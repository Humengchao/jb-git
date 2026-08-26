import * as path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { GitConflictVersions } from "../git/types";
import { RepositoryManager, RepositorySnapshot } from "../repositoryManager";
import { webviewDocument } from "./html";
import { isMergeEditorMessage } from "./mergeEditorProtocol";
import { basesForConflicts } from "../mergeAnalysis";
import { buildModel } from "../mergeRegions";
import { DiffContentProvider, diffSide } from "../views/diffProvider";

// The webview sandbox has no allow-modals, so window.confirm() silently
// returns false there; confirmations must round-trip through the host.
function confirmPrompts(): Map<string, { message: string; button: string }> {
  return new Map([
    ["acceptLeft", { message: vscode.l10n.t("Replace the complete result with the left version?"), button: vscode.l10n.t("Replace") }],
    ["acceptRight", { message: vscode.l10n.t("Replace the complete result with the right version?"), button: vscode.l10n.t("Replace") }],
    ["cancel", { message: vscode.l10n.t("Discard the unapplied merge result?"), button: vscode.l10n.t("Discard") }],
  ]);
}

interface MergeEditorLabels {
  ours: string;
  result: string;
  theirs: string;
}

export interface ConflictSideLabels {
  ours: string;
  theirs: string;
}

interface MergeDraft {
  fingerprint: string;
  result: string;
  deleted: boolean;
  updatedAt: number;
}

interface PersistedMergeDrafts {
  version: 1;
  drafts: Record<string, MergeDraft>;
}

const MERGE_DRAFTS_KEY = "jbGit.mergeDrafts";
const MAX_MERGE_DRAFT_BYTES = 2 * 1024 * 1024;
const MAX_MERGE_DRAFTS = 12;
const MERGE_DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1_000;

/** IntelliJ-inspired three-pane editor for a single unmerged text file. */
export class MergeConflictEditor implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly pendingOpens = new Set<string>();
  private readonly drafts: Record<string, MergeDraft>;
  private draftSaveTimer?: NodeJS.Timeout;
  private disposed = false;

  public constructor(
    private readonly manager: RepositoryManager,
    private readonly workspaceState: vscode.Memento,
    /** Comparisons open as native read-only diffs; an untitled document would open dirty. */
    private readonly diffProvider: DiffContentProvider,
  ) {
    const persisted = workspaceState.get<PersistedMergeDrafts>(MERGE_DRAFTS_KEY);
    const cutoff = Date.now() - MERGE_DRAFT_TTL_MS;
    this.drafts = Object.fromEntries(Object.entries(persisted?.version === 1 ? persisted.drafts : {})
      .filter(([, draft]) => draft.updatedAt >= cutoff && Buffer.byteLength(draft.result, "utf8") <= MAX_MERGE_DRAFT_BYTES)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_MERGE_DRAFTS));
  }

  /** Returns false for binary conflicts, which must use a whole-file fallback. */
  public async open(rootPath: string, pathSpec: string): Promise<boolean> {
    const key = `${rootPath}\0${pathSpec}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Active, false);
      return true;
    }
    // A second open for the same file while versions are still loading would
    // create a duplicate panel.
    if (this.pendingOpens.has(key)) return true;
    this.pendingOpens.add(key);
    try {
      return await this.openPanel(key, rootPath, pathSpec);
    } finally {
      this.pendingOpens.delete(key);
    }
  }

  /**
   * The base text of each conflict in `result`, in the order they appear.
   *
   * Git's working-tree conflict carries only the two sides, so the base comes
   * from replaying the merge in `diff3` on copies of the three stages. That
   * replay is a separate computation from the merge Git already performed, so
   * `basesForConflicts` hands back nothing unless it framed the same conflicts;
   * undefined here means the editor simply offers no base for this file, which
   * is the only safe answer when the alternative is labelling a block with
   * another block's history.
   */
  private async conflictBases(rootPath: string, pathSpec: string, result: string): Promise<string[] | undefined> {
    const { regions } = buildModel(result);
    if (!regions.length) return undefined;
    try {
      return basesForConflicts(regions, await this.manager.conflictAnalysis(rootPath, pathSpec));
    } catch {
      // A binary conflict, or one whose own content holds marker lines, cannot
      // be analysed line by line. That is not a reason to refuse the editor.
      return undefined;
    }
  }

  /**
   * IDEA's Compare contents: any two of the four versions, side by side.
   *
   * The pair is picked in a native Quick Pick and shown in a native diff rather
   * than as a fourth thing to render inside the Webview, which also means the
   * editor's own folding, search and whitespace settings apply to it.
   */
  private async compareVersions(
    rootPath: string,
    pathSpec: string,
    labels: MergeEditorLabels,
    versions: GitConflictVersions,
    result: string,
  ): Promise<void> {
    // The result is whatever the user is looking at now, which only the sandbox
    // knows; the other three are the merge's own stages.
    const sides = new Map<string, { label: string; content: string }>([
      ["left", { label: labels.ours, content: versions.ours }],
      ["base", { label: vscode.l10n.t("Base"), content: versions.base }],
      ["result", { label: labels.result, content: result }],
      ["right", { label: labels.theirs, content: versions.theirs }],
    ]);
    const pairs: Array<[string, string]> = [
      ["base", "result"], ["left", "result"], ["result", "right"],
      ["left", "right"], ["base", "left"], ["base", "right"],
    ];
    const choice = await vscode.window.showQuickPick(
      pairs
        // The base of a conflict that has no common ancestor — an add/add — is
        // nothing at all, and diffing against nothing says nothing.
        .filter(([left, right]) => (left !== "base" && right !== "base") || versions.baseExists)
        .map(([left, right]) => ({
          label: `${sides.get(left)!.label}  ↔  ${sides.get(right)!.label}`,
          pair: [left, right] as const,
        })),
      { title: vscode.l10n.t("Compare contents of {0}", path.basename(pathSpec)), placeHolder: vscode.l10n.t("Select two versions to compare") },
    );
    if (!choice) return;
    const [leftKey, rightKey] = choice.pair;
    const left = sides.get(leftKey)!;
    const right = sides.get(rightKey)!;
    const title = `${path.basename(pathSpec)}: ${left.label} ↔ ${right.label}`;
    await vscode.commands.executeCommand(
      "vscode.diff",
      diffSide(this.diffProvider, rootPath, `${title}:left`, pathSpec, Buffer.from(left.content, "utf8")),
      diffSide(this.diffProvider, rootPath, `${title}:right`, pathSpec, Buffer.from(right.content, "utf8")),
      title,
      { preview: true, viewColumn: vscode.ViewColumn.Beside },
    );
  }

  private async openPanel(key: string, rootPath: string, pathSpec: string): Promise<boolean> {
    const versions = await this.manager.conflictVersions(rootPath, pathSpec);
    if (versions.binary) return false;
    const fingerprint = conflictFingerprint(versions);
    const draft = this.drafts[key];
    const restoredDraft = draft?.fingerprint === fingerprint ? draft : undefined;
    if (draft && !restoredDraft) {
      delete this.drafts[key];
      void this.saveDrafts();
    }
    const displayedVersions = restoredDraft
      ? { ...versions, result: restoredDraft.result, resultExists: !restoredDraft.deleted }
      : versions;

    const bases = await this.conflictBases(rootPath, pathSpec, displayedVersions.result);
    const snapshot = this.manager.snapshot(rootPath);
    const sideLabels = await conflictSideLabels(snapshot);
    const labels: MergeEditorLabels = {
      ours: sideLabels.ours,
      result: vscode.l10n.t("Result"),
      theirs: sideLabels.theirs,
    };
    const title = `Merge Revisions for ${path.basename(pathSpec)}`;
    const panel = vscode.window.createWebviewPanel(
      "jbGit.mergeConflictEditor",
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panels.set(key, panel);
    let allowDispose = false;
    let dirty = Boolean(restoredDraft);
    let applying = false;
    let messageRegistration: vscode.Disposable | undefined;
    const disposeRegistration = panel.onDidDispose(() => {
      disposeRegistration.dispose();
      messageRegistration?.dispose();
      if (this.panels.get(key) === panel) this.panels.delete(key);
      // Only promise a draft that actually exists: an oversize result or cap eviction may
      // have removed it, and a close during Apply is resolved by the Apply's own outcome.
      if (dirty && !allowDispose && !applying && !this.disposed && this.drafts[key]) {
        const reopenLabel = vscode.l10n.t("Reopen");
        void vscode.window.showInformationMessage(
          vscode.l10n.t("The unapplied merge result for {0} was saved as a draft.", pathSpec),
          reopenLabel,
        ).then((choice) => { if (choice === reopenLabel) void this.open(rootPath, pathSpec); });
      }
    });
    messageRegistration = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isMergeEditorMessage(message)) return;
      if (message.type === "ready") {
        await panel.webview.postMessage({
          type: "load",
          versions: displayedVersions,
          originalResult: versions.result,
          originalResultExists: versions.resultExists,
          bases,
          labels,
          title,
          restoredDraft: Boolean(restoredDraft),
          language: path.extname(pathSpec).slice(1).toLowerCase() || path.basename(pathSpec).toLowerCase(),
        });
        return;
      }
      if (message.type === "dirty" && typeof message.result === "string") {
        dirty = true;
        if (Buffer.byteLength(message.result, "utf8") > MAX_MERGE_DRAFT_BYTES) {
          delete this.drafts[key];
          this.scheduleSaveDrafts();
          await panel.webview.postMessage({ type: "draftWarning", message: vscode.l10n.t("This result is too large for draft recovery. Apply it before closing the editor.") });
          return;
        }
        this.drafts[key] = { fingerprint, result: message.result, deleted: message.deleted === true, updatedAt: Date.now() };
        this.scheduleSaveDrafts();
        return;
      }
      if (message.type === "cancel") {
        allowDispose = true;
        dirty = false;
        delete this.drafts[key];
        await this.saveDrafts();
        panel.dispose();
        return;
      }
      if (message.type === "compare") {
        await this.compareVersions(rootPath, pathSpec, labels, displayedVersions, message.result);
        return;
      }
      if (message.type === "confirm") {
        const prompt = confirmPrompts().get(message.action);
        if (!prompt) return;
        const answer = await vscode.window.showWarningMessage(prompt.message, { modal: true }, prompt.button);
        if (answer === prompt.button) await panel.webview.postMessage({ type: "confirmed", action: message.action });
        return;
      }
      if (message.type !== "apply" || typeof message.result !== "string") return;
      applying = true;
      try {
        if (!vscode.workspace.isTrusted) throw new Error(vscode.l10n.t("Merge results cannot be applied until this workspace is trusted."));
        const latest = await this.manager.conflictVersions(rootPath, pathSpec);
        if (conflictFingerprint(latest) !== fingerprint) {
          throw new Error(vscode.l10n.t("The conflicted file changed outside this editor. Reopen it before applying to avoid overwriting newer work."));
        }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Applying merge result for {0}", pathSpec), cancellable: false },
          () => this.manager.applyConflictResult(rootPath, pathSpec, message.result, message.deleted === true),
        );
        allowDispose = true;
        dirty = false;
        delete this.drafts[key];
        await this.saveDrafts();
        await vscode.window.showInformationMessage(vscode.l10n.t("{0} was resolved and staged.", pathSpec));
        panel.dispose();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(detail);
        // The panel may have been closed while the apply was in flight.
        await panel.webview.postMessage({ type: "applyFailed", message: detail }).then(undefined, () => undefined);
      } finally {
        applying = false;
      }
    });
    panel.webview.html = webviewDocument(title, mergeStyles, `${await mergeRegionsScript()}${mergeScript}`);
    return true;
  }

  public dispose(): void {
    this.disposed = true;
    if (this.draftSaveTimer) clearTimeout(this.draftSaveTimer);
    void this.saveDrafts();
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
  }

  private async saveDrafts(): Promise<void> {
    const retained = Object.entries(this.drafts).sort((left, right) => right[1].updatedAt - left[1].updatedAt).slice(0, MAX_MERGE_DRAFTS);
    for (const key of Object.keys(this.drafts)) delete this.drafts[key];
    Object.assign(this.drafts, Object.fromEntries(retained));
    await this.workspaceState.update(MERGE_DRAFTS_KEY, { version: 1, drafts: this.drafts } satisfies PersistedMergeDrafts);
  }

  private scheduleSaveDrafts(): void {
    if (this.draftSaveTimer) clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = setTimeout(() => { this.draftSaveTimer = undefined; void this.saveDrafts(); }, 250);
  }
}

export function conflictFingerprint(versions: GitConflictVersions): string {
  return createHash("sha256")
    .update(JSON.stringify([versions.path, versions.baseExists, versions.base, versions.oursExists, versions.ours, versions.theirsExists, versions.theirs, versions.resultExists, versions.result]))
    .digest("hex");
}

/**
 * Git's stage-2/stage-3 meaning changes during a rebase: "ours" is the
 * target branch with already-replayed commits, while "theirs" is the commit
 * currently being replayed. Never label those panes as current/incoming
 * unconditionally; that makes the safest-looking button keep the wrong side.
 */
export async function conflictSideLabels(snapshot?: RepositorySnapshot): Promise<ConflictSideLabels> {
  const currentBranch = snapshot?.status?.branch.head ?? vscode.l10n.t("Current Branch");
  const operation = snapshot?.operation.kind ?? "none";
  const detail = snapshot?.operation.detail;
  if (operation === "rebase") {
    const [onto, stopped, headName] = await Promise.all([
      readOperationMetadata(detail, "onto"),
      readOperationMetadata(detail, "stopped-sha", "original-commit"),
      readOperationMetadata(detail, "head-name"),
    ]);
    const originalBranch = headName?.replace(/^refs\/heads\//, "");
    return {
      ours: onto ? `${vscode.l10n.t("Rebase Target")} · ${onto.slice(0, 10)}` : vscode.l10n.t("Rebase Target · already applied commits"),
      theirs: (originalBranch
        ? vscode.l10n.t("Replayed Commit from {0}", originalBranch)
        : vscode.l10n.t("Replayed Commit")) + (stopped ? ` · ${stopped.slice(0, 10)}` : ""),
    };
  }

  let revision: string | undefined;
  if (detail && ["merge", "cherry-pick", "revert"].includes(operation)) {
    try {
      revision = (await readFile(detail, "utf8")).trim().split(/\s+/)[0] || undefined;
    } catch {
      // The operation may finish while labels are loading.
    }
  }
  const branch = revision ? snapshot?.branches.find((candidate) => candidate.oid === revision) : undefined;
  const suffix = branch ? " " + vscode.l10n.t("from {0}", branch.name) : revision ? ` · ${revision.slice(0, 10)}` : "";
  const theirs = operation === "merge"
    ? vscode.l10n.t("Merged Changes") + suffix
    : operation === "cherry-pick"
      ? vscode.l10n.t("Cherry-picked Commit") + suffix
      : operation === "revert"
        ? vscode.l10n.t("Revert Result") + suffix
        : vscode.l10n.t("Incoming Changes");
  return { ours: vscode.l10n.t("Changes from {0}", currentBranch), theirs };
}

async function readOperationMetadata(directory: string | undefined, ...names: string[]): Promise<string | undefined> {
  if (!directory) return undefined;
  for (const name of names) {
    try {
      const value = (await readFile(path.join(directory, name), "utf8")).trim().split(/\s+/)[0];
      if (value) return value;
    } catch {
      // rebase-merge and rebase-apply expose slightly different file names.
    }
  }
  return undefined;
}

let mergeRegionsScriptCache: Promise<string> | undefined;

/**
 * The compiled mergeRegions module, wrapped as a global for the Webview
 * sandbox, which cannot import modules. Injecting the same build the tests
 * exercise keeps the region arithmetic in one place instead of a second copy
 * that could drift on exactly the code path that loses work.
 */
function mergeRegionsScript(): Promise<string> {
  mergeRegionsScriptCache ??= readFile(require.resolve("../mergeRegions"), "utf8").then(
    (source) => `const MergeRegions = (() => { const exports = {}; ${source}\n;return exports; })();\n`,
  );
  return mergeRegionsScriptCache;
}

const mergeStyles = String.raw`
  * { box-sizing: border-box; }
  :root { color-scheme: light dark; }
  html, body, #app { width: 100%; height: 100%; margin: 0; overflow: hidden; }
  body { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
  button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid transparent; border-radius: 2px; min-height: 28px; padding: 3px 12px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.icon { min-width: 30px; padding: 2px 8px; font-size: 16px; }
  button:disabled { opacity: .45; cursor: default; }
  .merge-root { display: grid; grid-template-rows: 42px minmax(0, 1fr) 50px; height: 100%; min-width: 650px;
    --merge-conflict: var(--vscode-editorError-foreground, var(--vscode-errorForeground, #f14c4c));
    --merge-applied: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #73c991));
    --merge-edited: var(--vscode-charts-blue, #3794ff);
    --merge-muted: var(--vscode-descriptionForeground, #848484); }
  .toolbar, .footer { display: flex; align-items: center; gap: 7px; padding: 6px 10px; background: var(--vscode-editorGroupHeader-tabsBackground); border-bottom: 1px solid var(--vscode-panel-border); }
  .footer { justify-content: space-between; border-top: 1px solid var(--vscode-panel-border); border-bottom: 0; }
  .toolbar-separator { width: 1px; height: 24px; margin: 0 3px; background: var(--vscode-panel-border); }
  .toolbar-spacer { flex: 1; }
  .non-conflicting { color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .counter { color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .counter.resolved { color: var(--vscode-testing-iconPassed); }
  .counter.error { color: var(--vscode-errorForeground); }
  .workspace { display: flex; min-width: 0; min-height: 0; overflow: hidden; }
  .pane { display: grid; grid-template-rows: 34px minmax(0, 1fr); flex: 1 1 0; min-width: 180px; min-height: 0; overflow: hidden; background: var(--vscode-editor-background); }
  .pane-title { display: flex; align-items: center; justify-content: center; padding: 0 10px; font-weight: 600; color: var(--vscode-foreground); background: var(--vscode-editorGroupHeader-tabsBackground); border-bottom: 1px solid var(--vscode-panel-border); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pane.result .pane-title { color: var(--vscode-textLink-foreground); }
  /* IDEA separates the panes with wide strips that draw each change as a
     coloured shape connecting its side chunk to the result region, and put the
     per-change apply/ignore actions on that shape. */
  .splitter { flex: 0 0 38px; position: relative; cursor: col-resize; background: var(--vscode-editor-background); border-left: 1px solid var(--vscode-panel-border); border-right: 1px solid var(--vscode-panel-border); }
  .splitter.active { background: color-mix(in srgb, var(--vscode-sash-hoverBorder) 18%, var(--vscode-editor-background)); }
  /* Only the strip's own connector canvas stretches; a descendant selector here
     would also stretch the icon inside every gutter button. */
  .splitter > svg { position: absolute; left: 0; right: 0; top: 34px; width: 100%; height: calc(100% - 34px); display: block; pointer-events: none; }
  .splitter polygon { pointer-events: auto; cursor: pointer; }
  /* One colour per change state, carried in --state, so the current change can
     be emphasised in any state the way IDEA outlines the one you are on. */
  .state-conflict { --state: var(--merge-conflict); }
  .state-applied { --state: var(--merge-applied); }
  .state-manual { --state: var(--merge-edited); }
  .state-ignored { --state: var(--merge-muted); }
  .connector { --fill: 15%; --line: 45%; fill: color-mix(in srgb, var(--state) var(--fill), transparent); stroke: color-mix(in srgb, var(--state) var(--line), transparent); stroke-width: 1; }
  .connector.is-current { --fill: 30%; --line: 90%; stroke-width: 1.5; }
  .strip-buttons { position: absolute; left: 0; right: 0; top: 34px; bottom: 0; overflow: hidden; pointer-events: none; }
  /* Gutter actions read as small chips outlined in their own action colour and
     filled on hover, so they stay legible on top of a shaded connector without
     competing with the code in either pane. */
  .chunk-action { --action: var(--merge-muted); pointer-events: auto; position: absolute; width: 16px; height: 16px; min-height: 0; min-width: 0; padding: 0; display: flex; align-items: center; justify-content: center; border: 1px solid color-mix(in srgb, var(--action) 45%, transparent); border-radius: 4px; color: var(--action); background: color-mix(in srgb, var(--action) 12%, var(--vscode-editor-background)); cursor: pointer; }
  .chunk-action:hover { border-color: color-mix(in srgb, var(--action) 90%, transparent); background: color-mix(in srgb, var(--action) 26%, var(--vscode-editor-background)); }
  .chunk-action:active { background: color-mix(in srgb, var(--action) 40%, var(--vscode-editor-background)); }
  .chunk-action:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .chunk-action svg { display: block; width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .chunk-action.accept { --action: var(--merge-applied); }
  .chunk-action.ignore { --action: var(--merge-muted); }
  /* Neutral, not the edited blue: blue already means "hand edited" on a band,
     and only the action that changes the result earns a colour. */
  .chunk-action.revert { --action: var(--merge-muted); }
  .code-shell { display: grid; grid-template-columns: 48px minmax(0, 1fr); min-height: 0; overflow: hidden; }
  /* IDEA's marker strip: every change at its place in the whole file, so a long
     merge shows where the work is left without scrolling for it. */
  .pane.result .code-shell { grid-template-columns: 48px minmax(0, 1fr) 12px; }
  .ruler { position: relative; overflow: hidden; background: var(--vscode-editorGutter-background); border-left: 1px solid var(--vscode-panel-border); cursor: pointer; }
  .ruler-mark { position: absolute; left: 2px; right: 2px; height: 3px; border-radius: 1px; background: color-mix(in srgb, var(--state) 70%, transparent); }
  .ruler-mark.is-current { left: 1px; right: 1px; height: 5px; background: var(--state); }
  .line-numbers { margin: 0; padding: 10px 8px 30px 4px; overflow: hidden; user-select: none; text-align: right; color: var(--vscode-editorLineNumber-foreground); background: var(--vscode-editorGutter-background); font: var(--vscode-editor-font-size, 13px) / var(--vscode-editor-line-height, 20px) var(--vscode-editor-font-family, monospace); }
  .editor-stack { position: relative; min-width: 0; min-height: 0; overflow: hidden; background: var(--vscode-editor-background); }
  .syntax-layer, textarea { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 10px 12px 30px; border: 0; outline: 0; overflow: auto; white-space: pre; tab-size: var(--vscode-editor-tab-size, 4); font: var(--vscode-editor-font-size, 13px) / var(--vscode-editor-line-height, 20px) var(--vscode-editor-font-family, monospace); }
  .syntax-layer { pointer-events: none; min-width: max-content; min-height: max-content; color: var(--vscode-editor-foreground); background: transparent; overflow: visible; }
  textarea { resize: none; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); caret-color: var(--vscode-editorCursor-foreground); }
  textarea.syntax-enabled { color: transparent; -webkit-text-fill-color: transparent; background: transparent; }
  textarea[readonly] { color: var(--vscode-editor-foreground); }
  textarea[readonly].syntax-enabled { color: transparent; -webkit-text-fill-color: transparent; }
  textarea:focus { box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }
  textarea::selection { background: var(--vscode-editor-selectionBackground); }
  .token-comment { color: var(--vscode-symbolIcon-colorForeground, #6a9955); }
  .token-string { color: var(--vscode-debugTokenExpression-string, #ce9178); }
  .token-number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
  .token-keyword { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
  .token-conflict { color: color-mix(in srgb, var(--vscode-errorForeground) 62%, var(--vscode-descriptionForeground)); background: transparent; opacity: 0.75; }
  /* IDEA marks each change with a coloured band instead of a text selection:
     red while a conflict is unresolved, green once a side was applied, blue for
     text the user rewrote, grey for a change that was looked at and ignored.
     The side panes shade the same change more faintly, so the result stays the
     pane that reads loudest. */
  .band { background: color-mix(in srgb, var(--state) var(--alpha, 13%), transparent); box-shadow: -8px 0 0 0 color-mix(in srgb, var(--state) var(--alpha, 13%), transparent); }
  .band.is-current { --alpha: 27%; }
  .band.side { --alpha: 10%; }
  .band.side.is-current { --alpha: 22%; }
  /* A conflict that took nothing from our side is a zero-length range: with no
     text to shade it was invisible in the result, so it is drawn the way IDEA
     draws a deletion — a coloured line at the exact spot. */
  .band-empty { position: relative; }
  .band-empty::after { content: ''; position: absolute; left: -8px; top: -1px; width: 56px; border-top: 2px solid color-mix(in srgb, var(--state) 75%, transparent); }
  .band-empty.is-current::after { border-top-width: 3px; border-top-color: var(--state); }
  /* IDEA answers "what did this change start from?" with a frame showing the
     previous contents over the editor. The same idea per conflict block: the
     base text of the change you are on, floated above it when there is room
     and below it when there is not. */
  /* An author rule that sets display beats the user agent's own
     "[hidden] { display: none }", so without this the frame is on screen
     permanently, empty, from the moment the editor opens. */
  .base-frame[hidden] { display: none; }
  .base-frame { position: absolute; left: 0; right: 0; z-index: 3; max-height: 45%; display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--merge-edited) 55%, transparent); border-radius: 3px;
    background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
    box-shadow: 0 2px 8px rgba(0, 0, 0, .3); }
  .base-frame-title { flex: 0 0 auto; padding: 1px 9px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
    color: var(--vscode-descriptionForeground); background: var(--vscode-editorGroupHeader-tabsBackground); border-bottom: 1px solid var(--vscode-panel-border); }
  .base-frame-text { margin: 0; padding: 5px 10px; overflow: auto; white-space: pre; tab-size: var(--vscode-editor-tab-size, 4);
    color: var(--vscode-editor-foreground); font: var(--vscode-editor-font-size, 13px) / var(--vscode-editor-line-height, 20px) var(--vscode-editor-font-family, monospace); }
  .base-frame-text.empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  button[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .footer-group { display: flex; align-items: center; gap: 8px; }
  .hint { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 850px) { .non-conflicting, .hint { display: none; } .toolbar button { padding-left: 7px; padding-right: 7px; } }
`;

// Kept as a standalone embedded script so its conflict parsing and CSP syntax can be unit-tested.
const mergeScript = String.raw`
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const useChinese = document.documentElement.lang.toLowerCase().startsWith('zh');
  const mergeZh = {
    'Previous change': '上一个更改', 'Next change': '下一个更改',
    '✓ Non-conflicting changes are already applied': '✓ 非冲突更改已自动应用',
    '← Left': '← 左侧', 'Both': '两者都保留', 'Right →': '右侧 →', 'Reset': '重置',
    'Base': '基线', 'Show what this change started from': '显示此更改的原始内容',
    '(this block is not in the base)': '（基线中没有这一块）',
    'Compare…': '比较…', 'Compare any two of the four versions side by side': '并排比较四个版本中的任意两个',
    'Loading conflict…': '正在加载冲突…', 'Current branch': '当前分支', 'Result': '结果',
    'Incoming changes': '传入更改', 'Accept Left': '接受左侧', 'Accept Right': '接受右侧',
    'Use the arrows between the panes to apply a side, × to ignore it, or edit the result directly.': '使用面板之间的箭头应用某一侧，× 忽略该更改，也可以直接编辑中间结果。',
    'Apply this change to the result': '将此更改应用到结果',
    'Keep both: append this side too': '两者都保留：再追加此侧',
    'Ignore this change and keep the result text': '忽略此更改，保留当前结果文本',
    'Revert this change to unresolved': '撤销此更改，恢复为未解决',
    'Use the current conflict from the left pane (1)': '当前冲突使用左侧版本（按 1）',
    'Keep both sides of the current conflict (2)': '当前冲突两侧都保留（按 2）',
    'Use the current conflict from the right pane (3)': '当前冲突使用右侧版本（按 3）',
    ' · draft restored': ' · 已恢复草稿', 'Draft restored · ready to apply': '已恢复草稿 · 可以应用',
    'Could not apply the merge result': '无法应用合并结果',
    'Abort': '中止', 'Apply': '应用', 'All changes processed': '所有更改已处理',
    'Resolved as deleted': '已解决为删除', 'Applying merge result…': '正在应用合并结果…',
  };
  const mt = value => useChinese ? (mergeZh[value] || value) : value;
  app.innerHTML = [
    '<div class="merge-root">',
      '<div class="toolbar">',
        '<button id="previous" class="secondary icon" title="Previous change" aria-label="Previous change">↑</button>',
        '<button id="next" class="secondary icon" title="Next change" aria-label="Next change">↓</button>',
        '<span class="toolbar-separator"></span>',
        '<span class="non-conflicting">✓ Non-conflicting changes are already applied</span>',
        '<span class="toolbar-separator"></span>',
        '<button id="take-left" class="secondary" title="Use the current conflict from the left pane (1)">← Left</button>',
        '<button id="take-both" class="secondary" title="Keep both sides of the current conflict (2)">Both</button>',
        '<button id="take-right" class="secondary" title="Use the current conflict from the right pane (3)">Right →</button>',
        '<button id="reset" class="secondary" title="Restore the original conflicted result" disabled>Reset</button>',
        '<span class="toolbar-separator"></span>',
        '<button id="show-base" class="secondary" title="Show what this change started from" aria-pressed="false" disabled>Base</button>',
        '<button id="compare" class="secondary" title="Compare any two of the four versions side by side">Compare…</button>',
        '<span class="toolbar-spacer"></span>',
        '<span id="counter" class="counter">Loading conflict…</span>',
      '</div>',
      '<div id="workspace" class="workspace">',
        '<section id="left-pane" class="pane">',
          '<div id="left-title" class="pane-title">Current branch</div>',
          '<div class="code-shell"><pre id="left-lines" class="line-numbers" aria-hidden="true"></pre><div class="editor-stack"><pre id="left-highlight" class="syntax-layer" aria-hidden="true"></pre><textarea id="left" readonly spellcheck="false" aria-label="Current branch version"></textarea></div></div>',
        '</section>',
        '<div id="strip-left" class="splitter" role="separator" aria-orientation="vertical" tabindex="0"><svg aria-hidden="true"></svg><div class="strip-buttons"></div></div>',
        '<section id="result-pane" class="pane result">',
          '<div id="result-title" class="pane-title">Result</div>',
          '<div class="code-shell"><pre id="result-lines" class="line-numbers" aria-hidden="true"></pre><div class="editor-stack"><pre id="result-highlight" class="syntax-layer" aria-hidden="true"></pre><textarea id="result" spellcheck="false" aria-label="Editable merge result"></textarea><div id="base-frame" class="base-frame" hidden><div class="base-frame-title">Base</div><pre id="base-frame-text" class="base-frame-text"></pre></div></div><div id="ruler" class="ruler" title="Changes in this file"></div></div>',
        '</section>',
        '<div id="strip-right" class="splitter" role="separator" aria-orientation="vertical" tabindex="0"><svg aria-hidden="true"></svg><div class="strip-buttons"></div></div>',
        '<section id="right-pane" class="pane">',
          '<div id="right-title" class="pane-title">Incoming changes</div>',
          '<div class="code-shell"><pre id="right-lines" class="line-numbers" aria-hidden="true"></pre><div class="editor-stack"><pre id="right-highlight" class="syntax-layer" aria-hidden="true"></pre><textarea id="right" readonly spellcheck="false" aria-label="Incoming version"></textarea></div></div>',
        '</section>',
      '</div>',
      '<div class="footer">',
        '<div class="footer-group">',
          '<button id="accept-left" class="secondary" disabled>Accept Left</button>',
          '<button id="accept-right" class="secondary" disabled>Accept Right</button>',
          '<span class="hint">Use the arrows between the panes to apply a side, × to ignore it, or edit the result directly.</span>',
        '</div>',
        '<div class="footer-group"><button id="cancel" class="secondary">Abort</button><button id="apply" disabled>Apply</button></div>',
      '</div>',
    '</div>',
  ].join('');
  if (useChinese) {
    for (const element of app.querySelectorAll('button, .non-conflicting, .hint, .counter, .pane-title')) {
      element.textContent = mt(element.textContent);
      if (element.title) element.title = mt(element.title);
      if (element.getAttribute('aria-label')) element.setAttribute('aria-label', mt(element.getAttribute('aria-label')));
    }
  }

  const left = document.getElementById('left');
  const result = document.getElementById('result');
  const right = document.getElementById('right');
  const counter = document.getElementById('counter');
  const ruler = document.getElementById('ruler');
  const apply = document.getElementById('apply');
  const conflictButtons = ['previous', 'next', 'take-left', 'take-both', 'take-right'].map((id) => document.getElementById(id));
  const wholeFileButtons = ['accept-left', 'accept-right', 'reset'].map((id) => document.getElementById(id));
  const showBaseButton = document.getElementById('show-base');
  const baseFrame = document.getElementById('base-frame');
  const baseFrameText = document.getElementById('base-frame-text');
  const editors = [left, result, right];
  const gutters = [document.getElementById('left-lines'), document.getElementById('result-lines'), document.getElementById('right-lines')];
  const highlights = [document.getElementById('left-highlight'), document.getElementById('result-highlight'), document.getElementById('right-highlight')];
  const strips = [
    { svg: document.querySelector('#strip-left svg'), buttons: document.querySelector('#strip-left .strip-buttons'), side: 0 },
    { svg: document.querySelector('#strip-right svg'), buttons: document.querySelector('#strip-right .strip-buttons'), side: 2 },
  ];
  const EDITOR_PADDING = 10;
  // The result is marker-free text plus conflict ranges, exactly the model
  // MergeRegions maintains; every mutation goes through that injected module.
  let model = { text: '', regions: [] };
  let markerLabels = { ours: 'ours', theirs: 'theirs' };
  let chunkOffsets = { 0: [], 2: [] };
  let geometry = [];
  let initialResult = '';
  let initialSerialized = '';
  let initialResultDeleted = false;
  let resultDeleted = false;
  let currentConflict = 0;
  let showBase = false;
  let applying = false;
  let loaded = false;
  let synchronizing = false;
  const HIGHLIGHT_MARGIN = 40;
  const UNDO_LIMIT = 100;
  let undoStack = [];
  let redoStack = [];
  let typingRun = false;
  let highlightWindows = [undefined, undefined, undefined];
  let highlightFrame;
  let updateFrame;
  let overlayFrame;
  let draftTimer;
  let language = '';
  let lastLineCounts = [0, 0, 0];
  let alignmentCache = new Map();

  function lineCount(value) {
    let count = 1;
    for (let index = 0; index < value.length; index += 1) if (value.charCodeAt(index) === 10) count += 1;
    return count;
  }

  function updateNumbers() {
    editors.forEach((editor, index) => {
      const count = lineCount(editor.value);
      if (count !== lastLineCounts[index]) {
        let numbers = '';
        for (let line = 1; line <= count; line += 1) numbers += (line === 1 ? '' : '\n') + String(line);
        gutters[index].textContent = numbers;
        lastLineCounts[index] = count;
      }
      gutters[index].scrollTop = editor.scrollTop;
    });
  }

  const keywords = new Set(('abstract as async await break case catch class const continue default delete do else enum export extends false finally for from function get if implements import in instanceof interface let namespace new null of package private protected public readonly return set static struct super switch this throw true try type typeof undefined var void while with yield').split(' '));

  function tokenClass(token) {
    if (/^(?:<{7,}|={7,}|>{7,})/.test(token)) return 'token-conflict';
    if (/^(?:\/\/|\/\*)/.test(token)) return 'token-comment';
    if (/^#/.test(token)) return ['py', 'python', 'sh', 'bash', 'zsh', 'rb', 'ruby', 'yaml', 'yml', 'toml'].includes(language) ? 'token-comment' : '';
    if (/^["']/.test(token)) return 'token-string';
    if (/^\d/.test(token)) return 'token-number';
    return keywords.has(token) ? 'token-keyword' : '';
  }

  function tokenizeInto(parent, text) {
    const pattern = /^(?:<{7,}|={7,}|>{7,})[^\r\n]*|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|#[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b/gm;
    let cursor = 0; let match;
    while ((match = pattern.exec(text))) {
      if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
      const className = tokenClass(match[0]);
      if (className) { const span = document.createElement('span'); span.className = className; span.textContent = match[0]; parent.append(span); }
      else parent.append(document.createTextNode(match[0]));
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
  }

  function regionState(region) {
    if (region.resolution === undefined) return 'conflict';
    if (region.resolution === 'manual') return 'manual';
    if (region.resolution === 'ignored') return 'ignored';
    return 'applied';
  }

  /** Line spans for sorted non-overlapping ranges, found in one pass over the text. */
  function lineRanges(text, ranges) {
    const spans = []; let line = 0; let cursor = 0;
    for (const range of ranges) {
      if (!range) { spans.push(null); continue; }
      while (cursor < range.start) { if (text.charCodeAt(cursor) === 10) line += 1; cursor += 1; }
      const top = line;
      while (cursor < range.end) { if (text.charCodeAt(cursor) === 10) line += 1; cursor += 1; }
      spans.push([top, range.end > range.start && text.charCodeAt(range.end - 1) !== 10 ? line + 1 : line]);
    }
    return spans;
  }

  /**
   * Locates each conflict's contribution inside a side pane by a forward scan,
   * so an unmatched side stays unmarked rather than shading the wrong lines.
   */
  function sideOffsets(sideIndex) {
    const text = editors[sideIndex].value;
    const key = sideIndex === 0 ? 'ours' : 'theirs';
    let from = 0;
    return model.regions.map((region) => {
      const section = region[key];
      if (!section) return null;
      const at = text.indexOf(section, from);
      if (at < 0) return null;
      from = at + section.length;
      return { start: at, end: at + section.length };
    });
  }

  function alignedSpan(sideIndex, resultLine) {
    const line = alignedLine(1, sideIndex, resultLine);
    return [line, line];
  }

  function rebuildGeometry() {
    chunkOffsets = { 0: sideOffsets(0), 2: sideOffsets(2) };
    const resultSpans = lineRanges(result.value, model.regions);
    const leftSpans = lineRanges(left.value, chunkOffsets[0]);
    const rightSpans = lineRanges(right.value, chunkOffsets[2]);
    geometry = model.regions.map((region, index) => {
      const res = resultSpans[index];
      return {
        state: regionState(region),
        res,
        left: leftSpans[index] || alignedSpan(0, res[0]),
        right: rightSpans[index] || alignedSpan(2, res[0]),
      };
    });
  }

  /**
   * Draws IDEA's connectors: one shape per change in each strip, joining the
   * side chunk's lines to the result region's lines, plus the per-change
   * action buttons anchored at the side chunk's first line.
   */
  function renderOverlays() {
    if (!loaded) return;
    const lineHeights = editors.map((editor) => Number.parseFloat(getComputedStyle(editor).lineHeight) || 20);
    const yOf = (index, line) => EDITOR_PADDING + line * lineHeights[index] - editors[index].scrollTop;
    for (const strip of strips) {
      const width = strip.svg.clientWidth || 38;
      const height = strip.svg.clientHeight;
      let shapes = '';
      geometry.forEach((geom, index) => {
        const leftIndex = strip.side === 0 ? 0 : 1;
        const rightIndex = strip.side === 0 ? 1 : 2;
        const leftRange = strip.side === 0 ? geom.left : geom.res;
        const rightRange = strip.side === 0 ? geom.res : geom.right;
        const leftTop = yOf(leftIndex, leftRange[0]);
        const rightTop = yOf(rightIndex, rightRange[0]);
        const leftBottom = Math.max(yOf(leftIndex, leftRange[1]), leftTop + 2);
        const rightBottom = Math.max(yOf(rightIndex, rightRange[1]), rightTop + 2);
        if (Math.max(leftBottom, rightBottom) < 0 || Math.min(leftTop, rightTop) > height) return;
        shapes += '<polygon class="connector state-' + geom.state + (index === currentConflict ? ' is-current' : '')
          + '" data-index="' + String(index) + '" points="0,'
          + String(Math.round(leftTop)) + ' ' + String(width) + ',' + String(Math.round(rightTop)) + ' '
          + String(width) + ',' + String(Math.round(rightBottom)) + ' 0,' + String(Math.round(leftBottom)) + '"></polygon>';
      });
      strip.svg.innerHTML = shapes;
      for (const action of strip.buttons.children) {
        const geom = geometry[Number(action.dataset.index)];
        const range = geom && (strip.side === 0 ? geom.left : geom.right);
        const y = range ? yOf(strip.side, range[0]) : -1;
        if (y < 0 || y > height - 16) { action.style.display = 'none'; continue; }
        action.style.display = 'flex';
        action.style.top = String(Math.round(y)) + 'px';
      }
    }
    const currentRange = geometry[currentConflict] ? geometry[currentConflict].res : [0, 0];
    renderBaseFrame(lineHeights[1], yOf(1, currentRange[0]), yOf(1, currentRange[1]));
  }

  /**
   * Puts the host's base texts onto the regions they belong to.
   *
   * The host already refused to send anything unless its diff3 replay framed
   * the same conflicts, and the count is checked again here so a protocol that
   * ever drifts leaves the editor with no base rather than a shifted one.
   */
  function withBases(built, bases) {
    if (!Array.isArray(bases) || bases.length !== built.regions.length) return built;
    return {
      text: built.text,
      regions: built.regions.map((region, index) => (
        typeof bases[index] === 'string' ? Object.assign({}, region, { base: bases[index] }) : region
      )),
    };
  }

  /** True when the change you are on knows what it started from. */
  function currentBase() {
    const region = model.regions[currentConflict];
    return region && typeof region.base === 'string' ? region.base : undefined;
  }

  /**
   * Draws IDEA's "previous contents" frame for the change you are on.
   *
   * The frame sits above the change when there is room for it and below it when
   * there is not, so it never covers the lines it is explaining. It is hidden
   * outright when the change scrolls away, rather than parked at an edge where
   * it would look like it belonged to whatever is there instead.
   */
  function renderBaseFrame(lineHeight, changeTop, changeBottom) {
    const base = currentBase();
    if (!showBase || base === undefined) { baseFrame.hidden = true; return; }
    const stack = result.parentElement;
    const available = stack.clientHeight;
    if (changeBottom < -lineHeight || changeTop > available) { baseFrame.hidden = true; return; }
    const empty = base === '';
    baseFrameText.className = 'base-frame-text' + (empty ? ' empty' : '');
    baseFrameText.textContent = empty ? mt('(this block is not in the base)') : base.replace(/\r?\n$/, '');
    baseFrame.hidden = false;
    // Measured only once the text is in place, because the frame's height is
    // what decides whether it fits above the change.
    const height = baseFrame.offsetHeight;
    const above = changeTop - height - 3;
    // Below the whole change, not below its first line: a change spanning
    // several lines would otherwise be covered by its own base.
    const below = Math.min(changeBottom + 3, Math.max(0, available - height));
    baseFrame.style.top = String(Math.round(above >= 0 ? above : below)) + 'px';
  }

  function setShowBase(next) {
    showBase = next;
    showBaseButton.setAttribute('aria-pressed', next ? 'true' : 'false');
    scheduleOverlays();
  }

  /** One tick per change, placed by its share of the file, like IDEA's strip. */
  function renderRuler() {
    const total = Math.max(1, lineCount(result.value) - 1);
    const fragment = document.createDocumentFragment();
    geometry.forEach((geom, index) => {
      const mark = document.createElement('div');
      mark.className = 'ruler-mark state-' + geom.state + (index === currentConflict ? ' is-current' : '');
      mark.style.top = String(Math.min(99, (geom.res[0] / total) * 100)) + '%';
      fragment.append(mark);
    });
    ruler.replaceChildren(fragment);
  }

  function scheduleOverlays() {
    if (overlayFrame) return;
    overlayFrame = requestAnimationFrame(() => { overlayFrame = undefined; renderOverlays(); });
  }

  // Stroked 12x12 icons: text glyphs like » and × render at a different weight
  // and baseline in every font the themes pick, which is what made the gutter
  // look ragged.
  const ACTION_ICONS = {
    'apply-right': 'M2.4 6h5.3M6 3.7L8.3 6 6 8.3',
    'apply-left': 'M9.6 6H4.3M6 3.7L3.7 6 6 8.3',
    ignore: 'M3.6 3.6l4.8 4.8M8.4 3.6L3.6 8.4',
    revert: 'M4.7 3.3L2.5 5.5l2.2 2.2M2.5 5.5h4.4a2.6 2.6 0 1 1 0 5.2H5.7',
  };

  function actionIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ACTION_ICONS[name]);
    svg.append(path);
    return svg;
  }

  function chunkAction(index, icon, kind, x, title, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chunk-action ' + kind;
    button.dataset.index = String(index);
    button.append(actionIcon(icon));
    button.title = mt(title);
    button.setAttribute('aria-label', mt(title));
    button.style.left = String(x) + 'px';
    button.style.display = 'none';
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    button.addEventListener('click', handler);
    return button;
  }

  /**
   * IDEA's per-change gutter actions, as a pair on each strip so no change is
   * ever left with an empty gutter: the arrow applies that side, and the outer
   * slot holds × while the change is open and the revert arrow once it is
   * settled. Applying one side must not strand the other, so the side that has
   * not been taken keeps its arrow and "keep both" stays one click away.
   */
  function rebuildStripButtons() {
    for (const strip of strips) {
      const fromLeft = strip.side === 0;
      const near = fromLeft ? 3 : 19;
      const far = fromLeft ? 19 : 3;
      const fragment = document.createDocumentFragment();
      model.regions.forEach((region, index) => {
        const crossSide = fromLeft ? 'theirs' : 'ours';
        if (region.resolution === undefined || region.resolution === crossSide) {
          const both = region.resolution === crossSide;
          fragment.append(chunkAction(index, fromLeft ? 'apply-right' : 'apply-left', 'accept', near,
            both ? 'Keep both: append this side too' : 'Apply this change to the result',
            () => resolveAs(index, both ? 'both' : (fromLeft ? 'ours' : 'theirs'))));
        }
        fragment.append(region.resolution === undefined
          ? chunkAction(index, 'ignore', 'ignore', far,
            'Ignore this change and keep the result text', () => ignoreAt(index))
          : chunkAction(index, 'revert', 'revert', far,
            'Revert this change to unresolved', () => resetAt(index)));
      });
      strip.buttons.replaceChildren(fragment);
    }
  }

  function bandClass(region, position, side) {
    return 'band state-' + regionState(region) + (side ? ' side' : '')
      + (position === currentConflict ? ' is-current' : '');
  }

  /** Ranges to shade in one pane, coloured by each change's state like IDEA. */
  function bandsFor(index) {
    if (!model.regions.length) return [];
    if (index === 1) {
      // Zero-length regions stay: updateHighlight draws them as deletion marks.
      return model.regions
        .map((region, position) => ({ start: region.start, end: region.end, className: bandClass(region, position, false) }));
    }
    const offsets = chunkOffsets[index] || [];
    const bands = [];
    model.regions.forEach((region, position) => {
      const chunk = offsets[position];
      if (!chunk || chunk.end <= chunk.start) return;
      bands.push({ start: chunk.start, end: chunk.end, className: bandClass(region, position, true) });
    });
    return bands;
  }

  function lineHeightOf(index) {
    return Number.parseFloat(getComputedStyle(editors[index]).lineHeight) || 20;
  }

  /**
   * The slice of a pane to paint: the lines on screen plus a margin.
   *
   * Painting the whole file cost ~115ms of every keystroke on a 3,000-line
   * merge, because each one re-tokenised all three panes into tens of
   * thousands of nodes. The syntax layer only has to be right where it is
   * visible, so it renders a window and is translated into place.
   */
  function highlightWindow(index) {
    const text = editors[index].value;
    const lineHeight = lineHeightOf(index);
    const first = Math.max(0, Math.floor(editors[index].scrollTop / lineHeight) - HIGHLIGHT_MARGIN);
    const count = Math.ceil(editors[index].clientHeight / lineHeight) + HIGHLIGHT_MARGIN * 2;
    let start = 0; let line = 0;
    while (line < first && start < text.length) { if (text.charCodeAt(start) === 10) line += 1; start += 1; }
    let end = start; let seen = 0;
    while (end < text.length && seen < count) { if (text.charCodeAt(end) === 10) seen += 1; end += 1; }
    return { first: first, last: first + seen, start: start, end: end };
  }

  /** Puts the rendered window under the text it highlights. */
  function positionHighlight(index) {
    const view = highlightWindows[index];
    const top = (view ? view.first * lineHeightOf(index) : 0) - editors[index].scrollTop;
    highlights[index].style.transform = 'translate(' + String(-editors[index].scrollLeft) + 'px,' + String(top) + 'px)';
  }

  /** True once the pane is scrolled close to the edge of what was painted. */
  function highlightStale(index) {
    const view = highlightWindows[index];
    if (!view) return false;
    const lineHeight = lineHeightOf(index);
    const top = editors[index].scrollTop / lineHeight;
    return (view.first > 0 && top < view.first + 4)
      || (view.end < editors[index].value.length && top + editors[index].clientHeight / lineHeight > view.last - 4);
  }

  function scheduleHighlights() {
    if (highlightFrame) return;
    highlightFrame = requestAnimationFrame(() => {
      highlightFrame = undefined;
      editors.forEach((_editor, index) => { if (highlightStale(index)) updateHighlight(index); });
    });
  }

  function updateHighlight(index) {
    const editor = editors[index]; const target = highlights[index];
    if (editor.value.length > 8000000) {
      editor.classList.remove('syntax-enabled'); target.replaceChildren(); highlightWindows[index] = undefined; return;
    }
    // A window that opens inside a block comment or a template string cannot
    // know it, so the first construct on screen may lose its colour until the
    // pane is scrolled; nothing is mispositioned by it.
    const view = highlightWindow(index);
    const fragment = document.createDocumentFragment();
    let cursor = view.start;
    for (const band of bandsFor(index)) {
      if (band.start === band.end) {
        if (band.start < cursor || band.start > view.end) continue;
        if (band.start > cursor) { tokenizeInto(fragment, editor.value.slice(cursor, band.start)); cursor = band.start; }
        const mark = document.createElement('span');
        mark.className = band.className + ' band-empty';
        fragment.append(mark);
        continue;
      }
      if (band.end <= cursor || band.start >= view.end) continue;
      const start = Math.max(band.start, cursor);
      const end = Math.min(band.end, view.end);
      if (end <= start) continue;
      if (start > cursor) tokenizeInto(fragment, editor.value.slice(cursor, start));
      const shaded = document.createElement('span');
      shaded.className = band.className;
      tokenizeInto(shaded, editor.value.slice(start, end));
      fragment.append(shaded);
      cursor = end;
    }
    if (cursor < view.end) tokenizeInto(fragment, editor.value.slice(cursor, view.end));
    target.replaceChildren(fragment); editor.classList.add('syntax-enabled');
    highlightWindows[index] = view;
    positionHighlight(index);
  }

  function alignmentAnchors(source, target) {
    const key = source + '>' + target;
    if (alignmentCache.has(key)) return alignmentCache.get(key);
    const sourceLines = editors[source].value.split(/\r?\n/); const targetLines = editors[target].value.split(/\r?\n/);
    const sourcePositions = new Map(); const targetPositions = new Map();
    sourceLines.forEach((line, index) => sourcePositions.set(line, sourcePositions.has(line) ? -1 : index));
    targetLines.forEach((line, index) => targetPositions.set(line, targetPositions.has(line) ? -1 : index));
    const anchors = [[-1, -1]]; let lastTarget = -1;
    sourceLines.forEach((line, sourceLine) => {
      const targetLine = targetPositions.get(line);
      if (sourcePositions.get(line) === sourceLine && typeof targetLine === 'number' && targetLine > lastTarget) {
        anchors.push([sourceLine, targetLine]); lastTarget = targetLine;
      }
    });
    anchors.push([sourceLines.length, targetLines.length]); alignmentCache.set(key, anchors); return anchors;
  }

  function alignedLine(source, target, line) {
    const anchors = alignmentAnchors(source, target);
    let upper = 1; while (upper < anchors.length && anchors[upper][0] < line) upper += 1;
    const before = anchors[Math.max(0, upper - 1)]; const after = anchors[Math.min(anchors.length - 1, upper)];
    const span = Math.max(1, after[0] - before[0]); const ratio = Math.max(0, Math.min(1, (line - before[0]) / span));
    return before[1] + (after[1] - before[1]) * ratio;
  }

  function updateControls(reveal) {
    const total = model.regions.length;
    currentConflict = total === 0 ? 0 : Math.max(0, Math.min(currentConflict, total - 1));
    const remaining = MergeRegions.unresolved(model.regions);
    conflictButtons.forEach((button) => { button.disabled = total === 0 || applying; });
    wholeFileButtons.forEach((button) => { button.disabled = !loaded || applying; });
    // Offered only where there is a base to show: a conflict whose replay could
    // not be paired has no previous contents this editor is willing to claim.
    showBaseButton.disabled = currentBase() === undefined || applying;
    apply.disabled = !loaded || remaining !== 0 || applying;
    counter.className = 'counter' + (remaining === 0 ? ' resolved' : '');
    counter.textContent = remaining === 0
      ? mt(resultDeleted ? 'Resolved as deleted' : 'All changes processed')
      : useChinese ? '剩余 ' + String(remaining) + ' 处更改待解决' : String(remaining) + (remaining === 1 ? ' change' : ' changes') + ' left to resolve';
    updateNumbers();
    rebuildGeometry();
    editors.forEach((_editor, index) => updateHighlight(index));
    rebuildStripButtons();
    renderOverlays();
    renderRuler();
    if (reveal) showCurrent(reveal);
  }

  /**
   * Brings the current change into view. Navigation always jumps; an action
   * only scrolls when the change it moved on to has left the viewport, since
   * applying a side you can see should not jerk the pane out from under you.
   *
   * Deliberately no setSelectionRange: the textarea paints its text
   * transparently over the syntax layer, so a selection would cover the change
   * with a solid block. The band marks it instead.
   */
  function showCurrent(mode) {
    if (!model.regions.length) return;
    const selected = model.regions[currentConflict];
    const line = result.value.slice(0, selected.start).split(/\r\n|\r|\n/).length - 1;
    const lineHeight = lineHeightOf(1);
    const top = result.scrollTop / lineHeight;
    const bottom = top + result.clientHeight / lineHeight;
    if (mode === 'reveal' && line >= top + 1 && line <= bottom - 2) return;
    result.scrollTop = Math.max(0, line * lineHeight - result.clientHeight / 3);
    syncFrom(result);
  }

  function scheduleUpdate(reveal) {
    if (updateFrame) cancelAnimationFrame(updateFrame);
    updateFrame = requestAnimationFrame(() => { updateFrame = undefined; updateControls(reveal); });
  }

  function serializeResult() {
    return MergeRegions.toMarkerText(model, markerLabels);
  }

  function saveDraft(immediate = false) {
    if (draftTimer) clearTimeout(draftTimer);
    // A draft send also closes the current typing burst, so the next keystroke
    // after a pause becomes its own undo step.
    const send = () => { draftTimer = undefined; typingRun = false; vscode.postMessage({ type: 'dirty', result: serializeResult(), deleted: resultDeleted }); };
    if (immediate) send(); else draftTimer = setTimeout(send, 300);
  }

  /**
   * One undo step per decision. Assigning textarea.value discards the control's
   * native history, so after any gutter or toolbar action Ctrl+Z silently did
   * nothing at all; the model keeps its own stacks instead, where every action
   * is one step and a typing burst collapses into one.
   */
  function captureState() { return { text: model.text, regions: model.regions, deleted: resultDeleted }; }

  function pushUndo(state) {
    undoStack.push(state);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
    typingRun = false;
  }

  function restoreState(state) {
    model = { text: state.text, regions: state.regions };
    setResultText(model.text);
    resultDeleted = state.deleted;
    typingRun = false;
    saveDraft();
    updateControls();
  }

  function undoStep() {
    if (!undoStack.length || applying) return;
    redoStack.push(captureState());
    restoreState(undoStack.pop());
  }

  function redoStep() {
    if (!redoStack.length || applying) return;
    undoStack.push(captureState());
    restoreState(redoStack.pop());
  }

  function setResultText(text) {
    result.value = text;
    alignmentCache.clear();
  }

  /** Moves the selection to the next unresolved change, the way IDEA walks on. */
  function advanceFrom(index) {
    const total = model.regions.length;
    for (let step = 1; step <= total; step += 1) {
      const candidate = (index + step) % total;
      if (model.regions[candidate].resolution === undefined) { currentConflict = candidate; return; }
    }
  }

  function resolveAs(index, side) {
    if (!model.regions[index]) return;
    pushUndo(captureState());
    model = MergeRegions.resolveRegion(model, index, side);
    setResultText(model.text);
    resultDeleted = false;
    advanceFrom(index);
    saveDraft();
    updateControls('reveal');
  }

  function ignoreAt(index) {
    if (!model.regions[index]) return;
    pushUndo(captureState());
    model = MergeRegions.ignoreRegion(model, index);
    advanceFrom(index);
    saveDraft();
    updateControls('reveal');
  }

  /** Undoes one change's resolution, leaving every other decision alone. */
  function resetAt(index) {
    if (!model.regions[index]) return;
    pushUndo(captureState());
    model = MergeRegions.resetRegion(model, index);
    setResultText(model.text);
    resultDeleted = false;
    currentConflict = index;
    saveDraft();
    updateControls('reveal');
  }

  function syncFrom(source) {
    const sourceIndex = editors.indexOf(source);
    gutters[sourceIndex].scrollTop = source.scrollTop;
    positionHighlight(sourceIndex);
    scheduleOverlays();
    scheduleHighlights();
    if (synchronizing) return;
    synchronizing = true;
    const sourceLineHeight = Number.parseFloat(getComputedStyle(source).lineHeight) || 20;
    const topLine = source.scrollTop / sourceLineHeight;
    editors.forEach((editor, index) => {
      if (editor === source) return;
      const targetLineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight) || 20;
      editor.scrollTop = alignedLine(sourceIndex, index, topLine) * targetLineHeight;
      editor.scrollLeft = source.scrollLeft;
      gutters[index].scrollTop = editor.scrollTop;
      positionHighlight(index);
    });
    requestAnimationFrame(() => { synchronizing = false; });
  }

  editors.forEach((editor) => editor.addEventListener('scroll', () => syncFrom(editor)));
  result.addEventListener('input', () => {
    // The regions follow the user's edit; one that was touched becomes manual.
    const previous = model.text;
    if (!typingRun) { pushUndo({ text: previous, regions: model.regions, deleted: resultDeleted }); typingRun = true; }
    model = { text: result.value, regions: MergeRegions.applyEdit(model.regions, MergeRegions.textDelta(previous, result.value)) };
    resultDeleted = false;
    alignmentCache.clear();
    saveDraft();
    scheduleUpdate();
  });
  // The textarea's own history is unusable once .value has been assigned, so
  // its undo gestures are intercepted wherever they come from.
  result.addEventListener('beforeinput', (event) => {
    if (event.inputType === 'historyUndo') { event.preventDefault(); undoStep(); }
    else if (event.inputType === 'historyRedo') { event.preventDefault(); redoStep(); }
  });
  result.addEventListener('click', () => {
    const index = model.regions.findIndex((region) => result.selectionStart >= region.start && result.selectionStart <= region.end);
    if (index >= 0) { currentConflict = index; updateControls(); }
  });
  document.getElementById('previous').addEventListener('click', () => {
    if (!model.regions.length) return;
    currentConflict = (currentConflict + model.regions.length - 1) % model.regions.length;
    updateControls('jump');
  });
  document.getElementById('next').addEventListener('click', () => {
    if (!model.regions.length) return;
    currentConflict = (currentConflict + 1) % model.regions.length;
    updateControls('jump');
  });
  showBaseButton.addEventListener('click', () => setShowBase(!showBase));
  // The result has to travel with the request: it is the one version the
  // extension host does not have, because the user is still editing it.
  document.getElementById('compare').addEventListener('click', () => vscode.postMessage({ type: 'compare', result: model.text }));
  document.getElementById('take-left').addEventListener('click', () => resolveAs(currentConflict, 'ours'));
  document.getElementById('take-both').addEventListener('click', () => resolveAs(currentConflict, 'both'));
  document.getElementById('take-right').addEventListener('click', () => resolveAs(currentConflict, 'theirs'));
  for (const strip of strips) {
    strip.svg.addEventListener('pointerdown', (event) => { if (event.target.nodeName === 'polygon') event.stopPropagation(); });
    strip.svg.addEventListener('click', (event) => {
      if (event.target.nodeName !== 'polygon') return;
      const index = Number(event.target.getAttribute('data-index'));
      if (Number.isInteger(index) && model.regions[index]) { currentConflict = index; updateControls(); }
    });
  }
  // Clicking the strip goes to the change nearest that point in the file.
  ruler.addEventListener('click', (event) => {
    if (!geometry.length) return;
    const fraction = (event.clientY - ruler.getBoundingClientRect().top) / Math.max(1, ruler.clientHeight);
    const target = fraction * Math.max(1, lineCount(result.value) - 1);
    let nearest = 0;
    geometry.forEach((geom, index) => {
      if (Math.abs(geom.res[0] - target) < Math.abs(geometry[nearest].res[0] - target)) nearest = index;
    });
    currentConflict = nearest;
    updateControls('jump');
  });
  window.addEventListener('resize', scheduleOverlays);
  // window.confirm() is disabled in the webview sandbox; confirmations are
  // delegated to the host, which answers with a 'confirmed' message.
  document.getElementById('accept-left').addEventListener('click', () => vscode.postMessage({ type: 'confirm', action: 'acceptLeft' }));
  document.getElementById('accept-right').addEventListener('click', () => vscode.postMessage({ type: 'confirm', action: 'acceptRight' }));
  document.getElementById('reset').addEventListener('click', () => {
    pushUndo(captureState());
    model = MergeRegions.buildModel(initialResult);
    setResultText(model.text);
    resultDeleted = initialResultDeleted;
    currentConflict = 0;
    saveDraft();
    updateControls('jump');
  });
  document.getElementById('cancel').addEventListener('click', () => {
    if (serializeResult() === initialSerialized && resultDeleted === initialResultDeleted) {
      if (draftTimer) clearTimeout(draftTimer);
      vscode.postMessage({ type: 'cancel' });
      return;
    }
    vscode.postMessage({ type: 'confirm', action: 'cancel' });
  });
  apply.addEventListener('click', () => {
    if (MergeRegions.unresolved(model.regions) !== 0 || applying) return;
    if (draftTimer) clearTimeout(draftTimer);
    applying = true;
    updateControls();
    counter.textContent = mt('Applying merge result…');
    vscode.postMessage({ type: 'apply', result: model.text, deleted: resultDeleted });
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !apply.disabled) {
      event.preventDefault();
      apply.click();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'z' || event.key === 'Z')) {
      event.preventDefault();
      if (event.shiftKey) redoStep(); else undoStep();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.key === 'y' || event.key === 'Y')) {
      event.preventDefault();
      redoStep();
      return;
    }
    if (event.key === 'F7' && model.regions.length) {
      event.preventDefault();
      document.getElementById(event.shiftKey ? 'previous' : 'next').click();
      return;
    }
    // 1/2/3 resolve the current change without reaching for the mouse. They
    // stay plain keys, so they must never fire while the user is typing text.
    if (['1', '2', '3'].includes(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey
        && document.activeElement !== result && model.regions.length) {
      event.preventDefault();
      document.getElementById(event.key === '1' ? 'take-left' : event.key === '2' ? 'take-both' : 'take-right').click();
      return;
    }
    // Escape closes the dialog in IDEA; the Abort handler still asks before
    // dropping a result that was worked on.
    if (event.key === 'Escape' && !applying) {
      event.preventDefault();
      document.getElementById('cancel').click();
    }
  });
  window.addEventListener('beforeunload', () => {
    if (loaded && (serializeResult() !== initialSerialized || resultDeleted !== initialResultDeleted)) saveDraft(true);
  });

  document.querySelectorAll('.splitter').forEach((splitter) => {
    // The wide strips sit between the panes; without this, 38px of the editor
    // is a dead zone where the wheel scrolls nothing.
    splitter.addEventListener('wheel', (event) => {
      event.preventDefault();
      result.scrollTop += event.deltaMode === 1 ? event.deltaY * lineHeightOf(1) : event.deltaY;
      syncFrom(result);
    }, { passive: false });
    const previous = splitter.previousElementSibling;
    const next = splitter.nextElementSibling;
    const resizeBy = (delta) => {
      const total = previous.getBoundingClientRect().width + next.getBoundingClientRect().width;
      const previousWidth = Math.max(180, Math.min(total - 180, previous.getBoundingClientRect().width + delta));
      previous.style.flex = '0 0 ' + String(previousWidth) + 'px';
      next.style.flex = '0 0 ' + String(total - previousWidth) + 'px';
      scheduleOverlays();
    };
    splitter.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      splitter.classList.add('active');
      let lastX = event.clientX;
      let done = false;
      // Pointer capture always delivers an end event; a window mouseup is never dispatched
      // when the button is released outside the window, which left the pane stuck to the cursor.
      try { splitter.setPointerCapture(event.pointerId); } catch (error) { /* capture is best effort */ }
      const move = (moveEvent) => { resizeBy(moveEvent.clientX - lastX); lastX = moveEvent.clientX; };
      const up = () => {
        if (done) return;
        done = true;
        splitter.classList.remove('active');
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', up);
        splitter.removeEventListener('pointercancel', up);
        splitter.removeEventListener('lostpointercapture', up);
        try { splitter.releasePointerCapture(event.pointerId); } catch (error) { /* already released */ }
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', up);
      splitter.addEventListener('pointercancel', up);
      splitter.addEventListener('lostpointercapture', up);
    });
    splitter.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      resizeBy(event.key === 'ArrowLeft' ? -20 : 20);
    });
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'load') {
      loaded = true;
      language = message.language || '';
      window.mergeVersions = message.versions;
      markerLabels = { ours: message.labels.ours, theirs: message.labels.theirs };
      left.value = message.versions.ours;
      right.value = message.versions.theirs;
      // The displayed result drops Git's markers; each conflict lives on as a range.
      model = withBases(MergeRegions.buildModel(message.versions.result), message.bases);
      setResultText(model.text);
      initialResult = message.originalResult;
      initialSerialized = MergeRegions.toMarkerText(MergeRegions.buildModel(message.originalResult), markerLabels);
      initialResultDeleted = !message.originalResultExists;
      resultDeleted = !message.versions.resultExists;
      document.getElementById('left-title').textContent = message.labels.ours + (message.versions.oursExists ? '' : ' (deleted)');
      document.getElementById('result-title').textContent = message.labels.result;
      document.getElementById('right-title').textContent = message.labels.theirs + (message.versions.theirsExists ? '' : ' (deleted)');
      currentConflict = 0;
      updateControls('jump');
      if (message.restoredDraft) {
        counter.className = 'counter';
        counter.textContent = model.regions.length
          ? counter.textContent + mt(' · draft restored')
          : mt('Draft restored · ready to apply');
      }
      return;
    }
    if (message.type === 'confirmed') {
      if (message.action === 'acceptLeft') {
        pushUndo(captureState());
        model = { text: left.value, regions: [] };
        setResultText(model.text);
        resultDeleted = !window.mergeVersions.oursExists;
        saveDraft(); updateControls();
      } else if (message.action === 'acceptRight') {
        pushUndo(captureState());
        model = { text: right.value, regions: [] };
        setResultText(model.text);
        resultDeleted = !window.mergeVersions.theirsExists;
        saveDraft(); updateControls();
      } else if (message.action === 'cancel') {
        if (draftTimer) clearTimeout(draftTimer);
        vscode.postMessage({ type: 'cancel' });
      }
      return;
    }
    if (message.type === 'applyFailed') {
      applying = false;
      updateControls();
      counter.className = 'counter error';
      counter.textContent = message.message || mt('Could not apply the merge result');
    }
    if (message.type === 'draftWarning') {
      counter.className = 'counter error'; counter.textContent = message.message;
    }
  });

  vscode.postMessage({ type: 'ready' });
`;

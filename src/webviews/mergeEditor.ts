import * as path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { GitConflictVersions } from "../git/types";
import { RepositoryManager, RepositorySnapshot } from "../repositoryManager";
import { webviewDocument } from "./html";
import { isMergeEditorMessage } from "./mergeEditorProtocol";

// The webview sandbox has no allow-modals, so window.confirm() silently
// returns false there; confirmations must round-trip through the host.
const CONFIRM_PROMPTS = new Map<string, { message: string; button: string }>([
  ["acceptLeft", { message: "Replace the complete result with the left version?", button: "Replace" }],
  ["acceptRight", { message: "Replace the complete result with the right version?", button: "Replace" }],
  ["cancel", { message: "Discard the unapplied merge result?", button: "Discard" }],
]);

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

  public constructor(private readonly manager: RepositoryManager, private readonly workspaceState: vscode.Memento) {
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

    const snapshot = this.manager.snapshot(rootPath);
    const sideLabels = await conflictSideLabels(snapshot);
    const labels: MergeEditorLabels = {
      ours: sideLabels.ours,
      result: "Result",
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
        void vscode.window.showInformationMessage(
          `The unapplied merge result for ${pathSpec} was saved as a draft.`,
          "Reopen",
        ).then((choice) => { if (choice === "Reopen") void this.open(rootPath, pathSpec); });
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
          await panel.webview.postMessage({ type: "draftWarning", message: "This result is too large for draft recovery. Apply it before closing the editor." });
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
      if (message.type === "confirm") {
        const prompt = CONFIRM_PROMPTS.get(message.action);
        if (!prompt) return;
        const answer = await vscode.window.showWarningMessage(prompt.message, { modal: true }, prompt.button);
        if (answer === prompt.button) await panel.webview.postMessage({ type: "confirmed", action: message.action });
        return;
      }
      if (message.type !== "apply" || typeof message.result !== "string") return;
      applying = true;
      try {
        if (!vscode.workspace.isTrusted) throw new Error("Merge results cannot be applied until this workspace is trusted.");
        const latest = await this.manager.conflictVersions(rootPath, pathSpec);
        if (conflictFingerprint(latest) !== fingerprint) {
          throw new Error("The conflicted file changed outside this editor. Reopen it before applying to avoid overwriting newer work.");
        }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Applying merge result for ${pathSpec}`, cancellable: false },
          () => this.manager.applyConflictResult(rootPath, pathSpec, message.result, message.deleted === true),
        );
        allowDispose = true;
        dirty = false;
        delete this.drafts[key];
        await this.saveDrafts();
        await vscode.window.showInformationMessage(`${pathSpec} was resolved and staged.`);
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
  const currentBranch = snapshot?.status?.branch.head ?? "Current Branch";
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
      ours: onto ? `Rebase Target · ${onto.slice(0, 10)}` : "Rebase Target · already applied commits",
      theirs: stopped
        ? `Replayed Commit${originalBranch ? ` from ${originalBranch}` : ""} · ${stopped.slice(0, 10)}`
        : `Replayed Commit${originalBranch ? ` from ${originalBranch}` : ""}`,
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
  const suffix = branch ? ` from ${branch.name}` : revision ? ` · ${revision.slice(0, 10)}` : "";
  const theirs = operation === "merge"
    ? `Merged Changes${suffix}`
    : operation === "cherry-pick"
      ? `Cherry-picked Commit${suffix}`
      : operation === "revert"
        ? `Revert Result${suffix}`
        : "Incoming Changes";
  return { ours: `Changes from ${currentBranch}`, theirs };
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
  .splitter polygon { pointer-events: auto; cursor: pointer; stroke-width: 1; }
  .connector-conflict { fill: color-mix(in srgb, var(--merge-conflict) 15%, transparent); stroke: color-mix(in srgb, var(--merge-conflict) 45%, transparent); }
  .connector-current { fill: color-mix(in srgb, var(--merge-conflict) 30%, transparent); stroke: color-mix(in srgb, var(--merge-conflict) 85%, transparent); stroke-width: 1.5; }
  .connector-applied { fill: color-mix(in srgb, var(--merge-applied) 15%, transparent); stroke: color-mix(in srgb, var(--merge-applied) 45%, transparent); }
  .connector-manual { fill: color-mix(in srgb, var(--merge-edited) 15%, transparent); stroke: color-mix(in srgb, var(--merge-edited) 45%, transparent); }
  .connector-ignored { fill: color-mix(in srgb, var(--merge-muted) 13%, transparent); stroke: color-mix(in srgb, var(--merge-muted) 40%, transparent); }
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
     text the user rewrote, grey for a change that was looked at and ignored. */
  .band-conflict { background: color-mix(in srgb, var(--merge-conflict) 13%, transparent); box-shadow: -8px 0 0 0 color-mix(in srgb, var(--merge-conflict) 13%, transparent); }
  .band-current { background: color-mix(in srgb, var(--merge-conflict) 26%, transparent); box-shadow: -8px 0 0 0 color-mix(in srgb, var(--merge-conflict) 26%, transparent); }
  .band-applied { background: color-mix(in srgb, var(--merge-applied) 14%, transparent); box-shadow: -8px 0 0 0 color-mix(in srgb, var(--merge-applied) 14%, transparent); }
  .band-manual { background: color-mix(in srgb, var(--merge-edited) 14%, transparent); box-shadow: -8px 0 0 0 color-mix(in srgb, var(--merge-edited) 14%, transparent); }
  .band-ignored { background: color-mix(in srgb, var(--merge-muted) 12%, transparent); box-shadow: -8px 0 0 0 color-mix(in srgb, var(--merge-muted) 12%, transparent); }
  .band-side { background: color-mix(in srgb, var(--merge-conflict) 11%, transparent); box-shadow: -8px 0 0 0 color-mix(in srgb, var(--merge-conflict) 11%, transparent); }
  .band-side-current { background: color-mix(in srgb, var(--merge-conflict) 22%, transparent); box-shadow: -8px 0 0 0 color-mix(in srgb, var(--merge-conflict) 22%, transparent); }
  .band-side-done { background: color-mix(in srgb, var(--merge-muted) 10%, transparent); box-shadow: -8px 0 0 0 color-mix(in srgb, var(--merge-muted) 10%, transparent); }
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
    'Loading conflict…': '正在加载冲突…', 'Current branch': '当前分支', 'Result': '结果',
    'Incoming changes': '传入更改', 'Accept Left': '接受左侧', 'Accept Right': '接受右侧',
    'Use the arrows between the panes to apply a side, × to ignore it, or edit the result directly.': '使用面板之间的箭头应用某一侧，× 忽略该更改，也可以直接编辑中间结果。',
    'Apply this change to the result': '将此更改应用到结果',
    'Keep both: append this side too': '两者都保留：再追加此侧',
    'Ignore this change and keep the result text': '忽略此更改，保留当前结果文本',
    'Revert this change to unresolved': '撤销此更改，恢复为未解决',
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
        '<button id="take-left" class="secondary" title="Use the current conflict from the left pane">← Left</button>',
        '<button id="take-both" class="secondary" title="Keep both sides of the current conflict">Both</button>',
        '<button id="take-right" class="secondary" title="Use the current conflict from the right pane">Right →</button>',
        '<button id="reset" class="secondary" title="Restore the original conflicted result" disabled>Reset</button>',
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
          '<div class="code-shell"><pre id="result-lines" class="line-numbers" aria-hidden="true"></pre><div class="editor-stack"><pre id="result-highlight" class="syntax-layer" aria-hidden="true"></pre><textarea id="result" spellcheck="false" aria-label="Editable merge result"></textarea></div></div>',
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
  const apply = document.getElementById('apply');
  const conflictButtons = ['previous', 'next', 'take-left', 'take-both', 'take-right'].map((id) => document.getElementById(id));
  const wholeFileButtons = ['accept-left', 'accept-right', 'reset'].map((id) => document.getElementById(id));
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
  let applying = false;
  let loaded = false;
  let synchronizing = false;
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

  function regionState(region, index) {
    if (region.resolution === undefined) return index === currentConflict ? 'current' : 'conflict';
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
        state: regionState(region, index),
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
      const width = strip.svg.clientWidth || 32;
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
        shapes += '<polygon class="connector-' + geom.state + '" data-index="' + String(index) + '" points="0,'
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

  /** Ranges to shade in one pane, coloured by each change's state like IDEA. */
  function bandsFor(index) {
    if (!model.regions.length) return [];
    if (index === 1) {
      return model.regions
        .map((region, position) => ({ start: region.start, end: region.end, className: 'band-' + regionState(region, position) }))
        .filter((band) => band.end > band.start);
    }
    const offsets = chunkOffsets[index] || [];
    const bands = [];
    model.regions.forEach((region, position) => {
      const chunk = offsets[position];
      if (!chunk || chunk.end <= chunk.start) return;
      const className = region.resolution !== undefined ? 'band-side-done'
        : position === currentConflict ? 'band-side-current' : 'band-side';
      bands.push({ start: chunk.start, end: chunk.end, className });
    });
    return bands;
  }

  function updateHighlight(index) {
    const editor = editors[index]; const target = highlights[index];
    if (editor.value.length > 1000000) {
      editor.classList.remove('syntax-enabled'); target.replaceChildren(); return;
    }
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const band of bandsFor(index)) {
      if (band.start < cursor) continue;
      if (band.start > cursor) tokenizeInto(fragment, editor.value.slice(cursor, band.start));
      const shaded = document.createElement('span');
      shaded.className = band.className;
      tokenizeInto(shaded, editor.value.slice(band.start, band.end));
      fragment.append(shaded);
      cursor = band.end;
    }
    if (cursor < editor.value.length) tokenizeInto(fragment, editor.value.slice(cursor));
    target.replaceChildren(fragment); editor.classList.add('syntax-enabled');
    target.style.transform = 'translate(' + String(-editor.scrollLeft) + 'px,' + String(-editor.scrollTop) + 'px)';
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

  function updateControls(selectCurrent) {
    const total = model.regions.length;
    currentConflict = total === 0 ? 0 : Math.max(0, Math.min(currentConflict, total - 1));
    const remaining = MergeRegions.unresolved(model.regions);
    conflictButtons.forEach((button) => { button.disabled = total === 0 || applying; });
    wholeFileButtons.forEach((button) => { button.disabled = !loaded || applying; });
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
    if (selectCurrent && total) {
      const selected = model.regions[currentConflict];
      // Deliberately no setSelectionRange: the textarea paints its text
      // transparently over the syntax layer, so a selection would cover the
      // conflict with a solid block. The band highlight marks it instead.
      const line = result.value.slice(0, selected.start).split(/\r\n|\r|\n/).length - 1;
      const lineHeight = Number.parseFloat(getComputedStyle(result).lineHeight) || 20;
      result.scrollTop = Math.max(0, line * lineHeight - result.clientHeight / 3);
      syncFrom(result);
    }
  }

  function scheduleUpdate(selectCurrent = false) {
    if (updateFrame) cancelAnimationFrame(updateFrame);
    updateFrame = requestAnimationFrame(() => { updateFrame = undefined; updateControls(selectCurrent); });
  }

  function serializeResult() {
    return MergeRegions.toMarkerText(model, markerLabels);
  }

  function saveDraft(immediate = false) {
    if (draftTimer) clearTimeout(draftTimer);
    const send = () => { draftTimer = undefined; vscode.postMessage({ type: 'dirty', result: serializeResult(), deleted: resultDeleted }); };
    if (immediate) send(); else draftTimer = setTimeout(send, 300);
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
    model = MergeRegions.resolveRegion(model, index, side);
    setResultText(model.text);
    resultDeleted = false;
    advanceFrom(index);
    saveDraft();
    updateControls(false);
  }

  function ignoreAt(index) {
    if (!model.regions[index]) return;
    model = MergeRegions.ignoreRegion(model, index);
    advanceFrom(index);
    saveDraft();
    updateControls(false);
  }

  /** Undoes one change's resolution, leaving every other decision alone. */
  function resetAt(index) {
    if (!model.regions[index]) return;
    model = MergeRegions.resetRegion(model, index);
    setResultText(model.text);
    resultDeleted = false;
    currentConflict = index;
    saveDraft();
    updateControls(false);
  }

  function syncFrom(source) {
    const sourceIndex = editors.indexOf(source);
    gutters[sourceIndex].scrollTop = source.scrollTop;
    highlights[sourceIndex].style.transform = 'translate(' + String(-source.scrollLeft) + 'px,' + String(-source.scrollTop) + 'px)';
    scheduleOverlays();
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
      highlights[index].style.transform = 'translate(' + String(-editor.scrollLeft) + 'px,' + String(-editor.scrollTop) + 'px)';
    });
    requestAnimationFrame(() => { synchronizing = false; });
  }

  editors.forEach((editor) => editor.addEventListener('scroll', () => syncFrom(editor)));
  result.addEventListener('input', () => {
    // The regions follow the user's edit; one that was touched becomes manual.
    const previous = model.text;
    model = { text: result.value, regions: MergeRegions.applyEdit(model.regions, MergeRegions.textDelta(previous, result.value)) };
    resultDeleted = false;
    alignmentCache.clear();
    saveDraft();
    scheduleUpdate(false);
  });
  result.addEventListener('click', () => {
    const index = model.regions.findIndex((region) => result.selectionStart >= region.start && result.selectionStart <= region.end);
    if (index >= 0) { currentConflict = index; updateControls(false); }
  });
  document.getElementById('previous').addEventListener('click', () => {
    if (!model.regions.length) return;
    currentConflict = (currentConflict + model.regions.length - 1) % model.regions.length;
    updateControls(true);
  });
  document.getElementById('next').addEventListener('click', () => {
    if (!model.regions.length) return;
    currentConflict = (currentConflict + 1) % model.regions.length;
    updateControls(true);
  });
  document.getElementById('take-left').addEventListener('click', () => resolveAs(currentConflict, 'ours'));
  document.getElementById('take-both').addEventListener('click', () => resolveAs(currentConflict, 'both'));
  document.getElementById('take-right').addEventListener('click', () => resolveAs(currentConflict, 'theirs'));
  for (const strip of strips) {
    strip.svg.addEventListener('pointerdown', (event) => { if (event.target.nodeName === 'polygon') event.stopPropagation(); });
    strip.svg.addEventListener('click', (event) => {
      if (event.target.nodeName !== 'polygon') return;
      const index = Number(event.target.getAttribute('data-index'));
      if (Number.isInteger(index) && model.regions[index]) { currentConflict = index; updateControls(false); }
    });
  }
  window.addEventListener('resize', scheduleOverlays);
  // window.confirm() is disabled in the webview sandbox; confirmations are
  // delegated to the host, which answers with a 'confirmed' message.
  document.getElementById('accept-left').addEventListener('click', () => vscode.postMessage({ type: 'confirm', action: 'acceptLeft' }));
  document.getElementById('accept-right').addEventListener('click', () => vscode.postMessage({ type: 'confirm', action: 'acceptRight' }));
  document.getElementById('reset').addEventListener('click', () => {
    model = MergeRegions.buildModel(initialResult);
    setResultText(model.text);
    resultDeleted = initialResultDeleted;
    currentConflict = 0;
    saveDraft();
    updateControls(true);
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
    updateControls(false);
    counter.textContent = mt('Applying merge result…');
    vscode.postMessage({ type: 'apply', result: model.text, deleted: resultDeleted });
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !apply.disabled) {
      event.preventDefault();
      apply.click();
      return;
    }
    if (event.key === 'F7' && model.regions.length) {
      event.preventDefault();
      document.getElementById(event.shiftKey ? 'previous' : 'next').click();
    }
  });
  window.addEventListener('beforeunload', () => {
    if (loaded && (serializeResult() !== initialSerialized || resultDeleted !== initialResultDeleted)) saveDraft(true);
  });

  document.querySelectorAll('.splitter').forEach((splitter) => {
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
      model = MergeRegions.buildModel(message.versions.result);
      setResultText(model.text);
      initialResult = message.originalResult;
      initialSerialized = MergeRegions.toMarkerText(MergeRegions.buildModel(message.originalResult), markerLabels);
      initialResultDeleted = !message.originalResultExists;
      resultDeleted = !message.versions.resultExists;
      document.getElementById('left-title').textContent = message.labels.ours + (message.versions.oursExists ? '' : ' (deleted)');
      document.getElementById('result-title').textContent = message.labels.result;
      document.getElementById('right-title').textContent = message.labels.theirs + (message.versions.theirsExists ? '' : ' (deleted)');
      currentConflict = 0;
      updateControls(true);
      if (message.restoredDraft) {
        counter.className = 'counter';
        counter.textContent = model.regions.length ? counter.textContent + ' · draft restored' : 'Draft restored · ready to apply';
      }
      return;
    }
    if (message.type === 'confirmed') {
      if (message.action === 'acceptLeft') {
        model = { text: left.value, regions: [] };
        setResultText(model.text);
        resultDeleted = !window.mergeVersions.oursExists;
        saveDraft(); updateControls(false);
      } else if (message.action === 'acceptRight') {
        model = { text: right.value, regions: [] };
        setResultText(model.text);
        resultDeleted = !window.mergeVersions.theirsExists;
        saveDraft(); updateControls(false);
      } else if (message.action === 'cancel') {
        if (draftTimer) clearTimeout(draftTimer);
        vscode.postMessage({ type: 'cancel' });
      }
      return;
    }
    if (message.type === 'applyFailed') {
      applying = false;
      updateControls(false);
      counter.className = 'counter error';
      counter.textContent = message.message || 'Could not apply the merge result';
    }
    if (message.type === 'draftWarning') {
      counter.className = 'counter error'; counter.textContent = message.message;
    }
  });

  vscode.postMessage({ type: 'ready' });
`;

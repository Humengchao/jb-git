import * as path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { GitConflictVersions } from "../git/types";
import { RepositoryManager } from "../repositoryManager";
import { webviewDocument } from "./html";

type MergeEditorMessage =
  | { type: "ready" }
  | { type: "apply"; result: string; deleted?: boolean }
  | { type: "dirty"; result: string; deleted?: boolean }
  | { type: "cancel" };

interface MergeEditorLabels {
  ours: string;
  result: string;
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

/** IntelliJ-inspired three-pane editor for a single unmerged text file. */
export class MergeConflictEditor implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly drafts: Record<string, MergeDraft>;
  private draftSaveTimer?: NodeJS.Timeout;
  private disposed = false;

  public constructor(private readonly manager: RepositoryManager, private readonly workspaceState: vscode.Memento) {
    const persisted = workspaceState.get<PersistedMergeDrafts>(MERGE_DRAFTS_KEY);
    this.drafts = persisted?.version === 1 ? { ...persisted.drafts } : {};
  }

  /** Returns false for binary conflicts, which must use a whole-file fallback. */
  public async open(rootPath: string, pathSpec: string): Promise<boolean> {
    const key = `${rootPath}\0${pathSpec}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Active, false);
      return true;
    }

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
    const operation = snapshot?.operation.kind ?? "none";
    let incomingLabel = operation === "none"
      ? "Incoming Changes"
      : `Incoming Changes (${operation === "cherry-pick" ? "Cherry-pick" : operation[0].toUpperCase() + operation.slice(1)})`;
    if (snapshot?.operation.detail && ["merge", "cherry-pick", "revert"].includes(operation)) {
      try {
        const revision = (await readFile(snapshot.operation.detail, "utf8")).trim().split(/\s+/)[0];
        const branch = snapshot.branches.find((candidate) => candidate.oid === revision);
        incomingLabel = branch ? `Changes from ${branch.name}` : `${incomingLabel} · ${revision.slice(0, 10)}`;
      } catch {
        // The operation may finish while the editor is opening; the generic label remains useful.
      }
    }
    const labels: MergeEditorLabels = {
      ours: `Changes from ${snapshot?.status?.branch.head ?? "Current Branch"}`,
      result: "Result",
      theirs: incomingLabel,
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
    let messageRegistration: vscode.Disposable | undefined;
    const disposeRegistration = panel.onDidDispose(() => {
      disposeRegistration.dispose();
      messageRegistration?.dispose();
      this.panels.delete(key);
      if (dirty && !allowDispose && !this.disposed) {
        void vscode.window.showInformationMessage(
          `The unapplied merge result for ${pathSpec} was saved as a draft.`,
          "Reopen",
        ).then((choice) => { if (choice === "Reopen") void this.open(rootPath, pathSpec); });
      }
    });
    messageRegistration = panel.webview.onDidReceiveMessage(async (message: MergeEditorMessage) => {
      if (message.type === "ready") {
        await panel.webview.postMessage({
          type: "load",
          versions: displayedVersions,
          originalResult: versions.result,
          originalResultExists: versions.resultExists,
          labels,
          title,
          restoredDraft: Boolean(restoredDraft),
        });
        return;
      }
      if (message.type === "dirty" && typeof message.result === "string") {
        dirty = true;
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
      if (message.type !== "apply" || typeof message.result !== "string") return;
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
        await panel.webview.postMessage({ type: "applyFailed", message: detail });
      }
    });
    panel.webview.html = webviewDocument(panel.webview, title, mergeStyles, mergeScript);
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
  .merge-root { display: grid; grid-template-rows: 42px minmax(0, 1fr) 50px; height: 100%; min-width: 650px; }
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
  .splitter { flex: 0 0 7px; position: relative; cursor: col-resize; background: var(--vscode-panel-border); }
  .splitter::after { content: ''; position: absolute; top: 0; bottom: 0; left: 3px; width: 1px; background: var(--vscode-contrastBorder, transparent); }
  .splitter:hover, .splitter.active { background: var(--vscode-sash-hoverBorder); }
  .code-shell { display: grid; grid-template-columns: 48px minmax(0, 1fr); min-height: 0; overflow: hidden; }
  .line-numbers { margin: 0; padding: 10px 8px 30px 4px; overflow: hidden; user-select: none; text-align: right; color: var(--vscode-editorLineNumber-foreground); background: var(--vscode-editorGutter-background); font: var(--vscode-editor-font-size, 13px) / var(--vscode-editor-line-height, 20px) var(--vscode-editor-font-family, monospace); }
  textarea { width: 100%; height: 100%; margin: 0; padding: 10px 12px 30px; border: 0; outline: 0; resize: none; overflow: auto; white-space: pre; tab-size: var(--vscode-editor-tab-size, 4); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); caret-color: var(--vscode-editorCursor-foreground); font: var(--vscode-editor-font-size, 13px) / var(--vscode-editor-line-height, 20px) var(--vscode-editor-font-family, monospace); }
  textarea[readonly] { color: var(--vscode-editor-foreground); }
  textarea:focus { box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }
  textarea::selection { background: var(--vscode-editor-selectionBackground); }
  .footer-group { display: flex; align-items: center; gap: 8px; }
  .hint { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 850px) { .non-conflicting, .hint { display: none; } .toolbar button { padding-left: 7px; padding-right: 7px; } }
`;

// Kept as a standalone embedded script so its conflict parsing and CSP syntax can be unit-tested.
const mergeScript = String.raw`
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  app.innerHTML = [
    '<div class="merge-root">',
      '<div class="toolbar">',
        '<button id="previous" class="secondary icon" title="Previous conflict" aria-label="Previous conflict">↑</button>',
        '<button id="next" class="secondary icon" title="Next conflict" aria-label="Next conflict">↓</button>',
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
          '<div class="code-shell"><pre id="left-lines" class="line-numbers" aria-hidden="true"></pre><textarea id="left" readonly spellcheck="false" aria-label="Current branch version"></textarea></div>',
        '</section>',
        '<div class="splitter" role="separator" aria-orientation="vertical" tabindex="0"></div>',
        '<section id="result-pane" class="pane result">',
          '<div id="result-title" class="pane-title">Result</div>',
          '<div class="code-shell"><pre id="result-lines" class="line-numbers" aria-hidden="true"></pre><textarea id="result" spellcheck="false" aria-label="Editable merge result"></textarea></div>',
        '</section>',
        '<div class="splitter" role="separator" aria-orientation="vertical" tabindex="0"></div>',
        '<section id="right-pane" class="pane">',
          '<div id="right-title" class="pane-title">Incoming changes</div>',
          '<div class="code-shell"><pre id="right-lines" class="line-numbers" aria-hidden="true"></pre><textarea id="right" readonly spellcheck="false" aria-label="Incoming version"></textarea></div>',
        '</section>',
      '</div>',
      '<div class="footer">',
        '<div class="footer-group">',
          '<button id="accept-left" class="secondary" disabled>Accept Left</button>',
          '<button id="accept-right" class="secondary" disabled>Accept Right</button>',
          '<span class="hint">Edit the center pane or resolve each conflict with the toolbar.</span>',
        '</div>',
        '<div class="footer-group"><button id="cancel" class="secondary">Cancel</button><button id="apply" disabled>Apply</button></div>',
      '</div>',
    '</div>',
  ].join('');

  const left = document.getElementById('left');
  const result = document.getElementById('result');
  const right = document.getElementById('right');
  const counter = document.getElementById('counter');
  const apply = document.getElementById('apply');
  const conflictButtons = ['previous', 'next', 'take-left', 'take-both', 'take-right'].map((id) => document.getElementById(id));
  const wholeFileButtons = ['accept-left', 'accept-right', 'reset'].map((id) => document.getElementById(id));
  const editors = [left, result, right];
  const gutters = [document.getElementById('left-lines'), document.getElementById('result-lines'), document.getElementById('right-lines')];
  let initialResult = '';
  let initialResultDeleted = false;
  let resultDeleted = false;
  let conflicts = [];
  let currentConflict = 0;
  let applying = false;
  let loaded = false;
  let synchronizing = false;
  let updateFrame;

  function marker(pattern, text, from) {
    pattern.lastIndex = from;
    return pattern.exec(text);
  }

  function parseConflicts(text) {
    const entries = [];
    const startPattern = /^<{7,}[^\r\n]*(?:\r?\n|$)/gm;
    let start;
    while ((start = marker(startPattern, text, startPattern.lastIndex))) {
      const base = marker(/^\|{7,}[^\r\n]*(?:\r?\n|$)/gm, text, start.index + start[0].length);
      const divider = marker(/^={7,}(?:\r?\n|$)/gm, text, start.index + start[0].length);
      if (!divider) break;
      const end = marker(/^>{7,}[^\r\n]*(?:\r?\n|$)/gm, text, divider.index + divider[0].length);
      if (!end) break;
      const oursEnd = base && base.index < divider.index ? base.index : divider.index;
      entries.push({
        start: start.index,
        end: end.index + end[0].length,
        ours: text.slice(start.index + start[0].length, oursEnd),
        theirs: text.slice(divider.index + divider[0].length, end.index),
      });
      startPattern.lastIndex = end.index + end[0].length;
    }
    return entries;
  }

  function numbersFor(value) {
    const count = Math.max(1, value.split(/\r\n|\r|\n/).length);
    return Array.from({ length: count }, (_, index) => String(index + 1)).join('\n');
  }

  function updateNumbers() {
    gutters[0].textContent = numbersFor(left.value);
    gutters[1].textContent = numbersFor(result.value);
    gutters[2].textContent = numbersFor(right.value);
    gutters.forEach((gutter, index) => { gutter.scrollTop = editors[index].scrollTop; });
  }

  function updateControls(selectCurrent) {
    conflicts = parseConflicts(result.value);
    if (conflicts.length === 0) currentConflict = 0;
    else currentConflict = Math.max(0, Math.min(currentConflict, conflicts.length - 1));
    conflictButtons.forEach((button) => { button.disabled = conflicts.length === 0 || applying; });
    wholeFileButtons.forEach((button) => { button.disabled = !loaded || applying; });
    apply.disabled = !loaded || conflicts.length !== 0 || applying;
    counter.className = 'counter' + (conflicts.length === 0 ? ' resolved' : '');
    counter.textContent = conflicts.length === 0
      ? (resultDeleted ? 'Resolved as deleted' : 'No unresolved conflicts')
      : String(currentConflict + 1) + ' of ' + String(conflicts.length) + ' conflicts';
    updateNumbers();
    if (selectCurrent && conflicts.length) {
      const selected = conflicts[currentConflict];
      result.focus();
      result.setSelectionRange(selected.start, selected.end);
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

  function saveDraft() {
    vscode.postMessage({ type: 'dirty', result: result.value, deleted: resultDeleted });
  }

  function chooseCurrent(side) {
    if (!conflicts.length) return;
    const selected = conflicts[currentConflict];
    let replacement = selected[side];
    if (side === 'both') {
      const separator = selected.ours && selected.theirs && !/\r?\n$/.test(selected.ours) ? (result.value.includes('\r\n') ? '\r\n' : '\n') : '';
      replacement = selected.ours + separator + selected.theirs;
    }
    result.value = result.value.slice(0, selected.start) + replacement + result.value.slice(selected.end);
    resultDeleted = false;
    saveDraft(); updateControls(true);
  }

  function syncFrom(source) {
    const sourceIndex = editors.indexOf(source);
    gutters[sourceIndex].scrollTop = source.scrollTop;
    if (synchronizing) return;
    synchronizing = true;
    const sourceLineHeight = Number.parseFloat(getComputedStyle(source).lineHeight) || 20;
    const topLine = source.scrollTop / sourceLineHeight;
    editors.forEach((editor, index) => {
      if (editor === source) return;
      const targetLineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight) || 20;
      editor.scrollTop = topLine * targetLineHeight;
      gutters[index].scrollTop = editor.scrollTop;
    });
    requestAnimationFrame(() => { synchronizing = false; });
  }

  editors.forEach((editor) => editor.addEventListener('scroll', () => syncFrom(editor)));
  result.addEventListener('input', () => { resultDeleted = false; saveDraft(); scheduleUpdate(false); });
  result.addEventListener('click', () => {
    const index = conflicts.findIndex((entry) => result.selectionStart >= entry.start && result.selectionStart <= entry.end);
    if (index >= 0) { currentConflict = index; updateControls(false); }
  });
  document.getElementById('previous').addEventListener('click', () => {
    if (!conflicts.length) return;
    currentConflict = (currentConflict + conflicts.length - 1) % conflicts.length;
    updateControls(true);
  });
  document.getElementById('next').addEventListener('click', () => {
    if (!conflicts.length) return;
    currentConflict = (currentConflict + 1) % conflicts.length;
    updateControls(true);
  });
  document.getElementById('take-left').addEventListener('click', () => chooseCurrent('ours'));
  document.getElementById('take-both').addEventListener('click', () => chooseCurrent('both'));
  document.getElementById('take-right').addEventListener('click', () => chooseCurrent('theirs'));
  document.getElementById('accept-left').addEventListener('click', () => {
    if (!window.confirm('Replace the complete result with the left version?')) return;
    result.value = left.value; resultDeleted = !window.mergeVersions.oursExists; saveDraft(); updateControls(false);
  });
  document.getElementById('accept-right').addEventListener('click', () => {
    if (!window.confirm('Replace the complete result with the right version?')) return;
    result.value = right.value; resultDeleted = !window.mergeVersions.theirsExists; saveDraft(); updateControls(false);
  });
  document.getElementById('reset').addEventListener('click', () => { result.value = initialResult; resultDeleted = initialResultDeleted; currentConflict = 0; saveDraft(); updateControls(true); });
  document.getElementById('cancel').addEventListener('click', () => {
    if ((result.value === initialResult && resultDeleted === initialResultDeleted) || window.confirm('Discard the unapplied merge result?')) vscode.postMessage({ type: 'cancel' });
  });
  apply.addEventListener('click', () => {
    if (conflicts.length || applying) return;
    applying = true;
    updateControls(false);
    counter.textContent = 'Applying merge result…';
    vscode.postMessage({ type: 'apply', result: result.value, deleted: resultDeleted });
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !apply.disabled) {
      event.preventDefault();
      apply.click();
    }
  });
  window.addEventListener('beforeunload', () => {
    if (loaded && (result.value !== initialResult || resultDeleted !== initialResultDeleted)) vscode.postMessage({ type: 'dirty', result: result.value, deleted: resultDeleted });
  });

  document.querySelectorAll('.splitter').forEach((splitter) => {
    const previous = splitter.previousElementSibling;
    const next = splitter.nextElementSibling;
    const resizeBy = (delta) => {
      const total = previous.getBoundingClientRect().width + next.getBoundingClientRect().width;
      const previousWidth = Math.max(180, Math.min(total - 180, previous.getBoundingClientRect().width + delta));
      previous.style.flex = '0 0 ' + String(previousWidth) + 'px';
      next.style.flex = '0 0 ' + String(total - previousWidth) + 'px';
    };
    splitter.addEventListener('mousedown', (event) => {
      event.preventDefault();
      splitter.classList.add('active');
      let lastX = event.clientX;
      const move = (moveEvent) => { resizeBy(moveEvent.clientX - lastX); lastX = moveEvent.clientX; };
      const up = () => {
        splitter.classList.remove('active');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
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
      window.mergeVersions = message.versions;
      left.value = message.versions.ours;
      right.value = message.versions.theirs;
      result.value = message.versions.result;
      initialResult = message.originalResult;
      initialResultDeleted = !message.originalResultExists;
      resultDeleted = !message.versions.resultExists;
      document.getElementById('left-title').textContent = message.labels.ours + (message.versions.oursExists ? '' : ' (deleted)');
      document.getElementById('result-title').textContent = message.labels.result;
      document.getElementById('right-title').textContent = message.labels.theirs + (message.versions.theirsExists ? '' : ' (deleted)');
      currentConflict = 0;
      updateControls(true);
      if (message.restoredDraft) {
        counter.className = 'counter';
        counter.textContent = conflicts.length ? counter.textContent + ' · draft restored' : 'Draft restored · ready to apply';
      }
      return;
    }
    if (message.type === 'applyFailed') {
      applying = false;
      updateControls(false);
      counter.className = 'counter error';
      counter.textContent = message.message || 'Could not apply the merge result';
    }
  });

  vscode.postMessage({ type: 'ready' });
`;

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
  | { type: "cancel" }
  | { type: "confirm"; action: string };

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
    panel.webview.html = webviewDocument(title, mergeStyles, mergeScript);
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
  .token-conflict { color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 14%, transparent); }
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
    'Previous conflict': '上一个冲突', 'Next conflict': '下一个冲突',
    '✓ Non-conflicting changes are already applied': '✓ 非冲突更改已自动应用',
    '← Left': '← 左侧', 'Both': '两者都保留', 'Right →': '右侧 →', 'Reset': '重置',
    'Loading conflict…': '正在加载冲突…', 'Current branch': '当前分支', 'Result': '结果',
    'Incoming changes': '传入更改', 'Accept Left': '接受左侧', 'Accept Right': '接受右侧',
    'Edit the center pane or resolve each conflict with the toolbar.': '编辑中间结果，或使用工具栏逐个解决冲突。',
    'Cancel': '取消', 'Apply': '应用', 'No unresolved conflicts': '没有未解决的冲突',
    'Resolved as deleted': '已解决为删除', 'Applying merge result…': '正在应用合并结果…',
  };
  const mt = value => useChinese ? (mergeZh[value] || value) : value;
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
          '<div class="code-shell"><pre id="left-lines" class="line-numbers" aria-hidden="true"></pre><div class="editor-stack"><pre id="left-highlight" class="syntax-layer" aria-hidden="true"></pre><textarea id="left" readonly spellcheck="false" aria-label="Current branch version"></textarea></div></div>',
        '</section>',
        '<div class="splitter" role="separator" aria-orientation="vertical" tabindex="0"></div>',
        '<section id="result-pane" class="pane result">',
          '<div id="result-title" class="pane-title">Result</div>',
          '<div class="code-shell"><pre id="result-lines" class="line-numbers" aria-hidden="true"></pre><div class="editor-stack"><pre id="result-highlight" class="syntax-layer" aria-hidden="true"></pre><textarea id="result" spellcheck="false" aria-label="Editable merge result"></textarea></div></div>',
        '</section>',
        '<div class="splitter" role="separator" aria-orientation="vertical" tabindex="0"></div>',
        '<section id="right-pane" class="pane">',
          '<div id="right-title" class="pane-title">Incoming changes</div>',
          '<div class="code-shell"><pre id="right-lines" class="line-numbers" aria-hidden="true"></pre><div class="editor-stack"><pre id="right-highlight" class="syntax-layer" aria-hidden="true"></pre><textarea id="right" readonly spellcheck="false" aria-label="Incoming version"></textarea></div></div>',
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
  let initialResult = '';
  let initialResultDeleted = false;
  let resultDeleted = false;
  let conflicts = [];
  let currentConflict = 0;
  let applying = false;
  let loaded = false;
  let synchronizing = false;
  let updateFrame;
  let draftTimer;
  let language = '';
  let lastLineCounts = [0, 0, 0];
  let alignmentCache = new Map();

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

  function updateHighlight(index) {
    const editor = editors[index]; const target = highlights[index];
    if (editor.value.length > 1000000) {
      editor.classList.remove('syntax-enabled'); target.replaceChildren(); return;
    }
    const pattern = /^(?:<{7,}|={7,}|>{7,})[^\r\n]*|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|#[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b/gm;
    const fragment = document.createDocumentFragment(); let cursor = 0; let match;
    while ((match = pattern.exec(editor.value))) {
      if (match.index > cursor) fragment.append(document.createTextNode(editor.value.slice(cursor, match.index)));
      const className = tokenClass(match[0]);
      if (className) { const span = document.createElement('span'); span.className = className; span.textContent = match[0]; fragment.append(span); }
      else fragment.append(document.createTextNode(match[0]));
      cursor = match.index + match[0].length;
    }
    if (cursor < editor.value.length) fragment.append(document.createTextNode(editor.value.slice(cursor)));
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
    conflicts = parseConflicts(result.value);
    if (conflicts.length === 0) currentConflict = 0;
    else currentConflict = Math.max(0, Math.min(currentConflict, conflicts.length - 1));
    conflictButtons.forEach((button) => { button.disabled = conflicts.length === 0 || applying; });
    wholeFileButtons.forEach((button) => { button.disabled = !loaded || applying; });
    apply.disabled = !loaded || conflicts.length !== 0 || applying;
    counter.className = 'counter' + (conflicts.length === 0 ? ' resolved' : '');
    counter.textContent = conflicts.length === 0
      ? mt(resultDeleted ? 'Resolved as deleted' : 'No unresolved conflicts')
      : useChinese ? '第 ' + String(currentConflict + 1) + ' 个，共 ' + String(conflicts.length) + ' 个冲突' : String(currentConflict + 1) + ' of ' + String(conflicts.length) + ' conflicts';
    updateNumbers(); editors.forEach((_editor, index) => updateHighlight(index));
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

  function saveDraft(immediate = false) {
    if (draftTimer) clearTimeout(draftTimer);
    const send = () => { draftTimer = undefined; vscode.postMessage({ type: 'dirty', result: result.value, deleted: resultDeleted }); };
    if (immediate) send(); else draftTimer = setTimeout(send, 300);
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
    highlights[sourceIndex].style.transform = 'translate(' + String(-source.scrollLeft) + 'px,' + String(-source.scrollTop) + 'px)';
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
  result.addEventListener('input', () => { resultDeleted = false; alignmentCache.clear(); saveDraft(); scheduleUpdate(false); });
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
  // window.confirm() is disabled in the webview sandbox; confirmations are
  // delegated to the host, which answers with a 'confirmed' message.
  document.getElementById('accept-left').addEventListener('click', () => vscode.postMessage({ type: 'confirm', action: 'acceptLeft' }));
  document.getElementById('accept-right').addEventListener('click', () => vscode.postMessage({ type: 'confirm', action: 'acceptRight' }));
  document.getElementById('reset').addEventListener('click', () => { result.value = initialResult; resultDeleted = initialResultDeleted; currentConflict = 0; saveDraft(); updateControls(true); });
  document.getElementById('cancel').addEventListener('click', () => {
    if (result.value === initialResult && resultDeleted === initialResultDeleted) {
      if (draftTimer) clearTimeout(draftTimer);
      vscode.postMessage({ type: 'cancel' });
      return;
    }
    vscode.postMessage({ type: 'confirm', action: 'cancel' });
  });
  apply.addEventListener('click', () => {
    if (conflicts.length || applying) return;
    if (draftTimer) clearTimeout(draftTimer);
    applying = true;
    updateControls(false);
    counter.textContent = mt('Applying merge result…');
    vscode.postMessage({ type: 'apply', result: result.value, deleted: resultDeleted });
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !apply.disabled) {
      event.preventDefault();
      apply.click();
    }
  });
  window.addEventListener('beforeunload', () => {
    if (loaded && (result.value !== initialResult || resultDeleted !== initialResultDeleted)) saveDraft(true);
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
      alignmentCache.clear();
      updateControls(true);
      if (message.restoredDraft) {
        counter.className = 'counter';
        counter.textContent = conflicts.length ? counter.textContent + ' · draft restored' : 'Draft restored · ready to apply';
      }
      return;
    }
    if (message.type === 'confirmed') {
      if (message.action === 'acceptLeft') {
        result.value = left.value; resultDeleted = !window.mergeVersions.oursExists; saveDraft(); updateControls(false);
      } else if (message.action === 'acceptRight') {
        result.value = right.value; resultDeleted = !window.mergeVersions.theirsExists; saveDraft(); updateControls(false);
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

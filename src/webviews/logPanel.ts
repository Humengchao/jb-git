import * as path from "node:path";
import * as vscode from "vscode";
import { GitBranch, GitCommit, GitCommitFile } from "../git/types";
import { GitTraceEvent } from "../git/runner";
import { RepositoryManager } from "../repositoryManager";
import { webviewDocument } from "./html";

type LogMessage =
  | { type: "ready" }
  | { type: "selectRepository"; root: string }
  | { type: "selectRef"; ref?: string }
  | { type: "selectCommit"; hash: string }
  | { type: "checkout"; name: string; kind: GitBranch["kind"] }
  | { type: "newBranch"; hash: string }
  | { type: "cherryPick"; hash: string }
  | { type: "revert"; hash: string }
  | { type: "reset"; hash: string }
  | { type: "showPatch"; hash: string }
  | { type: "refresh" }
  | { type: "clearConsole" }
  | { type: "openCommitView" };

interface LogSelection {
  commit: GitCommit;
  files: GitCommitFile[];
}

export class IntelliJGitLogPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private selectedRoot?: string;
  private selectedRef?: string;
  private selectedHash?: string;
  private filePath?: string;
  private currentCommits: GitCommit[] = [];
  private traces: GitTraceEvent[] = [];
  private updateVersion = 0;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(private readonly manager: RepositoryManager) {
    this.disposables.push(manager.onDidChange(() => void this.update()));
  }

  public async open(root?: string, filePath?: string): Promise<void> {
    if (root && this.manager.snapshot(root)) this.selectedRoot = root;
    this.filePath = filePath;
    this.selectedRef = undefined;
    this.selectedHash = undefined;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "jbGit.gitLog",
        filePath ? `Git: History · ${path.basename(filePath)}` : "Git",
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.panel.webview.html = webviewDocument(this.panel.webview, "Git Log", logStyles, logScript);
      this.disposables.push(
        this.panel.webview.onDidReceiveMessage((message: LogMessage) => void this.handleMessage(message)),
        this.panel.onDidDispose(() => { this.panel = undefined; }),
      );
    } else {
      this.panel.title = filePath ? `Git: History · ${path.basename(filePath)}` : "Git";
      this.panel.reveal(vscode.ViewColumn.One, false);
    }
    await this.update();
  }

  public appendTrace(event: GitTraceEvent): void {
    this.traces.push(event);
    if (this.traces.length > 400) this.traces = this.traces.slice(-400);
    void this.panel?.webview.postMessage({ type: "trace", trace: event });
  }

  private currentSnapshot() {
    const all = this.manager.all;
    if (!this.selectedRoot || !all.some((item) => item.repository.info.rootPath === this.selectedRoot)) {
      this.selectedRoot = all[0]?.repository.info.rootPath;
    }
    return this.selectedRoot ? this.manager.snapshot(this.selectedRoot) : undefined;
  }

  private async update(): Promise<void> {
    const webview = this.panel?.webview;
    if (!webview) return;
    const version = ++this.updateVersion;
    const snapshot = this.currentSnapshot();
    const repositories = this.manager.all.map((item) => ({
      root: item.repository.info.rootPath,
      name: path.basename(item.repository.info.rootPath) || item.repository.info.rootPath,
      branch: item.status?.branch.head ?? "detached HEAD",
    }));
    if (!snapshot) {
      await webview.postMessage({ type: "state", state: { empty: true, repositories } });
      return;
    }
    try {
      const repository = snapshot.repository;
      const commits = this.selectedRef
        ? await repository.logRef(this.selectedRef, 300, this.filePath)
        : await repository.log(300, this.filePath);
      if (version !== this.updateVersion) return;
      this.currentCommits = commits;
      if (!this.selectedHash || !commits.some((commit) => commit.hash === this.selectedHash)) {
        this.selectedHash = commits[0]?.hash;
      }
      let selection: LogSelection | undefined;
      const commit = commits.find((item) => item.hash === this.selectedHash);
      if (commit) selection = { commit, files: await this.manager.commitFiles(repository.info.rootPath, commit.hash) };
      if (version !== this.updateVersion) return;
      await webview.postMessage({
        type: "state",
        state: {
          repositories,
          selectedRoot: repository.info.rootPath,
          branch: snapshot.status?.branch.head ?? "detached HEAD",
          selectedRef: this.selectedRef,
          filePath: this.filePath,
          branches: snapshot.branches,
          commits,
          selection,
          operation: snapshot.operation,
          error: snapshot.error,
          traces: this.traces,
        },
      });
    } catch (error) {
      if (version === this.updateVersion) await webview.postMessage({ type: "error", message: formatError(error) });
    }
  }

  private async handleMessage(message: LogMessage): Promise<void> {
    try {
      if (message.type === "ready") return void this.update();
      if (message.type === "openCommitView") {
        await vscode.commands.executeCommand("jbGit.openChanges");
        return;
      }
      if (message.type === "clearConsole") {
        this.traces = [];
        return void this.update();
      }
      if (message.type === "selectRepository") {
        if (this.manager.snapshot(message.root)) this.selectedRoot = message.root;
        this.selectedRef = undefined;
        this.selectedHash = undefined;
        return void this.update();
      }
      const snapshot = this.currentSnapshot();
      if (!snapshot) return;
      const root = snapshot.repository.info.rootPath;
      if (message.type === "selectRef") {
        if (message.ref && !snapshot.branches.some((branch) => branch.name === message.ref)) return;
        this.selectedRef = message.ref;
        this.selectedHash = undefined;
        return void this.update();
      }
      if (message.type === "selectCommit") {
        if (!/^[0-9a-f]{40}$/i.test(message.hash)) return;
        const commit = this.currentCommits.find((item) => item.hash === message.hash);
        if (!commit) return;
        this.selectedHash = message.hash;
        const files = await this.manager.commitFiles(root, commit.hash);
        if (this.selectedHash !== commit.hash) return;
        await this.panel?.webview.postMessage({ type: "selection", selection: { commit, files } });
        return;
      }
      if (message.type === "refresh") {
        await this.manager.fetch(root);
        return;
      }
      if (message.type === "showPatch") {
        if (!/^[0-9a-f]{40}$/i.test(message.hash)) return;
        const patch = await snapshot.repository.showCommit(message.hash);
        const document = await vscode.workspace.openTextDocument({ content: patch, language: "diff" });
        await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        return;
      }
      if (!(await requireTrusted())) return;
      if (message.type === "checkout") {
        const branch = snapshot.branches.find((item) => item.name === message.name && item.kind === message.kind);
        if (branch) await this.manager.checkout(root, branch.name, branch.kind);
        return;
      }
      if (!/^[0-9a-f]{40}$/i.test(message.hash)) return;
      if (message.type === "newBranch") {
        const name = await vscode.window.showInputBox({ title: "New Branch", prompt: `Create from ${message.hash.slice(0, 12)}` });
        if (name?.trim()) await this.manager.createBranch(root, name.trim(), message.hash);
        return;
      }
      if (message.type === "cherryPick") {
        const confirmed = await vscode.window.showWarningMessage(`Cherry-pick ${message.hash.slice(0, 12)}?`, { modal: true }, "Cherry-pick");
        if (confirmed === "Cherry-pick") await this.manager.cherryPick(root, message.hash);
        return;
      }
      if (message.type === "revert") {
        const confirmed = await vscode.window.showWarningMessage(`Revert ${message.hash.slice(0, 12)} with a new commit?`, { modal: true }, "Revert");
        if (confirmed === "Revert") await this.manager.revert(root, message.hash);
        return;
      }
      if (message.type === "reset") {
        const choice = await vscode.window.showQuickPick(
          [
            { label: "Soft", description: "Keep index and working tree", mode: "soft" as const },
            { label: "Mixed", description: "Reset index; keep working tree", mode: "mixed" as const },
            { label: "Hard", description: "Discard index and working tree changes", mode: "hard" as const },
          ],
          { title: `Reset current branch to ${message.hash.slice(0, 12)}` },
        );
        if (!choice) return;
        const confirmed = await vscode.window.showWarningMessage(
          `Reset ${choice.label.toLowerCase()} to ${message.hash.slice(0, 12)}?${choice.mode === "hard" ? " Local changes will be lost." : ""}`,
          { modal: true }, "Reset",
        );
        if (confirmed === "Reset") await this.manager.reset(root, message.hash, choice.mode);
        return;
      }
    } catch (error) {
      await vscode.window.showErrorMessage(formatError(error));
      await this.panel?.webview.postMessage({ type: "error", message: formatError(error) });
    }
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}

async function requireTrusted(): Promise<boolean> {
  if (vscode.workspace.isTrusted) return true;
  await vscode.window.showWarningMessage("JB Git mutations are disabled until this workspace is trusted.");
  return false;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const logStyles = String.raw`
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body, #app { width: 100%; height: 100%; margin: 0; padding: 0; }
  body { overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 12px var(--vscode-font-family); }
  button, select, input { color: inherit; font: inherit; }
  button { border: 0; background: transparent; cursor: pointer; }
  button:focus-visible, select:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .root { height: 100%; display: grid; grid-template-rows: 34px 38px minmax(0, 1fr); }
  .tool-tabs { display: flex; align-items: end; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-panel-background); }
  .tool-tab { height: 33px; padding: 0 12px; border-bottom: 2px solid transparent; color: var(--vscode-descriptionForeground); }
  .tool-tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
  .toolbar { display: flex; align-items: center; gap: 5px; padding: 5px 7px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); }
  .toolbar select, .toolbar input { height: 26px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .toolbar select { max-width: 220px; padding: 2px 5px; }
  .search { width: min(330px, 32vw); padding: 3px 7px; }
  .icon-button { min-width: 27px; height: 27px; padding: 0 7px; border-radius: 3px; }
  .icon-button:hover, .action:hover { background: var(--vscode-toolbar-hoverBackground); }
  .spacer { flex: 1; }
  .branch-label { color: var(--vscode-descriptionForeground); }
  .workspace { min-height: 0; display: grid; grid-template-columns: 185px minmax(360px, 1fr) 300px; }
  .pane { min-width: 0; min-height: 0; overflow: auto; border-right: 1px solid var(--vscode-panel-border); }
  .pane:last-child { border-right: 0; }
  .pane-title { position: sticky; top: 0; z-index: 2; height: 28px; display: flex; align-items: center; padding: 0 9px; font-weight: 600; background: var(--vscode-editorGroupHeader-tabsBackground); border-bottom: 1px solid var(--vscode-panel-border); }
  .branch-section { padding: 5px 0 2px; }
  .section-title { height: 23px; display: flex; align-items: center; padding: 0 9px; color: var(--vscode-descriptionForeground); font-weight: 600; }
  .branch-row { height: 25px; width: 100%; display: flex; align-items: center; gap: 6px; padding: 0 9px 0 16px; text-align: left; white-space: nowrap; }
  .branch-row:hover { background: var(--vscode-list-hoverBackground); }
  .branch-row.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .branch-row.current::before { content: '✓'; width: 11px; margin-left: -11px; color: var(--vscode-charts-green); }
  .branch-name { overflow: hidden; text-overflow: ellipsis; }
  .commit-pane { overflow: hidden; display: grid; grid-template-rows: 27px minmax(0, 1fr); }
  .table-head, .commit-row { display: grid; grid-template-columns: minmax(300px, 1fr) 145px 135px 82px; align-items: center; }
  .table-head { border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); color: var(--vscode-descriptionForeground); font-size: 11px; }
  .table-head > span { padding: 0 7px; border-right: 1px solid var(--vscode-panel-border); }
  .commit-list { overflow: auto; min-height: 0; }
  .commit-row { min-height: 27px; cursor: default; }
  .commit-row:hover { background: var(--vscode-list-hoverBackground); }
  .commit-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .commit-row > div { min-width: 0; padding: 0 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .subject-cell { height: 27px; display: flex; align-items: center; gap: 5px; padding-left: 0 !important; }
  canvas { flex: none; width: 72px; height: 27px; }
  .refs { display: flex; gap: 3px; flex: none; max-width: 180px; overflow: hidden; }
  .ref { padding: 1px 5px; border-radius: 8px; background: color-mix(in srgb, var(--vscode-charts-blue) 24%, transparent); color: var(--vscode-foreground); font-size: 10px; }
  .subject { overflow: hidden; text-overflow: ellipsis; }
  .muted { color: var(--vscode-descriptionForeground); }
  .details { display: grid; grid-template-rows: auto minmax(90px, 1fr) minmax(100px, 1fr); overflow: hidden; }
  .commit-details { padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); overflow: auto; }
  .detail-subject { font-size: 14px; font-weight: 600; margin-bottom: 7px; white-space: pre-wrap; }
  .detail-meta { display: grid; grid-template-columns: 54px 1fr; gap: 4px 6px; color: var(--vscode-descriptionForeground); }
  .detail-meta strong { color: var(--vscode-foreground); font-weight: 400; overflow-wrap: anywhere; }
  .detail-body { margin-top: 9px; white-space: pre-wrap; line-height: 1.45; }
  .detail-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
  .action { height: 25px; padding: 0 7px; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .files { min-height: 0; overflow: auto; }
  .file-row { min-height: 25px; display: grid; grid-template-columns: 23px minmax(0, 1fr); align-items: center; padding: 0 7px; }
  .file-row:hover { background: var(--vscode-list-hoverBackground); }
  .file-status { font-weight: 700; }
  .file-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { padding: 28px 14px; text-align: center; color: var(--vscode-descriptionForeground); }
  .error { margin: 10px; padding: 8px; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder); background: var(--vscode-inputValidation-errorBackground); }
  .console-toolbar { display: flex; align-items: center; gap: 5px; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); }
  .console { min-height: 0; overflow: auto; padding: 7px 10px 28px; background: var(--vscode-terminal-background, var(--vscode-editor-background)); color: var(--vscode-terminal-foreground, var(--vscode-foreground)); font: 12px/1.45 var(--vscode-editor-font-family); white-space: pre-wrap; overflow-wrap: anywhere; }
  .trace { margin-bottom: 9px; }
  .trace-command { color: var(--vscode-terminal-ansiCyan); }
  .trace-cwd, .trace-time { color: var(--vscode-descriptionForeground); }
  .trace-error { color: var(--vscode-terminal-ansiRed); }
  @media (max-width: 1000px) {
    .workspace { grid-template-columns: 145px minmax(270px, 1fr) 235px; }
    .table-head, .commit-row { grid-template-columns: minmax(210px, 1fr) 82px; }
    .table-head > :nth-child(3), .table-head > :nth-child(4), .commit-row > :nth-child(3), .commit-row > :nth-child(4) { display: none; }
    .commit-details { padding: 8px; }
    .detail-meta { grid-template-columns: 44px 1fr; font-size: 11px; }
    .detail-actions .action { padding: 0 5px; }
  }
  @media (max-width: 650px) { .workspace { grid-template-columns: 125px minmax(260px, 1fr); } .details { display: none; } }
`;

const logScript = String.raw`
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state = { repositories: [], branches: [], commits: [] };
  let search = '';
  let activeToolTab = 'log';
  const colors = ['#4b8ff9', '#e36d75', '#55a868', '#c887d7', '#d99b42', '#45a9a5'];
  const post = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  const node = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
  const button = (label, title, handler, className = 'icon-button') => { const b = node('button', className, label); b.type = 'button'; b.title = title; b.addEventListener('click', handler); return b; };

  function render() {
    app.replaceChildren(); const root = node('div', 'root');
    const tabs = node('div', 'tool-tabs');
    tabs.append(
      button('Log', 'Git Log', () => { activeToolTab = 'log'; render(); }, 'tool-tab' + (activeToolTab === 'log' ? ' active' : '')),
      button('Console', 'Git Console', () => { activeToolTab = 'console'; render(); }, 'tool-tab' + (activeToolTab === 'console' ? ' active' : '')),
      button('Local Changes', 'Open Commit tool window', () => post('openCommitView'), 'tool-tab'),
    );
    root.append(tabs);
    if (activeToolTab === 'console') {
      const consoleBar = node('div', 'console-toolbar');
      consoleBar.append(node('span', '', 'Git Console'), node('span', 'spacer'), button('Clear', 'Clear Git Console', () => post('clearConsole'), 'action'));
      root.append(consoleBar, consolePanel()); app.append(root); return;
    }
    root.append(toolbar());
    const workspace = node('div', 'workspace');
    if (state.empty) workspace.append(node('div', 'empty', 'Open a folder containing a Git repository.'));
    else workspace.append(branchPane(), commitPane(), detailsPane());
    root.append(workspace); app.append(root); requestAnimationFrame(drawGraphs);
  }

  function consolePanel() {
    const output = node('div', 'console');
    const traces = state.traces || [];
    if (!traces.length) { output.append(node('div', 'empty', 'Git command output will appear here.')); return output; }
    for (const trace of traces) {
      const block = node('div', 'trace');
      block.append(node('div', 'trace-time', new Date(trace.startedAt).toLocaleTimeString() + ' · ' + trace.durationMs + ' ms · exit ' + (trace.exitCode ?? 'aborted')));
      block.append(node('div', 'trace-cwd', trace.cwd));
      block.append(node('div', 'trace-command', '$ git ' + trace.args.join(' ')));
      if (trace.stdout) block.append(node('div', '', trace.stdout.trimEnd()));
      if (trace.stderr) block.append(node('div', 'trace-error', trace.stderr.trimEnd()));
      output.append(block);
    }
    requestAnimationFrame(() => { output.scrollTop = output.scrollHeight; });
    return output;
  }

  function toolbar() {
    const bar = node('div', 'toolbar');
    const repositories = node('select'); repositories.title = 'Git root';
    for (const repo of state.repositories || []) { const option = node('option', '', repo.name); option.value = repo.root; option.selected = repo.root === state.selectedRoot; repositories.append(option); }
    repositories.addEventListener('change', () => post('selectRepository', { root: repositories.value }));
    const input = node('input', 'search'); input.type = 'search'; input.placeholder = 'Search commits'; input.value = search;
    input.addEventListener('input', () => { search = input.value.toLowerCase(); renderCommitRows(); });
    bar.append(repositories, button('↻', 'Fetch and Refresh', () => post('refresh')), input, node('span', 'spacer'), node('span', 'branch-label', '⑂ ' + (state.branch || 'detached HEAD')));
    return bar;
  }

  function branchPane() {
    const pane = node('aside', 'pane branches'); pane.append(node('div', 'pane-title', 'Branches'));
    const all = button('All', 'Show all branches', () => post('selectRef', {}), 'branch-row' + (!state.selectedRef ? ' active' : ''));
    pane.append(all);
    for (const [kind, title] of [['local','Local'], ['remote','Remote'], ['tag','Tags']]) {
      const section = node('section', 'branch-section'); section.append(node('div', 'section-title', title));
      for (const branch of (state.branches || []).filter(item => item.kind === kind)) {
        const row = button(branch.name, 'Filter by ' + branch.name, () => post('selectRef', { ref: branch.name }), 'branch-row' + (state.selectedRef === branch.name ? ' active' : '') + (kind === 'local' && branch.name === state.branch ? ' current' : ''));
        row.addEventListener('dblclick', () => post('checkout', { name: branch.name, kind: branch.kind }));
        section.append(row);
      }
      pane.append(section);
    }
    return pane;
  }

  function commitPane() {
    const pane = node('main', 'pane commit-pane');
    const head = node('div', 'table-head'); head.append(node('span', '', 'Commit'), node('span', '', 'Author'), node('span', '', 'Date'), node('span', '', 'Hash'));
    const list = node('div', 'commit-list'); list.id = 'commit-list'; pane.append(head, list); renderCommitRows(list); return pane;
  }

  function renderCommitRows(existing) {
    const list = existing || document.getElementById('commit-list'); if (!list) return;
    list.replaceChildren();
    const commits = filteredCommits(); const graph = graphLayout(commits);
    if (!commits.length) { list.append(node('div', 'empty', 'No matching commits')); return; }
    commits.forEach((commit, index) => {
      const row = node('div', 'commit-row' + (state.selection?.commit.hash === commit.hash ? ' selected' : '')); row.dataset.hash = commit.hash;
      const subject = node('div', 'subject-cell'); const canvas = node('canvas'); canvas.width = 144; canvas.height = 54; canvas.dataset.graph = JSON.stringify(graph[index]); subject.append(canvas);
      const refs = node('div', 'refs'); for (const ref of (commit.refs || []).slice(0, 2)) refs.append(node('span', 'ref', shortRef(ref))); subject.append(refs, node('span', 'subject', commit.subject || '(no subject)'));
      row.append(subject, node('div', '', commit.author), node('div', 'muted', formatDate(commit.authoredAt)), node('div', 'muted', commit.hash.slice(0, 8)));
      row.addEventListener('click', () => post('selectCommit', { hash: commit.hash }));
      row.addEventListener('dblclick', () => post('showPatch', { hash: commit.hash }));
      list.append(row);
    });
    requestAnimationFrame(drawGraphs);
  }

  function filteredCommits() {
    if (!search) return state.commits || [];
    return (state.commits || []).filter(c => (c.subject + '\n' + c.body + '\n' + c.author + '\n' + c.hash + '\n' + (c.refs || []).join(' ')).toLowerCase().includes(search));
  }

  function detailsPane() {
    const pane = node('aside', 'pane details'); const selection = state.selection;
    if (!selection) { pane.append(node('div', 'empty', 'Select a commit to view details')); return pane; }
    const commit = selection.commit; const details = node('div', 'commit-details');
    details.append(node('div', 'detail-subject', commit.subject || '(no subject)'));
    const meta = node('div', 'detail-meta');
    for (const [key, value] of [['Author', commit.author + ' <' + commit.email + '>'], ['Date', new Date(commit.authoredAt).toLocaleString()], ['Commit', commit.hash], ['Parents', (commit.parents || []).map(p => p.slice(0, 10)).join(', ') || '—']]) { meta.append(node('span', '', key), node('strong', '', value)); }
    details.append(meta); if (commit.body && commit.body !== commit.subject) details.append(node('div', 'detail-body', commit.body));
    const actions = node('div', 'detail-actions');
    actions.append(button('Show Diff', 'Open full patch', () => post('showPatch', { hash: commit.hash }), 'action'), button('Cherry-pick', 'Cherry-pick commit', () => post('cherryPick', { hash: commit.hash }), 'action'), button('Revert', 'Revert commit', () => post('revert', { hash: commit.hash }), 'action'), button('New Branch', 'Create branch here', () => post('newBranch', { hash: commit.hash }), 'action'), button('Reset…', 'Reset current branch here', () => post('reset', { hash: commit.hash }), 'action'));
    details.append(actions);
    const files = node('div', 'files'); files.append(node('div', 'pane-title', 'Changed Files (' + selection.files.length + ')'));
    for (const file of selection.files) { const row = node('div', 'file-row'); row.title = file.originalPath ? file.originalPath + ' → ' + file.path : file.path; row.append(node('span', 'file-status', file.status[0]), node('span', 'file-path', file.path)); row.addEventListener('dblclick', () => post('showPatch', { hash: commit.hash })); files.append(row); }
    pane.append(details, files); return pane;
  }

  function graphLayout(commits) {
    const lanes = []; return commits.map(commit => {
      let lane = lanes.indexOf(commit.hash); if (lane < 0) { lane = lanes.findIndex(value => !value); if (lane < 0) lane = lanes.length; lanes[lane] = commit.hash; }
      const before = lanes.map(Boolean); const parents = commit.parents || [];
      if (parents.length) { lanes[lane] = parents[0]; for (let i = 1; i < parents.length; i++) { if (!lanes.includes(parents[i])) lanes.splice(lane + i, 0, parents[i]); } } else lanes.splice(lane, 1);
      return { lane, before, after: lanes.map(Boolean), parentLanes: parents.map(parent => lanes.indexOf(parent)) };
    });
  }

  function drawGraphs() {
    document.querySelectorAll('canvas[data-graph]').forEach(canvas => {
      const graph = JSON.parse(canvas.dataset.graph); const ctx = canvas.getContext('2d'); const scale = 2; const gap = 12 * scale; const x = index => 8 * scale + index * gap; const mid = 13.5 * scale;
      ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.lineWidth = 1.5 * scale; ctx.lineCap = 'round';
      graph.before.forEach((active, lane) => { if (!active) return; ctx.strokeStyle = colors[lane % colors.length]; ctx.beginPath(); ctx.moveTo(x(lane), 0); ctx.lineTo(x(lane), mid); ctx.stroke(); });
      graph.after.forEach((active, lane) => { if (!active) return; ctx.strokeStyle = colors[lane % colors.length]; ctx.beginPath(); ctx.moveTo(x(lane), mid); ctx.lineTo(x(lane), 54); ctx.stroke(); });
      graph.parentLanes.forEach(parentLane => { if (parentLane < 0 || parentLane === graph.lane) return; ctx.strokeStyle = colors[parentLane % colors.length]; ctx.beginPath(); ctx.moveTo(x(graph.lane), mid); ctx.lineTo(x(parentLane), 54); ctx.stroke(); });
      ctx.fillStyle = colors[graph.lane % colors.length]; ctx.beginPath(); ctx.arc(x(graph.lane), mid, 4 * scale, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = getComputedStyle(document.body).backgroundColor; ctx.lineWidth = 1.3 * scale; ctx.stroke();
    });
  }

  const shortRef = ref => ref.replace(/^HEAD -> /, '').replace(/^tag: /, '');
  const formatDate = value => { const date = new Date(value); const now = new Date(); return date.toDateString() === now.toDateString() ? date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : date.toLocaleDateString(); };
  window.addEventListener('message', event => {
    if (event.data.type === 'state') { state = event.data.state; render(); }
    if (event.data.type === 'selection') { state.selection = event.data.selection; render(); }
    if (event.data.type === 'trace') { state.traces = [...(state.traces || []), event.data.trace].slice(-400); if (activeToolTab === 'console') render(); }
    if (event.data.type === 'error') { const error = node('div', 'error', event.data.message); app.prepend(error); }
  });
  post('ready'); render();
`;

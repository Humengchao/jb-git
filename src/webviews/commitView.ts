import * as path from "node:path";
import * as vscode from "vscode";
import { ChangelistStore } from "../changelists/store";
import { GitChange } from "../git/types";
import { RepositoryManager } from "../repositoryManager";
import { ShelfEntry, ShelfStore } from "../shelves/store";
import { ChangeNode } from "../views/changesTree";
import { webviewDocument } from "./html";

type CommitViewMessage =
  | { type: "ready" }
  | { type: "selectRepository"; root: string }
  | { type: "refresh" }
  | { type: "togglePath"; path: string; checked: boolean }
  | { type: "toggleAll"; checked: boolean }
  | { type: "openDiff"; path: string }
  | { type: "commit"; message: string; amend?: boolean; signoff?: boolean; noVerify?: boolean; push?: boolean }
  | { type: "createChangelist" }
  | { type: "setActiveChangelist"; id: string }
  | { type: "moveToChangelist"; path: string }
  | { type: "stage"; path: string }
  | { type: "unstage"; path: string }
  | { type: "discard"; path: string }
  | { type: "createShelf" }
  | { type: "applyShelf"; id: string }
  | { type: "deleteShelf"; id: string }
  | { type: "runCommand"; command: string };

const ALLOWED_COMMANDS = new Set([
  "jbGit.branchesPopup",
  "jbGit.operationsPopup",
  "jbGit.openGitToolWindow",
  "jbGit.fetch",
  "jbGit.pull",
  "jbGit.push",
  "jbGit.stash",
  "jbGit.applyPatch",
  "jbGit.continueOperation",
  "jbGit.abortOperation",
]);

export class IntelliJCommitViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "jbGit.commitTool";

  private view?: vscode.WebviewView;
  private selectedRoot?: string;
  private readonly selectedPaths = new Map<string, Set<string>>();
  private readonly knownPaths = new Map<string, Set<string>>();
  private readonly disposables: vscode.Disposable[] = [];
  private updateVersion = 0;

  public constructor(
    private readonly manager: RepositoryManager,
    private readonly changelists: ChangelistStore,
    private readonly shelves: ShelfStore,
  ) {
    this.disposables.push(
      manager.onDidChange(() => void this.update()),
      changelists.onDidChange(() => void this.update()),
      shelves.onDidChange(() => void this.update()),
    );
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = webviewDocument(view.webview, "Commit", commitViewStyles, commitViewScript);
    this.disposables.push(
      view.webview.onDidReceiveMessage((message: CommitViewMessage) => void this.handleMessage(message)),
      view.onDidDispose(() => { if (this.view === view) this.view = undefined; }),
    );
    void this.update();
  }

  public async reveal(root?: string): Promise<void> {
    if (root && this.manager.snapshot(root)) this.selectedRoot = root;
    await vscode.commands.executeCommand("workbench.view.extension.jbGit");
    await vscode.commands.executeCommand(`${IntelliJCommitViewProvider.viewType}.focus`);
  }

  private currentSnapshot() {
    const all = this.manager.all;
    if (!this.selectedRoot || !all.some((item) => item.repository.info.rootPath === this.selectedRoot)) {
      this.selectedRoot = all[0]?.repository.info.rootPath;
    }
    return this.selectedRoot ? this.manager.snapshot(this.selectedRoot) : undefined;
  }

  private syncSelection(root: string, changes: readonly GitChange[]): Set<string> {
    const live = new Set(changes.map((change) => change.path));
    const known = this.knownPaths.get(root);
    const selected = this.selectedPaths.get(root) ?? new Set<string>();
    if (!known) {
      for (const filePath of live) selected.add(filePath);
    } else {
      for (const filePath of live) if (!known.has(filePath)) selected.add(filePath);
    }
    for (const filePath of [...selected]) if (!live.has(filePath)) selected.delete(filePath);
    this.knownPaths.set(root, live);
    this.selectedPaths.set(root, selected);
    return selected;
  }

  private async update(): Promise<void> {
    const webview = this.view?.webview;
    if (!webview) return;
    const version = ++this.updateVersion;
    const snapshot = this.currentSnapshot();
    const repositories = this.manager.all.map((item) => ({
      root: item.repository.info.rootPath,
      name: path.basename(item.repository.info.rootPath) || item.repository.info.rootPath,
      branch: item.status?.branch.head ?? "detached HEAD",
    }));
    if (!snapshot) {
      await webview.postMessage({ type: "state", state: { repositories, empty: true } });
      return;
    }
    const root = snapshot.repository.info.rootPath;
    const changes = snapshot.status?.changes ?? [];
    const selected = this.syncSelection(root, changes);
    let shelfEntries: ShelfEntry[] = [];
    try {
      shelfEntries = await this.shelves.list(root);
    } catch (error) {
      if (version === this.updateVersion) await webview.postMessage({ type: "error", message: formatError(error) });
    }
    if (version !== this.updateVersion) return;
    const lists = this.changelists.lists(root).map((list) => ({
      id: list.id,
      name: list.name,
      active: list.id === this.changelists.activeId(root),
      changes: changes
        .filter((change) => this.changelists.listForFile(root, change.path).id === list.id)
        .map((change) => ({
          path: change.path,
          directory: path.dirname(change.path) === "." ? "" : path.dirname(change.path),
          fileName: path.basename(change.path),
          originalPath: change.originalPath,
          kind: change.kind,
          staged: change.staged,
          unstaged: change.unstaged,
          conflicted: change.conflicted,
          checked: selected.has(change.path),
          status: statusLabel(change),
        })),
    }));
    await webview.postMessage({
      type: "state",
      state: {
        repositories,
        selectedRoot: root,
        branch: snapshot.status?.branch.head ?? "detached HEAD",
        upstream: snapshot.status?.branch.upstream,
        ahead: snapshot.status?.branch.ahead ?? 0,
        behind: snapshot.status?.branch.behind ?? 0,
        operation: snapshot.operation,
        error: snapshot.error,
        lists,
        totalChanges: changes.length,
        selectedCount: selected.size,
        shelves: shelfEntries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          createdAt: entry.createdAt,
          paths: entry.paths,
        })),
      },
    });
  }

  private async handleMessage(message: CommitViewMessage): Promise<void> {
    try {
      if (message.type === "ready") return void this.update();
      if (message.type === "selectRepository") {
        if (this.manager.snapshot(message.root)) this.selectedRoot = message.root;
        return void this.update();
      }
      const snapshot = this.currentSnapshot();
      if (!snapshot) return;
      const root = snapshot.repository.info.rootPath;
      const changes = snapshot.status?.changes ?? [];
      const selected = this.syncSelection(root, changes);
      if (message.type === "togglePath") {
        const change = changes.find((item) => item.path === message.path);
        if (!change) return;
        if (message.checked) selected.add(change.path); else selected.delete(change.path);
        return void this.update();
      }
      if (message.type === "toggleAll") {
        selected.clear();
        if (message.checked) for (const change of changes) selected.add(change.path);
        return void this.update();
      }
      if (message.type === "refresh") {
        await this.manager.refresh(root);
        return;
      }
      if (message.type === "openDiff") {
        const change = changes.find((item) => item.path === message.path);
        if (!change) return;
        const mode = change.staged && !change.unstaged ? "staged" : "unstaged";
        await vscode.commands.executeCommand("jbGit.openDiff", new ChangeNode(root, change, mode));
        return;
      }
      if (message.type === "commit") {
        if (!(await requireTrusted())) return;
        const commitMessage = message.message.trim();
        if (!commitMessage) return void vscode.window.showWarningMessage("Enter a commit message first.");
        const paths = changes.filter((change) => selected.has(change.path)).map((change) => change.path);
        if (paths.length === 0) return void vscode.window.showWarningMessage("Select at least one changed file to commit.");
        const revision = await this.manager.commitPaths(root, paths, commitMessage, {
          amend: message.amend,
          signoff: message.signoff,
          noVerify: message.noVerify,
        });
        await vscode.window.showInformationMessage(`Created commit ${revision.slice(0, 12)}`);
        if (message.push) await this.manager.push(root);
        await this.view?.webview.postMessage({ type: "committed" });
        return;
      }
      if (message.type === "createChangelist") {
        if (!(await requireTrusted())) return;
        const name = await vscode.window.showInputBox({ title: "New Changelist", prompt: "Name", placeHolder: "Feature work" });
        if (name?.trim()) await this.changelists.create(root, name.trim());
        return;
      }
      if (message.type === "setActiveChangelist") {
        await this.changelists.setActive(root, message.id);
        return;
      }
      if (message.type === "moveToChangelist") {
        if (!(await requireTrusted())) return;
        const change = changes.find((item) => item.path === message.path);
        if (!change) return;
        const current = this.changelists.listForFile(root, change.path);
        const target = await vscode.window.showQuickPick(
          this.changelists.lists(root).filter((list) => list.id !== current.id).map((list) => ({ label: list.name, id: list.id })),
          { title: `Move ${change.path}`, placeHolder: "Select target Changelist" },
        );
        if (target) await this.changelists.assign(root, change.path, target.id);
        return;
      }
      if (message.type === "stage" || message.type === "unstage") {
        if (!(await requireTrusted())) return;
        const change = changes.find((item) => item.path === message.path);
        if (!change) return;
        if (message.type === "stage") await this.manager.stage(root, [change.path]);
        else await this.manager.unstage(root, [change.path]);
        return;
      }
      if (message.type === "discard") {
        if (!(await requireTrusted())) return;
        const change = changes.find((item) => item.path === message.path);
        if (!change) return;
        const action = change.kind === "untracked" ? "Delete" : "Rollback";
        const confirmed = await vscode.window.showWarningMessage(
          `${action} all local changes in ${change.path}?`, { modal: true }, action,
        );
        if (confirmed !== action) return;
        if (change.kind === "untracked") await this.manager.cleanUntracked(root, [change.path]);
        else await this.manager.discard(root, [change.path]);
        return;
      }
      if (message.type === "createShelf") {
        if (!(await requireTrusted())) return;
        const paths = changes
          .filter((change) => selected.has(change.path) && change.kind !== "untracked" && change.kind !== "ignored")
          .flatMap((change) => [change.path, ...(change.originalPath ? [change.originalPath] : [])]);
        if (!paths.length) return void vscode.window.showInformationMessage("Select at least one tracked change to shelf.");
        const name = await vscode.window.showInputBox({ title: "Shelve Changes", prompt: "Shelf name", value: "Shelf" });
        if (name?.trim()) {
          await this.shelves.create(snapshot.repository, name.trim(), [...new Set(paths)]);
          await this.manager.refresh(root);
        }
        return;
      }
      if (message.type === "applyShelf" || message.type === "deleteShelf") {
        if (!(await requireTrusted())) return;
        const entry = (await this.shelves.list(root)).find((item) => item.id === message.id);
        if (!entry) return;
        if (message.type === "applyShelf") {
          await this.shelves.apply(snapshot.repository, entry);
          await this.manager.refresh(root);
        } else {
          const confirmed = await vscode.window.showWarningMessage(`Delete shelf '${entry.name}'?`, { modal: true }, "Delete");
          if (confirmed === "Delete") await this.shelves.remove(root, entry);
        }
        return;
      }
      if (message.type === "runCommand" && ALLOWED_COMMANDS.has(message.command)) {
        await vscode.commands.executeCommand(message.command, root);
      }
    } catch (error) {
      await vscode.window.showErrorMessage(formatError(error));
      await this.view?.webview.postMessage({ type: "error", message: formatError(error) });
    }
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}

function statusLabel(change: GitChange): string {
  if (change.conflicted) return "!";
  if (change.kind === "untracked") return "?";
  if (change.kind === "added") return "A";
  if (change.kind === "deleted") return "D";
  if (change.kind === "renamed") return "R";
  return "M";
}

async function requireTrusted(): Promise<boolean> {
  if (vscode.workspace.isTrusted) return true;
  await vscode.window.showWarningMessage("JB Git mutations are disabled until this workspace is trusted.");
  return false;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const commitViewStyles = String.raw`
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body, #app { width: 100%; height: 100%; padding: 0; margin: 0; }
  body { color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: 12px var(--vscode-font-family); overflow: hidden; }
  button, select, textarea { font: inherit; color: inherit; }
  button { border: 0; background: transparent; cursor: pointer; }
  button:focus-visible, select:focus-visible, textarea:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .root { height: 100%; display: grid; grid-template-rows: auto auto minmax(80px, 1fr) auto; }
  .toolbar { min-height: 34px; display: flex; align-items: center; gap: 2px; padding: 4px 6px; border-bottom: 1px solid var(--vscode-panel-border); }
  .branch { min-width: 0; flex: 1; display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 3px; text-align: left; }
  .branch:hover, .icon-button:hover, .row-action:hover { background: var(--vscode-toolbar-hoverBackground); }
  .branch-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tracking { color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; }
  .icon-button { width: 26px; height: 26px; border-radius: 3px; display: grid; place-items: center; font-size: 15px; }
  .tabs { height: 31px; display: flex; align-items: end; gap: 2px; padding: 0 7px; border-bottom: 1px solid var(--vscode-panel-border); }
  .tab { height: 30px; padding: 0 9px; color: var(--vscode-descriptionForeground); border-bottom: 2px solid transparent; }
  .tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
  .count { display: inline-grid; place-items: center; min-width: 16px; height: 16px; margin-left: 4px; padding: 0 4px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 10px; }
  .content { min-height: 0; overflow: auto; padding: 3px 0 12px; }
  .error, .operation { margin: 6px; padding: 7px 8px; border-radius: 3px; }
  .error { color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
  .operation { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); }
  .operation-actions { margin-top: 6px; display: flex; gap: 5px; }
  .small-button { padding: 3px 7px; border-radius: 2px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .group { margin-top: 2px; }
  .group-header { height: 27px; display: flex; align-items: center; gap: 5px; padding: 0 7px; font-weight: 600; user-select: none; }
  .group-header:hover { background: var(--vscode-list-hoverBackground); }
  .twisty { width: 12px; color: var(--vscode-descriptionForeground); }
  .active-dot { color: var(--vscode-charts-blue); }
  .change-row { height: 25px; display: grid; grid-template-columns: 22px 18px minmax(0, 1fr) auto; align-items: center; padding: 0 4px 0 18px; }
  .change-row:hover { background: var(--vscode-list-hoverBackground); }
  .change-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .change-row input { margin: 0; }
  .status { width: 17px; font-weight: 700; text-align: center; }
  .status.M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .status.A, .status-q { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
  .status.D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .status.R { color: var(--vscode-gitDecoration-renamedResourceForeground); }
  .status-bang { color: var(--vscode-gitDecoration-conflictingResourceForeground); }
  .file { min-width: 0; display: flex; align-items: baseline; gap: 6px; cursor: default; }
  .file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .directory { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .stage-mark { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 10px; }
  .row-actions { display: none; align-items: center; }
  .change-row:hover .row-actions { display: flex; }
  .row-action { width: 23px; height: 23px; border-radius: 2px; color: inherit; }
  .empty { padding: 24px 12px; color: var(--vscode-descriptionForeground); text-align: center; }
  .shelf { margin: 2px 5px; padding: 7px 8px; border-radius: 3px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 8px; }
  .shelf:hover { background: var(--vscode-list-hoverBackground); }
  .shelf-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .shelf-meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .shelf-actions { grid-row: 1 / 3; grid-column: 2; display: flex; align-items: center; }
  .commit-panel { border-top: 1px solid var(--vscode-panel-border); padding: 7px; background: var(--vscode-sideBar-background); }
  textarea { display: block; width: 100%; min-height: 62px; max-height: 180px; resize: vertical; padding: 6px 7px; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
  .commit-options { min-height: 27px; display: flex; align-items: center; gap: 9px; color: var(--vscode-descriptionForeground); }
  .commit-options label { display: flex; align-items: center; gap: 3px; white-space: nowrap; }
  .commit-actions { display: grid; grid-template-columns: minmax(0, 1fr) 36px; gap: 4px; }
  .primary { min-height: 28px; padding: 4px 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 2px; }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .secondary { min-width: 35px; min-height: 28px; padding: 4px 7px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-radius: 2px; }
  .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .select-all { margin-left: auto; font-weight: 400; color: var(--vscode-descriptionForeground); }
  .repository-select { max-width: 100%; min-width: 0; border: 0; background: transparent; }
`;

const commitViewScript = String.raw`
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state = { empty: true, repositories: [] };
  let activeTab = 'changes';

  const post = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  const node = (tag, className, text) => {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  };
  const button = (label, title, handler, className = 'icon-button') => {
    const value = node('button', className, label);
    value.type = 'button'; value.title = title; value.setAttribute('aria-label', title);
    value.addEventListener('click', handler); return value;
  };

  function render() {
    app.replaceChildren();
    const root = node('div', 'root');
    root.append(toolbar(), tabs(), content(), commitPanel());
    app.append(root);
  }

  function toolbar() {
    const bar = node('div', 'toolbar');
    if ((state.repositories || []).length > 1) {
      const select = node('select', 'repository-select');
      select.title = 'Git root';
      for (const repository of state.repositories) {
        const option = node('option', '', repository.name + ' · ' + repository.branch);
        option.value = repository.root; option.selected = repository.root === state.selectedRoot;
        select.append(option);
      }
      select.addEventListener('change', () => post('selectRepository', { root: select.value }));
      bar.append(select);
    } else {
      const branch = button('⑂', 'Branches', () => post('runCommand', { command: 'jbGit.branchesPopup' }), 'branch');
      branch.append(node('span', 'branch-name', state.branch || 'No Git repository'));
      if (state.upstream) branch.append(node('span', 'tracking', '↑' + state.ahead + ' ↓' + state.behind));
      bar.append(branch);
    }
    bar.append(
      button('↻', 'Refresh', () => post('refresh')),
      button('⌕', 'Open Git Log', () => post('runCommand', { command: 'jbGit.openGitToolWindow' })),
      button('⋮', 'More Git actions', () => post('runCommand', { command: 'jbGit.operationsPopup' })),
    );
    return bar;
  }

  function tabs() {
    const strip = node('div', 'tabs');
    const changes = button('Local Changes', 'Local Changes', () => { activeTab = 'changes'; render(); }, 'tab' + (activeTab === 'changes' ? ' active' : ''));
    changes.append(node('span', 'count', String(state.totalChanges || 0)));
    const shelf = button('Shelf', 'Shelf', () => { activeTab = 'shelf'; render(); }, 'tab' + (activeTab === 'shelf' ? ' active' : ''));
    shelf.append(node('span', 'count', String((state.shelves || []).length)));
    strip.append(changes, shelf);
    return strip;
  }

  function content() {
    const area = node('div', 'content');
    if (state.error) area.append(node('div', 'error', state.error));
    if (state.operation && state.operation.kind !== 'none') {
      const operation = node('div', 'operation', state.operation.kind.toUpperCase() + ' is in progress');
      const actions = node('div', 'operation-actions');
      if (state.operation.canContinue) actions.append(button('Continue', 'Continue operation', () => post('runCommand', { command: 'jbGit.continueOperation' }), 'small-button'));
      if (state.operation.canAbort) actions.append(button('Abort', 'Abort operation', () => post('runCommand', { command: 'jbGit.abortOperation' }), 'small-button'));
      operation.append(actions); area.append(operation);
    }
    if (state.empty) { area.append(node('div', 'empty', 'Open a folder containing a Git repository.')); return area; }
    if (activeTab === 'shelf') renderShelves(area); else renderChanges(area);
    return area;
  }

  function renderChanges(area) {
    const lists = state.lists || [];
    if (!state.totalChanges) { area.append(node('div', 'empty', 'No local changes')); return; }
    for (const list of lists) {
      const group = node('section', 'group');
      const header = node('div', 'group-header');
      header.append(node('span', 'twisty', '⌄'), node('span', list.active ? 'active-dot' : '', list.active ? '●' : '○'), node('span', '', list.name), node('span', 'count', String(list.changes.length)));
      header.title = list.active ? 'Active Changelist' : 'Make active Changelist';
      header.addEventListener('click', () => post('setActiveChangelist', { id: list.id }));
      const selectAll = button('✓ All', 'Select all changes', (event) => { event.stopPropagation(); post('toggleAll', { checked: true }); }, 'select-all');
      header.append(selectAll); group.append(header);
      for (const change of list.changes) group.append(changeRow(change));
      area.append(group);
    }
  }

  function changeRow(change) {
    const row = node('div', 'change-row'); row.dataset.path = change.path; row.title = change.path;
    const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = change.checked; checkbox.title = 'Include in commit';
    checkbox.addEventListener('change', () => post('togglePath', { path: change.path, checked: checkbox.checked }));
    const statusClass = change.status === '?' ? 'status-q' : change.status === '!' ? 'status-bang' : change.status;
    const status = node('span', 'status ' + statusClass, change.status);
    const file = node('div', 'file'); file.append(node('span', 'file-name', change.fileName));
    if (change.directory) file.append(node('span', 'directory', change.directory));
    if (change.staged) file.append(node('span', 'stage-mark', 'staged'));
    file.addEventListener('dblclick', () => post('openDiff', { path: change.path }));
    const actions = node('div', 'row-actions');
    actions.append(button('↔', 'Show Diff', () => post('openDiff', { path: change.path }), 'row-action'));
    if (change.staged && !change.unstaged) actions.append(button('−', 'Unstage', () => post('unstage', { path: change.path }), 'row-action'));
    else actions.append(button('+', 'Stage', () => post('stage', { path: change.path }), 'row-action'));
    actions.append(button('⇥', 'Move to Changelist', () => post('moveToChangelist', { path: change.path }), 'row-action'));
    actions.append(button('↶', 'Rollback', () => post('discard', { path: change.path }), 'row-action'));
    row.append(checkbox, status, file, actions); return row;
  }

  function renderShelves(area) {
    const top = node('div', 'group-header');
    top.append(node('span', '', 'Shelved Changes'), button('+ Shelve', 'Shelve selected changes', () => post('createShelf'), 'select-all'));
    area.append(top);
    if (!(state.shelves || []).length) { area.append(node('div', 'empty', 'No shelved changes')); return; }
    for (const shelf of state.shelves) {
      const item = node('div', 'shelf');
      item.append(node('div', 'shelf-name', shelf.name), node('div', 'shelf-meta', new Date(shelf.createdAt).toLocaleString() + ' · ' + shelf.paths.length + ' files'));
      const actions = node('div', 'shelf-actions');
      actions.append(button('Apply', 'Unshelve', () => post('applyShelf', { id: shelf.id }), 'small-button'), button('×', 'Delete Shelf', () => post('deleteShelf', { id: shelf.id }), 'row-action'));
      item.append(actions); area.append(item);
    }
  }

  function commitPanel() {
    const panel = node('div', 'commit-panel');
    const message = node('textarea'); message.id = 'commit-message'; message.placeholder = 'Commit Message'; message.value = vscode.getState()?.message || '';
    message.addEventListener('input', () => vscode.setState({ message: message.value }));
    const options = node('div', 'commit-options');
    const amend = checkboxOption('Amend', 'amend'); const signoff = checkboxOption('Sign-off', 'signoff'); const noVerify = checkboxOption('Skip hooks', 'noVerify');
    options.append(amend.label, signoff.label, noVerify.label, node('span', 'tracking', (state.selectedCount || 0) + ' selected'));
    const actions = node('div', 'commit-actions');
    const submit = (push) => post('commit', { message: message.value, amend: amend.input.checked, signoff: signoff.input.checked, noVerify: noVerify.input.checked, push });
    actions.append(button('Commit', 'Commit selected changes', () => submit(false), 'primary'), button('↑', 'Commit and Push', () => submit(true), 'secondary'));
    panel.append(message, options, actions); return panel;
  }

  function checkboxOption(text, id) {
    const label = node('label'); const input = node('input'); input.type = 'checkbox'; input.id = id;
    label.append(input, node('span', '', text)); return { label, input };
  }

  window.addEventListener('message', event => {
    if (event.data.type === 'state') { state = event.data.state; render(); }
    if (event.data.type === 'committed') { vscode.setState({ message: '' }); render(); }
  });
  post('ready'); render();
`;

import * as vscode from "vscode";
import { GitRepository } from "../git/repository";
import { GitBranch } from "../git/types";
import { DiffContentProvider } from "../views/diffProvider";
import { webviewDocument } from "./html";

type ComparisonMessage =
  | { type: "ready" }
  | { type: "openFile"; index: number };

interface ComparisonSession {
  key: string;
  panel: vscode.WebviewPanel;
  disposables: vscode.Disposable[];
  requestVersion: number;
}

export class BranchComparisonWorkspace implements vscode.Disposable {
  private readonly sessions = new Map<string, ComparisonSession>();
  private readonly pendingOpens = new Set<string>();

  public constructor(private readonly diffProvider: DiffContentProvider) {}

  public async open(repository: GitRepository, left: GitBranch, right: GitBranch): Promise<void> {
    const key = `${repository.info.rootPath}\0${left.oid}\0${right.oid}`;
    const existing = this.sessions.get(key);
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn, false);
      return;
    }
    // A second open for the same comparison while the diff is still loading
    // would create a duplicate panel.
    if (this.pendingOpens.has(key)) return;
    this.pendingOpens.add(key);
    try {
      await this.openPanel(key, repository, left, right);
    } finally {
      this.pendingOpens.delete(key);
    }
  }

  private async openPanel(key: string, repository: GitRepository, left: GitBranch, right: GitBranch): Promise<void> {
    const files = await repository.diffFiles(left.oid, right.oid);
    const initialColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const panel = vscode.window.createWebviewPanel(
      "jbGit.branchComparison",
      `Changes Between ${left.name} and ${right.name}`,
      { viewColumn: initialColumn, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.webview.html = webviewDocument(panel.title, comparisonStyles, comparisonScript);

    const session: ComparisonSession = { key, panel, disposables: [], requestVersion: 0 };
    this.sessions.set(key, session);
    let firstFileOpened = false;

    const openFile = async (index: number): Promise<void> => {
      if (!Number.isInteger(index) || index < 0 || index >= files.length) return;
      const requestVersion = ++session.requestVersion;
      await panel.webview.postMessage({ type: "loading", index });
      const file = files[index];
      const oldPath = file.originalPath ?? file.path;
      const [leftContent, rightContent] = await Promise.all([
        file.status.startsWith("A") ? Promise.resolve(Buffer.alloc(0)) : repository.fileContent(oldPath, left.oid),
        file.status.startsWith("D") ? Promise.resolve(Buffer.alloc(0)) : repository.fileContent(file.path, right.oid),
      ]);
      if (requestVersion !== session.requestVersion || !this.sessions.has(key)) return;
      if (isBinary(leftContent) || isBinary(rightContent)) {
        await panel.webview.postMessage({ type: "selection", index });
        await vscode.window.showInformationMessage(`${file.path} is binary and cannot be displayed in the text diff editor.`);
        return;
      }
      const leftText = displayContent(leftContent, `${left.name}:${oldPath}`);
      const rightText = displayContent(rightContent, `${right.name}:${file.path}`);
      const leftUri = this.diffProvider.registerFile(repository.info.rootPath, left.name, oldPath, leftText);
      const rightUri = this.diffProvider.registerFile(repository.info.rootPath, right.name, file.path, rightText);
      const panelColumn = Number(panel.viewColumn ?? initialColumn);
      const targetColumn = panelColumn >= Number(vscode.ViewColumn.Nine)
        ? vscode.ViewColumn.Beside
        : Math.min(Number(vscode.ViewColumn.Nine), panelColumn + 1) as vscode.ViewColumn;
      const label = `${file.path} (${left.name} ↔ ${right.name})`;
      await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, label, {
        preview: true,
        preserveFocus: false,
        viewColumn: targetColumn,
      });
      if (requestVersion !== session.requestVersion || !this.sessions.has(key)) return;
      await panel.webview.postMessage({ type: "selection", index });
    };
    const openFileSafely = (index: number): void => {
      void openFile(index).catch((error) => {
        showComparisonError(error);
        void panel.webview.postMessage({ type: "loading", index: -1 });
      });
    };

    session.disposables.push(
      panel.webview.onDidReceiveMessage((message: ComparisonMessage) => {
        if (message.type === "ready") {
          void panel.webview.postMessage({
            type: "state",
            state: { leftRef: left.name, rightRef: right.name, files },
          });
          if (!firstFileOpened && files.length) {
            firstFileOpened = true;
            openFileSafely(0);
          }
          return;
        }
        if (message.type === "openFile") openFileSafely(message.index);
      }),
      panel.onDidDispose(() => {
        for (const disposable of session.disposables) disposable.dispose();
        if (this.sessions.get(key) === session) this.sessions.delete(key);
      }),
    );
  }

  public dispose(): void {
    for (const session of [...this.sessions.values()]) session.panel.dispose();
    this.sessions.clear();
  }
}

function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8192).includes(0);
}

function displayContent(content: Buffer, source: string): string {
  if (!isBinary(content)) return content.toString("utf8");
  return `Binary file differs and cannot be displayed as text.\n\n${source}\n${content.length} bytes\n`;
}

function showComparisonError(error: unknown): void {
  void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
}

const comparisonStyles = String.raw`
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body, #app { width: 100%; height: 100%; margin: 0; padding: 0; }
  body { overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px var(--vscode-font-family); }
  button { color: inherit; font: inherit; border: 0; background: transparent; cursor: pointer; }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .root { height: 100%; display: grid; grid-template-rows: 42px 36px minmax(0, 1fr); }
  .title { display: flex; align-items: center; gap: 8px; padding: 0 14px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); font-size: 15px; font-weight: 600; }
  .refs { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .toolbar { display: flex; align-items: center; gap: 3px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); }
  .toolbar input { height: 27px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; padding: 2px 7px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  /* Same themed dropdown as the tool window: the browser default was the one
     stock control left on this toolbar. */
  .select-shell { position: relative; display: flex; min-width: 0; }
  .select-shell::after { content: ''; position: absolute; right: 9px; top: 50%; width: 5px; height: 5px; margin-top: -4px; border-right: 1px solid var(--vscode-dropdown-foreground, var(--vscode-foreground)); border-bottom: 1px solid var(--vscode-dropdown-foreground, var(--vscode-foreground)); transform: rotate(45deg); opacity: .7; pointer-events: none; }
  .select-shell select { height: 27px; min-width: 0; padding: 0 24px 0 8px; appearance: none; font: inherit; color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); background: var(--vscode-dropdown-background, var(--vscode-input-background)); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 3px; cursor: pointer; text-overflow: ellipsis; }
  .select-shell select:hover { border-color: var(--vscode-focusBorder); }
  .select-shell select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .toolbar input { width: min(260px, 38vw); }
  .toolbar-button { min-width: 28px; height: 27px; padding: 0 7px; border-radius: 3px; color: var(--vscode-descriptionForeground); }
  .toolbar-button:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
  .count { margin-left: auto; color: var(--vscode-descriptionForeground); }
  .tree { min-width: 0; min-height: 0; overflow: auto; padding: 5px 8px 16px; scrollbar-gutter: stable; }
  .empty { padding: 30px 14px; text-align: center; color: var(--vscode-descriptionForeground); }
  .folder-row, .file-row { width: 100%; min-width: max-content; height: 27px; display: flex; align-items: center; gap: 6px; padding-right: 8px; border-radius: 3px; text-align: left; white-space: nowrap; }
  .folder-row:hover, .file-row:hover { background: var(--vscode-list-hoverBackground); }
  .file-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .file-row.loading::after { content: 'Loading…'; margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .twisty { width: 13px; color: var(--vscode-descriptionForeground); text-align: center; }
  .folder-icon { color: var(--vscode-symbolIcon-folderForeground, var(--vscode-descriptionForeground)); }
  .folder-name { font-weight: 600; }
  .folder-count { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .status { width: 18px; font-weight: 700; text-align: center; }
  .status-A { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green)); }
  .status-D { color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-charts-red)); }
  .status-R, .status-C { color: var(--vscode-gitDecoration-renamedResourceForeground, var(--vscode-charts-blue)); }
  .status-M, .status-T { color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow)); }
  .file-icon { color: var(--vscode-symbolIcon-fileForeground, var(--vscode-descriptionForeground)); }
  .file-name { color: var(--vscode-textLink-foreground); }
  .rename { color: var(--vscode-descriptionForeground); font-size: 12px; }
`;

const comparisonScript = String.raw`
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state = { leftRef: '', rightRef: '', files: [] };
  let selectedIndex = 0;
  let loadingIndex = -1;
  let collapsed = new Set();
  let query = '';
  let statusFilter = 'all';
  const post = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  const isZh = document.documentElement.lang.toLowerCase().startsWith('zh');
  const zh = isZh ? {
    'Filter changed files': '筛选更改的文件', 'Filter by change status': '按更改状态筛选',
    'All statuses': '全部状态', 'Modified': '已修改', 'Added': '已添加', 'Deleted': '已删除', 'Renamed': '已重命名',
    'Collapse all folders': '折叠所有文件夹', 'Expand all folders': '展开所有文件夹',
    'No files match the current filters.': '没有符合当前筛选条件的文件。',
    'The selected branches have no file differences.': '所选分支之间没有文件差异。',
  } : {};
  const t = value => typeof value === 'string' ? (zh[value] || value) : value;
  const fileCount = count => isZh ? String(count) + ' 个文件' : String(count) + (count === 1 ? ' file' : ' files');
  const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = t(text); return element; };
  const button = (label, title, handler, className) => { const element = node('button', className, label); element.type = 'button'; element.title = t(title); element.addEventListener('click', handler); return element; };

  function render() {
    app.replaceChildren();
    const root = node('div', 'root');
    const title = node('div', 'title');
    title.append(node('span', '', '↔'), node('span', 'refs', isZh ? '比较 ' + state.leftRef + ' 与 ' + state.rightRef + ' 的更改' : 'Changes Between ' + state.leftRef + ' and ' + state.rightRef));
    const toolbar = node('div', 'toolbar');
    const search = node('input'); search.type = 'search'; search.placeholder = t('Filter changed files'); search.value = query; search.setAttribute('aria-label', t('Filter changed files'));
    const status = node('select'); status.setAttribute('aria-label', t('Filter by change status')); status.title = t('Filter by change status');
    const statusShell = node('div', 'select-shell'); statusShell.append(status);
    for (const [value, label] of [['all', 'All statuses'], ['M', 'Modified'], ['A', 'Added'], ['D', 'Deleted'], ['R', 'Renamed']]) { const option = node('option', '', label); option.value = value; option.selected = value === statusFilter; status.append(option); }
    const count = node('span', 'count');
    toolbar.append(
      search, statusShell,
      button('⌃', 'Collapse all folders', () => { collapsed = new Set(allDirectoryPaths()); render(); }, 'toolbar-button'),
      button('⌄', 'Expand all folders', () => { collapsed.clear(); render(); }, 'toolbar-button'),
      count,
    );
    const tree = node('div', 'tree'); tree.setAttribute('role', 'tree');
    const refreshTree = () => {
      tree.replaceChildren(); const files = filteredFiles(); count.textContent = fileCount(files.length);
      if (!files.length) tree.append(node('div', 'empty', state.files.length ? 'No files match the current filters.' : 'The selected branches have no file differences.'));
      else renderTree(tree, buildTree(files));
      setupTreeKeyboard(tree);
    };
    search.addEventListener('input', () => { query = search.value.toLowerCase(); refreshTree(); });
    status.addEventListener('change', () => { statusFilter = status.value; refreshTree(); });
    refreshTree();
    root.append(title, toolbar, tree); app.append(root);
  }

  function filteredFiles() {
    return state.files.map((file, index) => ({ ...file, index })).filter(file => {
      const status = (file.status || 'M').charAt(0);
      return (statusFilter === 'all' || status === statusFilter || (statusFilter === 'R' && status === 'C')) &&
        (!query || (file.path + '\n' + (file.originalPath || '')).toLowerCase().includes(query));
    });
  }

  function buildTree(files) {
    const root = { name: '', path: '', directories: new Map(), files: [] };
    files.forEach((file, index) => {
      const parts = file.path.split('/'); let current = root; let currentPath = '';
      for (const part of parts.slice(0, -1)) {
        currentPath = currentPath ? currentPath + '/' + part : part;
        if (!current.directories.has(part)) current.directories.set(part, { name: part, path: currentPath, directories: new Map(), files: [] });
        current = current.directories.get(part);
      }
      current.files.push({ ...file, index: Number.isInteger(file.index) ? file.index : index });
    });
    return root;
  }

  function renderTree(container, root) {
    [...root.directories.values()].sort(byName).forEach(directory => container.append(renderDirectory(directory, 0)));
    [...root.files].sort(byName).forEach(file => container.append(renderFile(file, 0)));
  }

  function renderDirectory(directory, depth) {
    const compacted = compactDirectory(directory); directory = compacted.directory;
    const section = node('section');
    const isCollapsed = collapsed.has(directory.path);
    const row = button('', directory.path, () => {
      if (collapsed.has(directory.path)) collapsed.delete(directory.path); else collapsed.add(directory.path);
      render();
    }, 'folder-row');
    row.style.paddingLeft = (6 + depth * 16) + 'px'; row.setAttribute('aria-expanded', String(!isCollapsed));
    const count = countFiles(directory);
    row.append(node('span', 'twisty', isCollapsed ? '›' : '⌄'), node('span', 'folder-icon', '▱'), node('span', 'folder-name', compacted.name), node('span', 'folder-count', fileCount(count)));
    const children = node('div'); children.hidden = isCollapsed;
    [...directory.directories.values()].sort(byName).forEach(child => children.append(renderDirectory(child, depth + 1)));
    [...directory.files].sort(byName).forEach(file => children.append(renderFile(file, depth + 1)));
    section.append(row, children); return section;
  }

  function renderFile(file, depth) {
    const status = (file.status || 'M').charAt(0);
    const row = button('', file.path, () => selectFile(file.index), 'file-row' + (file.index === selectedIndex ? ' selected' : '') + (file.index === loadingIndex ? ' loading' : ''));
    row.style.paddingLeft = (22 + depth * 16) + 'px'; row.dataset.index = String(file.index); row.setAttribute('role', 'treeitem'); row.setAttribute('aria-selected', String(file.index === selectedIndex));
    row.append(node('span', 'status status-' + status, status), node('span', 'file-icon', fileIcon(file.path)), node('span', 'file-name status-' + status, file.path.split('/').pop()));
    if (file.originalPath) row.append(node('span', 'rename', '← ' + file.originalPath));
    return row;
  }

  function selectFile(index) {
    selectedIndex = index; loadingIndex = index;
    document.querySelectorAll('.file-row').forEach(row => {
      const selected = Number(row.dataset.index) === selectedIndex;
      row.classList.toggle('selected', selected); row.classList.toggle('loading', Number(row.dataset.index) === loadingIndex); row.setAttribute('aria-selected', String(selected));
    });
    post('openFile', { index });
  }

  function allDirectoryPaths() {
    const result = [];
    const visit = directory => { for (const child of directory.directories.values()) { result.push(child.path); visit(child); } };
    visit(buildTree(state.files)); return result;
  }

  function countFiles(directory) {
    let count = directory.files.length;
    for (const child of directory.directories.values()) count += countFiles(child);
    return count;
  }

  function compactDirectory(directory) {
    const names = [directory.name]; let current = directory;
    while (!current.files.length && current.directories.size === 1) { current = current.directories.values().next().value; names.push(current.name); }
    return { name: names.join('/'), directory: current };
  }

  function setupTreeKeyboard(tree) {
    const rows = [...tree.querySelectorAll('.folder-row, .file-row')]; if (!rows.length) return;
    const initial = rows.find(row => row.classList.contains('selected')) || rows[0]; rows.forEach(row => { row.tabIndex = row === initial ? 0 : -1; });
    tree.onkeydown = event => {
      const current = event.target.closest?.('.folder-row, .file-row'); if (!current) return;
      const live = [...tree.querySelectorAll('.folder-row, .file-row')].filter(row => row.offsetParent !== null); let index = live.indexOf(current);
      if (event.key === 'ArrowDown') index = Math.min(live.length - 1, index + 1);
      else if (event.key === 'ArrowUp') index = Math.max(0, index - 1);
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = live.length - 1;
      else return;
      event.preventDefault(); live.forEach(row => { row.tabIndex = -1; }); live[index].tabIndex = 0; live[index].focus();
    };
  }

  function fileIcon(filePath) {
    const extension = filePath.split('.').pop().toLowerCase();
    if (extension === 'json') return '{}';
    if (extension === 'md') return 'M↓';
    if (extension === 'go') return 'Go';
    if (extension === 'ts' || extension === 'tsx') return 'TS';
    if (extension === 'js' || extension === 'jsx') return 'JS';
    return '◇';
  }

  const byName = (left, right) => left.name?.localeCompare(right.name || '') || left.path.localeCompare(right.path);
  window.addEventListener('message', event => {
    if (event.data.type === 'state') { state = event.data.state; selectedIndex = 0; render(); }
    if (event.data.type === 'selection') {
      selectedIndex = event.data.index; loadingIndex = -1;
      document.querySelectorAll('.file-row').forEach(row => {
        const selected = Number(row.dataset.index) === selectedIndex;
        row.classList.toggle('selected', selected); row.classList.remove('loading'); row.setAttribute('aria-selected', String(selected));
      });
    }
    if (event.data.type === 'loading') {
      loadingIndex = event.data.index;
      document.querySelectorAll('.file-row').forEach(row => row.classList.toggle('loading', Number(row.dataset.index) === loadingIndex));
    }
  });
  post('ready'); render();
`;

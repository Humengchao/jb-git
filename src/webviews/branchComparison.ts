import * as vscode from "vscode";
import { GitRepository } from "../git/repository";
import { GitBranch, GitCommitFile } from "../git/types";
import { DiffContentProvider } from "../views/diffProvider";
import { webviewDocument } from "./html";

type ComparisonMessage =
  | { type: "ready" }
  | { type: "openFile"; index: number };

interface ComparisonSession {
  panel: vscode.WebviewPanel;
  disposables: vscode.Disposable[];
}

export class BranchComparisonWorkspace implements vscode.Disposable {
  private readonly sessions = new Set<ComparisonSession>();

  public constructor(private readonly diffProvider: DiffContentProvider) {}

  public async open(repository: GitRepository, left: GitBranch, right: GitBranch): Promise<void> {
    const files = await repository.diffFiles(left.oid, right.oid);
    const initialColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const panel = vscode.window.createWebviewPanel(
      "jbGit.branchComparison",
      `Changes Between ${left.name} and ${right.name}`,
      { viewColumn: initialColumn, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.webview.html = webviewDocument(panel.webview, panel.title, comparisonStyles, comparisonScript);

    const session: ComparisonSession = { panel, disposables: [] };
    this.sessions.add(session);
    let firstFileOpened = false;

    const openFile = async (index: number): Promise<void> => {
      if (!Number.isInteger(index) || index < 0 || index >= files.length) return;
      const file = files[index];
      const oldPath = file.originalPath ?? file.path;
      const [leftContent, rightContent] = await Promise.all([
        file.status.startsWith("A") ? Promise.resolve(Buffer.alloc(0)) : repository.fileContent(oldPath, left.oid),
        file.status.startsWith("D") ? Promise.resolve(Buffer.alloc(0)) : repository.fileContent(file.path, right.oid),
      ]);
      const leftText = displayContent(leftContent, `${left.name}:${oldPath}`);
      const rightText = displayContent(rightContent, `${right.name}:${file.path}`);
      const leftUri = this.diffProvider.registerFile(repository.info.rootPath, left.name, oldPath, leftText);
      const rightUri = this.diffProvider.registerFile(repository.info.rootPath, right.name, file.path, rightText);
      const targetColumn = Math.min(Number(vscode.ViewColumn.Nine), Number(panel.viewColumn ?? initialColumn) + 1) as vscode.ViewColumn;
      const label = `${file.path} (${left.name} ↔ ${right.name})`;
      await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, label, {
        preview: true,
        preserveFocus: false,
        viewColumn: targetColumn,
      });
      await panel.webview.postMessage({ type: "selection", index });
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
            void openFile(0).catch(showComparisonError);
          }
          return;
        }
        if (message.type === "openFile") void openFile(message.index).catch(showComparisonError);
      }),
      panel.onDidDispose(() => {
        for (const disposable of session.disposables) disposable.dispose();
        this.sessions.delete(session);
      }),
    );
  }

  public dispose(): void {
    for (const session of [...this.sessions]) session.panel.dispose();
    this.sessions.clear();
  }
}

function displayContent(content: Buffer, source: string): string {
  if (!content.subarray(0, 8192).includes(0)) return content.toString("utf8");
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
  .toolbar-button { min-width: 28px; height: 27px; padding: 0 7px; border-radius: 3px; color: var(--vscode-descriptionForeground); }
  .toolbar-button:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
  .count { margin-left: auto; color: var(--vscode-descriptionForeground); }
  .tree { min-width: 0; min-height: 0; overflow: auto; padding: 5px 8px 16px; scrollbar-gutter: stable; }
  .empty { padding: 30px 14px; text-align: center; color: var(--vscode-descriptionForeground); }
  .folder-row, .file-row { width: 100%; min-width: max-content; height: 27px; display: flex; align-items: center; gap: 6px; padding-right: 8px; border-radius: 3px; text-align: left; white-space: nowrap; }
  .folder-row:hover, .file-row:hover { background: var(--vscode-list-hoverBackground); }
  .file-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
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
  let collapsed = new Set();
  const post = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
  const button = (label, title, handler, className) => { const element = node('button', className, label); element.type = 'button'; element.title = title; element.addEventListener('click', handler); return element; };

  function render() {
    app.replaceChildren();
    const root = node('div', 'root');
    const title = node('div', 'title');
    title.append(node('span', '', '↔'), node('span', 'refs', 'Changes Between ' + state.leftRef + ' and ' + state.rightRef));
    const toolbar = node('div', 'toolbar');
    toolbar.append(
      button('⌃', 'Collapse all folders', () => { collapsed = new Set(allDirectoryPaths()); render(); }, 'toolbar-button'),
      button('⌄', 'Expand all folders', () => { collapsed.clear(); render(); }, 'toolbar-button'),
      node('span', 'count', state.files.length + (state.files.length === 1 ? ' file' : ' files')),
    );
    const tree = node('div', 'tree'); tree.setAttribute('role', 'tree');
    if (!state.files.length) tree.append(node('div', 'empty', 'The selected branches have no file differences.'));
    else renderTree(tree, buildTree(state.files));
    root.append(title, toolbar, tree); app.append(root);
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
      current.files.push({ ...file, index });
    });
    return root;
  }

  function renderTree(container, root) {
    [...root.directories.values()].sort(byName).forEach(directory => container.append(renderDirectory(directory, 0)));
    [...root.files].sort(byName).forEach(file => container.append(renderFile(file, 0)));
  }

  function renderDirectory(directory, depth) {
    const section = node('section');
    const isCollapsed = collapsed.has(directory.path);
    const row = button('', directory.path, () => {
      if (collapsed.has(directory.path)) collapsed.delete(directory.path); else collapsed.add(directory.path);
      render();
    }, 'folder-row');
    row.style.paddingLeft = (6 + depth * 16) + 'px'; row.setAttribute('aria-expanded', String(!isCollapsed));
    const count = countFiles(directory);
    row.append(node('span', 'twisty', isCollapsed ? '›' : '⌄'), node('span', 'folder-icon', '▱'), node('span', 'folder-name', directory.name), node('span', 'folder-count', count + (count === 1 ? ' file' : ' files')));
    const children = node('div'); children.hidden = isCollapsed;
    [...directory.directories.values()].sort(byName).forEach(child => children.append(renderDirectory(child, depth + 1)));
    [...directory.files].sort(byName).forEach(file => children.append(renderFile(file, depth + 1)));
    section.append(row, children); return section;
  }

  function renderFile(file, depth) {
    const status = (file.status || 'M').charAt(0);
    const row = button('', file.path, () => selectFile(file.index), 'file-row' + (file.index === selectedIndex ? ' selected' : ''));
    row.style.paddingLeft = (22 + depth * 16) + 'px'; row.dataset.index = String(file.index); row.setAttribute('role', 'treeitem'); row.setAttribute('aria-selected', String(file.index === selectedIndex));
    row.append(node('span', 'status status-' + status, status), node('span', 'file-icon', fileIcon(file.path)), node('span', 'file-name', file.path.split('/').pop()));
    if (file.originalPath) row.append(node('span', 'rename', '← ' + file.originalPath));
    return row;
  }

  function selectFile(index) {
    selectedIndex = index;
    document.querySelectorAll('.file-row').forEach(row => {
      const selected = Number(row.dataset.index) === selectedIndex;
      row.classList.toggle('selected', selected); row.setAttribute('aria-selected', String(selected));
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
      selectedIndex = event.data.index;
      document.querySelectorAll('.file-row').forEach(row => {
        const selected = Number(row.dataset.index) === selectedIndex;
        row.classList.toggle('selected', selected); row.setAttribute('aria-selected', String(selected));
      });
    }
  });
  post('ready'); render();
`;

import * as path from "node:path";
import * as vscode from "vscode";
import { ChangelistStore } from "../changelists/store";
import { GitBranch, GitChange, GitCommit, GitCommitFile } from "../git/types";
import { GitTraceEvent } from "../git/runner";
import { RepositoryManager } from "../repositoryManager";
import { ShelfEntry, ShelfStore } from "../shelves/store";
import { ChangeNode } from "../views/changesTree";
import { DiffContentProvider } from "../views/diffProvider";
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
  | { type: "openCommitFile"; hash: string; path: string }
  | { type: "refresh" }
  | { type: "clearConsole" }
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

interface LogSelection {
  commit: GitCommit;
  files: GitCommitFile[];
}

type ToolTab = "log" | "console" | "changes" | "shelf";

const ALLOWED_COMMANDS = new Set([
  "jbGit.branchesPopup",
  "jbGit.operationsPopup",
  "jbGit.fetch",
  "jbGit.pull",
  "jbGit.push",
  "jbGit.stash",
  "jbGit.applyPatch",
  "jbGit.continueOperation",
  "jbGit.abortOperation",
]);

export class IntelliJGitToolWindowProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "jbGit.toolWindow";

  private view?: vscode.WebviewView;
  private selectedRoot?: string;
  private selectedRef?: string;
  private selectedHash?: string;
  private filePath?: string;
  private requestedTab: ToolTab = "log";
  private currentCommits: GitCommit[] = [];
  private traces: GitTraceEvent[] = [];
  private readonly selectedPaths = new Map<string, Set<string>>();
  private readonly knownPaths = new Map<string, Set<string>>();
  private updateVersion = 0;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly manager: RepositoryManager,
    private readonly changelists: ChangelistStore,
    private readonly shelves: ShelfStore,
    private readonly diffProvider: DiffContentProvider,
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
    view.webview.html = webviewDocument(view.webview, "Git", logStyles, logScript);
    this.disposables.push(
      view.webview.onDidReceiveMessage((message: LogMessage) => void this.handleMessage(message)),
      view.onDidDispose(() => { if (this.view === view) this.view = undefined; }),
    );
    void this.update();
  }

  public async open(root?: string, filePath?: string, tab: ToolTab = "log"): Promise<void> {
    if (root && this.manager.snapshot(root)) this.selectedRoot = root;
    this.requestedTab = tab;
    this.filePath = filePath;
    this.selectedRef = undefined;
    this.selectedHash = undefined;
    await vscode.commands.executeCommand(`${IntelliJGitToolWindowProvider.viewType}.focus`);
    await this.view?.webview.postMessage({ type: "activateTab", tab });
    await this.update();
  }

  public async openChanges(root?: string): Promise<void> {
    await this.open(root, undefined, "changes");
  }

  public appendTrace(event: GitTraceEvent): void {
    this.traces.push(event);
    if (this.traces.length > 400) this.traces = this.traces.slice(-400);
    void this.view?.webview.postMessage({ type: "trace", trace: event });
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
      await webview.postMessage({ type: "state", state: { empty: true, repositories } });
      return;
    }
    try {
      const repository = snapshot.repository;
      const root = repository.info.rootPath;
      const changes = snapshot.status?.changes ?? [];
      const selected = this.syncSelection(root, changes);
      let shelfEntries: ShelfEntry[] = [];
      try {
        shelfEntries = await this.shelves.list(root);
      } catch (error) {
        if (version === this.updateVersion) await webview.postMessage({ type: "error", message: formatError(error) });
      }
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
    } catch (error) {
      if (version === this.updateVersion) await webview.postMessage({ type: "error", message: formatError(error) });
    }
  }

  private async handleMessage(message: LogMessage): Promise<void> {
    try {
      if (message.type === "ready") {
        await this.view?.webview.postMessage({ type: "activateTab", tab: this.requestedTab });
        return void this.update();
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
      if (message.type === "openDiff") {
        const change = changes.find((item) => item.path === message.path);
        if (!change) return;
        const mode = change.staged && !change.unstaged ? "staged" : "unstaged";
        await vscode.commands.executeCommand("jbGit.openDiff", new ChangeNode(root, change, mode));
        return;
      }
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
        await this.view?.webview.postMessage({ type: "selection", selection: { commit, files } });
        return;
      }
      if (message.type === "refresh") {
        await this.manager.refresh(root);
        return;
      }
      if (message.type === "showPatch") {
        if (!/^[0-9a-f]{40}$/i.test(message.hash)) return;
        const patch = await snapshot.repository.showCommit(message.hash);
        const document = await vscode.workspace.openTextDocument({ content: patch, language: "diff" });
        await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        return;
      }
      if (message.type === "openCommitFile") {
        if (!/^[0-9a-f]{40}$/i.test(message.hash)) return;
        const commit = this.currentCommits.find((item) => item.hash === message.hash);
        if (!commit) return;
        const files = await this.manager.commitFiles(root, commit.hash);
        const file = files.find((item) => item.path === message.path);
        if (!file) return;
        const oldPath = file.originalPath ?? file.path;
        const [left, right] = await Promise.all([
          commit.parents[0]
            ? snapshot.repository.fileContent(oldPath, commit.parents[0])
            : Promise.resolve(Buffer.alloc(0)),
          file.status.startsWith("D")
            ? Promise.resolve(Buffer.alloc(0))
            : snapshot.repository.fileContent(file.path, commit.hash),
        ]);
        const label = `${file.path} (${commit.hash.slice(0, 8)})`;
        const leftUri = this.diffProvider.register(root, `${label}:parent`, left.toString("utf8"));
        const rightUri = this.diffProvider.register(root, `${label}:commit`, right.toString("utf8"));
        await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, label, { preview: true });
        return;
      }
      if (message.type === "runCommand") {
        if (ALLOWED_COMMANDS.has(message.command)) await vscode.commands.executeCommand(message.command, root);
        return;
      }
      if (!(await requireTrusted())) return;
      if (message.type === "commit") {
        const commitMessage = message.message.trim();
        if (!commitMessage) return void vscode.window.showWarningMessage("Enter a commit message first.");
        const paths = changes.filter((change) => selected.has(change.path)).map((change) => change.path);
        if (!paths.length) return void vscode.window.showWarningMessage("Select at least one changed file to commit.");
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
        const name = await vscode.window.showInputBox({ title: "New Changelist", prompt: "Name", placeHolder: "Feature work" });
        if (name?.trim()) await this.changelists.create(root, name.trim());
        return;
      }
      if (message.type === "setActiveChangelist") {
        await this.changelists.setActive(root, message.id);
        return;
      }
      if (message.type === "moveToChangelist") {
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
        const change = changes.find((item) => item.path === message.path);
        if (!change) return;
        if (message.type === "stage") await this.manager.stage(root, [change.path]);
        else await this.manager.unstage(root, [change.path]);
        return;
      }
      if (message.type === "discard") {
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

const logStyles = String.raw`
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body, #app { width: 100%; height: 100%; margin: 0; padding: 0; }
  body { overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-panel-background, var(--vscode-editor-background)); font: 12px var(--vscode-font-family); }
  button, select, input, textarea { color: inherit; font: inherit; }
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
  .commit-row { min-height: 27px; cursor: pointer; }
  .commit-row:hover { background: var(--vscode-list-hoverBackground); }
  .commit-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .commit-row:focus-visible, .file-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
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
  .file-row { min-height: 25px; display: grid; grid-template-columns: 23px minmax(0, 1fr); align-items: center; padding: 0 7px; cursor: pointer; }
  .file-row:hover { background: var(--vscode-list-hoverBackground); }
  .file-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
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
  .count { display: inline-grid; place-items: center; min-width: 16px; height: 16px; margin-left: 5px; padding: 0 4px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 10px; }
  .changes-toolbar { display: flex; align-items: center; gap: 5px; padding: 5px 7px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); }
  .changes-toolbar select { max-width: 240px; height: 26px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 2px 5px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .changes-workspace { min-height: 0; display: grid; grid-template-columns: minmax(360px, 1fr) 340px; overflow: hidden; }
  .changes-list { min-width: 0; min-height: 0; overflow: auto; border-right: 1px solid var(--vscode-panel-border); }
  .operation { margin: 6px; padding: 7px 8px; border-radius: 3px; background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); }
  .operation-actions { margin-top: 6px; display: flex; gap: 5px; }
  .small-button { min-height: 24px; padding: 3px 7px; border-radius: 2px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .change-group { margin-top: 2px; }
  .group-header { height: 27px; display: flex; align-items: center; gap: 5px; padding: 0 8px; font-weight: 600; user-select: none; }
  .group-header:hover { background: var(--vscode-list-hoverBackground); }
  .twisty { width: 12px; color: var(--vscode-descriptionForeground); }
  .active-dot { color: var(--vscode-charts-blue); }
  .select-all { margin-left: auto; color: var(--vscode-descriptionForeground); }
  .change-row { height: 26px; display: grid; grid-template-columns: 24px 20px minmax(0, 1fr) auto; align-items: center; padding: 0 6px 0 20px; }
  .change-row:hover { background: var(--vscode-list-hoverBackground); }
  .change-row input { margin: 0; }
  .change-status { width: 18px; font-weight: 700; text-align: center; }
  .status-M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .status-A, .status-q { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
  .status-D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .status-R { color: var(--vscode-gitDecoration-renamedResourceForeground); }
  .status-bang { color: var(--vscode-gitDecoration-conflictingResourceForeground); }
  .change-file { min-width: 0; display: flex; align-items: baseline; gap: 7px; }
  .file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .directory, .stage-mark { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .stage-mark { margin-left: auto; }
  .row-actions { display: none; align-items: center; }
  .change-row:hover .row-actions { display: flex; }
  .row-action { width: 24px; height: 24px; border-radius: 2px; }
  .row-action:hover { background: var(--vscode-toolbar-hoverBackground); }
  .commit-form { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(60px, 1fr) auto auto; gap: 0; background: var(--vscode-panel-background, var(--vscode-editor-background)); }
  .commit-form-title { height: 28px; display: flex; align-items: center; padding: 0 9px; font-weight: 600; background: var(--vscode-editorGroupHeader-tabsBackground); border-bottom: 1px solid var(--vscode-panel-border); }
  .commit-message { width: calc(100% - 14px); min-height: 60px; margin: 7px; padding: 7px 8px; resize: none; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .commit-message::placeholder { color: var(--vscode-input-placeholderForeground); }
  .commit-options { min-height: 30px; display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 0 8px; color: var(--vscode-descriptionForeground); }
  .commit-options label { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
  .commit-actions { display: grid; grid-template-columns: minmax(0, 1fr) 40px; gap: 4px; padding: 0 7px 7px; }
  .primary { min-height: 29px; padding: 4px 10px; border-radius: 2px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .secondary { min-height: 29px; padding: 4px 8px; border-radius: 2px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .shelf-pane { min-height: 0; overflow: auto; padding: 3px 0 16px; }
  .shelf-row { margin: 2px 6px; padding: 7px 9px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 8px; border-radius: 3px; }
  .shelf-row:hover { background: var(--vscode-list-hoverBackground); }
  .shelf-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .shelf-meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .shelf-actions { grid-row: 1 / 3; grid-column: 2; display: flex; align-items: center; gap: 4px; }
  @media (max-width: 1000px) {
    .workspace { grid-template-columns: 145px minmax(270px, 1fr) 235px; }
    .table-head, .commit-row { grid-template-columns: minmax(210px, 1fr) 82px; }
    .table-head > :nth-child(3), .table-head > :nth-child(4), .commit-row > :nth-child(3), .commit-row > :nth-child(4) { display: none; }
    .commit-details { padding: 8px; }
    .detail-meta { grid-template-columns: 44px 1fr; font-size: 11px; }
    .detail-actions .action { padding: 0 5px; }
  }
  @media (max-width: 650px) { .workspace { grid-template-columns: 125px minmax(260px, 1fr); } .details { display: none; } }
  @media (max-width: 760px) { .changes-workspace { grid-template-columns: minmax(310px, 1fr) 280px; } .commit-options { gap: 5px; font-size: 11px; } }
`;

const logScript = String.raw`
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state = { repositories: [], branches: [], commits: [] };
  let search = '';
  let uiState = vscode.getState() || {};
  let activeToolTab = uiState.activeToolTab || 'log';
  let pendingCommitHash;
  let selectedFilePath;
  const colors = ['#4b8ff9', '#e36d75', '#55a868', '#c887d7', '#d99b42', '#45a9a5'];
  const post = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  const node = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
  const button = (label, title, handler, className = 'icon-button') => { const b = node('button', className, label); b.type = 'button'; b.title = title; b.addEventListener('click', handler); return b; };
  const saveUiState = extra => { uiState = { ...uiState, ...extra }; vscode.setState(uiState); };
  const selectToolTab = tab => { activeToolTab = tab; saveUiState({ activeToolTab: tab }); render(); };
  const keyboardActivate = (element, handler) => element.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault(); handler();
  });

  function render() {
    app.replaceChildren(); const root = node('div', 'root');
    const tabs = node('div', 'tool-tabs');
    const logTab = button('Log', 'Git Log', () => selectToolTab('log'), 'tool-tab' + (activeToolTab === 'log' ? ' active' : ''));
    const consoleTab = button('Console', 'Git Console', () => selectToolTab('console'), 'tool-tab' + (activeToolTab === 'console' ? ' active' : ''));
    const changesTab = button('Local Changes', 'Local Changes', () => selectToolTab('changes'), 'tool-tab' + (activeToolTab === 'changes' ? ' active' : ''));
    changesTab.append(node('span', 'count', String(state.totalChanges || 0)));
    const shelfTab = button('Shelf', 'Shelved Changes', () => selectToolTab('shelf'), 'tool-tab' + (activeToolTab === 'shelf' ? ' active' : ''));
    shelfTab.append(node('span', 'count', String((state.shelves || []).length)));
    tabs.append(logTab, consoleTab, changesTab, shelfTab);
    root.append(tabs);
    if (activeToolTab === 'console') {
      const consoleBar = node('div', 'console-toolbar');
      consoleBar.append(node('span', '', 'Git Console'), node('span', 'spacer'), button('Clear', 'Clear Git Console', () => post('clearConsole'), 'action'));
      root.append(consoleBar, consolePanel()); app.append(root); return;
    }
    if (activeToolTab === 'changes') {
      root.append(changesToolbar(), changesWorkspace()); app.append(root); return;
    }
    if (activeToolTab === 'shelf') {
      root.append(changesToolbar(), shelfPanel()); app.append(root); return;
    }
    root.append(toolbar());
    const workspace = node('div', 'workspace');
    if (state.empty) workspace.append(node('div', 'empty', 'Open a folder containing a Git repository.'));
    else workspace.append(branchPane(), commitPane(), detailsPane());
    root.append(workspace); app.append(root); requestAnimationFrame(drawGraphs);
  }

  function repositorySelect() {
    const repositories = node('select'); repositories.title = 'Git root';
    for (const repo of state.repositories || []) {
      const option = node('option', '', repo.name + (repo.branch ? ' · ' + repo.branch : ''));
      option.value = repo.root; option.selected = repo.root === state.selectedRoot; repositories.append(option);
    }
    repositories.addEventListener('change', () => post('selectRepository', { root: repositories.value }));
    return repositories;
  }

  function changesToolbar() {
    const bar = node('div', 'changes-toolbar');
    bar.append(
      repositorySelect(),
      button('⑂ ' + (state.branch || 'detached HEAD'), 'Branches', () => post('runCommand', { command: 'jbGit.branchesPopup' }), 'icon-button'),
      button('↻', 'Refresh', () => post('refresh')),
    );
    if (activeToolTab === 'changes') {
      bar.append(
        button('+ Changelist', 'New Changelist', () => post('createChangelist'), 'action'),
        button('Shelve', 'Shelve selected changes', () => post('createShelf'), 'action'),
      );
    }
    bar.append(node('span', 'spacer'), button('⋮', 'More Git actions', () => post('runCommand', { command: 'jbGit.operationsPopup' })));
    return bar;
  }

  function changesWorkspace() {
    const workspace = node('div', 'changes-workspace');
    workspace.append(changesPane(), commitForm());
    return workspace;
  }

  function changesPane() {
    const pane = node('div', 'changes-list');
    if (state.error) pane.append(node('div', 'error', state.error));
    if (state.operation && state.operation.kind !== 'none') {
      const operation = node('div', 'operation', state.operation.kind.toUpperCase() + ' is in progress');
      const actions = node('div', 'operation-actions');
      if (state.operation.canContinue) actions.append(button('Continue', 'Continue operation', () => post('runCommand', { command: 'jbGit.continueOperation' }), 'small-button'));
      if (state.operation.canAbort) actions.append(button('Abort', 'Abort operation', () => post('runCommand', { command: 'jbGit.abortOperation' }), 'small-button'));
      operation.append(actions); pane.append(operation);
    }
    if (state.empty) { pane.append(node('div', 'empty', 'Open a folder containing a Git repository.')); return pane; }
    if (!state.totalChanges) { pane.append(node('div', 'empty', 'No local changes')); return pane; }
    for (const list of state.lists || []) {
      const group = node('section', 'change-group');
      const header = node('div', 'group-header');
      header.append(
        node('span', 'twisty', '⌄'),
        node('span', list.active ? 'active-dot' : '', list.active ? '●' : '○'),
        node('span', '', list.name),
        node('span', 'count', String(list.changes.length)),
      );
      header.title = list.active ? 'Active Changelist' : 'Make active Changelist';
      header.addEventListener('click', () => post('setActiveChangelist', { id: list.id }));
      header.append(button('✓ All', 'Select all changes', event => { event.stopPropagation(); post('toggleAll', { checked: true }); }, 'select-all'));
      group.append(header);
      for (const change of list.changes) group.append(changeRow(change));
      pane.append(group);
    }
    return pane;
  }

  function changeRow(change) {
    const row = node('div', 'change-row'); row.title = change.path;
    const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = change.checked; checkbox.title = 'Include in commit';
    checkbox.addEventListener('change', () => post('togglePath', { path: change.path, checked: checkbox.checked }));
    const statusClass = change.status === '?' ? 'status-q' : change.status === '!' ? 'status-bang' : 'status-' + change.status;
    const file = node('div', 'change-file'); file.append(node('span', 'file-name', change.fileName));
    if (change.directory) file.append(node('span', 'directory', change.directory));
    if (change.staged) file.append(node('span', 'stage-mark', 'staged'));
    file.addEventListener('dblclick', () => post('openDiff', { path: change.path }));
    const actions = node('div', 'row-actions');
    actions.append(button('↔', 'Show Diff', () => post('openDiff', { path: change.path }), 'row-action'));
    if (change.staged && !change.unstaged) actions.append(button('−', 'Unstage', () => post('unstage', { path: change.path }), 'row-action'));
    else actions.append(button('+', 'Stage', () => post('stage', { path: change.path }), 'row-action'));
    actions.append(
      button('⇥', 'Move to Changelist', () => post('moveToChangelist', { path: change.path }), 'row-action'),
      button('↶', 'Rollback', () => post('discard', { path: change.path }), 'row-action'),
    );
    row.append(checkbox, node('span', 'change-status ' + statusClass, change.status), file, actions);
    return row;
  }

  function commitForm() {
    const form = node('div', 'commit-form');
    form.append(node('div', 'commit-form-title', 'Commit Changes'));
    const message = node('textarea', 'commit-message'); message.placeholder = 'Commit Message'; message.value = uiState.commitMessage || '';
    message.addEventListener('input', () => saveUiState({ commitMessage: message.value }));
    const options = node('div', 'commit-options');
    const amend = checkboxOption('Amend', 'amend');
    const signoff = checkboxOption('Sign-off', 'signoff');
    const noVerify = checkboxOption('Skip hooks', 'noVerify');
    options.append(amend.label, signoff.label, noVerify.label, node('span', 'spacer'), node('span', '', (state.selectedCount || 0) + ' selected'));
    const submit = push => post('commit', { message: message.value, amend: amend.input.checked, signoff: signoff.input.checked, noVerify: noVerify.input.checked, push });
    const actions = node('div', 'commit-actions');
    actions.append(button('Commit', 'Commit selected changes', () => submit(false), 'primary'), button('↑', 'Commit and Push', () => submit(true), 'secondary'));
    form.append(message, options, actions); return form;
  }

  function checkboxOption(text, key) {
    const label = node('label'); const input = node('input'); input.type = 'checkbox'; input.checked = Boolean(uiState[key]);
    input.addEventListener('change', () => saveUiState({ [key]: input.checked }));
    label.append(input, node('span', '', text)); return { label, input };
  }

  function shelfPanel() {
    const pane = node('div', 'shelf-pane');
    const top = node('div', 'group-header');
    top.append(node('span', '', 'Shelved Changes'), node('span', 'spacer'), button('+ Shelve', 'Shelve selected local changes', () => { selectToolTab('changes'); }, 'action'));
    pane.append(top);
    if (!(state.shelves || []).length) { pane.append(node('div', 'empty', 'No shelved changes')); return pane; }
    for (const shelf of state.shelves) {
      const item = node('div', 'shelf-row');
      item.append(node('div', 'shelf-name', shelf.name), node('div', 'shelf-meta', new Date(shelf.createdAt).toLocaleString() + ' · ' + shelf.paths.length + ' files'));
      const actions = node('div', 'shelf-actions');
      actions.append(button('Unshelve', 'Apply shelved changes', () => post('applyShelf', { id: shelf.id }), 'small-button'), button('×', 'Delete Shelf', () => post('deleteShelf', { id: shelf.id }), 'row-action'));
      item.append(actions); pane.append(item);
    }
    return pane;
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
    bar.append(repositories, button('↻', 'Refresh', () => post('refresh')), input, node('span', 'spacer'), node('span', 'branch-label', '⑂ ' + (state.branch || 'detached HEAD')));
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
      const selected = (pendingCommitHash || state.selection?.commit.hash) === commit.hash;
      const row = node('div', 'commit-row' + (selected ? ' selected' : '')); row.dataset.hash = commit.hash;
      row.tabIndex = 0; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(selected));
      const subject = node('div', 'subject-cell'); const canvas = node('canvas'); canvas.width = 144; canvas.height = 54; canvas.dataset.graph = JSON.stringify(graph[index]); subject.append(canvas);
      const refs = node('div', 'refs'); for (const ref of (commit.refs || []).slice(0, 2)) refs.append(node('span', 'ref', shortRef(ref))); subject.append(refs, node('span', 'subject', commit.subject || '(no subject)'));
      row.append(subject, node('div', '', commit.author), node('div', 'muted', formatDate(commit.authoredAt)), node('div', 'muted', commit.hash.slice(0, 8)));
      const select = () => {
        pendingCommitHash = commit.hash;
        document.querySelectorAll('.commit-row').forEach(item => {
          const active = item.dataset.hash === pendingCommitHash;
          item.classList.toggle('selected', active); item.setAttribute('aria-selected', String(active));
        });
        post('selectCommit', { hash: commit.hash });
      };
      row.addEventListener('click', select); keyboardActivate(row, select);
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
    const files = node('div', 'files'); files.setAttribute('role', 'listbox'); files.append(node('div', 'pane-title', 'Changed Files (' + selection.files.length + ')'));
    for (const file of selection.files) {
      const selected = selectedFilePath === file.path;
      const row = node('div', 'file-row' + (selected ? ' selected' : '')); row.dataset.filePath = file.path;
      row.tabIndex = 0; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(selected));
      row.title = file.originalPath ? file.originalPath + ' → ' + file.path : file.path;
      row.append(node('span', 'file-status', file.status[0]), node('span', 'file-path', file.path));
      const selectFile = () => {
        selectedFilePath = file.path;
        document.querySelectorAll('.file-row').forEach(item => {
          const active = item.dataset.filePath === selectedFilePath;
          item.classList.toggle('selected', active); item.setAttribute('aria-selected', String(active));
        });
      };
      row.addEventListener('click', selectFile); keyboardActivate(row, selectFile);
      row.addEventListener('dblclick', () => post('openCommitFile', { hash: commit.hash, path: file.path }));
      files.append(row);
    }
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
    if (event.data.type === 'state') {
      state = event.data.state; pendingCommitHash = undefined;
      if (state.selection && !(state.selection.files || []).some(file => file.path === selectedFilePath)) selectedFilePath = state.selection.files[0]?.path;
      render();
    }
    if (event.data.type === 'selection') {
      state.selection = event.data.selection; pendingCommitHash = undefined;
      if (!(state.selection.files || []).some(file => file.path === selectedFilePath)) selectedFilePath = state.selection.files[0]?.path;
      render();
    }
    if (event.data.type === 'trace') { state.traces = [...(state.traces || []), event.data.trace].slice(-400); if (activeToolTab === 'console') render(); }
    if (event.data.type === 'activateTab') { selectToolTab(event.data.tab); }
    if (event.data.type === 'committed') { saveUiState({ commitMessage: '' }); render(); }
    if (event.data.type === 'error') { const error = node('div', 'error', event.data.message); app.prepend(error); }
  });
  post('ready'); render();
`;

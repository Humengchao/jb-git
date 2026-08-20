import * as path from "node:path";
import * as vscode from "vscode";
import { ChangelistStore } from "../changelists/store";
import { GitBranch, GitChange, GitCommit, GitCommitFile, GitLogOptions } from "../git/types";
import { GitTraceEvent } from "../git/runner";
import { RepositoryManager } from "../repositoryManager";
import { ShelfEntry, ShelfStore } from "../shelves/store";
import { ChangeNode } from "../views/changesTree";
import { DiffContentProvider } from "../views/diffProvider";
import { BranchComparisonWorkspace } from "./branchComparison";
import { webviewDocument } from "./html";

type LogMessage =
  | { type: "ready"; logOptions?: Partial<GitLogOptions> }
  | { type: "selectRepository"; root: string }
  | { type: "selectRef"; ref?: string }
  | { type: "setPathFilter"; path?: string }
  | { type: "setLogOptions"; options: GitLogOptions }
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
  | { type: "runCommand"; command: string }
  | { type: "contextAction"; action: "copyRevision" | "createPatch" | "checkoutRevision" | "compareWithLocal" | "createTag"; hash: string }
  | { type: "contextAction"; action: "copyBranch" | "newBranchFromRef" | "showRefDiff" | "createWorktreeFromRef" | "renameBranch" | "deleteBranch"; ref: string; kind: GitBranch["kind"] }
  | { type: "contextAction"; action: "compareBranches" | "showBranchesDiff" | "deleteBranches"; branches: Array<{ name: string; kind: GitBranch["kind"] }> }
  | { type: "contextAction"; action: "copyPath" | "showFileDiff" | "compareFileWithLocal" | "openRepositoryFile" | "createFilePatch" | "restoreFile" | "fileHistory"; hash: string; path: string };

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
  private logOptions: GitLogOptions = { order: "date", firstParent: false, noMerges: false };
  private requestedTab: ToolTab = "log";
  private currentCommits: GitCommit[] = [];
  private traces: GitTraceEvent[] = [];
  private readonly selectedPaths = new Map<string, Set<string>>();
  private readonly knownPaths = new Map<string, Set<string>>();
  private updateVersion = 0;
  private readonly branchComparisons: BranchComparisonWorkspace;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly manager: RepositoryManager,
    private readonly changelists: ChangelistStore,
    private readonly shelves: ShelfStore,
    private readonly diffProvider: DiffContentProvider,
  ) {
    this.branchComparisons = new BranchComparisonWorkspace(diffProvider);
    this.disposables.push(
      this.branchComparisons,
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
        ? await repository.logRef(this.selectedRef, 300, this.filePath, this.logOptions)
        : await repository.log(300, this.filePath, this.logOptions);
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
          logOptions: this.logOptions,
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
        this.logOptions = normalizeLogOptions(message.logOptions);
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
      if (message.type === "contextAction") {
        if ("branches" in message) {
          const branches = message.branches.map((requested) => snapshot.branches.find(
            (candidate) => candidate.name === requested.name && candidate.kind === requested.kind,
          ));
          if (branches.some((branch) => !branch)) return;
          const selectedBranches = branches.filter((branch): branch is GitBranch => Boolean(branch));
          if (message.action === "compareBranches" || message.action === "showBranchesDiff") {
            if (selectedBranches.length !== 2) return;
            const [left, right] = selectedBranches;
            if (message.action === "showBranchesDiff") {
              await this.branchComparisons.open(snapshot.repository, left, right);
              return;
            }
            const content = await snapshot.repository.compareRefHistory(left.name, right.name);
            await showDiffText(`${left.name} ↔ ${right.name}`, content);
            return;
          }
          if (message.action === "deleteBranches") {
            if (!(await requireTrusted())) return;
            const current = snapshot.status?.branch.head;
            const deletable = selectedBranches.filter((branch) => branch.kind === "local" && branch.name !== current);
            if (!deletable.length) return;
            const confirmed = await vscode.window.showWarningMessage(
              `Delete ${deletable.length} selected branch${deletable.length === 1 ? "" : "es"}?`,
              { modal: true, detail: deletable.map((branch) => branch.name).join("\n") },
              "Delete",
            );
            if (confirmed === "Delete") {
              for (const branch of deletable) await this.manager.deleteBranch(root, branch.name);
            }
            return;
          }
          return;
        }
        if ("ref" in message) {
          const branch = snapshot.branches.find((item) => item.name === message.ref && item.kind === message.kind);
          if (!branch) return;
          if (message.action === "copyBranch") {
            await vscode.env.clipboard.writeText(branch.name);
            return;
          }
          if (message.action === "showRefDiff") {
            const diff = await snapshot.repository.diffAgainstWorkingTree(branch.name);
            await showDiffText(`${branch.name} ↔ Working Tree`, diff);
            return;
          }
          if (!(await requireTrusted())) return;
          if (message.action === "newBranchFromRef") {
            const name = await vscode.window.showInputBox({ title: `New Branch from '${branch.name}'`, prompt: "Branch name" });
            if (name?.trim()) await this.manager.createBranch(root, name.trim(), branch.name);
            return;
          }
          if (message.action === "createWorktreeFromRef") {
            const worktreePath = await vscode.window.showInputBox({ title: `New Worktree from '${branch.name}'`, prompt: "Worktree path", placeHolder: "../feature-worktree" });
            if (!worktreePath?.trim()) return;
            const newBranch = await vscode.window.showInputBox({ title: "Optional New Branch", prompt: "Leave empty to use the selected ref" });
            await this.manager.addWorktree(root, worktreePath.trim(), branch.name, newBranch?.trim() || undefined);
            return;
          }
          if (message.action === "renameBranch") {
            if (branch.kind !== "local") return;
            const name = await vscode.window.showInputBox({ title: `Rename '${branch.name}'`, value: branch.name });
            if (name?.trim() && name.trim() !== branch.name) await this.manager.renameBranch(root, branch.name, name.trim());
            return;
          }
          if (message.action === "deleteBranch") {
            if (branch.kind !== "local" || branch.name === snapshot.status?.branch.head) return;
            const confirmed = await vscode.window.showWarningMessage(`Delete branch '${branch.name}'?`, { modal: true }, "Delete");
            if (confirmed === "Delete") await this.manager.deleteBranch(root, branch.name);
            return;
          }
          return;
        }
        if (!/^[0-9a-f]{40}$/i.test(message.hash)) return;
        const commit = this.currentCommits.find((item) => item.hash === message.hash);
        if (!commit) return;
        if ("path" in message) {
          const files = await this.manager.commitFiles(root, commit.hash);
          const file = files.find((item) => item.path === message.path);
          if (!file) return;
          if (message.action === "copyPath") {
            await vscode.env.clipboard.writeText(file.path);
            return;
          }
          if (message.action === "showFileDiff") {
            await this.openCommitFile(snapshot.repository, commit, file);
            return;
          }
          if (message.action === "compareFileWithLocal") {
            const [left, right] = await Promise.all([
              snapshot.repository.fileContent(file.path, commit.hash),
              snapshot.repository.fileContent(file.path),
            ]);
            const label = `${file.path} (${commit.hash.slice(0, 8)} ↔ Local)`;
            const leftUri = this.diffProvider.register(root, `${label}:commit`, left.toString("utf8"));
            const rightUri = this.diffProvider.register(root, `${label}:local`, right.toString("utf8"));
            await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, label, { preview: true });
            return;
          }
          if (message.action === "openRepositoryFile") {
            const content = await snapshot.repository.fileContent(file.path, commit.hash);
            const uri = this.diffProvider.register(root, `${file.path}@${commit.hash.slice(0, 8)}`, content.toString("utf8"));
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
            return;
          }
          if (message.action === "createFilePatch") {
            const patch = await snapshot.repository.formatPatch(commit.hash, file.path);
            await savePatch(root, `${path.basename(file.path)}-${commit.hash.slice(0, 8)}.patch`, patch);
            return;
          }
          if (message.action === "fileHistory") {
            this.filePath = file.path;
            this.selectedRef = commit.hash;
            this.selectedHash = undefined;
            return void this.update();
          }
          if (message.action === "restoreFile") {
            if (!(await requireTrusted())) return;
            const confirmed = await vscode.window.showWarningMessage(
              `Replace the working-tree version of '${file.path}' with ${commit.hash.slice(0, 8)}?`,
              { modal: true }, "Restore",
            );
            if (confirmed === "Restore") await this.manager.restoreFileFromRevision(root, commit.hash, file.path);
            return;
          }
          return;
        }
        if (message.action === "copyRevision") {
          await vscode.env.clipboard.writeText(commit.hash);
          return;
        }
        if (message.action === "createPatch") {
          await savePatch(root, `${commit.hash.slice(0, 8)}.patch`, await snapshot.repository.formatPatch(commit.hash));
          return;
        }
        if (message.action === "compareWithLocal") {
          await showDiffText(`${commit.hash.slice(0, 8)} ↔ Working Tree`, await snapshot.repository.diffAgainstWorkingTree(commit.hash));
          return;
        }
        if (!(await requireTrusted())) return;
        if (message.action === "checkoutRevision") {
          const confirmed = await vscode.window.showWarningMessage(`Checkout ${commit.hash.slice(0, 8)} in detached HEAD mode?`, { modal: true }, "Checkout");
          if (confirmed === "Checkout") await this.manager.checkoutRevision(root, commit.hash);
          return;
        }
        if (message.action === "createTag") {
          const name = await vscode.window.showInputBox({ title: `New Tag at ${commit.hash.slice(0, 8)}`, prompt: "Tag name" });
          if (name?.trim()) await this.manager.createTag(root, name.trim(), commit.hash);
          return;
        }
        return;
      }
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
      if (message.type === "setPathFilter") {
        const filePath = message.path?.trim();
        if (filePath && (filePath.length > 4096 || /[\r\n\0]/.test(filePath))) return;
        this.filePath = filePath || undefined;
        this.selectedHash = undefined;
        return void this.update();
      }
      if (message.type === "setLogOptions") {
        this.logOptions = normalizeLogOptions(message.options);
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
        await this.openCommitFile(snapshot.repository, commit, file);
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

  private async openCommitFile(repository: NonNullable<ReturnType<RepositoryManager["snapshot"]>>["repository"], commit: GitCommit, file: GitCommitFile): Promise<void> {
    const root = repository.info.rootPath;
    const oldPath = file.originalPath ?? file.path;
    const [left, right] = await Promise.all([
      commit.parents[0] ? repository.fileContent(oldPath, commit.parents[0]) : Promise.resolve(Buffer.alloc(0)),
      file.status.startsWith("D") ? Promise.resolve(Buffer.alloc(0)) : repository.fileContent(file.path, commit.hash),
    ]);
    const label = `${file.path} (${commit.hash.slice(0, 8)})`;
    const leftUri = this.diffProvider.register(root, `${label}:parent`, left.toString("utf8"));
    const rightUri = this.diffProvider.register(root, `${label}:commit`, right.toString("utf8"));
    await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, label, { preview: true });
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

function normalizeLogOptions(options?: Partial<GitLogOptions>): GitLogOptions {
  return {
    order: options?.order === "topological" ? "topological" : "date",
    firstParent: Boolean(options?.firstParent),
    noMerges: Boolean(options?.noMerges),
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function showDiffText(title: string, content: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({ content, language: "diff" });
  await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}

async function savePatch(root: string, name: string, content: string): Promise<void> {
  const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(root, name)), filters: { "Patch files": ["patch"] } });
  if (target) await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
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
  .workspace { --branch-width: 185px; --details-width: 300px; min-width: 0; min-height: 0; display: grid; grid-template-columns: var(--branch-width) 9px minmax(260px, 1fr) 9px var(--details-width); overflow: hidden; }
  .pane { min-width: 0; min-height: 0; overflow: auto; }
  .column-splitter { position: relative; min-width: 9px; cursor: col-resize; background: transparent; outline: none; touch-action: none; }
  .column-splitter::before { content: ''; position: absolute; top: 0; bottom: 0; left: 4px; width: 1px; background: var(--vscode-panel-border); }
  .column-splitter:hover::before, .column-splitter.dragging::before, .column-splitter:focus-visible::before { left: 3px; width: 2px; background: var(--vscode-focusBorder); }
  .branches { overscroll-behavior: contain; scrollbar-gutter: stable; }
  .pane-title { position: sticky; top: 0; z-index: 2; height: 28px; display: flex; align-items: center; padding: 0 9px; font-weight: 600; background: var(--vscode-editorGroupHeader-tabsBackground); border-bottom: 1px solid var(--vscode-panel-border); }
  .branch-section { padding: 5px 0 2px; }
  .section-title { height: 23px; display: flex; align-items: center; padding: 0 9px; color: var(--vscode-descriptionForeground); font-weight: 600; }
  .branch-row { height: 25px; width: 100%; display: flex; align-items: center; gap: 6px; padding: 0 9px 0 16px; text-align: left; white-space: nowrap; }
  .branch-row:hover { background: var(--vscode-list-hoverBackground); }
  .branch-row.active, .branch-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .branch-row.current::before { content: '✓'; width: 11px; margin-left: -11px; color: var(--vscode-charts-green); }
  .branch-name { overflow: hidden; text-overflow: ellipsis; }
  .commit-pane { overflow: hidden; display: grid; grid-template-rows: 35px minmax(0, 1fr); }
  .commit-filters { min-width: 0; display: flex; align-items: center; gap: 2px; padding: 4px 5px; overflow: visible; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); }
  .commit-search { width: 190px; min-width: 88px; max-width: 210px; flex: 0 1 190px; height: 27px; padding: 3px 7px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .filter-button { height: 27px; flex: none; padding: 0 7px; border-radius: 3px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .filter-button:hover, .filter-button.active { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
  .sort-button { min-width: 31px; padding: 0 6px; font-size: 15px; }
  .filter-popover { position: fixed; z-index: 1000; width: min(360px, calc(100vw - 12px)); padding: 8px; border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 6px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); box-shadow: 0 8px 24px rgba(0,0,0,.38); }
  .filter-popover-title { margin: 0 0 6px; color: var(--vscode-descriptionForeground); }
  .filter-popover input { width: 100%; height: 28px; padding: 3px 7px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .filter-popover-actions { display: flex; justify-content: flex-end; gap: 5px; margin-top: 8px; }
  .commit-scroll { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  .table-head, .commit-row { display: grid; grid-template-columns: minmax(300px, 1fr) 145px 135px 82px; align-items: center; }
  .table-head { position: sticky; top: 0; z-index: 3; height: 27px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); color: var(--vscode-descriptionForeground); font-size: 11px; }
  .table-head > span { padding: 0 7px; border-right: 1px solid var(--vscode-panel-border); }
  .commit-list { min-height: 0; overflow: visible; }
  .commit-row { min-height: 27px; cursor: pointer; }
  .commit-row:hover { background: var(--vscode-list-hoverBackground); }
  .commit-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .commit-row:focus-visible, .file-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .commit-row > div { min-width: 0; padding: 0 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .subject-cell { height: 27px; display: flex; align-items: center; gap: 5px; padding-left: 0 !important; }
  canvas { flex: none; width: 72px; height: 27px; }
  canvas.graph-interactive { cursor: pointer; }
  .refs { display: flex; gap: 3px; flex: none; max-width: 180px; overflow: hidden; }
  .ref { padding: 1px 5px; border-radius: 8px; background: color-mix(in srgb, var(--vscode-charts-blue) 24%, transparent); color: var(--vscode-foreground); font-size: 10px; }
  .subject { overflow: hidden; text-overflow: ellipsis; }
  .muted { color: var(--vscode-descriptionForeground); }
  .details { --message-height: 160px; display: grid; grid-template-rows: minmax(70px, 1fr) 9px var(--message-height); overflow: hidden; }
  .commit-details { min-height: 0; padding: 10px; overflow: auto; overscroll-behavior: contain; }
  .detail-subject { font-size: 14px; font-weight: 600; margin-bottom: 7px; white-space: pre-wrap; }
  .detail-meta { display: grid; grid-template-columns: 54px 1fr; gap: 4px 6px; color: var(--vscode-descriptionForeground); }
  .detail-meta strong { color: var(--vscode-foreground); font-weight: 400; overflow-wrap: anywhere; }
  .detail-body { margin-top: 9px; white-space: pre-wrap; line-height: 1.45; }
  .action { height: 25px; padding: 0 7px; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .files { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  .detail-splitter { position: relative; min-height: 9px; cursor: row-resize; background: transparent; outline: none; }
  .detail-splitter::before { content: ''; position: absolute; left: 0; right: 0; top: 4px; height: 1px; background: var(--vscode-panel-border); }
  .detail-splitter:hover::before, .detail-splitter.dragging::before, .detail-splitter:focus-visible::before { height: 2px; background: var(--vscode-focusBorder); }
  .file-tree-root { min-width: max-content; padding-bottom: 8px; }
  .tree-row { height: 25px; display: flex; align-items: center; gap: 5px; padding-right: 7px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .tree-row:hover { background: var(--vscode-list-hoverBackground); }
  .tree-twisty { width: 12px; text-align: center; }
  .tree-folder { color: var(--vscode-foreground); }
  .tree-count { margin-left: 2px; font-size: 11px; }
  .file-row { min-height: 25px; display: grid; grid-template-columns: 23px minmax(0, 1fr); align-items: center; padding: 0 7px; cursor: pointer; }
  .file-row:hover { background: var(--vscode-list-hoverBackground); }
  .file-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .file-status { font-weight: 700; }
  .file-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .context-menu { position: fixed; z-index: 1000; min-width: 230px; max-width: min(360px, calc(100vw - 12px)); max-height: calc(100vh - 12px); overflow: auto; padding: 5px; border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 6px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); box-shadow: 0 8px 24px rgba(0,0,0,.38); }
  .context-menu-item { width: 100%; min-height: 28px; display: flex; align-items: center; gap: 8px; padding: 4px 9px; border-radius: 4px; text-align: left; white-space: nowrap; }
  .context-menu-item:hover, .context-menu-item:focus-visible { outline: 0; background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground)); }
  .context-menu-item:disabled { opacity: .45; pointer-events: none; }
  .context-menu-icon { width: 17px; text-align: center; color: var(--vscode-descriptionForeground); }
  .context-menu-separator { height: 1px; margin: 5px 3px; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); }
  .context-menu-heading { padding: 6px 9px 3px; color: var(--vscode-descriptionForeground); font-weight: 600; }
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
    .table-head, .commit-row { grid-template-columns: minmax(210px, 1fr) 82px; }
    .table-head > :nth-child(3), .table-head > :nth-child(4), .commit-row > :nth-child(3), .commit-row > :nth-child(4) { display: none; }
    .commit-details { padding: 8px; }
    .detail-meta { grid-template-columns: 44px 1fr; font-size: 11px; }
  }
  @media (max-width: 760px) { .filter-button .filter-value { display: none; } }
  @media (max-width: 650px) { .workspace { grid-template-columns: var(--branch-width) 9px minmax(260px, 1fr); } .details, .column-splitter[data-side="details"] { display: none; } }
  @media (max-width: 760px) { .changes-workspace { grid-template-columns: minmax(310px, 1fr) 280px; } .commit-options { gap: 5px; font-size: 11px; } }
`;

const logScript = String.raw`
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state = { repositories: [], branches: [], commits: [] };
  let uiState = vscode.getState() || {};
  let search = uiState.search || '';
  let activeToolTab = uiState.activeToolTab || 'log';
  let selectedBranchKeys = new Set(uiState.selectedBranchKeys || []);
  let authorFilter = uiState.authorFilter || '';
  let dateFilter = uiState.dateFilter || 'all';
  let sortMode = uiState.sortMode === 'topological' ? 'topological' : 'date';
  let firstParent = Boolean(uiState.firstParent);
  let noMerges = Boolean(uiState.noMerges);
  let collapsedGraphSeries = new Set(uiState.collapsedGraphSeries || []);
  let selectedGraphSeries = uiState.selectedGraphSeries || '';
  let hoveredGraphSeries = '';
  let currentGraphFragments = new Map();
  let pendingCommitHash;
  let selectedFilePath;
  let openMenu;
  const colors = ['#4b8ff9', '#e36d75', '#55a868', '#c887d7', '#d99b42', '#45a9a5'];
  const post = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  const node = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
  const button = (label, title, handler, className = 'icon-button') => { const b = node('button', className, label); b.type = 'button'; b.title = title; b.addEventListener('click', handler); return b; };
  const saveUiState = extra => { uiState = { ...uiState, ...extra }; vscode.setState(uiState); };
  const selectToolTab = tab => { closeContextMenu(); activeToolTab = tab; saveUiState({ activeToolTab: tab }); render(); };
  const keyboardActivate = (element, handler) => element.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault(); handler();
  });

  function captureScroll() {
    const result = {};
    for (const id of ['branch-pane', 'commit-scroll', 'changed-files', 'commit-details']) {
      const element = document.getElementById(id);
      if (element) result[id] = { top: element.scrollTop, left: element.scrollLeft };
    }
    return result;
  }

  function restoreScroll(saved) {
    requestAnimationFrame(() => {
      for (const [id, position] of Object.entries(saved || {})) {
        const element = document.getElementById(id);
        if (element) { element.scrollTop = position.top; element.scrollLeft = position.left; }
      }
    });
  }

  function finishRender(root, saved, graphs = false) {
    app.append(root); restoreScroll(saved);
    if (graphs) requestAnimationFrame(drawGraphs);
  }

  function closeContextMenu() {
    openMenu?.remove(); openMenu = undefined;
  }

  function showContextMenu(event, items) {
    event.preventDefault(); event.stopPropagation(); showContextMenuAt(event.clientX, event.clientY, items);
  }

  function showContextMenuAt(clientX, clientY, items) {
    closeContextMenu();
    const menu = node('div', 'context-menu'); menu.setAttribute('role', 'menu');
    for (const item of items) {
      if (item.heading) { menu.append(node('div', 'context-menu-heading', item.heading)); continue; }
      if (item.separator) { menu.append(node('div', 'context-menu-separator')); continue; }
      const entry = button('', item.label, () => { closeContextMenu(); item.run(); }, 'context-menu-item');
      entry.disabled = Boolean(item.disabled); entry.setAttribute('role', 'menuitem');
      entry.append(node('span', 'context-menu-icon', item.icon || ''), node('span', '', item.label)); menu.append(entry);
    }
    document.body.append(menu); openMenu = menu;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(clientX, window.innerWidth - bounds.width - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(clientY, window.innerHeight - bounds.height - 6)) + 'px';
    menu.querySelector('.context-menu-item:not(:disabled)')?.focus();
  }

  function showMenuForElement(element, items) {
    const bounds = element.getBoundingClientRect();
    showContextMenuAt(bounds.left, bounds.bottom + 2, items);
  }

  function attachContextMenu(element, items) {
    const entries = () => typeof items === 'function' ? items() : items;
    element.addEventListener('contextmenu', event => showContextMenu(event, entries()));
    element.addEventListener('keydown', event => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault(); event.stopPropagation();
      const bounds = element.getBoundingClientRect();
      showContextMenuAt(bounds.left + Math.min(28, bounds.width / 2), bounds.top + Math.min(22, bounds.height), entries());
    });
  }

  function render() {
    const saved = captureScroll();
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
      root.append(consoleBar, consolePanel()); finishRender(root, saved); return;
    }
    if (activeToolTab === 'changes') {
      root.append(changesToolbar(), changesWorkspace()); finishRender(root, saved); return;
    }
    if (activeToolTab === 'shelf') {
      root.append(changesToolbar(), shelfPanel()); finishRender(root, saved); return;
    }
    root.append(toolbar());
    const workspace = node('div', 'workspace'); workspace.id = 'log-workspace';
    if (state.empty) workspace.append(node('div', 'empty', 'Open a folder containing a Git repository.'));
    else workspace.append(branchPane(), columnSplitter('branch'), commitPane(), columnSplitter('details'), detailsPane());
    root.append(workspace); finishRender(root, saved, true);
    if (!state.empty) requestAnimationFrame(() => setupWorkspaceColumns(workspace));
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
    actions.append(button('↔', change.conflicted ? 'Open Merge Conflict Editor' : 'Show Diff', () => post('openDiff', { path: change.path }), 'row-action'));
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
    bar.append(repositories, button('↻', 'Refresh', () => post('refresh')), node('span', 'spacer'), node('span', 'branch-label', '⑂ ' + (state.branch || 'detached HEAD')));
    return bar;
  }

  function columnSplitter(side) {
    const splitter = node('div', 'column-splitter'); splitter.dataset.side = side; splitter.tabIndex = 0;
    splitter.setAttribute('role', 'separator'); splitter.setAttribute('aria-orientation', 'vertical');
    splitter.title = side === 'branch' ? 'Drag to resize branches' : 'Drag to resize commit details';
    return splitter;
  }

  function setupWorkspaceColumns(workspace) {
    setColumnWidths(workspace, Number(uiState.branchPaneWidth) || 185, Number(uiState.detailsPaneWidth) || 300, false);
    workspace.querySelectorAll('.column-splitter').forEach(splitter => setupColumnSplitter(workspace, splitter));
    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(() => {
        if (!workspace.isConnected) { observer.disconnect(); return; }
        setColumnWidths(workspace, readColumnWidth(workspace, 'branch'), readColumnWidth(workspace, 'details'), false);
      });
      observer.observe(workspace);
    }
  }

  function setupColumnSplitter(workspace, splitter) {
    const side = splitter.dataset.side;
    const resize = event => {
      const bounds = workspace.getBoundingClientRect();
      const requested = side === 'branch' ? event.clientX - bounds.left : bounds.right - event.clientX;
      const left = side === 'branch' ? requested : readColumnWidth(workspace, 'branch');
      const right = side === 'details' ? requested : readColumnWidth(workspace, 'details');
      setColumnWidths(workspace, left, right, false);
    };
    splitter.addEventListener('mousedown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); splitter.focus(); splitter.classList.add('dragging'); resize(event);
      const move = moveEvent => resize(moveEvent);
      const finish = () => {
        window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', finish);
        splitter.classList.remove('dragging'); persistColumnWidths(workspace);
      };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', finish);
    });
    splitter.addEventListener('dblclick', () => {
      setColumnWidths(workspace, side === 'branch' ? 185 : readColumnWidth(workspace, 'branch'), side === 'details' ? 300 : readColumnWidth(workspace, 'details'), true);
    });
    splitter.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault(); const delta = event.key === 'ArrowRight' ? 16 : -16;
      const left = readColumnWidth(workspace, 'branch') + (side === 'branch' ? delta : 0);
      const right = readColumnWidth(workspace, 'details') + (side === 'details' ? -delta : 0);
      setColumnWidths(workspace, left, right, true);
    });
  }

  function readColumnWidth(workspace, side) {
    const property = side === 'branch' ? '--branch-width' : '--details-width';
    return parseFloat(getComputedStyle(workspace).getPropertyValue(property)) || (side === 'branch' ? 185 : 300);
  }

  function setColumnWidths(workspace, requestedLeft, requestedRight, persist) {
    const compact = window.matchMedia('(max-width: 650px)').matches;
    const total = workspace.clientWidth || window.innerWidth;
    const leftMinimum = 125; const rightMinimum = 190; const centerMinimum = 260; const gutters = compact ? 9 : 18;
    const maximumSides = Math.max(leftMinimum + rightMinimum, total - gutters - centerMinimum);
    let left = Math.max(leftMinimum, requestedLeft || 185);
    let right = Math.max(rightMinimum, requestedRight || 300);
    if (compact) left = Math.min(left, Math.max(leftMinimum, total - gutters - centerMinimum));
    else {
      if (left + right > maximumSides) {
        const overflow = left + right - maximumSides;
        const shrinkRight = Math.min(overflow, Math.max(0, right - rightMinimum)); right -= shrinkRight;
        left = Math.max(leftMinimum, left - (overflow - shrinkRight));
      }
      left = Math.min(left, Math.max(leftMinimum, maximumSides - rightMinimum));
      right = Math.min(right, Math.max(rightMinimum, maximumSides - left));
    }
    workspace.style.setProperty('--branch-width', Math.round(left) + 'px');
    workspace.style.setProperty('--details-width', Math.round(right) + 'px');
    const leftSplitter = workspace.querySelector('.column-splitter[data-side="branch"]');
    const rightSplitter = workspace.querySelector('.column-splitter[data-side="details"]');
    if (leftSplitter) { leftSplitter.setAttribute('aria-valuemin', String(leftMinimum)); leftSplitter.setAttribute('aria-valuemax', String(Math.max(leftMinimum, compact ? total - gutters - centerMinimum : maximumSides - rightMinimum))); leftSplitter.setAttribute('aria-valuenow', String(Math.round(left))); }
    if (rightSplitter) { rightSplitter.setAttribute('aria-valuemin', String(rightMinimum)); rightSplitter.setAttribute('aria-valuemax', String(Math.max(rightMinimum, maximumSides - leftMinimum))); rightSplitter.setAttribute('aria-valuenow', String(Math.round(right))); }
    if (persist) persistColumnWidths(workspace);
  }

  function persistColumnWidths(workspace) {
    saveUiState({ branchPaneWidth: Math.round(readColumnWidth(workspace, 'branch')), detailsPaneWidth: Math.round(readColumnWidth(workspace, 'details')) });
  }

  const branchKey = branch => JSON.stringify([branch.kind, branch.name]);
  const selectedBranches = () => (state.branches || []).filter(branch => selectedBranchKeys.has(branchKey(branch)));
  function setBranchSelection(branches) {
    selectedBranchKeys = new Set(branches.map(branchKey));
    saveUiState({ selectedBranchKeys: [...selectedBranchKeys] });
    document.querySelectorAll('.branch-row[data-branch-key]').forEach(row => {
      const active = selectedBranchKeys.has(row.dataset.branchKey);
      row.classList.toggle('selected', active); row.setAttribute('aria-selected', String(active));
    });
  }

  function branchContextItems(branch) {
    if (!selectedBranchKeys.has(branchKey(branch))) setBranchSelection([branch]);
    const selected = selectedBranches();
    if (selected.length > 1) {
      const descriptors = selected.map(item => ({ name: item.name, kind: item.kind }));
      const deletable = selected.some(item => item.kind === 'local' && item.name !== state.branch);
      return [
        { icon: '↔', label: 'Compare Branches', disabled: selected.length !== 2, run: () => post('contextAction', { action: 'compareBranches', branches: descriptors }) },
        { icon: '⇄', label: 'Show Files Diff', disabled: selected.length !== 2, run: () => post('contextAction', { action: 'showBranchesDiff', branches: descriptors }) },
        { separator: true },
        { icon: '×', label: 'Delete Selected Branches…', disabled: !deletable, run: () => post('contextAction', { action: 'deleteBranches', branches: descriptors }) },
      ];
    }
    const kind = branch.kind;
    return [
      { icon: '+', label: "New Branch from '" + branch.name + "'…", run: () => post('contextAction', { action: 'newBranchFromRef', ref: branch.name, kind: branch.kind }) },
      { icon: '↔', label: 'Show Diff with Working Tree', run: () => post('contextAction', { action: 'showRefDiff', ref: branch.name, kind: branch.kind }) },
      { icon: '▣', label: "New Worktree from '" + branch.name + "'…", run: () => post('contextAction', { action: 'createWorktreeFromRef', ref: branch.name, kind: branch.kind }) },
      { separator: true },
      { icon: '✓', label: 'Checkout', disabled: kind === 'local' && branch.name === state.branch, run: () => post('checkout', { name: branch.name, kind: branch.kind }) },
      { icon: '⧉', label: 'Copy Branch Name', run: () => post('contextAction', { action: 'copyBranch', ref: branch.name, kind: branch.kind }) },
      { separator: true },
      { icon: '✎', label: 'Rename…', disabled: kind !== 'local', run: () => post('contextAction', { action: 'renameBranch', ref: branch.name, kind: branch.kind }) },
      { icon: '×', label: 'Delete…', disabled: kind !== 'local' || branch.name === state.branch, run: () => post('contextAction', { action: 'deleteBranch', ref: branch.name, kind: branch.kind }) },
    ];
  }

  function branchPane() {
    const pane = node('aside', 'pane branches'); pane.id = 'branch-pane'; pane.append(node('div', 'pane-title', 'Branches'));
    const all = button('All', 'Show all branches', () => { setBranchSelection([]); post('selectRef', {}); }, 'branch-row' + (!state.selectedRef && !selectedBranchKeys.size ? ' active' : ''));
    pane.append(all);
    for (const [kind, title] of [['local','Local'], ['remote','Remote'], ['tag','Tags']]) {
      const section = node('section', 'branch-section'); section.append(node('div', 'section-title', title));
      for (const branch of (state.branches || []).filter(item => item.kind === kind)) {
        const key = branchKey(branch); const selected = selectedBranchKeys.has(key);
        const row = button(branch.name, 'Filter by ' + branch.name + ' (Command/Ctrl-click to select multiple)', event => {
          if (event.metaKey || event.ctrlKey) {
            const next = new Set(selectedBranchKeys); if (next.has(key)) next.delete(key); else next.add(key);
            selectedBranchKeys = next; setBranchSelection(selectedBranches()); return;
          }
          setBranchSelection([branch]); post('selectRef', { ref: branch.name });
        }, 'branch-row' + (selected ? ' selected' : '') + (kind === 'local' && branch.name === state.branch ? ' current' : ''));
        row.dataset.branchKey = key; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(selected));
        row.addEventListener('dblclick', () => post('checkout', { name: branch.name, kind: branch.kind }));
        attachContextMenu(row, () => branchContextItems(branch));
        section.append(row);
      }
      pane.append(section);
    }
    return pane;
  }

  function commitPane() {
    const pane = node('main', 'pane commit-pane');
    pane.append(commitFilterBar());
    const head = node('div', 'table-head'); head.append(node('span', '', 'Commit'), node('span', '', 'Author'), node('span', '', 'Date'), node('span', '', 'Hash'));
    const scroll = node('div', 'commit-scroll'); scroll.id = 'commit-scroll';
    const list = node('div', 'commit-list'); list.id = 'commit-list'; scroll.append(head, list); pane.append(scroll); renderCommitRows(list); return pane;
  }

  function filterButton(label, value, title, active, items) {
    const buttonElement = button('', title, () => showMenuForElement(buttonElement, typeof items === 'function' ? items() : items), 'filter-button' + (active ? ' active' : ''));
    buttonElement.append(node('span', '', label), node('span', 'filter-value', value ? ': ' + value : ''), node('span', '', '⌄'));
    return buttonElement;
  }

  function commitFilterBar() {
    const bar = node('div', 'commit-filters');
    const input = node('input', 'commit-search'); input.type = 'search'; input.placeholder = 'Text or hash'; input.value = search;
    input.setAttribute('aria-label', 'Filter commits by text or hash');
    input.addEventListener('input', () => { search = input.value.toLowerCase(); saveUiState({ search }); renderCommitRows(); });
    const branch = filterButton('Branch', state.selectedRef ? shortRef(state.selectedRef) : '', 'Filter by branch', Boolean(state.selectedRef), branchFilterItems);
    const user = filterButton('User', authorFilter, 'Filter by author', Boolean(authorFilter), userFilterItems);
    const dateLabels = { all: '', today: 'Today', week: '7 days', month: '30 days', year: '1 year' };
    const date = filterButton('Date', dateLabels[dateFilter] || '', 'Filter by date', dateFilter !== 'all', dateFilterItems);
    const pathValue = state.filePath ? compactPath(state.filePath) : '';
    const paths = button('', 'Filter by changed path', () => showPathFilterPopover(paths), 'filter-button' + (state.filePath ? ' active' : ''));
    paths.append(node('span', '', 'Paths'), node('span', 'filter-value', pathValue ? ': ' + pathValue : ''), node('span', '', '⌄'));
    const sort = button('⇵', 'Graph and sort options', () => showMenuForElement(sort, graphOptionItems()), 'filter-button sort-button' + ((firstParent || noMerges || sortMode === 'topological') ? ' active' : ''));
    bar.append(input, branch, user, date, paths, sort); return bar;
  }

  function graphOptionItems() {
    return [
      { heading: 'Sort' },
      { icon: sortMode === 'date' ? '✓' : '', label: 'By Commit Date', run: () => setLogOptions({ order: 'date' }) },
      { icon: sortMode === 'topological' ? '✓' : '', label: 'Topologically', run: () => setLogOptions({ order: 'topological' }) },
      { separator: true },
      { heading: 'Options' },
      { icon: firstParent ? '✓' : '', label: 'First Parent', run: () => setLogOptions({ firstParent: !firstParent }) },
      { icon: noMerges ? '✓' : '', label: 'No Merges', run: () => setLogOptions({ noMerges: !noMerges }) },
      { separator: true },
      { heading: 'Branch Actions' },
      { icon: '', label: 'Collapse Linear Branches', disabled: !currentGraphFragments.size, run: collapseLinearBranches },
      { icon: '', label: 'Expand Linear Branches', disabled: !collapsedGraphSeries.size, run: expandLinearBranches },
    ];
  }

  function setLogOptions(update) {
    if (update.order) sortMode = update.order;
    if (Object.prototype.hasOwnProperty.call(update, 'firstParent')) firstParent = Boolean(update.firstParent);
    if (Object.prototype.hasOwnProperty.call(update, 'noMerges')) noMerges = Boolean(update.noMerges);
    collapsedGraphSeries.clear(); selectedGraphSeries = ''; hoveredGraphSeries = '';
    saveUiState({ sortMode, firstParent, noMerges, collapsedGraphSeries: [], selectedGraphSeries: '' });
    post('setLogOptions', { options: { order: sortMode, firstParent, noMerges } });
  }

  function collapseLinearBranches() {
    collapsedGraphSeries = new Set(currentGraphFragments.keys()); selectedGraphSeries = ''; hoveredGraphSeries = '';
    saveUiState({ collapsedGraphSeries: [...collapsedGraphSeries], selectedGraphSeries: '' }); renderCommitRows();
  }

  function expandLinearBranches() {
    collapsedGraphSeries.clear(); selectedGraphSeries = ''; hoveredGraphSeries = '';
    saveUiState({ collapsedGraphSeries: [], selectedGraphSeries: '' }); renderCommitRows();
  }

  function branchFilterItems() {
    const items = [{ icon: state.selectedRef ? '' : '✓', label: 'All Branches', run: () => { setBranchSelection([]); post('selectRef', {}); } }];
    for (const kind of ['local', 'remote', 'tag']) {
      const branches = (state.branches || []).filter(branch => branch.kind === kind);
      if (!branches.length) continue;
      items.push({ separator: true });
      for (const branch of branches) items.push({
        icon: state.selectedRef === branch.name ? '✓' : kind === 'local' ? '⑂' : kind === 'remote' ? '☁' : '◆',
        label: branch.name,
        run: () => { setBranchSelection([branch]); post('selectRef', { ref: branch.name }); },
      });
    }
    return items;
  }

  function userFilterItems() {
    const authors = [...new Set((state.commits || []).map(commit => commit.author).filter(Boolean))].sort((left, right) => left.localeCompare(right));
    return [
      { icon: authorFilter ? '' : '✓', label: 'All Users', run: () => setAuthorFilter('') },
      { separator: true },
      ...authors.map(author => ({ icon: authorFilter === author ? '✓' : '', label: author, run: () => setAuthorFilter(author) })),
    ];
  }

  function setAuthorFilter(author) {
    authorFilter = author; saveUiState({ authorFilter }); render();
  }

  function dateFilterItems() {
    return [
      ['all', 'All Dates'], ['today', 'Today'], ['week', 'Last 7 Days'], ['month', 'Last 30 Days'], ['year', 'Last Year'],
    ].map(([value, label]) => ({ icon: dateFilter === value ? '✓' : '', label, run: () => {
      dateFilter = value; saveUiState({ dateFilter }); render();
    } }));
  }

  function showPathFilterPopover(anchor) {
    closeContextMenu();
    const popover = node('form', 'filter-popover');
    popover.append(node('div', 'filter-popover-title', 'Show commits affecting this path'));
    const input = node('input'); input.type = 'text'; input.placeholder = 'src/path or file name'; input.value = state.filePath || '';
    const actions = node('div', 'filter-popover-actions');
    const clear = button('Clear', 'Clear path filter', () => { closeContextMenu(); post('setPathFilter', {}); }, 'action');
    clear.disabled = !state.filePath;
    const apply = button('Apply', 'Apply path filter', () => {}, 'primary'); apply.type = 'submit';
    actions.append(clear, apply); popover.append(input, actions);
    popover.addEventListener('submit', event => { event.preventDefault(); closeContextMenu(); post('setPathFilter', { path: input.value.trim() }); });
    document.body.append(popover); openMenu = popover;
    const bounds = anchor.getBoundingClientRect(); const popupBounds = popover.getBoundingClientRect();
    popover.style.left = Math.max(6, Math.min(bounds.left, window.innerWidth - popupBounds.width - 6)) + 'px';
    popover.style.top = Math.max(6, Math.min(bounds.bottom + 2, window.innerHeight - popupBounds.height - 6)) + 'px';
    input.focus(); input.select();
  }

  function compactPath(value) {
    if (value.length <= 24) return value;
    return '…/' + value.split('/').slice(-2).join('/');
  }

  function renderCommitRows(existing) {
    const list = existing || document.getElementById('commit-list'); if (!list) return;
    list.replaceChildren();
    const model = graphModel(filteredCommits()); const commits = model.commits; const graph = graphLayout(commits, model);
    currentGraphFragments = model.fragments;
    for (const id of [...collapsedGraphSeries]) if (!currentGraphFragments.has(id)) collapsedGraphSeries.delete(id);
    if (!commits.length) { list.append(node('div', 'empty', 'No matching commits')); return; }
    commits.forEach((commit, index) => {
      const selected = (pendingCommitHash || state.selection?.commit.hash) === commit.hash;
      const row = node('div', 'commit-row' + (selected ? ' selected' : '')); row.dataset.hash = commit.hash;
      row.tabIndex = 0; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(selected));
      const subject = node('div', 'subject-cell'); const canvas = node('canvas', 'graph-interactive'); canvas.width = 144; canvas.height = 54; canvas.dataset.graph = JSON.stringify(graph[index]); canvas.title = 'Click a graph line to collapse or expand its branch series'; attachGraphInteraction(canvas); subject.append(canvas);
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
      attachContextMenu(row, () => {
        const parent = commit.parents?.[0];
        const child = (state.commits || []).find(item => (item.parents || []).includes(commit.hash));
        select();
        return [
          { icon: '⧉', label: 'Copy Revision Number', run: () => post('contextAction', { action: 'copyRevision', hash: commit.hash }) },
          { icon: '+', label: 'Create Patch…', run: () => post('contextAction', { action: 'createPatch', hash: commit.hash }) },
          { icon: '⌘', label: 'Cherry-Pick', run: () => post('cherryPick', { hash: commit.hash }) },
          { separator: true },
          { icon: '⑂', label: 'Checkout Revision…', run: () => post('contextAction', { action: 'checkoutRevision', hash: commit.hash }) },
          { icon: '↔', label: 'Compare with Local', run: () => post('contextAction', { action: 'compareWithLocal', hash: commit.hash }) },
          { separator: true },
          { icon: '↶', label: 'Reset Current Branch to Here…', run: () => post('reset', { hash: commit.hash }) },
          { icon: '↩', label: 'Revert Commit', run: () => post('revert', { hash: commit.hash }) },
          { icon: '+', label: 'New Branch…', run: () => post('newBranch', { hash: commit.hash }) },
          { icon: '◆', label: 'New Tag…', run: () => post('contextAction', { action: 'createTag', hash: commit.hash }) },
          { separator: true },
          { icon: '↑', label: 'Go to Child Commit', disabled: !child, run: () => child && selectCommitByHash(child.hash) },
          { icon: '↓', label: 'Go to Parent Commit', disabled: !parent, run: () => parent && selectCommitByHash(parent) },
        ];
      });
      list.append(row);
    });
    requestAnimationFrame(drawGraphs);
  }

  function selectCommitByHash(hash) {
    const row = document.querySelector('.commit-row[data-hash="' + CSS.escape(hash) + '"]');
    if (row) { row.click(); row.scrollIntoView({ block: 'nearest' }); }
  }

  function filteredCommits() {
    let commits = [...(state.commits || [])];
    if (search) commits = commits.filter(c => (c.subject + '\n' + c.body + '\n' + c.author + '\n' + c.email + '\n' + c.hash + '\n' + (c.refs || []).join(' ')).toLowerCase().includes(search));
    if (authorFilter) commits = commits.filter(commit => commit.author === authorFilter);
    if (dateFilter !== 'all') {
      const now = new Date(); let cutoff;
      if (dateFilter === 'today') cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      else cutoff = new Date(now.getTime() - ({ week: 7, month: 30, year: 365 }[dateFilter] || 0) * 86400000);
      commits = commits.filter(commit => new Date(commit.authoredAt) >= cutoff);
    }
    return commits;
  }

  function detailsPane() {
    const pane = node('aside', 'pane details'); pane.id = 'details-pane'; const selection = state.selection;
    if (!selection) { pane.append(node('div', 'empty', 'Select a commit to view details')); return pane; }
    const commit = selection.commit; const details = node('div', 'commit-details');
    details.id = 'commit-details';
    details.append(node('div', 'detail-subject', commit.subject || '(no subject)'));
    const meta = node('div', 'detail-meta');
    for (const [key, value] of [['Author', commit.author + ' <' + commit.email + '>'], ['Date', new Date(commit.authoredAt).toLocaleString()], ['Commit', commit.hash], ['Parents', (commit.parents || []).map(p => p.slice(0, 10)).join(', ') || '—']]) { meta.append(node('span', '', key), node('strong', '', value)); }
    details.append(meta); if (commit.body && commit.body !== commit.subject) details.append(node('div', 'detail-body', commit.body));
    const files = node('div', 'files'); files.id = 'changed-files'; files.setAttribute('role', 'tree');
    files.append(node('div', 'pane-title', 'Changed Files (' + selection.files.length + ')'));
    const tree = node('div', 'file-tree-root'); tree.append(fileTree(selection.files, commit)); files.append(tree);
    const splitter = node('div', 'detail-splitter'); splitter.tabIndex = 0; splitter.setAttribute('role', 'separator'); splitter.setAttribute('aria-orientation', 'horizontal'); splitter.title = 'Drag to resize commit message';
    setupDetailSplitter(pane, splitter);
    pane.append(files, splitter, details);
    requestAnimationFrame(() => setMessagePaneHeight(pane, Number(uiState.messagePaneHeight) || 160, false));
    return pane;
  }

  function fileTree(files, commit) {
    const root = { path: '', directories: new Map(), files: [] };
    for (const file of files) {
      const parts = file.path.split('/'); let current = root; let currentPath = '';
      for (const part of parts.slice(0, -1)) {
        currentPath = currentPath ? currentPath + '/' + part : part;
        if (!current.directories.has(part)) current.directories.set(part, { name: part, path: currentPath, directories: new Map(), files: [] });
        current = current.directories.get(part);
      }
      current.files.push(file);
    }
    const container = node('div');
    for (const directory of root.directories.values()) container.append(renderDirectory(directory, 0, commit));
    for (const file of root.files) container.append(commitFileRow(file, 0, commit));
    return container;
  }

  function renderDirectory(directory, depth, commit) {
    const section = node('section');
    const collapsed = new Set(uiState.collapsedFileFolders || []).has(directory.path);
    const row = node('div', 'tree-row'); row.style.paddingLeft = (8 + depth * 16) + 'px'; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-expanded', String(!collapsed));
    const count = countTreeFiles(directory);
    const twisty = node('span', 'tree-twisty', collapsed ? '›' : '⌄');
    row.append(twisty, node('span', 'tree-folder', '▱ ' + directory.name), node('span', 'tree-count', count + (count === 1 ? ' file' : ' files')));
    const children = node('div'); children.hidden = collapsed;
    for (const child of directory.directories.values()) children.append(renderDirectory(child, depth + 1, commit));
    for (const file of directory.files) children.append(commitFileRow(file, depth + 1, commit));
    const toggle = () => {
      children.hidden = !children.hidden; twisty.textContent = children.hidden ? '›' : '⌄'; row.setAttribute('aria-expanded', String(!children.hidden));
      const collapsedFolders = new Set(uiState.collapsedFileFolders || []);
      if (children.hidden) collapsedFolders.add(directory.path); else collapsedFolders.delete(directory.path);
      saveUiState({ collapsedFileFolders: [...collapsedFolders] });
    };
    row.addEventListener('click', toggle); keyboardActivate(row, toggle); section.append(row, children); return section;
  }

  function countTreeFiles(directory) {
    let count = directory.files.length;
    for (const child of directory.directories.values()) count += countTreeFiles(child);
    return count;
  }

  function commitFileRow(file, depth, commit) {
    const selected = selectedFilePath === file.path;
    const row = node('div', 'file-row' + (selected ? ' selected' : '')); row.dataset.filePath = file.path; row.style.paddingLeft = (10 + depth * 16) + 'px';
    row.tabIndex = 0; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-selected', String(selected));
    row.title = file.originalPath ? file.originalPath + ' → ' + file.path : file.path;
    row.append(node('span', 'file-status', file.status[0]), node('span', 'file-path', file.path.split('/').pop()));
    const selectFile = () => {
      selectedFilePath = file.path;
      document.querySelectorAll('.file-row').forEach(item => {
        const active = item.dataset.filePath === selectedFilePath;
        item.classList.toggle('selected', active); item.setAttribute('aria-selected', String(active));
      });
    };
    row.addEventListener('click', selectFile); keyboardActivate(row, selectFile);
    row.addEventListener('dblclick', () => post('openCommitFile', { hash: commit.hash, path: file.path }));
    attachContextMenu(row, () => {
      selectFile();
      return [
        { icon: '↔', label: 'Show Diff', run: () => post('contextAction', { action: 'showFileDiff', hash: commit.hash, path: file.path }) },
        { icon: '⇄', label: 'Compare with Local', run: () => post('contextAction', { action: 'compareFileWithLocal', hash: commit.hash, path: file.path }) },
        { icon: '□', label: 'Open Repository Version', run: () => post('contextAction', { action: 'openRepositoryFile', hash: commit.hash, path: file.path }) },
        { separator: true },
        { icon: '+', label: 'Create Patch…', run: () => post('contextAction', { action: 'createFilePatch', hash: commit.hash, path: file.path }) },
        { icon: '↓', label: 'Get from Revision…', disabled: file.status.startsWith('D'), run: () => post('contextAction', { action: 'restoreFile', hash: commit.hash, path: file.path }) },
        { icon: '◷', label: 'History Up to Here', run: () => post('contextAction', { action: 'fileHistory', hash: commit.hash, path: file.path }) },
        { separator: true },
        { icon: '⧉', label: 'Copy Path', run: () => post('contextAction', { action: 'copyPath', hash: commit.hash, path: file.path }) },
      ];
    });
    return row;
  }

  function setupDetailSplitter(pane, splitter) {
    const resize = event => {
      const bounds = pane.getBoundingClientRect();
      setMessagePaneHeight(pane, bounds.bottom - event.clientY, false);
    };
    splitter.addEventListener('mousedown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); splitter.focus(); splitter.classList.add('dragging'); resize(event);
      const move = moveEvent => resize(moveEvent);
      const finish = () => {
        window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', finish);
        splitter.classList.remove('dragging');
        saveUiState({ messagePaneHeight: parseFloat(getComputedStyle(pane).getPropertyValue('--message-height')) });
      };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', finish);
    });
    splitter.addEventListener('dblclick', () => setMessagePaneHeight(pane, 160, true));
    splitter.addEventListener('keydown', event => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault(); const current = parseFloat(getComputedStyle(pane).getPropertyValue('--message-height')) || 160;
      setMessagePaneHeight(pane, current + (event.key === 'ArrowUp' ? 16 : -16), true);
    });
    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(() => {
        if (!pane.isConnected) { observer.disconnect(); return; }
        const current = parseFloat(getComputedStyle(pane).getPropertyValue('--message-height')) || 160;
        setMessagePaneHeight(pane, current, false);
      });
      observer.observe(pane);
    }
  }

  function setMessagePaneHeight(pane, requested, persist) {
    const maximum = Math.max(80, pane.clientHeight - 80);
    const height = Math.max(80, Math.min(requested, maximum)); pane.style.setProperty('--message-height', height + 'px');
    const splitter = pane.querySelector('.detail-splitter');
    if (splitter) { splitter.setAttribute('aria-valuemin', '80'); splitter.setAttribute('aria-valuemax', String(maximum)); splitter.setAttribute('aria-valuenow', String(Math.round(height))); }
    if (persist) saveUiState({ messagePaneHeight: height });
  }

  const graphEdgeKey = (child, parent) => child + '>' + parent;

  function graphModel(commits) {
    const byHash = new Map(commits.map(commit => [commit.hash, commit]));
    const parents = new Map(); const children = new Map(commits.map(commit => [commit.hash, []]));
    for (const commit of commits) {
      const visibleParents = (commit.parents || []).filter(hash => byHash.has(hash)); parents.set(commit.hash, visibleParents);
      for (const parent of visibleParents) children.get(parent).push(commit.hash);
    }
    const isLinearMiddle = hash => {
      const commit = byHash.get(hash);
      return Boolean(commit) && (parents.get(hash) || []).length === 1 && (children.get(hash) || []).length === 1 && !(commit.refs || []).length;
    };
    const fragments = new Map(); const seriesByEdge = new Map();
    for (const commit of commits) {
      if (isLinearMiddle(commit.hash)) continue;
      for (const firstParentHash of parents.get(commit.hash) || []) {
        const edges = []; const middle = []; let childHash = commit.hash; let parentHash = firstParentHash;
        while (parentHash) {
          edges.push(graphEdgeKey(childHash, parentHash));
          if (!isLinearMiddle(parentHash)) break;
          middle.push(parentHash); childHash = parentHash; parentHash = (parents.get(parentHash) || [])[0];
        }
        const bottomHash = parentHash || childHash; const id = graphEdgeKey(commit.hash, bottomHash);
        for (const edge of edges) seriesByEdge.set(edge, id);
        if (middle.length >= 2) fragments.set(id, { id, topHash: commit.hash, firstParentHash, bottomHash, middle });
      }
    }
    const hidden = new Set(); const replacements = new Map(); const dottedEdges = new Set();
    for (const id of collapsedGraphSeries) {
      const fragment = fragments.get(id); if (!fragment) continue;
      for (const hash of fragment.middle) hidden.add(hash);
      replacements.set(graphEdgeKey(fragment.topHash, fragment.firstParentHash), fragment.bottomHash);
      const replacementEdge = graphEdgeKey(fragment.topHash, fragment.bottomHash);
      seriesByEdge.set(replacementEdge, id); dottedEdges.add(replacementEdge);
    }
    const visibleCommits = commits.filter(commit => !hidden.has(commit.hash)); const visibleHashes = new Set(visibleCommits.map(commit => commit.hash));
    const displayParents = new Map();
    for (const commit of visibleCommits) {
      displayParents.set(commit.hash, (parents.get(commit.hash) || []).map(parent => replacements.get(graphEdgeKey(commit.hash, parent)) || parent).filter(parent => visibleHashes.has(parent)));
    }
    return { commits: visibleCommits, parents: displayParents, fragments, seriesByEdge, dottedEdges };
  }

  function graphLayout(commits, model) {
    const positions = new Map(commits.map((commit, index) => [commit.hash, index])); const lanes = [];
    return commits.map((commit, index) => {
      for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
        const target = lanes[laneIndex]; const targetPosition = target && positions.get(target.hash);
        if (target && target.hash !== commit.hash && (targetPosition === undefined || targetPosition < index)) lanes[laneIndex] = null;
      }
      let lane = lanes.findIndex(target => target?.hash === commit.hash);
      const commitParents = model.parents.get(commit.hash) || [];
      if (lane < 0) {
        lane = lanes.findIndex(target => !target); if (lane < 0) lane = lanes.length;
        const firstSeries = commitParents[0] ? model.seriesByEdge.get(graphEdgeKey(commit.hash, commitParents[0])) : commit.hash;
        lanes[lane] = { hash: commit.hash, seriesId: firstSeries || commit.hash, dotted: false };
      }
      const incoming = lanes.map(target => target ? { seriesId: target.seriesId, dotted: target.dotted } : null);
      const connections = []; const occupied = new Set();
      commitParents.forEach((parent, parentIndex) => {
        const edge = graphEdgeKey(commit.hash, parent); const seriesId = model.seriesByEdge.get(edge) || edge; const dotted = model.dottedEdges.has(edge);
        let targetLane = lanes.findIndex((target, candidate) => candidate !== lane && target?.hash === parent);
        if (parentIndex === 0 && targetLane < 0) {
          targetLane = lane; lanes[lane] = { hash: parent, seriesId, dotted };
        } else {
          if (targetLane < 0) {
            targetLane = lanes.findIndex((target, candidate) => candidate !== lane && !target && !occupied.has(candidate));
            if (targetLane < 0) targetLane = lanes.length;
            lanes[targetLane] = { hash: parent, seriesId, dotted };
          }
          connections.push({ from: lane, to: targetLane, seriesId, dotted });
          if (parentIndex === 0) lanes[lane] = null;
        }
        occupied.add(targetLane);
      });
      if (!commitParents.length) lanes[lane] = null;
      for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
        const target = lanes[laneIndex]; const targetPosition = target && positions.get(target.hash);
        if (target && (targetPosition === undefined || targetPosition <= index)) lanes[laneIndex] = null;
      }
      while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
      const outgoing = lanes.map(target => target ? { seriesId: target.seriesId, dotted: target.dotted } : null);
      const nodeSeriesId = outgoing[lane]?.seriesId || incoming[lane]?.seriesId || connections[0]?.seriesId || commit.hash;
      return { lane, incoming, outgoing, connections, nodeSeriesId };
    });
  }

  function graphColor(seriesId) {
    let hash = 0; for (let index = 0; index < seriesId.length; index++) hash = ((hash << 5) - hash + seriesId.charCodeAt(index)) | 0;
    return colors[Math.abs(hash) % colors.length];
  }

  function graphSegments(graph) {
    const scale = 2; const x = lane => 8 * scale + lane * 12 * scale; const mid = 13.5 * scale; const bottom = 27 * scale; const segments = [];
    graph.incoming.forEach((line, lane) => { if (line) segments.push({ x1: x(lane), y1: 0, x2: x(lane), y2: mid, ...line }); });
    graph.outgoing.forEach((line, lane) => { if (line) segments.push({ x1: x(lane), y1: mid, x2: x(lane), y2: bottom, ...line }); });
    graph.connections.forEach(line => segments.push({ x1: x(line.from), y1: mid, x2: x(line.to), y2: bottom, seriesId: line.seriesId, dotted: line.dotted }));
    return segments;
  }

  function drawGraphs() {
    const activeSeries = hoveredGraphSeries || selectedGraphSeries;
    document.querySelectorAll('canvas[data-graph]').forEach(canvas => {
      const graph = JSON.parse(canvas.dataset.graph); const ctx = canvas.getContext('2d'); const scale = 2; const x = lane => 8 * scale + lane * 12 * scale; const mid = 13.5 * scale;
      ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.lineCap = 'round';
      for (const segment of graphSegments(graph)) {
        ctx.globalAlpha = activeSeries && segment.seriesId !== activeSeries ? .2 : 1;
        ctx.lineWidth = (segment.seriesId === activeSeries ? 2.6 : 1.5) * scale; ctx.strokeStyle = graphColor(segment.seriesId);
        ctx.setLineDash(segment.dotted ? [3 * scale, 3 * scale] : []); ctx.beginPath(); ctx.moveTo(segment.x1, segment.y1); ctx.lineTo(segment.x2, segment.y2); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.globalAlpha = activeSeries && graph.nodeSeriesId !== activeSeries ? .25 : 1;
      ctx.fillStyle = graphColor(graph.nodeSeriesId); ctx.beginPath(); ctx.arc(x(graph.lane), mid, (graph.nodeSeriesId === activeSeries ? 4.8 : 4) * scale, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = getComputedStyle(document.body).backgroundColor; ctx.lineWidth = 1.3 * scale; ctx.stroke(); ctx.globalAlpha = 1;
    });
  }

  function graphSeriesAt(canvas, event) {
    const graph = JSON.parse(canvas.dataset.graph); const bounds = canvas.getBoundingClientRect();
    const point = { x: (event.clientX - bounds.left) * canvas.width / bounds.width, y: (event.clientY - bounds.top) * canvas.height / bounds.height };
    let selected = ''; let nearest = 12;
    for (const segment of graphSegments(graph)) {
      const distance = pointToSegmentDistance(point.x, point.y, segment.x1, segment.y1, segment.x2, segment.y2);
      if (distance < nearest) { nearest = distance; selected = segment.seriesId; }
    }
    const nodeX = 16 + graph.lane * 24; const nodeDistance = Math.hypot(point.x - nodeX, point.y - 27);
    if (nodeDistance < nearest) selected = graph.nodeSeriesId;
    return selected;
  }

  function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1; const dy = y2 - y1; const length = dx * dx + dy * dy;
    const ratio = length ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / length)) : 0;
    return Math.hypot(px - (x1 + ratio * dx), py - (y1 + ratio * dy));
  }

  function attachGraphInteraction(canvas) {
    canvas.addEventListener('mousemove', event => {
      const series = graphSeriesAt(canvas, event); canvas.style.cursor = series ? 'pointer' : 'default';
      if (series !== hoveredGraphSeries) { hoveredGraphSeries = series; drawGraphs(); }
    });
    canvas.addEventListener('mouseleave', () => { if (hoveredGraphSeries) { hoveredGraphSeries = ''; drawGraphs(); } });
    canvas.addEventListener('click', event => {
      const series = graphSeriesAt(canvas, event); if (!series) return;
      event.preventDefault(); event.stopPropagation(); selectedGraphSeries = series;
      if (currentGraphFragments.has(series)) {
        if (collapsedGraphSeries.has(series)) collapsedGraphSeries.delete(series); else collapsedGraphSeries.add(series);
        hoveredGraphSeries = ''; saveUiState({ collapsedGraphSeries: [...collapsedGraphSeries], selectedGraphSeries }); renderCommitRows();
      } else {
        saveUiState({ selectedGraphSeries }); drawGraphs();
      }
    });
  }

  const shortRef = ref => ref.replace(/^HEAD -> /, '').replace(/^tag: /, '');
  const formatDate = value => { const date = new Date(value); const now = new Date(); return date.toDateString() === now.toDateString() ? date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : date.toLocaleDateString(); };
  function updateSelectionWithoutRerender() {
    const selectedHash = state.selection?.commit.hash;
    document.querySelectorAll('.commit-row').forEach(item => {
      const active = item.dataset.hash === selectedHash;
      item.classList.toggle('selected', active); item.setAttribute('aria-selected', String(active));
    });
    const current = document.getElementById('details-pane');
    if (current) current.replaceWith(detailsPane());
  }

  window.addEventListener('message', event => {
    if (event.data.type === 'state') {
      state = event.data.state; pendingCommitHash = undefined;
      if (state.logOptions) {
        sortMode = state.logOptions.order === 'topological' ? 'topological' : 'date';
        firstParent = Boolean(state.logOptions.firstParent); noMerges = Boolean(state.logOptions.noMerges);
        saveUiState({ sortMode, firstParent, noMerges });
      }
      const liveBranchKeys = new Set((state.branches || []).map(branchKey));
      selectedBranchKeys = new Set([...selectedBranchKeys].filter(key => liveBranchKeys.has(key)));
      if (!selectedBranchKeys.size && state.selectedRef) {
        const selectedRefBranch = (state.branches || []).find(branch => branch.name === state.selectedRef);
        if (selectedRefBranch) selectedBranchKeys.add(branchKey(selectedRefBranch));
      }
      saveUiState({ selectedBranchKeys: [...selectedBranchKeys] });
      if (state.selection && !(state.selection.files || []).some(file => file.path === selectedFilePath)) selectedFilePath = state.selection.files[0]?.path;
      render();
    }
    if (event.data.type === 'selection') {
      state.selection = event.data.selection; pendingCommitHash = undefined;
      if (!(state.selection.files || []).some(file => file.path === selectedFilePath)) selectedFilePath = state.selection.files[0]?.path;
      updateSelectionWithoutRerender();
    }
    if (event.data.type === 'trace') { state.traces = [...(state.traces || []), event.data.trace].slice(-400); if (activeToolTab === 'console') render(); }
    if (event.data.type === 'activateTab') { selectToolTab(event.data.tab); }
    if (event.data.type === 'committed') { saveUiState({ commitMessage: '' }); render(); }
    if (event.data.type === 'error') { const error = node('div', 'error', event.data.message); app.prepend(error); }
  });
  document.addEventListener('pointerdown', event => { if (openMenu && !openMenu.contains(event.target)) closeContextMenu(); });
  document.addEventListener('wheel', event => { if (openMenu && !openMenu.contains(event.target)) closeContextMenu(); }, { capture: true, passive: true });
  document.addEventListener('touchmove', event => { if (openMenu && !openMenu.contains(event.target)) closeContextMenu(); }, { capture: true, passive: true });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeContextMenu(); });
  post('ready', { logOptions: { order: sortMode, firstParent, noMerges } }); render();
`;

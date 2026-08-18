import * as path from "node:path";
import * as vscode from "vscode";
import { GitCommandError, GitRunner } from "./git/runner";
import { BranchNode, RepositoryNode, RepositoryTreeProvider } from "./views/repositoryTree";
import { ChangeNode, ChangesTreeProvider, HunkNode } from "./views/changesTree";
import { DiffContentProvider, openChangeDiff } from "./views/diffProvider";
import { CommitNode, HistoryTreeProvider } from "./views/historyTree";
import { ChangelistChangeNode, ChangelistNode, ChangelistTreeProvider } from "./views/changelistTree";
import { ChangelistStore } from "./changelists/store";
import { ShelfStore } from "./shelves/store";
import { ShelfNode, ShelfTreeProvider } from "./views/shelfTree";
import { WorktreeNode, WorktreeTreeProvider } from "./views/worktreeTree";
import { RemoteNode, RemoteTreeProvider } from "./views/remoteTree";
import { StashNode, StashTreeProvider } from "./views/stashTree";
import { SubmoduleNode, SubmoduleTreeProvider } from "./views/submoduleTree";
import { RepositoryManager } from "./repositoryManager";

function workspacePaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

function configurationGitPath(): string {
  return vscode.workspace.getConfiguration("jbGit").get<string>("gitPath", "git");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function requireTrustedWorkspace(): Promise<boolean> {
  if (vscode.workspace.isTrusted) return true;
  await vscode.window.showWarningMessage("JB Git mutations are disabled until this workspace is trusted.");
  return false;
}

async function runWithNotification<T>(title: string, task: () => Promise<T>): Promise<T | undefined> {
  try {
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: false },
      task,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(message);
    return undefined;
  }
}

async function runWithNotificationResult(title: string, task: () => Promise<void>): Promise<boolean> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: false },
      task,
    );
    return true;
  } catch (error) {
    await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    return false;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const runner = new GitRunner(configurationGitPath());
  const manager = new RepositoryManager(runner, workspacePaths);
  const changelistStore = new ChangelistStore(context.workspaceState);
  await changelistStore.load();
  const shelfStore = new ShelfStore(context.globalStorageUri.fsPath);
  const repositories = new RepositoryTreeProvider(manager);
  const changes = new ChangesTreeProvider(manager);
  const diffProvider = new DiffContentProvider();
  const history = new HistoryTreeProvider(manager);
  const changelists = new ChangelistTreeProvider(manager, changelistStore);
  const shelves = new ShelfTreeProvider(manager, shelfStore);
  const worktrees = new WorktreeTreeProvider(manager);
  const remotes = new RemoteTreeProvider(manager);
  const stashes = new StashTreeProvider(manager);
  const submodules = new SubmoduleTreeProvider(manager);
  const repositoryView = vscode.window.createTreeView("jbGit.repositories", { treeDataProvider: repositories, showCollapseAll: true });
  const changesView = vscode.window.createTreeView("jbGit.changes", { treeDataProvider: changes, showCollapseAll: true });
  const historyView = vscode.window.createTreeView("jbGit.history", { treeDataProvider: history, showCollapseAll: true });
  const changelistsView = vscode.window.createTreeView("jbGit.changelists", { treeDataProvider: changelists, showCollapseAll: true });
  const shelvesView = vscode.window.createTreeView("jbGit.shelves", { treeDataProvider: shelves, showCollapseAll: true });
  const worktreesView = vscode.window.createTreeView("jbGit.worktrees", { treeDataProvider: worktrees, showCollapseAll: true });
  const remotesView = vscode.window.createTreeView("jbGit.remotes", { treeDataProvider: remotes, showCollapseAll: true });
  const stashesView = vscode.window.createTreeView("jbGit.stashes", { treeDataProvider: stashes, showCollapseAll: true });
  const submodulesView = vscode.window.createTreeView("jbGit.submodules", { treeDataProvider: submodules, showCollapseAll: true });
  const branchStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  const outputChannel = vscode.window.createOutputChannel("JB Git");
  const showOutput = (title: string, content: string): void => {
    outputChannel.clear();
    outputChannel.appendLine(`# ${title}`);
    outputChannel.appendLine("");
    outputChannel.append(content);
    outputChannel.show(true);
  };
  branchStatus.command = "jbGit.openChanges";
  branchStatus.tooltip = "Open JB Git Local Changes";

  const updateStatusBar = (): void => {
    const first = manager.all[0];
    if (!first?.status) {
      branchStatus.hide();
      return;
    }
    const branch = first.status.branch.head ?? "detached";
    const counts = first.status.changes.length;
    const tracking = first.status.branch.upstream
      ? ` ↑${first.status.branch.ahead} ↓${first.status.branch.behind}`
      : "";
    branchStatus.text = `$(git-branch) ${branch}${tracking}${counts ? ` · ${counts}` : ""}`;
    branchStatus.show();
  };

  const refresh = async (): Promise<void> => {
    await runWithNotification("Refreshing Git repositories", () => manager.discoverAndRefresh());
    updateStatusBar();
  };

  const pendingRefreshRoots = new Set<string>();
  let refreshTimer: NodeJS.Timeout | undefined;
  const scheduleRefreshForPath = (filePath: string): void => {
    if (!vscode.workspace.getConfiguration("jbGit").get<boolean>("autoRefresh", true)) return;
    const snapshot = manager.all.find((item) => isInside(item.repository.info.rootPath, filePath));
    if (!snapshot) return;
    pendingRefreshRoots.add(snapshot.repository.info.rootPath);
    if (refreshTimer) clearTimeout(refreshTimer);
    const delay = vscode.workspace.getConfiguration("jbGit").get<number>("refreshDebounceMs", 250);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      const roots = [...pendingRefreshRoots];
      pendingRefreshRoots.clear();
      void Promise.all(roots.map((root) => manager.refresh(root))).then(updateStatusBar);
    }, delay);
  };
  const gitMetadataWatcher = vscode.workspace.createFileSystemWatcher("**/.git/**");

  const pickRepository = async (rootPath?: string) => {
    if (rootPath) return manager.snapshot(rootPath);
    if (manager.all.length <= 1) return manager.all[0];
    return (await vscode.window.showQuickPick(
      manager.all.map((snapshot) => ({
        label: path.basename(snapshot.repository.info.rootPath),
        description: snapshot.repository.info.rootPath,
        snapshot,
      })),
      { placeHolder: "Select a Git repository" },
    ))?.snapshot;
  };

  context.subscriptions.push(
    manager,
    changelistStore,
    shelfStore,
    repositories,
    changes,
    history,
    changelists,
    shelves,
    worktrees,
    remotes,
    stashes,
    submodules,
    repositoryView,
    changesView,
    historyView,
    changelistsView,
    shelvesView,
    worktreesView,
    remotesView,
    stashesView,
    submodulesView,
    diffProvider,
    gitMetadataWatcher,
    { dispose: () => { if (refreshTimer) clearTimeout(refreshTimer); } },
    vscode.workspace.registerTextDocumentContentProvider("jb-git-diff", diffProvider),
    branchStatus,
    outputChannel,
    manager.onDidChange(updateStatusBar),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refresh()),
    vscode.workspace.onDidSaveTextDocument((document) => scheduleRefreshForPath(document.uri.fsPath)),
    vscode.workspace.onDidCreateFiles((event) => event.files.forEach((uri) => scheduleRefreshForPath(uri.fsPath))),
    vscode.workspace.onDidDeleteFiles((event) => event.files.forEach((uri) => scheduleRefreshForPath(uri.fsPath))),
    vscode.workspace.onDidRenameFiles((event) => event.files.forEach((file) => { scheduleRefreshForPath(file.oldUri.fsPath); scheduleRefreshForPath(file.newUri.fsPath); })),
    gitMetadataWatcher.onDidChange((uri) => scheduleRefreshForPath(uri.fsPath)),
    gitMetadataWatcher.onDidCreate((uri) => scheduleRefreshForPath(uri.fsPath)),
    gitMetadataWatcher.onDidDelete((uri) => scheduleRefreshForPath(uri.fsPath)),
    vscode.commands.registerCommand("jbGit.refresh", refresh),
    vscode.commands.registerCommand("jbGit.openChanges", () => vscode.commands.executeCommand("workbench.view.extension.jbGit")),
    vscode.commands.registerCommand("jbGit.openDiff", async (node?: ChangeNode) => {
      if (!node) return;
      await runWithNotification(`Loading diff for ${node.change.path}`, () => openChangeDiff(manager, diffProvider, node));
    }),
    vscode.commands.registerCommand("jbGit.showHistory", () => vscode.commands.executeCommand("workbench.view.extension.jbGit")),
    vscode.commands.registerCommand("jbGit.fileHistory", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== "file") return void vscode.window.showInformationMessage("Open a file before showing its Git history.");
      const filePath = editor.document.uri.fsPath;
      const snapshot = manager.all.find((item) => isInside(item.repository.info.rootPath, filePath));
      if (!snapshot) return void vscode.window.showInformationMessage("The active file is not inside a discovered Git repository.");
      const relativePath = path.relative(snapshot.repository.info.rootPath, filePath);
      const commits = await runWithNotification(`Loading history for ${relativePath}`, () => snapshot.repository.log(100, relativePath));
      if (!commits) return;
      showOutput(`File History · ${relativePath}`, commits.map((commit) => `${commit.hash.slice(0, 12)}  ${commit.authoredAt.slice(0, 10)}  ${commit.author}  ${commit.subject}`).join("\n"));
    }),
    vscode.commands.registerCommand("jbGit.showCommit", async (node?: CommitNode) => {
      if (!node) return;
      const snapshot = manager.snapshot(node.repositoryRoot);
      if (!snapshot) return;
      const output = await runWithNotification(`Loading commit ${node.commit.hash.slice(0, 12)}`, () => snapshot.repository.showCommit(node.commit.hash));
      if (output === undefined) return;
      showOutput(`Commit ${node.commit.hash.slice(0, 12)}`, output);
    }),
    vscode.commands.registerCommand("jbGit.blame", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== "file") {
        await vscode.window.showInformationMessage("Open a file in the editor before running JB Git Blame.");
        return;
      }
      const filePath = editor.document.uri.fsPath;
      const snapshot = manager.all.find((item) => isInside(item.repository.info.rootPath, filePath));
      if (!snapshot) {
        await vscode.window.showInformationMessage("The active file is not inside a discovered Git repository.");
        return;
      }
      const relativePath = path.relative(snapshot.repository.info.rootPath, filePath);
      const entries = await runWithNotification(`Blaming ${relativePath}`, () => manager.blame(snapshot.repository.info.rootPath, relativePath));
      if (!entries) return;
      showOutput(`Blame · ${relativePath}`, entries.map((entry) => `${String(entry.finalLine).padStart(5)} ${entry.hash.slice(0, 12)} ${entry.author} ${entry.authorTime.slice(0, 10)}  ${entry.content}`).join("\n"));
    }),
    vscode.commands.registerCommand("jbGit.initializeRepository", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const root = workspacePaths()[0];
      if (!root) {
        await vscode.window.showInformationMessage("Open a folder before initializing a Git repository.");
        return;
      }
      const initialized = await runWithNotification("Initializing Git repository", () => manager.initializeRepository(root));
      if (initialized === false) await vscode.window.showInformationMessage("This folder is already inside a Git repository; no nested repository was created.");
    }),
    vscode.commands.registerCommand("jbGit.cloneRepository", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const source = await vscode.window.showInputBox({ prompt: "Repository URL or local path", placeHolder: "https://example.com/repository.git" });
      if (!source?.trim()) return;
      const destination = await vscode.window.showInputBox({ prompt: "Destination folder", placeHolder: "./repository" });
      if (!destination?.trim()) return;
      const mode = await vscode.window.showQuickPick(
        [{ label: "Standard clone", bare: false }, { label: "Bare clone", bare: true }],
        { placeHolder: "Clone type" },
      );
      if (!mode) return;
      const cloneRoot = workspacePaths()[0] ?? ".";
      const cloned = await runWithNotificationResult(`Cloning ${source.trim()}`, () => manager.clone(source.trim(), destination.trim(), mode.bare));
      if (cloned && !mode.bare) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(path.resolve(cloneRoot, destination.trim())), { forceNewWindow: false });
    }),
    vscode.commands.registerCommand("jbGit.fetch", async () => {
      if (!(await requireTrustedWorkspace())) return;
      await runWithNotification("Fetching Git remotes", () => manager.fetch());
    }),
    vscode.commands.registerCommand("jbGit.applyPatch", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const files = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false, openLabel: "Apply Patch" });
      const patchFile = files?.[0];
      if (!patchFile) return;
      await runWithNotification(`Applying ${path.basename(patchFile.fsPath)}`, () => manager.applyPatch(first.repository.info.rootPath, patchFile.fsPath));
    }),
    vscode.commands.registerCommand("jbGit.sparseCheckoutSet", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const input = await vscode.window.showInputBox({ prompt: "Sparse-checkout paths (comma-separated)", placeHolder: "src,docs" });
      if (!input?.trim()) return;
      const paths = input.split(",").map((item) => item.trim()).filter(Boolean);
      await runWithNotification("Configuring sparse checkout", () => manager.sparseCheckoutSet(first.repository.info.rootPath, paths));
    }),
    vscode.commands.registerCommand("jbGit.sparseCheckoutDisable", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const answer = await vscode.window.showWarningMessage("Disable sparse checkout and restore all files?", { modal: true }, "Disable");
      if (answer !== "Disable") return;
      await runWithNotification("Disabling sparse checkout", () => manager.sparseCheckoutDisable(first.repository.info.rootPath));
    }),
    vscode.commands.registerCommand("jbGit.lfsPull", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      await runWithNotification("Pulling Git LFS objects", () => manager.lfsPull(first.repository.info.rootPath));
    }),
    vscode.commands.registerCommand("jbGit.commit", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return void vscode.window.showInformationMessage("No Git repository was found in this workspace.");
      const message = await vscode.window.showInputBox({ prompt: "Commit message", placeHolder: "Describe the staged changes" });
      if (!message?.trim()) return;
      const mode = await vscode.window.showQuickPick(
        [
          { label: "Commit", description: "Create a new commit" },
          { label: "Amend", description: "Amend the current HEAD commit" },
          { label: "Sign-off", description: "Create a signed-off commit" },
          { label: "Amend and sign-off", description: "Amend HEAD and add a sign-off trailer" },
          { label: "Commit without hooks", description: "Skip client-side commit hooks" },
        ],
        { placeHolder: "Choose commit mode" },
      );
      if (!mode) return;
      const amend = mode.label.includes("Amend");
      const signoff = mode.label.includes("sign-off");
      const noVerify = mode.label.includes("without hooks");
      const revision = await runWithNotification("Creating Git commit", () => manager.commit(first.repository.info.rootPath, message, { amend, signoff, noVerify }));
      if (revision) await vscode.window.showInformationMessage(`Created commit ${revision.slice(0, 12)}`);
    }),
    vscode.commands.registerCommand("jbGit.pull", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const strategy = await vscode.window.showQuickPick(
        [
          { label: "Merge", value: "merge" as const },
          { label: "Rebase", value: "rebase" as const },
          { label: "Fast-forward only", value: "ff-only" as const },
        ],
        { placeHolder: "Choose pull strategy" },
      );
      if (!strategy) return;
      await runWithNotification(`Pulling with ${strategy.label}`, () => manager.pull(first.repository.info.rootPath, strategy.value));
    }),
    vscode.commands.registerCommand("jbGit.push", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const mode = await vscode.window.showQuickPick(
        [
          { label: "Push", force: false },
          { label: "Force with lease", force: true, description: "Safeguarded force push" },
        ],
        { placeHolder: "Choose push mode" },
      );
      if (!mode) return;
      if (mode.force) {
        const answer = await vscode.window.showWarningMessage("Force with lease can rewrite remote history. Continue?", { modal: true }, "Push");
        if (answer !== "Push") return;
      }
      await runWithNotification("Pushing Git commits", () => manager.push(first.repository.info.rootPath, mode.force));
    }),
    vscode.commands.registerCommand("jbGit.merge", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const current = first.status?.branch.head;
      const ref = await vscode.window.showQuickPick(
        first.branches.filter((branch) => (branch.kind === "local" || branch.kind === "remote") && branch.name !== current).map((branch) => branch.name),
        { placeHolder: "Select a branch or ref to merge" },
      );
      if (!ref) return;
      await runWithNotification(`Merging ${ref}`, () => manager.merge(first.repository.info.rootPath, ref));
    }),
    vscode.commands.registerCommand("jbGit.rebase", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const current = first.status?.branch.head;
      const ref = await vscode.window.showQuickPick(
        first.branches.filter((branch) => (branch.kind === "local" || branch.kind === "remote") && branch.name !== current).map((branch) => branch.name),
        { placeHolder: "Select a branch or ref to rebase onto" },
      );
      if (!ref) return;
      await runWithNotification(`Rebasing onto ${ref}`, () => manager.rebase(first.repository.info.rootPath, ref));
    }),
    vscode.commands.registerCommand("jbGit.cherryPick", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const hash = await vscode.window.showInputBox({ prompt: "Commit hash or ref to cherry-pick" });
      if (!hash?.trim()) return;
      await runWithNotification(`Cherry-picking ${hash.trim()}`, () => manager.cherryPick(first.repository.info.rootPath, hash.trim()));
    }),
    vscode.commands.registerCommand("jbGit.revert", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const hash = await vscode.window.showInputBox({ prompt: "Commit hash or ref to revert" });
      if (!hash?.trim()) return;
      const answer = await vscode.window.showWarningMessage(`Revert ${hash.trim()}?`, { modal: true }, "Revert");
      if (answer !== "Revert") return;
      await runWithNotification(`Reverting ${hash.trim()}`, () => manager.revert(first.repository.info.rootPath, hash.trim()));
    }),
    vscode.commands.registerCommand("jbGit.reset", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const ref = await vscode.window.showInputBox({ prompt: "Revision to reset to", value: "HEAD" });
      if (!ref?.trim()) return;
      const mode = await vscode.window.showQuickPick(
        [
          { label: "Soft", value: "soft" as const, description: "Keep index and working tree" },
          { label: "Mixed", value: "mixed" as const, description: "Keep working tree, reset index" },
          { label: "Hard", value: "hard" as const, description: "Discard tracked working tree changes" },
        ],
        { placeHolder: "Choose reset mode" },
      );
      if (!mode) return;
      const answer = await vscode.window.showWarningMessage(`Reset ${mode.label.toLowerCase()} to ${ref.trim()}?`, { modal: true }, "Reset");
      if (answer !== "Reset") return;
      await runWithNotification(`Resetting to ${ref.trim()}`, () => manager.reset(first.repository.info.rootPath, ref.trim(), mode.value));
    }),
    vscode.commands.registerCommand("jbGit.continueOperation", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      const kind = first?.operation.kind;
      if (!first || !kind || kind === "none" || kind === "bisect" || kind === "sequencer") return;
      await runWithNotification(`Continuing ${kind}`, () => manager.continueOperation(first.repository.info.rootPath, kind));
    }),
    vscode.commands.registerCommand("jbGit.abortOperation", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      const kind = first?.operation.kind;
      if (!first || !kind || kind === "none" || kind === "bisect" || kind === "sequencer") return;
      const answer = await vscode.window.showWarningMessage(`Abort ${kind}?`, { modal: true }, "Abort");
      if (answer !== "Abort") return;
      await runWithNotification(`Aborting ${kind}`, () => manager.abortOperation(first.repository.info.rootPath, kind));
    }),
    vscode.commands.registerCommand("jbGit.skipOperation", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      const kind = first?.operation.kind;
      if (!first || (kind !== "rebase" && kind !== "cherry-pick")) return;
      await runWithNotification(`Skipping ${kind}`, () => manager.skipOperation(first.repository.info.rootPath, kind));
    }),
    vscode.commands.registerCommand("jbGit.bisectStart", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const bad = await vscode.window.showInputBox({ prompt: "Known bad revision", value: "HEAD" });
      if (!bad?.trim()) return;
      const good = await vscode.window.showInputBox({ prompt: "Known good revision" });
      if (!good?.trim()) return;
      await runWithNotification("Starting Git bisect", () => manager.bisectStart(first.repository.info.rootPath, bad.trim(), good.trim()));
    }),
    vscode.commands.registerCommand("jbGit.bisectGood", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const ref = await vscode.window.showInputBox({ prompt: "Good revision (or HEAD)", value: "HEAD" });
      if (!ref?.trim()) return;
      await runWithNotification("Marking revision good", () => manager.bisectGood(first.repository.info.rootPath, ref.trim()));
    }),
    vscode.commands.registerCommand("jbGit.bisectBad", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const ref = await vscode.window.showInputBox({ prompt: "Bad revision (or HEAD)", value: "HEAD" });
      if (!ref?.trim()) return;
      await runWithNotification("Marking revision bad", () => manager.bisectBad(first.repository.info.rootPath, ref.trim()));
    }),
    vscode.commands.registerCommand("jbGit.bisectSkip", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      await runWithNotification("Skipping Git bisect revision", () => manager.bisectSkip(first.repository.info.rootPath));
    }),
    vscode.commands.registerCommand("jbGit.bisectReset", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      await runWithNotification("Resetting Git bisect", () => manager.bisectReset(first.repository.info.rootPath));
    }),
    vscode.commands.registerCommand("jbGit.createBranch", async (node?: RepositoryNode | BranchNode) => {
      if (!(await requireTrustedWorkspace())) return;
      const snapshot = await pickRepository(node instanceof RepositoryNode ? node.snapshot.repository.info.rootPath : node?.repositoryRoot);
      if (!snapshot) return;
      const name = await vscode.window.showInputBox({ prompt: "New branch name", placeHolder: "feature/my-change" });
      if (!name?.trim()) return;
      const startPoint = node instanceof BranchNode ? node.branch.name : undefined;
      await runWithNotification(`Creating branch ${name}`, () => manager.createBranch(snapshot.repository.info.rootPath, name.trim(), startPoint));
    }),
    vscode.commands.registerCommand("jbGit.renameBranch", async (node?: BranchNode) => {
      if (!(await requireTrustedWorkspace())) return;
      const snapshot = await pickRepository(node?.repositoryRoot);
      const current = node?.branch.kind === "local" ? node.branch.name : snapshot?.status?.branch.head;
      if (!snapshot || !current) return void vscode.window.showInformationMessage("Select a local branch to rename.");
      const name = await vscode.window.showInputBox({ prompt: `Rename ${current} to`, value: current });
      if (!name?.trim() || name.trim() === current) return;
      await runWithNotification(`Renaming branch ${current}`, () => manager.renameBranch(snapshot.repository.info.rootPath, current, name.trim()));
    }),
    vscode.commands.registerCommand("jbGit.deleteBranch", async (node?: BranchNode) => {
      if (!(await requireTrustedWorkspace())) return;
      const snapshot = await pickRepository(node?.repositoryRoot);
      if (!snapshot) return;
      const localBranches = snapshot.branches.filter((branch) => branch.kind === "local" && branch.name !== snapshot.status?.branch.head);
      const selected = node?.branch.kind === "local"
        ? node.branch.name
        : (await vscode.window.showQuickPick(localBranches.map((branch) => branch.name), { placeHolder: "Select a branch to delete" }));
      if (!selected) return;
      const answer = await vscode.window.showWarningMessage(`Delete branch ${selected}?`, { modal: true }, "Delete");
      if (answer !== "Delete") return;
      await runWithNotification(`Deleting branch ${selected}`, () => manager.deleteBranch(snapshot.repository.info.rootPath, selected));
    }),
    vscode.commands.registerCommand("jbGit.stash", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const message = await vscode.window.showInputBox({ prompt: "Optional stash message", placeHolder: "Work in progress" });
      const options = await vscode.window.showQuickPick(
        [
          { label: "Stash tracked changes", includeUntracked: false, keepIndex: false },
          { label: "Include untracked files", includeUntracked: true, keepIndex: false },
          { label: "Keep index staged", includeUntracked: false, keepIndex: true },
          { label: "Include untracked and keep index", includeUntracked: true, keepIndex: true },
        ],
        { placeHolder: "Choose stash options" },
      );
      if (!options) return;
      await runWithNotification("Stashing changes", () => manager.stash(first.repository.info.rootPath, message?.trim() || undefined, options.includeUntracked, options.keepIndex));
    }),
    vscode.commands.registerCommand("jbGit.createChangelist", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const name = await vscode.window.showInputBox({ prompt: "New Changelist name", placeHolder: "Feature work" });
      if (!name?.trim()) return;
      await changelistStore.create(first.repository.info.rootPath, name.trim());
    }),
    vscode.commands.registerCommand("jbGit.moveToChangelist", async (node?: ChangelistChangeNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      const lists = changelistStore.lists(node.repositoryRoot).filter((list) => list.id !== node.changelistId);
      const target = await vscode.window.showQuickPick(lists.map((list) => ({ label: list.name, list })), { placeHolder: "Move change to Changelist" });
      if (!target) return;
      await changelistStore.assign(node.repositoryRoot, node.change.path, target.list.id);
    }),
    vscode.commands.registerCommand("jbGit.commitChangelist", async (node?: ChangelistNode) => {
      if (!(await requireTrustedWorkspace())) return;
      node ??= changelistsView.selection.find((item): item is ChangelistNode => item instanceof ChangelistNode);
      if (!node) {
        const choice = await vscode.window.showQuickPick(
          manager.all.flatMap((snapshot) => changelistStore.lists(snapshot.repository.info.rootPath).map((changelist) => ({
            label: changelist.name,
            description: snapshot.repository.info.rootPath,
            repositoryRoot: snapshot.repository.info.rootPath,
            changelist,
          }))),
          { placeHolder: "Select a Changelist to commit" },
        );
        if (!choice) return;
        node = new ChangelistNode(choice.repositoryRoot, choice.changelist, choice.changelist.id === changelistStore.activeId(choice.repositoryRoot));
      }
      const snapshot = manager.snapshot(node.repositoryRoot);
      if (!snapshot?.status) return;
      const selected = new Set(snapshot.status.changes
        .filter((change) => changelistStore.listForFile(node.repositoryRoot, change.path).id === node.changelist.id)
        .map((change) => change.path));
      if (selected.size === 0) {
        await vscode.window.showInformationMessage("This Changelist has no local changes.");
        return;
      }
      const stagedOutside = snapshot.status.changes.some((change) => change.staged && !selected.has(change.path));
      if (stagedOutside) {
        await vscode.window.showWarningMessage("Cannot commit this Changelist while unrelated staged changes exist. Commit or unstage them first.");
        return;
      }
      const message = await vscode.window.showInputBox({ prompt: `Commit Changelist '${node.changelist.name}'` });
      if (!message?.trim()) return;
      const revision = await runWithNotification(
        "Creating Changelist commit",
        () => manager.commitPaths(node.repositoryRoot, [...selected], message.trim()),
      );
      if (revision) await vscode.window.showInformationMessage(`Created commit ${revision.slice(0, 12)}`);
    }),
    vscode.commands.registerCommand("jbGit.createShelf", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first?.status) return;
      const paths = [...new Set(first.status.changes
        .filter((change) => change.kind !== "untracked" && change.kind !== "ignored")
        .flatMap((change) => [change.path, ...(change.originalPath ? [change.originalPath] : [])]))];
      if (paths.length === 0) return void vscode.window.showInformationMessage("There are no tracked changes to shelf.");
      const name = await vscode.window.showInputBox({ prompt: "Shelf name", value: "Shelf" });
      if (!name?.trim()) return;
      await runWithNotification(`Creating shelf '${name.trim()}'`, () => shelfStore.create(first.repository, name.trim(), paths));
    }),
    vscode.commands.registerCommand("jbGit.applyShelf", async (node?: ShelfNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      const snapshot = manager.snapshot(node.repositoryRoot);
      if (!snapshot) return;
      await runWithNotification(`Applying shelf '${node.entry.name}'`, async () => {
        await shelfStore.apply(snapshot.repository, node.entry);
        await manager.refresh(node.repositoryRoot);
      });
    }),
    vscode.commands.registerCommand("jbGit.deleteShelf", async (node?: ShelfNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      const answer = await vscode.window.showWarningMessage(`Delete shelf '${node.entry.name}'?`, { modal: true }, "Delete");
      if (answer !== "Delete") return;
      await shelfStore.remove(node.repositoryRoot, node.entry);
    }),
    vscode.commands.registerCommand("jbGit.createWorktree", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const worktreePath = await vscode.window.showInputBox({ prompt: "Worktree path", placeHolder: "../feature-worktree" });
      if (!worktreePath?.trim()) return;
      const ref = await vscode.window.showInputBox({ prompt: "Optional starting ref", value: first.status?.branch.head ?? "HEAD" });
      const newBranch = await vscode.window.showInputBox({ prompt: "Optional new branch name", placeHolder: "feature/worktree" });
      await runWithNotification("Creating Git worktree", () => manager.addWorktree(first.repository.info.rootPath, worktreePath.trim(), ref?.trim() || undefined, newBranch?.trim() || undefined));
    }),
    vscode.commands.registerCommand("jbGit.removeWorktree", async (node?: WorktreeNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      const answer = await vscode.window.showWarningMessage(`Remove worktree ${node.worktree.path}?`, { modal: true }, "Remove");
      if (answer !== "Remove") return;
      await runWithNotification("Removing Git worktree", () => manager.removeWorktree(node.repositoryRoot, node.worktree.path, node.worktree.prunable));
    }),
    vscode.commands.registerCommand("jbGit.pruneWorktrees", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      await runWithNotification("Pruning Git worktrees", () => manager.pruneWorktrees(first.repository.info.rootPath));
    }),
    vscode.commands.registerCommand("jbGit.updateSubmodules", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      await runWithNotification("Updating Git submodules", () => manager.updateSubmodules(first.repository.info.rootPath));
    }),
    vscode.commands.registerCommand("jbGit.updateSubmodule", async (node?: SubmoduleNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      await runWithNotification(`Updating submodule ${node.submodule.path}`, () => manager.updateSubmodules(node.repositoryRoot, [node.submodule.path]));
    }),
    vscode.commands.registerCommand("jbGit.createTag", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const name = await vscode.window.showInputBox({ prompt: "Tag name" });
      if (!name?.trim()) return;
      const ref = await vscode.window.showInputBox({ prompt: "Revision to tag", value: "HEAD" });
      if (!ref?.trim()) return;
      await runWithNotification(`Creating tag ${name.trim()}`, () => manager.createTag(first.repository.info.rootPath, name.trim(), ref.trim()));
    }),
    vscode.commands.registerCommand("jbGit.deleteTag", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const tags = first.branches.filter((branch) => branch.kind === "tag").map((branch) => branch.name);
      const tag = await vscode.window.showQuickPick(tags, { placeHolder: "Select a tag to delete" });
      if (!tag) return;
      const answer = await vscode.window.showWarningMessage(`Delete tag ${tag}?`, { modal: true }, "Delete");
      if (answer !== "Delete") return;
      await runWithNotification(`Deleting tag ${tag}`, () => manager.deleteTag(first.repository.info.rootPath, tag));
    }),
    vscode.commands.registerCommand("jbGit.addRemote", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const name = await vscode.window.showInputBox({ prompt: "Remote name", value: "origin" });
      if (!name?.trim()) return;
      const url = await vscode.window.showInputBox({ prompt: `URL for remote ${name.trim()}`, placeHolder: "https://example.com/repository.git" });
      if (!url?.trim()) return;
      await runWithNotification(`Adding remote ${name.trim()}`, () => manager.addRemote(first.repository.info.rootPath, name.trim(), url.trim()));
    }),
    vscode.commands.registerCommand("jbGit.removeRemote", async (node?: RemoteNode) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const name = node?.remote.name ?? (await vscode.window.showQuickPick(
        (await manager.remotes(first.repository.info.rootPath)).map((remote) => remote.name),
        { placeHolder: "Select a remote to remove" },
      ));
      if (!name) return;
      const answer = await vscode.window.showWarningMessage(`Remove remote ${name}?`, { modal: true }, "Remove");
      if (answer !== "Remove") return;
      await runWithNotification(`Removing remote ${name}`, () => manager.removeRemote(node?.repositoryRoot ?? first.repository.info.rootPath, name));
    }),
    vscode.commands.registerCommand("jbGit.setRemoteUrl", async (node?: RemoteNode) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const remote = node?.remote ?? (await manager.remotes(first.repository.info.rootPath))[0];
      if (!remote) return;
      const kind = await vscode.window.showQuickPick(
        [{ label: "Fetch URL", push: false }, { label: "Push URL", push: true }],
        { placeHolder: "Which remote URL should be changed?" },
      );
      if (!kind) return;
      const current = kind.push ? remote.pushUrl : remote.fetchUrl;
      const url = await vscode.window.showInputBox({
        prompt: `New ${kind.label.toLowerCase()} for ${remote.name}`,
        value: current,
        password: /^[a-z][a-z0-9+.-]*:\/\/[^\s/]+@/i.test(current),
      });
      if (!url?.trim()) return;
      await runWithNotification(`Updating remote ${remote.name}`, () => manager.setRemoteUrl(node?.repositoryRoot ?? first.repository.info.rootPath, remote.name, url.trim(), kind.push));
    }),
    vscode.commands.registerCommand("jbGit.fetchRemote", async (node?: RemoteNode) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const name = node?.remote.name ?? (await vscode.window.showQuickPick(
        (await manager.remotes(first.repository.info.rootPath)).map((remote) => remote.name),
        { placeHolder: "Select a remote to fetch" },
      ));
      if (!name) return;
      await runWithNotification(`Fetching ${name}`, () => manager.fetchRemote(node?.repositoryRoot ?? first.repository.info.rootPath, name));
    }),
    vscode.commands.registerCommand("jbGit.pushRemote", async (node?: RemoteNode) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      if (!first) return;
      const root = node?.repositoryRoot ?? first.repository.info.rootPath;
      const name = node?.remote.name ?? (await vscode.window.showQuickPick(
        (await manager.remotes(root)).map((remote) => remote.name),
        { placeHolder: "Select a remote to push" },
      ));
      if (!name) return;
      const branch = manager.snapshot(root)?.status?.branch.head;
      if (!branch) return void vscode.window.showInformationMessage("Push requires a checked-out local branch.");
      const mode = await vscode.window.showQuickPick(
        [{ label: "Push", force: false }, { label: "Force with lease", force: true }],
        { placeHolder: `Push ${branch} to ${name}` },
      );
      if (!mode) return;
      if (mode.force && (await vscode.window.showWarningMessage("Force with lease can rewrite remote history. Continue?", { modal: true }, "Push")) !== "Push") return;
      await runWithNotification(`Pushing ${branch} to ${name}`, () => manager.pushRemote(root, name, branch, mode.force));
    }),
    vscode.commands.registerCommand("jbGit.applyStash", async (node?: StashNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      await runWithNotification(`Applying ${node.entry.ref}`, () => manager.applyStash(node.repositoryRoot, node.entry.ref));
    }),
    vscode.commands.registerCommand("jbGit.popStash", async (node?: StashNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      await runWithNotification(`Popping ${node.entry.ref}`, () => manager.applyStash(node.repositoryRoot, node.entry.ref, true));
    }),
    vscode.commands.registerCommand("jbGit.dropStash", async (node?: StashNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      const answer = await vscode.window.showWarningMessage(`Drop ${node.entry.ref}?`, { modal: true }, "Drop");
      if (answer !== "Drop") return;
      await runWithNotification(`Dropping ${node.entry.ref}`, () => manager.dropStash(node.repositoryRoot, node.entry.ref));
    }),
    vscode.commands.registerCommand("jbGit.checkoutBranch", async (node?: BranchNode) => {
      if (!(await requireTrustedWorkspace())) return;
      const snapshot = await pickRepository(node?.repositoryRoot);
      if (!snapshot) return void vscode.window.showInformationMessage("No Git repository was found in this workspace.");
      const selected = node?.branch ?? (await vscode.window.showQuickPick(
        snapshot.branches.filter((item) => item.kind !== "remote" || item.name !== "origin/HEAD").map((item) => ({ label: item.name, description: item.kind, item })),
        { placeHolder: "Select a branch to checkout" },
      ))?.item;
      if (!selected) return;
      await runWithNotification(`Checking out ${selected.name}`, () => manager.checkout(snapshot.repository.info.rootPath, selected.name, selected.kind));
    }),
    vscode.commands.registerCommand("jbGit.stageChange", async (node?: ChangeNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      await runWithNotification(`Staging ${node.change.path}`, () => manager.stage(node.repositoryRoot, [node.change.path]));
    }),
    vscode.commands.registerCommand("jbGit.unstageChange", async (node?: ChangeNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      await runWithNotification(`Unstaging ${node.change.path}`, () => manager.unstage(node.repositoryRoot, [node.change.path]));
    }),
    vscode.commands.registerCommand("jbGit.stageHunk", async (node?: HunkNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      await runWithNotification(`Staging hunk in ${node.pathSpec}`, () => manager.stageHunk(node.repositoryRoot, node.pathSpec, node.hunk));
    }),
    vscode.commands.registerCommand("jbGit.unstageHunk", async (node?: HunkNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      await runWithNotification(`Unstaging hunk in ${node.pathSpec}`, () => manager.unstageHunk(node.repositoryRoot, node.pathSpec, node.hunk));
    }),
    vscode.commands.registerCommand("jbGit.discardChange", async (node?: ChangeNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      if (node.change.kind === "untracked") {
        const answer = await vscode.window.showWarningMessage(`Delete untracked file ${node.change.path}?`, { modal: true }, "Delete");
        if (answer !== "Delete") return;
        await runWithNotification(`Deleting ${node.change.path}`, () => manager.cleanUntracked(node.repositoryRoot, [node.change.path]));
        return;
      }
      const confirmDiscard = vscode.workspace.getConfiguration("jbGit").get<boolean>("confirmDiscard", true);
      if (confirmDiscard) {
        const answer = await vscode.window.showWarningMessage(
          `Discard working tree changes in ${node.change.path}?`,
          { modal: true },
          "Discard",
        );
        if (answer !== "Discard") return;
      }
      await runWithNotification(`Discarding ${node.change.path}`, () => manager.discard(node.repositoryRoot, [node.change.path]));
    }),
    vscode.commands.registerCommand("jbGit.resolveConflict", async (node?: ChangeNode) => {
      if (!(await requireTrustedWorkspace()) || !node || !node.change.conflicted) return;
      const side = await vscode.window.showQuickPick(
        [
          { label: "Accept ours", value: "ours" as const, description: "Use the current branch version" },
          { label: "Accept theirs", value: "theirs" as const, description: "Use the incoming branch version" },
        ],
        { placeHolder: `Resolve ${node.change.path}` },
      );
      if (!side) return;
      const answer = await vscode.window.showWarningMessage(`Replace ${node.change.path} with ${side.label.toLowerCase()}?`, { modal: true }, "Resolve");
      if (answer !== "Resolve") return;
      await runWithNotification(`Resolving ${node.change.path}`, () => manager.resolveConflict(node.repositoryRoot, node.change.path, side.value));
    }),
    vscode.commands.registerCommand("jbGit.markResolved", async (node?: ChangeNode) => {
      if (!(await requireTrustedWorkspace()) || !node || !node.change.conflicted) return;
      await runWithNotification(`Marking ${node.change.path} resolved`, () => manager.markResolved(node.repositoryRoot, [node.change.path]));
    }),
  );

  await refresh();
}

export function deactivate(): void {
  // All resources are owned by ExtensionContext subscriptions.
}

export function formatGitError(error: unknown): string {
  if (error instanceof GitCommandError) {
    return error.stderr.trim() || error.stdout.trim() || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

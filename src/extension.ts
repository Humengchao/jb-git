import * as path from "node:path";
import * as vscode from "vscode";
import { GitCommandError, GitRunner, redactGitText } from "./git/runner";
import { BranchNode, RepositoryNode } from "./views/repositoryTree";
import { ChangeNode, HunkNode } from "./views/changesTree";
import { DiffContentProvider, openChangeDiff } from "./views/diffProvider";
import { CommitNode } from "./views/historyTree";
import { ChangelistChangeNode, ChangelistNode } from "./views/changelistTree";
import { ChangelistStore } from "./changelists/store";
import { ShelfStore } from "./shelves/store";
import { ShelfNode } from "./views/shelfTree";
import { WorktreeNode } from "./views/worktreeTree";
import { RemoteNode } from "./views/remoteTree";
import { StashNode } from "./views/stashTree";
import { SubmoduleNode } from "./views/submoduleTree";
import { RepositoryManager } from "./repositoryManager";
import { IntelliJGitToolWindowProvider } from "./webviews/logPanel";
import { MergeConflictEditor } from "./webviews/mergeEditor";
import { validateGitRefName, validatePathInput, validateRemoteName, validateSingleLine } from "./inputValidation";
import { canonicalPath, deepestContaining } from "./pathRouting";

function workspacePaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

function configurationGitPath(): string {
  return vscode.workspace.getConfiguration("jbGit").get<string>("gitPath", "git");
}

async function requireTrustedWorkspace(): Promise<boolean> {
  if (vscode.workspace.isTrusted) return true;
  await vscode.window.showWarningMessage("JB Git mutations are disabled until this workspace is trusted.");
  return false;
}

async function runWithNotification<T>(title: string, task: (signal: AbortSignal) => Promise<T>, cancellable = false): Promise<T | undefined> {
  try {
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable },
      async (_progress, token) => {
        const controller = new AbortController();
        const registration = token.onCancellationRequested(() => controller.abort());
        try { return await task(controller.signal); } finally { registration.dispose(); }
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(message);
    return undefined;
  }
}

async function runWithNotificationResult(title: string, task: (signal: AbortSignal) => Promise<void>, cancellable = false): Promise<boolean> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable },
      async (_progress, token) => {
        const controller = new AbortController();
        const registration = token.onCancellationRequested(() => controller.abort());
        try { await task(controller.signal); } finally { registration.dispose(); }
      },
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
  const diffProvider = new DiffContentProvider();
  const gitToolWindow = new IntelliJGitToolWindowProvider(manager, changelistStore, shelfStore, diffProvider, context.workspaceState);
  const mergeEditor = new MergeConflictEditor(manager, context.workspaceState);
  const traceRegistration = runner.onDidRun((event) => gitToolWindow.appendTrace(event));
  const toolWindowRegistration = vscode.window.registerWebviewViewProvider(
    IntelliJGitToolWindowProvider.viewType,
    gitToolWindow,
    { webviewOptions: { retainContextWhenHidden: true } },
  );
  const branchStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  const outputChannel = vscode.window.createOutputChannel("JB Git");
  const showOutput = (title: string, content: string): void => {
    outputChannel.clear();
    outputChannel.appendLine(`# ${title}`);
    outputChannel.appendLine("");
    outputChannel.append(content);
    outputChannel.show(true);
  };
  branchStatus.command = "jbGit.branchesPopup";
  branchStatus.tooltip = "Git Branches and Operations";

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
  let pendingDiscovery = false;
  let refreshTimer: NodeJS.Timeout | undefined;
  const scheduleRefresh = (): void => {
    if (refreshTimer) clearTimeout(refreshTimer);
    const delay = vscode.workspace.getConfiguration("jbGit").get<number>("refreshDebounceMs", 600);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      const roots = [...pendingRefreshRoots];
      const discover = pendingDiscovery;
      pendingRefreshRoots.clear();
      pendingDiscovery = false;
      const operation = discover
        ? manager.discoverAndRefresh()
        : Promise.all(roots.map((root) => manager.refresh(root))).then(() => undefined);
      void operation.then(updateStatusBar, (error) => vscode.window.showErrorMessage(formatGitError(error)));
    }, delay);
  };
  const scheduleRefreshRoot = (rootPath: string): void => {
    if (!vscode.workspace.getConfiguration("jbGit").get<boolean>("autoRefresh", true)) return;
    pendingRefreshRoots.add(rootPath);
    scheduleRefresh();
  };
  const scheduleRefreshForPath = (filePath: string): void => {
    if (!vscode.workspace.getConfiguration("jbGit").get<boolean>("autoRefresh", true)) return;
    void canonicalPath(filePath).then((candidate) => {
      const snapshot = deepestContaining(manager.all, candidate, (item) => item.repository.info.rootPath);
      if (snapshot) scheduleRefreshRoot(snapshot.repository.info.rootPath);
    });
  };
  const scheduleDiscovery = (): void => {
    if (!vscode.workspace.getConfiguration("jbGit").get<boolean>("autoRefresh", true)) return;
    pendingDiscovery = true;
    scheduleRefresh();
  };
  // This watcher is only for discovering newly-created or removed repositories.
  // Repository state itself is watched through a small set of metadata paths below.
  const gitMetadataWatcher = vscode.workspace.createFileSystemWatcher("**/.git");
  const repositoryMetadataWatchers = new Map<string, vscode.FileSystemWatcher[]>();
  const metadataPatterns = [
    "HEAD", "index", "packed-refs", "refs/**", "MERGE_HEAD", "CHERRY_PICK_HEAD",
    "REVERT_HEAD", "BISECT_LOG", "rebase-merge/**", "rebase-apply/**", "sequencer/**",
  ];
  const rebuildRepositoryMetadataWatchers = (): void => {
    const desired = new Map<string, { root: string; directory: string }>();
    for (const snapshot of manager.all) {
      for (const directory of new Set([snapshot.repository.info.gitDir, snapshot.repository.info.commonGitDir])) {
        desired.set(`${snapshot.repository.info.rootPath}\0${directory}`, { root: snapshot.repository.info.rootPath, directory });
      }
    }
    for (const [key, watchers] of repositoryMetadataWatchers) {
      if (!desired.has(key)) {
        for (const watcher of watchers) watcher.dispose();
        repositoryMetadataWatchers.delete(key);
      }
    }
    for (const [key, target] of desired) {
      if (repositoryMetadataWatchers.has(key)) continue;
      const watchers = metadataPatterns.map((pattern) => {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(target.directory, pattern));
        watcher.onDidChange(() => scheduleRefreshRoot(target.root));
        watcher.onDidCreate(() => scheduleRefreshRoot(target.root));
        watcher.onDidDelete(() => scheduleRefreshRoot(target.root));
        return watcher;
      });
      repositoryMetadataWatchers.set(key, watchers);
    }
  };

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
  const pickWorkspaceRoot = async (): Promise<string | undefined> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length <= 1) return folders[0]?.uri.fsPath;
    return (await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, rootPath: folder.uri.fsPath })),
      { placeHolder: "Select a workspace folder" },
    ))?.rootPath;
  };
  const pickChangeNode = async (mode: "staged" | "unstaged", rootPath?: string): Promise<ChangeNode | undefined> => {
    const snapshot = await pickRepository(rootPath);
    if (!snapshot?.status) return;
    const changes = snapshot.status.changes.filter((change) => mode === "staged" ? change.staged : change.unstaged);
    const selected = await vscode.window.showQuickPick(
      changes.map((change) => ({ label: change.path, description: change.kind, change })),
      { title: mode === "staged" ? "Staged Changes" : "Unstaged Changes", placeHolder: "Select a changed file", matchOnDescription: true },
    );
    return selected ? new ChangeNode(snapshot.repository.info.rootPath, selected.change, mode) : undefined;
  };
  const pickHunkNode = async (mode: "staged" | "unstaged", rootPath?: string): Promise<HunkNode | undefined> => {
    const change = await pickChangeNode(mode, rootPath);
    if (!change || change.change.conflicted || change.change.kind === "untracked") return;
    const hunks = await manager.diffHunks(change.repositoryRoot, change.change.path, mode === "staged");
    if (!hunks.length) {
      await vscode.window.showInformationMessage(`No ${mode} text hunks were found in ${change.change.path}.`);
      return;
    }
    const selected = await vscode.window.showQuickPick(
      hunks.map((hunk, index) => ({
        label: hunk.header,
        description: hunk.lines.find((line) => line.startsWith("+") || line.startsWith("-"))?.slice(0, 100),
        hunk,
        index,
      })),
      { title: change.change.path, placeHolder: mode === "staged" ? "Select a hunk to unstage" : "Select a hunk to stage", matchOnDescription: true },
    );
    return selected ? new HunkNode(change.repositoryRoot, change.change.path, mode, selected.index, selected.hunk) : undefined;
  };

  context.subscriptions.push(
    manager,
    changelistStore,
    shelfStore,
    gitToolWindow,
    mergeEditor,
    traceRegistration,
    toolWindowRegistration,
    diffProvider,
    gitMetadataWatcher,
    { dispose: () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      for (const watchers of repositoryMetadataWatchers.values()) for (const watcher of watchers) watcher.dispose();
      repositoryMetadataWatchers.clear();
    } },
    vscode.workspace.registerTextDocumentContentProvider("jb-git-diff", diffProvider),
    branchStatus,
    outputChannel,
    manager.onDidChange(() => {
      updateStatusBar();
      rebuildRepositoryMetadataWatchers();
      // A manager refresh already captured the latest worktree and metadata
      // state, so discard watcher events generated by that same Git operation.
      for (const snapshot of manager.all) pendingRefreshRoots.delete(snapshot.repository.info.rootPath);
      if (!pendingRefreshRoots.size && !pendingDiscovery && refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
      }
      for (const snapshot of manager.all) {
        if (snapshot.status) {
          void changelistStore.reconcile(snapshot.repository.info.rootPath, snapshot.status.changes)
            .catch((error) => vscode.window.showErrorMessage(formatGitError(error)));
        }
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refresh()),
    vscode.workspace.onDidSaveTextDocument((document) => scheduleRefreshForPath(document.uri.fsPath)),
    vscode.workspace.onDidCreateFiles((event) => event.files.forEach((uri) => scheduleRefreshForPath(uri.fsPath))),
    vscode.workspace.onDidDeleteFiles((event) => event.files.forEach((uri) => scheduleRefreshForPath(uri.fsPath))),
    vscode.workspace.onDidRenameFiles((event) => event.files.forEach((file) => { scheduleRefreshForPath(file.oldUri.fsPath); scheduleRefreshForPath(file.newUri.fsPath); })),
    gitMetadataWatcher.onDidCreate(() => scheduleDiscovery()),
    gitMetadataWatcher.onDidDelete(() => scheduleDiscovery()),
    vscode.commands.registerCommand("jbGit.refresh", refresh),
    vscode.commands.registerCommand("jbGit.openChanges", (rootPath?: string) => gitToolWindow.openChanges(rootPath)),
    vscode.commands.registerCommand("jbGit.openDiff", async (node?: ChangeNode) => {
      if (!node) return;
      if (node.change.conflicted) {
        await openMergeConflictEditor(manager, mergeEditor, node);
        return;
      }
      await runWithNotification(`Loading diff for ${node.change.path}`, () => openChangeDiff(manager, diffProvider, node));
    }),
    vscode.commands.registerCommand("jbGit.showHistory", () => gitToolWindow.open()),
    vscode.commands.registerCommand("jbGit.openGitToolWindow", (rootPath?: string) => gitToolWindow.open(rootPath)),
    vscode.commands.registerCommand("jbGit.branchesPopup", async (rootPath?: string) => {
      const snapshot = await pickRepository(rootPath);
      if (!snapshot) return void vscode.window.showInformationMessage("No Git repository was found in this workspace.");
      type BranchAction = vscode.QuickPickItem & { action?: "new" | "fetch" | "pull" | "push" | "log"; branch?: typeof snapshot.branches[number] };
      const current = snapshot.status?.branch.head;
      const items: BranchAction[] = [
        { label: "$(add) New Branch", description: `from ${current ?? "HEAD"}`, action: "new" },
        { label: "$(git-pull-request-go-to-changes) Fetch", action: "fetch" },
        { label: "$(cloud-download) Pull…", action: "pull" },
        { label: "$(cloud-upload) Push…", action: "push" },
        { label: "$(git-commit) Show Git Log", action: "log" },
        { label: "Local Branches", kind: vscode.QuickPickItemKind.Separator },
        ...snapshot.branches.filter((branch) => branch.kind === "local").map((branch) => ({
          label: `${branch.name === current ? "$(check)" : "$(git-branch)"} ${branch.name}`,
          description: branch.upstream ? `${branch.upstream}${branch.tracking ? ` · ${branch.tracking}` : ""}` : undefined,
          branch,
        })),
        { label: "Remote Branches", kind: vscode.QuickPickItemKind.Separator },
        ...snapshot.branches.filter((branch) => branch.kind === "remote").map((branch) => ({ label: `$(cloud) ${branch.name}`, branch })),
        { label: "Tags", kind: vscode.QuickPickItemKind.Separator },
        ...snapshot.branches.filter((branch) => branch.kind === "tag").map((branch) => ({ label: `$(tag) ${branch.name}`, branch })),
      ];
      const selected = await vscode.window.showQuickPick(items, {
        title: `${path.basename(snapshot.repository.info.rootPath)} · ${current ?? "detached HEAD"}`,
        placeHolder: "Git branches and common operations",
        matchOnDescription: true,
      });
      if (!selected) return;
      const root = snapshot.repository.info.rootPath;
      if (selected.branch) {
        if (selected.branch.kind === "local" && selected.branch.name === current) return;
        await runWithNotification(`Checking out ${selected.branch.name}`, () => manager.checkout(root, selected.branch!.name, selected.branch!.kind));
      } else if (selected.action === "new") {
        const name = await vscode.window.showInputBox({ title: "New Branch", prompt: `Create from ${current ?? "HEAD"}`, validateInput: (value) => validateGitRefName(value) });
        if (name?.trim()) await runWithNotification(`Creating branch ${name.trim()}`, () => manager.createBranch(root, name.trim()));
      } else if (selected.action === "fetch") await runWithNotification("Fetching remotes", () => manager.fetch(root));
      else if (selected.action === "pull") await vscode.commands.executeCommand("jbGit.pull", root);
      else if (selected.action === "push") await vscode.commands.executeCommand("jbGit.push", root);
      else if (selected.action === "log") await gitToolWindow.open(root);
    }),
    vscode.commands.registerCommand("jbGit.operationsPopup", async (rootPath?: string) => {
      const snapshot = await pickRepository(rootPath);
      if (!snapshot) return void vscode.window.showInformationMessage("No Git repository was found in this workspace.");
      const root = snapshot.repository.info.rootPath;
      type OperationItem = vscode.QuickPickItem & { command?: string };
      const items: OperationItem[] = [
        { label: "Common", kind: vscode.QuickPickItemKind.Separator },
        { label: "$(check) Commit…", command: "jbGit.openChanges" },
        { label: "$(cloud-upload) Push…", command: "jbGit.push" },
        { label: "$(cloud-download) Pull…", command: "jbGit.pull" },
        { label: "$(sync) Fetch", command: "jbGit.fetch" },
        { label: "$(git-branch) Branches…", command: "jbGit.branchesPopup" },
        { label: "$(git-commit) Git Log", command: "jbGit.openGitToolWindow" },
        { label: "History rewriting", kind: vscode.QuickPickItemKind.Separator },
        { label: "$(git-merge) Merge…", command: "jbGit.merge" },
        { label: "$(git-compare) Rebase…", command: "jbGit.rebase" },
        { label: "$(git-commit) Cherry-pick…", command: "jbGit.cherryPick" },
        { label: "$(discard) Revert…", command: "jbGit.revert" },
        { label: "$(debug-restart) Reset HEAD…", command: "jbGit.reset" },
        { label: "Save work", kind: vscode.QuickPickItemKind.Separator },
        { label: "$(archive) Manage Stashes…", command: "jbGit.manageStashes" },
        { label: "$(package) Shelve Changes…", command: "jbGit.createShelf" },
        { label: "$(file-code) Apply Patch…", command: "jbGit.applyPatch" },
        { label: "Repository", kind: vscode.QuickPickItemKind.Separator },
        { label: "$(remote) Manage Remotes…", command: "jbGit.manageRemotes" },
        { label: "$(repo-forked) Manage Worktrees…", command: "jbGit.manageWorktrees" },
        { label: "$(file-submodule) Manage Submodules…", command: "jbGit.manageSubmodules" },
        { label: "$(tag) Create Tag…", command: "jbGit.createTag" },
        { label: "$(list-tree) Configure Sparse Checkout…", command: "jbGit.sparseCheckoutSet" },
        { label: "$(cloud-download) Pull LFS Objects", command: "jbGit.lfsPull" },
        { label: "Diagnostics", kind: vscode.QuickPickItemKind.Separator },
        { label: "$(debug-alt) Bisect Start…", command: "jbGit.bisectStart" },
      ];
      const selected = await vscode.window.showQuickPick(items, {
        title: `Git · ${snapshot.status?.branch.head ?? "detached HEAD"}`,
        placeHolder: "Select a Git operation",
      });
      if (selected?.command) await vscode.commands.executeCommand(selected.command, root);
    }),
    vscode.commands.registerCommand("jbGit.fileHistory", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== "file") return void vscode.window.showInformationMessage("Open a file before showing its Git history.");
      const filePath = editor.document.uri.fsPath;
      const snapshot = deepestContaining(manager.all, await canonicalPath(filePath), (item) => item.repository.info.rootPath);
      if (!snapshot) return void vscode.window.showInformationMessage("The active file is not inside a discovered Git repository.");
      const relativePath = path.relative(snapshot.repository.info.rootPath, filePath);
      await gitToolWindow.open(snapshot.repository.info.rootPath, relativePath);
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
      const snapshot = deepestContaining(manager.all, await canonicalPath(filePath), (item) => item.repository.info.rootPath);
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
      const root = await pickWorkspaceRoot();
      if (!root) {
        await vscode.window.showInformationMessage("Open a folder before initializing a Git repository.");
        return;
      }
      const initialized = await runWithNotification("Initializing Git repository", () => manager.initializeRepository(root));
      if (initialized === false) await vscode.window.showInformationMessage("This folder is already inside a Git repository; no nested repository was created.");
    }),
    vscode.commands.registerCommand("jbGit.cloneRepository", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const source = await vscode.window.showInputBox({ prompt: "Repository URL or local path", placeHolder: "https://example.com/repository.git", validateInput: (value) => validateSingleLine(value, "Repository URL or path") });
      if (!source?.trim()) return;
      const destination = await vscode.window.showInputBox({ prompt: "Destination folder", placeHolder: "./repository", validateInput: (value) => validatePathInput(value) });
      if (!destination?.trim()) return;
      const mode = await vscode.window.showQuickPick(
        [{ label: "Standard clone", bare: false }, { label: "Bare clone", bare: true }],
        { placeHolder: "Clone type" },
      );
      if (!mode) return;
      const cloneRoot = await pickWorkspaceRoot() ?? process.cwd();
      const cloned = await runWithNotificationResult(
        `Cloning ${source.trim()}`,
        (signal) => manager.clone(source.trim(), destination.trim(), mode.bare, cloneRoot, signal),
        true,
      );
      if (cloned && !mode.bare) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(path.resolve(cloneRoot, destination.trim())), { forceNewWindow: false });
    }),
    vscode.commands.registerCommand("jbGit.fetch", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      await runWithNotification("Fetching Git remotes", (signal) => manager.fetch(rootPath, signal), true);
    }),
    vscode.commands.registerCommand("jbGit.applyPatch", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const files = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false, openLabel: "Apply Patch" });
      const patchFile = files?.[0];
      if (!patchFile) return;
      await runWithNotification(`Applying ${path.basename(patchFile.fsPath)}`, () => manager.applyPatch(first.repository.info.rootPath, patchFile.fsPath));
    }),
    vscode.commands.registerCommand("jbGit.sparseCheckoutSet", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const input = await vscode.window.showInputBox({ prompt: "Sparse-checkout paths (comma-separated)", placeHolder: "src,docs" });
      if (!input?.trim()) return;
      const paths = input.split(",").map((item) => item.trim()).filter(Boolean);
      await runWithNotification("Configuring sparse checkout", () => manager.sparseCheckoutSet(first.repository.info.rootPath, paths));
    }),
    vscode.commands.registerCommand("jbGit.sparseCheckoutDisable", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const answer = await vscode.window.showWarningMessage("Disable sparse checkout and restore all files?", { modal: true }, "Disable");
      if (answer !== "Disable") return;
      await runWithNotification("Disabling sparse checkout", () => manager.sparseCheckoutDisable(first.repository.info.rootPath));
    }),
    vscode.commands.registerCommand("jbGit.lfsPull", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      await runWithNotification("Pulling Git LFS objects", (signal) => manager.lfsPull(first.repository.info.rootPath, signal), true);
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
    vscode.commands.registerCommand("jbGit.pull", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
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
      await runWithNotification(`Pulling with ${strategy.label}`, (signal) => manager.pull(first.repository.info.rootPath, strategy.value, signal), true);
    }),
    vscode.commands.registerCommand("jbGit.push", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
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
      await runWithNotification("Pushing Git commits", (signal) => manager.push(first.repository.info.rootPath, mode.force, signal), true);
    }),
    vscode.commands.registerCommand("jbGit.merge", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const current = first.status?.branch.head;
      const ref = await vscode.window.showQuickPick(
        first.branches.filter((branch) => (branch.kind === "local" || branch.kind === "remote") && branch.name !== current).map((branch) => branch.name),
        { placeHolder: "Select a branch or ref to merge" },
      );
      if (!ref) return;
      await runWithNotification(`Merging ${ref}`, () => manager.merge(first.repository.info.rootPath, ref));
    }),
    vscode.commands.registerCommand("jbGit.rebase", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const current = first.status?.branch.head;
      const ref = await vscode.window.showQuickPick(
        first.branches.filter((branch) => (branch.kind === "local" || branch.kind === "remote") && branch.name !== current).map((branch) => branch.name),
        { placeHolder: "Select a branch or ref to rebase onto" },
      );
      if (!ref) return;
      await runWithNotification(`Rebasing onto ${ref}`, () => manager.rebase(first.repository.info.rootPath, ref));
    }),
    vscode.commands.registerCommand("jbGit.cherryPick", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const hash = await vscode.window.showInputBox({ prompt: "Commit hash or ref to cherry-pick" });
      if (!hash?.trim()) return;
      await runWithNotification(`Cherry-picking ${hash.trim()}`, () => manager.cherryPick(first.repository.info.rootPath, hash.trim()));
    }),
    vscode.commands.registerCommand("jbGit.revert", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const hash = await vscode.window.showInputBox({ prompt: "Commit hash or ref to revert" });
      if (!hash?.trim()) return;
      const answer = await vscode.window.showWarningMessage(`Revert ${hash.trim()}?`, { modal: true }, "Revert");
      if (answer !== "Revert") return;
      await runWithNotification(`Reverting ${hash.trim()}`, () => manager.revert(first.repository.info.rootPath, hash.trim()));
    }),
    vscode.commands.registerCommand("jbGit.reset", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
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
    vscode.commands.registerCommand("jbGit.continueOperation", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      const kind = first?.operation.kind;
      if (!first || !kind || kind === "none" || kind === "bisect" || kind === "sequencer") return;
      await runWithNotification(`Continuing ${kind}`, () => manager.continueOperation(first.repository.info.rootPath, kind));
    }),
    vscode.commands.registerCommand("jbGit.abortOperation", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      const kind = first?.operation.kind;
      if (!first || !kind || kind === "none" || kind === "sequencer") return;
      const answer = await vscode.window.showWarningMessage(`Abort ${kind}?`, { modal: true }, "Abort");
      if (answer !== "Abort") return;
      if (kind === "bisect") await runWithNotification("Resetting bisect", () => manager.bisectReset(first.repository.info.rootPath));
      else await runWithNotification(`Aborting ${kind}`, () => manager.abortOperation(first.repository.info.rootPath, kind));
    }),
    vscode.commands.registerCommand("jbGit.skipOperation", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository();
      const kind = first?.operation.kind;
      if (!first || (kind !== "rebase" && kind !== "cherry-pick")) return;
      await runWithNotification(`Skipping ${kind}`, () => manager.skipOperation(first.repository.info.rootPath, kind));
    }),
    vscode.commands.registerCommand("jbGit.bisectStart", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
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
      const name = await vscode.window.showInputBox({ prompt: "New branch name", placeHolder: "feature/my-change", validateInput: (value) => validateGitRefName(value) });
      if (!name?.trim()) return;
      const startPoint = node instanceof BranchNode ? node.branch.name : undefined;
      await runWithNotification(`Creating branch ${name}`, () => manager.createBranch(snapshot.repository.info.rootPath, name.trim(), startPoint));
    }),
    vscode.commands.registerCommand("jbGit.renameBranch", async (node?: BranchNode) => {
      if (!(await requireTrustedWorkspace())) return;
      const snapshot = await pickRepository(node?.repositoryRoot);
      const current = node?.branch.kind === "local" ? node.branch.name : snapshot?.status?.branch.head;
      if (!snapshot || !current) return void vscode.window.showInformationMessage("Select a local branch to rename.");
      const name = await vscode.window.showInputBox({ prompt: `Rename ${current} to`, value: current, validateInput: (value) => validateGitRefName(value) });
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
    vscode.commands.registerCommand("jbGit.stash", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
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
    vscode.commands.registerCommand("jbGit.createShelf", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
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
    vscode.commands.registerCommand("jbGit.createWorktree", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const worktreePath = await vscode.window.showInputBox({ prompt: "Worktree path", placeHolder: "../feature-worktree", validateInput: (value) => validatePathInput(value) });
      if (!worktreePath?.trim()) return;
      const ref = await vscode.window.showInputBox({ prompt: "Optional starting ref", value: first.status?.branch.head ?? "HEAD" });
      const newBranch = await vscode.window.showInputBox({ prompt: "Optional new branch name", placeHolder: "feature/worktree", validateInput: (value) => validateGitRefName(value, true) });
      await runWithNotification("Creating Git worktree", () => manager.addWorktree(first.repository.info.rootPath, worktreePath.trim(), ref?.trim() || undefined, newBranch?.trim() || undefined));
    }),
    vscode.commands.registerCommand("jbGit.manageWorktrees", async (rootPath?: string) => {
      const first = await pickRepository(rootPath);
      if (!first) return;
      const root = first.repository.info.rootPath;
      const worktrees = await manager.worktrees(root);
      const selected = await vscode.window.showQuickPick([
        { label: "$(add) Create Worktree…", action: "create" as const },
        { label: "$(clear-all) Prune Missing Worktrees", action: "prune" as const },
        ...worktrees.map((worktree) => ({
          label: `$(git-branch) ${worktree.branch ?? "detached HEAD"}`,
          description: worktree.path,
          detail: worktree.prunable ? "Prunable" : worktree.head ?? undefined,
          action: "worktree" as const,
          worktree,
        })),
      ], { title: "Git Worktrees", placeHolder: "Create, open, or remove a worktree", matchOnDescription: true, matchOnDetail: true });
      if (!selected) return;
      if (selected.action === "create") return void vscode.commands.executeCommand("jbGit.createWorktree", root);
      if (selected.action === "prune") return void vscode.commands.executeCommand("jbGit.pruneWorktrees", root);
      const action = await vscode.window.showQuickPick([
        { label: "$(folder-opened) Open Worktree", action: "open" as const },
        { label: "$(trash) Remove Worktree…", action: "remove" as const },
      ], { title: selected.worktree.path, placeHolder: "Select a worktree action" });
      if (action?.action === "open") await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(selected.worktree.path), { forceNewWindow: false });
      if (action?.action === "remove") await vscode.commands.executeCommand("jbGit.removeWorktree", new WorktreeNode(root, selected.worktree));
    }),
    vscode.commands.registerCommand("jbGit.removeWorktree", async (node?: WorktreeNode) => {
      if (!(await requireTrustedWorkspace())) return;
      if (!node) {
        const first = await pickRepository();
        if (!first) return;
        const worktree = (await vscode.window.showQuickPick(
          (await manager.worktrees(first.repository.info.rootPath))
            .filter((item) => path.normalize(item.path) !== path.normalize(first.repository.info.rootPath))
            .map((item) => ({ label: item.branch ?? "detached HEAD", description: item.path, item })),
          { placeHolder: "Select a worktree to remove", matchOnDescription: true },
        ))?.item;
        if (!worktree) return;
        node = new WorktreeNode(first.repository.info.rootPath, worktree);
      }
      const answer = await vscode.window.showWarningMessage(`Remove worktree ${node.worktree.path}?`, { modal: true }, "Remove");
      if (answer !== "Remove") return;
      await runWithNotification("Removing Git worktree", () => manager.removeWorktree(node.repositoryRoot, node.worktree.path, node.worktree.prunable));
    }),
    vscode.commands.registerCommand("jbGit.pruneWorktrees", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      await runWithNotification("Pruning Git worktrees", () => manager.pruneWorktrees(first.repository.info.rootPath));
    }),
    vscode.commands.registerCommand("jbGit.updateSubmodules", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      await runWithNotification("Updating Git submodules", () => manager.updateSubmodules(first.repository.info.rootPath));
    }),
    vscode.commands.registerCommand("jbGit.updateSubmodule", async (node?: SubmoduleNode) => {
      if (!(await requireTrustedWorkspace())) return;
      if (!node) {
        const first = await pickRepository();
        if (!first) return;
        const submodule = (await vscode.window.showQuickPick(
          (await manager.submodules(first.repository.info.rootPath)).map((item) => ({ label: item.path, description: item.status, item })),
          { placeHolder: "Select a submodule to update" },
        ))?.item;
        if (!submodule) return;
        node = new SubmoduleNode(first.repository.info.rootPath, submodule);
      }
      await runWithNotification(`Updating submodule ${node.submodule.path}`, () => manager.updateSubmodules(node.repositoryRoot, [node.submodule.path]));
    }),
    vscode.commands.registerCommand("jbGit.manageSubmodules", async (rootPath?: string) => {
      const first = await pickRepository(rootPath);
      if (!first) return;
      const root = first.repository.info.rootPath;
      const submodules = await manager.submodules(root);
      if (!submodules.length) return void vscode.window.showInformationMessage("This repository has no Git submodules.");
      const selected = await vscode.window.showQuickPick([
        { label: "$(sync) Update All Submodules", action: "all" as const },
        ...submodules.map((submodule) => ({ label: `$(repo) ${submodule.path}`, description: submodule.status, detail: submodule.url ? redactGitText(submodule.url) : submodule.oid, action: "one" as const, submodule })),
      ], { title: "Git Submodules", placeHolder: "Select what to update", matchOnDescription: true, matchOnDetail: true });
      if (selected?.action === "all") await vscode.commands.executeCommand("jbGit.updateSubmodules", root);
      if (selected?.action === "one") await vscode.commands.executeCommand("jbGit.updateSubmodule", new SubmoduleNode(root, selected.submodule));
    }),
    vscode.commands.registerCommand("jbGit.createTag", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const name = await vscode.window.showInputBox({ prompt: "Tag name", validateInput: (value) => validateGitRefName(value) });
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
    vscode.commands.registerCommand("jbGit.addRemote", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const name = await vscode.window.showInputBox({ prompt: "Remote name", value: "origin", validateInput: validateRemoteName });
      if (!name?.trim()) return;
      const url = await vscode.window.showInputBox({ prompt: `URL for remote ${name.trim()}`, placeHolder: "https://example.com/repository.git" });
      if (!url?.trim()) return;
      await runWithNotification(`Adding remote ${name.trim()}`, () => manager.addRemote(first.repository.info.rootPath, name.trim(), url.trim()));
    }),
    vscode.commands.registerCommand("jbGit.manageRemotes", async (rootPath?: string) => {
      const first = await pickRepository(rootPath);
      if (!first) return;
      const root = first.repository.info.rootPath;
      const selected = await vscode.window.showQuickPick([
        { label: "$(add) Add Remote…", action: "add" as const },
        ...(await manager.remotes(root)).map((remote) => ({ label: `$(remote) ${remote.name}`, description: redactGitText(remote.fetchUrl), action: "remote" as const, remote })),
      ], { title: "Git Remotes", placeHolder: "Add or manage a remote", matchOnDescription: true });
      if (!selected) return;
      if (selected.action === "add") return void vscode.commands.executeCommand("jbGit.addRemote", root);
      const action = await vscode.window.showQuickPick([
        { label: "$(sync) Fetch", command: "jbGit.fetchRemote" },
        { label: "$(cloud-upload) Push…", command: "jbGit.pushRemote" },
        { label: "$(edit) Edit URL…", command: "jbGit.setRemoteUrl" },
        { label: "$(trash) Remove…", command: "jbGit.removeRemote" },
      ], { title: selected.remote.name, placeHolder: "Select a remote action" });
      if (action) await vscode.commands.executeCommand(action.command, new RemoteNode(root, selected.remote));
    }),
    vscode.commands.registerCommand("jbGit.removeRemote", async (node?: RemoteNode) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(node?.repositoryRoot);
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
      const first = await pickRepository(node?.repositoryRoot);
      if (!first) return;
      const remote = node?.remote ?? (await vscode.window.showQuickPick(
        (await manager.remotes(first.repository.info.rootPath)).map((item) => ({ label: item.name, description: redactGitText(item.fetchUrl), item })),
        { placeHolder: "Select a remote to edit", matchOnDescription: true },
      ))?.item;
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
      const first = await pickRepository(node?.repositoryRoot);
      if (!first) return;
      const name = node?.remote.name ?? (await vscode.window.showQuickPick(
        (await manager.remotes(first.repository.info.rootPath)).map((remote) => remote.name),
        { placeHolder: "Select a remote to fetch" },
      ));
      if (!name) return;
      await runWithNotification(`Fetching ${name}`, (signal) => manager.fetchRemote(node?.repositoryRoot ?? first.repository.info.rootPath, name, signal), true);
    }),
    vscode.commands.registerCommand("jbGit.pushRemote", async (node?: RemoteNode) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(node?.repositoryRoot);
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
      await runWithNotification(`Pushing ${branch} to ${name}`, (signal) => manager.pushRemote(root, name, branch, mode.force, signal), true);
    }),
    vscode.commands.registerCommand("jbGit.applyStash", async (node?: StashNode) => {
      if (!(await requireTrustedWorkspace())) return;
      if (!node) {
        const first = await pickRepository(); if (!first) return;
        const entry = (await vscode.window.showQuickPick((await manager.stashes(first.repository.info.rootPath)).map((item) => ({ label: item.ref, description: item.message, item })), { placeHolder: "Select a stash to apply" }))?.item;
        if (!entry) return; node = new StashNode(first.repository.info.rootPath, entry);
      }
      await runWithNotification(`Applying ${node.entry.ref}`, () => manager.applyStash(node.repositoryRoot, node.entry.ref));
    }),
    vscode.commands.registerCommand("jbGit.popStash", async (node?: StashNode) => {
      if (!(await requireTrustedWorkspace())) return;
      if (!node) {
        const first = await pickRepository(); if (!first) return;
        const entry = (await vscode.window.showQuickPick((await manager.stashes(first.repository.info.rootPath)).map((item) => ({ label: item.ref, description: item.message, item })), { placeHolder: "Select a stash to pop" }))?.item;
        if (!entry) return; node = new StashNode(first.repository.info.rootPath, entry);
      }
      await runWithNotification(`Popping ${node.entry.ref}`, () => manager.applyStash(node.repositoryRoot, node.entry.ref, true));
    }),
    vscode.commands.registerCommand("jbGit.dropStash", async (node?: StashNode) => {
      if (!(await requireTrustedWorkspace())) return;
      if (!node) {
        const first = await pickRepository(); if (!first) return;
        const entry = (await vscode.window.showQuickPick((await manager.stashes(first.repository.info.rootPath)).map((item) => ({ label: item.ref, description: item.message, item })), { placeHolder: "Select a stash to drop" }))?.item;
        if (!entry) return; node = new StashNode(first.repository.info.rootPath, entry);
      }
      const answer = await vscode.window.showWarningMessage(`Drop ${node.entry.ref}?`, { modal: true }, "Drop");
      if (answer !== "Drop") return;
      await runWithNotification(`Dropping ${node.entry.ref}`, () => manager.dropStash(node.repositoryRoot, node.entry.ref));
    }),
    vscode.commands.registerCommand("jbGit.manageStashes", async (rootPath?: string) => {
      const first = await pickRepository(rootPath);
      if (!first) return;
      const root = first.repository.info.rootPath;
      const selected = await vscode.window.showQuickPick([
        { label: "$(add) Stash Current Changes…", action: "create" as const },
        ...(await manager.stashes(root)).map((entry) => ({ label: `$(archive) ${entry.ref}`, description: entry.message, action: "stash" as const, entry })),
      ], { title: "Git Stashes", placeHolder: "Create or manage a stash", matchOnDescription: true });
      if (!selected) return;
      if (selected.action === "create") return void vscode.commands.executeCommand("jbGit.stash", root);
      const action = await vscode.window.showQuickPick([
        { label: "$(check) Apply", command: "jbGit.applyStash" },
        { label: "$(move) Pop", command: "jbGit.popStash" },
        { label: "$(trash) Drop…", command: "jbGit.dropStash" },
      ], { title: `${selected.entry.ref} · ${selected.entry.message}`, placeHolder: "Select a stash action" });
      if (action) await vscode.commands.executeCommand(action.command, new StashNode(root, selected.entry));
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
      if (!(await requireTrustedWorkspace())) return;
      node ??= await pickChangeNode("unstaged");
      if (!node) return;
      await runWithNotification(`Staging ${node.change.path}`, () => manager.stage(node.repositoryRoot, [node.change.path]));
    }),
    vscode.commands.registerCommand("jbGit.unstageChange", async (node?: ChangeNode) => {
      if (!(await requireTrustedWorkspace())) return;
      node ??= await pickChangeNode("staged");
      if (!node) return;
      await runWithNotification(`Unstaging ${node.change.path}`, () => manager.unstage(node.repositoryRoot, [node.change.path]));
    }),
    vscode.commands.registerCommand("jbGit.stageHunk", async (node?: HunkNode) => {
      if (!(await requireTrustedWorkspace())) return;
      node ??= await pickHunkNode("unstaged");
      if (!node) return;
      await runWithNotification(`Staging hunk in ${node.pathSpec}`, () => manager.stageHunk(node.repositoryRoot, node.pathSpec, node.hunk));
    }),
    vscode.commands.registerCommand("jbGit.unstageHunk", async (node?: HunkNode) => {
      if (!(await requireTrustedWorkspace())) return;
      node ??= await pickHunkNode("staged");
      if (!node) return;
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
      if (!(await requireTrustedWorkspace())) return;
      const target = node?.change.conflicted ? node : await pickConflict(manager);
      if (!target) return;
      await openMergeConflictEditor(manager, mergeEditor, target);
    }),
    vscode.commands.registerCommand("jbGit.markResolved", async (node?: ChangeNode) => {
      if (!(await requireTrustedWorkspace()) || !node || !node.change.conflicted) return;
      await runWithNotification(`Marking ${node.change.path} resolved`, () => manager.markResolved(node.repositoryRoot, [node.change.path]));
    }),
  );

  // Startup activation must stay cheap: this finds a repository containing
  // each workspace root (including parent and bare repositories) without a
  // recursive directory crawl. The full nested scan runs when the view opens
  // or when the user explicitly refreshes.
  await manager.discoverAndRefresh(false);
  updateStatusBar();
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

async function openMergeConflictEditor(
  manager: RepositoryManager,
  mergeEditor: MergeConflictEditor,
  node: ChangeNode,
): Promise<void> {
  const opened = await runWithNotification(
    `Loading merge conflict for ${node.change.path}`,
    () => mergeEditor.open(node.repositoryRoot, node.change.path),
  );
  if (opened !== false) return;

  const side = await vscode.window.showQuickPick(
    [
      { label: "Accept ours", value: "ours" as const, description: "Use the complete current-branch binary file" },
      { label: "Accept theirs", value: "theirs" as const, description: "Use the complete incoming binary file" },
    ],
    { title: "Binary merge conflict", placeHolder: `${node.change.path} cannot be merged as text` },
  );
  if (!side) return;
  const answer = await vscode.window.showWarningMessage(
    `Replace ${node.change.path} with ${side.label.toLowerCase()} and mark it resolved?`,
    { modal: true },
    "Resolve",
  );
  if (answer !== "Resolve") return;
  await runWithNotification(`Resolving ${node.change.path}`, async () => {
    await manager.resolveConflict(node.repositoryRoot, node.change.path, side.value);
    await manager.markResolved(node.repositoryRoot, [node.change.path]);
  });
}

async function pickConflict(manager: RepositoryManager): Promise<ChangeNode | undefined> {
  const candidates = manager.all.flatMap((snapshot) => (snapshot.status?.changes ?? [])
    .filter((change) => change.conflicted)
    .map((change) => ({
      label: change.path,
      description: path.basename(snapshot.repository.info.rootPath),
      detail: snapshot.repository.info.rootPath,
      node: new ChangeNode(snapshot.repository.info.rootPath, change),
    })));
  if (candidates.length === 0) {
    await vscode.window.showInformationMessage("There are no unresolved Git conflicts in this workspace.");
    return undefined;
  }
  if (candidates.length === 1) return candidates[0].node;
  return (await vscode.window.showQuickPick(candidates, {
    title: "Open Merge Conflict Editor",
    placeHolder: "Select a conflicted file",
    matchOnDescription: true,
    matchOnDetail: true,
  }))?.node;
}

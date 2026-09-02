import * as path from "node:path";
import * as vscode from "vscode";
import { GitCommandError, GitRunner, isGitAbort, redactGitText } from "./git/runner";
import { type GitRepository, mergeArguments } from "./git/repository";
import type { GitMergeOptions, GitRebaseOptions } from "./git/types";
import { DiffContentProvider, diffSide, openChangeDiff } from "./views/diffProvider";
import { BlameAnnotationController } from "./views/blameDecorations";
import {
  ChangeNode, ChangelistChangeNode, ChangelistNode, HunkNode,
  RemoteNode, ShelfNode, StashNode, SubmoduleNode, WorktreeNode,
} from "./views/nodes";
import { ChangelistStore } from "./changelists/store";
import { ShelfStore } from "./shelves/store";
import { RepositoryManager, type RepositorySnapshot } from "./repositoryManager";
import { IntelliJGitToolWindowProvider } from "./webviews/logPanel";
import { conflictSideLabels, MergeConflictEditor } from "./webviews/mergeEditor";
import { validateGitRefName, validatePathInput, validateRemoteName, validateSingleLine } from "./inputValidation";
import { canonicalPath, deepestContaining } from "./pathRouting";
import { mapLineRangeToHead, selectedLineRange } from "./lineHistory";
import { moveUntrackedToTrash } from "./discardSafety";
import { previewAndPush } from "./pushPreview";
import { checkoutWithLocalChanges } from "./smartCheckout";
import { pullWithLocalChanges, rebaseWithLocalChanges } from "./smartRebase";
import { runInteractiveRebase } from "./interactiveRebaseFlow";
import { FavoriteBranches, recentBranchesFromReflog } from "./branchPopup";

function workspacePaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

function configurationGitPath(): string {
  return vscode.workspace.getConfiguration("jbGit").get<string>("gitPath", "git");
}

/** What a blame hover link and a palette invocation both reduce to. */
export interface BlameLineArgument {
  uri: string;
  line: number;
}

export interface RefreshGenerationBatch {
  readonly roots: ReadonlyMap<string, number>;
  readonly discoveryGeneration?: number;
}

/**
 * Tracks debounced refresh requests without allowing completion of an older
 * refresh to erase work that arrived later (or belongs to another root).
 */
export class RefreshGenerationTracker {
  private readonly roots = new Map<string, number>();
  private generation = 0;
  private discoveryGeneration?: number;

  public addRoot(rootPath: string): void {
    this.roots.set(rootPath, ++this.generation);
  }

  public addDiscovery(): void {
    this.discoveryGeneration = ++this.generation;
  }

  public capture(): RefreshGenerationBatch {
    return {
      roots: new Map(this.roots),
      discoveryGeneration: this.discoveryGeneration,
    };
  }

  public complete(batch: RefreshGenerationBatch): void {
    for (const [root, generation] of batch.roots) {
      if (this.roots.get(root) === generation) this.roots.delete(root);
    }
    if (batch.discoveryGeneration !== undefined && this.discoveryGeneration === batch.discoveryGeneration) {
      this.discoveryGeneration = undefined;
    }
  }

  public get hasPending(): boolean {
    return this.roots.size > 0 || this.discoveryGeneration !== undefined;
  }
}

const WORKTREE_WATCH_IGNORED_SEGMENTS = new Set([".git", "node_modules", ".vscode-test", ".cache"]);

/** Returns true for metadata and dependency/cache trees that must not cause worktree refreshes. */
export function isWorktreeWatchPathIgnored(rootPath: string, filePath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return true;
  return relative.split(/[\\/]+/).some((segment) => WORKTREE_WATCH_IGNORED_SEGMENTS.has(segment.toLowerCase()));
}

export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
  text: string;
}

export function parseGitVersion(value: string): GitVersion | undefined {
  const match = /(?:^|\s)(\d+)\.(\d+)(?:\.(\d+))?/.exec(value);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0), text: value.trim() };
}

function supportsRequiredGitCommands(version: GitVersion): boolean {
  return version.major > 2 || (version.major === 2 && version.minor >= 23);
}

async function requireTrustedWorkspace(): Promise<boolean> {
  if (vscode.workspace.isTrusted) return true;
  await vscode.window.showWarningMessage(vscode.l10n.t("JB Git mutations are disabled until this workspace is trusted."));
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
    if (isGitAbort(error)) return undefined;
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
    if (isGitAbort(error)) return false;
    await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    return false;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const runner = new GitRunner(configurationGitPath());
  const gitRuntimeCheck = runner.version(context.extensionPath).then(async (text) => {
    const version = parseGitVersion(text);
    if (!version) {
      await vscode.window.showWarningMessage(vscode.l10n.t("JB Git could not identify the configured Git version: {0}", text));
    } else if (!supportsRequiredGitCommands(version)) {
      await vscode.window.showWarningMessage(vscode.l10n.t("JB Git requires Git 2.23 or newer; configured runtime is {0}. Switch, restore, and sparse-checkout operations may be unavailable.", version.text));
    }
  }, async (error) => {
    const action = await vscode.window.showErrorMessage(
      `JB Git could not run '${configurationGitPath()}': ${formatGitError(error)}`,
      vscode.l10n.t("Open Settings"),
    );
    if (action === vscode.l10n.t("Open Settings")) await vscode.commands.executeCommand("workbench.action.openSettings", "jbGit.gitPath");
  });
  const manager = new RepositoryManager(runner, workspacePaths);
  const changelistStore = new ChangelistStore(context.workspaceState);
  await changelistStore.load();
  const shelfStore = new ShelfStore(context.globalStorageUri.fsPath);
  const diffProvider = new DiffContentProvider();
  const gitToolWindow = new IntelliJGitToolWindowProvider(manager, changelistStore, shelfStore, diffProvider, context.workspaceState);
  const mergeEditor = new MergeConflictEditor(manager, context.workspaceState, diffProvider);
  const favoriteBranches = new FavoriteBranches(context.workspaceState);
  const blameAnnotations = new BlameAnnotationController(manager, async (target, content) => diffSide(
    diffProvider,
    target.repositoryRoot,
    `${target.relativePath} @ ${target.revision?.slice(0, 8) ?? "working tree"}`,
    target.relativePath,
    content,
  ));
  const traceRegistration = runner.onDidRun((event) => gitToolWindow.appendTrace(event));
  const toolWindowRegistration = vscode.window.registerWebviewViewProvider(
    IntelliJGitToolWindowProvider.viewType,
    gitToolWindow,
    { webviewOptions: { retainContextWhenHidden: true } },
  );
  const toolWindowStatus = vscode.window.createStatusBarItem("jbGit.toolWindowStatus", vscode.StatusBarAlignment.Left, 21);
  toolWindowStatus.name = "JB Git";
  toolWindowStatus.text = "$(source-control) JB Git";
  toolWindowStatus.tooltip = "Open the JB Git tool window";
  toolWindowStatus.command = "jbGit.openGitToolWindow";
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
    if ((vscode.workspace.workspaceFolders ?? []).length) toolWindowStatus.show();
    else toolWindowStatus.hide();
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
    await runWithNotification(vscode.l10n.t("Refreshing Git repositories"), () => manager.discoverAndRefresh());
    updateStatusBar();
  };

  const pendingRefreshes = new RefreshGenerationTracker();
  let refreshTimer: NodeJS.Timeout | undefined;
  let refreshDeadline: number | undefined;
  let refreshInFlight = false;
  let refreshSchedulingDisposed = false;
  const scheduleRefresh = (): void => {
    if (refreshSchedulingDisposed || refreshInFlight) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    const delay = vscode.workspace.getConfiguration("jbGit").get<number>("refreshDebounceMs", 600);
    // A steady event stream (auto-save while typing) must not defer the
    // refresh forever, so the debounce is capped by a hard deadline.
    refreshDeadline ??= Date.now() + Math.max(delay * 4, 2_000);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refreshDeadline = undefined;
      const batch = pendingRefreshes.capture();
      if (!batch.roots.size && batch.discoveryGeneration === undefined) return;
      refreshInFlight = true;
      const roots = [...batch.roots.keys()];
      const operation = batch.discoveryGeneration !== undefined
        ? manager.discoverAndRefresh()
        : Promise.all(roots.map((root) => manager.refresh(root))).then(() => undefined);
      void operation
        .then(updateStatusBar, (error) => vscode.window.showErrorMessage(formatGitError(error)))
        .finally(() => {
          // Only the exact root generations captured by this batch are done.
          // Requests queued while it ran, including another root, remain pending.
          pendingRefreshes.complete(batch);
          refreshInFlight = false;
          if (!refreshSchedulingDisposed && pendingRefreshes.hasPending) scheduleRefresh();
        });
    }, Math.max(0, Math.min(delay, refreshDeadline - Date.now())));
  };
  const scheduleRefreshRoot = (rootPath: string): void => {
    if (!vscode.workspace.getConfiguration("jbGit").get<boolean>("autoRefresh", true)) return;
    pendingRefreshes.addRoot(rootPath);
    scheduleRefresh();
  };
  const scheduleRefreshForPath = (filePath: string): void => {
    if (!vscode.workspace.getConfiguration("jbGit").get<boolean>("autoRefresh", true)) return;
    void canonicalPath(filePath).then((candidate) => {
      const snapshot = deepestContaining(manager.all, candidate, (item) => item.repository.info.rootPath);
      if (!snapshot || snapshot.repository.info.isBare) return;
      const root = snapshot.repository.info.rootPath;
      if (!isWorktreeWatchPathIgnored(root, candidate)) scheduleRefreshRoot(root);
    });
  };
  const scheduleDiscovery = (): void => {
    if (!vscode.workspace.getConfiguration("jbGit").get<boolean>("autoRefresh", true)) return;
    pendingRefreshes.addDiscovery();
    scheduleRefresh();
  };
  // This watcher is only for discovering newly-created or removed repositories.
  // Repository state itself is watched through metadata and worktree paths below.
  const gitMetadataWatcher = vscode.workspace.createFileSystemWatcher("**/.git");
  const repositoryMetadataWatchers = new Map<string, vscode.FileSystemWatcher[]>();
  const repositoryWorktreeWatchers = new Map<string, vscode.FileSystemWatcher>();
  const metadataPatterns = [
    "HEAD", "index", "packed-refs", "refs/**", "MERGE_HEAD", "CHERRY_PICK_HEAD",
    "REVERT_HEAD", "BISECT_LOG", "rebase-merge/**", "rebase-apply/**", "sequencer/**",
  ];
  const rebuildRepositoryWatchers = (): void => {
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

    const worktreeRoots = new Set(manager.all
      .filter((snapshot) => !snapshot.repository.info.isBare)
      .map((snapshot) => snapshot.repository.info.rootPath));
    for (const [root, watcher] of repositoryWorktreeWatchers) {
      if (!worktreeRoots.has(root)) {
        watcher.dispose();
        repositoryWorktreeWatchers.delete(root);
      }
    }
    for (const root of worktreeRoots) {
      if (repositoryWorktreeWatchers.has(root)) continue;
      // Text-document/workspace events only cover edits made through VS Code.
      // A filesystem watcher is required for formatters, generators, and other
      // external tools that modify ordinary worktree files.
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "**/*"));
      const onWorktreeChange = (uri: vscode.Uri): void => {
        // Filter before canonicalisation so dependency/cache event storms do
        // not create one realpath lookup per file.
        if (!isWorktreeWatchPathIgnored(root, uri.fsPath)) scheduleRefreshForPath(uri.fsPath);
      };
      watcher.onDidChange(onWorktreeChange);
      watcher.onDidCreate(onWorktreeChange);
      watcher.onDidDelete(onWorktreeChange);
      repositoryWorktreeWatchers.set(root, watcher);
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
      { placeHolder: vscode.l10n.t("Select a Git repository") },
    ))?.snapshot;
  };
  const pickWorkspaceRoot = async (): Promise<string | undefined> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length <= 1) return folders[0]?.uri.fsPath;
    return (await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, rootPath: folder.uri.fsPath })),
      { placeHolder: vscode.l10n.t("Select a workspace folder") },
    ))?.rootPath;
  };
  const pickChangeNode = async (mode: "staged" | "unstaged", rootPath?: string): Promise<ChangeNode | undefined> => {
    const snapshot = await pickRepository(rootPath);
    if (!snapshot?.status) return;
    const changes = snapshot.status.changes.filter((change) => mode === "staged" ? change.staged : change.unstaged);
    if (!changes.length) {
      await vscode.window.showInformationMessage(vscode.l10n.t("There are no {0} changes.", mode === "staged" ? vscode.l10n.t("staged") : vscode.l10n.t("unstaged")));
      return undefined;
    }
    const selected = await vscode.window.showQuickPick(
      changes.map((change) => ({ label: change.path, description: change.kind, change })),
      { title: mode === "staged" ? vscode.l10n.t("Staged Changes") : vscode.l10n.t("Unstaged Changes"), placeHolder: vscode.l10n.t("Select a changed file"), matchOnDescription: true },
    );
    return selected ? new ChangeNode(snapshot.repository.info.rootPath, selected.change, mode) : undefined;
  };
  const pickHunkNode = async (mode: "staged" | "unstaged", rootPath?: string): Promise<HunkNode | undefined> => {
    const change = await pickChangeNode(mode, rootPath);
    if (!change || change.change.conflicted || change.change.kind === "untracked") return;
    const hunks = await manager.diffHunks(change.repositoryRoot, change.change.path, mode === "staged");
    if (!hunks.length) {
      await vscode.window.showInformationMessage(vscode.l10n.t("No {0} text hunks were found in {1}.", mode === "staged" ? vscode.l10n.t("staged") : vscode.l10n.t("unstaged"), change.change.path));
      return;
    }
    const selected = await vscode.window.showQuickPick(
      hunks.map((hunk, index) => ({
        label: hunk.header,
        description: hunk.lines.find((line) => line.startsWith("+") || line.startsWith("-"))?.slice(0, 100),
        hunk,
        index,
      })),
      { title: change.change.path, placeHolder: mode === "staged" ? vscode.l10n.t("Select a hunk to unstage") : vscode.l10n.t("Select a hunk to stage"), matchOnDescription: true },
    );
    return selected ? new HunkNode(change.repositoryRoot, change.change.path, mode, selected.index, selected.hunk) : undefined;
  };

  // git stash apply/pop exits non-zero after writing conflict markers, and pop then keeps
  // the entry; a raw error dialog invited running Pop again on top of the conflicts.
  const applyStashReportingConflicts = async (node: StashNode, pop: boolean): Promise<void> => {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `${pop ? "Popping" : "Applying"} ${node.entry.ref}` },
        () => manager.applyStash(node.repositoryRoot, node.entry.ref, pop, node.entry.oid),
      );
    } catch (error) {
      const snapshot = manager.snapshot(node.repositoryRoot);
      const conflicted = snapshot?.status?.changes.some((change) => change.conflicted);
      if (!conflicted) throw error;
      await vscode.window.showWarningMessage(
        `The stash was applied with conflicts.${pop ? " The stash entry was kept; do not pop it again." : ""} Resolve the conflicted files in Local Changes.`,
      );
    }
  };

  /** The document a blame command should act on: the one passed by a menu, else the active one. */
  const blameDocument = async (resource?: vscode.Uri): Promise<vscode.TextDocument | undefined> => {
    const active = vscode.window.activeTextEditor?.document;
    if (!(resource instanceof vscode.Uri)) return active;
    if (active?.uri.toString() === resource.toString()) return active;
    return vscode.workspace.openTextDocument(resource);
  };
  /** A hover link carries its own line; from the palette the caret is the line. */
  const blameLocation = (argument?: BlameLineArgument): { uri: vscode.Uri; line: number } | undefined => {
    if (argument && typeof argument.uri === "string" && Number.isInteger(argument.line)) {
      return { uri: vscode.Uri.parse(argument.uri), line: argument.line };
    }
    const editor = vscode.window.activeTextEditor;
    return editor ? { uri: editor.document.uri, line: editor.selection.active.line } : undefined;
  };
  const annotatedLine = (argument?: BlameLineArgument) => {
    const location = blameLocation(argument);
    if (!location) return undefined;
    const entry = blameAnnotations.entryAt(location.uri, location.line);
    const target = blameAnnotations.targetFor(location.uri);
    if (!entry || !target || entry.uncommitted) return undefined;
    return { entry, target };
  };
  const requireAnnotatedLine = async (argument?: BlameLineArgument) => {
    const found = annotatedLine(argument);
    if (!found) {
      await vscode.window.showInformationMessage(
        "Run 'JB Git: Annotate with Git Blame' on the file and put the caret on a committed line first.",
      );
    }
    return found;
  };

  context.subscriptions.push(
    manager,
    changelistStore,
    shelfStore,
    blameAnnotations,
    gitToolWindow,
    mergeEditor,
    traceRegistration,
    toolWindowRegistration,
    diffProvider,
    gitMetadataWatcher,
    { dispose: () => {
      refreshSchedulingDisposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      for (const watchers of repositoryMetadataWatchers.values()) for (const watcher of watchers) watcher.dispose();
      repositoryMetadataWatchers.clear();
      for (const watcher of repositoryWorktreeWatchers.values()) watcher.dispose();
      repositoryWorktreeWatchers.clear();
    } },
    vscode.workspace.registerFileSystemProvider(DiffContentProvider.scheme, diffProvider, {
      isCaseSensitive: true,
      isReadonly: true,
    }),
    toolWindowStatus,
    branchStatus,
    outputChannel,
    manager.onDidChange(() => {
      updateStatusBar();
      // A commit, an amend or a checkout changes who each line belongs to.
      blameAnnotations.refresh();
      rebuildRepositoryWatchers();
      for (const snapshot of manager.all) {
        if (snapshot.status) {
          void changelistStore.reconcile(snapshot.repository.info.rootPath, snapshot.status.changes)
            .catch((error) => vscode.window.showErrorMessage(formatGitError(error)));
        }
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("jbGit.gitPath")) return;
      void vscode.window.showInformationMessage(vscode.l10n.t("Reload VS Code to use the new JB Git executable."), vscode.l10n.t("Reload")).then((choice) => {
        if (choice === vscode.l10n.t("Reload")) void vscode.commands.executeCommand("workbench.action.reloadWindow");
      });
    }),
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
      // Cancellable: reading a large blob out of Git is the one step here that
      // can take long enough for a notification with no way out to feel stuck.
      await runWithNotification(
        vscode.l10n.t("Loading diff for {0}", node.change.path),
        (signal) => openChangeDiff(manager, diffProvider, node, signal),
        true,
      );
    }),
    vscode.commands.registerCommand("jbGit.showHistory", () => gitToolWindow.open()),
    vscode.commands.registerCommand("jbGit.openGitToolWindow", (rootPath?: string) => gitToolWindow.open(rootPath)),
    vscode.commands.registerCommand("jbGit.branchesPopup", async (rootPath?: string) => {
      const snapshot = await pickRepository(rootPath);
      if (!snapshot) return void vscode.window.showInformationMessage(vscode.l10n.t("No Git repository was found in this workspace."));
      type Branch = typeof snapshot.branches[number];
      type BranchAction = vscode.QuickPickItem & { action?: "new" | "fetch" | "pull" | "push" | "log" | "update"; branch?: Branch };
      const root = snapshot.repository.info.rootPath;
      const current = snapshot.status?.branch.head;
      // IDEA's popup groups: Recent (from the reflog) and Favorites (starred
      // here, kept per workspace) above the plain lists. Favorites are keyed by
      // kind as well as name, since `origin/x` can be both a remote-tracking
      // and, in principle, a local branch.
      const favoriteKey = (branch: Branch) => `${branch.kind}:${branch.name}`;
      const existing = new Set(snapshot.branches.filter((branch) => branch.kind !== "tag").map(favoriteKey));
      await favoriteBranches.prune(root, existing);
      const localNames = new Set(snapshot.branches.filter((branch) => branch.kind === "local").map((branch) => branch.name));
      const recent = recentBranchesFromReflog(await manager.reflogSubjects(root).catch(() => []), localNames, current);
      const starButton = (starred: boolean): vscode.QuickInputButton => ({
        iconPath: new vscode.ThemeIcon(starred ? "star-full" : "star-empty"),
        tooltip: starred ? vscode.l10n.t("Remove from Favorites") : vscode.l10n.t("Add to Favorites"),
      });
      const updateButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("sync"), tooltip: vscode.l10n.t("Update from upstream") };
      const branchItem = (branch: Branch, icon?: string): BranchAction => {
        const starred = favoriteBranches.has(root, favoriteKey(branch));
        const buttons: vscode.QuickInputButton[] = [];
        if (branch.kind === "local" && branch.upstream && !branch.upstreamGone) buttons.push(updateButton);
        if (branch.kind !== "tag") buttons.push(starButton(starred));
        const glyph = icon ?? (branch.kind === "tag" ? "$(tag)" : branch.kind === "remote" ? "$(cloud)" : branch.name === current ? "$(check)" : "$(git-branch)");
        return {
          label: `${glyph} ${branch.name}`,
          description: branch.kind === "local" && branch.upstream ? `${branch.upstream}${branch.tracking ? ` · ${branch.tracking}` : ""}` : undefined,
          branch,
          buttons,
        };
      };
      const build = (): BranchAction[] => {
        const favorites = snapshot.branches.filter((branch) => branch.kind !== "tag" && favoriteBranches.has(root, favoriteKey(branch)));
        const recentBranches = recent.map((name) => snapshot.branches.find((branch) => branch.kind === "local" && branch.name === name)).filter((branch): branch is Branch => Boolean(branch));
        return [
          { label: `$(add) ${vscode.l10n.t("New Branch")}`, description: vscode.l10n.t("from {0}", current ?? "HEAD"), action: "new" },
          { label: `$(git-pull-request-go-to-changes) ${vscode.l10n.t("Fetch")}`, action: "fetch" },
          { label: `$(cloud-download) ${vscode.l10n.t("Pull…")}`, action: "pull" },
          { label: `$(cloud-upload) ${vscode.l10n.t("Push…")}`, action: "push" },
          { label: `$(git-commit) ${vscode.l10n.t("Show Git Log")}`, action: "log" },
          ...(recentBranches.length ? [{ label: vscode.l10n.t("Recent"), kind: vscode.QuickPickItemKind.Separator }, ...recentBranches.map((branch) => branchItem(branch, "$(history)"))] : []),
          ...(favorites.length ? [{ label: vscode.l10n.t("Favorites"), kind: vscode.QuickPickItemKind.Separator }, ...favorites.map((branch) => branchItem(branch))] : []),
          { label: vscode.l10n.t("Local Branches"), kind: vscode.QuickPickItemKind.Separator },
          ...snapshot.branches.filter((branch) => branch.kind === "local").map((branch) => branchItem(branch)),
          { label: vscode.l10n.t("Remote Branches"), kind: vscode.QuickPickItemKind.Separator },
          ...snapshot.branches.filter((branch) => branch.kind === "remote").map((branch) => branchItem(branch)),
          { label: vscode.l10n.t("Tags"), kind: vscode.QuickPickItemKind.Separator },
          ...snapshot.branches.filter((branch) => branch.kind === "tag").map((branch) => branchItem(branch)),
        ];
      };
      const picker = vscode.window.createQuickPick<BranchAction>();
      picker.title = `${path.basename(root)} · ${current ?? "detached HEAD"}`;
      picker.placeholder = vscode.l10n.t("Git branches and common operations");
      picker.matchOnDescription = true;
      picker.items = build();
      const selected = await new Promise<BranchAction | undefined>((resolve) => {
        picker.onDidTriggerItemButton(async (event) => {
          if (!event.item.branch) return;
          if (event.button === updateButton) {
            resolve({ ...event.item, action: "update" });
            picker.hide();
            return;
          }
          // Starring keeps the popup open, like IDEA's star.
          await favoriteBranches.toggle(root, favoriteKey(event.item.branch));
          picker.items = build();
        });
        picker.onDidAccept(() => { resolve(picker.selectedItems[0]); picker.hide(); });
        picker.onDidHide(() => { resolve(undefined); picker.dispose(); });
        picker.show();
      });
      if (!selected) return;
      if (selected.action === "update" && selected.branch) {
        if (!(await requireTrustedWorkspace())) return;
        if (selected.branch.name === current) {
          await vscode.commands.executeCommand("jbGit.pull", root);
          return;
        }
        await runWithNotification(vscode.l10n.t("Updating {0} from {1}", selected.branch.name, selected.branch.upstream ?? "upstream"), () => manager.updateBranch(root, selected.branch!.name));
        return;
      }
      if (selected.branch) {
        if (selected.branch.kind === "local" && selected.branch.name === current) return;
        await runWithNotification(vscode.l10n.t("Checking out {0}", selected.branch.name), () => checkoutWithLocalChanges(manager, root, selected.branch!));
      } else if (selected.action === "new") {
        const name = await vscode.window.showInputBox({ title: vscode.l10n.t("New Branch"), prompt: vscode.l10n.t("Create from {0}", current ?? "HEAD"), validateInput: (value) => validateGitRefName(value) });
        if (name?.trim()) await runWithNotification(vscode.l10n.t("Creating branch {0}", name.trim()), () => manager.createBranch(root, name.trim()));
      } else if (selected.action === "fetch") await runWithNotification(vscode.l10n.t("Fetching remotes"), () => manager.fetch(root));
      else if (selected.action === "pull") await vscode.commands.executeCommand("jbGit.pull", root);
      else if (selected.action === "push") await vscode.commands.executeCommand("jbGit.push", root);
      else if (selected.action === "log") await gitToolWindow.open(root);
    }),
    vscode.commands.registerCommand("jbGit.operationsPopup", async (rootPath?: string) => {
      const snapshot = await pickRepository(rootPath);
      if (!snapshot) return void vscode.window.showInformationMessage(vscode.l10n.t("No Git repository was found in this workspace."));
      const root = snapshot.repository.info.rootPath;
      type OperationItem = vscode.QuickPickItem & { command?: string };
      const items: OperationItem[] = [
        { label: vscode.l10n.t("Common"), kind: vscode.QuickPickItemKind.Separator },
        { label: `$(check) ${vscode.l10n.t("Commit…")}`, command: "jbGit.openChanges" },
        { label: `$(cloud-upload) ${vscode.l10n.t("Push…")}`, command: "jbGit.push" },
        { label: `$(cloud-download) ${vscode.l10n.t("Pull…")}`, command: "jbGit.pull" },
        { label: `$(sync) ${vscode.l10n.t("Fetch")}`, command: "jbGit.fetch" },
        { label: `$(git-branch) ${vscode.l10n.t("Branches…")}`, command: "jbGit.branchesPopup" },
        { label: `$(git-commit) ${vscode.l10n.t("Git Log")}`, command: "jbGit.openGitToolWindow" },
        { label: vscode.l10n.t("History rewriting"), kind: vscode.QuickPickItemKind.Separator },
        { label: `$(git-merge) ${vscode.l10n.t("Merge…")}`, command: "jbGit.merge" },
        { label: `$(git-compare) ${vscode.l10n.t("Rebase…")}`, command: "jbGit.rebase" },
        { label: `$(list-ordered) ${vscode.l10n.t("Interactively Rebase…")}`, command: "jbGit.interactiveRebase" },
        { label: `$(merge) ${vscode.l10n.t("Resolve Simple Conflicts")}`, command: "jbGit.resolveSimpleConflicts" },
        { label: `$(git-commit) ${vscode.l10n.t("Cherry-pick…")}`, command: "jbGit.cherryPick" },
        { label: `$(discard) ${vscode.l10n.t("Revert…")}`, command: "jbGit.revert" },
        { label: `$(debug-restart) ${vscode.l10n.t("Reset HEAD…")}`, command: "jbGit.reset" },
        { label: vscode.l10n.t("Save work"), kind: vscode.QuickPickItemKind.Separator },
        { label: `$(archive) ${vscode.l10n.t("Manage Stashes…")}`, command: "jbGit.manageStashes" },
        { label: `$(package) ${vscode.l10n.t("Shelve Changes…")}`, command: "jbGit.createShelf" },
        { label: `$(file-code) ${vscode.l10n.t("Apply Patch…")}`, command: "jbGit.applyPatch" },
        { label: vscode.l10n.t("Repository"), kind: vscode.QuickPickItemKind.Separator },
        { label: `$(remote) ${vscode.l10n.t("Manage Remotes…")}`, command: "jbGit.manageRemotes" },
        { label: `$(repo-forked) ${vscode.l10n.t("Manage Worktrees…")}`, command: "jbGit.manageWorktrees" },
        { label: `$(file-submodule) ${vscode.l10n.t("Manage Submodules…")}`, command: "jbGit.manageSubmodules" },
        { label: `$(tag) ${vscode.l10n.t("Create Tag…")}`, command: "jbGit.createTag" },
        { label: `$(list-tree) ${vscode.l10n.t("Configure Sparse Checkout…")}`, command: "jbGit.sparseCheckoutSet" },
        { label: `$(cloud-download) ${vscode.l10n.t("Pull LFS Objects")}`, command: "jbGit.lfsPull" },
        { label: vscode.l10n.t("Diagnostics"), kind: vscode.QuickPickItemKind.Separator },
        { label: `$(debug-alt) ${vscode.l10n.t("Bisect Start…")}`, command: "jbGit.bisectStart" },
      ];
      const selected = await vscode.window.showQuickPick(items, {
        title: vscode.l10n.t("Git · {0}", snapshot.status?.branch.head ?? "detached HEAD"),
        placeHolder: vscode.l10n.t("Select a Git operation"),
      });
      if (selected?.command) await vscode.commands.executeCommand(selected.command, root);
    }),
    vscode.commands.registerCommand("jbGit.fileHistory", async (resource?: vscode.Uri) => {
      const uri = resource?.scheme === "file" ? resource : vscode.window.activeTextEditor?.document.uri;
      if (!uri || uri.scheme !== "file") return void vscode.window.showInformationMessage(vscode.l10n.t("Open or select a file before showing its Git history."));
      // The repository root is canonical, so the file must be too: through a
      // symlinked directory the editor's path would otherwise leave the root.
      const filePath = await canonicalPath(uri.fsPath);
      const snapshot = deepestContaining(manager.all, filePath, (item) => item.repository.info.rootPath);
      if (!snapshot) return void vscode.window.showInformationMessage(vscode.l10n.t("The active file is not inside a discovered Git repository."));
      const relativePath = path.relative(snapshot.repository.info.rootPath, filePath);
      await gitToolWindow.open(snapshot.repository.info.rootPath, relativePath);
    }),
    vscode.commands.registerCommand("jbGit.compareWithBranch", async (resource?: vscode.Uri) => {
      // IDEA's Compare with Branch…: the file as it is on another branch (or
      // tag) against the working copy, in the native diff.
      const located = await locateFile(manager, resource, vscode.l10n.t("Open or select a file before comparing it with a branch."));
      if (!located) return;
      const { snapshot, root, relativePath } = located;
      const current = snapshot.status?.branch.head;
      const branch = await vscode.window.showQuickPick(
        snapshot.branches.filter((candidate) => !(candidate.kind === "local" && candidate.name === current)).map((candidate) => ({
          label: `${candidate.kind === "tag" ? "$(tag)" : candidate.kind === "remote" ? "$(cloud)" : "$(git-branch)"} ${candidate.name}`,
          candidate,
        })),
        { title: vscode.l10n.t("Compare {0} with branch", relativePath), placeHolder: vscode.l10n.t("Branch or tag to compare the working copy with") },
      );
      if (!branch) return;
      await compareFileWithRef(diffProvider, snapshot.repository, root, relativePath, branch.candidate.fullName, branch.candidate.name);
    }),
    vscode.commands.registerCommand("jbGit.compareWithRevision", async (resource?: vscode.Uri) => {
      // IDEA's Compare with Revision…: pick a commit from the file's own
      // history — followed through renames — and diff that version with the
      // working copy.
      const located = await locateFile(manager, resource, vscode.l10n.t("Open or select a file before comparing it with a revision."));
      if (!located) return;
      const { snapshot, root, relativePath } = located;
      const history = await snapshot.repository.logRef("HEAD", 100, relativePath, { exactPath: true, follow: true }).catch(() => []);
      if (!history.length) return void vscode.window.showInformationMessage(vscode.l10n.t("{0} has not been committed yet, so its lines have no history.", relativePath));
      const picked = await vscode.window.showQuickPick(
        history.map((commit) => ({
          label: `${commit.hash.slice(0, 8)} ${commit.subject}`,
          description: `${commit.author} · ${new Date(commit.authoredAt).toLocaleDateString()}`,
          commit,
        })),
        { title: vscode.l10n.t("Compare {0} with revision", relativePath), placeHolder: vscode.l10n.t("Revision to compare the working copy with"), matchOnDescription: true },
      );
      if (!picked) return;
      await compareFileWithRef(diffProvider, snapshot.repository, root, relativePath, picked.commit.hash, picked.commit.hash.slice(0, 8));
    }),
    vscode.commands.registerCommand("jbGit.historyForSelection", async () => {
      // IDEA's Show History for Selection: the Log narrowed to the commits
      // that touched the selected lines, followed through renames by Git.
      const editor = vscode.window.activeTextEditor;
      const uri = editor?.document.uri;
      if (!editor || !uri || uri.scheme !== "file") return void vscode.window.showInformationMessage(vscode.l10n.t("Select lines in a file before showing their history."));
      const filePath = await canonicalPath(uri.fsPath);
      const snapshot = deepestContaining(manager.all, filePath, (item) => item.repository.info.rootPath);
      if (!snapshot) return void vscode.window.showInformationMessage(vscode.l10n.t("The active file is not inside a discovered Git repository."));
      const root = snapshot.repository.info.rootPath;
      const relativePath = path.relative(root, filePath);
      if (editor.document.isDirty) {
        // The selection is matched to the committed file through the on-disk
        // diff, which cannot see unsaved text.
        const save = vscode.l10n.t("Save and Show");
        const answer = await vscode.window.showInformationMessage(vscode.l10n.t("Save {0} so the selected lines can be matched to the committed file?", path.basename(filePath)), save);
        if (answer !== save || !(await editor.document.save())) return;
      }
      if (!(await manager.isTrackedAtHead(root, relativePath))) {
        return void vscode.window.showInformationMessage(vscode.l10n.t("{0} has not been committed yet, so its lines have no history.", relativePath));
      }
      const { hunks } = await manager.diffAgainstHead(root, relativePath);
      const selection = selectedLineRange(editor.selection.start.line, editor.selection.end.line, editor.selection.end.character);
      const committed = mapLineRangeToHead(hunks, selection);
      if (!committed) return void vscode.window.showInformationMessage(vscode.l10n.t("The selected lines have not been committed yet, so they have no history."));
      await gitToolWindow.open(root, relativePath, "log", { path: relativePath, ...committed });
    }),
    vscode.commands.registerCommand("jbGit.blame", async (resource?: vscode.Uri) => {
      const uri = resource?.scheme === "file" ? resource : vscode.window.activeTextEditor?.document.uri;
      if (!uri || uri.scheme !== "file") {
        await vscode.window.showInformationMessage(vscode.l10n.t("Open or select a file before running JB Git Blame."));
        return;
      }
      const filePath = await canonicalPath(uri.fsPath);
      const snapshot = deepestContaining(manager.all, filePath, (item) => item.repository.info.rootPath);
      if (!snapshot) {
        await vscode.window.showInformationMessage(vscode.l10n.t("The active file is not inside a discovered Git repository."));
        return;
      }
      const relativePath = path.relative(snapshot.repository.info.rootPath, filePath);
      const entries = await runWithNotification(vscode.l10n.t("Blaming {0}", relativePath), () => manager.blame(snapshot.repository.info.rootPath, relativePath));
      if (!entries) return;
      showOutput(`Blame · ${relativePath}`, entries.map((entry) => `${String(entry.finalLine).padStart(5)} ${entry.hash.slice(0, 12)} ${entry.author} ${entry.authorTime.slice(0, 10)}  ${entry.content}`).join("\n"));
    }),
    vscode.commands.registerCommand("jbGit.toggleBlameAnnotations", async (resource?: vscode.Uri) => {
      const document = await blameDocument(resource);
      if (!document) {
        await vscode.window.showInformationMessage(vscode.l10n.t("Open or select a file before annotating it."));
        return;
      }
      if (vscode.window.activeTextEditor?.document !== document) await vscode.window.showTextDocument(document, { preview: false });
      await blameAnnotations.toggle(document);
    }),
    vscode.commands.registerCommand("jbGit.annotatePreviousRevision", async (argument?: BlameLineArgument) => {
      const location = blameLocation(argument);
      if (!location) return;
      await blameAnnotations.annotatePrevious(location.uri, location.line);
    }),
    vscode.commands.registerCommand("jbGit.blameHideRevision", async (argument?: BlameLineArgument) => {
      const found = await requireAnnotatedLine(argument);
      if (!found) return;
      const location = blameLocation(argument)!;
      await blameAnnotations.hideRevision(location.uri, location.line);
    }),
    vscode.commands.registerCommand("jbGit.blameShowHiddenRevisions", async (argument?: BlameLineArgument | vscode.Uri) => {
      const uri = argument instanceof vscode.Uri ? argument : blameLocation(argument)?.uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri) return;
      const shown = await blameAnnotations.showHiddenRevisions(uri);
      if (!shown) await vscode.window.showInformationMessage(vscode.l10n.t("No revision is hidden in this annotation."));
    }),
    vscode.commands.registerCommand("jbGit.annotateRevision", async (resource?: vscode.Uri) => {
      const document = await blameDocument(resource);
      if (!document) {
        await vscode.window.showInformationMessage(vscode.l10n.t("Open or select a file before annotating it."));
        return;
      }
      // An already-annotated revision document knows the repository and the
      // path it had back then; anything else is resolved from the workspace.
      const known = blameAnnotations.targetFor(document.uri);
      const file = known ?? (document.uri.scheme === "file" ? await (async () => {
        const canonical = await canonicalPath(document.uri.fsPath);
        const snapshot = deepestContaining(manager.all, canonical, (item) => item.repository.info.rootPath);
        return snapshot && {
          repositoryRoot: snapshot.repository.info.rootPath,
          relativePath: path.relative(snapshot.repository.info.rootPath, canonical),
        };
      })() : undefined);
      if (!file) {
        await vscode.window.showInformationMessage(vscode.l10n.t("The active file is not inside a discovered Git repository."));
        return;
      }
      const revision = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Annotate {0} as of which revision?", file.relativePath),
        placeHolder: vscode.l10n.t("Commit, tag or branch — for example HEAD~5"),
        validateInput: (value) => validateSingleLine(value, "Revision"),
      });
      if (!revision?.trim()) return;
      try {
        await blameAnnotations.annotateAt({ ...file, revision: revision.trim() });
      } catch (error) {
        await vscode.window.showErrorMessage(vscode.l10n.t("Could not annotate {0} at {1}: {2}", file.relativePath, revision.trim(), formatGitError(error)));
      }
    }),
    vscode.commands.registerCommand("jbGit.copyRevisionNumber", async (argument?: BlameLineArgument) => {
      const found = await requireAnnotatedLine(argument);
      if (!found) return;
      await vscode.env.clipboard.writeText(found.entry.hash);
      await vscode.window.showInformationMessage(vscode.l10n.t("Copied {0} to the clipboard.", found.entry.hash));
    }),
    vscode.commands.registerCommand("jbGit.blameShowCommit", async (argument?: BlameLineArgument) => {
      const found = await requireAnnotatedLine(argument);
      if (!found) return;
      const short = found.entry.hash.slice(0, 8);
      if (await gitToolWindow.revealCommit(found.target.repositoryRoot, found.entry.hash)) return;
      // The Log holds a window of history. Rather than quietly selecting some
      // other commit, show the one that was asked for as its own patch.
      const repository = manager.snapshot(found.target.repositoryRoot)?.repository;
      if (!repository) return;
      const patch = await runWithNotification(vscode.l10n.t("Reading commit {0}", short), () => repository.showCommit(found.entry.hash));
      if (patch === undefined) return;
      const uri = diffProvider.registerFile(found.target.repositoryRoot, `Commit ${short}`, `${short}.diff`, patch);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
      await vscode.window.showInformationMessage(vscode.l10n.t("Commit {0} is older than the history the Log has loaded, so it opened as a patch.", short));
    }),
    vscode.commands.registerCommand("jbGit.initializeRepository", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const root = await pickWorkspaceRoot();
      if (!root) {
        await vscode.window.showInformationMessage(vscode.l10n.t("Open a folder before initializing a Git repository."));
        return;
      }
      const initialized = await runWithNotification(vscode.l10n.t("Initializing Git repository"), () => manager.initializeRepository(root));
      if (initialized === false) await vscode.window.showInformationMessage(vscode.l10n.t("This folder is already inside a Git repository; no nested repository was created."));
    }),
    vscode.commands.registerCommand("jbGit.cloneRepository", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const source = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Repository URL or local path"), placeHolder: vscode.l10n.t("https://example.com/repository.git"), validateInput: (value) => validateSingleLine(value, "Repository URL or path") });
      if (!source?.trim()) return;
      const destination = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Destination folder"), placeHolder: vscode.l10n.t("./repository"), validateInput: (value) => validatePathInput(value) });
      if (!destination?.trim()) return;
      const mode = await vscode.window.showQuickPick(
        [{ label: vscode.l10n.t("Standard clone"), bare: false }, { label: vscode.l10n.t("Bare clone"), bare: true }],
        { placeHolder: vscode.l10n.t("Clone type") },
      );
      if (!mode) return;
      const cloneRoot = await pickWorkspaceRoot();
      if (!cloneRoot) return void vscode.window.showInformationMessage(vscode.l10n.t("Open a folder before cloning a repository."));
      const cloned = await runWithNotificationResult(
        `Cloning ${source.trim()}`,
        (signal) => manager.clone(source.trim(), destination.trim(), mode.bare, cloneRoot, signal),
        true,
      );
      if (cloned && !mode.bare) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(path.resolve(cloneRoot, destination.trim())), { forceNewWindow: false });
    }),
    vscode.commands.registerCommand("jbGit.fetch", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      await runWithNotification(vscode.l10n.t("Fetching Git remotes"), (signal) => manager.fetch(rootPath, signal), true);
    }),
    vscode.commands.registerCommand("jbGit.applyPatch", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const files = await vscode.window.showOpenDialog({
        canSelectMany: false, canSelectFiles: true, canSelectFolders: false, openLabel: "Apply Patch",
        filters: { "Patch files": ["patch", "diff"], "All files": ["*"] },
      });
      const patchFile = files?.[0];
      if (!patchFile) return;
      if (patchFile.scheme !== "file") {
        return void vscode.window.showWarningMessage(vscode.l10n.t("Patches can only be applied from the local file system."));
      }
      await runWithNotification(vscode.l10n.t("Applying {0}", path.basename(patchFile.fsPath)), () => manager.applyPatch(first.repository.info.rootPath, patchFile.fsPath));
    }),
    vscode.commands.registerCommand("jbGit.sparseCheckoutSet", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const input = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Sparse-checkout paths (comma-separated)"),
        placeHolder: vscode.l10n.t("src,docs"),
        validateInput: (value) => value.split(",").map((item) => item.trim()).filter(Boolean).map((item) => validatePathInput(item)).find(Boolean),
      });
      if (!input?.trim()) return;
      const paths = input.split(",").map((item) => item.trim()).filter(Boolean);
      const confirmed = await vscode.window.showWarningMessage(
        `Restrict the working tree to ${paths.join(", ")}?`,
        { modal: true, detail: vscode.l10n.t("Every file outside these directories is removed from the working tree until sparse checkout is disabled.") },
        vscode.l10n.t("Restrict"),
      );
      if (confirmed !== vscode.l10n.t("Restrict")) return;
      await runWithNotification(vscode.l10n.t("Configuring sparse checkout"), () => manager.sparseCheckoutSet(first.repository.info.rootPath, paths));
    }),
    vscode.commands.registerCommand("jbGit.sparseCheckoutDisable", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Disable sparse checkout and restore all files?"), { modal: true }, vscode.l10n.t("Disable"));
      if (answer !== vscode.l10n.t("Disable")) return;
      await runWithNotification(vscode.l10n.t("Disabling sparse checkout"), () => manager.sparseCheckoutDisable(first.repository.info.rootPath));
    }),
    vscode.commands.registerCommand("jbGit.lfsPull", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      await runWithNotification(vscode.l10n.t("Pulling Git LFS objects"), (signal) => manager.lfsPull(first.repository.info.rootPath, signal), true);
    }),
    vscode.commands.registerCommand("jbGit.commit", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return void vscode.window.showInformationMessage(vscode.l10n.t("No Git repository was found in this workspace."));
      const message = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Commit message"), placeHolder: vscode.l10n.t("Describe the staged changes") });
      if (!message?.trim()) return;
      // The choice carries its semantics as data: sniffing English words out
      // of the label breaks silently the moment the label is translated.
      const mode = await vscode.window.showQuickPick(
        [
          { label: vscode.l10n.t("Commit"), description: vscode.l10n.t("Create a new commit"), amend: false, signoff: false, noVerify: false },
          { label: vscode.l10n.t("Amend"), description: vscode.l10n.t("Amend the current HEAD commit"), amend: true, signoff: false, noVerify: false },
          { label: vscode.l10n.t("Sign-off"), description: vscode.l10n.t("Create a signed-off commit"), amend: false, signoff: true, noVerify: false },
          { label: vscode.l10n.t("Amend and sign-off"), description: vscode.l10n.t("Amend HEAD and add a sign-off trailer"), amend: true, signoff: true, noVerify: false },
          { label: vscode.l10n.t("Commit without hooks"), description: vscode.l10n.t("Skip client-side commit hooks"), amend: false, signoff: false, noVerify: true },
        ],
        { placeHolder: vscode.l10n.t("Choose commit mode") },
      );
      if (!mode) return;
      const { amend, signoff, noVerify } = mode;
      const revision = await runWithNotification(vscode.l10n.t("Creating Git commit"), () => manager.commit(first.repository.info.rootPath, message, { amend, signoff, noVerify }));
      if (revision) {
        await gitToolWindow.recordCommitMessage(first.repository.info.rootPath, message);
        await vscode.window.showInformationMessage(vscode.l10n.t("Created commit {0}", revision.slice(0, 12)));
      }
    }),
    vscode.commands.registerCommand("jbGit.pull", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const strategy = await vscode.window.showQuickPick(
        [
          { label: vscode.l10n.t("Merge"), value: "merge" as const },
          { label: vscode.l10n.t("Rebase"), value: "rebase" as const },
          { label: vscode.l10n.t("Fast-forward only"), value: "ff-only" as const },
        ],
        { placeHolder: vscode.l10n.t("Choose pull strategy") },
      );
      if (!strategy) return;
      // IDEA's Update Project: local changes can be parked around the update
      // and come back afterwards, or stay parked if the update stops on a conflict.
      const root = first.repository.info.rootPath;
      try {
        await pullWithLocalChanges(manager, root, strategy.value, strategy.label);
      } catch (error) {
        if (isGitAbort(error)) return;
        const kind = manager.snapshot(root)?.operation.kind;
        if (kind === "rebase" || kind === "merge") {
          await vscode.window.showWarningMessage(vscode.l10n.t("The update stopped on a conflict. Resolve the conflicted files in Local Changes and Continue, or Abort to put the branch back."));
        } else {
          await vscode.window.showErrorMessage(formatGitError(error));
        }
      }
    }),
    vscode.commands.registerCommand("jbGit.push", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      await previewAndPush(manager, first.repository.info.rootPath);
    }),
    vscode.commands.registerCommand("jbGit.merge", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const current = first.status?.branch.head;
      const mergeCandidates = first.branches.filter((branch) => (branch.kind === "local" || branch.kind === "remote") && branch.name !== current).map((branch) => branch.name);
      if (!mergeCandidates.length) return void vscode.window.showInformationMessage(vscode.l10n.t("There is no other branch to merge."));
      const ref = await vscode.window.showQuickPick(mergeCandidates, { placeHolder: vscode.l10n.t("Select a branch or ref to merge") });
      if (!ref) return;
      // IDEA's merge dialog options. Multi-select; an empty pick is a plain merge.
      const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { key: keyof GitMergeOptions }>(
        [
          { label: vscode.l10n.t("No fast-forward"), description: "--no-ff", detail: vscode.l10n.t("Always record a merge commit, even when the branch could be fast-forwarded."), key: "noFastForward" },
          { label: vscode.l10n.t("Fast-forward only"), description: "--ff-only", detail: vscode.l10n.t("Refuse the merge unless the current branch can simply move forward."), key: "fastForwardOnly" },
          { label: vscode.l10n.t("Squash"), description: "--squash", detail: vscode.l10n.t("Stage the branch's changes as one uncommitted change; its commits are not merged."), key: "squash" },
          { label: vscode.l10n.t("No commit"), description: "--no-commit", detail: vscode.l10n.t("Stop before committing so the result can be reviewed."), key: "noCommit" },
          { label: vscode.l10n.t("Allow unrelated histories"), description: "--allow-unrelated-histories", detail: vscode.l10n.t("Merge a branch that shares no common ancestor with the current one."), key: "allowUnrelatedHistories" },
        ],
        { canPickMany: true, title: vscode.l10n.t("Merge {0} into {1}", ref, current ?? "HEAD"), placeHolder: vscode.l10n.t("Options (Enter for a plain merge)") },
      );
      if (!picked) return;
      const options: GitMergeOptions = Object.fromEntries(picked.map((item) => [item.key, true]));
      let problem: string | undefined;
      try {
        mergeArguments(options);
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      if (problem) return void vscode.window.showWarningMessage(problem);
      await runWithNotification(vscode.l10n.t("Merging {0}", ref), () => manager.merge(first.repository.info.rootPath, ref, options));
    }),
    vscode.commands.registerCommand("jbGit.rebase", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const current = first.status?.branch.head;
      const rebaseCandidates = first.branches.filter((branch) => (branch.kind === "local" || branch.kind === "remote") && branch.name !== current).map((branch) => branch.name);
      if (!rebaseCandidates.length) return void vscode.window.showInformationMessage(vscode.l10n.t("There is no other branch to rebase onto."));
      const ref = await vscode.window.showQuickPick(
        rebaseCandidates,
        { placeHolder: vscode.l10n.t("Select a branch or ref to rebase onto") },
      );
      if (!ref) return;
      // IDEA's Rebase dialog: Onto is the branch just picked; From is optional
      // and turns the rebase into `--onto <Onto> <From>`, replaying only the
      // commits after From; the options are its "Modify options".
      const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { key: "interactive" | "rebaseMerges" | "from" }>(
        [
          { label: vscode.l10n.t("Interactive"), description: "--interactive", detail: vscode.l10n.t("Review and edit the commits to replay in the sequence editor first."), key: "interactive" },
          { label: vscode.l10n.t("Preserve merges"), description: "--rebase-merges", detail: vscode.l10n.t("Keep merge commits in the replayed history instead of flattening them."), key: "rebaseMerges" },
          { label: vscode.l10n.t("Replay from a chosen commit"), description: "--onto", detail: vscode.l10n.t("Pick where the replayed commits start; only the commits after it move onto {0}.", ref), key: "from" },
        ],
        { canPickMany: true, title: vscode.l10n.t("Rebase {0} onto {1}", current ?? "HEAD", ref), placeHolder: vscode.l10n.t("Options (Enter for a plain rebase)") },
      );
      if (!picked) return;
      const root = first.repository.info.rootPath;
      if (picked.some((item) => item.key === "interactive")) {
        // The sequence editor plans exactly what Git would replay onto the
        // branch; it flattens merges and replays from the merge base, so the
        // other two options do not combine with it.
        if (picked.length > 1) return void vscode.window.showWarningMessage(vscode.l10n.t("An interactive rebase plans its own replay, so it cannot be combined with Preserve merges or a chosen starting commit."));
        const branch = first.branches.find((candidate) => candidate.name === ref && (candidate.kind === "local" || candidate.kind === "remote"));
        await runInteractiveRebase(manager, root, branch?.fullName ?? ref, ref);
        return;
      }
      let upstream = ref;
      const options: GitRebaseOptions = { rebaseMerges: picked.some((item) => item.key === "rebaseMerges") };
      if (picked.some((item) => item.key === "from")) {
        const recent = await first.repository.logRef("HEAD", 50);
        const from = await vscode.window.showQuickPick(
          recent.filter((commit) => commit.parents.length > 0).map((commit) => ({
            label: `${commit.hash.slice(0, 8)} ${commit.subject}`,
            description: commit.author,
            hash: commit.hash,
          })),
          { title: vscode.l10n.t("Replay the commits after…"), placeHolder: vscode.l10n.t("This commit stays where it is; the ones after it are replayed onto {0}", ref), matchOnDescription: true },
        );
        if (!from) return;
        options.onto = ref;
        upstream = from.hash;
      }
      try {
        await rebaseWithLocalChanges(manager, root, upstream, ref, options);
      } catch (error) {
        if (manager.snapshot(root)?.operation.kind === "rebase") {
          await vscode.window.showWarningMessage(vscode.l10n.t("The rebase stopped before the end of the plan. Resolve the conflicted files in Local Changes and Continue, or Abort to put the branch back."));
        } else {
          await vscode.window.showErrorMessage(formatGitError(error));
        }
      }
    }),
    vscode.commands.registerCommand("jbGit.resolveSimpleConflicts", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const root = first.repository.info.rootPath;
      const conflicted = (first.status?.changes ?? []).filter((change) => change.conflicted).map((change) => change.path);
      if (!conflicted.length) return void vscode.window.showInformationMessage(vscode.l10n.t("There are no conflicted files to resolve."));

      const sides = await conflictSideLabels(first);
      const labels = { ours: sides.ours, base: "base", theirs: sides.theirs };
      let resolved = 0;
      let remaining = 0;
      const skipped: string[] = [];
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Resolving simple conflicts in {0} file(s)", conflicted.length) },
        async () => {
          for (const pathSpec of conflicted) {
            try {
              const outcome = await manager.resolveSimpleConflicts(root, pathSpec, labels);
              resolved += outcome.resolved;
              remaining += outcome.remaining;
            } catch (error) {
              // A binary, symlink, or marker-carrying file cannot be analysed;
              // it is reported rather than silently left out of the totals.
              skipped.push(`${pathSpec}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        },
      );

      const detail = skipped.length ? ` ${skipped.length} file(s) could not be analysed.` : "";
      if (resolved === 0) {
        await vscode.window.showInformationMessage(vscode.l10n.t("No conflict could be resolved mechanically; {0} still need a decision.{1}", remaining, detail));
      } else {
        await vscode.window.showInformationMessage(
          `Resolved ${resolved} conflict(s) that had only one possible outcome. ${remaining} still need a decision.${detail}`,
        );
      }
      if (skipped.length) outputChannel.appendLine(`Simple conflict resolution skipped:\n${skipped.join("\n")}`);
    }),
    vscode.commands.registerCommand("jbGit.interactiveRebase", async (rootPath?: string, fromCommit?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const root = first.repository.info.rootPath;

      let from = fromCommit;
      if (!from) {
        const recent = await first.repository.logRef("HEAD", 50);
        // A root commit has no parent to rebase onto, so "from here" cannot include it.
        const choices = recent.filter((commit) => commit.parents.length > 0).map((commit) => ({
          label: `${commit.hash.slice(0, 8)} ${commit.subject}`,
          description: commit.author,
          hash: commit.hash,
        }));
        if (!choices.length) return void vscode.window.showInformationMessage(vscode.l10n.t("There is no commit this branch can be interactively rebased from."));
        const picked = await vscode.window.showQuickPick(choices, {
          placeHolder: vscode.l10n.t("Edit this commit and everything after it"),
          matchOnDescription: true,
        });
        if (!picked) return;
        from = picked.hash;
      }
      // The plan starts one commit earlier, so the chosen commit is itself editable.
      await runInteractiveRebase(manager, root, `${from}^`, from.slice(0, 8));
    }),
    vscode.commands.registerCommand("jbGit.cherryPick", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const hash = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Commit hash or ref to cherry-pick") });
      if (!hash?.trim()) return;
      await runWithNotification(vscode.l10n.t("Cherry-picking {0}", hash.trim()), () => manager.cherryPick(first.repository.info.rootPath, hash.trim()));
    }),
    vscode.commands.registerCommand("jbGit.revert", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const hash = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Commit hash or ref to revert") });
      if (!hash?.trim()) return;
      const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Revert {0}?", hash.trim()), { modal: true }, vscode.l10n.t("Revert"));
      if (answer !== vscode.l10n.t("Revert")) return;
      await runWithNotification(vscode.l10n.t("Reverting {0}", hash.trim()), () => manager.revert(first.repository.info.rootPath, hash.trim()));
    }),
    vscode.commands.registerCommand("jbGit.reset", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const ref = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Revision to reset to"), value: "HEAD" });
      if (!ref?.trim()) return;
      const mode = await vscode.window.showQuickPick(
        [
          { label: vscode.l10n.t("Soft"), value: "soft" as const, description: vscode.l10n.t("Keep index and working tree") },
          { label: vscode.l10n.t("Mixed"), value: "mixed" as const, description: vscode.l10n.t("Keep working tree, reset index") },
          { label: vscode.l10n.t("Hard"), value: "hard" as const, description: vscode.l10n.t("Discard tracked working tree changes") },
        ],
        { placeHolder: vscode.l10n.t("Choose reset mode") },
      );
      if (!mode) return;
      const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Reset {0} to {1}?", mode.label.toLowerCase(), ref.trim()), { modal: true }, vscode.l10n.t("Reset"));
      if (answer !== vscode.l10n.t("Reset")) return;
      await runWithNotification(vscode.l10n.t("Resetting to {0}", ref.trim()), () => manager.reset(first.repository.info.rootPath, ref.trim(), mode.value));
    }),
    vscode.commands.registerCommand("jbGit.continueOperation", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      const kind = first?.operation.kind;
      if (!first || !kind || kind === "none" || kind === "bisect" || kind === "sequencer") return;
      await runWithNotification(vscode.l10n.t("Continuing {0}", kind), () => manager.continueOperation(first.repository.info.rootPath, kind));
    }),
    vscode.commands.registerCommand("jbGit.abortOperation", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      const kind = first?.operation.kind;
      if (!first || !kind || kind === "none" || kind === "sequencer") return;
      const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Abort {0}?", kind), { modal: true }, vscode.l10n.t("Abort"));
      if (answer !== vscode.l10n.t("Abort")) return;
      if (kind === "bisect") await runWithNotification(vscode.l10n.t("Resetting bisect"), () => manager.bisectReset(first.repository.info.rootPath));
      else await runWithNotification(vscode.l10n.t("Aborting {0}", kind), () => manager.abortOperation(first.repository.info.rootPath, kind));
    }),
    vscode.commands.registerCommand("jbGit.skipOperation", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      const kind = first?.operation.kind;
      if (!first || (kind !== "rebase" && kind !== "cherry-pick")) return;
      await runWithNotification(vscode.l10n.t("Skipping {0}", kind), () => manager.skipOperation(first.repository.info.rootPath, kind));
    }),
    vscode.commands.registerCommand("jbGit.bisectStart", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const bad = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Known bad revision"), value: "HEAD" });
      if (!bad?.trim()) return;
      const good = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Known good revision") });
      if (!good?.trim()) return;
      await runWithNotification(vscode.l10n.t("Starting Git bisect"), () => manager.bisectStart(first.repository.info.rootPath, bad.trim(), good.trim()));
    }),
    vscode.commands.registerCommand("jbGit.bisectGood", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const ref = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Good revision (or HEAD)"), value: "HEAD" });
      if (!ref?.trim()) return;
      await runWithNotification(vscode.l10n.t("Marking revision good"), () => manager.bisectGood(first.repository.info.rootPath, ref.trim()));
    }),
    vscode.commands.registerCommand("jbGit.bisectBad", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const ref = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Bad revision (or HEAD)"), value: "HEAD" });
      if (!ref?.trim()) return;
      await runWithNotification(vscode.l10n.t("Marking revision bad"), () => manager.bisectBad(first.repository.info.rootPath, ref.trim()));
    }),
    vscode.commands.registerCommand("jbGit.bisectSkip", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      await runWithNotification(vscode.l10n.t("Skipping Git bisect revision"), () => manager.bisectSkip(first.repository.info.rootPath));
    }),
    vscode.commands.registerCommand("jbGit.bisectReset", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      await runWithNotification(vscode.l10n.t("Resetting Git bisect"), () => manager.bisectReset(first.repository.info.rootPath));
    }),
    vscode.commands.registerCommand("jbGit.createBranch", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const snapshot = await pickRepository(rootPath);
      if (!snapshot) return;
      const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t("New branch name"), placeHolder: vscode.l10n.t("feature/my-change"), validateInput: (value) => validateGitRefName(value) });
      if (!name?.trim()) return;
      await runWithNotification(vscode.l10n.t("Creating branch {0}", name), () => manager.createBranch(snapshot.repository.info.rootPath, name.trim()));
    }),
    vscode.commands.registerCommand("jbGit.renameBranch", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const snapshot = await pickRepository(rootPath);
      const current = snapshot?.status?.branch.head;
      if (!snapshot || !current) return void vscode.window.showInformationMessage(vscode.l10n.t("Select a local branch to rename."));
      const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Rename {0} to", current), value: current, validateInput: (value) => validateGitRefName(value) });
      if (!name?.trim() || name.trim() === current) return;
      await runWithNotification(vscode.l10n.t("Renaming branch {0}", current), () => manager.renameBranch(snapshot.repository.info.rootPath, current, name.trim()));
    }),
    vscode.commands.registerCommand("jbGit.deleteBranch", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const snapshot = await pickRepository(rootPath);
      if (!snapshot) return;
      const localBranches = snapshot.branches.filter((branch) => branch.kind === "local" && branch.name !== snapshot.status?.branch.head);
      if (!localBranches.length) return void vscode.window.showInformationMessage(vscode.l10n.t("There is no other local branch to delete."));
      const selected = await vscode.window.showQuickPick(localBranches.map((branch) => branch.name), { placeHolder: vscode.l10n.t("Select a branch to delete") });
      if (!selected) return;
      const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Delete branch {0}?", selected), { modal: true }, vscode.l10n.t("Delete"));
      if (answer !== vscode.l10n.t("Delete")) return;
      await runWithNotification(vscode.l10n.t("Deleting branch {0}", selected), () => manager.deleteBranch(snapshot.repository.info.rootPath, selected));
    }),
    vscode.commands.registerCommand("jbGit.stash", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const message = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Optional stash message"), placeHolder: vscode.l10n.t("Work in progress") });
      const options = await vscode.window.showQuickPick(
        [
          { label: vscode.l10n.t("Stash tracked changes"), includeUntracked: false, keepIndex: false },
          { label: vscode.l10n.t("Include untracked files"), includeUntracked: true, keepIndex: false },
          { label: vscode.l10n.t("Keep index staged"), includeUntracked: false, keepIndex: true },
          { label: vscode.l10n.t("Include untracked and keep index"), includeUntracked: true, keepIndex: true },
        ],
        { placeHolder: vscode.l10n.t("Choose stash options") },
      );
      if (!options) return;
      await runWithNotification(vscode.l10n.t("Stashing changes"), () => manager.stash(first.repository.info.rootPath, message?.trim() || undefined, options.includeUntracked, options.keepIndex));
    }),
    vscode.commands.registerCommand("jbGit.createChangelist", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t("New Changelist name"), placeHolder: vscode.l10n.t("Feature work") });
      if (!name?.trim()) return;
      await changelistStore.create(first.repository.info.rootPath, name.trim());
    }),
    vscode.commands.registerCommand("jbGit.moveToChangelist", async (node?: ChangelistChangeNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      const lists = changelistStore.lists(node.repositoryRoot).filter((list) => list.id !== node.changelistId);
      if (!lists.length) return void vscode.window.showInformationMessage(vscode.l10n.t("Create another Changelist first: this is the only one."));
      const target = await vscode.window.showQuickPick(lists.map((list) => ({ label: list.name, list })), { placeHolder: vscode.l10n.t("Move change to Changelist") });
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
          { placeHolder: vscode.l10n.t("Select a Changelist to commit") },
        );
        if (!choice) return;
        node = new ChangelistNode(choice.repositoryRoot, choice.changelist, choice.changelist.id === changelistStore.activeId(choice.repositoryRoot));
      }
      const snapshot = manager.snapshot(node.repositoryRoot);
      if (!snapshot?.status) return;
      // A Changelist owns whole files and, where the user split one, individual
      // hunks of a file that belongs to another list.
      const plan = changelistStore.commitPlan(
        node.repositoryRoot,
        node.changelist.id,
        snapshot.status.changes.map((change) => change.path),
      );
      const selected = new Set(plan.paths);
      if (selected.size === 0) {
        await vscode.window.showInformationMessage(vscode.l10n.t("This Changelist has no local changes."));
        return;
      }
      const stagedOutside = snapshot.status.changes.some((change) => change.staged && !selected.has(change.path));
      if (stagedOutside) {
        await vscode.window.showWarningMessage(vscode.l10n.t("Cannot commit this Changelist while unrelated staged changes exist. Commit or unstage them first."));
        return;
      }
      const message = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Commit Changelist '{0}'", node.changelist.name) });
      if (!message?.trim()) return;
      const revision = await runWithNotification(
        "Creating Changelist commit",
        () => manager.commitPaths(node.repositoryRoot, [...selected], message.trim(), undefined, plan.hunkSelections),
      );
      if (revision) {
        await gitToolWindow.recordCommitMessage(node.repositoryRoot, message.trim());
        await vscode.window.showInformationMessage(vscode.l10n.t("Created commit {0}", revision.slice(0, 12)));
      }
    }),
    vscode.commands.registerCommand("jbGit.createShelf", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first?.status) return;
      const eligible = first.status.changes.filter((change) => change.kind !== "untracked" && change.kind !== "ignored");
      // Shelving a conflicted path would reset its unmerged index entry to
      // HEAD, silently "resolving" the merge with the other side discarded.
      const conflicted = eligible.filter((change) => change.conflicted);
      const paths = [...new Set(eligible
        .filter((change) => !change.conflicted)
        .flatMap((change) => [change.path, ...(change.originalPath ? [change.originalPath] : [])]))];
      if (conflicted.length) {
        void vscode.window.showWarningMessage(vscode.l10n.t("Skipped {0} conflicted file(s): resolve merge conflicts before shelving them.", conflicted.length));
      }
      if (paths.length === 0) return void vscode.window.showInformationMessage(vscode.l10n.t("There are no tracked changes to shelf."));
      const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Shelf name"), value: "Shelf" });
      if (!name?.trim()) return;
      await runWithNotification(vscode.l10n.t("Creating shelf '{0}'", name.trim()), () => shelfStore.create(first.repository, name.trim(), paths));
    }),
    vscode.commands.registerCommand("jbGit.applyShelf", async (node?: ShelfNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      const snapshot = manager.snapshot(node.repositoryRoot);
      if (!snapshot) return;
      await runWithNotification(vscode.l10n.t("Applying shelf '{0}'", node.entry.name), async () => {
        await shelfStore.apply(snapshot.repository, node.entry);
        await manager.refresh(node.repositoryRoot);
      });
    }),
    vscode.commands.registerCommand("jbGit.deleteShelf", async (node?: ShelfNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Delete shelf '{0}'?", node.entry.name), { modal: true }, vscode.l10n.t("Delete"));
      if (answer !== vscode.l10n.t("Delete")) return;
      await shelfStore.remove(node.repositoryRoot, node.entry);
    }),
    vscode.commands.registerCommand("jbGit.createWorktree", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const worktreePath = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Worktree path"), placeHolder: vscode.l10n.t("../feature-worktree"), validateInput: (value) => validatePathInput(value) });
      if (!worktreePath?.trim()) return;
      const ref = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Optional starting ref"), value: first.status?.branch.head ?? "HEAD" });
      const newBranch = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Optional new branch name"), placeHolder: vscode.l10n.t("feature/worktree"), validateInput: (value) => validateGitRefName(value, true) });
      await runWithNotification(vscode.l10n.t("Creating Git worktree"), () => manager.addWorktree(first.repository.info.rootPath, worktreePath.trim(), ref?.trim() || undefined, newBranch?.trim() || undefined));
    }),
    vscode.commands.registerCommand("jbGit.manageWorktrees", async (rootPath?: string) => {
      const first = await pickRepository(rootPath);
      if (!first) return;
      const root = first.repository.info.rootPath;
      const worktrees = await manager.worktrees(root);
      const selected = await vscode.window.showQuickPick([
        { label: `$(add) ${vscode.l10n.t("Create Worktree…")}`, action: "create" as const },
        { label: `$(clear-all) ${vscode.l10n.t("Prune Missing Worktrees")}`, action: "prune" as const },
        ...worktrees.map((worktree) => ({
          label: `$(git-branch) ${worktree.branch ?? "detached HEAD"}`,
          description: worktree.path,
          detail: worktree.prunable ? "Prunable" : worktree.head ?? undefined,
          action: "worktree" as const,
          worktree,
        })),
      ], { title: vscode.l10n.t("Git Worktrees"), placeHolder: vscode.l10n.t("Create, open, or remove a worktree"), matchOnDescription: true, matchOnDetail: true });
      if (!selected) return;
      if (selected.action === "create") return void vscode.commands.executeCommand("jbGit.createWorktree", root);
      if (selected.action === "prune") return void vscode.commands.executeCommand("jbGit.pruneWorktrees", root);
      const action = await vscode.window.showQuickPick([
        { label: `$(folder-opened) ${vscode.l10n.t("Open Worktree")}`, action: "open" as const },
        { label: `$(trash) ${vscode.l10n.t("Remove Worktree…")}`, action: "remove" as const },
      ], { title: selected.worktree.path, placeHolder: vscode.l10n.t("Select a worktree action") });
      if (action?.action === "open") await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(selected.worktree.path), { forceNewWindow: false });
      if (action?.action === "remove") await vscode.commands.executeCommand("jbGit.removeWorktree", new WorktreeNode(root, selected.worktree));
    }),
    vscode.commands.registerCommand("jbGit.removeWorktree", async (node?: WorktreeNode) => {
      if (!(await requireTrustedWorkspace())) return;
      if (!node) {
        const first = await pickRepository();
        if (!first) return;
        const removable = (await manager.worktrees(first.repository.info.rootPath))
          .filter((item) => path.normalize(item.path) !== path.normalize(first.repository.info.rootPath));
        if (!removable.length) return void vscode.window.showInformationMessage(vscode.l10n.t("This repository has no linked worktrees to remove."));
        const worktree = (await vscode.window.showQuickPick(
          removable.map((item) => ({ label: item.branch ?? "detached HEAD", description: item.path, item })),
          { placeHolder: vscode.l10n.t("Select a worktree to remove"), matchOnDescription: true },
        ))?.item;
        if (!worktree) return;
        node = new WorktreeNode(first.repository.info.rootPath, worktree);
      }
      const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Remove worktree {0}?", node.worktree.path), { modal: true }, vscode.l10n.t("Remove"));
      if (answer !== vscode.l10n.t("Remove")) return;
      await runWithNotification(vscode.l10n.t("Removing Git worktree"), () => manager.removeWorktree(node.repositoryRoot, node.worktree.path, node.worktree.prunable));
    }),
    vscode.commands.registerCommand("jbGit.pruneWorktrees", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      await runWithNotification(vscode.l10n.t("Pruning Git worktrees"), () => manager.pruneWorktrees(first.repository.info.rootPath));
    }),
    vscode.commands.registerCommand("jbGit.updateSubmodules", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      await runWithNotification(vscode.l10n.t("Updating Git submodules"), () => manager.updateSubmodules(first.repository.info.rootPath));
    }),
    vscode.commands.registerCommand("jbGit.updateSubmodule", async (node?: SubmoduleNode) => {
      if (!(await requireTrustedWorkspace())) return;
      if (!node) {
        const first = await pickRepository();
        if (!first) return;
        const available = await manager.submodules(first.repository.info.rootPath);
        if (!available.length) return void vscode.window.showInformationMessage(vscode.l10n.t("This repository has no Git submodules."));
        const submodule = (await vscode.window.showQuickPick(
          available.map((item) => ({ label: item.path, description: item.status, item })),
          { placeHolder: vscode.l10n.t("Select a submodule to update") },
        ))?.item;
        if (!submodule) return;
        node = new SubmoduleNode(first.repository.info.rootPath, submodule);
      }
      await runWithNotification(vscode.l10n.t("Updating submodule {0}", node.submodule.path), () => manager.updateSubmodules(node.repositoryRoot, [node.submodule.path]));
    }),
    vscode.commands.registerCommand("jbGit.manageSubmodules", async (rootPath?: string) => {
      const first = await pickRepository(rootPath);
      if (!first) return;
      const root = first.repository.info.rootPath;
      const submodules = await manager.submodules(root);
      if (!submodules.length) return void vscode.window.showInformationMessage(vscode.l10n.t("This repository has no Git submodules."));
      const selected = await vscode.window.showQuickPick([
        { label: `$(sync) ${vscode.l10n.t("Update All Submodules")}`, action: "all" as const },
        ...submodules.map((submodule) => ({ label: `$(repo) ${submodule.path}`, description: submodule.status, detail: submodule.url ? redactGitText(submodule.url) : submodule.oid, action: "one" as const, submodule })),
      ], { title: vscode.l10n.t("Git Submodules"), placeHolder: vscode.l10n.t("Select what to update"), matchOnDescription: true, matchOnDetail: true });
      if (selected?.action === "all") await vscode.commands.executeCommand("jbGit.updateSubmodules", root);
      if (selected?.action === "one") await vscode.commands.executeCommand("jbGit.updateSubmodule", new SubmoduleNode(root, selected.submodule));
    }),
    vscode.commands.registerCommand("jbGit.createTag", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Tag name"), validateInput: (value) => validateGitRefName(value) });
      if (!name?.trim()) return;
      const ref = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Revision to tag"), value: "HEAD" });
      if (!ref?.trim()) return;
      await runWithNotification(vscode.l10n.t("Creating tag {0}", name.trim()), () => manager.createTag(first.repository.info.rootPath, name.trim(), ref.trim()));
    }),
    vscode.commands.registerCommand("jbGit.deleteTag", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const tags = first.branches.filter((branch) => branch.kind === "tag").map((branch) => branch.name);
      if (!tags.length) return void vscode.window.showInformationMessage(vscode.l10n.t("This repository has no tags."));
      const tag = await vscode.window.showQuickPick(tags, { placeHolder: vscode.l10n.t("Select a tag to delete") });
      if (!tag) return;
      const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Delete tag {0}?", tag), { modal: true }, vscode.l10n.t("Delete"));
      if (answer !== vscode.l10n.t("Delete")) return;
      await runWithNotification(vscode.l10n.t("Deleting tag {0}", tag), () => manager.deleteTag(first.repository.info.rootPath, tag));
    }),
    vscode.commands.registerCommand("jbGit.addRemote", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(rootPath);
      if (!first) return;
      const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Remote name"), value: "origin", validateInput: validateRemoteName });
      if (!name?.trim()) return;
      const url = await vscode.window.showInputBox({ prompt: vscode.l10n.t("URL for remote {0}", name.trim()), placeHolder: vscode.l10n.t("https://example.com/repository.git") });
      if (!url?.trim()) return;
      await runWithNotification(vscode.l10n.t("Adding remote {0}", name.trim()), () => manager.addRemote(first.repository.info.rootPath, name.trim(), url.trim()));
    }),
    vscode.commands.registerCommand("jbGit.manageRemotes", async (rootPath?: string) => {
      const first = await pickRepository(rootPath);
      if (!first) return;
      const root = first.repository.info.rootPath;
      const selected = await vscode.window.showQuickPick([
        { label: `$(add) ${vscode.l10n.t("Add Remote…")}`, action: "add" as const },
        ...(await manager.remotes(root)).map((remote) => ({ label: `$(remote) ${remote.name}`, description: redactGitText(remote.fetchUrl), action: "remote" as const, remote })),
      ], { title: vscode.l10n.t("Git Remotes"), placeHolder: vscode.l10n.t("Add or manage a remote"), matchOnDescription: true });
      if (!selected) return;
      if (selected.action === "add") return void vscode.commands.executeCommand("jbGit.addRemote", root);
      const action = await vscode.window.showQuickPick([
        { label: `$(sync) ${vscode.l10n.t("Fetch")}`, command: "jbGit.fetchRemote" },
        { label: `$(cloud-upload) ${vscode.l10n.t("Push…")}`, command: "jbGit.pushRemote" },
        { label: `$(edit) ${vscode.l10n.t("Edit URL…")}`, command: "jbGit.setRemoteUrl" },
        { label: `$(trash) ${vscode.l10n.t("Remove…")}`, command: "jbGit.removeRemote" },
      ], { title: selected.remote.name, placeHolder: vscode.l10n.t("Select a remote action") });
      if (action) await vscode.commands.executeCommand(action.command, new RemoteNode(root, selected.remote));
    }),
    vscode.commands.registerCommand("jbGit.removeRemote", async (node?: RemoteNode) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(node?.repositoryRoot);
      if (!first) return;
      const name = node?.remote.name ?? (await vscode.window.showQuickPick(
        (await manager.remotes(first.repository.info.rootPath)).map((remote) => remote.name),
        { placeHolder: vscode.l10n.t("Select a remote to remove") },
      ));
      if (!name) return;
      const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Remove remote {0}?", name), { modal: true }, vscode.l10n.t("Remove"));
      if (answer !== vscode.l10n.t("Remove")) return;
      await runWithNotification(vscode.l10n.t("Removing remote {0}", name), () => manager.removeRemote(node?.repositoryRoot ?? first.repository.info.rootPath, name));
    }),
    vscode.commands.registerCommand("jbGit.setRemoteUrl", async (node?: RemoteNode) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(node?.repositoryRoot);
      if (!first) return;
      const remote = node?.remote ?? (await vscode.window.showQuickPick(
        (await manager.remotes(first.repository.info.rootPath)).map((item) => ({ label: item.name, description: redactGitText(item.fetchUrl), item })),
        { placeHolder: vscode.l10n.t("Select a remote to edit"), matchOnDescription: true },
      ))?.item;
      if (!remote) return;
      const kind = await vscode.window.showQuickPick(
        [{ label: vscode.l10n.t("Fetch URL"), push: false }, { label: vscode.l10n.t("Push URL"), push: true }],
        { placeHolder: vscode.l10n.t("Which remote URL should be changed?") },
      );
      if (!kind) return;
      const current = kind.push ? remote.pushUrl : remote.fetchUrl;
      const url = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("New {0} for {1}", kind.label.toLowerCase(), remote.name),
        value: current,
        password: /^[a-z][a-z0-9+.-]*:\/\/[^\s/]+@/i.test(current),
      });
      if (!url?.trim()) return;
      await runWithNotification(vscode.l10n.t("Updating remote {0}", remote.name), () => manager.setRemoteUrl(node?.repositoryRoot ?? first.repository.info.rootPath, remote.name, url.trim(), kind.push));
    }),
    vscode.commands.registerCommand("jbGit.fetchRemote", async (node?: RemoteNode) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(node?.repositoryRoot);
      if (!first) return;
      const name = node?.remote.name ?? (await vscode.window.showQuickPick(
        (await manager.remotes(first.repository.info.rootPath)).map((remote) => remote.name),
        { placeHolder: vscode.l10n.t("Select a remote to fetch") },
      ));
      if (!name) return;
      await runWithNotification(vscode.l10n.t("Fetching {0}", name), (signal) => manager.fetchRemote(node?.repositoryRoot ?? first.repository.info.rootPath, name, signal), true);
    }),
    vscode.commands.registerCommand("jbGit.pushRemote", async (node?: RemoteNode) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = await pickRepository(node?.repositoryRoot);
      if (!first) return;
      const root = node?.repositoryRoot ?? first.repository.info.rootPath;
      const name = node?.remote.name ?? (await vscode.window.showQuickPick(
        (await manager.remotes(root)).map((remote) => remote.name),
        { placeHolder: vscode.l10n.t("Select a remote to push") },
      ));
      if (!name) return;
      const branch = manager.snapshot(root)?.status?.branch.head;
      if (!branch) return void vscode.window.showInformationMessage(vscode.l10n.t("Push requires a checked-out local branch."));
      await previewAndPush(manager, root, { remote: name });
    }),
    vscode.commands.registerCommand("jbGit.applyStash", async (node?: StashNode) => {
      if (!(await requireTrustedWorkspace())) return;
      if (!node) {
        const first = await pickRepository(); if (!first) return;
        const entries = await manager.stashes(first.repository.info.rootPath);
        if (!entries.length) return void vscode.window.showInformationMessage(vscode.l10n.t("This repository has no stashes."));
        const entry = (await vscode.window.showQuickPick(entries.map((item) => ({ label: item.ref, description: item.message, item })), { placeHolder: vscode.l10n.t("Select a stash to apply") }))?.item;
        if (!entry) return; node = new StashNode(first.repository.info.rootPath, entry);
      }
      await applyStashReportingConflicts(node, false);
    }),
    vscode.commands.registerCommand("jbGit.popStash", async (node?: StashNode) => {
      if (!(await requireTrustedWorkspace())) return;
      if (!node) {
        const first = await pickRepository(); if (!first) return;
        const entries = await manager.stashes(first.repository.info.rootPath);
        if (!entries.length) return void vscode.window.showInformationMessage(vscode.l10n.t("This repository has no stashes."));
        const entry = (await vscode.window.showQuickPick(entries.map((item) => ({ label: item.ref, description: item.message, item })), { placeHolder: vscode.l10n.t("Select a stash to pop") }))?.item;
        if (!entry) return; node = new StashNode(first.repository.info.rootPath, entry);
      }
      await applyStashReportingConflicts(node, true);
    }),
    vscode.commands.registerCommand("jbGit.dropStash", async (node?: StashNode) => {
      if (!(await requireTrustedWorkspace())) return;
      if (!node) {
        const first = await pickRepository(); if (!first) return;
        const entries = await manager.stashes(first.repository.info.rootPath);
        if (!entries.length) return void vscode.window.showInformationMessage(vscode.l10n.t("This repository has no stashes."));
        const entry = (await vscode.window.showQuickPick(entries.map((item) => ({ label: item.ref, description: item.message, item })), { placeHolder: vscode.l10n.t("Select a stash to drop") }))?.item;
        if (!entry) return; node = new StashNode(first.repository.info.rootPath, entry);
      }
      const answer = await vscode.window.showWarningMessage(
        `Drop the stash '${node.entry.message || node.entry.ref}'?`,
        { modal: true },
        vscode.l10n.t("Drop"),
      );
      if (answer !== vscode.l10n.t("Drop")) return;
      await runWithNotification(vscode.l10n.t("Dropping {0}", node.entry.ref), () => manager.dropStash(node.repositoryRoot, node.entry.ref, node.entry.oid));
    }),
    vscode.commands.registerCommand("jbGit.manageStashes", async (rootPath?: string) => {
      const first = await pickRepository(rootPath);
      if (!first) return;
      const root = first.repository.info.rootPath;
      const selected = await vscode.window.showQuickPick([
        { label: `$(add) ${vscode.l10n.t("Stash Current Changes…")}`, action: "create" as const },
        ...(await manager.stashes(root)).map((entry) => ({ label: `$(archive) ${entry.ref}`, description: entry.message, action: "stash" as const, entry })),
      ], { title: vscode.l10n.t("Git Stashes"), placeHolder: vscode.l10n.t("Create or manage a stash"), matchOnDescription: true });
      if (!selected) return;
      if (selected.action === "create") return void vscode.commands.executeCommand("jbGit.stash", root);
      const action = await vscode.window.showQuickPick([
        { label: `$(check) ${vscode.l10n.t("Apply")}`, command: "jbGit.applyStash" },
        { label: `$(move) ${vscode.l10n.t("Pop")}`, command: "jbGit.popStash" },
        { label: `$(trash) ${vscode.l10n.t("Drop…")}`, command: "jbGit.dropStash" },
      ], { title: `${selected.entry.ref} · ${selected.entry.message}`, placeHolder: vscode.l10n.t("Select a stash action") });
      if (action) await vscode.commands.executeCommand(action.command, new StashNode(root, selected.entry));
    }),
    vscode.commands.registerCommand("jbGit.checkoutBranch", async (rootPath?: string) => {
      if (!(await requireTrustedWorkspace())) return;
      const snapshot = await pickRepository(rootPath);
      if (!snapshot) return void vscode.window.showInformationMessage(vscode.l10n.t("No Git repository was found in this workspace."));
      const selected = (await vscode.window.showQuickPick(
        snapshot.branches.filter((item) => item.kind !== "remote" || item.name !== "origin/HEAD").map((item) => ({ label: item.name, description: item.kind, item })),
        { placeHolder: vscode.l10n.t("Select a branch to checkout") },
      ))?.item;
      if (!selected) return;
      await runWithNotification(vscode.l10n.t("Checking out {0}", selected.name), () => checkoutWithLocalChanges(manager, snapshot.repository.info.rootPath, selected));
    }),
    vscode.commands.registerCommand("jbGit.stageChange", async (node?: ChangeNode) => {
      if (!(await requireTrustedWorkspace())) return;
      node ??= await pickChangeNode("unstaged");
      if (!node) return;
      await runWithNotification(vscode.l10n.t("Staging {0}", node.change.path), () => manager.stage(node.repositoryRoot, [node.change.path]));
    }),
    vscode.commands.registerCommand("jbGit.unstageChange", async (node?: ChangeNode) => {
      if (!(await requireTrustedWorkspace())) return;
      node ??= await pickChangeNode("staged");
      if (!node) return;
      await runWithNotification(vscode.l10n.t("Unstaging {0}", node.change.path), () => manager.unstage(node.repositoryRoot, [node.change.path]));
    }),
    vscode.commands.registerCommand("jbGit.stageHunk", async (node?: HunkNode) => {
      if (!(await requireTrustedWorkspace())) return;
      node ??= await pickHunkNode("unstaged");
      if (!node) return;
      await runWithNotification(vscode.l10n.t("Staging hunk in {0}", node.pathSpec), () => manager.stageHunk(node.repositoryRoot, node.pathSpec, node.hunk));
    }),
    vscode.commands.registerCommand("jbGit.unstageHunk", async (node?: HunkNode) => {
      if (!(await requireTrustedWorkspace())) return;
      node ??= await pickHunkNode("staged");
      if (!node) return;
      await runWithNotification(vscode.l10n.t("Unstaging hunk in {0}", node.pathSpec), () => manager.unstageHunk(node.repositoryRoot, node.pathSpec, node.hunk));
    }),
    vscode.commands.registerCommand("jbGit.discardChange", async (node?: ChangeNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      if (node.change.kind === "untracked") {
        const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Move untracked file {0} to Trash?", node.change.path), { modal: true }, vscode.l10n.t("Move to Trash"));
        if (answer !== vscode.l10n.t("Move to Trash")) return;
        await runWithNotification(vscode.l10n.t("Moving {0} to Trash", node.change.path), async () => {
          await moveUntrackedToTrash(node.repositoryRoot, node.change.path);
          await manager.refresh(node.repositoryRoot);
        });
        return;
      }
      if (node.change.conflicted) {
        return void vscode.window.showWarningMessage(vscode.l10n.t("Conflicted files are not discarded individually. Resolve the conflict or abort the Git operation so both sides remain recoverable."));
      }
      const confirmDiscard = vscode.workspace.getConfiguration("jbGit").get<boolean>("confirmDiscard", true);
      if (confirmDiscard) {
        const answer = await vscode.window.showWarningMessage(
          `Roll back ${node.change.path}? A recovery entry will be kept in Shelf.`,
          { modal: true },
          vscode.l10n.t("Discard"),
        );
        if (answer !== vscode.l10n.t("Discard")) return;
      }
      const snapshot = manager.snapshot(node.repositoryRoot);
      if (!snapshot) return;
      const recovery = await runWithNotification(vscode.l10n.t("Backing up and rolling back {0}", node.change.path), async () => {
        const recoveryPaths = [node.change.path, ...(node.change.originalPath ? [node.change.originalPath] : [])];
        const entry = await shelfStore.create(snapshot.repository, `Rollback backup · ${node.change.path}`, recoveryPaths);
        await manager.refresh(node.repositoryRoot);
        return entry;
      });
      if (recovery) void vscode.window.showInformationMessage(vscode.l10n.t("Rolled back {0}. Recovery shelf '{1}' was kept.", node.change.path, recovery.name));
    }),
    vscode.commands.registerCommand("jbGit.resolveConflict", async (node?: ChangeNode) => {
      if (!(await requireTrustedWorkspace())) return;
      if (node && !node.change.conflicted) {
        return void vscode.window.showInformationMessage(vscode.l10n.t("'{0}' has no merge conflict to resolve.", node.change.path));
      }
      const target = node ?? (await pickConflict(manager));
      if (!target) return;
      await openMergeConflictEditor(manager, mergeEditor, target);
    }),
    vscode.commands.registerCommand("jbGit.markResolved", async (node?: ChangeNode) => {
      if (!(await requireTrustedWorkspace()) || !node || !node.change.conflicted) return;
      await runWithNotification(vscode.l10n.t("Marking {0} resolved", node.change.path), () => manager.markResolved(node.repositoryRoot, [node.change.path]));
    }),
  );

  // Startup activation must stay cheap: this finds a repository containing
  // each workspace root (including parent and bare repositories) without a
  // recursive directory crawl. The full nested scan runs when the view opens
  // or when the user explicitly refreshes.
  await gitRuntimeCheck;
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

/** The active or given file as a repository-relative path, or undefined (after telling the user) when there is none. */
async function locateFile(manager: RepositoryManager, resource: vscode.Uri | undefined, none: string): Promise<{ snapshot: RepositorySnapshot; root: string; relativePath: string } | undefined> {
  const uri = resource?.scheme === "file" ? resource : vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== "file") {
    await vscode.window.showInformationMessage(none);
    return undefined;
  }
  const filePath = await canonicalPath(uri.fsPath);
  const snapshot = deepestContaining(manager.all, filePath, (item) => item.repository.info.rootPath);
  if (!snapshot) {
    await vscode.window.showInformationMessage(vscode.l10n.t("The active file is not inside a discovered Git repository."));
    return undefined;
  }
  const root = snapshot.repository.info.rootPath;
  return { snapshot, root, relativePath: path.relative(root, filePath) };
}

/** Opens `ref`'s version of a file against the working copy in the native read-only-left diff. */
async function compareFileWithRef(diffProvider: DiffContentProvider, repository: GitRepository, root: string, relativePath: string, ref: string, describe: string): Promise<void> {
  const [left, right] = await Promise.all([
    repository.fileContent(relativePath, ref),
    repository.fileContent(relativePath),
  ]);
  const label = `${relativePath} (${describe} ↔ Local)`;
  const leftUri = diffSide(diffProvider, root, `${label}:ref`, relativePath, left);
  const rightUri = diffSide(diffProvider, root, `${label}:local`, relativePath, right);
  await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, label, { preview: true });
}

async function openMergeConflictEditor(
  manager: RepositoryManager,
  mergeEditor: MergeConflictEditor,
  node: ChangeNode,
): Promise<void> {
  const opened = await runWithNotification(
    vscode.l10n.t("Loading merge conflict for {0}", node.change.path),
    () => mergeEditor.open(node.repositoryRoot, node.change.path),
  );
  if (opened !== false) return;

  const labels = await conflictSideLabels(manager.snapshot(node.repositoryRoot));
  const side = await vscode.window.showQuickPick(
    [
      { label: vscode.l10n.t("Accept left"), value: "ours" as const, description: labels.ours },
      { label: vscode.l10n.t("Accept right"), value: "theirs" as const, description: labels.theirs },
    ],
    { title: vscode.l10n.t("Binary merge conflict"), placeHolder: vscode.l10n.t("{0} cannot be merged as text", node.change.path) },
  );
  if (!side) return;
  const resolveLabel = vscode.l10n.t("Resolve");
  const answer = await vscode.window.showWarningMessage(
    vscode.l10n.t("Replace {0} with '{1}' and mark it resolved?", node.change.path, side.description ?? ""),
    { modal: true },
    resolveLabel,
  );
  if (answer !== resolveLabel) return;
  await runWithNotification(vscode.l10n.t("Resolving {0}", node.change.path), async () => {
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
    await vscode.window.showInformationMessage(vscode.l10n.t("There are no unresolved Git conflicts in this workspace."));
    return undefined;
  }
  if (candidates.length === 1) return candidates[0].node;
  return (await vscode.window.showQuickPick(candidates, {
    title: vscode.l10n.t("Open Merge Conflict Editor"),
    placeHolder: vscode.l10n.t("Select a conflicted file"),
    matchOnDescription: true,
    matchOnDetail: true,
  }))?.node;
}

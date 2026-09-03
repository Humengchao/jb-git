import * as path from "node:path";
import * as vscode from "vscode";
import { ChangelistStore } from "../changelists/store";
import { GitBranch, GitChange, GitCommit, GitCommitFile, GitDiffHunk, GitLineRange, GitLogOptions, GitResetMode } from "../git/types";
import { GitTraceEvent, isGitAbort } from "../git/runner";
import { GitBatchError } from "../git/repository";
import { RepositoryManager, type RepositoryMutationLease, type RepositorySnapshot } from "../repositoryManager";
import { ShelfEntry, ShelfStore } from "../shelves/store";
import { ChangeNode } from "../views/nodes";
import { DiffContentProvider, diffSide, isBinaryContent } from "../views/diffProvider";
import { BranchComparisonWorkspace } from "./branchComparison";
import { webviewDocument } from "./html";
import { issueNavigationScript, logScript } from "./logPanelScript";
import { logStyles } from "./logPanelStyles";
import { validateGitRefName, validatePathInput } from "../inputValidation";
import { moveUntrackedToTrash } from "../discardSafety";
import { DEFAULT_COMMENT_CHAR, effectiveCommitMessage } from "../commitMessage";
import { FavoriteBranches, recentBranchesFromReflog } from "../branchPopup";
import { ignorePatternsFor } from "../ignoreRules";
import { conflictSideLabels } from "./mergeEditor";
import { previewAndPush } from "../pushPreview";
import { checkoutWithLocalChanges } from "../smartCheckout";
import { rebaseWithLocalChanges } from "../smartRebase";
import { hunkKeys, partitionHunks } from "../changelists/hunkOwnership";
import { isLogMessage, isToolTab, LogMessage, oldestFirst, ToolTab } from "./logPanelProtocol";
import { originalMessage } from "./rebaseEditorProtocol";
import { dropPlan, fixupPlan, rewordPlan, squashPlan } from "../logHistoryEdit";
import { type InteractiveRebaseExpectation, type RebaseStep, validateRebasePlan } from "../interactiveRebase";
import { restoreTemporaryStash, stashLocalChanges } from "../temporaryStash";

/**
 * What became of a history rewrite: it ran to the end, the user declined the
 * stash it needed, or Git stopped mid-plan on a conflict. Only "completed"
 * may be reported to the user as done.
 */
type HistoryRewriteOutcome = "completed" | "declined" | "paused";

interface LogSelection {
  commit: GitCommit;
  files: GitCommitFile[];
}

interface DisplayTrace extends GitTraceEvent {
  background: boolean;
}

interface PersistedSelectionState {
  version: 1;
  repositories: Record<string, { selected: string[]; known: string[] }>;
}

const SELECTION_STORAGE_KEY = "jbGit.toolWindowSelections";

const ALLOWED_COMMANDS = new Set([
  "jbGit.branchesPopup",
  "jbGit.operationsPopup",
  "jbGit.fetch",
  "jbGit.pull",
  "jbGit.push",
  "jbGit.stash",
  "jbGit.createBranch",
  "jbGit.pushRemote",
  "jbGit.merge",
  "jbGit.rebase",
  "jbGit.applyPatch",
  "jbGit.continueOperation",
  "jbGit.abortOperation",
  "jbGit.skipOperation",
]);

// Read-only lookups can overlap; their root/request generations below discard
// stale replies. Keeping them out of the mutation queue makes keyboard
// navigation responsive even when one commit has a very large file list.
const CONCURRENT_LOOKUP_MESSAGES = new Set(["selectCommit", "requestHeadMessage"]);

export class IntelliJGitToolWindowProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "jbGit.toolWindow";

  private view?: vscode.WebviewView;
  private selectedRoot?: string;
  private selectedRef?: string;
  private selectedHash?: string;
  private filePath?: string;
  /** True when `filePath` names one exact file (File History), which is followed through renames; false for the typed suffix filter. */
  private filePathExact = false;
  /** IDEA's History for Selection: restricts the walk to the commits that touched these lines of `filePath`. */
  private lineRange?: GitLineRange;
  private logOptions: GitLogOptions = { order: "date", firstParent: false, noMerges: false };
  /** Whole-history message search, IDEA's log search field. Applied by Git, not by filtering the loaded window. */
  private logSearch?: string;
  private requestedTab: ToolTab = "log";
  private pendingOpenTab?: ToolTab;
  private currentCommits: GitCommit[] = [];
  private traces: DisplayTrace[] = [];
  private readonly selectedPaths = new Map<string, Set<string>>();
  private readonly knownPaths = new Map<string, Set<string>>();
  private updateVersion = 0;
  private selectionRequestVersion = 0;
  private hunkRequestVersion = 0;
  private headMessageRequestVersion = 0;
  private logLimit = 300;
  private updateTimer?: NodeJS.Timeout;
  private logCache?: { root: string; fingerprint: string; limit: number; commits: GitCommit[]; exhausted: boolean };
  private selectionCache?: { key: string; files: LogSelection["files"] };
  private lastSentBranchesKey?: string;
  private lastSentTracesKey?: string;
  private lastSentLogDataKey?: string;
  private lastSentSelectionKey?: string;
  private readonly branchComparisons: BranchComparisonWorkspace;
  private readonly hunkCache = new Map<string, { staged: GitDiffHunk[]; unstaged: GitDiffHunk[] }>();
  private readonly commitFilesCache = new Map<string, GitCommitFile[]>();
  private readonly commitMessageCache = new Map<string, string>();
  /** IDEA's Author completions, per repository, valid while HEAD stands still. */
  private readonly authorsCache = new Map<string, { head: string | null; authors: string[] }>();
  /** The repository's `commit.template`, re-read at most every so often: it is configuration, not state. */
  private readonly templateCache = new Map<string, { readAt: number; template?: string; commentChar: string }>();
  private readonly recentBranchCache = new Map<string, { refsKey: string; names: string[] }>();
  private readonly disposables: vscode.Disposable[] = [];
  private didRequestNestedDiscovery = false;
  private currentCommitsRoot?: string;
  private messageQueue: Promise<void> = Promise.resolve();
  private logRequestController?: AbortController;
  private selectionController?: AbortController;
  private viewGeneration = 0;

  public constructor(
    private readonly manager: RepositoryManager,
    private readonly changelists: ChangelistStore,
    private readonly shelves: ShelfStore,
    private readonly diffProvider: DiffContentProvider,
    private readonly workspaceState: vscode.Memento,
    private readonly favorites: FavoriteBranches,
  ) {
    const persisted = workspaceState.get<PersistedSelectionState>(SELECTION_STORAGE_KEY);
    if (persisted?.version === 1) {
      for (const [root, selection] of Object.entries(persisted.repositories)) {
        this.selectedPaths.set(root, new Set(selection.selected));
        this.knownPaths.set(root, new Set(selection.known));
      }
    }
    this.branchComparisons = new BranchComparisonWorkspace(diffProvider);
    this.disposables.push(
      this.branchComparisons,
      manager.onDidChange(() => {
        this.hunkCache.clear(); this.commitFilesCache.clear(); this.commitMessageCache.clear();
        // A mutation can finish while a detail lookup is still in flight; its
        // response must not repopulate a view that was just invalidated.
        this.invalidateRequests();
        this.scheduleUpdate();
      }),
      changelists.onDidChange(() => this.scheduleUpdate()),
      shelves.onDidChange(() => this.scheduleUpdate()),
    );
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    // A previous panel may still have lookups in flight. Invalidate them before
    // attaching the new view so an old response cannot accidentally match a
    // freshly reset request id.
    this.invalidateRequests(true);
    this.view = view;
    const generation = ++this.viewGeneration;
    view.webview.options = { enableScripts: true };
    view.webview.html = webviewDocument("Git", logStyles, `${issueNavigationScript()}${logScript}`);
    const registrations: vscode.Disposable[] = [
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (!isLogMessage(message)) return;
        if (generation !== this.viewGeneration || this.view !== view) return;
        if (CONCURRENT_LOOKUP_MESSAGES.has(message.type)) {
          void this.handleMessage(message);
          return;
        }
        // Keep host-side requests in arrival order.  This is especially
        // important while a commit detail or hunk request is reading Git.
        this.messageQueue = this.messageQueue
          .then(() => generation === this.viewGeneration && this.view === view ? this.handleMessage(message) : undefined)
          .catch(() => undefined);
      }),
      view.onDidChangeVisibility(() => { if (view.visible) this.scheduleUpdate(0); }),
    ];
    registrations.push(view.onDidDispose(() => {
      for (const registration of registrations.splice(0)) registration.dispose();
      if (this.view === view) {
        this.view = undefined;
        this.viewGeneration += 1;
        this.invalidateRequests(true);
      }
    }));
    this.scheduleUpdate(0);
    if (!this.didRequestNestedDiscovery) {
      this.didRequestNestedDiscovery = true;
      void this.manager.discoverAndRefresh().catch((error) => {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      });
    }
  }

  public async open(root?: string, filePath?: string, tab: ToolTab = "log", lineRange?: GitLineRange): Promise<void> {
    const rootChanged = Boolean(root && root !== this.selectedRoot);
    if (root && this.manager.snapshot(root)) {
      if (rootChanged) {
        this.logOptions = { ...this.logOptions, author: undefined, since: undefined };
        this.logSearch = undefined;
        this.logLimit = 300;
      }
      this.selectedRoot = root;
    }
    this.invalidateRequests(rootChanged, true);
    this.requestedTab = tab;
    this.pendingOpenTab = this.view ? undefined : tab;
    // A path handed in by a command is a real file, so it is read literally
    // and followed through renames; only the typed filter is a suffix search.
    this.filePath = filePath;
    this.filePathExact = Boolean(filePath);
    this.lineRange = filePath && lineRange ? { ...lineRange, path: filePath } : undefined;
    this.selectedRef = undefined;
    this.selectedHash = undefined;
    await vscode.commands.executeCommand(`${IntelliJGitToolWindowProvider.viewType}.focus`);
    await this.view?.webview.postMessage({ type: "activateTab", tab });
    await this.update();
  }

  /**
   * IDEA's Recent group in the Branches pane. The reflog only changes when
   * HEAD moves, so it is read once per refs fingerprint rather than on every
   * refresh of the panel.
   */
  private async recentBranches(root: string, snapshot: RepositorySnapshot, refsKey: string): Promise<string[]> {
    const cached = this.recentBranchCache.get(root);
    if (cached?.refsKey === refsKey) return cached.names;
    const existing = new Set(snapshot.branches.filter((branch) => branch.kind === "local").map((branch) => branch.name));
    const names = recentBranchesFromReflog(
      await this.manager.reflogSubjects(root).catch(() => []),
      existing,
      snapshot.status?.branch.head,
    );
    this.recentBranchCache.set(root, { refsKey, names });
    return names;
  }

  /** Redraws the panel after something it renders changed outside it, such as a favorite starred in the Branches popup. */
  public refreshView(): void {
    this.scheduleUpdate();
  }

  public async openChanges(root?: string): Promise<void> {
    await this.open(root, undefined, "changes");
  }

  public async openShelf(root?: string): Promise<void> {
    await this.open(root, undefined, "shelf");
  }

  /**
   * Opens the Log with `hash` selected.
   *
   * Reports whether the commit was actually reached: the Log holds a window of
   * history, so a commit older than that window cannot be selected, and
   * `update()` falls back to the newest one. The caller needs to know that it
   * is now looking at a different commit rather than the one it asked for.
   */
  public async revealCommit(root: string, hash: string): Promise<boolean> {
    if (!this.manager.snapshot(root)) return false;
    const rootChanged = root !== this.selectedRoot;
    if (rootChanged) {
      this.logOptions = { ...this.logOptions, author: undefined, since: undefined };
      this.logLimit = 300;
    }
    // An active message search could exclude exactly the commit being revealed.
    this.logSearch = undefined;
    this.selectedRoot = root;
    this.invalidateRequests(rootChanged, true);
    this.requestedTab = "log";
    this.pendingOpenTab = this.view ? undefined : "log";
    this.filePath = undefined;
    this.filePathExact = false;
    this.lineRange = undefined;
    this.selectedRef = undefined;
    this.selectedHash = hash;
    await vscode.commands.executeCommand(`${IntelliJGitToolWindowProvider.viewType}.focus`);
    await this.view?.webview.postMessage({ type: "activateTab", tab: "log" });
    await this.update();
    return this.currentCommits.some((commit) => commit.hash === hash);
  }

  public appendTrace(event: GitTraceEvent): void {
    const trace = { ...event, background: isBackgroundTrace(event) };
    this.traces.push(trace);
    if (this.traces.length > 200) this.traces = this.traces.slice(-200);
    if (this.view?.visible && this.requestedTab === "console") {
      void this.view.webview.postMessage({ type: "trace", trace });
      // The incremental channel just delivered this; a full resend is only
      // needed for traces accumulated while another tab was active.
      this.lastSentTracesKey = this.tracesFingerprint();
    }
  }

  private scheduleUpdate(delay = 75): void {
    if (!this.view?.visible) return;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      void this.update();
    }, delay);
  }

  /** Invalidates asynchronous replies that belong to an older view selection. */
  private invalidateRequests(rootChanged = false, historyChanged = false): void {
    this.selectionRequestVersion += 1;
    this.hunkRequestVersion += 1;
    this.headMessageRequestVersion += 1;
    this.selectionCache = undefined;
    this.logRequestController?.abort();
    this.selectionController?.abort();
    // update() checks this generation after every Git await.
    this.updateVersion += 1;
    if (rootChanged || historyChanged) {
      this.currentCommits = [];
      this.currentCommitsRoot = undefined;
      this.logCache = undefined;
      this.lastSentLogDataKey = undefined;
      this.lastSentSelectionKey = undefined;
    }
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
    // IDEA does not pre-check unversioned files: a tracked change is work the
    // user did, but an untracked path is often a build artefact or an editor's
    // cache, and auto-checking thousands of those makes Commit add them all.
    // They stay listed and checkable; they just start unchecked.
    const autoCheck = new Set(changes.filter((change) => change.kind !== "untracked" && change.kind !== "ignored").map((change) => change.path));
    if (!known) {
      for (const filePath of autoCheck) selected.add(filePath);
    } else {
      for (const filePath of autoCheck) if (!known.has(filePath)) selected.add(filePath);
    }
    for (const filePath of [...selected]) if (!live.has(filePath)) selected.delete(filePath);
    const changed = !known || !sameSet(known, live) || !sameSet(this.selectedPaths.get(root) ?? new Set(), selected);
    this.knownPaths.set(root, live);
    this.selectedPaths.set(root, selected);
    if (changed) this.persistSelections();
    return selected;
  }

  private persistSelections(): void {
    const repositories: PersistedSelectionState["repositories"] = {};
    for (const [root, selected] of this.selectedPaths) {
      repositories[root] = { selected: [...selected], known: [...(this.knownPaths.get(root) ?? [])] };
    }
    void this.workspaceState.update(SELECTION_STORAGE_KEY, { version: 1, repositories } satisfies PersistedSelectionState);
  }

  /** Cheap identity of the selected repository's refs; when it is unchanged, `git log` output cannot have changed either. */
  private refsFingerprint(snapshot: RepositorySnapshot): string {
    let hash = 0;
    for (const branch of snapshot.branches) {
      const text = `${branch.name}\0${branch.oid}\0${branch.upstream ?? ""}\0${branch.tracking ?? ""}\0${branch.kind}`;
      for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) | 0;
    }
    return `${snapshot.repository.info.rootPath}\0${snapshot.branches.length}\0${hash}`;
  }

  private static readonly MESSAGE_HISTORY_KEY = "jbGit.commitMessageHistory";
  private static readonly MESSAGE_HISTORY_LIMIT = 25;

  /** The most recent commit messages written through this extension, newest first. */
  public commitMessageHistory(root: string): string[] {
    const stored = this.workspaceState.get<Record<string, string[]>>(IntelliJGitToolWindowProvider.MESSAGE_HISTORY_KEY);
    const entries = stored?.[root];
    return Array.isArray(entries) ? entries.filter((entry) => typeof entry === "string" && entry.trim()) : [];
  }

  /**
   * Remembers a message that made it into a commit, which is what IDEA's
   * Commit Message History offers back. Re-using an old message moves it to
   * the front rather than duplicating it.
   */
  public async recordCommitMessage(root: string, message: string): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed) return;
    const stored = { ...(this.workspaceState.get<Record<string, string[]>>(IntelliJGitToolWindowProvider.MESSAGE_HISTORY_KEY) ?? {}) };
    const entries = [trimmed, ...this.commitMessageHistory(root).filter((entry) => entry !== trimmed)];
    stored[root] = entries.slice(0, IntelliJGitToolWindowProvider.MESSAGE_HISTORY_LIMIT);
    await this.workspaceState.update(IntelliJGitToolWindowProvider.MESSAGE_HISTORY_KEY, stored);
  }

  private tracesFingerprint(): string {
    const last = this.traces[this.traces.length - 1];
    return `${this.traces.length}\0${last?.startedAt ?? ""}\0${last?.durationMs ?? ""}\0${last?.exitCode ?? ""}`;
  }

  private async update(): Promise<void> {
    const view = this.view;
    const webview = view?.webview;
    if (!webview || !view.visible) return;
    const version = ++this.updateVersion;
    this.logRequestController?.abort();
    const snapshot = this.currentSnapshot();
    const repositories = this.manager.all.map((item) => ({
      root: item.repository.info.rootPath,
      name: path.basename(item.repository.info.rootPath) || item.repository.info.rootPath,
      branch: item.status?.branch.head ?? "detached HEAD",
    }));
    if (!snapshot) {
      await webview.postMessage({ type: "state", state: { empty: true, repositories, stateVersion: version } });
      return;
    }
    try {
      const repository = snapshot.repository;
      const root = repository.info.rootPath;
      const changes = snapshot.status?.changes ?? [];
      const selected = this.syncSelection(root, changes);
      // The shelf list comes from disk; only the shelf tab renders it, and the
      // webview keeps its previous value when the field is omitted.
      let shelfEntries: ShelfEntry[] | undefined;
      if (this.requestedTab === "shelf") {
        try {
          shelfEntries = await this.shelves.list(root);
          if (version !== this.updateVersion) return;
        } catch (error) {
          if (version === this.updateVersion) await webview.postMessage({ type: "error", message: formatError(error) });
        }
      }
      const refsKey = this.refsFingerprint(snapshot);
      let selection: LogSelection | undefined;
      let logState: Record<string, unknown> = {};
      let logDataKey: string | undefined;
      let selectionKey: string | undefined;
      if (this.requestedTab === "log") {
        // Everything `git log` depends on is part of this fingerprint, so a
        // working-tree-only refresh (stage/unstage/save) reuses the cache.
        // The list only needs subjects and metadata. Full commit messages are
        // fetched for the selected row, preventing a 5,000-commit log from
        // copying every body through Git, parsing, and Webview IPC.
        const readOptions: Partial<GitLogOptions> = {
          ...this.logOptions,
          includeBody: false,
          ...(this.logSearch ? { grep: this.logSearch } : {}),
          ...(this.filePath && this.filePathExact ? { exactPath: true, follow: true } : {}),
          ...(this.lineRange ? { lineRange: this.lineRange } : {}),
        };
        const fingerprint = JSON.stringify([
          refsKey, snapshot.status?.branch.oid ?? null,
          this.selectedRef ?? null, this.filePath ?? null, readOptions,
        ]);
        let commits: GitCommit[];
        const cache = this.logCache;
        const cacheMatches = cache?.fingerprint === fingerprint && cache.root === root && this.currentCommitsRoot === root;
        if (!cacheMatches && this.currentCommitsRoot === root) {
          // Do not let a context-menu action use the previous ref/history while
          // a fresh walk is still in flight.
          this.currentCommits = [];
          this.currentCommitsRoot = undefined;
        }
        if (cacheMatches) {
          if (cache.limit >= this.logLimit || cache.exhausted) {
            commits = cache.commits.slice(0, this.logLimit);
          } else {
            // Grow the existing walk with --skip instead of asking Git to
            // serialize and parse every older record again.
            const additional = this.logLimit - cache.limit;
            const controller = new AbortController();
            this.logRequestController = controller;
            let page: GitCommit[];
            try {
              page = this.selectedRef
                ? await this.manager.logRefPage(root, this.selectedRef, additional, cache.limit, this.filePath, readOptions, controller.signal)
                : await this.manager.logPage(root, additional, cache.limit, this.filePath, readOptions, controller.signal);
            } finally {
              if (this.logRequestController === controller) this.logRequestController = undefined;
            }
            if (version !== this.updateVersion) return;
            cache.commits = [...cache.commits, ...page];
            cache.limit = cache.commits.length;
            cache.exhausted = page.length < additional;
            commits = cache.commits.slice(0, this.logLimit);
          }
        } else {
          const controller = new AbortController();
          this.logRequestController = controller;
          try {
            commits = this.selectedRef
              ? await repository.logRef(this.selectedRef, this.logLimit, this.filePath, readOptions, controller.signal)
              : await repository.log(this.logLimit, this.filePath, readOptions, controller.signal);
          } finally {
            if (this.logRequestController === controller) this.logRequestController = undefined;
          }
          if (version !== this.updateVersion) return;
          this.logCache = { root, fingerprint, limit: commits.length, commits, exhausted: commits.length < this.logLimit };
          this.currentCommitsRoot = root;
        }
        this.currentCommits = commits;
        if (!this.selectedHash || !commits.some((commit) => commit.hash === this.selectedHash)) {
          this.selectedHash = commits[0]?.hash;
        }
        const commit = commits.find((item) => item.hash === this.selectedHash);
        if (commit) {
          const selectionKey = `${fingerprint}\0${commit.hash}`;
          const selectionVersion = this.selectionRequestVersion;
          if (this.selectionCache?.key !== selectionKey) {
            const controller = new AbortController();
            this.selectionController?.abort();
            this.selectionController = controller;
            let files: GitCommitFile[];
            let message: string;
            try {
              ({ files, message } = await this.readCommitSelection(root, commit.hash, controller.signal));
            } finally {
              if (this.selectionController === controller) this.selectionController = undefined;
            }
            if (version !== this.updateVersion || selectionVersion !== this.selectionRequestVersion
              || this.selectedRoot !== root || this.selectedHash !== commit.hash) return;
            this.selectionCache = { key: selectionKey, files };
            selection = { commit: { ...commit, body: message }, files };
          }
          if (!selection) {
            const controller = new AbortController();
            this.selectionController?.abort();
            this.selectionController = controller;
            let messageText: string;
            try {
              try {
                messageText = await this.readCommitMessage(root, commit.hash, controller.signal);
              } catch (error) {
                if (isGitAbort(error)) throw error;
                messageText = "";
              }
            } finally {
              if (this.selectionController === controller) this.selectionController = undefined;
            }
            if (version !== this.updateVersion || selectionVersion !== this.selectionRequestVersion
              || this.selectedRoot !== root || this.selectedHash !== commit.hash) return;
            selection = { commit: { ...commit, body: messageText }, files: this.selectionCache.files };
          }
        }
        logDataKey = `${fingerprint}\0${commits.length}\0${commits[0]?.hash ?? ""}\0${commits[commits.length - 1]?.hash ?? ""}`;
        selectionKey = `${fingerprint}\0${this.selectedHash ?? ""}`;
        if (this.lastSentLogDataKey !== logDataKey) {
          logState = {
            ...logState,
            commits,
            logLimit: this.logLimit,
            hasMoreCommits: this.logLimit < 5_000 && !this.logCache?.exhausted && commits.length >= this.logLimit,
            logSearch: this.logSearch ?? "",
          };
        }
        if (this.lastSentSelectionKey !== selectionKey) logState = { ...logState, selection: selection ?? null };
        // Keep these keys separate: changing only the selected row should not
        // resend thousands of unchanged commit records over the Webview IPC.
      }
      // The Log tab does not render local-change ownership; defer this
      // potentially large model until the Local Changes tab is active.
      const lists = this.requestedTab === "changes" ? this.buildChangeLists(root, changes, selected) : undefined;
      const commitForm = this.requestedTab === "changes" ? await this.commitFormExtras(root, snapshot) : undefined;
      if (version !== this.updateVersion) return;
      // Omitted fields keep their previous value in the webview, which merges
      // incoming state; large arrays are resent only when their identity moved.
      const tracesKey = this.tracesFingerprint();
      const includeTraces = this.requestedTab === "console" && this.lastSentTracesKey !== tracesKey;
      if (version !== this.updateVersion) return;
      await webview.postMessage({
        type: "state",
        state: {
          stateVersion: version,
          repositories,
          empty: false,
          selectedRoot: repository.info.rootPath,
          branch: snapshot.status?.branch.head ?? "detached HEAD",
          selectedRef: this.selectedRef ?? null,
          filePath: this.filePath ?? null,
          lineRange: this.lineRange ? { start: this.lineRange.start, end: this.lineRange.end } : null,
          logOptions: this.logOptions,
          issueRules: vscode.workspace.getConfiguration("jbGit").get<unknown[]>("issueNavigation", []),
          // Favorites are cheap and change on their own, so they always travel;
          // the branch list itself is still gated by the refs fingerprint.
          favoriteBranches: this.favorites.list(root),
          recentBranches: await this.recentBranches(root, snapshot, refsKey),
          ...(this.lastSentBranchesKey === refsKey ? {} : { branches: snapshot.branches }),
          ...logState,
          operation: snapshot.operation,
          error: snapshot.error ?? null,
          ...(includeTraces ? { traces: this.traces } : {}),
          ...(lists ? { lists } : {}),
          ...(commitForm ?? {}),
          totalChanges: changes.length,
          stagedCount: changes.filter((change) => change.staged).length,
          selectedCount: selected.size,
          ...(shelfEntries ? {
            shelves: shelfEntries.map((entry) => ({
              id: entry.id,
              name: entry.name,
              createdAt: entry.createdAt,
              paths: entry.paths,
            })),
          } : {}),
        },
      });
      this.lastSentBranchesKey = refsKey;
      if (includeTraces) this.lastSentTracesKey = tracesKey;
      if (logDataKey !== undefined) this.lastSentLogDataKey = logDataKey;
      if (selectionKey !== undefined) this.lastSentSelectionKey = selectionKey;
    } catch (error) {
      if (isGitAbort(error)) return;
      if (version === this.updateVersion) await webview.postMessage({ type: "error", message: formatError(error) });
    }
  }

  private async handleMessage(message: LogMessage): Promise<void> {
    try {
      // Every Webview request carries the repository it was rendered for. A
      // delayed click from a previous repository must never be interpreted in
      // the newly selected one. Repository selection itself is the exception,
      // because its root is the destination rather than the current state.
      if (message.type !== "ready" && message.type !== "selectRepository"
        && message.root !== undefined && message.root !== this.selectedRoot) return;
      if (message.type === "ready") {
        this.invalidateRequests(false, true);
        this.logOptions = normalizeLogOptions(message.logOptions);
        if (this.pendingOpenTab) {
          this.requestedTab = this.pendingOpenTab;
          this.pendingOpenTab = undefined;
        } else if (isToolTab(message.activeTab)) this.requestedTab = message.activeTab;
        // A reloaded webview starts empty, so nothing counts as already sent.
        this.lastSentBranchesKey = undefined;
        this.lastSentTracesKey = undefined;
        this.lastSentLogDataKey = undefined;
        this.lastSentSelectionKey = undefined;
        await this.view?.webview.postMessage({ type: "activateTab", tab: this.requestedTab });
        return void this.update();
      }
      if (message.type === "setActiveTab") {
        if (!isToolTab(message.tab)) return;
        this.requestedTab = message.tab;
        this.pendingOpenTab = undefined;
        return void this.update();
      }
      if (message.type === "clearConsole") {
        this.traces = [];
        this.lastSentTracesKey = this.tracesFingerprint();
        await this.view?.webview.postMessage({ type: "consoleCleared" });
        return;
      }
      if (message.type === "selectRepository") {
        if (this.manager.snapshot(message.root)) {
          if (message.root !== this.selectedRoot) this.invalidateRequests(true);
          this.selectedRoot = message.root;
        }
        this.selectedRef = undefined;
        this.selectedHash = undefined;
        this.filePath = undefined;
        this.logOptions = { ...this.logOptions, author: undefined, since: undefined };
        this.logSearch = undefined;
        this.logLimit = 300;
        return void this.update();
      }
      const snapshot = this.currentSnapshot();
      if (!snapshot) return;
      const root = snapshot.repository.info.rootPath;
      const changes = snapshot.status?.changes ?? [];
      const selected = this.syncSelection(root, changes);
      // These handlers own disjoint sets of message types, so calling them
      // in turn is the same linear chain this used to be, split up only so
      // that one subject fits on a screen. Order matters in one place: the
      // actions needing a full object id are guarded inside the history
      // group, after the multi-commit actions that validate their own.
      await this.handleContextActionMessage(message, snapshot, root);
      await this.handleLogViewMessage(message, snapshot, root);
      await this.handleChangesMessage(message, snapshot, root, changes, selected);
      await this.handleCommitFormMessage(message, snapshot, root, changes, selected);
      await this.handleChangelistMessage(message, root, changes);
      await this.handleBranchMessage(message, snapshot, root);
      await this.handleHistoryMessage(message, snapshot, root, changes);
    } catch (error) {
      if (isGitAbort(error)) return;
      // A merge, rebase or cherry-pick that stopped mid-way did not simply
      // fail: the repository is now holding a conflict the user has to settle.
      // Git's own message names the files but not the way out, so say it.
      const paused = this.currentSnapshot()?.operation;
      if (paused && paused.kind !== "none" && paused.canContinue) {
        // Git's own text stays available in the panel's error banner below;
        // a non-modal toast would drop a `detail` anyway.
        await vscode.window.showWarningMessage(
          vscode.l10n.t("The {0} stopped on a conflict. Resolve the conflicted files in Local Changes and Continue, or Abort to put the branch back.", paused.kind),
        );
        await this.view?.webview.postMessage({ type: "error", message: formatError(error) });
        return;
      }
      await vscode.window.showErrorMessage(formatError(error));
      await this.view?.webview.postMessage({ type: "error", message: formatError(error) });
    }
  }

  /**
   * the branch, commit and file actions the Log's context menus post.
   *
   * `handleMessage` calls every group in turn; the groups own disjoint
   * message types, so one that does not own this message falls through
   * without doing anything.
   */
  private async handleContextActionMessage(
    message: LogMessage,
    snapshot: RepositorySnapshot,
    root: string,
  ): Promise<void> {
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
          const content = await snapshot.repository.compareRefHistory(left.fullName, right.fullName);
          await this.showReadOnlyDiff(root, `${left.name}...${right.name}`, content);
          return;
        }
        if (message.action === "deleteBranches") {
          if (!(await requireTrusted())) return;
          const current = snapshot.status?.branch.head;
          const deletable = selectedBranches.filter((branch) => branch.kind === "local" && branch.name !== current);
          if (!deletable.length) return;
          const confirmed = await vscode.window.showWarningMessage(
            vscode.l10n.t("Delete {0} selected branch(es)?", deletable.length),
            { modal: true, detail: deletable.map((branch) => branch.name).join("\n") },
            vscode.l10n.t("Delete"),
          );
          if (confirmed === vscode.l10n.t("Delete")) {
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
          const diff = await snapshot.repository.diffAgainstWorkingTree(branch.fullName);
          await this.showReadOnlyDiff(root, `${branch.name} vs working tree`, diff);
          return;
        }
        if (!(await requireTrusted())) return;
        if (message.action === "mergeRef" || message.action === "rebaseOntoRef" || message.action === "pullRefMerge" || message.action === "pullRefRebase") {
          const head = snapshot.status?.branch.head;
          if (!head) return void vscode.window.showWarningMessage(vscode.l10n.t("Check out a branch before merging or rebasing."));
          if (branch.kind === "tag") return;
          if (branch.name === head && branch.kind === "local") return;
          const pull = message.action === "pullRefMerge" || message.action === "pullRefRebase";
          const rebase = message.action === "rebaseOntoRef" || message.action === "pullRefRebase";
          if (pull && branch.kind !== "remote") return;
          if (rebase) {
            // Rebasing rewrites the checked-out branch, so confirm like every other
            // history-rewriting action in this panel.
            const confirmed = await vscode.window.showWarningMessage(
              `Rebase '${head}' onto ${branch.name}?`,
              { modal: true, detail: vscode.l10n.t("Commits on the current branch are rewritten.") },
              vscode.l10n.t("Rebase"),
            );
            if (confirmed !== vscode.l10n.t("Rebase")) return;
          }
          // IDEA's "Pull into <current>" is a fetch followed by an integration of the
          // remote-tracking ref, so run it as those two verified steps.
          if (pull) {
            const remote = await this.remoteForBranch(root, branch);
            if (!remote) return void vscode.window.showWarningMessage(vscode.l10n.t("'{0}' does not belong to a configured remote.", branch.name));
            await this.withCancellableProgress(`Fetching ${remote}`, (signal) => this.manager.fetchRemote(root, remote, signal));
          }
          if (rebase) {
            // IDEA's smart handling of local changes: parked for the rebase,
            // restored after it, kept in the stash if it stops on a conflict.
            await rebaseWithLocalChanges(this.manager, root, branch.fullName, branch.name);
            return;
          }
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Merging ${branch.name}` },
            () => this.manager.merge(root, branch.fullName),
          );
          return;
        }
        if (message.action === "updateRef") {
          // IDEA's Update on a branch row: the current branch is a pull, any
          // other local branch is fast-forwarded from its upstream in place.
          if (branch.kind !== "local" || !branch.upstream || branch.upstreamGone) return;
          if (branch.name === snapshot.status?.branch.head) {
            await vscode.commands.executeCommand("jbGit.pull", root);
            return;
          }
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Updating {0} from {1}", branch.name, branch.upstream) },
            () => this.manager.updateBranch(root, branch.name),
          );
          return;
        }
        if (message.action === "checkoutAndRebase") {
          // IDEA's Checkout and Rebase onto Current: the selected branch is
          // checked out and rewritten on top of the branch that was current.
          const head = snapshot.status?.branch.head;
          if (!head) return void vscode.window.showWarningMessage(vscode.l10n.t("Check out a branch before merging or rebasing."));
          if (branch.kind === "tag" || (branch.kind === "local" && branch.name === head)) return;
          const confirmed = await vscode.window.showWarningMessage(
            vscode.l10n.t("Check out '{0}' and rebase it onto '{1}'?", branch.name, head),
            { modal: true, detail: vscode.l10n.t("Commits on '{0}' that are not on '{1}' are rewritten. Local changes are parked in a stash for the duration and restored afterwards.", branch.name, head) },
            vscode.l10n.t("Checkout and Rebase"),
          );
          if (confirmed !== vscode.l10n.t("Checkout and Rebase")) return;
          const onto = `refs/heads/${head}`;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Checking out {0} and rebasing onto {1}", branch.name, head) },
            // A conflict surfaces as Git's own message through the panel's
            // error path, exactly as "Rebase onto" does; the checkout flow
            // keeps the parked changes in their stash when that happens.
            () => checkoutWithLocalChanges(this.manager, root, branch, {
              afterCheckout: (lease) => this.manager.rebase(root, onto, lease),
            }),
          );
          return;
        }
        if (message.action === "fetchRef") {
          if (branch.kind !== "remote") return;
          const remote = await this.remoteForBranch(root, branch);
          if (!remote) return void vscode.window.showWarningMessage(vscode.l10n.t("'{0}' does not belong to a configured remote.", branch.name));
          await this.withCancellableProgress(`Fetching ${remote}`, (signal) => this.manager.fetchRemote(root, remote, signal));
          return;
        }
        if (message.action === "pushRef") {
          if (branch.kind !== "local") return;
          if (branch.name === snapshot.status?.branch.head) {
            await previewAndPush(this.manager, root);
            return;
          }
          await previewAndPush(this.manager, root, { sourceBranch: branch.name });
          return;
        }
        if (message.action === "tagFromRef") {
          const name = await vscode.window.showInputBox({ title: vscode.l10n.t("New Tag at '{0}'", branch.name), prompt: vscode.l10n.t("Tag name"), validateInput: (value) => validateGitRefName(value) });
          if (!name?.trim()) return;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Creating tag {0}", name.trim()) },
            () => this.manager.createTag(root, name.trim(), branch.fullName),
          );
          return;
        }
        if (message.action === "deleteTag") {
          if (branch.kind !== "tag") return;
          const confirmed = await vscode.window.showWarningMessage(vscode.l10n.t("Delete tag '{0}'?", branch.name), { modal: true }, vscode.l10n.t("Delete"));
          if (confirmed === vscode.l10n.t("Delete")) await this.manager.deleteTag(root, branch.name);
          return;
        }
        if (message.action === "newBranchFromRef") {
          const name = await vscode.window.showInputBox({ title: vscode.l10n.t("New Branch from '{0}'", branch.name), prompt: vscode.l10n.t("Branch name"), validateInput: (value) => validateGitRefName(value) });
          if (name?.trim()) await this.manager.createBranch(root, name.trim(), branch.fullName);
          return;
        }
        if (message.action === "createWorktreeFromRef") {
          const worktreePath = await vscode.window.showInputBox({ title: vscode.l10n.t("New Worktree from '{0}'", branch.name), prompt: vscode.l10n.t("Worktree path"), placeHolder: vscode.l10n.t("../feature-worktree"), validateInput: (value) => validatePathInput(value) });
          if (!worktreePath?.trim()) return;
          const newBranch = await vscode.window.showInputBox({ title: vscode.l10n.t("Optional New Branch"), prompt: vscode.l10n.t("Leave empty to use the selected ref"), validateInput: (value) => validateGitRefName(value, true) });
          await this.manager.addWorktree(root, worktreePath.trim(), branch.name, newBranch?.trim() || undefined);
          return;
        }
        if (message.action === "renameBranch") {
          if (branch.kind !== "local") return;
          const name = await vscode.window.showInputBox({ title: vscode.l10n.t("Rename '{0}'", branch.name), value: branch.name, validateInput: (value) => validateGitRefName(value) });
          if (name?.trim() && name.trim() !== branch.name) await this.manager.renameBranch(root, branch.name, name.trim());
          return;
        }
        if (message.action === "deleteBranch") {
          if (branch.kind !== "local" || branch.name === snapshot.status?.branch.head) return;
          const confirmed = await vscode.window.showWarningMessage(vscode.l10n.t("Delete branch '{0}'?", branch.name), { modal: true }, vscode.l10n.t("Delete"));
          if (confirmed === vscode.l10n.t("Delete")) await this.manager.deleteBranch(root, branch.name);
          return;
        }
        return;
      }
      if (!isFullObjectId(message.hash)) return;
      if (this.currentCommitsRoot !== root) return;
      const commit = this.currentCommits.find((item) => item.hash === message.hash);
      if (!commit) return;
      if ("path" in message) {
        const files = await this.readCommitFiles(root, commit.hash);
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
          const leftUri = diffSide(this.diffProvider, root, `${label}:commit`, file.path, left);
          const rightUri = diffSide(this.diffProvider, root, `${label}:local`, file.path, right);
          await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, label, { preview: true });
          return;
        }
        if (message.action === "openRepositoryFile") {
          const content = await snapshot.repository.fileContent(file.path, commit.hash);
          if (isBinaryContent(content)) return void vscode.window.showInformationMessage(vscode.l10n.t("{0} is binary and cannot be opened as text.", file.path));
          const uri = this.diffProvider.registerFile(root, `${file.path}@${commit.hash.slice(0, 8)}`, file.path, content.toString("utf8"));
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
          this.filePathExact = true;
          this.lineRange = undefined;
          this.selectedRef = commit.hash;
          this.selectedHash = undefined;
          return void this.update();
        }
        if (message.action === "restoreFile") {
          if (!(await requireTrusted())) return;
          const confirmed = await vscode.window.showWarningMessage(
            `Replace the working-tree version of '${file.path}' with ${commit.hash.slice(0, 8)}?`,
            { modal: true }, vscode.l10n.t("Restore"),
          );
          if (confirmed === vscode.l10n.t("Restore")) await this.manager.restoreFileFromRevision(root, commit.hash, file.path);
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
        const diff = await snapshot.repository.diffAgainstWorkingTree(commit.hash);
        await this.showReadOnlyDiff(root, `${commit.hash.slice(0, 12)} vs local`, diff);
        return;
      }
      if (!(await requireTrusted())) return;
      if (message.action === "checkoutRevision") {
        const confirmed = await vscode.window.showWarningMessage(vscode.l10n.t("Checkout {0} in detached HEAD mode?", commit.hash.slice(0, 8)), { modal: true }, vscode.l10n.t("Checkout"));
        if (confirmed === vscode.l10n.t("Checkout")) await this.manager.checkoutRevision(root, commit.hash);
        return;
      }
      if (message.action === "createTag") {
        const name = await vscode.window.showInputBox({ title: vscode.l10n.t("New Tag at {0}", commit.hash.slice(0, 8)), prompt: vscode.l10n.t("Tag name"), validateInput: (value) => validateGitRefName(value) });
        if (name?.trim()) await this.manager.createTag(root, name.trim(), commit.hash);
        return;
      }
      return;
    }
  }
  /**
   * what the Log view itself asks for: paging, filters, search and selection.
   *
   * `handleMessage` calls every group in turn; the groups own disjoint
   * message types, so one that does not own this message falls through
   * without doing anything.
   */
  private async handleLogViewMessage(
    message: LogMessage,
    snapshot: RepositorySnapshot,
    root: string,
  ): Promise<void> {
    if (message.type === "loadMore") {
      this.logLimit = Math.min(5_000, this.logLimit + 300);
      return void this.update();
    }
    if (message.type === "deepSearch") {
      const text = message.text.trim();
      if (!text) {
        if (this.logSearch === undefined) return;
        this.invalidateRequests(false, true);
        this.logSearch = undefined;
        this.logLimit = 300;
        this.selectedHash = undefined;
        return void this.update();
      }
      // A hash goes to the commit itself, IDEA's go-to-hash: re-root the log
      // at it so even a commit outside the loaded window is reachable.
      if (/^[0-9a-f]{4,64}$/i.test(text)) {
        try {
          const [commit] = await snapshot.repository.logRef(text, 1);
          if (commit) {
            this.invalidateRequests(false, true);
            this.logSearch = undefined;
            this.selectedRef = commit.hash;
            this.lineRange = undefined;
            this.selectedHash = commit.hash;
            this.logLimit = 300;
            return void this.update();
          }
        } catch {
          // Hex-looking text that resolves to nothing is searched as text.
        }
      }
      this.invalidateRequests(false, true);
      this.logSearch = text;
      this.selectedHash = undefined;
      this.logLimit = 300;
      return void this.update();
    }
    if (message.type === "selectRef") {
      if (message.ref && !snapshot.branches.some((branch) => branch.name === message.ref)) return;
      this.invalidateRequests(false, true);
      this.selectedRef = message.ref;
      // A line range names lines of HEAD's file; another branch's version of
      // the file need not have them, so the range does not survive the switch.
      this.lineRange = undefined;
      this.selectedHash = undefined;
      this.logLimit = 300;
      return void this.update();
    }
    if (message.type === "setPathFilter") {
      const filePath = message.path?.trim();
      if (filePath && (filePath.length > 4096 || /[\r\n\0]/.test(filePath))) return;
      this.invalidateRequests(false, true);
      // Typed by hand: a suffix search, and no longer one exact file's
      // history, so a line range that belonged to the old path is dropped.
      this.filePath = filePath || undefined;
      this.filePathExact = false;
      this.lineRange = undefined;
      this.selectedHash = undefined;
      this.logLimit = 300;
      return void this.update();
    }
    if (message.type === "clearLineRange") {
      if (!this.lineRange) return;
      // Back to the whole file's history; the path filter stays.
      this.invalidateRequests(false, true);
      this.lineRange = undefined;
      this.selectedHash = undefined;
      this.logLimit = 300;
      return void this.update();
    }
    if (message.type === "setLogOptions") {
      this.invalidateRequests(false, true);
      this.logOptions = normalizeLogOptions(message.options);
      this.selectedHash = undefined;
      this.logLimit = 300;
      return void this.update();
    }
    if (message.type === "selectCommit") {
      if (!isFullObjectId(message.hash)) return;
      if (this.currentCommitsRoot !== root) return;
      const commit = this.currentCommits.find((item) => item.hash === message.hash);
      if (!commit) return;
      const requestId = message.requestId;
      const selectionVersion = ++this.selectionRequestVersion;
      this.selectedHash = message.hash;
      const controller = new AbortController();
      this.selectionController?.abort();
      this.selectionController = controller;
      let files: GitCommitFile[];
      let messageText: string;
      try {
        ({ files, message: messageText } = await this.readCommitSelection(root, commit.hash, controller.signal));
      } finally {
        if (this.selectionController === controller) this.selectionController = undefined;
      }
      if (this.selectedHash !== commit.hash || selectionVersion !== this.selectionRequestVersion
        || this.selectedRoot !== root) return;
      await this.view?.webview.postMessage({ type: "selection", root, requestId, selection: { commit: { ...commit, body: messageText }, files } });
      return;
    }
    if (message.type === "refresh") {
      await this.manager.refresh(root);
      return;
    }
    if (message.type === "showPatch") {
      if (!isFullObjectId(message.hash)) return;
      const patch = await snapshot.repository.showCommit(message.hash);
      await this.showReadOnlyDiff(root, message.hash.slice(0, 12), patch);
      return;
    }
    if (message.type === "openCommitFile") {
      if (!isFullObjectId(message.hash)) return;
      if (this.currentCommitsRoot !== root) return;
      const commit = this.currentCommits.find((item) => item.hash === message.hash);
      if (!commit) return;
      const files = await this.readCommitFiles(root, commit.hash);
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
  }
  /**
   * Local Changes: staging, hunks, rollback, patches and shelving.
   *
   * `handleMessage` calls every group in turn; the groups own disjoint
   * message types, so one that does not own this message falls through
   * without doing anything.
   */
  private async handleChangesMessage(
    message: LogMessage,
    snapshot: RepositorySnapshot,
    root: string,
    changes: GitChange[],
    selected: Set<string>,
  ): Promise<void> {
    if (message.type === "togglePath") {
      const change = changes.find((item) => item.path === message.path);
      if (!change) return;
      if (message.checked) selected.add(change.path); else selected.delete(change.path);
      this.persistSelections();
      return void this.update();
    }
    if (message.type === "toggleAll") {
      const targetChanges = message.listId
        ? changes.filter((change) => this.changelists.listForFile(root, change.path).id === message.listId)
        : changes;
      for (const change of targetChanges) {
        if (message.checked) selected.add(change.path); else selected.delete(change.path);
      }
      this.persistSelections();
      return void this.update();
    }
    if (message.type === "openDiff") {
      const change = changes.find((item) => item.path === message.path);
      if (!change) return;
      const mode = message.mode ?? (change.staged && !change.unstaged ? "staged" : "unstaged");
      if ((mode === "staged" && !change.staged) || (mode === "unstaged" && !change.unstaged)) return;
      await vscode.commands.executeCommand("jbGit.openDiff", new ChangeNode(root, change, mode));
      return;
    }
    if (message.type === "requestHunks") {
      const change = changes.find((item) => item.path === message.path);
      if (!change || change.conflicted || change.kind === "untracked" || change.kind === "ignored") return;
      const requestVersion = ++this.hunkRequestVersion;
      const requestId = message.requestId ?? requestVersion;
      const [hunks, owned] = await Promise.all([
        this.readHunks(root, change),
        // Only offered where there is somewhere to move a change to.
        this.changelists.lists(root).length > 1 ? this.readOwnedHunks(root, change.path) : Promise.resolve([]),
      ]);
      if (requestVersion !== this.hunkRequestVersion || this.selectedRoot !== root) return;
      await this.view?.webview.postMessage({ type: "hunks", root, requestId, path: change.path, ...hunks, owned });
      return;
    }
    if (message.type === "moveHunk") {
      const change = changes.find((item) => item.path === message.path);
      if (!change || change.conflicted || change.kind === "untracked" || change.kind === "ignored") return;
      const requestVersion = ++this.hunkRequestVersion;
      const requestId = message.requestId ?? requestVersion;
      const lists = this.changelists.lists(root);
      if (lists.length < 2) return;
      const home = this.changelists.homeListId(root, change.path);
      const picked = await vscode.window.showQuickPick(
        lists.map((list) => ({
          label: list.name,
          description: list.id === home ? "the file's own Changelist" : undefined,
          id: list.id,
        })),
        { title: vscode.l10n.t("Move this change of {0} to", change.path), placeHolder: vscode.l10n.t("Select a Changelist") },
      );
      if (!picked) return;
      await this.changelists.assignHunks(root, change.path, [message.key], picked.id);
      const owned = await this.readOwnedHunks(root, change.path);
      const hunks = await this.readHunks(root, change);
      if (requestVersion !== this.hunkRequestVersion || this.selectedRoot !== root) return;
      await this.view?.webview.postMessage({ type: "hunks", root, requestId, path: change.path, ...hunks, owned });
      return;
    }
    if (message.type === "rollbackHunk") {
      // IDEA's Rollback on a single change: the working-tree hunk goes back
      // to what the Index holds. It throws work away, so it is confirmed and
      // backed by the same recovery shelf a whole-file rollback keeps.
      if (!(await requireTrusted())) return;
      const change = changes.find((item) => item.path === message.path);
      if (!change || change.conflicted || change.kind === "untracked" || change.kind === "ignored") return;
      const hunks = await this.readHunks(root, change);
      const expected = hunks.unstaged[message.index];
      if (!expected) return;
      const rollback = vscode.l10n.t("Rollback");
      if (vscode.workspace.getConfiguration("jbGit").get<boolean>("confirmDiscard", true)) {
        const confirmed = await vscode.window.showWarningMessage(
          vscode.l10n.t("Roll back this change in {0}?", change.path),
          { modal: true, detail: `${expected.header}\n\n${vscode.l10n.t("The file's other changes and anything staged stay as they are. A recovery entry is kept in Shelf.")}` },
          rollback,
        );
        if (confirmed !== rollback) return;
      }
      // The recovery entry holds exactly the change being discarded, and is
      // recorded rather than shelved: shelving takes the file's changes out of
      // the working tree, which would throw away the hunks meant to stay.
      const patch = await this.manager.hunkPatch(root, change.path, expected);
      const recovery = await this.shelves.record(snapshot.repository, `Hunk rollback backup · ${change.path}`, [change.path], patch);
      try {
        await this.manager.rollbackHunk(root, change.path, expected);
      } catch (error) {
        // The hunk moved between the read and the apply, so nothing was
        // discarded and the entry would describe a change that is still there.
        await this.shelves.remove(root, recovery).catch(() => undefined);
        throw error;
      }
      this.hunkCache.delete(`${root}\0${change.path}`);
      void vscode.window.showInformationMessage(vscode.l10n.t("Rolled back one change in {0}. Recovery shelf '{1}' was kept.", change.path, recovery.name));
      return;
    }
    if (message.type === "createLocalPatch") {
      // IDEA's Create Patch from the local changes the user checked, which is
      // the same selection Commit would take.
      const eligible = changes.filter((change) => selected.has(change.path) && !change.conflicted && change.kind !== "ignored");
      const paths = eligible.flatMap((change) => [change.path, ...(change.originalPath ? [change.originalPath] : [])]);
      if (!paths.length) return void vscode.window.showInformationMessage(vscode.l10n.t("Select at least one change to create a patch from."));
      const patch = await this.manager.localChangesPatch(root, [...new Set(paths)]);
      if (!patch.trim()) return void vscode.window.showInformationMessage(vscode.l10n.t("The selected changes produced an empty patch."));
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
      await savePatch(root, `local-changes-${stamp}.patch`, patch);
      return;
    }
    if (message.type === "applyHunk") {
      const change = changes.find((item) => item.path === message.path);
      if (!change || change.conflicted || !Number.isInteger(message.index) || message.index < 0) return;
      const requestVersion = ++this.hunkRequestVersion;
      const requestId = message.requestId ?? requestVersion;
      const hunks = await this.readHunks(root, change);
      const expected = hunks[message.source][message.index];
      if (!expected) return;
      if (message.source === "staged") await this.manager.unstageHunk(root, change.path, expected);
      else await this.manager.stageHunk(root, change.path, expected);
      const latest = this.manager.snapshot(root)?.status?.changes.find((item) => item.path === change.path);
      if (!latest) {
        this.hunkCache.delete(`${root}\0${change.path}`);
        if (requestVersion !== this.hunkRequestVersion || this.selectedRoot !== root) return;
        await this.view?.webview.postMessage({ type: "hunks", root, requestId, path: change.path, staged: [], unstaged: [] });
        return;
      }
      const refreshed = await this.readHunks(root, latest, true);
      if (requestVersion !== this.hunkRequestVersion || this.selectedRoot !== root) return;
      await this.view?.webview.postMessage({ type: "hunks", root, requestId, path: change.path, ...refreshed });
      return;
    }
    if (message.type === "stage" || message.type === "unstage") {
      const change = changes.find((item) => item.path === message.path);
      if (!change) return;
      if (message.type === "stage") await this.manager.stage(root, [change.path]);
      else await this.manager.unstage(root, [change.path]);
      return;
    }
    if (message.type === "resolveWith") {
      // IDEA's Accept Yours / Accept Theirs for one conflicted file. The side
      // labels come from the operation, so during a rebase "yours" is the
      // rebase target rather than the replayed commit.
      if (!(await requireTrusted())) return;
      const change = changes.find((item) => item.path === message.path);
      if (!change?.conflicted) return;
      const labels = await conflictSideLabels(snapshot);
      const chosen = message.side === "ours" ? labels.ours : labels.theirs;
      const resolveLabel = vscode.l10n.t("Resolve");
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t("Replace {0} with '{1}' and mark it resolved?", change.path, chosen),
        { modal: true },
        resolveLabel,
      );
      if (answer !== resolveLabel) return;
      await this.manager.acceptConflictSide(root, change.path, message.side);
      return;
    }
    if (message.type === "ignorePath") {
      if (!(await requireTrusted())) return;
      const change = changes.find((item) => item.path === message.path);
      if (!change || change.kind !== "untracked") return;
      const kindLabel = { file: vscode.l10n.t("Ignore File"), directory: vscode.l10n.t("Ignore Directory"), extension: vscode.l10n.t("Ignore All Files with This Extension") };
      const pattern = await vscode.window.showQuickPick(
        ignorePatternsFor(change.path).map((option) => ({ label: kindLabel[option.kind], description: option.pattern, pattern: option.pattern })),
        { title: vscode.l10n.t("Ignore {0}", change.path), placeHolder: vscode.l10n.t("Which rule should be added?") },
      );
      if (!pattern) return;
      const target = await vscode.window.showQuickPick(
        [
          { label: ".gitignore", description: vscode.l10n.t("Shared with everyone who clones the repository"), target: "gitignore" as const },
          { label: ".git/info/exclude", description: vscode.l10n.t("Private to this clone"), target: "exclude" as const },
        ],
        { title: vscode.l10n.t("Add '{0}' to", pattern.pattern) },
      );
      if (!target) return;
      const file = await this.manager.addIgnoreRule(root, target.target, pattern.pattern);
      const open = vscode.l10n.t("Open");
      const answer = await vscode.window.showInformationMessage(vscode.l10n.t("Added '{0}' to {1}.", pattern.pattern, target.label), open);
      if (answer === open) await vscode.window.showTextDocument(vscode.Uri.file(file));
      return;
    }
    if (message.type === "discard") {
      const change = changes.find((item) => item.path === message.path);
      if (!change) return;
      const action = change.kind === "untracked" ? "Move to Trash" : "Rollback";
      const shouldConfirm = vscode.workspace.getConfiguration("jbGit").get<boolean>("confirmDiscard", true);
      if (shouldConfirm) {
        const confirmed = await vscode.window.showWarningMessage(
          change.kind === "untracked"
            ? `Move ${change.path} to the system Trash?`
            : `Roll back ${change.path}? A recovery entry will be kept in Shelf.`,
          { modal: true }, action,
        );
        if (confirmed !== action) return;
      }
      if (change.kind === "untracked") {
        await moveUntrackedToTrash(root, change.path);
        await this.manager.refresh(root);
      } else if (change.conflicted) {
        return void vscode.window.showWarningMessage(vscode.l10n.t("Conflicted files are not rolled back individually. Resolve the conflict or abort the Git operation so both sides remain recoverable."));
      } else {
        const recoveryPaths = [change.path, ...(change.originalPath ? [change.originalPath] : [])];
        const recovery = await this.shelves.create(snapshot.repository, `Rollback backup · ${change.path}`, recoveryPaths);
        await this.manager.refresh(root);
        void vscode.window.showInformationMessage(vscode.l10n.t("Rolled back {0}. Recovery shelf '{1}' was kept.", change.path, recovery.name));
      }
      return;
    }
    if (message.type === "createShelf") {
      const eligible = changes.filter((change) => selected.has(change.path) && change.kind !== "untracked" && change.kind !== "ignored");
      // Shelving a conflicted path would reset its unmerged index entry to
      // HEAD, silently "resolving" the merge with the other side discarded.
      const conflicted = eligible.filter((change) => change.conflicted);
      const paths = eligible
        .filter((change) => !change.conflicted)
        .flatMap((change) => [change.path, ...(change.originalPath ? [change.originalPath] : [])]);
      if (conflicted.length) {
        void vscode.window.showWarningMessage(vscode.l10n.t("Skipped {0} conflicted file(s): resolve merge conflicts before shelving them.", conflicted.length));
      }
      if (!paths.length) return void vscode.window.showInformationMessage(vscode.l10n.t("Select at least one tracked change to shelf."));
      const name = await vscode.window.showInputBox({ title: vscode.l10n.t("Shelve Changes"), prompt: vscode.l10n.t("Shelf name"), value: "Shelf" });
      if (name?.trim()) {
        await this.shelves.create(snapshot.repository, name.trim(), [...new Set(paths)]);
        await this.manager.refresh(root);
      }
      return;
    }
    if (message.type === "applyShelf" || message.type === "unshelve" || message.type === "deleteShelf"
      || message.type === "renameShelf" || message.type === "showShelfDiff") {
      const entry = (await this.shelves.list(root)).find((item) => item.id === message.id);
      if (!entry) return;
      if (message.type === "showShelfDiff") {
        const patch = await this.shelves.patchText(root, entry);
        await this.showReadOnlyDiff(root, entry.name, patch);
        return;
      }
      if (message.type === "renameShelf") {
        const name = await vscode.window.showInputBox({
          title: vscode.l10n.t("Rename Shelf"),
          prompt: vscode.l10n.t("Shelf name"),
          value: entry.name,
          validateInput: (value) => (value.trim() ? undefined : vscode.l10n.t("A shelf needs a name.")),
        });
        if (name?.trim() && name.trim() !== entry.name) await this.shelves.rename(root, entry, name.trim());
        return;
      }
      if (message.type === "deleteShelf") {
        const confirmed = await vscode.window.showWarningMessage(vscode.l10n.t("Delete shelf '{0}'?", entry.name), { modal: true }, vscode.l10n.t("Delete"));
        if (confirmed === vscode.l10n.t("Delete")) await this.shelves.remove(root, entry);
        return;
      }
      // IDEA's Unshelve restores the changes and drops the entry; Unshelve and
      // Keep is the other half of that choice. `applyShelf` is the old button
      // and keeps the entry, so an existing habit does not start deleting.
      const keep = message.type !== "unshelve" || message.keep === true;
      const listId = message.type === "unshelve" ? message.listId : undefined;
      if (!(await requireTrusted())) return;
      const outcome = await this.shelves.apply(snapshot.repository, entry);
      // The Changelist assignment names the files the shelf carried, whether
      // or not each one ended up conflicted.
      if (listId && this.changelists.lists(root).some((list) => list.id === listId)) {
        for (const file of entry.paths) await this.changelists.assign(root, file, listId);
      }
      await this.manager.refresh(root);
      if (outcome === "conflicted") {
        // The entry stays: its conflicts are unresolved, so it is still the
        // only complete copy of what was shelved.
        void vscode.window.showWarningMessage(vscode.l10n.t("'{0}' no longer applied cleanly and was restored as a conflict. Resolve the files in Local Changes; the shelf was kept.", entry.name));
        return;
      }
      if (!keep) await this.shelves.remove(root, entry);
      void vscode.window.showInformationMessage(keep
        ? vscode.l10n.t("Unshelved '{0}' and kept the shelf.", entry.name)
        : vscode.l10n.t("Unshelved '{0}'.", entry.name));
      return;
    }
  }
  /**
   * the commit form's message conveniences and the commit itself.
   *
   * `handleMessage` calls every group in turn; the groups own disjoint
   * message types, so one that does not own this message falls through
   * without doing anything.
   */
  private async handleCommitFormMessage(
    message: LogMessage,
    snapshot: RepositorySnapshot,
    root: string,
    changes: GitChange[],
    selected: Set<string>,
  ): Promise<void> {
    if (message.type === "requestHeadMessage") {
      // IDEA fills the message box with the commit being amended. An unborn
      // branch has nothing to amend, and an empty reply leaves the box alone.
      const requestId = ++this.headMessageRequestVersion;
      let full = "";
      try {
        const [head] = await snapshot.repository.logRef("HEAD", 1);
        if (head) full = originalMessage(head);
      } catch {
        // No HEAD yet.
      }
      if (requestId !== this.headMessageRequestVersion || this.selectedRoot !== root) return;
      await this.view?.webview.postMessage({ type: "headMessage", root, requestId, message: full });
      return;
    }
    if (message.type === "messageHistory") {
      const history = this.commitMessageHistory(root);
      if (!history.length) {
        return void vscode.window.showInformationMessage(vscode.l10n.t("No commit messages have been recorded yet."));
      }
      const picked = await vscode.window.showQuickPick(
        history.map((entry) => ({
          label: entry.split("\n", 1)[0],
          detail: entry.includes("\n") ? entry.slice(entry.indexOf("\n") + 1).trim() || undefined : undefined,
          message: entry,
        })),
        { title: vscode.l10n.t("Commit Message History"), placeHolder: vscode.l10n.t("Select a previous commit message") },
      );
      if (picked) await this.view?.webview.postMessage({ type: "applyCommitMessage", message: picked.message });
      return;
    }
    if (message.type === "commit") {
      if (!message.message.trim()) return void vscode.window.showWarningMessage(vscode.l10n.t("Enter a commit message first."));
      // With a commit.template configured, comment lines are the template's
      // own — Git strips them in its editor, so they are stripped here too;
      // without one they stay, as `git commit -m` keeps them. What Git will
      // record is therefore what has to be checked and recorded: a message
      // that is nothing but the template's comments would otherwise reach
      // Git and come back as "Aborting commit due to empty commit message".
      const { commitTemplate, commentChar } = await this.commitFormExtras(root, snapshot);
      const stripComments = commitTemplate !== null;
      const commitMessage = effectiveCommitMessage(message.message, stripComments, commentChar);
      if (!commitMessage) {
        return void vscode.window.showWarningMessage(vscode.l10n.t("The message is only the commit template's comments. Describe the change above them."));
      }
      const options = { amend: message.amend, signoff: message.signoff, noVerify: message.noVerify, author: message.author?.trim() || undefined, stripComments };
      let revision: string;
      if (message.mode === "staged") {
        if (!changes.some((change) => change.staged)) return void vscode.window.showWarningMessage(vscode.l10n.t("Stage at least one change before committing the staging area."));
        revision = await this.manager.commit(root, commitMessage, options);
      } else {
        const paths = changes.filter((change) => selected.has(change.path)).map((change) => change.path);
        if (!paths.length) return void vscode.window.showWarningMessage(vscode.l10n.t("Select at least one changed file to commit."));
        // "Complete contents" means exactly that, so a file whose hunks the
        // user split between Changelists would have the other list's work
        // swept into this commit. Say so rather than doing it quietly.
        const split = this.changelists.splitPaths(root, paths);
        if (split.length > 0) {
          const answer = await vscode.window.showWarningMessage(
            split.length === 1
              ? vscode.l10n.t("'{0}' has changes assigned to more than one Changelist.", split[0])
              : vscode.l10n.t("{0} files have changes assigned to more than one Changelist.", split.length),
            {
              modal: true,
              detail: vscode.l10n.t("Committing complete contents takes all of them, including the ones another Changelist owns. Commit the Changelist itself to take only its own changes."),
            },
            vscode.l10n.t("Commit Everything"),
          );
          if (answer !== vscode.l10n.t("Commit Everything")) return;
        }
        revision = await this.manager.commitPaths(root, paths, commitMessage, options);
      }
      await this.recordCommitMessage(root, commitMessage);
      // Never await a notification here: showInformationMessage only settles once the
      // toast is dismissed, which used to stall the push for as long as it stayed up.
      if (message.push) {
        const pushed = await previewAndPush(this.manager, root);
        if (!pushed) void vscode.window.showInformationMessage(vscode.l10n.t("Created commit {0}; push was not performed.", revision.slice(0, 12)));
      } else {
        void vscode.window.showInformationMessage(vscode.l10n.t("Created commit {0}", revision.slice(0, 12)));
      }
      await this.view?.webview.postMessage({ type: "committed" });
      return;
    }
  }
  /**
   * Changelist bookkeeping.
   *
   * `handleMessage` calls every group in turn; the groups own disjoint
   * message types, so one that does not own this message falls through
   * without doing anything.
   */
  private async handleChangelistMessage(
    message: LogMessage,
    root: string,
    changes: GitChange[],
  ): Promise<void> {
    if (message.type === "createChangelist") {
      const name = await vscode.window.showInputBox({ title: vscode.l10n.t("New Changelist"), prompt: vscode.l10n.t("Name"), placeHolder: vscode.l10n.t("Feature work") });
      if (!name?.trim()) return;
      const description = await vscode.window.showInputBox({ title: vscode.l10n.t("New Changelist · {0}", name.trim()), prompt: vscode.l10n.t("Optional description"), placeHolder: vscode.l10n.t("Why these changes belong together") });
      if (description === undefined) return;
      await this.changelists.create(root, name.trim(), description);
      return;
    }
    if (message.type === "editChangelist") {
      const list = this.changelists.lists(root).find((candidate) => candidate.id === message.id);
      if (!list) return;
      const name = await vscode.window.showInputBox({ title: vscode.l10n.t("Edit Changelist"), prompt: vscode.l10n.t("Name"), value: list.name });
      if (!name?.trim()) return;
      const description = await vscode.window.showInputBox({ title: vscode.l10n.t("Edit Changelist · {0}", name.trim()), prompt: vscode.l10n.t("Optional description"), value: list.description ?? "" });
      if (description === undefined) return;
      await this.changelists.update(root, list.id, name, description);
      return;
    }
    if (message.type === "deleteChangelist") {
      const list = this.changelists.lists(root).find((candidate) => candidate.id === message.id);
      if (!list || this.changelists.lists(root).length === 1) return;
      const answer = await vscode.window.showWarningMessage(
        `Delete Changelist '${list.name}'? Its files will move to the first remaining Changelist.`,
        { modal: true }, vscode.l10n.t("Delete"),
      );
      if (answer === vscode.l10n.t("Delete")) await this.changelists.remove(root, list.id);
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
        { title: vscode.l10n.t("Move {0}", change.path), placeHolder: vscode.l10n.t("Select target Changelist") },
      );
      if (target) await this.changelists.assign(root, change.path, target.id);
      return;
    }
  }
  /**
   * branch actions posted from a row rather than from a menu.
   *
   * `handleMessage` calls every group in turn; the groups own disjoint
   * message types, so one that does not own this message falls through
   * without doing anything.
   */
  private async handleBranchMessage(
    message: LogMessage,
    snapshot: RepositorySnapshot,
    root: string,
  ): Promise<void> {
    if (message.type === "toggleFavoriteBranch") {
      const branch = snapshot.branches.find((item) => item.name === message.name && item.kind === message.kind);
      if (!branch || branch.kind === "tag") return;
      await this.favorites.toggle(root, `${branch.kind}:${branch.name}`);
      return void this.update();
    }
    if (message.type === "checkout") {
      const branch = snapshot.branches.find((item) => item.name === message.name && item.kind === message.kind);
      if (branch) await checkoutWithLocalChanges(this.manager, root, branch);
      return;
    }
  }
  /**
   * the actions that rewrite history, and the ones that need a full object id.
   *
   * `handleMessage` calls every group in turn; the groups own disjoint
   * message types, so one that does not own this message falls through
   * without doing anything.
   */
  private async handleHistoryMessage(
    message: LogMessage,
    snapshot: RepositorySnapshot,
    root: string,
    changes: GitChange[],
  ): Promise<void> {
    if (message.type === "commitsAction") {
      if (this.currentCommitsRoot !== root) return;
      // The set was gathered by clicks in whatever order the user made them;
      // the log's own display order decides how the selection is applied,
      // and a hash outside the loaded window is dropped, not guessed about.
      const requestedHashes = [...new Set(message.hashes)];
      if (!requestedHashes.every((hash) => isFullObjectId(hash))) return;
      const hashes = oldestFirst(requestedHashes, this.currentCommits.map((commit) => commit.hash));
      // A stale request is rejected as a whole; silently dropping one hash
      // could turn a reviewed multi-commit operation into a different one.
      if (hashes.length !== requestedHashes.length) return;
      const commits = hashes.map((hash) => this.currentCommits.find((commit) => commit.hash === hash)!);
      if (!hashes.length) return;
      if (message.action === "compareCommits") {
        if (hashes.length !== 2) return;
        // Oldest on the left, so the diff reads the way history moved.
        const diff = await snapshot.repository.diffRefs(hashes[0], hashes[1]);
        await this.showReadOnlyDiff(root, `${hashes[0].slice(0, 8)} → ${hashes[1].slice(0, 8)}`, diff);
        return;
      }
      if (message.action === "dropCommits" || message.action === "squashCommits") {
        if (!(await requireTrusted())) return;
        const squash = message.action === "squashCommits";
        if (squash && hashes.length < 2) return;
        const oldest = commits[0];
        if (!oldest.parents?.length) {
          return void vscode.window.showWarningMessage(vscode.l10n.t("The root commit has no parent to rebase onto, so it cannot be rewritten from the Log."));
        }
        const base = `${oldest.hash}^`;
        // The same loader the sequence editor uses, with the same refusals:
        // a range with merges, or a base that is not an ancestor of HEAD,
        // is reported before any history is touched.
        const candidates = await this.manager.interactiveRebaseCandidates(root, base);
        const chosen = new Set(hashes);
        if (!hashes.every((hash) => candidates.some((commit) => commit.hash === hash))) {
          return void vscode.window.showWarningMessage(vscode.l10n.t("Only commits on the current branch's linear history can be rewritten from the Log."));
        }
        const history = candidates.map((commit) => ({ hash: commit.hash, subject: commit.subject, message: originalMessage(commit) }));
        const steps = squash ? squashPlan(history, chosen) : dropPlan(history, chosen);
        const planProblem = validateRebasePlan(steps);
        if (planProblem) return void vscode.window.showWarningMessage(planProblem);
        const expectation = this.rebaseExpectation(root, candidates);
        // A non-adjacent squash silently reorders the commits in between,
        // which is worth a sentence before the branch is rewritten.
        const chosenIndexes = candidates.map((commit, index) => (chosen.has(commit.hash) ? index : -1)).filter((index) => index >= 0);
        const adjacent = chosenIndexes[chosenIndexes.length - 1] - chosenIndexes[0] === chosenIndexes.length - 1;
        const detail = commits.map((commit) => `${commit.hash.slice(0, 8)} ${commit.subject}`).join("\n")
          + (squash && !adjacent ? `\n\n${vscode.l10n.t("The unselected commits in between are reordered to replay after the squashed commit.")}` : "");
        const button = squash ? vscode.l10n.t("Squash") : vscode.l10n.t("Drop");
        const confirmed = await vscode.window.showWarningMessage(
          squash
            ? vscode.l10n.t("Squash {0} commits into one? The branch is rewritten from {1} onward.", hashes.length, oldest.hash.slice(0, 8))
            : vscode.l10n.t("Drop {0} commit(s)? The branch is rewritten from {1} onward.", hashes.length, oldest.hash.slice(0, 8)),
          { modal: true, detail },
          button,
        );
        if (confirmed !== button) return;
        await this.runHistoryRewrite(root, base, steps, expectation, squash
          ? vscode.l10n.t("Squashed {0} commits into one.", hashes.length)
          : vscode.l10n.t("Dropped {0} commit(s).", hashes.length));
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        vscode.l10n.t("Cherry-pick {0} commit(s) onto the current branch, oldest first?", hashes.length),
        { modal: true, detail: commits.map((commit) => `${commit.hash.slice(0, 8)} ${commit.subject}`).join("\n") },
        vscode.l10n.t("Cherry-pick"),
      );
      if (confirmed !== vscode.l10n.t("Cherry-pick")) return;
      let applied = 0;
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Cherry-picking {0} commit(s)", hashes.length), cancellable: true },
          async (progress, token) => {
            const controller = new AbortController();
            const registration = token.onCancellationRequested(() => controller.abort());
            try {
              progress.report({ message: `0/${hashes.length}` });
              await this.manager.cherryPickMany(root, hashes, controller.signal, (count) => progress.report({ message: `${count}/${hashes.length}` }));
              applied = hashes.length;
            } finally {
              registration.dispose();
            }
          },
        );
      } catch (error) {
        const batch = error instanceof GitBatchError ? error : undefined;
        applied = batch?.applied ?? applied;
        const paused = this.manager.snapshot(root)?.operation.kind === "cherry-pick";
        if (isGitAbort(error) || (batch && isGitAbort(batch.cause))) return;
        if (paused) {
          await vscode.window.showWarningMessage(vscode.l10n.t(
            "Cherry-pick stopped at {0} after {1} of {2} commit(s): {3} Resolve the conflicts and Continue, or Abort; the remaining commits were not picked.",
            batch?.currentHash.slice(0, 8) ?? hashes[applied]?.slice(0, 8) ?? "?", applied, hashes.length, formatError(error),
          ));
        } else {
          await vscode.window.showErrorMessage(formatError(error));
        }
        return;
      }
      void vscode.window.showInformationMessage(vscode.l10n.t("Cherry-picked {0} commit(s).", hashes.length));
      return;
    }
    if (!("hash" in message) || !isFullObjectId(message.hash)) return;
    if (message.type === "newBranch") {
      const name = await vscode.window.showInputBox({ title: vscode.l10n.t("New Branch"), prompt: vscode.l10n.t("Create from {0}", message.hash.slice(0, 12)), validateInput: (value) => validateGitRefName(value) });
      if (name?.trim()) await this.manager.createBranch(root, name.trim(), message.hash);
      return;
    }
    if (message.type === "cherryPick") {
      const confirmed = await vscode.window.showWarningMessage(vscode.l10n.t("Cherry-pick {0}?", message.hash.slice(0, 12)), { modal: true }, vscode.l10n.t("Cherry-pick"));
      if (confirmed === vscode.l10n.t("Cherry-pick")) await this.manager.cherryPick(root, message.hash);
      return;
    }
    if (message.type === "revert") {
      const confirmed = await vscode.window.showWarningMessage(vscode.l10n.t("Revert {0} with a new commit?", message.hash.slice(0, 12)), { modal: true }, vscode.l10n.t("Revert"));
      if (confirmed === vscode.l10n.t("Revert")) await this.manager.revert(root, message.hash);
      return;
    }
    if (message.type === "undoCommit") {
      if (!(await requireTrusted())) return;
      const head = snapshot.status?.branch.oid;
      if (!head || head.toLowerCase() !== message.hash.toLowerCase()) {
        return void vscode.window.showWarningMessage(vscode.l10n.t("Only the last commit can be undone. Use Reset or Drop Commit for an older one."));
      }
      if (snapshot.operation.kind !== "none") {
        return void vscode.window.showWarningMessage(vscode.l10n.t("Finish or abort the active {0} before undoing a commit.", snapshot.operation.kind));
      }
      const commit = this.currentCommits.find((item) => item.hash === message.hash);
      if ((commit?.parents.length ?? 0) > 1) {
        return void vscode.window.showWarningMessage(vscode.l10n.t("A merge commit cannot be undone from the Log; use Reset instead."));
      }
      const pushed = await this.manager.isPushed(root, message.hash);
      const undo = vscode.l10n.t("Undo Commit");
      const confirmed = await vscode.window.showWarningMessage(
        vscode.l10n.t("Undo commit {0}?", message.hash.slice(0, 8)),
        {
          modal: true,
          detail: [
            commit?.subject ?? "",
            vscode.l10n.t("The branch moves back to the parent and the commit's changes stay staged in Local Changes."),
            ...(pushed ? [vscode.l10n.t("This commit has already been pushed: the remote branch keeps it, and pushing again will be rejected without a force push.")] : []),
          ].filter(Boolean).join("\n\n"),
        },
        undo,
      );
      if (confirmed !== undo) return;
      await this.manager.undoCommit(root, message.hash);
      void vscode.window.showInformationMessage(vscode.l10n.t("Undid commit {0}; its changes are staged.", message.hash.slice(0, 8)));
      return;
    }
    if (message.type === "fixupCommit") {
      // IDEA's Fixup…: the staged changes become part of the chosen commit.
      if (!(await requireTrusted())) return;
      if (this.currentCommitsRoot !== root) return;
      const commit = this.currentCommits.find((item) => item.hash === message.hash);
      if (!commit) return;
      if (snapshot.operation.kind !== "none") {
        return void vscode.window.showWarningMessage(vscode.l10n.t("Finish or abort the active {0} before fixing up a commit.", snapshot.operation.kind));
      }
      const stagedPaths = changes.filter((change) => change.staged && !change.conflicted).map((change) => change.path);
      if (!stagedPaths.length) {
        return void vscode.window.showWarningMessage(vscode.l10n.t("Stage the changes that belong in {0} first; Fixup takes exactly what is in the Index.", message.hash.slice(0, 8)));
      }
      if (await this.manager.isPushed(root, message.hash)) {
        const rewrite = vscode.l10n.t("Fix Up Anyway");
        const answer = await vscode.window.showWarningMessage(
          vscode.l10n.t("Commit {0} has already been pushed.", message.hash.slice(0, 8)),
          { modal: true, detail: vscode.l10n.t("Fixing it up rewrites the branch, so the next push will need a force push.") },
          rewrite,
        );
        if (answer !== rewrite) return;
      }
      const fixUp = vscode.l10n.t("Fix Up");
      const confirmed = await vscode.window.showWarningMessage(
        vscode.l10n.t("Fix up {0} with the {1} staged file(s)?", message.hash.slice(0, 8), stagedPaths.length),
        { modal: true, detail: `${commit.subject}\n\n${stagedPaths.join("\n")}` },
        fixUp,
      );
      if (confirmed !== fixUp) return;
      const head = snapshot.status?.branch.oid;
      if (head && head.toLowerCase() === message.hash.toLowerCase()) {
        // The last commit: the staged changes are amended in, message kept.
        await this.manager.amendStaged(root, message.hash);
        void vscode.window.showInformationMessage(vscode.l10n.t("Fixed up {0} with the staged changes.", message.hash.slice(0, 8)));
        return;
      }
      if (!commit.parents.length) {
        return void vscode.window.showWarningMessage(vscode.l10n.t("The root commit has no parent to rebase onto, so it cannot be rewritten from the Log."));
      }
      const base = `${commit.hash}^`;
      // Checked before anything is committed, so a commit off the linear
      // history is refused while the staged changes are still just staged.
      if (!(await this.manager.interactiveRebaseCandidates(root, base)).some((candidate) => candidate.hash === commit.hash)) {
        return void vscode.window.showWarningMessage(vscode.l10n.t("Only commits on the current branch's linear history can be rewritten from the Log."));
      }
      const fixup = await this.manager.commitFixup(root, commit.hash);
      const candidates = await this.manager.interactiveRebaseCandidates(root, base);
      const history = candidates.map((candidate) => ({ hash: candidate.hash, subject: candidate.subject, message: originalMessage(candidate) }));
      const steps = fixupPlan(history, commit.hash, fixup);
      const planProblem = validateRebasePlan(steps);
      if (planProblem) return void vscode.window.showWarningMessage(planProblem);
      const expectation = this.rebaseExpectation(root, candidates, fixup);
      const outcome = await this.runHistoryRewrite(root, base, steps, expectation, vscode.l10n.t("Fixed up {0} with the staged changes.", message.hash.slice(0, 8)));
      // A rebase that stopped will still fold the fixup in once it is
      // continued, so only a rewrite that never ran leaves it standing.
      if (outcome === "declined") {
        void vscode.window.showInformationMessage(vscode.l10n.t("The fixup commit {0} was created but not folded in. Squash it with Interactively Rebase, or drop it from the Log.", fixup.slice(0, 8)));
      }
      return;
    }
    if (message.type === "rewordCommit") {
      if (!(await requireTrusted())) return;
      const text = message.message.replace(/\r\n/g, "\n");
      if (!text.trim()) return void vscode.window.showWarningMessage(vscode.l10n.t("A commit message cannot be empty."));
      if (this.currentCommitsRoot !== root) return;
      const commit = this.currentCommits.find((item) => item.hash === message.hash);
      if (!commit) return;
      if (snapshot.operation.kind !== "none") {
        return void vscode.window.showWarningMessage(vscode.l10n.t("Finish or abort the active {0} before editing a commit message.", snapshot.operation.kind));
      }
      if (await this.manager.isPushed(root, message.hash)) {
        const rewrite = vscode.l10n.t("Edit Anyway");
        const answer = await vscode.window.showWarningMessage(
          vscode.l10n.t("Commit {0} has already been pushed.", message.hash.slice(0, 8)),
          { modal: true, detail: vscode.l10n.t("Editing its message rewrites the branch, so the next push will need a force push.") },
          rewrite,
        );
        if (answer !== rewrite) return;
      }
      const head = snapshot.status?.branch.oid;
      if (head && head.toLowerCase() === message.hash.toLowerCase()) {
        // The last commit: an amend of the message alone, nothing else moves.
        await this.manager.rewordHead(root, message.hash, text);
        void vscode.window.showInformationMessage(vscode.l10n.t("Edited the message of {0}.", message.hash.slice(0, 8)));
        return;
      }
      if (!commit.parents.length) {
        return void vscode.window.showWarningMessage(vscode.l10n.t("The root commit has no parent to rebase onto, so it cannot be rewritten from the Log."));
      }
      const base = `${commit.hash}^`;
      const candidates = await this.manager.interactiveRebaseCandidates(root, base);
      if (!candidates.some((candidate) => candidate.hash === commit.hash)) {
        return void vscode.window.showWarningMessage(vscode.l10n.t("Only commits on the current branch's linear history can be rewritten from the Log."));
      }
      const history = candidates.map((candidate) => ({ hash: candidate.hash, subject: candidate.subject, message: originalMessage(candidate) }));
      const steps = rewordPlan(history, commit.hash, text);
      const planProblem = validateRebasePlan(steps);
      if (planProblem) return void vscode.window.showWarningMessage(planProblem);
      const expectation = this.rebaseExpectation(root, candidates);
      await this.runHistoryRewrite(root, base, steps, expectation, vscode.l10n.t("Edited the message of {0}.", message.hash.slice(0, 8)));
      return;
    }
    if (message.type === "reset") {
      const choice = await vscode.window.showQuickPick<vscode.QuickPickItem & { mode: GitResetMode }>(
        [
          { label: vscode.l10n.t("Soft"), description: vscode.l10n.t("Keep index and working tree"), mode: "soft" },
          { label: vscode.l10n.t("Mixed"), description: vscode.l10n.t("Reset index; keep working tree"), mode: "mixed" },
          { label: vscode.l10n.t("Hard"), description: vscode.l10n.t("Discard index and working tree changes"), mode: "hard" },
          { label: vscode.l10n.t("Keep"), description: vscode.l10n.t("Move the branch; keep local changes, refusing if a changed file differs between the two commits"), mode: "keep" },
        ],
        { title: vscode.l10n.t("Reset current branch to {0}", message.hash.slice(0, 12)) },
      );
      if (!choice) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Reset ${choice.label.toLowerCase()} to ${message.hash.slice(0, 12)}?${choice.mode === "hard" ? " Local changes will be lost." : ""}`,
        { modal: true }, vscode.l10n.t("Reset"),
      );
      if (confirmed === vscode.l10n.t("Reset")) await this.manager.reset(root, message.hash, choice.mode);
      return;
    }
  }

  /** The repository state a reviewed plan was built from: HEAD, branch and the candidate set, compared again inside the mutex. */
  private rebaseExpectation(root: string, candidates: readonly GitCommit[], head?: string): InteractiveRebaseExpectation {
    const status = this.manager.snapshot(root)?.status;
    return {
      head: head ?? status?.branch.oid ?? candidates[candidates.length - 1].hash,
      branch: status?.branch.head,
      commits: candidates.map((candidate) => candidate.hash),
    };
  }

  /**
   * Runs an unattended history rewrite (Drop/Squash from the Log) with the
   * same working-tree choreography as the interactive rebase command: local
   * changes are parked only after the user agrees, restored when the rewrite
   * finishes, and kept in the stash when it stops on a conflict rather than
   * being replayed on top of one. These plans contain no `edit` rows, so a
   * successful exit means the plan finished.
   */
  private async runHistoryRewrite(
    root: string,
    base: string,
    steps: readonly RebaseStep[],
    expectation: InteractiveRebaseExpectation,
    successMessage: string,
  ): Promise<HistoryRewriteOutcome> {
    const blocking = (this.manager.snapshot(root)?.status?.changes ?? [])
      .filter((change) => change.kind !== "untracked" && change.kind !== "ignored");
    const answer = blocking.length > 0
      ? await vscode.window.showWarningMessage(
        vscode.l10n.t("{0} local change(s) would block rewriting history.", blocking.length),
        {
          modal: true,
          detail: vscode.l10n.t("JB Git can stash them, run the rebase, and restore the working tree and Index afterwards. If the rebase stops on a conflict the stash is kept instead, so nothing is lost."),
        },
        vscode.l10n.t("Stash and Rebase"),
      )
      : vscode.l10n.t("Stash and Rebase");
    if (blocking.length > 0 && answer !== vscode.l10n.t("Stash and Rebase")) return "declined";
    // A plan that stops mid-rebase has not done what was asked, so the caller
    // must not report success: Drop/Squash/Reword would claim the history was
    // rewritten while the branch is parked on a conflict, and Fixup would skip
    // saying that its fixup commit is still sitting there unfolded.
    let outcome: HistoryRewriteOutcome = "completed";
    await this.manager.withExclusive(root, async (lease: RepositoryMutationLease) => {
      const stillBlocking = (this.manager.snapshot(root)?.status?.changes ?? [])
        .some((change) => change.kind !== "untracked" && change.kind !== "ignored");
      const parked = blocking.length > 0 && stillBlocking
        ? await stashLocalChanges(this.manager, root, `JB Git history rewrite onto ${base}`, { includeUntracked: false }, lease)
        : undefined;
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Rebasing {0} commit(s)", steps.length) },
          () => this.manager.interactiveRebase(root, base, steps, expectation, lease),
        );
      } catch (error) {
        const paused = this.manager.snapshot(root)?.operation.kind === "rebase";
        if (parked && paused) {
          void vscode.window.showWarningMessage(vscode.l10n.t("Your local changes are kept in {0}. Apply it from Manage Stashes once the rebase is finished or aborted.", parked.ref));
        } else if (parked) {
          // A stale plan or another preflight failure never started a rebase;
          // restore the user's changes instead of making them recover manually.
          const restore = await restoreTemporaryStash(this.manager, root, parked, lease);
          if (restore.outcome !== "restored") {
            void vscode.window.showWarningMessage(vscode.l10n.t("The rebase did not start, and your local changes remain in {0}; restore failed: {1}", parked.ref, formatError(restore.error)));
          }
        }
        if (paused) {
          outcome = "paused";
          await vscode.window.showWarningMessage(vscode.l10n.t("The rebase stopped before the end of the plan. Resolve the conflicted files in Local Changes and Continue, or Abort to put the branch back."));
          return;
        }
        throw error;
      }
      if (!parked) return;
      const restore = await restoreTemporaryStash(this.manager, root, parked, lease);
      if (restore.outcome === "conflicted") {
        void vscode.window.showWarningMessage(vscode.l10n.t("Restoring your local changes caused conflicts. {0} was kept; resolve the files in Local Changes.", parked.ref));
      } else if (restore.outcome === "kept") {
        void vscode.window.showWarningMessage(vscode.l10n.t("Restoring your local changes failed and {0} was kept: {1}", parked.ref, formatError(restore.error)));
      }
    });
    if (outcome !== "completed") return outcome;
    void vscode.window.showInformationMessage(successMessage);
    return "completed";
  }

  public dispose(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.logRequestController?.abort();
    this.invalidateRequests(true);
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  /**
   * Resolves the remote a remote-tracking branch belongs to, longest name first so
   * `origin/sub/main` beats `origin`. Returns undefined rather than guessing: refs left behind
   * by `git remote remove` still look remote, and fetching some other remote would silently
   * integrate stale commits.
   */
  private async remoteForBranch(root: string, branch: GitBranch): Promise<string | undefined> {
    if (branch.kind !== "remote") return undefined;
    const prefix = branch.fullName.replace(/^refs\/remotes\//, "");
    const remotes = await this.manager.remotes(root);
    return [...remotes]
      .sort((left, right) => right.name.length - left.name.length)
      .find((remote) => prefix.startsWith(`${remote.name}/`))?.name;
  }

  /**
   * What the commit form needs beyond the change list: the authors IDEA's
   * Author field completes from, and the `commit.template` text it pre-fills.
   * Both are cheap to cache — authors change only when HEAD moves, and the
   * template is configuration.
   */
  private async commitFormExtras(root: string, snapshot: RepositorySnapshot): Promise<{ recentAuthors: string[]; commitTemplate: string | null; commentChar: string }> {
    const head = snapshot.status?.branch.oid ?? null;
    let authors = this.authorsCache.get(root);
    if (!authors || authors.head !== head) {
      authors = { head, authors: await this.manager.recentAuthors(root, 100).catch(() => []) };
      this.authorsCache.set(root, authors);
    }
    let template = this.templateCache.get(root);
    if (!template || Date.now() - template.readAt > 30_000) {
      // The comment character travels with the template: it is only consulted
      // when comments are stripped, and both come from the same config read.
      const [text, commentChar] = await Promise.all([
        this.manager.commitTemplate(root).catch(() => undefined),
        this.manager.commentChar(root).catch(() => DEFAULT_COMMENT_CHAR),
      ]);
      template = { readAt: Date.now(), template: text, commentChar };
      this.templateCache.set(root, template);
    }
    return { recentAuthors: authors.authors, commitTemplate: template.template ?? null, commentChar: template.commentChar };
  }

  private async readHunks(root: string, change: GitChange, refresh = false): Promise<{ staged: GitDiffHunk[]; unstaged: GitDiffHunk[] }> {
    const key = `${root}\0${change.path}`;
    if (!refresh) {
      const cached = this.hunkCache.get(key);
      if (cached) return cached;
    }
    const [staged, unstaged] = await Promise.all([
      change.staged ? this.manager.diffHunks(root, change.path, true) : Promise.resolve([]),
      change.unstaged ? this.manager.diffHunks(root, change.path, false) : Promise.resolve([]),
    ]);
    const value = { staged, unstaged };
    this.hunkCache.set(key, value);
    return value;
  }

  private buildChangeLists(root: string, changes: readonly GitChange[], selected: ReadonlySet<string>) {
    const definitions = this.changelists.lists(root);
    const activeId = this.changelists.activeId(root);
    const homeByPath = new Map<string, string>();
    for (const list of definitions) {
      for (const filePath of list.files) if (!homeByPath.has(filePath)) homeByPath.set(filePath, list.id);
    }
    for (const change of changes) if (!homeByPath.has(change.path)) homeByPath.set(change.path, activeId);
    const claimsByPath = new Map(changes.map((change) => [change.path, this.changelists.claims(root, change.path)]));
    return definitions.map((list) => ({
      id: list.id,
      name: list.name,
      description: list.description,
      active: list.id === activeId,
      changes: changes
        // A file whose hunks were split appears under every list that owns
        // part of it. Listing it only under its home list left the claiming
        // list looking empty while its commit would have taken those hunks.
        .filter((change) => {
          const home = homeByPath.get(change.path);
          return home === list.id || claimsByPath.get(change.path)?.has(list.id);
        })
        .map((change) => ({
          path: change.path,
          partial: (claimsByPath.get(change.path)?.size ?? 0) > 0,
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
  }

  private async readCommitFiles(root: string, hash: string, signal?: AbortSignal): Promise<GitCommitFile[]> {
    const key = `${root}\0${hash}`;
    const cached = this.commitFilesCache.get(key);
    if (cached) return cached;
    const files = await this.manager.commitFiles(root, hash, signal);
    this.commitFilesCache.set(key, files);
    while (this.commitFilesCache.size > 100) this.commitFilesCache.delete(this.commitFilesCache.keys().next().value!);
    return files;
  }

  private async readCommitMessage(root: string, hash: string, signal?: AbortSignal): Promise<string> {
    const key = `${root}\0${hash}`;
    const cached = this.commitMessageCache.get(key);
    if (cached !== undefined) return cached;
    const message = await this.manager.commitMessage(root, hash, signal);
    // Avoid retaining a pathological multi-megabyte commit message in the LRU;
    // the selected detail can still display it once without making it permanent.
    if (message.length <= 1_000_000) {
      this.commitMessageCache.set(key, message);
      while (this.commitMessageCache.size > 100) this.commitMessageCache.delete(this.commitMessageCache.keys().next().value!);
    }
    return message;
  }

  private async readCommitSelection(root: string, hash: string, signal?: AbortSignal): Promise<{ files: GitCommitFile[]; message: string }> {
    const [filesResult, messageResult] = await Promise.allSettled([
      this.readCommitFiles(root, hash, signal),
      this.readCommitMessage(root, hash, signal),
    ]);
    if (filesResult.status === "rejected") throw filesResult.reason;
    if (messageResult.status === "rejected") {
      if (isGitAbort(messageResult.reason)) throw messageResult.reason;
      // A pathological message should not make the entire log disappear; the
      // selected row can still be shown with its subject as a fallback.
      return { files: filesResult.value, message: "" };
    }
    return { files: filesResult.value, message: messageResult.value };
  }

  /**
   * The file's changes as Changelist ownership sees them: against HEAD, not
   * against the Index.
   *
   * Staging is a different question from ownership — a hunk can be staged and
   * still belong to another Changelist — so this is its own reading rather than
   * a re-slice of the staged/unstaged split.
   */
  private async readOwnedHunks(root: string, filePath: string): Promise<Array<{ header: string; lines: string[]; key: string; listId: string; listName: string }>> {
    const { hunks } = await this.manager.diffAgainstHead(root, filePath);
    if (hunks.length === 0) return [];
    const keys = hunkKeys(hunks);
    // Reading is also when a claim on a hunk that no longer exists is dropped,
    // which keeps the stored assignments from outliving the changes they name.
    await this.changelists.reconcileHunks(root, filePath, keys);
    const home = this.changelists.homeListId(root, filePath);
    const { byList } = partitionHunks(keys, this.changelists.claims(root, filePath), home);
    const owner = new Map<number, string>();
    for (const [listId, indices] of byList) for (const index of indices) owner.set(index, listId);
    const names = new Map(this.changelists.lists(root).map((list) => [list.id, list.name]));
    return hunks.map((hunk, index) => {
      const listId = owner.get(index) ?? home;
      return { header: hunk.header, lines: hunk.lines, key: keys[index], listId, listName: names.get(listId) ?? "" };
    });
  }

  private async withCancellableProgress(title: string, operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        const registration = token.onCancellationRequested(() => controller.abort());
        try { await operation(controller.signal); } finally { registration.dispose(); }
      },
    );
  }

  /**
   * Shows generated diff text in a read-only editor. An untitled document would open
   * dirty and make VS Code ask to save a patch the user only wanted to read.
   */
  private async showReadOnlyDiff(root: string, name: string, content: string): Promise<void> {
    const fileName = `${name.replace(/[^\w.@-]+/g, "-").replace(/^-+|-+$/g, "") || "changes"}.diff`;
    const uri = this.diffProvider.registerFile(root, name, fileName, content);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  }

  private async openCommitFile(repository: NonNullable<ReturnType<RepositoryManager["snapshot"]>>["repository"], commit: GitCommit, file: GitCommitFile): Promise<void> {
    const root = repository.info.rootPath;
    const oldPath = file.originalPath ?? file.path;
    const [left, right] = await Promise.all([
      commit.parents[0] ? repository.fileContent(oldPath, commit.parents[0]) : Promise.resolve(Buffer.alloc(0)),
      file.status.startsWith("D") ? Promise.resolve(Buffer.alloc(0)) : repository.fileContent(file.path, commit.hash),
    ]);
    const label = `${file.path} (${commit.hash.slice(0, 8)})`;
    const leftUri = diffSide(this.diffProvider, root, `${label}:parent`, oldPath, left);
    const rightUri = diffSide(this.diffProvider, root, `${label}:commit`, file.path, right);
    await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, label, { preview: true });
  }
}

/** Git currently exposes full SHA-1 (40 hex) or SHA-256 (64 hex) object IDs. */
function isFullObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
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
  await vscode.window.showWarningMessage(vscode.l10n.t("JB Git mutations are disabled until this workspace is trusted."));
  return false;
}

function normalizeLogOptions(options?: Partial<GitLogOptions>): GitLogOptions {
  const author = typeof options?.author === "string" && options.author.length <= 512 && !/[\r\n\0]/.test(options.author) ? options.author : undefined;
  const since = typeof options?.since === "string" && Number.isFinite(Date.parse(options.since)) ? new Date(options.since).toISOString() : undefined;
  return {
    order: options?.order === "topological" ? "topological" : "date",
    firstParent: Boolean(options?.firstParent),
    noMerges: Boolean(options?.noMerges),
    author,
    since,
  };
}

function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function isBackgroundTrace(event: GitTraceEvent): boolean {
  const command = event.args.find((argument) => !argument.startsWith("-")) ?? "";
  return new Set(["status", "for-each-ref", "rev-parse", "symbolic-ref", "log", "diff-tree"]).has(command);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function savePatch(root: string, name: string, content: string): Promise<void> {
  const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(root, name)), filters: { "Patch files": ["patch"] } });
  if (target) await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
}

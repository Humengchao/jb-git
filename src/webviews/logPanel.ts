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
import { readFileSync } from "node:fs";
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
      if (message.type === "loadMore") {
        this.logLimit = Math.min(5_000, this.logLimit + 300);
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
        const recovery = await this.shelves.create(snapshot.repository, `Hunk rollback backup · ${change.path}`, [change.path]);
        await this.manager.rollbackHunk(root, change.path, expected);
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
      if (message.type === "toggleFavoriteBranch") {
        const branch = snapshot.branches.find((item) => item.name === message.name && item.kind === message.kind);
        if (!branch || branch.kind === "tag") return;
        await this.favorites.toggle(root, `${branch.kind}:${branch.name}`);
        return void this.update();
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
      if (message.type === "applyShelf" || message.type === "deleteShelf") {
        const entry = (await this.shelves.list(root)).find((item) => item.id === message.id);
        if (!entry) return;
        if (message.type === "applyShelf") {
          await this.shelves.apply(snapshot.repository, entry);
          await this.manager.refresh(root);
        } else {
          const confirmed = await vscode.window.showWarningMessage(vscode.l10n.t("Delete shelf '{0}'?", entry.name), { modal: true }, vscode.l10n.t("Delete"));
          if (confirmed === vscode.l10n.t("Delete")) await this.shelves.remove(root, entry);
        }
        return;
      }
      if (message.type === "checkout") {
        const branch = snapshot.branches.find((item) => item.name === message.name && item.kind === message.kind);
        if (branch) await checkoutWithLocalChanges(this.manager, root, branch);
        return;
      }
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

const logStyles = String.raw`
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body, #app { width: 100%; height: 100%; margin: 0; padding: 0; }
  body { overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-panel-background, var(--vscode-editor-background)); font: var(--vscode-font-size, 13px) var(--vscode-font-family); }
  button, select, input, textarea { color: inherit; font: inherit; }
  button { border: 0; background: transparent; cursor: pointer; }
  button:focus-visible, select:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .root { height: 100%; display: grid; grid-template-rows: 34px 38px minmax(0, 1fr); }
  .tool-tabs { display: flex; align-items: end; gap: 2px; padding: 0 8px; overflow-x: auto; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-panel-background); }
  .tool-tab { height: 33px; padding: 0 12px; border-bottom: 2px solid transparent; color: var(--vscode-descriptionForeground); }
  .tool-tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
  .toolbar { display: flex; align-items: center; gap: 5px; padding: 5px 7px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); }
  .toolbar select, .toolbar input { height: 26px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .toolbar select { max-width: 220px; padding: 2px 5px; }
  .search { width: min(330px, 32vw); padding: 3px 7px; }
  .issue-link { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .issue-link:hover { text-decoration: underline; }
  /* A whole-history search is a different state from filtering the window, and
     has to look like one. */
  .commit-search.deep-active { border-color: var(--vscode-focusBorder); background: color-mix(in srgb, var(--vscode-focusBorder) 12%, var(--vscode-input-background)); }
  .icon-button { min-width: 27px; height: 27px; padding: 0 7px; border-radius: 3px; }
  .icon-button:hover, .action:hover { background: var(--vscode-toolbar-hoverBackground); }
  .spacer { flex: 1; }
  .branch-label { color: var(--vscode-descriptionForeground); }
  .workspace { --branch-width: 185px; --details-width: 300px; min-width: 0; min-height: 0; display: grid; grid-template-columns: var(--branch-width) 9px minmax(260px, 1fr) 9px var(--details-width); overflow: hidden; }
  .workspace.compact { grid-template-columns: minmax(260px, 1fr) 9px var(--details-width); }
  .workspace.compact > .branches, .workspace.compact > .column-splitter[data-side="branch"] { display: none; }
  .workspace.tiny { grid-template-columns: minmax(260px, 1fr); }
  .workspace.tiny > .column-splitter[data-side="details"], .workspace.tiny > .details { display: none; }
  .pane { min-width: 0; min-height: 0; overflow: auto; }
  .column-splitter { position: relative; min-width: 9px; cursor: col-resize; background: transparent; outline: none; touch-action: none; }
  .column-splitter::before { content: ''; position: absolute; top: 0; bottom: 0; left: 4px; width: 1px; background: var(--vscode-panel-border); }
  .column-splitter:hover::before, .column-splitter.dragging::before, .column-splitter:focus-visible::before { left: 3px; width: 2px; background: var(--vscode-focusBorder); }
  .branches { overscroll-behavior: contain; scrollbar-gutter: stable; }
  .pane-title { position: sticky; top: 0; z-index: 2; height: 28px; display: flex; align-items: center; padding: 0 9px; font-weight: 600; background: var(--vscode-editorGroupHeader-tabsBackground); border-bottom: 1px solid var(--vscode-panel-border); }
  .branch-section { padding: 5px 0 2px; }
  .pane-action { width: 21px; height: 21px; flex: none; display: flex; align-items: center; justify-content: center; border-radius: 3px; color: var(--vscode-icon-foreground); font-size: 12px; font-weight: 400; }
  .pane-action:hover { background: var(--vscode-toolbar-hoverBackground); }
  .pane-action:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .branch-star { flex: none; margin-left: 4px; padding: 0 2px; color: var(--vscode-descriptionForeground); cursor: pointer; }
  .branch-star.on { color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow, #d99b42)); }
  .branch-row:not(:hover) .branch-star:not(.on) { visibility: hidden; }
  .branch-filter { width: calc(100% - 12px); height: 23px; margin: 5px 6px 3px; padding: 0 6px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font-size: 11px; }
  .section-title { height: 23px; display: flex; align-items: center; padding: 0 9px; color: var(--vscode-descriptionForeground); font-weight: 600; }
  .branch-row { height: 25px; width: 100%; display: flex; align-items: center; gap: 6px; padding: 0 9px 0 16px; text-align: left; white-space: nowrap; }
  .branch-row:hover { background: var(--vscode-list-hoverBackground); }
  .branch-row.active, .branch-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .branch-row.current::before { content: '✓'; width: 11px; margin-left: -11px; color: var(--vscode-charts-green); }
  /* IDEA's incoming/outgoing markers, right-aligned so branch names stay scannable. */
  .branch-track { margin-left: auto; display: inline-flex; gap: 5px; font-size: 11px; font-variant-numeric: tabular-nums; }
  .track-in { color: var(--vscode-charts-blue, #3794ff); }
  .track-out { color: var(--vscode-charts-green, #73c991); }
  .track-gone { color: var(--vscode-descriptionForeground); font-style: italic; }
  .branch-row.active .track-in, .branch-row.selected .track-in,
  .branch-row.active .track-out, .branch-row.selected .track-out { color: inherit; }
  .branch-name { overflow: hidden; text-overflow: ellipsis; }
  .commit-pane { overflow: hidden; display: grid; grid-template-rows: 35px minmax(0, 1fr); }
  .commit-filters { min-width: 0; display: flex; align-items: center; gap: 2px; padding: 4px 5px; overflow: visible; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); }
  .commit-search { width: 150px; min-width: 82px; max-width: 180px; flex: 0 1 150px; height: 27px; padding: 3px 7px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
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
  .load-more { display: block; min-height: 30px; margin: 8px auto 14px; padding: 4px 12px; border-radius: 3px; color: var(--vscode-textLink-foreground); background: var(--vscode-button-secondaryBackground); }
  .load-more:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .commit-row { min-height: 27px; cursor: pointer; }
  .commit-row:hover { background: var(--vscode-list-hoverBackground); }
  .commit-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .commit-row:focus-visible, .file-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .commit-row > div { min-width: 0; padding: 0 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .subject-cell { height: 27px; display: flex; align-items: center; gap: 5px; padding-left: 0 !important; }
  canvas { flex: none; width: 72px; height: 27px; }
  canvas.graph-interactive { cursor: pointer; }
  .refs { display: flex; gap: 3px; flex: none; max-width: 190px; overflow: hidden; }
  .ref { display: inline-flex; align-items: center; gap: 3px; max-width: 132px; padding: 1px 6px 1px 4px; border-radius: 8px; background: color-mix(in srgb, var(--vscode-charts-blue) 24%, transparent); color: var(--vscode-foreground); font-size: 10px; }
  .ref-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ref-icon { display: flex; flex: none; }
  .ref-icon svg { width: 10px; height: 10px; }
  .ref-remote { background: color-mix(in srgb, var(--vscode-charts-purple) 24%, transparent); }
  .ref-tag { background: color-mix(in srgb, var(--vscode-charts-yellow) 30%, transparent); }
  .ref-head { box-shadow: inset 0 0 0 1px var(--vscode-charts-green); font-weight: 600; }
  .detail-refs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
  .detail-refs .ref { max-width: none; padding: 2px 8px 2px 6px; font-size: 11px; }
  .detail-refs .ref-icon svg { width: 11px; height: 11px; }
  .subject { overflow: hidden; text-overflow: ellipsis; }
  .muted { color: var(--vscode-descriptionForeground); }
  .details { --message-height: 160px; display: grid; grid-template-rows: minmax(70px, 1fr) 9px var(--message-height); overflow: hidden; }
  .commit-details { min-height: 0; padding: 10px; overflow: auto; overscroll-behavior: contain; }
  .detail-subject { font-size: 14px; font-weight: 600; margin-bottom: 7px; white-space: pre-wrap; }
  .detail-multi { margin: 4px 0 8px; overflow-y: auto; }
  .multi-commit { padding: 2px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
  .multi-hint { font-size: 11px; }
  .detail-meta { display: grid; grid-template-columns: 54px 1fr; gap: 4px 6px; color: var(--vscode-descriptionForeground); }
  .detail-meta strong { color: var(--vscode-foreground); font-weight: 400; overflow-wrap: anywhere; }
  .detail-body { margin-top: 9px; white-space: pre-wrap; line-height: 1.45; }
  .reword-editor { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .reword-editor textarea { width: 100%; min-height: 96px; padding: 6px 8px; resize: vertical; border: 1px solid var(--vscode-focusBorder); border-radius: 3px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); line-height: 1.45; }
  .reword-actions { display: flex; gap: 6px; align-items: center; }
  .reword-actions .hint { margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .primary-action { height: 25px; padding: 0 9px; border-radius: 3px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .action { height: 25px; padding: 0 7px; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .files { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  .detail-splitter { position: relative; min-height: 9px; cursor: row-resize; background: transparent; outline: none; touch-action: none; }
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
  .console-toolbar select { height: 26px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
  .console { min-height: 0; overflow: auto; padding: 7px 10px 28px; background: var(--vscode-terminal-background, var(--vscode-editor-background)); color: var(--vscode-terminal-foreground, var(--vscode-foreground)); font: 12px/1.45 var(--vscode-editor-font-family); white-space: pre-wrap; overflow-wrap: anywhere; }
  .trace { margin-bottom: 6px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent); }
  .trace summary { min-height: 28px; display: flex; align-items: center; gap: 7px; cursor: pointer; list-style: none; }
  .trace summary::-webkit-details-marker { display: none; }
  .trace summary::before { content: '›'; width: 10px; color: var(--vscode-descriptionForeground); }
  .trace[open] summary::before { content: '⌄'; }
  .trace-output { padding: 0 0 8px 17px; }
  .trace-status-ok { color: var(--vscode-testing-iconPassed); }
  .trace-status-error { color: var(--vscode-testing-iconFailed); }
  .trace-background { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 10px; }
  .trace-command { color: var(--vscode-terminal-ansiCyan); }
  .trace-cwd, .trace-time { color: var(--vscode-descriptionForeground); }
  .trace-error { color: var(--vscode-terminal-ansiRed); }
  .count { display: inline-grid; place-items: center; min-width: 16px; height: 16px; margin-left: 5px; padding: 0 4px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 10px; }
  .changes-toolbar { display: flex; align-items: center; gap: 5px; padding: 5px 7px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); }
  .changes-toolbar select { max-width: 240px; height: 26px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 2px 5px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .changes-workspace { --commit-width: 340px; min-height: 0; display: grid; grid-template-columns: minmax(220px, 1fr) 9px var(--commit-width); overflow: hidden; }
  .changes-list { min-width: 0; min-height: 0; overflow: auto; }
  .changes-splitter { position: relative; min-width: 9px; cursor: col-resize; outline: none; touch-action: none; }
  .changes-splitter::before { content: ''; position: absolute; inset: 0 auto 0 4px; width: 1px; background: var(--vscode-panel-border); }
  .changes-splitter:hover::before, .changes-splitter:focus-visible::before, .changes-splitter.dragging::before { left: 3px; width: 2px; background: var(--vscode-focusBorder); }
  .operation { margin: 6px; padding: 7px 8px; border-radius: 3px; background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); }
  .operation-actions { margin-top: 6px; display: flex; gap: 5px; }
  .small-button { min-height: 24px; padding: 3px 7px; border-radius: 2px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .change-group { margin-top: 2px; }
  .group-header { height: 27px; display: flex; align-items: center; gap: 5px; padding: 0 8px; font-weight: 600; user-select: none; }
  .group-header:hover { background: var(--vscode-list-hoverBackground); }
  .group-header:focus-visible, .change-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .twisty { width: 12px; color: var(--vscode-descriptionForeground); }
  .active-dot { color: var(--vscode-charts-blue); }
  .changelist-actions { display: flex; align-items: center; opacity: .75; }
  .group-header:hover .changelist-actions, .group-header:focus-within .changelist-actions { opacity: 1; }
  .changelist-description { padding: 1px 10px 5px 48px; color: var(--vscode-descriptionForeground); font-size: 11px; white-space: pre-wrap; }
  .select-all { margin-left: auto; color: var(--vscode-descriptionForeground); }
  .change-item { min-width: 0; }
  .change-row { min-height: 26px; display: grid; grid-template-columns: 20px 24px 20px minmax(0, 1fr) auto; align-items: center; padding: 0 6px 0 8px; }
  .change-row:hover, .change-row:focus-within { background: var(--vscode-list-hoverBackground); }
  .change-row input { margin: 0; }
  .hunk-toggle { width: 20px; height: 24px; padding: 0; color: var(--vscode-descriptionForeground); background: transparent; }
  .hunk-toggle:disabled { visibility: hidden; }
  .change-status { width: 18px; font-weight: 700; text-align: center; }
  .status-M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .status-A { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-gitDecoration-untrackedResourceForeground)); }
  .status-q { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
  .status-R, .status-C { color: var(--vscode-gitDecoration-renamedResourceForeground, var(--vscode-gitDecoration-modifiedResourceForeground)); }
  .status-D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .status-R { color: var(--vscode-gitDecoration-renamedResourceForeground); }
  .status-bang { color: var(--vscode-gitDecoration-conflictingResourceForeground); }
  .change-file { min-width: 0; display: flex; align-items: baseline; gap: 7px; }
  /* The file name inherits its row's status colour, the way IDEA colours the
     names themselves; directory and stage marks keep their own muted colour. */
  .file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .render-error { max-width: 560px; margin: 40px auto; padding: 0 16px; display: grid; gap: 10px; }
  .render-error-title { font-weight: 600; font-size: 14px; }
  .render-error-detail { margin: 0; padding: 8px 10px; max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--vscode-errorForeground); background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); border-radius: 3px; }
  .render-error-actions { display: flex; gap: 8px; }
  .directory, .stage-mark { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .partial-mark { color: var(--vscode-charts-purple, var(--vscode-descriptionForeground)); border-color: currentColor; }
  .stage-mark { margin-left: auto; padding: 0 4px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; }
  .worktree-mark { border-style: dashed; }
  .row-actions { display: none; align-items: center; }
  .change-row:hover .row-actions, .change-row:focus-within .row-actions { display: flex; }
  .row-action { width: 24px; height: 24px; border-radius: 2px; }
  .state-diff { width: 22px; font-size: 10px; font-weight: 700; color: var(--vscode-textLink-foreground); }
  .row-action:hover { background: var(--vscode-toolbar-hoverBackground); }
  .change-hunks { margin: 0 8px 7px 28px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; overflow: hidden; background: var(--vscode-editor-background); }
  .hunk-group + .hunk-group { border-top: 1px solid var(--vscode-panel-border); }
  .hunk-group-title { padding: 5px 8px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; background: var(--vscode-editorGroupHeader-tabsBackground); }
  .hunk-block + .hunk-block { border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 65%, transparent); }
  .hunk-header { min-height: 29px; display: flex; align-items: center; gap: 6px; padding: 3px 7px; }
  .hunk-header code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
  /* Which Changelist a change belongs to, read at a glance beside its header. */
  /* The list name matters more here than the @@ header beside it, so the
     header is what gives way when the row is narrow. */
  .hunk-owner { flex: 0 0 auto; max-width: 14em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px 6px; border-radius: 9px; font-size: 11px;
    color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
  .hunk-preview { max-height: 220px; margin: 0; padding: 5px 8px 8px; overflow: auto; font: 11px/1.35 var(--vscode-editor-font-family); }
  .hunk-add { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .hunk-delete { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .hunk-context { color: var(--vscode-editor-foreground); }
  .hunk-empty { padding: 8px; color: var(--vscode-descriptionForeground); }
  .commit-form { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto auto minmax(60px, 1fr) auto auto; gap: 0; background: var(--vscode-panel-background, var(--vscode-editor-background)); }
  .commit-form-title { height: 28px; display: flex; align-items: center; padding: 0 9px; font-weight: 600; background: var(--vscode-editorGroupHeader-tabsBackground); border-bottom: 1px solid var(--vscode-panel-border); }
  /* Stacked, not side by side: the commit column is ~340px, and next to the
     select the help text wrapped into a six-line sliver. */
  .commit-mode-row { display: grid; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .commit-mode-help { color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.25; }
  /* A native select and native checkboxes were the only browser-default controls
     left in the panel, so the commit form read as a web form dropped into the
     editor. Both are drawn from the theme instead; the select's own arrow is
     dropped for a chevron on the shell, because a CSP with no img-src cannot
     load a background image for it. */
  .select-shell { position: relative; display: flex; min-width: 0; }
  .select-shell::after { content: ''; position: absolute; right: 9px; top: 50%; width: 5px; height: 5px; margin-top: -4px; border-right: 1px solid var(--vscode-dropdown-foreground, var(--vscode-foreground)); border-bottom: 1px solid var(--vscode-dropdown-foreground, var(--vscode-foreground)); transform: rotate(45deg); opacity: .7; pointer-events: none; }
  .select-shell select { width: 100%; min-width: 0; height: 26px; padding: 0 24px 0 8px; appearance: none; font: inherit; color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); background: var(--vscode-dropdown-background, var(--vscode-input-background)); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 3px; cursor: pointer; text-overflow: ellipsis; }
  .select-shell select:hover { border-color: var(--vscode-focusBorder); }
  .select-shell select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  input[type="checkbox"] { appearance: none; flex: none; width: 15px; height: 15px; margin: 0; position: relative; border: 1px solid var(--vscode-checkbox-border, var(--vscode-dropdown-border, var(--vscode-panel-border))); border-radius: 3px; background: var(--vscode-checkbox-background, var(--vscode-input-background)); cursor: pointer; }
  input[type="checkbox"]:hover { border-color: var(--vscode-focusBorder); }
  input[type="checkbox"]:checked { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
  input[type="checkbox"]:checked::after { content: ''; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px; border: solid var(--vscode-button-foreground); border-width: 0 1.6px 1.6px 0; transform: rotate(45deg); }
  input[type="checkbox"]:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .commit-message { width: calc(100% - 14px); min-height: 60px; margin: 7px; padding: 7px 8px; resize: none; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .commit-message::placeholder { color: var(--vscode-input-placeholderForeground); }
  .commit-options { min-height: 32px; display: flex; align-items: center; flex-wrap: wrap; gap: 14px; padding: 4px 9px 7px; color: var(--vscode-foreground); }
  .commit-options label { display: flex; align-items: center; gap: 6px; white-space: nowrap; cursor: pointer; user-select: none; }
  .commit-options .author-toggle { height: 22px; padding: 0 7px; border-radius: 3px; background: transparent; border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground); }
  .commit-options .author-toggle.active { border-color: var(--vscode-focusBorder); }
  .commit-author-row { display: flex; align-items: center; gap: 8px; padding: 0 9px 7px; }
  .commit-author-row[hidden] { display: none; }
  .commit-author-row input { flex: 1; min-width: 0; height: 24px; padding: 0 7px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .commit-author-row input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .commit-options #selected-count { color: var(--vscode-descriptionForeground); }
  .commit-actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(100px, auto); gap: 4px; padding: 0 7px 7px; }
  .primary { min-height: 29px; padding: 4px 10px; border-radius: 2px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .primary:disabled, .secondary:disabled, .action:disabled { opacity: .45; cursor: default; }
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
  @media (max-width: 650px) { .toolbar, .changes-toolbar { overflow-x: auto; } }
  @media (max-width: 760px) { .commit-options { gap: 9px; font-size: 11px; } }
  @media (max-width: 520px) {
    .changes-workspace { --commit-height: 220px; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(150px, 1fr) 9px var(--commit-height); }
    .changes-splitter { min-height: 9px; cursor: row-resize; }
    .changes-splitter::before { inset: 4px 0 auto; width: auto; height: 1px; }
    .changes-splitter:hover::before, .changes-splitter:focus-visible::before, .changes-splitter.dragging::before { top: 3px; left: 0; width: auto; height: 2px; }
  }
`;

let issueNavigationScriptCache: string | undefined;

/**
 * The compiled issueNavigation module, wrapped as a global for the Webview
 * sandbox. Injecting the build the tests exercise keeps rule compilation and
 * overlap handling in one place instead of a copy that could drift.
 */
function issueNavigationScript(): string {
  issueNavigationScriptCache ??= `const IssueNavigation = (() => { const exports = {}; ${readFileSync(require.resolve("../issueNavigation"), "utf8")}\n;return exports; })();\n`;
  return issueNavigationScriptCache;
}

const logScript = String.raw`
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state = { repositories: [], branches: [], commits: [] };
  let uiState = vscode.getState() || {};
  const hunkState = new Map();
  const hunkRequestIds = new Map();
  let requestSequence = 0;
  let pendingSelectionRequestId;
  let pendingHeadRequestId;
  let lastStateVersion = 0;
  // What the message box held before Amend replaced it, per repository.
  const preAmendDrafts = {};

  /**
   * Puts text into the commit message box as if it had been typed, so the
   * draft is saved and the buttons re-enable through the box's own listener.
   */
  function fillCommitMessage(text) {
    const box = document.getElementById('commit-message');
    if (!box || box.disabled || typeof text !== 'string' || !text) return;
    box.value = text;
    box.dispatchEvent(new Event('input'));
  }
  let expandedChangeHunks; let search; let branchFilter; let activeToolTab; let selectedBranchKeys;
  let authorFilter; let knownAuthors; let dateFilter; let sortMode; let firstParent; let noMerges;
  let collapsedGraphSeries; let selectedGraphSeries; let consoleFilter; let consolePaused;

  /** (Re)derives every view local from persisted state, so recovery can reset them together. */
  function deriveUiState() {
    expandedChangeHunks = new Set(uiState.expandedChangeHunks || []);
    search = uiState.search || '';
    branchFilter = uiState.branchFilter || '';
    activeToolTab = uiState.activeToolTab || 'log';
    selectedBranchKeys = new Set(uiState.selectedBranchKeys || []);
    authorFilter = uiState.authorFilter || '';
    knownAuthors = new Set(uiState.knownAuthors || []);
    dateFilter = uiState.dateFilter || 'all';
    sortMode = uiState.sortMode === 'topological' ? 'topological' : 'date';
    firstParent = Boolean(uiState.firstParent);
    noMerges = Boolean(uiState.noMerges);
    collapsedGraphSeries = new Set(uiState.collapsedGraphSeries || []);
    selectedGraphSeries = uiState.selectedGraphSeries || '';
    consoleFilter = uiState.consoleFilter || 'operations';
    consolePaused = Boolean(uiState.consolePaused);
  }
  // The state VS Code restores was written by whatever version ran last, so a
  // shape this build cannot read must fall back to defaults, not leave the
  // whole window blank before the first render.
  try { deriveUiState(); } catch (error) { uiState = {}; deriveUiState(); }
  let hoveredGraphSeries = '';
  let currentGraphFragments = new Map();
  let pendingCommitHash;
  // Ctrl/Cmd- and Shift-click selection, IDEA's multi-commit workflows. Size 0
  // means the ordinary single selection (pendingCommitHash / state.selection)
  // is authoritative; the anchor is where a Shift range grows from.
  let multiSelectedHashes = new Set();
  let commitSelectionAnchor;
  // IDEA's Edit Commit Message: the commit whose message is being edited in
  // place of the details pane's read-only message, if any.
  let rewordEditingHash;
  // What has been typed so far: every state message re-renders the pane, and
  // the box must not fall back to the commit's message mid-edit.
  let rewordDraft;
  let rewordNeedsFocus = false;
  let selectedFilePath;
  let openMenu;
  let menuInvoker;
  let deferredState;
  let deferredStateVersion = 0;
  let virtualCommits = [];
  let virtualGraph = [];
  let virtualRenderFrame;
  let expectedScrollTop;
  let scrollMemory = {};
  const commitRowHeight = 27;
  const virtualThreshold = 500;
  const colors = ['#4b8ff9', '#e36d75', '#55a868', '#c887d7', '#d99b42', '#45a9a5'];
  const isZh = document.documentElement.lang.toLowerCase().startsWith('zh');
  const zh = isZh ? {
    'Log': '日志', 'Git Log': 'Git 日志', 'Console': '控制台', 'Git Console': 'Git 控制台',
    'Local Changes': '本地更改', 'Shelf': '搁置', 'Shelved Changes': '已搁置的更改',
    'User operations': '用户操作', 'Errors only': '仅错误', 'All commands': '全部命令',
    'Pause scroll': '暂停滚动', 'Resume scroll': '继续滚动', 'Clear': '清空',
    'Branches': '分支', 'All': '全部', 'Local': '本地', 'Remote': '远程', 'Tags': '标签',
    'Recent': '最近', 'Favorites': '收藏', 'Add to Favorites': '添加到收藏', 'Remove from Favorites': '从收藏中移除',
    'Update Project…': '更新项目…',
    'Refresh': '刷新', 'More…': '更多…', 'New Changelist': '新建更改列表', 'Shelve': '搁置',
    'No local changes': '没有本地更改', 'No changes to commit': '没有可提交的更改',
    'Commit Changes': '提交更改', 'Commit Message': '提交消息', 'Amend': '修正提交',
    'Sign-off': '添加签署', 'Skip hooks': '跳过钩子', 'Commit': '提交', 'Commit & Push': '提交并推送',
    'Select All': '全选', 'Clear Selection': '取消全选', '+ Changelist': '+ 更改列表', '+ Shelve': '+ 搁置',
    'Include in commit': '包含在提交中', 'Filter loaded commits': '筛选已加载的提交', 'Filter branches': '筛选分支',
    'Filter the loaded commits by text or hash': '按文本或哈希筛选已加载的提交',
    'Filter branches, remotes and tags by name': '按名称筛选分支、远程和标签',
    'src/path or file name': 'src/路径 或 文件名', 'No branch matches the filter': '没有匹配的分支',
    'No user Git operations yet. Background refresh commands are hidden.': '还没有用户 Git 操作。后台刷新命令已隐藏。',
    'No matching Git command output.': '没有匹配的 Git 命令输出。', 'background': '后台', 'Git root': 'Git 仓库根',
    'Shelve selected local changes': '搁置所选本地更改', 'Shelve selected changes': '搁置所选更改',
    'Save the selected changes as a patch file': '将所选更改保存为补丁文件',
    'Rollback this change': '回滚此改动', 'Rollback': '回滚',
    'Click a graph line to select or collapse its series': '点击图形线条以选择或折叠该系列',
    'Drag to resize commit message': '拖动以调整提交消息高度', 'More Git actions': '更多 Git 操作',
    'The Git tool window failed to render': 'Git 工具窗口渲染失败', 'Reset view state': '重置视图状态',
    'Clear saved view state and render again': '清除保存的视图状态并重新渲染', 'Try again': '重试',
    'Render again without changing anything': '不做更改，重新渲染',
    'Staging area (Index)': '暂存区（Index）', 'Selected files (complete contents)': '所选文件（完整内容）',
    'Commits exactly what is in Git Index; working-tree changes stay uncommitted.': '只提交 Git Index 中已暂存的内容，工作区里未暂存的修改保持不提交。',
    'Commits all changes in each checked file, including its unstaged changes.': '提交每个勾选文件的全部改动，包括其中尚未暂存的部分。',
    'Commit selected changes': '提交所选更改', 'Commit selected changes and push': '提交所选更改并推送',
    'Commit source': '提交内容来源',
    'selected': '已选择',
    'No shelved changes': '没有已搁置的更改', 'Unshelve': '取消搁置',
    'Branch': '分支', 'User': '用户', 'Date': '日期', 'Paths': '路径', 'Lines': '行',
    'Only commits that changed these lines; click to show the whole file': '仅显示改动过这些行的提交；点击可查看整个文件的历史',
    'Edit Commit Message…': '编辑提交消息…', 'Undo Commit…': '撤销提交…',
    'Save Message': '保存消息', 'Rewrite the commit with this message': '用这条消息重写该提交',
    'Cancel': '取消', 'Keep the current message': '保留当前消息', 'Commit message': '提交消息',
    'Accept Yours': '接受你的版本', 'Accept Theirs': '接受对方版本', 'Ignore…': '忽略…',
    'Fixup…': '修正到此提交…', 'Author…': '作者…', 'Commit as another author': '以其他作者身份提交',
    'Author (Name <email>), leave empty for yourself': '作者（姓名 <邮箱>），留空则为本人',
    'All Branches': '所有分支', 'All Users': '所有用户', 'All Dates': '所有日期',
    'Today': '今天', 'Last 7 Days': '最近 7 天', 'Last 30 Days': '最近 30 天', 'Last Year': '最近一年',
    'Sort': '排序', 'By Commit Date': '按提交日期', 'Topologically': '按拓扑', 'Options': '选项',
    'First Parent': '仅第一父提交', 'No Merges': '隐藏合并提交', 'Branch Actions': '分支操作',
    'Collapse Linear Branches': '折叠线性分支', 'Expand Linear Branches': '展开线性分支',
    'Author': '作者', 'Parents': '父提交',
    'Show Diff': '显示差异', 'Compare with Local': '与本地比较', 'Copy Path': '复制路径',
    'Changelist': '变更列表', 'Move…': '移动…', 'some changes': '部分更改',
    'Incoming commits: fetched but not merged': '传入提交：已抓取但未合并',
    'Searching all history': '正在搜索全部历史',
    'Filter loaded commits · Enter searches all history': '筛选已加载的提交 · 回车搜索全部历史',
    'Outgoing commits: not pushed yet': '传出提交：尚未推送',
    'The upstream branch no longer exists': '上游分支已不存在',
    'Commit Message History': '提交消息历史', 'Move this change to another Changelist': '把这处更改移到其他变更列表',
    'Create Patch…': '创建补丁…', 'Copy Revision Number': '复制修订号', 'Cherry-Pick': '拣选提交',
    'Cherry-Pick Selected': '拣选所选提交', 'Compare Versions': '比较版本',
    'Squash Selected…': '压缩所选提交…', 'Drop Selected…': '丢弃所选提交…', 'Drop Commit…': '丢弃提交…',
    'Right-click the selection to cherry-pick the commits in history order, or compare two.': '右键所选内容可按历史顺序拣选这些提交，选中两个时可比较版本。',
    'Checkout': '检出', 'Rename…': '重命名…', 'Delete…': '删除…', 'New Branch…': '新建分支…',
    'Continue': '继续', 'Skip': '跳过', 'Abort': '中止', 'Reset': '重置',
    'Copy Branch Name': '复制分支名', 'Compare Branches': '比较分支', 'Show Files Diff': '显示文件差异',
    'Delete Selected Branches…': '删除所选分支…', 'Show Diff with Working Tree': '与工作区比较',
    'Checkout Revision…': '检出此修订…', 'Reset Current Branch to Here…': '将当前分支重置到这里…',
    'Revert Commit': '还原提交', 'New Tag…': '新建标签…', 'Go to Child Commit': '转到子提交',
    'Go to Parent Commit': '转到父提交', 'Move to Changelist…': '移动到更改列表…',
    'Open Repository Version': '打开仓库版本', 'Get from Revision…': '从修订获取…',
    'History Up to Here': '查看截至此处的历史', 'Load 300 more commits': '再加载 300 条提交',
    'Show commits affecting this path': '显示影响此路径的提交', 'Apply': '应用',
    'Changed Files': '已更改文件', 'Hash': '哈希', 'staged': '已暂存',
    'No matching commits': '没有匹配的提交', 'Loading commit details…': '正在加载提交详情…',
    'Select a commit to view details': '选择一个提交以查看详情',
    'No commit matches the current filters': '没有提交符合当前筛选条件',
    'Open a folder containing a Git repository.': '请打开包含 Git 仓库的文件夹。',
  } : {};
  const t = value => typeof value === 'string' ? (zh[value] || value) : value;
  const post = (type, extra = {}) => vscode.postMessage({ type, root: state.selectedRoot, ...extra });
  const nextRequestId = () => { requestSequence += 1; return requestSequence; };
  const requestHunks = (path, key) => {
    const requestId = nextRequestId(); hunkRequestIds.set(key, requestId);
    post('requestHunks', { path, requestId });
  };
  const requestCommitSelection = hash => {
    const requestId = nextRequestId(); pendingSelectionRequestId = requestId;
    post('selectCommit', { hash, requestId });
  };
  const node = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = t(text); return n; };
  const button = (label, title, handler, className = 'icon-button') => { const b = node('button', className, label); b.type = 'button'; b.title = t(title); b.addEventListener('click', handler); return b; };
  const selectShell = select => { const shell = node('div', 'select-shell'); shell.append(select); return shell; };
  const statusClassFor = letter => letter === '?' ? 'status-q' : letter === '!' ? 'status-bang' : 'status-' + letter;
  const fileCount = count => isZh ? String(count) + ' 个文件' : String(count) + (count === 1 ? ' file' : ' files');
  const saveUiState = extra => { uiState = { ...uiState, ...extra }; vscode.setState(uiState); };
  const selectToolTab = tab => {
    closeContextMenu(); activeToolTab = tab; saveUiState({ activeToolTab: tab });
    post('setActiveTab', { tab }); render();
  };
  const keyboardActivate = (element, handler) => element.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault(); handler();
  });

  function captureScroll() {
    for (const id of ['branch-pane', 'commit-scroll', 'changed-files', 'commit-details', 'changes-list', 'shelf-pane', 'console-output']) {
      const element = document.getElementById(id);
      if (element) scrollMemory[id] = { top: element.scrollTop, left: element.scrollLeft };
    }
    // Remembered across renders, so leaving a tab and coming back keeps its scroll position.
    return { positions: { ...scrollMemory }, focus: captureFocus() };
  }

  function captureFocus() {
    const element = document.activeElement;
    if (!element || element === document.body || !app.contains(element)) return undefined;
    const descriptor = {
      id: element.id || '',
      hash: element.dataset?.hash || '',
      filePath: element.dataset?.filePath || '',
      branchKey: element.dataset?.branchKey || '',
      focusKey: element.dataset?.focusKey || '',
    };
    // Without any of these the element cannot be found again, so do not claim it can be.
    if (!descriptor.id && !descriptor.hash && !descriptor.filePath && !descriptor.branchKey && !descriptor.focusKey) return undefined;
    if (typeof element.selectionStart === 'number') {
      descriptor.selectionStart = element.selectionStart; descriptor.selectionEnd = element.selectionEnd;
    }
    return descriptor;
  }

  function restoreFocus(descriptor) {
    if (!descriptor) return;
    let element = descriptor.id ? document.getElementById(descriptor.id) : undefined;
    if (!element && descriptor.hash) element = document.querySelector('[data-hash="' + CSS.escape(descriptor.hash) + '"]');
    if (!element && descriptor.filePath) element = document.querySelector('[data-file-path="' + CSS.escape(descriptor.filePath) + '"]');
    if (!element && descriptor.branchKey) element = document.querySelector('[data-branch-key="' + CSS.escape(descriptor.branchKey) + '"]');
    if (!element && descriptor.focusKey) element = document.querySelector('[data-focus-key="' + CSS.escape(descriptor.focusKey) + '"]');
    if (!element) return;
    element.focus({ preventScroll: true });
    if (typeof descriptor.selectionStart === 'number' && typeof element.setSelectionRange === 'function') {
      element.setSelectionRange(descriptor.selectionStart, descriptor.selectionEnd);
    }
  }

  function restoreScroll(saved) {
    requestAnimationFrame(() => {
      // The commit window was built while the list was still detached, so it only holds the
      // first rows. Rebuild it for the offset about to be restored, before assigning
      // scrollTop (which replaceChildren would otherwise clamp back to 0) and before
      // restoring focus, whose target row would not exist yet.
      const commitTarget = saved?.positions?.['commit-scroll']?.top;
      if (commitTarget && virtualCommits.length > virtualThreshold) renderCommitWindow(undefined, commitTarget);
      for (const [id, position] of Object.entries(saved?.positions || {})) {
        const element = document.getElementById(id);
        if (!element) continue;
        if (id === 'commit-scroll') expectedScrollTop = position.top;
        element.scrollTop = position.top; element.scrollLeft = position.left;
      }
      restoreFocus(saved?.focus);
    });
  }

  function finishRender(root, saved, graphs = false) {
    app.append(root); restoreScroll(saved);
    if (graphs) requestAnimationFrame(drawGraphs);
  }

  function closeContextMenu(restoreInvoker = false) {
    const invoker = menuInvoker;
    openMenu?.remove(); openMenu = undefined; menuInvoker = undefined;
    if (restoreInvoker && invoker?.isConnected) invoker.focus({ preventScroll: true });
    requestAnimationFrame(flushDeferredState);
  }

  function showContextMenu(event, items) {
    event.preventDefault(); event.stopPropagation(); showContextMenuAt(event.clientX, event.clientY, items, event.currentTarget);
  }

  function showContextMenuAt(clientX, clientY, items, invoker) {
    closeContextMenu();
    menuInvoker = invoker;
    const menu = node('div', 'context-menu'); menu.setAttribute('role', 'menu');
    for (const item of items) {
      if (item.heading) { menu.append(node('div', 'context-menu-heading', item.heading)); continue; }
      if (item.separator) { menu.append(node('div', 'context-menu-separator')); continue; }
      const entry = button('', item.label, () => { closeContextMenu(true); item.run(); }, 'context-menu-item');
      entry.disabled = Boolean(item.disabled); entry.setAttribute('role', 'menuitem');
      entry.append(node('span', 'context-menu-icon', item.icon || ''), node('span', '', item.label)); menu.append(entry);
    }
    document.body.append(menu); openMenu = menu;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(clientX, window.innerWidth - bounds.width - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(clientY, window.innerHeight - bounds.height - 6)) + 'px';
    menu.addEventListener('keydown', event => {
      const entries = [...menu.querySelectorAll('.context-menu-item:not(:disabled)')];
      const current = entries.indexOf(document.activeElement);
      let next = current;
      if (event.key === 'ArrowDown') next = (current + 1) % entries.length;
      else if (event.key === 'ArrowUp') next = (current + entries.length - 1) % entries.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = entries.length - 1;
      else if (event.key === 'Escape') { event.preventDefault(); closeContextMenu(true); return; }
      else if (event.key === 'Tab') { closeContextMenu(); return; }
      else return;
      event.preventDefault(); entries[next]?.focus();
    });
    menu.querySelector('.context-menu-item:not(:disabled)')?.focus();
  }

  function showMenuForElement(element, items) {
    if (openMenu && menuInvoker === element) { closeContextMenu(true); return; }
    const bounds = element.getBoundingClientRect();
    showContextMenuAt(bounds.left, bounds.bottom + 2, items, element);
  }

  function attachContextMenu(element, items) {
    const entries = () => typeof items === 'function' ? items() : items;
    element.addEventListener('contextmenu', event => showContextMenu(event, entries()));
    element.addEventListener('keydown', event => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault(); event.stopPropagation();
      const bounds = element.getBoundingClientRect();
      showContextMenuAt(bounds.left + Math.min(28, bounds.width / 2), bounds.top + Math.min(22, bounds.height), entries(), element);
    });
  }

  let composing = false;
  document.addEventListener('compositionstart', () => { composing = true; }, true);
  document.addEventListener('compositionend', () => { composing = false; }, true);

  function blocksStateRender() {
    const active = document.activeElement;
    return Boolean(composing || openMenu || document.querySelector('.dragging') ||
      (active && active.tagName === 'SELECT'));
  }

  function applyIncomingState(next) {
    if (typeof next.stateVersion === 'number' && next.stateVersion < lastStateVersion) return;
    if (typeof next.stateVersion === 'number') lastStateVersion = next.stateVersion;
    const previousRoot = state.selectedRoot;
    // Keep an in-flight selection unless this push fulfils it or removed its commit;
    // clearing it unconditionally made the highlight jump back to the previous commit.
    const fulfilled = !pendingCommitHash
      || next.selection?.commit?.hash === pendingCommitHash
      || (next.commits ? !next.commits.some(commit => commit.hash === pendingCommitHash) : false);
    state = { ...state, ...next };
    if (fulfilled) pendingCommitHash = undefined;
    for (const commit of next.commits || []) if (commit.author) knownAuthors.add(commit.author);
    saveUiState({ knownAuthors: [...knownAuthors].slice(-500) });
    if (previousRoot && state.selectedRoot && previousRoot !== state.selectedRoot) {
      search = ''; authorFilter = ''; dateFilter = 'all'; selectedFilePath = undefined;
      pendingSelectionRequestId = undefined; pendingHeadRequestId = undefined;
      hunkRequestIds.clear();
      if (!('commits' in next)) { state.commits = []; state.selection = null; }
      collapsedGraphSeries.clear(); selectedGraphSeries = ''; hoveredGraphSeries = '';
      saveUiState({ search, authorFilter, dateFilter, collapsedGraphSeries: [], selectedGraphSeries: '' });
    }
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

  let errorBanner;
  function showErrorBanner(message) {
    // A full render clears the banner via replaceChildren; failures between
    // renders reuse one element instead of stacking a banner per failure.
    if (errorBanner && errorBanner.isConnected) { errorBanner.textContent = message; return; }
    errorBanner = node('div', 'error', message);
    app.prepend(errorBanner);
  }

  function flushDeferredState() {
    if (!deferredState || blocksStateRender()) return;
    const next = deferredState; deferredState = undefined; applyIncomingState(next);
    deferredStateVersion = 0;
  }

  function render() {
    try {
      renderView();
    } catch (error) {
      // Rendering runs again on every state message, so one throw here would
      // otherwise leave the tool window permanently blank with nothing to act
      // on. Show the failure and offer the two ways out.
      app.replaceChildren();
      const panel = node('div', 'render-error');
      panel.append(node('div', 'render-error-title', 'The Git tool window failed to render'));
      panel.append(node('pre', 'render-error-detail', String((error && error.stack) || error)));
      const actions = node('div', 'render-error-actions');
      actions.append(
        button('Reset view state', 'Clear saved view state and render again', () => {
          uiState = {}; vscode.setState(undefined); deriveUiState(); render();
        }, 'primary'),
        button('Try again', 'Render again without changing anything', () => render(), 'secondary'),
      );
      panel.append(actions);
      app.append(panel);
    }
  }

  function renderView() {
    const saved = captureScroll();
    app.replaceChildren(); const root = node('div', 'root');
    const tabs = node('div', 'tool-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Git tool window');
    const logTab = button('Log', 'Git Log', () => selectToolTab('log'), 'tool-tab' + (activeToolTab === 'log' ? ' active' : ''));
    const consoleTab = button('Console', 'Git Console', () => selectToolTab('console'), 'tool-tab' + (activeToolTab === 'console' ? ' active' : ''));
    const changesTab = button('Local Changes', 'Local Changes', () => selectToolTab('changes'), 'tool-tab' + (activeToolTab === 'changes' ? ' active' : ''));
    changesTab.append(node('span', 'count', String(state.totalChanges || 0)));
    const shelfTab = button('Shelf', 'Shelved Changes', () => selectToolTab('shelf'), 'tool-tab' + (activeToolTab === 'shelf' ? ' active' : ''));
    shelfTab.append(node('span', 'count', String((state.shelves || []).length)));
    for (const [tab, active, id] of [[logTab, activeToolTab === 'log', 'log'], [consoleTab, activeToolTab === 'console', 'console'], [changesTab, activeToolTab === 'changes', 'changes'], [shelfTab, activeToolTab === 'shelf', 'shelf']]) {
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
      tab.dataset.tabId = id; tab.dataset.focusKey = 'tab:' + id;
    }
    tabs.append(logTab, consoleTab, changesTab, shelfTab);
    tabs.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
      const items = [logTab, consoleTab, changesTab, shelfTab]; let index = items.indexOf(document.activeElement);
      if (event.key === 'Home') index = 0; else if (event.key === 'End') index = items.length - 1;
      else index = (index + (event.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length;
      event.preventDefault();
      const target = items[index].dataset.tabId;
      items[index].click();
      // The click re-renders the header, so the old element is already detached.
      requestAnimationFrame(() => document.querySelector('[data-tab-id="' + target + '"]')?.focus());
    });
    root.append(tabs);
    if (activeToolTab === 'console') {
      const consoleBar = node('div', 'console-toolbar');
      const filter = node('select'); filter.setAttribute('aria-label', 'Console filter');
      for (const [value, label] of [['operations', 'User operations'], ['errors', 'Errors only'], ['all', 'All commands']]) {
        const option = node('option', '', label); option.value = value; option.selected = value === consoleFilter; filter.append(option);
      }
      filter.addEventListener('change', () => { consoleFilter = filter.value; saveUiState({ consoleFilter }); render(); });
      const pause = button(consolePaused ? 'Resume scroll' : 'Pause scroll', consolePaused ? 'Resume automatic scrolling' : 'Pause automatic scrolling', () => {
        consolePaused = !consolePaused; saveUiState({ consolePaused }); render();
      }, 'action');
      consoleBar.append(node('span', '', 'Git Console'), selectShell(filter), node('span', 'spacer'), pause, button('Clear', 'Clear Git Console', () => post('clearConsole'), 'action'));
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
    const repositories = node('select'); repositories.title = t('Git root');
    for (const repo of state.repositories || []) {
      // The branch button beside this select already shows the current branch;
      // repeating it in the collapsed control read as two widgets for one fact.
      const option = node('option', '', repo.name);
      option.value = repo.root; option.selected = repo.root === state.selectedRoot; repositories.append(option);
    }
    repositories.addEventListener('change', () => { post('selectRepository', { root: repositories.value }); repositories.blur(); });
    return selectShell(repositories);
  }

  function changesToolbar() {
    const bar = node('div', 'changes-toolbar');
    bar.append(
      repositorySelect(),
      button(state.branch || 'detached HEAD', 'Branches', () => post('runCommand', { command: 'jbGit.branchesPopup' }), 'icon-button'),
      button('Refresh', 'Refresh', () => post('refresh'), 'icon-button'),
    );
    if (activeToolTab === 'changes') {
      bar.append(
        button('+ Changelist', 'New Changelist', () => post('createChangelist'), 'action'),
        button('Shelve', 'Shelve selected changes', () => post('createShelf'), 'action'),
        button('Create Patch…', 'Save the selected changes as a patch file', () => post('createLocalPatch'), 'action'),
      );
    }
    bar.append(node('span', 'spacer'), button('⋮', 'More Git actions', () => post('runCommand', { command: 'jbGit.operationsPopup' })));
    return bar;
  }

  function changesWorkspace() {
    const workspace = node('div', 'changes-workspace');
    const splitter = node('div', 'changes-splitter'); splitter.tabIndex = 0; splitter.setAttribute('role', 'separator'); splitter.setAttribute('aria-label', 'Resize commit editor');
    workspace.append(changesPane(), splitter, commitForm());
    requestAnimationFrame(() => setupChangesSplitter(workspace, splitter));
    return workspace;
  }

  function setupChangesSplitter(workspace, splitter) {
    const compact = () => window.matchMedia('(max-width: 520px)').matches;
    const applySize = requested => {
      if (compact()) {
        const maximum = Math.max(130, workspace.clientHeight - 150 - 9);
        const size = Math.max(130, Math.min(requested, maximum)); workspace.style.setProperty('--commit-height', size + 'px');
        splitter.setAttribute('aria-orientation', 'horizontal'); splitter.setAttribute('aria-valuenow', String(Math.round(size)));
      } else {
        const maximum = Math.max(220, workspace.clientWidth - 220 - 9);
        const size = Math.max(220, Math.min(requested, maximum)); workspace.style.setProperty('--commit-width', size + 'px');
        splitter.setAttribute('aria-orientation', 'vertical'); splitter.setAttribute('aria-valuenow', String(Math.round(size)));
      }
    };
    const applyStored = () => applySize(compact() ? Number(uiState.commitPaneHeight) || 220 : Number(uiState.commitPaneWidth) || 340);
    applyStored();
    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(() => {
        if (!workspace.isConnected) { observer.disconnect(); return; }
        if (!splitter.classList.contains('dragging')) applyStored();
      });
      observer.observe(workspace);
    }
    splitter.addEventListener('pointerdown', event => {
      const resize = move => { const bounds = workspace.getBoundingClientRect(); applySize(compact() ? bounds.bottom - move.clientY : bounds.right - move.clientX); };
      const started = beginDrag(splitter, event, resize, () => {
        splitter.classList.remove('dragging');
        const value = Number(splitter.getAttribute('aria-valuenow'));
        saveUiState(compact() ? { commitPaneHeight: value } : { commitPaneWidth: value });
        flushDeferredState();
      });
      if (!started) return;
      splitter.focus(); splitter.classList.add('dragging'); resize(event);
    });
    splitter.addEventListener('keydown', event => {
      const valid = compact() ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']; if (!valid.includes(event.key)) return;
      event.preventDefault(); const current = Number(splitter.getAttribute('aria-valuenow')) || (compact() ? 220 : 340);
      const grow = event.key === 'ArrowUp' || event.key === 'ArrowLeft'; applySize(current + (grow ? 16 : -16));
    });
  }

  function changesPane() {
    const pane = node('div', 'changes-list'); pane.id = 'changes-list';
    if (state.error) pane.append(node('div', 'error', state.error));
    if (state.operation && state.operation.kind !== 'none') {
      const operation = node('div', 'operation', state.operation.kind.toUpperCase() + ' is in progress');
      const actions = node('div', 'operation-actions');
      if (state.operation.canContinue) actions.append(button('Continue', 'Continue operation', () => post('runCommand', { command: 'jbGit.continueOperation' }), 'small-button'));
      if (state.operation.kind === 'rebase' || state.operation.kind === 'cherry-pick') actions.append(button('Skip', 'Skip current commit', () => post('runCommand', { command: 'jbGit.skipOperation' }), 'small-button'));
      if (state.operation.canAbort) actions.append(button(state.operation.kind === 'bisect' ? 'Reset' : 'Abort', state.operation.kind === 'bisect' ? 'End bisect session' : 'Abort operation', () => post('runCommand', { command: 'jbGit.abortOperation' }), 'small-button'));
      operation.append(actions); pane.append(operation);
    }
    if (state.empty) { pane.append(node('div', 'empty', 'Open a folder containing a Git repository.')); return pane; }
    if (!state.totalChanges) { pane.append(node('div', 'empty', 'No local changes')); return pane; }
    for (const list of state.lists || []) {
      const group = node('section', 'change-group');
      const collapsedByRoot = { ...(uiState.collapsedChangelists || {}) };
      const collapsedLists = new Set(collapsedByRoot[state.selectedRoot || ''] || []); const collapsed = collapsedLists.has(list.id);
      const header = node('div', 'group-header'); header.tabIndex = 0; header.setAttribute('role', 'treeitem'); header.setAttribute('aria-expanded', String(!collapsed));
      header.title = list.description || list.name;
      header.append(
        node('span', 'twisty', collapsed ? '›' : '⌄'),
        button(list.active ? '●' : '○', list.active ? 'Active Changelist' : 'Make active Changelist', event => { event.stopPropagation(); post('setActiveChangelist', { id: list.id }); }, list.active ? 'active-dot row-action' : 'row-action'),
        node('span', '', list.name),
        node('span', 'count', String(list.changes.length)),
      );
      const listActions = node('span', 'changelist-actions');
      listActions.append(button('✎', 'Rename or describe Changelist', event => { event.stopPropagation(); post('editChangelist', { id: list.id }); }, 'row-action'));
      if ((state.lists || []).length > 1) {
        listActions.append(button('×', 'Delete Changelist', event => { event.stopPropagation(); post('deleteChangelist', { id: list.id }); }, 'row-action'));
      }
      header.append(listActions);
      const allSelected = list.changes.length > 0 && list.changes.every(change => change.checked);
      header.append(button(allSelected ? 'Clear Selection' : 'Select All', allSelected ? 'Exclude this Changelist from commit' : 'Include this Changelist in commit', event => {
        event.stopPropagation(); post('toggleAll', { checked: !allSelected, listId: list.id });
        group.querySelectorAll('.change-row input[type="checkbox"]').forEach(box => { box.checked = !allSelected; });
        refreshCommitControls();
      }, 'select-all'));
      const toggle = () => {
        if (collapsedLists.has(list.id)) collapsedLists.delete(list.id); else collapsedLists.add(list.id);
        collapsedByRoot[state.selectedRoot || ''] = [...collapsedLists]; saveUiState({ collapsedChangelists: collapsedByRoot }); render();
      };
      header.addEventListener('click', toggle);
      header.addEventListener('keydown', event => { if (event.target === header && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(); } });
      group.append(header);
      if (!collapsed && list.description) group.append(node('div', 'changelist-description', list.description));
      if (!collapsed) for (const change of list.changes) group.append(changeRow(change));
      pane.append(group);
    }
    return pane;
  }

  function changeRow(change) {
    const item = node('div', 'change-item');
    const row = node('div', 'change-row'); row.title = change.path; row.tabIndex = 0; row.setAttribute('role', 'treeitem');
    row.dataset.focusKey = 'change:' + change.path;
    const hunkKey = (state.selectedRoot || '') + '::' + change.path;
    const canExpand = !change.conflicted && change.kind !== 'untracked' && change.kind !== 'ignored' && (change.staged || change.unstaged);
    const expanded = canExpand && expandedChangeHunks.has(hunkKey);
    const expander = button(expanded ? '⌄' : '›', expanded ? 'Hide change hunks' : 'Show change hunks', event => {
      event.stopPropagation();
      if (expandedChangeHunks.has(hunkKey)) {
        expandedChangeHunks.delete(hunkKey);
      } else {
        expandedChangeHunks.add(hunkKey);
        hunkState.set(hunkKey, { loading: true });
        requestHunks(change.path, hunkKey);
      }
      saveUiState({ expandedChangeHunks: [...expandedChangeHunks] }); render();
    }, 'hunk-toggle');
    expander.disabled = !canExpand;
    const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = change.checked; checkbox.title = t('Include in commit');
    checkbox.addEventListener('change', () => { post('togglePath', { path: change.path, checked: checkbox.checked }); refreshCommitControls(); });
    const statusClass = statusClassFor(change.status);
    const file = node('div', 'change-file ' + statusClass); file.append(node('span', 'file-name', change.fileName));
    if (change.directory) file.append(node('span', 'directory', change.directory));
    if (change.staged) file.append(node('span', 'stage-mark', change.unstaged ? 'index + worktree' : 'index'));
    else if (change.unstaged) file.append(node('span', 'stage-mark worktree-mark', 'worktree'));
    // The same file appears under every Changelist that owns part of it, so it
    // has to say that rather than look like two copies of the whole thing.
    if (change.partial) file.append(node('span', 'stage-mark partial-mark', t('some changes')));

    const actions = node('div', 'row-actions');
    const defaultDiffMode = change.unstaged ? 'unstaged' : 'staged';
    if (change.conflicted) {
      actions.append(button('↔', 'Open Merge Conflict Editor', () => post('openDiff', { path: change.path }), 'row-action'));
    } else {
      if (change.staged) actions.append(button('I', 'Show HEAD ↔ Index diff', () => post('openDiff', { path: change.path, mode: 'staged' }), 'row-action state-diff'));
      if (change.unstaged) actions.append(button('W', 'Show Index ↔ Working Tree diff', () => post('openDiff', { path: change.path, mode: 'unstaged' }), 'row-action state-diff'));
    }
    if (change.staged) actions.append(button('−', 'Unstage indexed changes', () => post('unstage', { path: change.path }), 'row-action'));
    if (change.unstaged) actions.append(button('+', 'Stage working-tree changes', () => post('stage', { path: change.path }), 'row-action'));
    actions.append(
      button('⇥', 'Move to Changelist', () => post('moveToChangelist', { path: change.path }), 'row-action'),
      button('↶', 'Rollback', () => post('discard', { path: change.path }), 'row-action'),
    );
    row.append(expander, checkbox, node('span', 'change-status ' + statusClass, change.status), file, actions);
    row.addEventListener('dblclick', event => {
      // Row actions and the checkbox handle their own clicks.
      if (event.target.closest('button, input')) return;
      post('openDiff', { path: change.path, mode: defaultDiffMode });
    });
    row.addEventListener('keydown', event => {
      if (event.target !== row) return;
      if (event.key === 'Enter') { event.preventDefault(); post('openDiff', { path: change.path, mode: defaultDiffMode }); return; }
      // Space toggles inclusion, as in the IntelliJ commit tool window.
      if (event.key === ' ') {
        event.preventDefault();
        checkbox.checked = !checkbox.checked;
        post('togglePath', { path: change.path, checked: checkbox.checked });
        refreshCommitControls();
      }
    });
    const contextItems = [];
    if (change.conflicted) contextItems.push(
      { icon: '↔', label: 'Open Merge Conflict Editor', run: () => post('openDiff', { path: change.path }) },
      { icon: '◧', label: 'Accept Yours', run: () => post('resolveWith', { path: change.path, side: 'ours' }) },
      { icon: '◨', label: 'Accept Theirs', run: () => post('resolveWith', { path: change.path, side: 'theirs' }) },
    );
    else {
      if (change.staged) contextItems.push({ icon: 'I', label: 'Show HEAD ↔ Index Diff', run: () => post('openDiff', { path: change.path, mode: 'staged' }) });
      if (change.unstaged) contextItems.push({ icon: 'W', label: 'Show Index ↔ Working Tree Diff', run: () => post('openDiff', { path: change.path, mode: 'unstaged' }) });
    }
    if (change.staged) contextItems.push({ icon: '−', label: 'Unstage Indexed Changes', run: () => post('unstage', { path: change.path }) });
    if (change.unstaged) contextItems.push({ icon: '+', label: 'Stage Working-tree Changes', run: () => post('stage', { path: change.path }) });
    contextItems.push(
      { icon: '⇥', label: 'Move to Changelist…', run: () => post('moveToChangelist', { path: change.path }) },
      { separator: true },
    );
    if (change.kind === 'untracked') contextItems.push({ icon: '⊘', label: 'Ignore…', run: () => post('ignorePath', { path: change.path }) });
    contextItems.push({ icon: '↶', label: change.kind === 'untracked' ? 'Delete…' : 'Rollback…', run: () => post('discard', { path: change.path }) });
    attachContextMenu(row, contextItems);
    item.append(row);
    if (expanded) item.append(changeHunks(change, hunkKey));
    return item;
  }

  function changeHunks(change, hunkKey) {
    const panel = node('div', 'change-hunks');
    const value = hunkState.get(hunkKey);
    if (!value || value.loading) {
      panel.append(node('div', 'hunk-empty', 'Loading change hunks…'));
      if (!value) {
        hunkState.set(hunkKey, { loading: true });
        queueMicrotask(() => requestHunks(change.path, hunkKey));
      }
      return panel;
    }
    const appendGroup = (title, source, hunks, action) => {
      if (!hunks.length) return;
      const group = node('section', 'hunk-group');
      group.append(node('div', 'hunk-group-title', title + ' · ' + hunks.length));
      hunks.forEach((hunk, index) => {
        const block = node('div', 'hunk-block');
        const header = node('div', 'hunk-header');
        const apply = button(action, action + ' this hunk', () => {
          apply.disabled = true;
          const requestId = nextRequestId(); hunkRequestIds.set(hunkKey, requestId);
          post('applyHunk', { path: change.path, source, index, requestId });
        }, 'small-button');
        header.append(node('code', '', hunk.header), node('span', 'spacer'));
        // Only a working-tree hunk can be rolled back: a staged one is the
        // Index's content, and taking it back is Unstage, not Rollback.
        if (source === 'unstaged') {
          header.append(button('Rollback', 'Rollback this change', () => post('rollbackHunk', { path: change.path, index }), 'small-button'));
        }
        header.append(apply);
        const preview = node('pre', 'hunk-preview');
        const lines = (hunk.lines || []).slice(0, 120);
        for (const line of lines) {
          const part = node('span', line.startsWith('+') ? 'hunk-add' : line.startsWith('-') ? 'hunk-delete' : 'hunk-context', line);
          preview.append(part, document.createTextNode('\n'));
        }
        if ((hunk.lines || []).length > lines.length) preview.append(node('span', 'hunk-context', '…'));
        block.append(header, preview); group.append(block);
      });
      panel.append(group);
    };
    appendGroup('HEAD → Index', 'staged', value.staged || [], 'Unstage');
    appendGroup('Index → Working Tree', 'unstaged', value.unstaged || [], 'Stage');
    appendOwnership(panel, change, value.owned || []);
    if (!(value.staged || []).length && !(value.unstaged || []).length) panel.append(node('div', 'hunk-empty', 'No text hunks available.'));
    return panel;
  }

  /**
   * Which Changelist each change in this file belongs to.
   *
   * Its own group, measured against HEAD, because ownership and staging are
   * different questions: a hunk can be staged and still belong to another
   * Changelist, so re-slicing the staged/unstaged lists would answer neither.
   */
  function appendOwnership(panel, change, owned) {
    if (!owned.length) return;
    const group = node('section', 'hunk-group');
    group.append(node('div', 'hunk-group-title', t('Changelist') + ' · ' + owned.length));
    owned.forEach(entry => {
      const block = node('div', 'hunk-block');
      const header = node('div', 'hunk-header');
      const move = button(t('Move…'), t('Move this change to another Changelist'), () => {
        move.disabled = true;
        const requestId = nextRequestId(); hunkRequestIds.set(hunkKey, requestId);
        post('moveHunk', { path: change.path, key: entry.key, requestId });
      }, 'small-button');
      header.append(
        node('code', '', entry.header),
        node('span', 'hunk-owner', entry.listName),
        node('span', 'spacer'),
        move,
      );
      const preview = node('pre', 'hunk-preview');
      const lines = (entry.lines || []).slice(0, 40);
      for (const line of lines) {
        preview.append(node('span', line.startsWith('+') ? 'hunk-add' : line.startsWith('-') ? 'hunk-delete' : 'hunk-context', line), document.createTextNode('\n'));
      }
      if ((entry.lines || []).length > lines.length) preview.append(node('span', 'hunk-context', '…'));
      block.append(header, preview);
      group.append(block);
    });
    panel.append(group);
  }

  /**
   * Syncs the selected count and Commit buttons with the checkboxes as rendered. The state
   * echo for a toggle is deferred while a menu is open or a drag is running, so without this
   * the controls contradict what the user just clicked.
   */
  function refreshCommitControls() {
    const boxes = [...document.querySelectorAll('#changes-list .change-row input[type="checkbox"]')];
    const selected = boxes.filter(box => box.checked).length;
    state.selectedCount = selected;
    const mode = document.getElementById('commit-mode')?.value || 'files';
    const available = mode === 'staged' ? Number(state.stagedCount || 0) : selected;
    const count = document.getElementById('selected-count');
    if (count) count.textContent = mode === 'staged' ? available + ' indexed files' : selected + ' ' + t('selected');
    const message = document.getElementById('commit-message');
    const disabled = !available || !(message?.value || '').trim();
    for (const id of ['commit-button', 'commit-push-button']) {
      const buttonElement = document.getElementById(id);
      if (buttonElement) buttonElement.disabled = disabled;
    }
  }

  function commitForm() {
    const form = node('div', 'commit-form');
    const title = node('div', 'commit-form-title');
    title.append(
      node('span', '', 'Commit Changes'),
      node('span', 'spacer'),
      button('↺', 'Commit Message History', () => post('messageHistory'), 'row-action'),
    );
    form.append(title);
    const drafts = { ...(uiState.commitMessages || {}) }; const root = state.selectedRoot || '';
    const message = node('textarea', 'commit-message'); message.id = 'commit-message'; message.placeholder = t(state.totalChanges ? 'Commit Message' : 'No changes to commit');
    // IDEA pre-fills the box from commit.template when nothing has been typed;
    // the template is not a draft, so an emptied box shows it again.
    const template = typeof state.commitTemplate === 'string' ? state.commitTemplate : '';
    // The same rule the host applies before committing: with a template, the
    // comment lines are the template's own and Git strips them, so a box
    // holding nothing else is empty as far as the commit is concerned.
    const commentChar = typeof state.commentChar === 'string' && state.commentChar ? state.commentChar : '#';
    message.value = drafts[root] || template; message.disabled = !state.totalChanges;
    const modeRow = node('div', 'commit-mode-row');
    const mode = node('select'); mode.id = 'commit-mode'; mode.setAttribute('aria-label', t('Commit source')); mode.title = t('Commit source');
    const stagedMode = node('option', '', 'Staging area (Index)'); stagedMode.value = 'staged';
    const fileMode = node('option', '', 'Selected files (complete contents)'); fileMode.value = 'files';
    mode.append(stagedMode, fileMode); mode.value = uiState.commitMode === 'staged' ? 'staged' : 'files';
    const modeHelp = node('div', 'commit-mode-help');
    const updateModeHelp = () => {
      modeHelp.textContent = t(mode.value === 'staged'
        ? 'Commits exactly what is in Git Index; working-tree changes stay uncommitted.'
        : 'Commits all changes in each checked file, including its unstaged changes.');
    };
    mode.addEventListener('change', () => { saveUiState({ commitMode: mode.value }); updateModeHelp(); refreshCommitControls(); });
    updateModeHelp(); modeRow.append(selectShell(mode), modeHelp);
    const options = node('div', 'commit-options');
    const amend = checkboxOption('Amend', 'amend', root);
    amend.input.id = 'amend-toggle';
    // IDEA fills the box with the message of the commit being amended, and
    // unchecking gives back what was typed before. The pre-amend draft lives in
    // module state because a background render rebuilds this whole form.
    amend.input.addEventListener('change', () => {
      if (amend.input.checked) {
        preAmendDrafts[root] = message.value;
        pendingHeadRequestId = nextRequestId();
        post('requestHeadMessage', { requestId: pendingHeadRequestId });
      } else if (root in preAmendDrafts) {
        message.value = preAmendDrafts[root];
        delete preAmendDrafts[root];
        message.dispatchEvent(new Event('input'));
      }
    });
    const signoff = checkboxOption('Sign-off', 'signoff', root);
    const noVerify = checkboxOption('Skip hooks', 'noVerify', root);
    const count = node('span', '', ''); count.id = 'selected-count';
    // IDEA's Author field: hidden until asked for, remembered per repository
    // until the commit is made, completing from the recent history's authors.
    const authors = { ...(uiState.commitAuthors || {}) };
    const authorRow = node('div', 'commit-author-row'); authorRow.hidden = !authors[root] && !uiState.authorFieldOpen;
    const authorInput = node('input'); authorInput.id = 'commit-author'; authorInput.type = 'text'; authorInput.setAttribute('list', 'commit-authors');
    authorInput.placeholder = t('Author (Name <email>), leave empty for yourself'); authorInput.value = authors[root] || '';
    authorInput.setAttribute('aria-label', t('Author'));
    const authorList = node('datalist'); authorList.id = 'commit-authors';
    for (const author of state.recentAuthors || []) { const option = node('option'); option.value = author; authorList.append(option); }
    authorInput.addEventListener('input', () => {
      const next = { ...(uiState.commitAuthors || {}) };
      if (authorInput.value.trim()) next[root] = authorInput.value; else delete next[root];
      saveUiState({ commitAuthors: next });
    });
    authorRow.append(node('span', '', 'Author'), authorInput, authorList);
    const authorToggle = button('Author…', 'Commit as another author', () => {
      authorRow.hidden = !authorRow.hidden; saveUiState({ authorFieldOpen: !authorRow.hidden });
      authorToggle.classList.toggle('active', !authorRow.hidden || Boolean(authorInput.value.trim()));
      if (!authorRow.hidden) authorInput.focus();
    }, 'author-toggle' + (!authorRow.hidden || authors[root] ? ' active' : ''));
    options.append(amend.label, signoff.label, noVerify.label, authorToggle, node('span', 'spacer'), count);
    const submit = push => post('commit', { message: message.value, mode: mode.value, amend: amend.input.checked, signoff: signoff.input.checked, noVerify: noVerify.input.checked, push, author: authorInput.value.trim() || undefined });
    const actions = node('div', 'commit-actions');
    const commit = button('Commit', 'Commit selected changes', () => submit(false), 'primary'); commit.id = 'commit-button';
    const commitPush = button('Commit & Push', 'Commit selected changes and push', () => submit(true), 'primary'); commitPush.id = 'commit-push-button';
    // With a template configured, lines starting with # are comments Git will
    // strip, so a box holding only the template is still an empty message.
    const effectivelyEmpty = value => !value.split('\n').some(line => line.trim() && !(template && line.trimStart().startsWith(commentChar)));
    const updateEnabled = () => {
      const available = mode.value === 'staged' ? Number(state.stagedCount || 0) : Number(state.selectedCount || 0);
      const disabled = !available || effectivelyEmpty(message.value); commit.disabled = disabled; commitPush.disabled = disabled;
      count.textContent = mode.value === 'staged' ? available + ' indexed files' : available + ' ' + t('selected');
    };
    message.addEventListener('input', () => { drafts[root] = message.value; saveUiState({ commitMessages: drafts, commitMessage: undefined }); updateEnabled(); });
    mode.addEventListener('change', updateEnabled);
    updateEnabled(); actions.append(commit, commitPush);
    form.append(modeRow, message, options, authorRow, actions); return form;
  }

  function checkboxOption(text, key, root) {
    const persisted = (uiState.commitOptions || {})[root] || {};
    const label = node('label'); const input = node('input'); input.type = 'checkbox'; input.checked = Boolean(persisted[key]);
    input.addEventListener('change', () => {
      // Merge over the live uiState: a render-time snapshot would overwrite
      // whatever the other checkboxes saved since this one was created.
      const options = { ...(uiState.commitOptions || {}) };
      options[root] = { ...(options[root] || {}), [key]: input.checked };
      saveUiState({ commitOptions: options });
    });
    label.append(input, node('span', '', text)); return { label, input };
  }

  function shelfPanel() {
    const pane = node('div', 'shelf-pane'); pane.id = 'shelf-pane';
    const top = node('div', 'group-header');
    top.append(node('span', '', 'Shelved Changes'), node('span', 'spacer'), button('+ Shelve', 'Shelve selected local changes', () => { selectToolTab('changes'); }, 'action'));
    pane.append(top);
    if (!(state.shelves || []).length) { pane.append(node('div', 'empty', 'No shelved changes')); return pane; }
    for (const shelf of state.shelves) {
      const item = node('div', 'shelf-row');
      item.append(node('div', 'shelf-name', shelf.name), node('div', 'shelf-meta', new Date(shelf.createdAt).toLocaleString() + ' · ' + fileCount(shelf.paths.length)));
      const actions = node('div', 'shelf-actions');
      actions.append(button('Unshelve', 'Apply shelved changes', () => post('applyShelf', { id: shelf.id }), 'small-button'), button('×', 'Delete Shelf', () => post('deleteShelf', { id: shelf.id }), 'row-action'));
      item.append(actions); pane.append(item);
    }
    return pane;
  }

  function consolePanel() {
    const output = node('div', 'console'); output.id = 'console-output';
    const traces = (state.traces || []).filter(consoleTraceVisible);
    if (!traces.length) { output.append(node('div', 'empty', consoleFilter === 'operations' ? 'No user Git operations yet. Background refresh commands are hidden.' : 'No matching Git command output.')); return output; }
    for (const trace of traces) output.append(consoleTraceNode(trace));
    if (!consolePaused) requestAnimationFrame(() => { output.scrollTop = output.scrollHeight; });
    return output;
  }

  function consoleTraceVisible(trace) {
    if (consoleFilter === 'all') return true;
    if (consoleFilter === 'errors') return trace.exitCode !== 0;
    return !trace.background || trace.exitCode !== 0;
  }

  function consoleTraceNode(trace) {
    const block = node('details', 'trace'); if (trace.exitCode !== 0) block.open = true;
    const summary = node('summary'); const status = node('span', trace.exitCode === 0 ? 'trace-status-ok' : 'trace-status-error', trace.exitCode === 0 ? '✓' : '!');
    summary.append(status, node('span', 'trace-time', new Date(trace.startedAt).toLocaleTimeString() + ' · ' + trace.durationMs + ' ms'), node('span', 'trace-command', 'git ' + trace.args.join(' ')));
    if (trace.background) summary.append(node('span', 'trace-background', 'background'));
    const detail = node('div', 'trace-output'); detail.append(node('div', 'trace-cwd', trace.cwd));
    if (trace.stdout) detail.append(node('div', '', trace.stdout.slice(0, 4_000).trimEnd()));
    if (trace.stderr) detail.append(node('div', 'trace-error', trace.stderr.slice(0, 4_000).trimEnd()));
    block.append(summary, detail); return block;
  }

  function appendConsoleTrace(trace) {
    if (!consoleTraceVisible(trace)) return;
    const output = document.getElementById('console-output'); if (!output) return;
    const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 36;
    output.querySelector('.empty')?.remove(); output.append(consoleTraceNode(trace));
    if (!consolePaused && nearBottom) output.scrollTop = output.scrollHeight;
  }

  function toolbar() {
    const bar = node('div', 'toolbar');
    const repositories = node('select'); repositories.title = t('Git root');
    for (const repo of state.repositories || []) { const option = node('option', '', repo.name); option.value = repo.root; option.selected = repo.root === state.selectedRoot; repositories.append(option); }
    repositories.addEventListener('change', () => { post('selectRepository', { root: repositories.value }); repositories.blur(); });
    bar.append(
      selectShell(repositories),
      button('Refresh', 'Refresh repository', () => post('refresh'), 'icon-button'),
      button(state.branch || 'detached HEAD', 'Branches', () => post('runCommand', { command: 'jbGit.branchesPopup' }), 'icon-button'),
      node('span', 'spacer'),
      button('More…', 'More Git actions', () => post('runCommand', { command: 'jbGit.operationsPopup' }), 'icon-button'),
    );
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
        // Re-clamp the stored preference, not the current width: feeding the clamped value
        // back in made every shrink permanent, so widening never restored the user's size.
        setColumnWidths(workspace, Number(uiState.branchPaneWidth) || 185, Number(uiState.detailsPaneWidth) || 300, false);
      });
      observer.observe(workspace);
    }
  }

  /**
   * Runs a drag that is guaranteed to end. Pointer capture retargets pointermove/pointerup to
   * the handle and always delivers an end event, whereas a window mouseup is never dispatched
   * when the button is released outside the window, leaving the splitter stuck to the cursor.
   */
  function beginDrag(handle, event, onMove, onEnd) {
    if (event.button !== 0) return false;
    event.preventDefault();
    let done = false;
    try { handle.setPointerCapture(event.pointerId); } catch (error) { /* capture is best effort */ }
    const move = moveEvent => onMove(moveEvent);
    const finish = () => {
      if (done) return;
      done = true;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      handle.removeEventListener('lostpointercapture', finish);
      try { handle.releasePointerCapture(event.pointerId); } catch (error) { /* already released */ }
      onEnd();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    return true;
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
    splitter.addEventListener('pointerdown', event => {
      const started = beginDrag(splitter, event, resize, () => {
        splitter.classList.remove('dragging'); persistColumnWidths(workspace);
        flushDeferredState();
      });
      if (!started) return;
      splitter.focus(); splitter.classList.add('dragging'); resize(event);
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
    const total = workspace.clientWidth || window.innerWidth;
    const compact = total < 650; const tiny = total < 470;
    workspace.classList.toggle('compact', compact); workspace.classList.toggle('tiny', tiny);
    const leftMinimum = 125; const rightMinimum = 190; const centerMinimum = 260; const gutters = compact ? 9 : 18;
    const maximumSides = Math.max(leftMinimum + rightMinimum, total - gutters - centerMinimum);
    let left = Math.max(leftMinimum, requestedLeft || 185);
    let right = Math.max(rightMinimum, requestedRight || 300);
    if (compact) right = Math.min(right, Math.max(rightMinimum, total - gutters - centerMinimum));
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
    const allRow = document.querySelector('.branch-row[data-branch-all]');
    if (allRow) allRow.classList.toggle('active', !selectedBranchKeys.size);
  }

  const isFavoriteBranch = branch => new Set(state.favoriteBranches || []).has(branch.kind + ':' + branch.name);

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
    const current = state.branch;
    const isCurrent = kind === 'local' && branch.name === current;
    const into = current ? "'" + current + "'" : 'current branch';
    const act = action => () => post('contextAction', { action, ref: branch.name, kind: branch.kind });
    const items = [
      { icon: '✓', label: 'Checkout', disabled: isCurrent, run: () => post('checkout', { name: branch.name, kind: branch.kind }) },
      { icon: '+', label: "New Branch from '" + branch.name + "'…", run: act('newBranchFromRef') },
      { separator: true },
    ];
    if (kind === 'local') items.push({ icon: '↑', label: isCurrent ? 'Push…' : "Push '" + branch.name + "'…", run: act('pushRef') });
    // IDEA's per-branch Update: fast-forward it from its upstream without
    // checking it out; on the current branch that is a pull.
    if (kind === 'local' && branch.upstream && !branch.upstreamGone) {
      items.push({ icon: '⟳', label: isCurrent ? 'Update Project…' : "Update '" + branch.name + "'", run: act('updateRef') });
    }
    if (kind !== 'tag') {
      items.push({ icon: isFavoriteBranch(branch) ? '★' : '☆', label: isFavoriteBranch(branch) ? 'Remove from Favorites' : 'Add to Favorites', run: () => post('toggleFavoriteBranch', { name: branch.name, kind: branch.kind }) });
    }
    if (kind === 'remote') items.push(
      { icon: '↓', label: 'Fetch', run: act('fetchRef') },
      { icon: '⇓', label: 'Pull into ' + into + ' using Merge', disabled: !current, run: act('pullRefMerge') },
      { icon: '⇓', label: 'Pull into ' + into + ' using Rebase', disabled: !current, run: act('pullRefRebase') },
    );
    // Merging or rebasing the checked-out branch onto itself is meaningless, so leave it out
    // entirely instead of showing a disabled self-referencing entry.
    if (!isCurrent && kind !== 'tag') items.push(
      { icon: '⇤', label: 'Merge ' + branch.name + ' into ' + into, disabled: !current, run: act('mergeRef') },
      { icon: '⇧', label: 'Rebase ' + into + ' onto ' + branch.name, disabled: !current, run: act('rebaseOntoRef') },
      { icon: '⇪', label: 'Checkout ' + branch.name + ' and Rebase onto ' + into, disabled: !current, run: act('checkoutAndRebase') },
    );
    items.push(
      { separator: true },
      { icon: '↔', label: 'Show Diff with Working Tree', run: act('showRefDiff') },
      { icon: '◇', label: "New Tag at '" + branch.name + "'…", run: act('tagFromRef') },
      { icon: '▣', label: "New Worktree from '" + branch.name + "'…", run: act('createWorktreeFromRef') },
      { icon: '⧉', label: kind === 'tag' ? 'Copy Tag Name' : 'Copy Branch Name', run: act('copyBranch') },
      { separator: true },
    );
    if (kind === 'tag') items.push({ icon: '×', label: 'Delete Tag…', run: act('deleteTag') });
    else items.push(
      { icon: '✎', label: 'Rename…', disabled: kind !== 'local', run: act('renameBranch') },
      { icon: '×', label: 'Delete…', disabled: kind !== 'local' || isCurrent, run: act('deleteBranch') },
    );
    return items;
  }

  function branchPane() {
    const pane = node('aside', 'pane branches'); pane.id = 'branch-pane'; pane.setAttribute('role', 'listbox'); pane.setAttribute('aria-label', 'Branches'); pane.setAttribute('aria-multiselectable', 'true');
    const title = node('div', 'pane-title'); title.append(node('span', '', 'Branches'), node('span', 'spacer'));
    title.append(
      button('↓', 'Fetch all remotes', () => post('runCommand', { command: 'jbGit.fetch' }), 'pane-action'),
      button('⇓', 'Pull into the current branch', () => post('runCommand', { command: 'jbGit.pull' }), 'pane-action'),
      button('↑', 'Push the current branch', () => post('runCommand', { command: 'jbGit.push' }), 'pane-action'),
      button('+', 'New branch', () => post('runCommand', { command: 'jbGit.createBranch' }), 'pane-action'),
      button('⋮', 'More Git actions', () => post('runCommand', { command: 'jbGit.operationsPopup' }), 'pane-action'),
    );
    pane.append(title);
    const filter = node('input', 'branch-filter'); filter.id = 'branch-filter'; filter.type = 'search'; filter.placeholder = t('Filter branches'); filter.value = branchFilter;
    filter.setAttribute('aria-label', t('Filter branches, remotes and tags by name'));
    filter.addEventListener('input', () => { branchFilter = filter.value; saveUiState({ branchFilter }); refreshBranchPane(); });
    pane.append(filter);
    const needle = branchFilter.trim().toLowerCase();
    const matches = branch => !needle || branch.name.toLowerCase().includes(needle);
    const all = button('All', 'Show all branches', () => { setBranchSelection([]); post('selectRef', {}); }, 'branch-row' + (!state.selectedRef && !selectedBranchKeys.size ? ' active' : ''));
    all.dataset.branchAll = '1';
    pane.append(all);

    const favorites = new Set(state.favoriteBranches || []);
    const isFavorite = branch => favorites.has(branch.kind + ':' + branch.name);
    // A row can appear in more than one group (Recent, Favorites, Local), so
    // the roving-focus key has to say which group it is in, or the two copies
    // would collide on the same data-branch-key.
    const branchRow = (branch, group) => {
      const key = branchKey(branch); const selected = selectedBranchKeys.has(key);
      const row = button(branch.name, 'Filter by ' + branch.name + ' (Command/Ctrl-click to select multiple)', event => {
        if (event.metaKey || event.ctrlKey) {
          const next = new Set(selectedBranchKeys); if (next.has(key)) next.delete(key); else next.add(key);
          selectedBranchKeys = next; setBranchSelection(selectedBranches()); return;
        }
        setBranchSelection([branch]); post('selectRef', { ref: branch.name });
      }, 'branch-row' + (selected ? ' selected' : '') + (branch.kind === 'local' && branch.name === state.branch ? ' current' : ''));
      row.dataset.branchKey = key; row.dataset.focusKey = 'branch:' + group + ':' + key;
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(selected));
      // IDEA's incoming/outgoing markers: what a fetch brought in (↓) and
      // what a push would send (↑), right-aligned on the row.
      if (branch.kind === 'local' && (branch.ahead || branch.behind || branch.upstreamGone)) {
        const track = node('span', 'branch-track');
        if (branch.upstreamGone) {
          const gone = node('span', 'track-gone', 'gone');
          gone.title = t('The upstream branch no longer exists');
          track.append(gone);
        } else {
          if (branch.behind) {
            const incoming = node('span', 'track-in', '↓' + branch.behind);
            incoming.title = t('Incoming commits: fetched but not merged');
            track.append(incoming);
          }
          if (branch.ahead) {
            const outgoing = node('span', 'track-out', '↑' + branch.ahead);
            outgoing.title = t('Outgoing commits: not pushed yet');
            track.append(outgoing);
          }
        }
        row.append(track);
      }
      if (branch.kind !== 'tag') {
        // A span, not a button: a button inside a button is invalid markup and
        // the browser would take the click away from the row entirely.
        const starred = isFavorite(branch);
        const star = node('span', 'branch-star' + (starred ? ' on' : ''), starred ? '★' : '☆');
        star.title = t(starred ? 'Remove from Favorites' : 'Add to Favorites');
        star.setAttribute('role', 'button');
        star.setAttribute('aria-label', t(starred ? 'Remove from Favorites' : 'Add to Favorites'));
        star.addEventListener('click', event => {
          event.stopPropagation(); event.preventDefault();
          post('toggleFavoriteBranch', { name: branch.name, kind: branch.kind });
        });
        row.append(star);
      }
      row.addEventListener('dblclick', () => post('checkout', { name: branch.name, kind: branch.kind }));
      attachContextMenu(row, () => branchContextItems(branch));
      return row;
    };
    const appendSection = (label, branches, group) => {
      if (!branches.length) return;
      const section = node('section', 'branch-section'); section.append(node('div', 'section-title', label));
      for (const branch of branches) section.append(branchRow(branch, group));
      pane.append(section);
    };

    // IDEA's groups: recently checked out, then starred, then everything.
    const local = (state.branches || []).filter(item => item.kind === 'local');
    const recent = (state.recentBranches || [])
      .map(name => local.find(item => item.name === name))
      .filter(item => item && matches(item));
    appendSection('Recent', recent, 'recent');
    appendSection('Favorites', (state.branches || []).filter(item => item.kind !== 'tag' && isFavorite(item) && matches(item)), 'favorite');
    let shown = 0;
    for (const [kind, label] of [['local','Local'], ['remote','Remote'], ['tag','Tags']]) {
      const visible = (state.branches || []).filter(item => item.kind === kind && matches(item));
      if (!visible.length) continue;
      shown += visible.length;
      appendSection(label, visible, kind);
    }
    if (!shown && needle) pane.append(node('div', 'empty', 'No branch matches the filter'));
    requestAnimationFrame(() => setupRovingRows(pane, '.branch-row'));
    return pane;
  }

  /** Re-renders only the branch column so typing in its filter cannot disturb the rest of the layout. */
  function refreshBranchPane() {
    const existing = document.getElementById('branch-pane');
    if (!existing) return;
    const replacement = branchPane();
    existing.replaceWith(replacement);
    const input = replacement.querySelector('.branch-filter');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }

  function setupRovingRows(container, selector) {
    const rows = [...container.querySelectorAll(selector)]; if (!rows.length) return;
    const initial = rows.find(row => row.classList.contains('active') || row.classList.contains('selected')) || rows[0];
    rows.forEach(row => { row.tabIndex = row === initial ? 0 : -1; row.addEventListener('keydown', event => {
      let index = rows.indexOf(row);
      if (event.key === 'ArrowDown') index = Math.min(rows.length - 1, index + 1);
      else if (event.key === 'ArrowUp') index = Math.max(0, index - 1);
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = rows.length - 1;
      else return;
      event.preventDefault(); rows.forEach(item => { item.tabIndex = -1; }); rows[index].tabIndex = 0; rows[index].focus();
    }); });
  }

  function commitPane() {
    const pane = node('main', 'pane commit-pane');
    pane.append(commitFilterBar());
    const head = node('div', 'table-head'); head.append(node('span', '', 'Commit'), node('span', '', 'Author'), node('span', '', 'Date'), node('span', '', 'Hash'));
    const scroll = node('div', 'commit-scroll'); scroll.id = 'commit-scroll';
    const list = node('div', 'commit-list'); list.id = 'commit-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Git commits');
    scroll.addEventListener('scroll', () => {
      // Ignore the event caused by our own scroll assignment; matching on the position keeps
      // this self-healing when no event is delivered at all.
      if (expectedScrollTop !== undefined && Math.abs(scroll.scrollTop - expectedScrollTop) < 1) { expectedScrollTop = undefined; return; }
      expectedScrollTop = undefined;
      if (virtualCommits.length <= virtualThreshold || virtualRenderFrame) return;
      virtualRenderFrame = requestAnimationFrame(() => { virtualRenderFrame = undefined; renderCommitWindow(list); });
    });
    scroll.append(head, list); pane.append(scroll); renderCommitRows(list); return pane;
  }

  function filterButton(label, value, title, active, items) {
    const buttonElement = button('', title, () => showMenuForElement(buttonElement, typeof items === 'function' ? items() : items), 'filter-button' + (active ? ' active' : ''));
    buttonElement.append(node('span', '', label), node('span', 'filter-value', value ? ': ' + value : ''), node('span', '', '⌄'));
    return buttonElement;
  }

  function commitFilterBar() {
    const bar = node('div', 'commit-filters');
    const deepActive = Boolean(state.logSearch);
    const input = node('input', 'commit-search' + (deepActive ? ' deep-active' : '')); input.id = 'commit-search'; input.type = 'search';
    input.placeholder = t(deepActive ? 'Searching all history' : 'Filter loaded commits · Enter searches all history');
    input.value = deepActive ? state.logSearch : search;
    input.setAttribute('aria-label', t('Filter the loaded commits by text or hash'));
    const loadedCount = String(state.logLimit || (state.commits || []).length);
    input.title = deepActive
      ? (isZh ? '正在于整个历史中搜索：' + state.logSearch : 'Searching the whole history for: ' + state.logSearch)
      : (isZh ? '筛选当前已加载的 ' + loadedCount + ' 个提交；按 Enter 在整个历史中搜索' : 'Filters the ' + loadedCount + ' commits currently loaded; press Enter to search all history');
    input.addEventListener('input', () => {
      search = input.value; saveUiState({ search });
      // The native ✕ (or emptying the box) also ends an active whole-history
      // search, so one control clears both layers.
      if (!input.value && state.logSearch) { post('deepSearch', { text: '' }); return; }
      renderCommitRows(); refreshDetailsForFilter();
    });
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const text = input.value.trim();
      // Git applies the search over the whole walk, so the loaded-window
      // filter would only hide rows the search already matched.
      search = ''; saveUiState({ search });
      post('deepSearch', { text });
    });
    const branch = filterButton('Branch', state.selectedRef ? shortRef(state.selectedRef) : '', 'Filter by branch', Boolean(state.selectedRef), branchFilterItems);
    const user = filterButton('User', authorFilter, 'Filter by author', Boolean(authorFilter), userFilterItems);
    const dateLabels = { all: '', today: 'Today', week: '7 days', month: '30 days', year: '1 year' };
    const date = filterButton('Date', dateLabels[dateFilter] || '', 'Filter by date', dateFilter !== 'all', dateFilterItems);
    const pathValue = state.filePath ? compactPath(state.filePath) : '';
    const paths = button('', 'Filter by changed path', () => showPathFilterPopover(paths), 'filter-button' + (state.filePath ? ' active' : ''));
    paths.append(node('span', '', 'Paths'), node('span', 'filter-value', pathValue ? ': ' + pathValue : ''), node('span', '', '⌄'));
    const sort = button('⇵', 'Graph and sort options', () => showMenuForElement(sort, graphOptionItems()), 'filter-button sort-button' + ((firstParent || noMerges || sortMode === 'topological') ? ' active' : ''));
    bar.append(input, branch, user, date, paths);
    if (state.lineRange && state.filePath) {
      // IDEA's History for Selection: the walk is narrowed to the lines shown
      // here, and the × widens it back to the whole file.
      const range = state.lineRange.start === state.lineRange.end ? String(state.lineRange.start) : state.lineRange.start + '–' + state.lineRange.end;
      const lines = button('', 'Only commits that changed these lines; click to show the whole file', () => post('clearLineRange'), 'filter-button active line-range-filter');
      lines.append(node('span', '', 'Lines'), node('span', 'filter-value', ': ' + range), node('span', '', '×'));
      bar.append(lines);
    }
    bar.append(sort); return bar;
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
    if (Object.prototype.hasOwnProperty.call(update, 'author')) authorFilter = update.author || '';
    collapsedGraphSeries.clear(); selectedGraphSeries = ''; hoveredGraphSeries = '';
    saveUiState({ sortMode, firstParent, noMerges, collapsedGraphSeries: [], selectedGraphSeries: '' });
    post('setLogOptions', { options: { order: sortMode, firstParent, noMerges, author: authorFilter || undefined, since: dateCutoff(dateFilter) } });
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
    const authors = [...new Set([...knownAuthors, ...(state.commits || []).map(commit => commit.author).filter(Boolean)])].sort((left, right) => left.localeCompare(right));
    return [
      { icon: authorFilter ? '' : '✓', label: 'All Users', run: () => setAuthorFilter('') },
      { separator: true },
      ...authors.map(author => ({ icon: authorFilter === author ? '✓' : '', label: author, run: () => setAuthorFilter(author) })),
    ];
  }

  function setAuthorFilter(author) {
    authorFilter = author; saveUiState({ authorFilter }); render(); setLogOptions({ author });
  }

  function dateCutoff(value) {
    if (value === 'all') return undefined;
    const now = new Date();
    if (value === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    return new Date(now.getTime() - ({ week: 7, month: 30, year: 365 }[value] || 0) * 86400000).toISOString();
  }

  function dateFilterItems() {
    return [
      ['all', 'All Dates'], ['today', 'Today'], ['week', 'Last 7 Days'], ['month', 'Last 30 Days'], ['year', 'Last Year'],
    ].map(([value, label]) => ({ icon: dateFilter === value ? '✓' : '', label, run: () => {
      dateFilter = value; saveUiState({ dateFilter }); render(); setLogOptions({ since: dateCutoff(value) });
    } }));
  }

  function showPathFilterPopover(anchor) {
    closeContextMenu();
    menuInvoker = anchor;
    const popover = node('form', 'filter-popover');
    popover.append(node('div', 'filter-popover-title', 'Show commits affecting this path'));
    const input = node('input'); input.type = 'text'; input.placeholder = t('src/path or file name'); input.value = state.filePath || '';
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
    const model = graphModel(filteredCommits()); const commits = model.commits; const graph = graphLayout(commits, model);
    virtualCommits = commits; virtualGraph = graph;
    if (multiSelectedHashes.size) {
      // A filter or reload can drop selected commits out of the list; the
      // selection follows what is actually shown rather than acting on ghosts.
      const live = new Set(commits.map(commit => commit.hash));
      multiSelectedHashes = new Set([...multiSelectedHashes].filter(hash => live.has(hash)));
    }
    currentGraphFragments = model.fragments;
    for (const id of [...collapsedGraphSeries]) if (!currentGraphFragments.has(id)) collapsedGraphSeries.delete(id);
    if (selectedGraphSeries) {
      const liveSeries = new Set();
      for (const entry of graph) {
        liveSeries.add(entry.nodeSeriesId);
        for (const segment of graphSegments(entry)) liveSeries.add(segment.seriesId);
      }
      if (!liveSeries.has(selectedGraphSeries)) { selectedGraphSeries = ''; saveUiState({ selectedGraphSeries: '' }); }
    }
    const currentHash = pendingCommitHash || state.selection?.commit?.hash;
    if (commits.length && !commits.some(commit => commit.hash === currentHash)) {
      pendingCommitHash = commits[0].hash; requestCommitSelection(pendingCommitHash);
    }
    if (!commits.length) {
      pendingCommitHash = undefined;
      list.replaceChildren();
      const loaded = String(state.logLimit || (state.commits || []).length);
      list.append(node('div', 'empty', isZh ? '已加载的 ' + loaded + ' 个提交中没有匹配项。' : 'No match in the ' + loaded + ' loaded commits.'));
      if (state.hasMoreCommits) list.append(button('Load 300 more commits', 'Load older history', () => post('loadMore'), 'load-more'));
      return;
    }
    renderCommitWindow(list);
  }

  function renderCommitWindow(existing, scrollTopOverride) {
    const list = existing || document.getElementById('commit-list'); if (!list || !virtualCommits.length) return;
    const scroll = list.parentElement;
    const virtual = virtualCommits.length > virtualThreshold;
    const visibleHeight = Math.max(270, scroll?.clientHeight || 600);
    const offset = scrollTopOverride === undefined ? (scroll?.scrollTop || 0) : scrollTopOverride;
    const first = virtual ? Math.max(0, Math.floor(Math.max(0, offset - commitRowHeight) / commitRowHeight) - 18) : 0;
    const last = virtual ? Math.min(virtualCommits.length, first + Math.ceil(visibleHeight / commitRowHeight) + 36) : virtualCommits.length;
    const currentHash = pendingCommitHash || state.selection?.commit?.hash;
    list.replaceChildren();
    if (first) {
      const spacer = node('div', 'virtual-spacer'); spacer.style.height = String(first * commitRowHeight) + 'px'; spacer.setAttribute('role', 'presentation'); list.append(spacer);
    }
    for (let index = first; index < last; index += 1) {
      const commit = virtualCommits[index];
      const selected = multiSelectedHashes.size
        ? multiSelectedHashes.has(commit.hash)
        : (pendingCommitHash || state.selection?.commit.hash) === commit.hash;
      const row = node('div', 'commit-row' + (selected ? ' selected' : '')); row.dataset.hash = commit.hash;
      row.dataset.index = String(index); row.setAttribute('aria-posinset', String(index + 1)); row.setAttribute('aria-setsize', String(virtualCommits.length));
      row.tabIndex = selected || (!currentHash && index === 0) ? 0 : -1; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(selected));
      row.setAttribute('aria-label', (commit.subject || 'No subject') + ', ' + commit.author + ', ' + formatDate(commit.authoredAt) + ', ' + commit.hash.slice(0, 8));
      const subject = node('div', 'subject-cell'); const canvas = node('canvas', 'graph-interactive'); canvas.width = 144; canvas.height = 54; canvas.dataset.graph = JSON.stringify(virtualGraph[index]); canvas.title = t('Click a graph line to select or collapse its series'); canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Commit graph lane ' + String(virtualGraph[index].lane + 1)); attachGraphInteraction(canvas); subject.append(canvas);
      const ordered = orderedRefs(commit.refs);
      const refs = node('div', 'refs'); for (const ref of ordered.slice(0, 2)) refs.append(refChip(ref));
      if (ordered.length > 2) { const more = node('span', 'ref', '+' + String(ordered.length - 2)); more.title = ordered.slice(2).map(shortRef).join('\n'); refs.append(more); }
      subject.append(refs, node('span', 'subject', commit.subject || '(no subject)'));
      row.append(subject, node('div', '', commit.author), node('div', 'muted', formatDate(commit.authoredAt)), node('div', 'muted', commit.hash.slice(0, 8)));
      const select = () => {
        pendingCommitHash = commit.hash;
        multiSelectedHashes = new Set(); commitSelectionAnchor = commit.hash;
        document.querySelectorAll('.commit-row').forEach(item => {
          const active = item.dataset.hash === pendingCommitHash;
          item.classList.toggle('selected', active); item.setAttribute('aria-selected', String(active));
        });
        requestCommitSelection(commit.hash);
      };
      row.addEventListener('click', event => {
        if (event.ctrlKey || event.metaKey) return toggleCommitInSelection(commit.hash);
        if (event.shiftKey) return extendCommitSelection(commit.hash);
        select();
      });
      keyboardActivate(row, select);
      row.addEventListener('keydown', event => navigateCommitRows(event, row));
      row.addEventListener('dblclick', () => post('showPatch', { hash: commit.hash }));
      attachContextMenu(row, () => {
        if (multiSelectedHashes.size > 1 && multiSelectedHashes.has(commit.hash)) {
          // The host re-orders by its own log, so the set can be sent as-is.
          const hashes = [...multiSelectedHashes];
          return [
            { icon: '⌘', label: 'Cherry-Pick Selected', run: () => post('commitsAction', { action: 'cherryPickCommits', hashes }) },
            { icon: '↔', label: 'Compare Versions', disabled: hashes.length !== 2, run: () => post('commitsAction', { action: 'compareCommits', hashes }) },
            { separator: true },
            { icon: '⇊', label: 'Squash Selected…', run: () => post('commitsAction', { action: 'squashCommits', hashes }) },
            { icon: '✕', label: 'Drop Selected…', run: () => post('commitsAction', { action: 'dropCommits', hashes }) },
          ];
        }
        const parent = commit.parents?.[0];
        const child = (state.commits || []).find(item => (item.parents || []).includes(commit.hash));
        // Git decorates the checked-out commit as 'HEAD' or 'HEAD -> branch'.
        const isHead = (commit.refs || []).some(ref => ref === 'HEAD' || ref.startsWith('HEAD -> '));
        select();
        return [
          { icon: '⧉', label: 'Copy Revision Number', run: () => post('contextAction', { action: 'copyRevision', hash: commit.hash }) },
          { icon: '+', label: 'Create Patch…', run: () => post('contextAction', { action: 'createPatch', hash: commit.hash }) },
          { icon: '⌘', label: 'Cherry-Pick', run: () => post('cherryPick', { hash: commit.hash }) },
          { separator: true },
          { icon: '⑂', label: 'Checkout Revision…', run: () => post('contextAction', { action: 'checkoutRevision', hash: commit.hash }) },
          { icon: '↔', label: 'Compare with Local', run: () => post('contextAction', { action: 'compareWithLocal', hash: commit.hash }) },
          { separator: true },
          { icon: '✎', label: 'Edit Commit Message…', run: () => beginRewordEditing(commit.hash) },
          { icon: '⤵', label: 'Fixup…', run: () => post('fixupCommit', { hash: commit.hash }) },
          { icon: '⟲', label: 'Undo Commit…', disabled: !isHead || (commit.parents || []).length !== 1, run: () => post('undoCommit', { hash: commit.hash }) },
          { icon: '↶', label: 'Reset Current Branch to Here…', run: () => post('reset', { hash: commit.hash }) },
          { icon: '↩', label: 'Revert Commit', run: () => post('revert', { hash: commit.hash }) },
          { icon: '✕', label: 'Drop Commit…', run: () => post('commitsAction', { action: 'dropCommits', hashes: [commit.hash] }) },
          { icon: '+', label: 'New Branch…', run: () => post('newBranch', { hash: commit.hash }) },
          { icon: '◆', label: 'New Tag…', run: () => post('contextAction', { action: 'createTag', hash: commit.hash }) },
          { separator: true },
          { icon: '↑', label: 'Go to Child Commit', disabled: !child, run: () => child && selectCommitByHash(child.hash) },
          { icon: '↓', label: 'Go to Parent Commit', disabled: !parent, run: () => parent && selectCommitByHash(parent) },
        ];
      });
      list.append(row);
    }
    if (!list.querySelector('.commit-row[tabindex="0"]')) {
      const first = list.querySelector('.commit-row');
      if (first) first.tabIndex = 0;
    }
    if (last < virtualCommits.length) {
      const spacer = node('div', 'virtual-spacer'); spacer.style.height = String((virtualCommits.length - last) * commitRowHeight) + 'px'; spacer.setAttribute('role', 'presentation'); list.append(spacer);
    }
    if (state.hasMoreCommits) list.append(button('Load 300 more commits', 'Load older history', () => post('loadMore'), 'load-more'));
    requestAnimationFrame(drawGraphs);
  }

  function navigateCommitRows(event, row) {
    const current = Number(row.dataset.index); let next = current;
    if (event.key === 'ArrowDown') next = Math.min(virtualCommits.length - 1, current + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, current - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = virtualCommits.length - 1;
    else if (event.key === 'PageDown') next = Math.min(virtualCommits.length - 1, current + 10);
    else if (event.key === 'PageUp') next = Math.max(0, current - 10);
    else return;
    event.preventDefault();
    if (event.shiftKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const target = virtualCommits[next]; if (!target) return;
      extendCommitSelection(target.hash);
      const focusRow = document.querySelector('.commit-row[data-hash="' + target.hash + '"]');
      if (focusRow) {
        focusRow.scrollIntoView({ block: 'nearest' }); focusRow.focus({ preventScroll: true });
      } else {
        // The target can be outside the currently materialized virtual window.
        // Rebuild around it while preserving the range instead of silently
        // leaving keyboard focus on the old row.
        selectVirtualCommit(next, true, true);
      }
      return;
    }
    selectVirtualCommit(next, true);
  }

  function primarySelectedCommitHash() {
    return pendingCommitHash || state.selection?.commit?.hash;
  }

  /** Ctrl/Cmd+click: the single selection seeds the set, then the click toggles. */
  function toggleCommitInSelection(hash) {
    if (!multiSelectedHashes.size) {
      const primary = primarySelectedCommitHash();
      if (primary && virtualCommits.some(commit => commit.hash === primary)) multiSelectedHashes.add(primary);
    }
    if (multiSelectedHashes.has(hash) && multiSelectedHashes.size > 1) multiSelectedHashes.delete(hash);
    else multiSelectedHashes.add(hash);
    commitSelectionAnchor = hash;
    refreshCommitSelection();
  }

  /** Shift+click or Shift+arrow: everything between the anchor and here, in list order. */
  function extendCommitSelection(hash) {
    const order = virtualCommits.map(commit => commit.hash);
    const anchor = commitSelectionAnchor && order.includes(commitSelectionAnchor)
      ? commitSelectionAnchor
      : (primarySelectedCommitHash() ?? hash);
    const from = order.indexOf(anchor); const to = order.indexOf(hash);
    if (from < 0 || to < 0) return;
    commitSelectionAnchor = anchor;
    multiSelectedHashes = new Set(order.slice(Math.min(from, to), Math.max(from, to) + 1));
    refreshCommitSelection();
  }

  function refreshCommitSelection() {
    document.querySelectorAll('.commit-row').forEach(item => {
      const active = multiSelectedHashes.size ? multiSelectedHashes.has(item.dataset.hash) : item.dataset.hash === primarySelectedCommitHash();
      item.classList.toggle('selected', active); item.setAttribute('aria-selected', String(active));
    });
    // The details pane switches between one commit's details and the
    // selection summary without a host round trip: the subjects are already
    // in the loaded window.
    const pane = document.getElementById('details-pane');
    if (pane) replaceDetailsPane(pane);
  }

  function selectVirtualCommit(index, focus = false, preserveMulti = false) {
    const commit = virtualCommits[index]; if (!commit) return;
    pendingCommitHash = commit.hash; requestCommitSelection(commit.hash);
    if (!preserveMulti) multiSelectedHashes = new Set(); commitSelectionAnchor = commit.hash;
    if (virtualCommits.length <= virtualThreshold) {
      // Every row already exists; rebuilding them all made holding an arrow key janky.
      let target;
      document.querySelectorAll('.commit-row').forEach(item => {
        const active = item.dataset.hash === commit.hash;
        item.classList.toggle('selected', active); item.setAttribute('aria-selected', String(active));
        item.tabIndex = active ? 0 : -1;
        if (active) target = item;
      });
      target?.scrollIntoView({ block: 'nearest' });
      if (focus) target?.focus({ preventScroll: true });
      return;
    }
    const scroll = document.getElementById('commit-scroll');
    const top = commitRowHeight + index * commitRowHeight;
    const needsScroll = scroll && (top < scroll.scrollTop + commitRowHeight || top + commitRowHeight > scroll.scrollTop + scroll.clientHeight);
    const target = needsScroll ? Math.max(0, top - Math.floor(scroll.clientHeight / 2)) : undefined;
    // Render the window for the intended offset first: replaceChildren empties the scroller,
    // so assigning scrollTop beforehand is clamped back to 0 and the list never moves.
    renderCommitWindow(undefined, target);
    if (scroll && target !== undefined) {
      // The assignment fires the scroll listener, which would rebuild the window a frame later
      // and destroy the row focused below.
      expectedScrollTop = target;
      scroll.scrollTop = target;
    }
    if (focus) document.querySelector('.commit-row[data-hash="' + CSS.escape(commit.hash) + '"]')?.focus({ preventScroll: true });
  }

  function refreshDetailsForFilter() {
    const current = document.getElementById('details-pane');
    if (current) replaceDetailsPane(current);
  }

  /** Swaps the details pane while keeping the scroll positions inside it. */
  function replaceDetailsPane(current) {
    const saved = {};
    for (const id of ['changed-files', 'commit-details']) {
      const element = document.getElementById(id);
      if (element) saved[id] = { top: element.scrollTop, left: element.scrollLeft };
    }
    current.replaceWith(detailsPane());
    requestAnimationFrame(() => {
      for (const [id, position] of Object.entries(saved)) {
        const element = document.getElementById(id);
        if (element) { element.scrollTop = position.top; element.scrollLeft = position.left; }
      }
    });
  }

  function selectCommitByHash(hash) {
    const row = document.querySelector('.commit-row[data-hash="' + CSS.escape(hash) + '"]');
    if (row) { row.click(); row.scrollIntoView({ block: 'nearest' }); return; }
    const index = virtualCommits.findIndex(commit => commit.hash === hash); if (index >= 0) selectVirtualCommit(index, true);
  }

  function filteredCommits() {
    let commits = [...(state.commits || [])];
    if (search) commits = commits.filter(c => (c.subject + '\n' + c.body + '\n' + c.author + '\n' + c.email + '\n' + c.hash + '\n' + (c.refs || []).join(' ')).toLowerCase().includes(search.toLowerCase()));
    if (authorFilter) commits = commits.filter(commit => commit.author === authorFilter);
    if (dateFilter !== 'all') {
      const now = new Date(); let cutoff;
      if (dateFilter === 'today') cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      else cutoff = new Date(now.getTime() - ({ week: 7, month: 30, year: 365 }[dateFilter] || 0) * 86400000);
      commits = commits.filter(commit => new Date(commit.authoredAt) >= cutoff);
    }
    return commits;
  }

  let issueRuleCache = { key: '', rules: [] };

  /**
   * Appends text with the configured issue ids turned into tracker links,
   * IDEA's Issue Navigation. Rules compile once per configuration value.
   */
  function appendIssueLinked(parent, text) {
    const raw = state.issueRules || [];
    const key = JSON.stringify(raw);
    if (issueRuleCache.key !== key) issueRuleCache = { key, rules: IssueNavigation.compileIssueRules(raw) };
    for (const segment of IssueNavigation.linkifyIssues(String(text), issueRuleCache.rules)) {
      if (segment.url) {
        const anchor = document.createElement('a');
        anchor.className = 'issue-link';
        anchor.href = segment.url;
        anchor.textContent = segment.text;
        anchor.title = segment.url;
        parent.append(anchor);
      } else {
        parent.append(document.createTextNode(segment.text));
      }
    }
  }

  function beginRewordEditing(hash) {
    rewordEditingHash = hash; rewordDraft = undefined; rewordNeedsFocus = true;
    // The editor needs the complete message, which arrives with the selection.
    if (pendingCommitHash !== hash && state.selection?.commit?.hash !== hash) selectCommitByHash(hash);
    render();
  }

  function endRewordEditing() {
    rewordEditingHash = undefined; rewordDraft = undefined; rewordNeedsFocus = false;
    render();
  }

  /** The message of the selected commit as an editable box: Ctrl/Cmd+Enter saves, Escape cancels. */
  function rewordEditor(commit) {
    const editor = node('div', 'reword-editor');
    const box = node('textarea'); box.id = 'reword-message'; box.spellcheck = true;
    box.value = rewordDraft !== undefined ? rewordDraft : ((commit.body && commit.body.trim()) || commit.subject || '');
    box.setAttribute('aria-label', t('Commit message'));
    const save = () => {
      if (!box.value.trim()) { box.focus(); return; }
      post('rewordCommit', { hash: commit.hash, message: box.value });
      endRewordEditing();
    };
    box.addEventListener('input', () => { rewordDraft = box.value; });
    box.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); endRewordEditing(); return; }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); }
    });
    const actions = node('div', 'reword-actions');
    actions.append(
      button('Save Message', 'Rewrite the commit with this message', save, 'primary-action'),
      button('Cancel', 'Keep the current message', endRewordEditing, 'action'),
      node('span', 'hint', isZh ? 'Ctrl/Cmd+Enter 保存 · Esc 取消' : 'Ctrl/Cmd+Enter saves · Esc cancels'),
    );
    editor.append(box, actions);
    if (rewordNeedsFocus) {
      rewordNeedsFocus = false;
      requestAnimationFrame(() => { box.focus(); box.setSelectionRange(box.value.length, box.value.length); });
    }
    return editor;
  }

  function detailsPane() {
    const pane = node('aside', 'pane details'); pane.id = 'details-pane'; const selection = state.selection;
    if (multiSelectedHashes.size > 1) {
      // IDEA shows the messages of every selected commit; the subjects are in
      // the loaded window, so no host round trip is needed.
      const chosen = virtualCommits.filter(commit => multiSelectedHashes.has(commit.hash));
      const summary = node('div', 'commit-details');
      summary.append(node('div', 'detail-subject', isZh ? '已选择 ' + chosen.length + ' 个提交' : String(chosen.length) + ' commits selected'));
      const listed = node('div', 'detail-multi');
      for (const commit of chosen) {
        const line = node('div', 'multi-commit');
        line.append(node('span', 'muted', commit.hash.slice(0, 8) + '  '), node('span', '', commit.subject || t('(no subject)')));
        listed.append(line);
      }
      summary.append(listed, node('div', 'muted multi-hint', t('Right-click the selection to cherry-pick the commits in history order, or compare two.')));
      pane.append(summary);
      return pane;
    }
    const visible = new Set(filteredCommits().map(commit => commit.hash));
    if (pendingCommitHash && selection?.commit?.hash !== pendingCommitHash) { pane.append(node('div', 'empty', 'Loading commit details…')); return pane; }
    if (!selection || !visible.has(selection.commit.hash)) { pane.append(node('div', 'empty', visible.size ? 'Select a commit to view details' : 'No commit matches the current filters')); return pane; }
    const commit = selection.commit; const details = node('div', 'commit-details');
    details.id = 'commit-details';
    if (rewordEditingHash === commit.hash) {
      details.append(rewordEditor(commit));
    } else {
      const subjectLine = node('div', 'detail-subject');
      appendIssueLinked(subjectLine, commit.subject || t('(no subject)'));
      details.append(subjectLine);
    }
    if ((commit.refs || []).length) {
      const refs = node('div', 'detail-refs');
      for (const ref of orderedRefs(commit.refs)) refs.append(refChip(ref));
      details.append(refs);
    }
    const meta = node('div', 'detail-meta');
    for (const [key, value] of [['Author', commit.author + ' <' + commit.email + '>'], ['Date', new Date(commit.authoredAt).toLocaleString()], ['Commit', commit.hash], ['Parents', (commit.parents || []).map(p => p.slice(0, 10)).join(', ') || '—']]) { meta.append(node('span', '', key), node('strong', '', value)); }
    details.append(meta);
    if (rewordEditingHash !== commit.hash && commit.body && commit.body !== commit.subject) {
      const body = node('div', 'detail-body');
      appendIssueLinked(body, commit.body);
      details.append(body);
    }
    const files = node('div', 'files'); files.id = 'changed-files'; files.setAttribute('role', 'tree');
    files.append(node('div', 'pane-title', t('Changed Files') + ' (' + selection.files.length + ')'));
    const tree = node('div', 'file-tree-root'); tree.append(fileTree(selection.files, commit)); files.append(tree);
    const splitter = node('div', 'detail-splitter'); splitter.tabIndex = 0; splitter.setAttribute('role', 'separator'); splitter.setAttribute('aria-orientation', 'horizontal'); splitter.title = t('Drag to resize commit message');
    setupDetailSplitter(pane, splitter);
    pane.append(files, splitter, details);
    requestAnimationFrame(() => { setMessagePaneHeight(pane, Number(uiState.messagePaneHeight) || 160, false); setupTreeKeyboard(files); });
    return pane;
  }

  function setupTreeKeyboard(tree) {
    const visibleRows = () => [...tree.querySelectorAll('[role="treeitem"]')].filter(row => row.offsetParent !== null);
    const rows = visibleRows(); if (!rows.length) return;
    const initial = rows.find(row => row.classList.contains('selected')) || rows[0]; rows.forEach(row => { row.tabIndex = row === initial ? 0 : -1; });
    tree.addEventListener('keydown', event => {
      const current = event.target.closest?.('[role="treeitem"]'); if (!current) return;
      const live = visibleRows(); let index = live.indexOf(current);
      if (event.key === 'ArrowDown') index = Math.min(live.length - 1, index + 1);
      else if (event.key === 'ArrowUp') index = Math.max(0, index - 1);
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = live.length - 1;
      else if (event.key === 'ArrowRight' && current.getAttribute('aria-expanded') === 'false') { event.preventDefault(); current.click(); return; }
      else if (event.key === 'ArrowLeft' && current.getAttribute('aria-expanded') === 'true') { event.preventDefault(); current.click(); return; }
      else return;
      event.preventDefault(); live.forEach(row => { row.tabIndex = -1; }); live[index].tabIndex = 0; live[index].focus();
    });
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
    const compacted = compactDirectory(directory); directory = compacted.directory;
    const section = node('section');
    const collapsed = new Set(uiState.collapsedFileFolders || []).has(directory.path);
    const row = node('div', 'tree-row'); row.tabIndex = 0; row.style.paddingLeft = (8 + depth * 16) + 'px'; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-expanded', String(!collapsed));
    const count = countTreeFiles(directory);
    const twisty = node('span', 'tree-twisty', collapsed ? '›' : '⌄');
    row.append(twisty, node('span', 'tree-folder', '▱ ' + compacted.name), node('span', 'tree-count', fileCount(count)));
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

  function compactDirectory(directory) {
    const names = [directory.name]; let current = directory;
    while (!current.files.length && current.directories.size === 1) {
      current = current.directories.values().next().value; names.push(current.name);
    }
    return { name: names.join('/'), directory: current };
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
    const statusClass = statusClassFor(file.status[0]);
    row.append(node('span', 'file-status ' + statusClass, file.status[0]), node('span', 'file-path ' + statusClass, file.path.split('/').pop()));
    const selectFile = () => {
      selectedFilePath = file.path;
      document.querySelectorAll('.file-row').forEach(item => {
        const active = item.dataset.filePath === selectedFilePath;
        item.classList.toggle('selected', active); item.setAttribute('aria-selected', String(active));
      });
    };
    row.addEventListener('click', selectFile);
    row.addEventListener('keydown', event => {
      if (event.key === ' ') { event.preventDefault(); selectFile(); }
      if (event.key === 'Enter') { event.preventDefault(); selectFile(); post('openCommitFile', { hash: commit.hash, path: file.path }); }
    });
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
    splitter.addEventListener('pointerdown', event => {
      const started = beginDrag(splitter, event, resize, () => {
        splitter.classList.remove('dragging');
        saveUiState({ messagePaneHeight: parseFloat(getComputedStyle(pane).getPropertyValue('--message-height')) });
        flushDeferredState();
      });
      if (!started) return;
      splitter.focus(); splitter.classList.add('dragging'); resize(event);
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
      const series = graphSeriesAt(canvas, event);
      if (!series) {
        if (selectedGraphSeries) { selectedGraphSeries = ''; saveUiState({ selectedGraphSeries: '' }); drawGraphs(); }
        return;
      }
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

  const refIconMarkup = {
    tag: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.6 1.5H13.9a.6.6 0 0 1 .6.6v5.3a1 1 0 0 1-.3.7l-6 6a1 1 0 0 1-1.4 0L1.6 9.1a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 .7-.3z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11.3" cy="4.7" r="1.15" fill="currentColor"/></svg>',
    local: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.2" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="4.5" cy="12.8" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11.5" cy="3.2" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 4.9v6.2M11.5 4.9v1.4a2.6 2.6 0 0 1-2.6 2.6H7.1a2.6 2.6 0 0 0-2.6 2.6" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    remote: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1.9 8h12.2M8 1.9c1.9 2.1 1.9 10.1 0 12.2M8 1.9c-1.9 2.1-1.9 10.1 0 12.2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  };

  /** Splits a git decoration such as 'HEAD -> main' or 'tag: v1.2' into a kind and a name. */
  function refInfo(ref) {
    const raw = String(ref).trim();
    if (raw.startsWith('tag: ')) return { kind: 'tag', name: raw.slice(5).trim(), head: false };
    if (raw.startsWith('HEAD -> ')) return { kind: 'local', name: raw.slice(8).trim(), head: true };
    if (raw === 'HEAD') return { kind: 'local', name: 'HEAD', head: true };
    const known = (state.branches || []).find(branch => branch.name === raw);
    if (known) return { kind: known.kind, name: raw, head: false };
    return { kind: raw.includes('/') ? 'remote' : 'local', name: raw, head: false };
  }

  /**
   * Orders decorations so the current branch, then tags, stay visible: with limited row width a
   * remote branch that merely mirrors a local one is the least informative chip to drop.
   */
  const refPriority = info => info.head ? 0 : info.kind === 'tag' ? 1 : info.kind === 'local' ? 2 : 3;
  const orderedRefs = refs => [...(refs || [])]
    .map(ref => ({ ref, info: refInfo(ref) }))
    .sort((left, right) => refPriority(left.info) - refPriority(right.info))
    .map(item => item.ref);

  function refChip(ref) {
    const info = refInfo(ref);
    const chip = node('span', 'ref ref-' + info.kind + (info.head ? ' ref-head' : ''));
    const icon = node('span', 'ref-icon'); icon.innerHTML = refIconMarkup[info.kind] || refIconMarkup.local;
    chip.append(icon, node('span', 'ref-name', info.name));
    chip.title = (info.kind === 'tag' ? 'Tag' : info.kind === 'remote' ? 'Remote branch' : info.head ? 'Current branch' : 'Local branch') + ' ' + info.name;
    return chip;
  }
  const formatDate = value => { const date = new Date(value); const now = new Date(); return date.toDateString() === now.toDateString() ? date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : date.toLocaleDateString(); };
  function updateSelectionWithoutRerender() {
    const selectedHash = state.selection?.commit.hash;
    document.querySelectorAll('.commit-row').forEach(item => {
      const active = item.dataset.hash === selectedHash;
      item.classList.toggle('selected', active); item.setAttribute('aria-selected', String(active));
    });
    const current = document.getElementById('details-pane');
    if (current) replaceDetailsPane(current);
  }

  window.addEventListener('message', event => {
    if (event.data.type === 'state') {
      const incomingVersion = event.data.state?.stateVersion;
      if (typeof incomingVersion === 'number' && incomingVersion < Math.max(lastStateVersion, deferredStateVersion)) return;
      if (blocksStateRender()) {
        deferredState = { ...deferredState, ...event.data.state };
        if (typeof incomingVersion === 'number') deferredStateVersion = incomingVersion;
      }
      else applyIncomingState(event.data.state);
    }
    if (event.data.type === 'selection') {
      if (event.data.root !== state.selectedRoot || event.data.requestId !== pendingSelectionRequestId) return;
      state.selection = event.data.selection; pendingCommitHash = undefined;
      pendingSelectionRequestId = undefined;
      if (!(state.selection.files || []).some(file => file.path === selectedFilePath)) selectedFilePath = state.selection.files[0]?.path;
      updateSelectionWithoutRerender();
    }
    if (event.data.type === 'hunks' && typeof event.data.path === 'string') {
      if (event.data.root !== state.selectedRoot) return;
      const key = (state.selectedRoot || '') + '::' + event.data.path;
      if (event.data.requestId !== hunkRequestIds.get(key)) return;
      hunkRequestIds.delete(key);
      hunkState.set(key, { staged: event.data.staged || [], unstaged: event.data.unstaged || [], owned: event.data.owned || [] });
      if (activeToolTab === 'changes' && expandedChangeHunks.has(key)) render();
    }
    if (event.data.type === 'headMessage') {
      // Filled only while Amend is still checked: the reply may arrive after
      // the user already changed their mind.
      const amendBox = document.getElementById('amend-toggle');
      if (event.data.root === state.selectedRoot && event.data.requestId === pendingHeadRequestId
        && amendBox && amendBox.checked) {
        pendingHeadRequestId = undefined;
        fillCommitMessage(event.data.message);
      }
    }
    if (event.data.type === 'applyCommitMessage') fillCommitMessage(event.data.message);
    if (event.data.type === 'trace') { state.traces = [...(state.traces || []), event.data.trace].slice(-200); if (activeToolTab === 'console') appendConsoleTrace(event.data.trace); }
    if (event.data.type === 'consoleCleared') { state.traces = []; if (activeToolTab === 'console') render(); }
    if (event.data.type === 'activateTab' && event.data.tab !== activeToolTab) { selectToolTab(event.data.tab); }
    if (event.data.type === 'committed') {
      const drafts = { ...(uiState.commitMessages || {}) }; delete drafts[state.selectedRoot || ''];
      const options = { ...(uiState.commitOptions || {}) }; delete options[state.selectedRoot || ''];
      // The author was for that one commit; the next one is the user's own again.
      const authors = { ...(uiState.commitAuthors || {}) }; delete authors[state.selectedRoot || ''];
      saveUiState({ commitMessages: drafts, commitMessage: undefined, commitOptions: options, commitAuthors: authors, authorFieldOpen: false }); render();
    }
    if (event.data.type === 'error') {
      showErrorBanner(event.data.message);
      // The reply for this request is not coming, so stop showing the loading placeholder.
      if (pendingCommitHash) { pendingCommitHash = undefined; updateSelectionWithoutRerender(); }
    }
  });
  document.addEventListener('pointerdown', event => {
    // Leave a press on the invoker alone so its own click can toggle the menu closed.
    if (openMenu && !openMenu.contains(event.target) && !menuInvoker?.contains(event.target)) closeContextMenu();
  });
  document.addEventListener('wheel', event => { if (openMenu && !openMenu.contains(event.target)) closeContextMenu(); }, { capture: true, passive: true });
  document.addEventListener('touchmove', event => { if (openMenu && !openMenu.contains(event.target)) closeContextMenu(); }, { capture: true, passive: true });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeContextMenu(true); });
  // A resize moves everything under the menu, so close it like native menus do.
  window.addEventListener('resize', () => closeContextMenu());
  document.addEventListener('focusout', () => setTimeout(flushDeferredState, 0));
  post('ready', { activeTab: activeToolTab, logOptions: { order: sortMode, firstParent, noMerges, author: authorFilter || undefined, since: dateCutoff(dateFilter) } }); render();
`;

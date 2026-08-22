import * as path from "node:path";
import * as vscode from "vscode";
import { ChangelistStore } from "../changelists/store";
import { GitBranch, GitChange, GitCommit, GitCommitFile, GitLogOptions } from "../git/types";
import { GitTraceEvent, isGitAbort } from "../git/runner";
import { RepositoryManager, RepositorySnapshot } from "../repositoryManager";
import { ShelfEntry, ShelfStore } from "../shelves/store";
import { ChangeNode } from "../views/nodes";
import { DiffContentProvider, isBinaryContent } from "../views/diffProvider";
import { BranchComparisonWorkspace } from "./branchComparison";
import { webviewDocument } from "./html";
import { validateGitRefName, validatePathInput } from "../inputValidation";

type LogMessage =
  | { type: "ready"; logOptions?: Partial<GitLogOptions>; activeTab?: ToolTab }
  | { type: "setActiveTab"; tab: ToolTab }
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
  | { type: "toggleAll"; checked: boolean; listId?: string }
  | { type: "loadMore" }
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
  | { type: "contextAction"; action: "copyBranch" | "newBranchFromRef" | "showRefDiff" | "createWorktreeFromRef" | "renameBranch" | "deleteBranch" | "mergeRef" | "rebaseOntoRef" | "pushRef" | "pullRefMerge" | "pullRefRebase" | "fetchRef" | "tagFromRef" | "deleteTag"; ref: string; kind: GitBranch["kind"] }
  | { type: "contextAction"; action: "compareBranches" | "showBranchesDiff" | "deleteBranches"; branches: Array<{ name: string; kind: GitBranch["kind"] }> }
  | { type: "contextAction"; action: "copyPath" | "showFileDiff" | "compareFileWithLocal" | "openRepositoryFile" | "createFilePatch" | "restoreFile" | "fileHistory"; hash: string; path: string };

interface LogSelection {
  commit: GitCommit;
  files: GitCommitFile[];
}

type ToolTab = "log" | "console" | "changes" | "shelf";

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

export class IntelliJGitToolWindowProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "jbGit.toolWindow";

  private view?: vscode.WebviewView;
  private selectedRoot?: string;
  private selectedRef?: string;
  private selectedHash?: string;
  private filePath?: string;
  private logOptions: GitLogOptions = { order: "date", firstParent: false, noMerges: false };
  private requestedTab: ToolTab = "log";
  private pendingOpenTab?: ToolTab;
  private currentCommits: GitCommit[] = [];
  private traces: DisplayTrace[] = [];
  private readonly selectedPaths = new Map<string, Set<string>>();
  private readonly knownPaths = new Map<string, Set<string>>();
  private updateVersion = 0;
  private logLimit = 300;
  private updateTimer?: NodeJS.Timeout;
  private logCache?: { fingerprint: string; commits: GitCommit[] };
  private selectionCache?: { key: string; files: LogSelection["files"] };
  private lastSentBranchesKey?: string;
  private lastSentTracesKey?: string;
  private lastSentLogKey?: string;
  private readonly branchComparisons: BranchComparisonWorkspace;
  private readonly disposables: vscode.Disposable[] = [];
  private didRequestNestedDiscovery = false;

  public constructor(
    private readonly manager: RepositoryManager,
    private readonly changelists: ChangelistStore,
    private readonly shelves: ShelfStore,
    private readonly diffProvider: DiffContentProvider,
    private readonly workspaceState: vscode.Memento,
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
      manager.onDidChange(() => this.scheduleUpdate()),
      changelists.onDidChange(() => this.scheduleUpdate()),
      shelves.onDidChange(() => this.scheduleUpdate()),
    );
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = webviewDocument("Git", logStyles, logScript);
    const registrations: vscode.Disposable[] = [
      view.webview.onDidReceiveMessage((message: LogMessage) => void this.handleMessage(message)),
      view.onDidChangeVisibility(() => { if (view.visible) this.scheduleUpdate(0); }),
    ];
    registrations.push(view.onDidDispose(() => {
      for (const registration of registrations.splice(0)) registration.dispose();
      if (this.view === view) this.view = undefined;
    }));
    this.scheduleUpdate(0);
    if (!this.didRequestNestedDiscovery) {
      this.didRequestNestedDiscovery = true;
      void this.manager.discoverAndRefresh().catch((error) => {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      });
    }
  }

  public async open(root?: string, filePath?: string, tab: ToolTab = "log"): Promise<void> {
    if (root && this.manager.snapshot(root)) {
      if (root !== this.selectedRoot) {
        this.logOptions = { ...this.logOptions, author: undefined, since: undefined };
        this.logLimit = 300;
      }
      this.selectedRoot = root;
    }
    this.requestedTab = tab;
    this.pendingOpenTab = this.view ? undefined : tab;
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

  private tracesFingerprint(): string {
    const last = this.traces[this.traces.length - 1];
    return `${this.traces.length}\0${last?.startedAt ?? ""}\0${last?.durationMs ?? ""}\0${last?.exitCode ?? ""}`;
  }

  private async update(): Promise<void> {
    const view = this.view;
    const webview = view?.webview;
    if (!webview || !view.visible) return;
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
      let logKey: string | undefined;
      if (this.requestedTab === "log") {
        // Everything `git log` depends on is part of this fingerprint, so a
        // working-tree-only refresh (stage/unstage/save) reuses the cache.
        const fingerprint = JSON.stringify([
          refsKey, snapshot.status?.branch.oid ?? null,
          this.selectedRef ?? null, this.logLimit, this.filePath ?? null, this.logOptions,
        ]);
        let commits: GitCommit[];
        if (this.logCache?.fingerprint === fingerprint) {
          commits = this.logCache.commits;
        } else {
          commits = this.selectedRef
            ? await repository.logRef(this.selectedRef, this.logLimit, this.filePath, this.logOptions)
            : await repository.log(this.logLimit, this.filePath, this.logOptions);
          if (version !== this.updateVersion) return;
          this.logCache = { fingerprint, commits };
        }
        this.currentCommits = commits;
        if (!this.selectedHash || !commits.some((commit) => commit.hash === this.selectedHash)) {
          this.selectedHash = commits[0]?.hash;
        }
        const commit = commits.find((item) => item.hash === this.selectedHash);
        if (commit) {
          const selectionKey = `${fingerprint}\0${commit.hash}`;
          if (this.selectionCache?.key !== selectionKey) {
            const files = await this.manager.commitFiles(root, commit.hash);
            if (version !== this.updateVersion) return;
            this.selectionCache = { key: selectionKey, files };
          }
          selection = { commit, files: this.selectionCache.files };
        }
        logKey = `${fingerprint}\0${this.selectedHash ?? ""}`;
        if (this.lastSentLogKey !== logKey) {
          logState = { commits, selection: selection ?? null, logLimit: this.logLimit, hasMoreCommits: this.logLimit < 5_000 && commits.length >= this.logLimit };
        }
      }
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
      // Omitted fields keep their previous value in the webview, which merges
      // incoming state; large arrays are resent only when their identity moved.
      const tracesKey = this.tracesFingerprint();
      const includeTraces = this.requestedTab === "console" && this.lastSentTracesKey !== tracesKey;
      if (version !== this.updateVersion) return;
      await webview.postMessage({
        type: "state",
        state: {
          repositories,
          empty: false,
          selectedRoot: repository.info.rootPath,
          branch: snapshot.status?.branch.head ?? "detached HEAD",
          selectedRef: this.selectedRef ?? null,
          filePath: this.filePath ?? null,
          logOptions: this.logOptions,
          ...(this.lastSentBranchesKey === refsKey ? {} : { branches: snapshot.branches }),
          ...logState,
          operation: snapshot.operation,
          error: snapshot.error ?? null,
          ...(includeTraces ? { traces: this.traces } : {}),
          lists,
          totalChanges: changes.length,
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
      if (logKey !== undefined) this.lastSentLogKey = logKey;
    } catch (error) {
      if (version === this.updateVersion) await webview.postMessage({ type: "error", message: formatError(error) });
    }
  }

  private async handleMessage(message: LogMessage): Promise<void> {
    try {
      if (message.type === "ready") {
        this.logOptions = normalizeLogOptions(message.logOptions);
        if (this.pendingOpenTab) {
          this.requestedTab = this.pendingOpenTab;
          this.pendingOpenTab = undefined;
        } else if (isToolTab(message.activeTab)) this.requestedTab = message.activeTab;
        // A reloaded webview starts empty, so nothing counts as already sent.
        this.lastSentBranchesKey = undefined;
        this.lastSentTracesKey = undefined;
        this.lastSentLogKey = undefined;
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
        if (this.manager.snapshot(message.root)) this.selectedRoot = message.root;
        this.selectedRef = undefined;
        this.selectedHash = undefined;
        this.filePath = undefined;
        this.logOptions = { ...this.logOptions, author: undefined, since: undefined };
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
            const diff = await snapshot.repository.diffAgainstWorkingTree(branch.fullName);
            await this.showReadOnlyDiff(root, `${branch.name} vs working tree`, diff);
            return;
          }
          if (!(await requireTrusted())) return;
          if (message.action === "mergeRef" || message.action === "rebaseOntoRef" || message.action === "pullRefMerge" || message.action === "pullRefRebase") {
            const head = snapshot.status?.branch.head;
            if (!head) return void vscode.window.showWarningMessage("Check out a branch before merging or rebasing.");
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
                { modal: true, detail: "Commits on the current branch are rewritten." },
                "Rebase",
              );
              if (confirmed !== "Rebase") return;
            }
            // IDEA's "Pull into <current>" is a fetch followed by an integration of the
            // remote-tracking ref, so run it as those two verified steps.
            if (pull) {
              const remote = await this.remoteForBranch(root, branch);
              if (!remote) return void vscode.window.showWarningMessage(`'${branch.name}' does not belong to a configured remote.`);
              await this.withCancellableProgress(`Fetching ${remote}`, (signal) => this.manager.fetchRemote(root, remote, signal));
            }
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: `${rebase ? "Rebasing onto" : "Merging"} ${branch.name}` },
              () => rebase ? this.manager.rebase(root, branch.fullName) : this.manager.merge(root, branch.fullName),
            );
            return;
          }
          if (message.action === "fetchRef") {
            if (branch.kind !== "remote") return;
            const remote = await this.remoteForBranch(root, branch);
            if (!remote) return void vscode.window.showWarningMessage(`'${branch.name}' does not belong to a configured remote.`);
            await this.withCancellableProgress(`Fetching ${remote}`, (signal) => this.manager.fetchRemote(root, remote, signal));
            return;
          }
          if (message.action === "pushRef") {
            if (branch.kind !== "local") return;
            // push() honours the branch's own upstream and establishes one when missing,
            // so only a branch that is not checked out needs an explicit destination.
            if (branch.name === snapshot.status?.branch.head) {
              await this.withCancellableProgress(`Pushing ${branch.name}`, (signal) => this.manager.push(root, false, signal));
              return;
            }
            const remote = await this.pickPushRemote(root, branch);
            if (!remote) return;
            await this.withCancellableProgress(
              `Pushing ${branch.name} to ${remote}`,
              (signal) => this.manager.pushRemote(root, remote, branch.name, false, signal, !branch.upstream),
            );
            return;
          }
          if (message.action === "tagFromRef") {
            const name = await vscode.window.showInputBox({ title: `New Tag at '${branch.name}'`, prompt: "Tag name", validateInput: (value) => validateGitRefName(value) });
            if (!name?.trim()) return;
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: `Creating tag ${name.trim()}` },
              () => this.manager.createTag(root, name.trim(), branch.fullName),
            );
            return;
          }
          if (message.action === "deleteTag") {
            if (branch.kind !== "tag") return;
            const confirmed = await vscode.window.showWarningMessage(`Delete tag '${branch.name}'?`, { modal: true }, "Delete");
            if (confirmed === "Delete") await this.manager.deleteTag(root, branch.name);
            return;
          }
          if (message.action === "newBranchFromRef") {
            const name = await vscode.window.showInputBox({ title: `New Branch from '${branch.name}'`, prompt: "Branch name", validateInput: (value) => validateGitRefName(value) });
            if (name?.trim()) await this.manager.createBranch(root, name.trim(), branch.fullName);
            return;
          }
          if (message.action === "createWorktreeFromRef") {
            const worktreePath = await vscode.window.showInputBox({ title: `New Worktree from '${branch.name}'`, prompt: "Worktree path", placeHolder: "../feature-worktree", validateInput: (value) => validatePathInput(value) });
            if (!worktreePath?.trim()) return;
            const newBranch = await vscode.window.showInputBox({ title: "Optional New Branch", prompt: "Leave empty to use the selected ref", validateInput: (value) => validateGitRefName(value, true) });
            await this.manager.addWorktree(root, worktreePath.trim(), branch.name, newBranch?.trim() || undefined);
            return;
          }
          if (message.action === "renameBranch") {
            if (branch.kind !== "local") return;
            const name = await vscode.window.showInputBox({ title: `Rename '${branch.name}'`, value: branch.name, validateInput: (value) => validateGitRefName(value) });
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
            if (isBinaryContent(left) || isBinaryContent(right)) return void vscode.window.showInformationMessage(`${file.path} is binary and cannot be shown in the text diff editor.`);
            const label = `${file.path} (${commit.hash.slice(0, 8)} ↔ Local)`;
            const leftUri = this.diffProvider.registerFile(root, `${label}:commit`, file.path, left.toString("utf8"));
            const rightUri = this.diffProvider.registerFile(root, `${label}:local`, file.path, right.toString("utf8"));
            await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, label, { preview: true });
            return;
          }
          if (message.action === "openRepositoryFile") {
            const content = await snapshot.repository.fileContent(file.path, commit.hash);
            if (isBinaryContent(content)) return void vscode.window.showInformationMessage(`${file.path} is binary and cannot be opened as text.`);
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
          const diff = await snapshot.repository.diffAgainstWorkingTree(commit.hash);
          await this.showReadOnlyDiff(root, `${commit.hash.slice(0, 12)} vs local`, diff);
          return;
        }
        if (!(await requireTrusted())) return;
        if (message.action === "checkoutRevision") {
          const confirmed = await vscode.window.showWarningMessage(`Checkout ${commit.hash.slice(0, 8)} in detached HEAD mode?`, { modal: true }, "Checkout");
          if (confirmed === "Checkout") await this.manager.checkoutRevision(root, commit.hash);
          return;
        }
        if (message.action === "createTag") {
          const name = await vscode.window.showInputBox({ title: `New Tag at ${commit.hash.slice(0, 8)}`, prompt: "Tag name", validateInput: (value) => validateGitRefName(value) });
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
        const mode = change.staged && !change.unstaged ? "staged" : "unstaged";
        await vscode.commands.executeCommand("jbGit.openDiff", new ChangeNode(root, change, mode));
        return;
      }
      if (message.type === "selectRef") {
        if (message.ref && !snapshot.branches.some((branch) => branch.name === message.ref)) return;
        this.selectedRef = message.ref;
        this.selectedHash = undefined;
        this.logLimit = 300;
        return void this.update();
      }
      if (message.type === "setPathFilter") {
        const filePath = message.path?.trim();
        if (filePath && (filePath.length > 4096 || /[\r\n\0]/.test(filePath))) return;
        this.filePath = filePath || undefined;
        this.selectedHash = undefined;
        this.logLimit = 300;
        return void this.update();
      }
      if (message.type === "setLogOptions") {
        this.logOptions = normalizeLogOptions(message.options);
        this.selectedHash = undefined;
        this.logLimit = 300;
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
        await this.showReadOnlyDiff(root, message.hash.slice(0, 12), patch);
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
        // Never await a notification here: showInformationMessage only settles once the
        // toast is dismissed, which used to stall the push for as long as it stayed up.
        if (message.push) {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Pushing ${revision.slice(0, 12)}`, cancellable: true },
            async (_progress, token) => {
              const controller = new AbortController();
              const registration = token.onCancellationRequested(() => controller.abort());
              try { await this.manager.push(root, false, controller.signal); } finally { registration.dispose(); }
            },
          );
          void vscode.window.showInformationMessage(`Committed ${revision.slice(0, 12)} and pushed it.`);
        } else {
          void vscode.window.showInformationMessage(`Created commit ${revision.slice(0, 12)}`);
        }
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
        const shouldConfirm = vscode.workspace.getConfiguration("jbGit").get<boolean>("confirmDiscard", true);
        if (shouldConfirm) {
          const confirmed = await vscode.window.showWarningMessage(
            `${action} all local changes in ${change.path}?`, { modal: true }, action,
          );
          if (confirmed !== action) return;
        }
        if (change.kind === "untracked") await this.manager.cleanUntracked(root, [change.path]);
        else await this.manager.discard(root, [change.path]);
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
          void vscode.window.showWarningMessage(`Skipped ${conflicted.length} conflicted file(s): resolve merge conflicts before shelving them.`);
        }
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
        if (branch) await this.manager.checkout(root, branch.name, branch.kind, branch.fullName);
        return;
      }
      if (!/^[0-9a-f]{40}$/i.test(message.hash)) return;
      if (message.type === "newBranch") {
        const name = await vscode.window.showInputBox({ title: "New Branch", prompt: `Create from ${message.hash.slice(0, 12)}`, validateInput: (value) => validateGitRefName(value) });
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
      if (isGitAbort(error)) return;
      await vscode.window.showErrorMessage(formatError(error));
      await this.view?.webview.postMessage({ type: "error", message: formatError(error) });
    }
  }

  public dispose(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
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

  /** Picks the remote to push a branch that is not checked out to, preferring its upstream. */
  private async pickPushRemote(root: string, branch: GitBranch): Promise<string | undefined> {
    const remotes = await this.manager.remotes(root);
    if (!remotes.length) {
      await vscode.window.showWarningMessage("This repository has no remote. Add a remote before pushing.");
      return undefined;
    }
    const upstreamRemote = branch.upstream
      ? [...remotes].sort((left, right) => right.name.length - left.name.length)
        .find((remote) => branch.upstream?.startsWith(`${remote.name}/`))?.name
      : undefined;
    if (upstreamRemote) return upstreamRemote;
    if (remotes.length === 1) return remotes[0].name;
    const origin = remotes.find((remote) => remote.name === "origin");
    if (origin) return origin.name;
    const picked = await vscode.window.showQuickPick(
      remotes.map((remote) => ({ label: remote.name, description: remote.fetchUrl })),
      { title: `Push '${branch.name}' to`, placeHolder: "Select a remote" },
    );
    return picked?.label;
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
    if (isBinaryContent(left) || isBinaryContent(right)) return void vscode.window.showInformationMessage(`${file.path} is binary and cannot be shown in the text diff editor.`);
    const leftUri = this.diffProvider.registerFile(root, `${label}:parent`, oldPath, left.toString("utf8"));
    const rightUri = this.diffProvider.registerFile(root, `${label}:commit`, file.path, right.toString("utf8"));
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

function isToolTab(value: unknown): value is ToolTab {
  return value === "log" || value === "console" || value === "changes" || value === "shelf";
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
  .branch-filter { width: calc(100% - 12px); height: 23px; margin: 5px 6px 3px; padding: 0 6px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font-size: 11px; }
  .section-title { height: 23px; display: flex; align-items: center; padding: 0 9px; color: var(--vscode-descriptionForeground); font-weight: 600; }
  .branch-row { height: 25px; width: 100%; display: flex; align-items: center; gap: 6px; padding: 0 9px 0 16px; text-align: left; white-space: nowrap; }
  .branch-row:hover { background: var(--vscode-list-hoverBackground); }
  .branch-row.active, .branch-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .branch-row.current::before { content: '✓'; width: 11px; margin-left: -11px; color: var(--vscode-charts-green); }
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
  .select-all { margin-left: auto; color: var(--vscode-descriptionForeground); }
  .change-row { height: 26px; display: grid; grid-template-columns: 24px 20px minmax(0, 1fr) auto; align-items: center; padding: 0 6px 0 20px; }
  .change-row:hover, .change-row:focus-within { background: var(--vscode-list-hoverBackground); }
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
  .change-row:hover .row-actions, .change-row:focus-within .row-actions { display: flex; }
  .row-action { width: 24px; height: 24px; border-radius: 2px; }
  .row-action:hover { background: var(--vscode-toolbar-hoverBackground); }
  .commit-form { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(60px, 1fr) auto auto; gap: 0; background: var(--vscode-panel-background, var(--vscode-editor-background)); }
  .commit-form-title { height: 28px; display: flex; align-items: center; padding: 0 9px; font-weight: 600; background: var(--vscode-editorGroupHeader-tabsBackground); border-bottom: 1px solid var(--vscode-panel-border); }
  .commit-message { width: calc(100% - 14px); min-height: 60px; margin: 7px; padding: 7px 8px; resize: none; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .commit-message::placeholder { color: var(--vscode-input-placeholderForeground); }
  .commit-options { min-height: 30px; display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 0 8px; color: var(--vscode-descriptionForeground); }
  .commit-options label { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
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
  @media (max-width: 760px) { .commit-options { gap: 5px; font-size: 11px; } }
  @media (max-width: 520px) {
    .changes-workspace { --commit-height: 220px; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(150px, 1fr) 9px var(--commit-height); }
    .changes-splitter { min-height: 9px; cursor: row-resize; }
    .changes-splitter::before { inset: 4px 0 auto; width: auto; height: 1px; }
    .changes-splitter:hover::before, .changes-splitter:focus-visible::before, .changes-splitter.dragging::before { top: 3px; left: 0; width: auto; height: 2px; }
  }
`;

const logScript = String.raw`
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state = { repositories: [], branches: [], commits: [] };
  let uiState = vscode.getState() || {};
  let search = uiState.search || '';
  let branchFilter = uiState.branchFilter || '';
  let activeToolTab = uiState.activeToolTab || 'log';
  let selectedBranchKeys = new Set(uiState.selectedBranchKeys || []);
  let authorFilter = uiState.authorFilter || '';
  let knownAuthors = new Set(uiState.knownAuthors || []);
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
  let menuInvoker;
  let deferredState;
  let consoleFilter = uiState.consoleFilter || 'operations';
  let consolePaused = Boolean(uiState.consolePaused);
  let virtualCommits = [];
  let virtualGraph = [];
  let virtualRenderFrame;
  const commitRowHeight = 27;
  const virtualThreshold = 500;
  const colors = ['#4b8ff9', '#e36d75', '#55a868', '#c887d7', '#d99b42', '#45a9a5'];
  const zh = document.documentElement.lang.toLowerCase().startsWith('zh') ? {
    'Log': '日志', 'Git Log': 'Git 日志', 'Console': '控制台', 'Git Console': 'Git 控制台',
    'Local Changes': '本地更改', 'Shelf': '搁置', 'Shelved Changes': '已搁置的更改',
    'User operations': '用户操作', 'Errors only': '仅错误', 'All commands': '全部命令',
    'Pause scroll': '暂停滚动', 'Resume scroll': '继续滚动', 'Clear': '清空',
    'Branches': '分支', 'All': '全部', 'Local': '本地', 'Remote': '远程', 'Tags': '标签',
    'Refresh': '刷新', 'More…': '更多…', 'New Changelist': '新建更改列表', 'Shelve': '搁置',
    'No local changes': '没有本地更改', 'No changes to commit': '没有可提交的更改',
    'Commit Changes': '提交更改', 'Commit Message': '提交消息', 'Amend': '修正提交',
    'Sign-off': '添加签署', 'Skip hooks': '跳过钩子', 'Commit': '提交', 'Commit & Push': '提交并推送',
    'No shelved changes': '没有已搁置的更改', 'Unshelve': '取消搁置',
    'Branch': '分支', 'User': '用户', 'Date': '日期', 'Paths': '路径',
    'All Branches': '所有分支', 'All Users': '所有用户', 'All Dates': '所有日期',
    'Today': '今天', 'Last 7 Days': '最近 7 天', 'Last 30 Days': '最近 30 天', 'Last Year': '最近一年',
    'Sort': '排序', 'By Commit Date': '按提交日期', 'Topologically': '按拓扑', 'Options': '选项',
    'First Parent': '仅第一父提交', 'No Merges': '隐藏合并提交', 'Branch Actions': '分支操作',
    'Collapse Linear Branches': '折叠线性分支', 'Expand Linear Branches': '展开线性分支',
    'Author': '作者', 'Commit': '提交', 'Parents': '父提交',
    'Show Diff': '显示差异', 'Compare with Local': '与本地比较', 'Copy Path': '复制路径',
    'Create Patch…': '创建补丁…', 'Copy Revision Number': '复制修订号', 'Cherry-Pick': '拣选提交',
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
  const post = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  const node = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = t(text); return n; };
  const button = (label, title, handler, className = 'icon-button') => { const b = node('button', className, label); b.type = 'button'; b.title = t(title); b.addEventListener('click', handler); return b; };
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
    const result = { positions: {}, focus: captureFocus() };
    for (const id of ['branch-pane', 'commit-scroll', 'changed-files', 'commit-details', 'changes-list', 'shelf-pane', 'console-output']) {
      const element = document.getElementById(id);
      if (element) result.positions[id] = { top: element.scrollTop, left: element.scrollLeft };
    }
    return result;
  }

  function captureFocus() {
    const element = document.activeElement;
    if (!element || element === document.body || !app.contains(element)) return undefined;
    const descriptor = {
      id: element.id || '',
      hash: element.dataset?.hash || '',
      filePath: element.dataset?.filePath || '',
      branchKey: element.dataset?.branchKey || '',
    };
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
    if (!element) return;
    element.focus({ preventScroll: true });
    if (typeof descriptor.selectionStart === 'number' && typeof element.setSelectionRange === 'function') {
      element.setSelectionRange(descriptor.selectionStart, descriptor.selectionEnd);
    }
  }

  function restoreScroll(saved) {
    requestAnimationFrame(() => {
      for (const [id, position] of Object.entries(saved?.positions || {})) {
        const element = document.getElementById(id);
        if (element) { element.scrollTop = position.top; element.scrollLeft = position.left; }
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
      else return;
      event.preventDefault(); entries[next]?.focus();
    });
    menu.querySelector('.context-menu-item:not(:disabled)')?.focus();
  }

  function showMenuForElement(element, items) {
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
    return Boolean(composing || openMenu || document.querySelector('.dragging, .splitter.active') ||
      (active && active.tagName === 'SELECT'));
  }

  function applyIncomingState(next) {
    const previousRoot = state.selectedRoot;
    state = { ...state, ...next }; pendingCommitHash = undefined;
    for (const commit of next.commits || []) if (commit.author) knownAuthors.add(commit.author);
    saveUiState({ knownAuthors: [...knownAuthors].slice(-500) });
    if (previousRoot && state.selectedRoot && previousRoot !== state.selectedRoot) {
      search = ''; authorFilter = ''; dateFilter = 'all'; selectedFilePath = undefined;
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
  }

  function render() {
    const saved = captureScroll();
    app.replaceChildren(); const root = node('div', 'root');
    const tabs = node('div', 'tool-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Git tool window');
    const logTab = button('Log', 'Git Log', () => selectToolTab('log'), 'tool-tab' + (activeToolTab === 'log' ? ' active' : ''));
    const consoleTab = button('Console', 'Git Console', () => selectToolTab('console'), 'tool-tab' + (activeToolTab === 'console' ? ' active' : ''));
    const changesTab = button('Local Changes', 'Local Changes', () => selectToolTab('changes'), 'tool-tab' + (activeToolTab === 'changes' ? ' active' : ''));
    changesTab.append(node('span', 'count', String(state.totalChanges || 0)));
    const shelfTab = button('Shelf', 'Shelved Changes', () => selectToolTab('shelf'), 'tool-tab' + (activeToolTab === 'shelf' ? ' active' : ''));
    shelfTab.append(node('span', 'count', String((state.shelves || []).length)));
    for (const [tab, active] of [[logTab, activeToolTab === 'log'], [consoleTab, activeToolTab === 'console'], [changesTab, activeToolTab === 'changes'], [shelfTab, activeToolTab === 'shelf']]) {
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    }
    tabs.append(logTab, consoleTab, changesTab, shelfTab);
    tabs.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
      const items = [logTab, consoleTab, changesTab, shelfTab]; let index = items.indexOf(document.activeElement);
      if (event.key === 'Home') index = 0; else if (event.key === 'End') index = items.length - 1;
      else index = (index + (event.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length;
      event.preventDefault(); items[index].click(); items[index].focus();
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
      consoleBar.append(node('span', '', 'Git Console'), filter, node('span', 'spacer'), pause, button('Clear', 'Clear Git Console', () => post('clearConsole'), 'action'));
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
    repositories.addEventListener('change', () => { post('selectRepository', { root: repositories.value }); repositories.blur(); });
    return repositories;
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
    applySize(compact() ? Number(uiState.commitPaneHeight) || 220 : Number(uiState.commitPaneWidth) || 340);
    splitter.addEventListener('mousedown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); splitter.focus(); splitter.classList.add('dragging');
      const resize = move => { const bounds = workspace.getBoundingClientRect(); applySize(compact() ? bounds.bottom - move.clientY : bounds.right - move.clientX); };
      resize(event);
      const finish = () => {
        window.removeEventListener('mousemove', resize); window.removeEventListener('mouseup', finish); splitter.classList.remove('dragging');
        const value = Number(splitter.getAttribute('aria-valuenow'));
        saveUiState(compact() ? { commitPaneHeight: value } : { commitPaneWidth: value });
        flushDeferredState();
      };
      window.addEventListener('mousemove', resize); window.addEventListener('mouseup', finish);
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
      header.append(
        node('span', 'twisty', collapsed ? '›' : '⌄'),
        button(list.active ? '●' : '○', list.active ? 'Active Changelist' : 'Make active Changelist', event => { event.stopPropagation(); post('setActiveChangelist', { id: list.id }); }, list.active ? 'active-dot row-action' : 'row-action'),
        node('span', '', list.name),
        node('span', 'count', String(list.changes.length)),
      );
      const allSelected = list.changes.length > 0 && list.changes.every(change => change.checked);
      header.append(button(allSelected ? 'Clear' : 'Select All', allSelected ? 'Exclude this Changelist from commit' : 'Include this Changelist in commit', event => {
        event.stopPropagation(); post('toggleAll', { checked: !allSelected, listId: list.id });
      }, 'select-all'));
      const toggle = () => {
        if (collapsedLists.has(list.id)) collapsedLists.delete(list.id); else collapsedLists.add(list.id);
        collapsedByRoot[state.selectedRoot || ''] = [...collapsedLists]; saveUiState({ collapsedChangelists: collapsedByRoot }); render();
      };
      header.addEventListener('click', toggle);
      header.addEventListener('keydown', event => { if (event.target === header && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(); } });
      group.append(header);
      if (!collapsed) for (const change of list.changes) group.append(changeRow(change));
      pane.append(group);
    }
    return pane;
  }

  function changeRow(change) {
    const row = node('div', 'change-row'); row.title = change.path; row.tabIndex = 0; row.setAttribute('role', 'treeitem');
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
    row.addEventListener('keydown', event => { if (event.target === row && event.key === 'Enter') { event.preventDefault(); post('openDiff', { path: change.path }); } });
    attachContextMenu(row, [
      { icon: '↔', label: change.conflicted ? 'Open Merge Conflict Editor' : 'Show Diff', run: () => post('openDiff', { path: change.path }) },
      { icon: change.staged && !change.unstaged ? '−' : '+', label: change.staged && !change.unstaged ? 'Unstage' : 'Stage', run: () => post(change.staged && !change.unstaged ? 'unstage' : 'stage', { path: change.path }) },
      { icon: '⇥', label: 'Move to Changelist…', run: () => post('moveToChangelist', { path: change.path }) },
      { separator: true },
      { icon: '↶', label: change.kind === 'untracked' ? 'Delete…' : 'Rollback…', run: () => post('discard', { path: change.path }) },
    ]);
    return row;
  }

  function commitForm() {
    const form = node('div', 'commit-form');
    form.append(node('div', 'commit-form-title', 'Commit Changes'));
    const drafts = { ...(uiState.commitMessages || {}) }; const root = state.selectedRoot || '';
    const message = node('textarea', 'commit-message'); message.id = 'commit-message'; message.placeholder = state.totalChanges ? 'Commit Message' : 'No changes to commit'; message.value = drafts[root] || ''; message.disabled = !state.totalChanges;
    const options = node('div', 'commit-options');
    const amend = checkboxOption('Amend', 'amend', root);
    const signoff = checkboxOption('Sign-off', 'signoff', root);
    const noVerify = checkboxOption('Skip hooks', 'noVerify', root);
    options.append(amend.label, signoff.label, noVerify.label, node('span', 'spacer'), node('span', '', (state.selectedCount || 0) + ' selected'));
    const submit = push => post('commit', { message: message.value, amend: amend.input.checked, signoff: signoff.input.checked, noVerify: noVerify.input.checked, push });
    const actions = node('div', 'commit-actions');
    const commit = button('Commit', 'Commit selected changes', () => submit(false), 'primary');
    const commitPush = button('Commit & Push', 'Commit selected changes and push', () => submit(true), 'secondary');
    const updateEnabled = () => {
      const disabled = !state.totalChanges || !state.selectedCount || !message.value.trim(); commit.disabled = disabled; commitPush.disabled = disabled;
    };
    message.addEventListener('input', () => { drafts[root] = message.value; saveUiState({ commitMessages: drafts, commitMessage: undefined }); updateEnabled(); });
    updateEnabled(); actions.append(commit, commitPush);
    form.append(message, options, actions); return form;
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
      item.append(node('div', 'shelf-name', shelf.name), node('div', 'shelf-meta', new Date(shelf.createdAt).toLocaleString() + ' · ' + shelf.paths.length + ' files'));
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
    const repositories = node('select'); repositories.title = 'Git root';
    for (const repo of state.repositories || []) { const option = node('option', '', repo.name); option.value = repo.root; option.selected = repo.root === state.selectedRoot; repositories.append(option); }
    repositories.addEventListener('change', () => { post('selectRepository', { root: repositories.value }); repositories.blur(); });
    bar.append(
      repositories,
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
        flushDeferredState();
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
    filter.setAttribute('aria-label', 'Filter branches, remotes and tags by name');
    filter.addEventListener('input', () => { branchFilter = filter.value; saveUiState({ branchFilter }); refreshBranchPane(); });
    pane.append(filter);
    const needle = branchFilter.trim().toLowerCase();
    const matches = branch => !needle || branch.name.toLowerCase().includes(needle);
    const all = button('All', 'Show all branches', () => { setBranchSelection([]); post('selectRef', {}); }, 'branch-row' + (!state.selectedRef && !selectedBranchKeys.size ? ' active' : ''));
    all.dataset.branchAll = '1';
    pane.append(all);
    let shown = 0;
    for (const [kind, title] of [['local','Local'], ['remote','Remote'], ['tag','Tags']]) {
      const visible = (state.branches || []).filter(item => item.kind === kind && matches(item));
      if (!visible.length) continue;
      shown += visible.length;
      const section = node('section', 'branch-section'); section.append(node('div', 'section-title', title));
      for (const branch of visible) {
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
    const input = node('input', 'commit-search'); input.id = 'commit-search'; input.type = 'search'; input.placeholder = 'Filter loaded commits'; input.value = search;
    input.setAttribute('aria-label', 'Filter the loaded commits by text or hash');
    input.title = 'Filters the ' + String(state.logLimit || (state.commits || []).length) + ' commits currently loaded';
    input.addEventListener('input', () => { search = input.value; saveUiState({ search }); renderCommitRows(); refreshDetailsForFilter(); });
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
    const model = graphModel(filteredCommits()); const commits = model.commits; const graph = graphLayout(commits, model);
    virtualCommits = commits; virtualGraph = graph;
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
      pendingCommitHash = commits[0].hash; post('selectCommit', { hash: pendingCommitHash });
    }
    if (!commits.length) {
      pendingCommitHash = undefined;
      list.replaceChildren();
      list.append(node('div', 'empty', 'No match in the ' + String(state.logLimit || (state.commits || []).length) + ' loaded commits.'));
      if (state.hasMoreCommits) list.append(button('Load 300 more commits', 'Load older history', () => post('loadMore'), 'load-more'));
      return;
    }
    renderCommitWindow(list);
  }

  function renderCommitWindow(existing) {
    const list = existing || document.getElementById('commit-list'); if (!list || !virtualCommits.length) return;
    const scroll = list.parentElement;
    const virtual = virtualCommits.length > virtualThreshold;
    const visibleHeight = Math.max(270, scroll?.clientHeight || 600);
    const first = virtual ? Math.max(0, Math.floor(Math.max(0, (scroll?.scrollTop || 0) - commitRowHeight) / commitRowHeight) - 18) : 0;
    const last = virtual ? Math.min(virtualCommits.length, first + Math.ceil(visibleHeight / commitRowHeight) + 36) : virtualCommits.length;
    const currentHash = pendingCommitHash || state.selection?.commit?.hash;
    list.replaceChildren();
    if (first) {
      const spacer = node('div', 'virtual-spacer'); spacer.style.height = String(first * commitRowHeight) + 'px'; spacer.setAttribute('role', 'presentation'); list.append(spacer);
    }
    for (let index = first; index < last; index += 1) {
      const commit = virtualCommits[index];
      const selected = (pendingCommitHash || state.selection?.commit.hash) === commit.hash;
      const row = node('div', 'commit-row' + (selected ? ' selected' : '')); row.dataset.hash = commit.hash;
      row.dataset.index = String(index); row.setAttribute('aria-posinset', String(index + 1)); row.setAttribute('aria-setsize', String(virtualCommits.length));
      row.tabIndex = selected || (!currentHash && index === 0) ? 0 : -1; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(selected));
      row.setAttribute('aria-label', (commit.subject || 'No subject') + ', ' + commit.author + ', ' + formatDate(commit.authoredAt) + ', ' + commit.hash.slice(0, 8));
      const subject = node('div', 'subject-cell'); const canvas = node('canvas', 'graph-interactive'); canvas.width = 144; canvas.height = 54; canvas.dataset.graph = JSON.stringify(virtualGraph[index]); canvas.title = 'Click a graph line to select or collapse its series'; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Commit graph lane ' + String(virtualGraph[index].lane + 1)); attachGraphInteraction(canvas); subject.append(canvas);
      const ordered = orderedRefs(commit.refs);
      const refs = node('div', 'refs'); for (const ref of ordered.slice(0, 2)) refs.append(refChip(ref));
      if (ordered.length > 2) { const more = node('span', 'ref', '+' + String(ordered.length - 2)); more.title = ordered.slice(2).map(shortRef).join('\n'); refs.append(more); }
      subject.append(refs, node('span', 'subject', commit.subject || '(no subject)'));
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
      row.addEventListener('keydown', event => navigateCommitRows(event, row));
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
    event.preventDefault(); selectVirtualCommit(next, true);
  }

  function selectVirtualCommit(index, focus = false) {
    const commit = virtualCommits[index]; if (!commit) return;
    pendingCommitHash = commit.hash; post('selectCommit', { hash: commit.hash });
    const scroll = document.getElementById('commit-scroll');
    const top = commitRowHeight + index * commitRowHeight;
    if (scroll && (top < scroll.scrollTop + commitRowHeight || top + commitRowHeight > scroll.scrollTop + scroll.clientHeight)) {
      scroll.scrollTop = Math.max(0, top - Math.floor(scroll.clientHeight / 2));
    }
    renderCommitWindow();
    if (focus) requestAnimationFrame(() => document.querySelector('.commit-row[data-hash="' + CSS.escape(commit.hash) + '"]')?.focus({ preventScroll: true }));
  }

  function refreshDetailsForFilter() {
    const current = document.getElementById('details-pane'); if (current) current.replaceWith(detailsPane());
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

  function detailsPane() {
    const pane = node('aside', 'pane details'); pane.id = 'details-pane'; const selection = state.selection;
    const visible = new Set(filteredCommits().map(commit => commit.hash));
    if (pendingCommitHash && selection?.commit?.hash !== pendingCommitHash) { pane.append(node('div', 'empty', 'Loading commit details…')); return pane; }
    if (!selection || !visible.has(selection.commit.hash)) { pane.append(node('div', 'empty', visible.size ? 'Select a commit to view details' : 'No commit matches the current filters')); return pane; }
    const commit = selection.commit; const details = node('div', 'commit-details');
    details.id = 'commit-details';
    details.append(node('div', 'detail-subject', commit.subject || '(no subject)'));
    if ((commit.refs || []).length) {
      const refs = node('div', 'detail-refs');
      for (const ref of orderedRefs(commit.refs)) refs.append(refChip(ref));
      details.append(refs);
    }
    const meta = node('div', 'detail-meta');
    for (const [key, value] of [['Author', commit.author + ' <' + commit.email + '>'], ['Date', new Date(commit.authoredAt).toLocaleString()], ['Commit', commit.hash], ['Parents', (commit.parents || []).map(p => p.slice(0, 10)).join(', ') || '—']]) { meta.append(node('span', '', key), node('strong', '', value)); }
    details.append(meta); if (commit.body && commit.body !== commit.subject) details.append(node('div', 'detail-body', commit.body));
    const files = node('div', 'files'); files.id = 'changed-files'; files.setAttribute('role', 'tree');
    files.append(node('div', 'pane-title', 'Changed Files (' + selection.files.length + ')'));
    const tree = node('div', 'file-tree-root'); tree.append(fileTree(selection.files, commit)); files.append(tree);
    const splitter = node('div', 'detail-splitter'); splitter.tabIndex = 0; splitter.setAttribute('role', 'separator'); splitter.setAttribute('aria-orientation', 'horizontal'); splitter.title = 'Drag to resize commit message';
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
    row.append(twisty, node('span', 'tree-folder', '▱ ' + compacted.name), node('span', 'tree-count', count + (count === 1 ? ' file' : ' files')));
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
    row.append(node('span', 'file-status', file.status[0]), node('span', 'file-path', file.path.split('/').pop()));
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
    splitter.addEventListener('mousedown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); splitter.focus(); splitter.classList.add('dragging'); resize(event);
      const move = moveEvent => resize(moveEvent);
      const finish = () => {
        window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', finish);
        splitter.classList.remove('dragging');
        saveUiState({ messagePaneHeight: parseFloat(getComputedStyle(pane).getPropertyValue('--message-height')) });
        flushDeferredState();
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
    if (current) current.replaceWith(detailsPane());
  }

  window.addEventListener('message', event => {
    if (event.data.type === 'state') {
      if (blocksStateRender()) deferredState = { ...deferredState, ...event.data.state };
      else applyIncomingState(event.data.state);
    }
    if (event.data.type === 'selection') {
      state.selection = event.data.selection; pendingCommitHash = undefined;
      if (!(state.selection.files || []).some(file => file.path === selectedFilePath)) selectedFilePath = state.selection.files[0]?.path;
      updateSelectionWithoutRerender();
    }
    if (event.data.type === 'trace') { state.traces = [...(state.traces || []), event.data.trace].slice(-200); if (activeToolTab === 'console') appendConsoleTrace(event.data.trace); }
    if (event.data.type === 'consoleCleared') { state.traces = []; if (activeToolTab === 'console') render(); }
    if (event.data.type === 'activateTab' && event.data.tab !== activeToolTab) { selectToolTab(event.data.tab); }
    if (event.data.type === 'committed') {
      const drafts = { ...(uiState.commitMessages || {}) }; delete drafts[state.selectedRoot || ''];
      const options = { ...(uiState.commitOptions || {}) }; delete options[state.selectedRoot || ''];
      saveUiState({ commitMessages: drafts, commitMessage: undefined, commitOptions: options }); render();
    }
    if (event.data.type === 'error') { showErrorBanner(event.data.message); }
  });
  document.addEventListener('pointerdown', event => { if (openMenu && !openMenu.contains(event.target)) closeContextMenu(); });
  document.addEventListener('wheel', event => { if (openMenu && !openMenu.contains(event.target)) closeContextMenu(); }, { capture: true, passive: true });
  document.addEventListener('touchmove', event => { if (openMenu && !openMenu.contains(event.target)) closeContextMenu(); }, { capture: true, passive: true });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeContextMenu(true); });
  document.addEventListener('focusout', () => setTimeout(flushDeferredState, 0));
  post('ready', { activeTab: activeToolTab, logOptions: { order: sortMode, firstParent, noMerges, author: authorFilter || undefined, since: dateCutoff(dateFilter) } }); render();
`;

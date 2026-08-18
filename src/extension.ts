import * as path from "node:path";
import * as vscode from "vscode";
import { GitCommandError, GitRunner } from "./git/runner";
import { BranchNode, RepositoryTreeProvider } from "./views/repositoryTree";
import { ChangeNode, ChangesTreeProvider } from "./views/changesTree";
import { DiffContentProvider, openChangeDiff } from "./views/diffProvider";
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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const runner = new GitRunner(configurationGitPath());
  const manager = new RepositoryManager(runner, workspacePaths);
  const repositories = new RepositoryTreeProvider(manager);
  const changes = new ChangesTreeProvider(manager);
  const diffProvider = new DiffContentProvider();
  const repositoryView = vscode.window.createTreeView("jbGit.repositories", { treeDataProvider: repositories, showCollapseAll: true });
  const changesView = vscode.window.createTreeView("jbGit.changes", { treeDataProvider: changes, showCollapseAll: true });
  const branchStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
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

  const refreshForPath = async (filePath: string): Promise<void> => {
    const snapshot = manager.all.find((item) => isInside(item.repository.info.rootPath, filePath));
    if (snapshot) await manager.refresh(snapshot.repository.info.rootPath);
    updateStatusBar();
  };

  context.subscriptions.push(
    manager,
    repositories,
    changes,
    repositoryView,
    changesView,
    diffProvider,
    vscode.workspace.registerTextDocumentContentProvider("jb-git-diff", diffProvider),
    branchStatus,
    manager.onDidChange(updateStatusBar),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refresh()),
    vscode.workspace.onDidSaveTextDocument((document) => void refreshForPath(document.uri.fsPath)),
    vscode.workspace.onDidCreateFiles((event) => void Promise.all(event.files.map((uri) => refreshForPath(uri.fsPath)))),
    vscode.workspace.onDidDeleteFiles((event) => void Promise.all(event.files.map((uri) => refreshForPath(uri.fsPath)))),
    vscode.workspace.onDidRenameFiles((event) => void Promise.all(event.files.flatMap((file) => [file.oldUri, file.newUri]).map((uri) => refreshForPath(uri.fsPath)))),
    vscode.commands.registerCommand("jbGit.refresh", refresh),
    vscode.commands.registerCommand("jbGit.openChanges", () => vscode.commands.executeCommand("workbench.view.extension.jbGit")),
    vscode.commands.registerCommand("jbGit.openDiff", async (node?: ChangeNode) => {
      if (!node) return;
      await runWithNotification(`Loading diff for ${node.change.path}`, () => openChangeDiff(manager, diffProvider, node));
    }),
    vscode.commands.registerCommand("jbGit.initializeRepository", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const root = workspacePaths()[0];
      if (!root) {
        await vscode.window.showInformationMessage("Open a folder before initializing a Git repository.");
        return;
      }
      await runWithNotification("Initializing Git repository", () => manager.initializeRepository(root));
    }),
    vscode.commands.registerCommand("jbGit.fetch", async () => {
      if (!(await requireTrustedWorkspace())) return;
      await runWithNotification("Fetching Git remotes", () => manager.fetch());
    }),
    vscode.commands.registerCommand("jbGit.commit", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = manager.all[0];
      if (!first) return void vscode.window.showInformationMessage("No Git repository was found in this workspace.");
      const message = await vscode.window.showInputBox({ prompt: "Commit message", placeHolder: "Describe the staged changes" });
      if (!message?.trim()) return;
      const mode = await vscode.window.showQuickPick(
        [
          { label: "Commit", description: "Create a new commit" },
          { label: "Amend", description: "Amend the current HEAD commit" },
          { label: "Sign-off", description: "Create a signed-off commit" },
          { label: "Amend and sign-off", description: "Amend HEAD and add a sign-off trailer" },
        ],
        { placeHolder: "Choose commit mode" },
      );
      if (!mode) return;
      const amend = mode.label.includes("Amend");
      const signoff = mode.label.includes("sign-off");
      const revision = await runWithNotification("Creating Git commit", () => manager.commit(first.repository.info.rootPath, message, { amend, signoff }));
      if (revision) await vscode.window.showInformationMessage(`Created commit ${revision.slice(0, 12)}`);
    }),
    vscode.commands.registerCommand("jbGit.pull", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = manager.all[0];
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
      const first = manager.all[0];
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
    vscode.commands.registerCommand("jbGit.createBranch", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = manager.all[0];
      if (!first) return;
      const name = await vscode.window.showInputBox({ prompt: "New branch name", placeHolder: "feature/my-change" });
      if (!name?.trim()) return;
      await runWithNotification(`Creating branch ${name}`, () => manager.createBranch(first.repository.info.rootPath, name.trim()));
    }),
    vscode.commands.registerCommand("jbGit.renameBranch", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = manager.all[0];
      const current = first?.status?.branch.head;
      if (!first || !current) return void vscode.window.showInformationMessage("A local branch must be checked out to rename it.");
      const name = await vscode.window.showInputBox({ prompt: `Rename ${current} to`, value: current });
      if (!name?.trim() || name.trim() === current) return;
      await runWithNotification(`Renaming branch ${current}`, () => manager.renameBranch(first.repository.info.rootPath, current, name.trim()));
    }),
    vscode.commands.registerCommand("jbGit.deleteBranch", async (node?: BranchNode) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = manager.all[0];
      if (!first) return;
      const localBranches = first.branches.filter((branch) => branch.kind === "local" && branch.name !== first.status?.branch.head);
      const selected = node?.branch.kind === "local"
        ? node.branch.name
        : (await vscode.window.showQuickPick(localBranches.map((branch) => branch.name), { placeHolder: "Select a branch to delete" }));
      if (!selected) return;
      const answer = await vscode.window.showWarningMessage(`Delete branch ${selected}?`, { modal: true }, "Delete");
      if (answer !== "Delete") return;
      await runWithNotification(`Deleting branch ${selected}`, () => manager.deleteBranch(node?.repositoryRoot ?? first.repository.info.rootPath, selected));
    }),
    vscode.commands.registerCommand("jbGit.stash", async () => {
      if (!(await requireTrustedWorkspace())) return;
      const first = manager.all[0];
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
    vscode.commands.registerCommand("jbGit.checkoutBranch", async (node?: BranchNode) => {
      if (!(await requireTrustedWorkspace())) return;
      const first = manager.all[0];
      if (!first) return void vscode.window.showInformationMessage("No Git repository was found in this workspace.");
      const branch = node?.branch.name ?? (await vscode.window.showQuickPick(
        first.branches.filter((item) => item.kind === "local" || item.kind === "remote").map((item) => ({ label: item.name, item })),
        { placeHolder: "Select a branch to checkout" },
      ))?.item.name;
      if (!branch) return;
      await runWithNotification(`Checking out ${branch}`, () => manager.checkout(node?.repositoryRoot ?? first.repository.info.rootPath, branch));
    }),
    vscode.commands.registerCommand("jbGit.stageChange", async (node?: ChangeNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      await runWithNotification(`Staging ${node.change.path}`, () => manager.stage(node.repositoryRoot, [node.change.path]));
    }),
    vscode.commands.registerCommand("jbGit.unstageChange", async (node?: ChangeNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      await runWithNotification(`Unstaging ${node.change.path}`, () => manager.unstage(node.repositoryRoot, [node.change.path]));
    }),
    vscode.commands.registerCommand("jbGit.discardChange", async (node?: ChangeNode) => {
      if (!(await requireTrustedWorkspace()) || !node) return;
      if (node.change.kind === "untracked") {
        await vscode.window.showInformationMessage("Discarding untracked files is not enabled in this milestone.");
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

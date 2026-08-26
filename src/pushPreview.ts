import * as vscode from "vscode";
import { GitCommandError, isGitAbort } from "./git/runner";
import { RepositoryManager, RepositorySnapshot } from "./repositoryManager";

interface PushTarget {
  remote: string;
  branch: string;
  configureUpstream: boolean;
  usesExistingUpstream: boolean;
}

export interface PushRequest {
  /** Local branch to push. Defaults to the checked-out branch. */
  sourceBranch?: string;
  /** Explicit remote selected by the user. Existing upstreams win only when this is omitted. */
  remote?: string;
  /** Destination branch. Defaults to sourceBranch. */
  targetBranch?: string;
}

/** Shows the outgoing commits and exact target before any network mutation. */
export async function previewAndPush(manager: RepositoryManager, rootPath: string, request: PushRequest = {}): Promise<boolean> {
  let snapshot = manager.snapshot(rootPath);
  if (!snapshot?.status) {
    await vscode.window.showWarningMessage(vscode.l10n.t("This repository has no working branch to push."));
    return false;
  }
  const checkedOutBranch = snapshot.status.branch.head;
  const branch = request.sourceBranch ?? checkedOutBranch;
  if (!branch) {
    await vscode.window.showWarningMessage(vscode.l10n.t("Create or checkout a branch before pushing a detached HEAD."));
    return false;
  }
  const localBranch = snapshot.branches.find((candidate) => candidate.kind === "local" && candidate.name === branch);
  if (request.sourceBranch && !localBranch) {
    await vscode.window.showWarningMessage(vscode.l10n.t("Local branch '{0}' no longer exists.", branch));
    return false;
  }
  const sourceRef = localBranch?.fullName ?? `refs/heads/${branch}`;
  let target: PushTarget | undefined;
  try {
    target = await resolvePushTarget(manager, snapshot, branch, localBranch, request);
  } catch (error) {
    await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    return false;
  }
  if (!target) return false;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Refreshing {0} before push preview", target.remote), cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        const registration = token.onCancellationRequested(() => controller.abort());
        try { await manager.fetchRemote(rootPath, target.remote, controller.signal); } finally { registration.dispose(); }
      },
    );
  } catch (error) {
    if (isGitAbort(error)) return false;
    const cachedLabel = vscode.l10n.t("Continue with Cached Refs");
    const continueCached = await vscode.window.showWarningMessage(
      vscode.l10n.t("Could not refresh {0}: {1}", target.remote, error instanceof Error ? error.message : String(error)),
      cachedLabel,
    );
    if (continueCached !== cachedLabel) return false;
  }
  snapshot = manager.snapshot(rootPath) ?? snapshot;
  const remoteBranch = snapshot.branches.find((candidate) => candidate.kind === "remote" && candidate.name === `${target.remote}/${target.branch}`);
  let comparison: { left: number; right: number } | undefined;
  let outgoing;
  try {
    comparison = remoteBranch
      ? await snapshot.repository.aheadBehind(remoteBranch.fullName, sourceRef)
      : undefined;
    const limit = comparison ? Math.max(1, Math.min(comparison.right, 100)) : 20;
    outgoing = remoteBranch
      ? await snapshot.repository.logRange(remoteBranch.fullName, sourceRef, limit)
      : await snapshot.repository.logRef(sourceRef, limit);
  } catch (error) {
    await vscode.window.showErrorMessage(vscode.l10n.t("Could not build the push preview: {0}", error instanceof Error ? error.message : String(error)));
    return false;
  }
  const ahead = comparison?.right;
  const behind = comparison?.left ?? 0;
  if (ahead === 0 && !target.configureUpstream) {
    await vscode.window.showInformationMessage(behind
      ? vscode.l10n.t("{0} has no outgoing commits and is {1} commit(s) behind {2}. Update it before pushing.", branch, behind, `${target.remote}/${target.branch}`)
      : vscode.l10n.t("{0} is already up to date with {1}.", branch, `${target.remote}/${target.branch}`));
    return false;
  }
  const protectedBranch = isProtectedBranch(target.branch, vscode.workspace.getConfiguration("jbGit").get<readonly string[]>("protectedBranches", []));
  const outgoingCount = ahead ?? outgoing.length;
  const detail = [
    `${branch}  →  ${target.remote}/${target.branch}`,
    target.configureUpstream
      ? ahead === 0
        ? vscode.l10n.t("No outgoing commits; this push only configures the selected destination as upstream.")
        : vscode.l10n.t("Initial push; the selected destination will be configured as upstream.")
      : target.usesExistingUpstream
      ? vscode.l10n.t("{0} outgoing commit(s)", outgoingCount) + (behind ? ` · ${vscode.l10n.t("{0} behind", behind)}` : "")
      : vscode.l10n.t("{0} outgoing commit(s); the branch's existing upstream will not be changed.", outgoingCount),
    protectedBranch ? vscode.l10n.t("Protected branch: force push is disabled.") : "",
    "",
    ...outgoing.map((commit) => `${commit.hash.slice(0, 10)}  ${commit.subject}  — ${commit.author}`),
    ...(ahead !== undefined && ahead > outgoing.length ? [vscode.l10n.t("…and {0} more commit(s)", ahead - outgoing.length)] : []),
  ].filter((line, index, lines) => line || (index > 0 && lines[index - 1] !== "")).join("\n");
  const forceLabel = vscode.l10n.t("Force with Lease");
  const pushLabel = ahead === 0 ? vscode.l10n.t("Set Upstream") : vscode.l10n.t("Push");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t("Review push to {0}", `${target.remote}/${target.branch}`),
    { modal: true, detail },
    pushLabel,
    ...(protectedBranch || ahead === 0 ? [] : [forceLabel]),
  );
  if (choice !== pushLabel && choice !== forceLabel) return false;
  const forceWithLease = choice === forceLabel;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Pushing {0} to {1}", branch, `${target.remote}/${target.branch}`), cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        const registration = token.onCancellationRequested(() => controller.abort());
        try {
          // Always push the exact source/destination shown in the preview.
          // A plain `git push` may be redirected by push.default,
          // remote.pushDefault, branch.*.pushRemote, or remote refspecs.
          const refspec = `${sourceRef}:refs/heads/${target.branch}`;
          await manager.pushRemote(rootPath, target.remote, refspec, forceWithLease, controller.signal, target.configureUpstream);
        } finally {
          registration.dispose();
        }
      },
    );
    await vscode.window.showInformationMessage(vscode.l10n.t("Pushed {0} to {1}.", branch, `${target.remote}/${target.branch}`));
    return true;
  } catch (error) {
    if (isGitAbort(error)) return false;
    if (isRejectedPush(error)) {
      const canPull = branch === checkedOutBranch && target.usesExistingUpstream;
      if (canPull) {
        const rebaseLabel = vscode.l10n.t("Pull with Rebase");
        const recovery = await vscode.window.showWarningMessage(
          vscode.l10n.t("Push was rejected because {0} has newer commits. Update the branch and retry?", `${target.remote}/${target.branch}`),
          rebaseLabel,
          vscode.l10n.t("Pull with Merge"),
        );
        if (recovery) {
          try {
            await manager.pull(rootPath, recovery === rebaseLabel ? "rebase" : "merge");
          } catch (pullError) {
            await vscode.window.showErrorMessage(pullError instanceof Error ? pullError.message : String(pullError));
            return false;
          }
          return previewAndPush(manager, rootPath, request);
        }
      } else {
        const refreshLabel = vscode.l10n.t("Refresh Preview");
        const refresh = await vscode.window.showWarningMessage(
          vscode.l10n.t("Push was rejected because {0} changed after the preview.", `${target.remote}/${target.branch}`),
          refreshLabel,
        );
        if (refresh === refreshLabel) return previewAndPush(manager, rootPath, request);
      }
    }
    await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function resolvePushTarget(
  manager: RepositoryManager,
  snapshot: RepositorySnapshot,
  branch: string,
  localBranch: RepositorySnapshot["branches"][number] | undefined,
  request: PushRequest,
): Promise<PushTarget | undefined> {
  const remotes = await manager.remotes(snapshot.repository.info.rootPath);
  if (!remotes.length) {
    await vscode.window.showWarningMessage(vscode.l10n.t("This repository has no remote. Add one before pushing."));
    return undefined;
  }
  const upstream = localBranch?.upstream
    ?? (snapshot.status?.branch.head === branch ? snapshot.status.branch.upstream : undefined);
  const upstreamTarget = upstream ? splitUpstream(upstream, remotes.map((remote) => remote.name)) : undefined;
  if (request.remote) {
    const remote = remotes.find((candidate) => candidate.name === request.remote);
    if (!remote) {
      await vscode.window.showWarningMessage(vscode.l10n.t("Remote '{0}' no longer exists.", request.remote));
      return undefined;
    }
    const targetBranch = request.targetBranch ?? branch;
    const usesExistingUpstream = upstreamTarget?.remote === remote.name && upstreamTarget.branch === targetBranch;
    return {
      remote: remote.name,
      branch: targetBranch,
      configureUpstream: !upstreamTarget,
      usesExistingUpstream,
    };
  }
  if (upstreamTarget) return { ...upstreamTarget, configureUpstream: false, usesExistingUpstream: true };
  const picked = remotes.length === 1 ? remotes[0] : (await vscode.window.showQuickPick(
    remotes.map((remote) => ({ label: remote.name, remote })),
    { title: vscode.l10n.t("Initial push of {0}", branch), placeHolder: vscode.l10n.t("Select a remote") },
  ))?.remote;
  return picked ? { remote: picked.name, branch, configureUpstream: true, usesExistingUpstream: false } : undefined;
}

function splitUpstream(upstream: string, remoteNames: readonly string[]): Pick<PushTarget, "remote" | "branch"> | undefined {
  const remote = [...remoteNames].sort((left, right) => right.length - left.length)
    .find((candidate) => upstream.startsWith(`${candidate}/`));
  return remote ? { remote, branch: upstream.slice(remote.length + 1) } : undefined;
}

export function isProtectedBranch(branch: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const expression = pattern.trim();
    if (!expression) return false;
    const escaped = expression.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
    return new RegExp(`^${escaped}$`).test(branch);
  });
}

function isRejectedPush(error: unknown): boolean {
  if (!(error instanceof GitCommandError)) return false;
  return /non-fast-forward|fetch first|rejected|failed to push some refs/i.test(`${error.stderr}\n${error.stdout}`);
}

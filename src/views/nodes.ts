import { Changelist } from "../changelists/store";
import { GitBranch, GitChange, GitDiffHunk, GitRemote, GitStashEntry, GitSubmodule, GitWorktree } from "../git/types";
import { RepositorySnapshot } from "../repositoryManager";
import { ShelfEntry } from "../shelves/store";

/**
 * Plain data carriers passed into commands, either from the tool-window
 * webview or built inline by QuickPick flows. They intentionally carry no UI
 * concerns; the webview renders repository state itself.
 */

export type ChangeViewMode = "staged" | "unstaged";

export class RepositoryNode {
  public constructor(public readonly snapshot: RepositorySnapshot) {}
}

export class BranchNode {
  public constructor(public readonly repositoryRoot: string, public readonly branch: GitBranch) {}
}

export class ChangeNode {
  public constructor(
    public readonly repositoryRoot: string,
    public readonly change: GitChange,
    public readonly mode: ChangeViewMode = change.staged ? "staged" : "unstaged",
  ) {}
}

export class HunkNode {
  public constructor(
    public readonly repositoryRoot: string,
    public readonly pathSpec: string,
    public readonly mode: ChangeViewMode,
    public readonly index: number,
    public readonly hunk: GitDiffHunk,
  ) {}
}

export class ChangelistNode {
  public constructor(
    public readonly repositoryRoot: string,
    public readonly changelist: Changelist,
    public readonly isActive: boolean,
  ) {}
}

export class ChangelistChangeNode extends ChangeNode {
  public constructor(
    repositoryRoot: string,
    change: GitChange,
    public readonly changelistId: string,
  ) {
    super(repositoryRoot, change);
  }
}

export class ShelfNode {
  public constructor(public readonly repositoryRoot: string, public readonly entry: ShelfEntry) {}
}

export class WorktreeNode {
  public constructor(public readonly repositoryRoot: string, public readonly worktree: GitWorktree) {}
}

export class RemoteNode {
  public constructor(public readonly repositoryRoot: string, public readonly remote: GitRemote) {}
}

export class StashNode {
  public constructor(public readonly repositoryRoot: string, public readonly entry: GitStashEntry) {}
}

export class SubmoduleNode {
  public constructor(public readonly repositoryRoot: string, public readonly submodule: GitSubmodule) {}
}

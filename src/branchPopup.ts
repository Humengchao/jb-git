import type { Memento } from "vscode";

/**
 * The parts of IDEA's Branches popup that are not a Git command: which
 * branches were checked out recently, and which ones the user starred.
 */

const CHECKOUT_SUBJECT = /^checkout: moving from (.+) to (.+)$/;

/**
 * Branches checked out most recently, newest first, from the reflog subjects
 * of HEAD (newest first, as `git reflog` prints them). A checkout names two
 * branches the user was on — the one moved to, then the one left — so both
 * count, in that order. Only names that still exist as local branches are
 * kept (a detached checkout leaves a hash here, a deleted branch a stale
 * name), and the current branch is left out, since the popup already marks it.
 */
export function recentBranchesFromReflog(subjects: readonly string[], existing: ReadonlySet<string>, current?: string | null, limit = 5): string[] {
  const recent: string[] = [];
  for (const subject of subjects) {
    const match = CHECKOUT_SUBJECT.exec(subject.trim());
    if (!match) continue;
    for (const name of [match[2], match[1]]) {
      if (name === current || !existing.has(name) || recent.includes(name)) continue;
      recent.push(name);
      if (recent.length >= limit) return recent;
    }
  }
  return recent;
}

/** The persisted shape: local branch names per repository root. */
type FavoriteMap = Record<string, string[]>;

const FAVORITES_KEY = "jbGit.favoriteBranches";

/**
 * IDEA's Favorites group, remembered per workspace and repository.
 *
 * The store deliberately holds no VS Code objects beyond the Memento it was
 * given — the Branches popup and the Log's Branches pane share one instance,
 * so a star toggled in either has to reach the other, and `onChange` is how
 * the owner is told to redraw without this module importing an event emitter
 * it could not be unit-tested without.
 */
export class FavoriteBranches {
  public constructor(private readonly state: Memento, private readonly onChange?: () => void) {}

  public list(root: string): string[] {
    return [...(this.read()[root] ?? [])];
  }

  public has(root: string, branch: string): boolean {
    return (this.read()[root] ?? []).includes(branch);
  }

  public async toggle(root: string, branch: string): Promise<boolean> {
    const all = this.read();
    const current = all[root] ?? [];
    const favorite = !current.includes(branch);
    const next = favorite ? [...current, branch] : current.filter((name) => name !== branch);
    if (next.length) all[root] = next;
    else delete all[root];
    await this.state.update(FAVORITES_KEY, all);
    this.onChange?.();
    return favorite;
  }

  /** Forgets favorites that no longer name a local branch, so a deleted branch does not haunt the group. */
  public async prune(root: string, existing: ReadonlySet<string>): Promise<void> {
    const all = this.read();
    const kept = (all[root] ?? []).filter((name) => existing.has(name));
    if (kept.length === (all[root] ?? []).length) return;
    if (kept.length) all[root] = kept;
    else delete all[root];
    await this.state.update(FAVORITES_KEY, all);
    this.onChange?.();
  }

  private read(): FavoriteMap {
    const raw = this.state.get<unknown>(FAVORITES_KEY);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const result: FavoriteMap = {};
    for (const [root, names] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(names)) result[root] = names.filter((name): name is string => typeof name === "string");
    }
    return result;
  }
}

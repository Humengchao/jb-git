import * as vscode from "vscode";
import { GitChange } from "../git/types";
import { commitSelectionFor, reconcileClaims, type HunkSelection } from "./hunkOwnership";

/** Removes a list's claims on one file, and the map itself once it is empty. */
function dropClaims(list: Changelist, filePath: string): void {
  if (!list.hunks) return;
  delete list.hunks[filePath];
  if (Object.keys(list.hunks).length === 0) delete list.hunks;
}

/** Follows a file's claims to its new path after a rename. */
function renameClaims(list: Changelist, from: string, to: string): boolean {
  const keys = list.hunks?.[from];
  if (!keys) return false;
  delete list.hunks![from];
  list.hunks![to] = keys;
  return true;
}

export interface Changelist {
  id: string;
  name: string;
  description?: string;
  files: string[];
  /**
   * Hunks this list claimed out of a file that belongs to another one.
   *
   * Keyed by path, holding the hunk names `hunkKeys` produces. Absent on a list
   * that has never claimed anything, so persisted state written before partial
   * ownership existed loads unchanged.
   */
  hunks?: Record<string, string[]>;
}

interface RepositoryChangelists {
  activeId: string;
  lists: Changelist[];
}

interface PersistedChangelistState {
  version: 1;
  repositories: Record<string, RepositoryChangelists>;
}

const STORAGE_KEY = "jbGit.changelists";

export class ChangelistStore implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<string | undefined>();
  private state: PersistedChangelistState = { version: 1, repositories: {} };

  public constructor(private readonly storage: vscode.Memento) {}

  public readonly onDidChange = this.changeEmitter.event;

  public async load(): Promise<void> {
    const persisted = this.storage.get<PersistedChangelistState>(STORAGE_KEY);
    if (persisted?.version === 1 && persisted.repositories) this.state = persisted;
  }

  public lists(repositoryRoot: string): readonly Changelist[] {
    return this.ensure(repositoryRoot).lists;
  }

  public activeId(repositoryRoot: string): string {
    return this.ensure(repositoryRoot).activeId;
  }

  public files(repositoryRoot: string, listId: string): readonly string[] {
    return this.ensure(repositoryRoot).lists.find((list) => list.id === listId)?.files ?? [];
  }

  public listForFile(repositoryRoot: string, filePath: string): Changelist {
    const repository = this.ensure(repositoryRoot);
    // A file the user never assigned belongs to the active list, matching the
    // IntelliJ model where new changes join the active changelist. Existing
    // changes cannot be captured retroactively because reconcile() records
    // every live path explicitly before the active list can change.
    return repository.lists.find((list) => list.files.includes(filePath))
      ?? repository.lists.find((list) => list.id === repository.activeId)
      ?? repository.lists[0];
  }

  public async create(repositoryRoot: string, name: string, description?: string): Promise<Changelist> {
    const repository = this.ensure(repositoryRoot);
    const list = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: name.trim(),
      ...(description?.trim() ? { description: description.trim() } : {}),
      files: [],
    };
    repository.lists.push(list);
    repository.activeId = list.id;
    await this.save(repositoryRoot);
    return list;
  }

  public async rename(repositoryRoot: string, listId: string, name: string): Promise<void> {
    const list = this.ensure(repositoryRoot).lists.find((item) => item.id === listId);
    if (!list) throw new Error("Changelist not found");
    list.name = name.trim();
    await this.save(repositoryRoot);
  }

  public async update(repositoryRoot: string, listId: string, name: string, description?: string): Promise<void> {
    const list = this.ensure(repositoryRoot).lists.find((item) => item.id === listId);
    if (!list) throw new Error("Changelist not found");
    const nextName = name.trim();
    if (!nextName) throw new Error("Changelist name cannot be empty");
    list.name = nextName;
    const nextDescription = description?.trim();
    if (nextDescription) list.description = nextDescription;
    else delete list.description;
    await this.save(repositoryRoot);
  }

  public async remove(repositoryRoot: string, listId: string): Promise<void> {
    const repository = this.ensure(repositoryRoot);
    if (repository.lists.length === 1) throw new Error("The last Changelist cannot be removed");
    const index = repository.lists.findIndex((list) => list.id === listId);
    if (index < 0) throw new Error("Changelist not found");
    const [removed] = repository.lists.splice(index, 1);
    const fallback = repository.lists[0];
    fallback.files.push(...removed.files.filter((file) => !fallback.files.includes(file)));
    // A claim whose list is gone would leave those hunks belonging to nothing,
    // so the fallback inherits them the same way it inherits whole files.
    for (const [filePath, keys] of Object.entries(removed.hunks ?? {})) {
      if (fallback.files.includes(filePath)) continue;
      fallback.hunks ??= {};
      const existing = fallback.hunks[filePath] ?? [];
      fallback.hunks[filePath] = [...existing, ...keys.filter((key) => !existing.includes(key))];
    }
    if (repository.activeId === listId) repository.activeId = fallback.id;
    await this.save(repositoryRoot);
  }

  public async assign(repositoryRoot: string, filePath: string, listId: string): Promise<void> {
    const repository = this.ensure(repositoryRoot);
    const target = repository.lists.find((list) => list.id === listId);
    if (!target) throw new Error("Changelist not found");
    for (const list of repository.lists) {
      list.files = list.files.filter((file) => file !== filePath);
      // Moving the whole file is a decision about all of it, so per-hunk claims
      // on it stop meaning anything.
      if (list.hunks?.[filePath]) dropClaims(list, filePath);
    }
    target.files.push(filePath);
    await this.save(repositoryRoot);
  }

  /** The list that owns a file outright, which is where its unclaimed hunks go. */
  public homeListId(repositoryRoot: string, filePath: string): string {
    return this.listForFile(repositoryRoot, filePath).id;
  }

  /** Every list's claims on one file, including the empty ones, so a caller can partition its hunks. */
  public claims(repositoryRoot: string, filePath: string): Map<string, string[]> {
    const claims = new Map<string, string[]>();
    for (const list of this.ensure(repositoryRoot).lists) {
      const keys = list.hunks?.[filePath];
      if (keys?.length) claims.set(list.id, [...keys]);
    }
    return claims;
  }

  /**
   * Moves individual hunks of a file into a Changelist.
   *
   * Claiming a hunk for the list that already owns the whole file is how a hunk
   * comes home: the claim is removed rather than recorded, so the hunk goes
   * back to being one of the file's unclaimed ones.
   */
  public async assignHunks(repositoryRoot: string, filePath: string, keys: readonly string[], listId: string): Promise<void> {
    const repository = this.ensure(repositoryRoot);
    const target = repository.lists.find((list) => list.id === listId);
    if (!target) throw new Error("Changelist not found");
    if (keys.length === 0) return;
    const claimed = new Set(keys);
    for (const list of repository.lists) {
      const existing = list.hunks?.[filePath];
      if (!existing) continue;
      const kept = existing.filter((key) => !claimed.has(key));
      if (kept.length === existing.length) continue;
      if (kept.length === 0) dropClaims(list, filePath);
      else list.hunks![filePath] = kept;
    }
    if (target.id !== this.homeListId(repositoryRoot, filePath)) {
      target.hunks ??= {};
      const existing = target.hunks[filePath] ?? [];
      target.hunks[filePath] = [...existing, ...keys.filter((key) => !existing.includes(key))];
    }
    await this.save(repositoryRoot);
  }

  public async setActive(repositoryRoot: string, listId: string): Promise<void> {
    const repository = this.ensure(repositoryRoot);
    if (!repository.lists.some((list) => list.id === listId)) throw new Error("Changelist not found");
    repository.activeId = listId;
    await this.save(repositoryRoot);
  }

  /** Upper bound on remembered assignments per repository; stale entries are dropped beyond it. */
  private static readonly MAX_ASSIGNMENTS = 4000;

  /**
   * Migrates rename assignments and records every new change in the active
   * list. Assignments whose paths currently have no change are kept: the
   * change may only be parked in a stash or on another branch, and IntelliJ
   * restores its grouping when it reappears.
   */
  public async reconcile(repositoryRoot: string, changes: readonly GitChange[]): Promise<void> {
    const repository = this.ensure(repositoryRoot);
    let modified = false;
    for (const change of changes) {
      if (!change.originalPath) continue;
      // The new path may already be assigned (the user moved it after the rename); in that
      // case only drop the old path, or the file ends up in two lists at once.
      const alreadyAssigned = repository.lists.some((list) => list.files.includes(change.path));
      for (const list of repository.lists) {
        // Per-hunk claims are keyed by path, so they follow the rename too or
        // they would name a file that no longer exists.
        if (renameClaims(list, change.originalPath, change.path)) modified = true;
        if (!list.files.includes(change.originalPath)) continue;
        list.files = list.files.filter((file) => file !== change.originalPath);
        if (!alreadyAssigned && !list.files.includes(change.path)) list.files.push(change.path);
        modified = true;
      }
    }

    const assigned = new Set(repository.lists.flatMap((list) => list.files));
    const active = repository.lists.find((list) => list.id === repository.activeId) ?? repository.lists[0];
    for (const change of changes) {
      if (assigned.has(change.path)) continue;
      active.files.push(change.path);
      assigned.add(change.path);
      modified = true;
    }

    const livePaths = new Set(changes.map((change) => change.path));
    let total = repository.lists.reduce((count, list) => count + list.files.length, 0);
    if (total > ChangelistStore.MAX_ASSIGNMENTS) {
      // The oldest entries sit at the front of each list; only assignments
      // without a live change may be dropped.
      for (const list of repository.lists) {
        if (total <= ChangelistStore.MAX_ASSIGNMENTS) break;
        const retained: string[] = [];
        for (const file of list.files) {
          if (total > ChangelistStore.MAX_ASSIGNMENTS && !livePaths.has(file)) {
            total -= 1;
            modified = true;
            continue;
          }
          retained.push(file);
        }
        list.files = retained;
      }
    }
    if (modified) await this.save(repositoryRoot);
  }

  /**
   * What a Changelist commits: the paths it owns any part of, and for a file it
   * owns only part of, which hunks.
   *
   * A path with no split is absent from `hunkSelections`, so committing a
   * Changelist nobody split runs exactly the code path it always did.
   */
  public commitPlan(
    repositoryRoot: string,
    listId: string,
    changedPaths: readonly string[],
  ): { paths: string[]; hunkSelections: Map<string, HunkSelection> } {
    const paths: string[] = [];
    const hunkSelections = new Map<string, HunkSelection>();
    for (const filePath of changedPaths) {
      const selection = commitSelectionFor(listId, this.homeListId(repositoryRoot, filePath), this.claims(repositoryRoot, filePath));
      if (selection === "none") continue;
      paths.push(filePath);
      if (selection !== "whole") hunkSelections.set(filePath, selection);
    }
    return { paths, hunkSelections };
  }

  /** Files whose hunks are shared between Changelists, which a whole-file commit would flatten. */
  public splitPaths(repositoryRoot: string, changedPaths: readonly string[]): string[] {
    return changedPaths.filter((filePath) => this.claims(repositoryRoot, filePath).size > 0);
  }

  /** Paths that have per-hunk claims, so a caller re-reads only the files whose ownership can change. */
  public claimedPaths(repositoryRoot: string): string[] {
    const paths = new Set<string>();
    for (const list of this.ensure(repositoryRoot).lists) {
      for (const path of Object.keys(list.hunks ?? {})) paths.add(path);
    }
    return [...paths];
  }

  /**
   * Drops claims on hunks the file no longer has.
   *
   * Called with the hunk names the file currently produces. A claim survives an
   * editing session so an edit that is reverted and redone keeps its list, but
   * once the change is gone the claim has to go with it, or it would later
   * re-capture an unrelated hunk that happens to hash the same.
   */
  public async reconcileHunks(repositoryRoot: string, filePath: string, currentKeys: readonly string[]): Promise<void> {
    const repository = this.ensure(repositoryRoot);
    let modified = false;
    for (const list of repository.lists) {
      const existing = list.hunks?.[filePath];
      if (!existing) continue;
      const kept = reconcileClaims(existing, currentKeys);
      if (kept.length === existing.length) continue;
      modified = true;
      if (kept.length === 0) dropClaims(list, filePath);
      else list.hunks![filePath] = kept;
    }
    if (modified) await this.save(repositoryRoot);
  }

  private ensure(repositoryRoot: string): RepositoryChangelists {
    const existing = this.state.repositories[repositoryRoot];
    if (existing) return existing;
    const defaultList = { id: "default", name: "Default Changelist", files: [] };
    const created = { activeId: defaultList.id, lists: [defaultList] };
    this.state.repositories[repositoryRoot] = created;
    return created;
  }

  private async save(repositoryRoot: string): Promise<void> {
    await this.storage.update(STORAGE_KEY, this.state);
    this.changeEmitter.fire(repositoryRoot);
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }
}

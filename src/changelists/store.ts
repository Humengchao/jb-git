import * as vscode from "vscode";
import { GitChange } from "../git/types";

export interface Changelist {
  id: string;
  name: string;
  files: string[];
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

  public async create(repositoryRoot: string, name: string): Promise<Changelist> {
    const repository = this.ensure(repositoryRoot);
    const list = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: name.trim(), files: [] };
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

  public async remove(repositoryRoot: string, listId: string): Promise<void> {
    const repository = this.ensure(repositoryRoot);
    if (repository.lists.length === 1) throw new Error("The last Changelist cannot be removed");
    const index = repository.lists.findIndex((list) => list.id === listId);
    if (index < 0) throw new Error("Changelist not found");
    const [removed] = repository.lists.splice(index, 1);
    const fallback = repository.lists[0];
    fallback.files.push(...removed.files.filter((file) => !fallback.files.includes(file)));
    if (repository.activeId === listId) repository.activeId = fallback.id;
    await this.save(repositoryRoot);
  }

  public async assign(repositoryRoot: string, filePath: string, listId: string): Promise<void> {
    const repository = this.ensure(repositoryRoot);
    const target = repository.lists.find((list) => list.id === listId);
    if (!target) throw new Error("Changelist not found");
    for (const list of repository.lists) list.files = list.files.filter((file) => file !== filePath);
    target.files.push(filePath);
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

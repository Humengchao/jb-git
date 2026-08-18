import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { GitRepository } from "../git/repository";

export interface ShelfEntry {
  id: string;
  repositoryRoot: string;
  name: string;
  createdAt: string;
  patchFile: string;
  paths: string[];
}

function repositoryKey(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 20);
}

export class ShelfStore implements vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<string | undefined>();
  private readonly rootDirectory: string;

  public constructor(storageRoot: string) {
    this.rootDirectory = path.join(storageRoot, "shelves");
  }

  public readonly onDidChange = this.changedEmitter.event;

  public async list(repositoryRoot: string): Promise<ShelfEntry[]> {
    const directory = this.repositoryDirectory(repositoryRoot);
    try {
      const names = await readdir(directory);
      const entries: ShelfEntry[] = [];
      for (const name of names.filter((item) => item.endsWith(".json"))) {
        try {
          const content = await readFile(path.join(directory, name), "utf8");
          entries.push(JSON.parse(content) as ShelfEntry);
        } catch {
          // Ignore a partially written or manually removed shelf entry.
        }
      }
      return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  public async create(repository: GitRepository, name: string, paths: readonly string[]): Promise<ShelfEntry> {
    const patch = await repository.patch(paths);
    if (!patch.trim()) throw new Error("There are no tracked changes to shelf.");
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const directory = this.repositoryDirectory(repository.info.rootPath);
    await mkdir(directory, { recursive: true });
    const patchFile = path.join(directory, `${id}.patch`);
    const metadataFile = path.join(directory, `${id}.json`);
    const entry: ShelfEntry = {
      id,
      repositoryRoot: repository.info.rootPath,
      name: name.trim() || "Shelf",
      createdAt: new Date().toISOString(),
      patchFile,
      paths: [...paths],
    };
    await writeFile(patchFile, patch, "utf8");
    await writeFile(metadataFile, JSON.stringify(entry, null, 2), "utf8");
    // Persist first: if cleanup fails, the patch remains recoverable and the
    // working copy is never modified without a saved shelf.
    try {
      await repository.shelveTrackedPaths(paths);
    } finally {
      // The persisted recovery patch must be visible even when cleanup fails.
      this.changedEmitter.fire(repository.info.rootPath);
    }
    return entry;
  }

  public async apply(repository: GitRepository, entry: ShelfEntry): Promise<void> {
    await repository.applyPatchFile(entry.patchFile);
    this.changedEmitter.fire(repository.info.rootPath);
  }

  public async remove(repositoryRoot: string, entry: ShelfEntry): Promise<void> {
    await Promise.allSettled([
      unlink(entry.patchFile),
      unlink(path.join(this.repositoryDirectory(repositoryRoot), `${entry.id}.json`)),
    ]);
    this.changedEmitter.fire(repositoryRoot);
  }

  private repositoryDirectory(repositoryRoot: string): string {
    return path.join(this.rootDirectory, repositoryKey(repositoryRoot));
  }

  public dispose(): void {
    this.changedEmitter.dispose();
  }
}

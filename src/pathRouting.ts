import * as path from "node:path";
import { realpath } from "node:fs/promises";

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function deepestContaining<T>(items: readonly T[], candidate: string, rootOf: (item: T) => string): T | undefined {
  return items
    .filter((item) => isPathInside(rootOf(item), candidate))
    .sort((left, right) => rootOf(right).length - rootOf(left).length)[0];
}

/**
 * Canonicalizes even a path that has just been deleted by resolving the
 * closest existing ancestor and then appending the missing suffix again.
 */
export async function canonicalPath(candidate: string): Promise<string> {
  let cursor = path.resolve(candidate);
  const suffix: string[] = [];
  while (true) {
    try {
      return path.normalize(path.join(await realpath(cursor), ...suffix));
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.normalize(path.resolve(candidate));
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

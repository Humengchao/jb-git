/**
 * IDEA's Ignore action for an unversioned file, as pure text: the patterns it
 * can offer for a path, and how a chosen pattern is added to an ignore file
 * without disturbing what is already there.
 *
 * gitignore syntax is small but has teeth: a leading `/` anchors the pattern
 * to the ignore file's directory, `#`, `!`, `*`, `?`, `[` and `\` are
 * special, and a trailing space is trimmed unless escaped. Every pattern
 * offered here is built to name exactly what the user pointed at.
 */

export type IgnorePatternKind = "file" | "directory" | "extension";

export interface IgnorePattern {
  readonly kind: IgnorePatternKind;
  /** The line to append to the ignore file. */
  readonly pattern: string;
}

/**
 * Escapes one path so gitignore reads it literally. The path is relative to
 * the ignore file's directory and uses forward slashes, as Git requires.
 */
export function escapeIgnorePath(relativePath: string): string {
  let escaped = relativePath.replaceAll("\\", "/").replace(/[*?[\]\\]/g, (character) => `\\${character}`);
  // `#` and `!` are only special at the start of a line, and the anchoring
  // slash is prepended by the caller, so escape them anyway: it is harmless
  // elsewhere and correct where it matters.
  escaped = escaped.replace(/^([#!])/, "\\$1");
  return escaped.replace(/ $/, "\\ ");
}

/**
 * The patterns IDEA offers when ignoring `relativePath`: the exact file, its
 * containing directory (or the directory itself, for a directory), and every
 * file sharing its extension. Anchored with a leading `/` so `build/` does not
 * also ignore `src/build/`, except the extension pattern, which is meant to
 * apply everywhere.
 */
export function ignorePatternsFor(relativePath: string, isDirectory = false): IgnorePattern[] {
  const normalized = relativePath.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized) return [];
  const patterns: IgnorePattern[] = [];
  if (isDirectory) {
    patterns.push({ kind: "directory", pattern: `/${escapeIgnorePath(normalized)}/` });
    return patterns;
  }
  patterns.push({ kind: "file", pattern: `/${escapeIgnorePath(normalized)}` });
  const slash = normalized.lastIndexOf("/");
  if (slash > 0) {
    patterns.push({ kind: "directory", pattern: `/${escapeIgnorePath(normalized.slice(0, slash))}/` });
  }
  const name = normalized.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  // `.env` has no extension to generalise; `a.tar.gz` offers `*.gz`.
  if (dot > 0 && dot < name.length - 1) {
    patterns.push({ kind: "extension", pattern: `*${escapeIgnorePath(name.slice(dot))}` });
  }
  return patterns;
}

/**
 * Adds `line` to the contents of an ignore file. A rule that is already
 * present as a whole line is left alone, so repeating the action does not
 * grow the file, and a file lacking its final newline gets one before the new
 * rule rather than being glued to the previous one.
 */
export function appendIgnoreLine(existing: string, line: string): string {
  const rule = line.trim();
  if (!rule || /[\r\n]/.test(rule)) throw new Error("An ignore rule is a single non-empty line.");
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.split(/\r?\n/);
  if (lines.some((candidate) => candidate.trim() === rule)) return existing;
  if (existing.length === 0) return `${rule}${newline}`;
  const separator = existing.endsWith("\n") ? "" : newline;
  return `${existing}${separator}${rule}${newline}`;
}

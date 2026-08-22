import { readFileSync } from "node:fs";

/**
 * Reads a source file for pattern matching with line endings normalised.
 *
 * A Windows checkout is CRLF, so any regex written with `\n` silently stops matching there and
 * the assertion fails only in CI. Tests that are specifically about line endings read their
 * own fixtures instead of using this.
 */
export function readSource(relativePath, baseUrl) {
  return readFileSync(new URL(relativePath, baseUrl), "utf8").replace(/\r\n/g, "\n");
}

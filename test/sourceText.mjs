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

/**
 * The tool window's two halves.
 *
 * The host class and the Webview script live in different files — the script
 * is a plain `String.raw` constant with no interpolation, so it was lifted out
 * of the 4,500-line panel file. Tests ask for the half they mean instead of
 * slicing one file at the boundary, which is what they used to do and what
 * made the split a 29-file edit.
 */
export function panelHost(baseUrl) {
  return readSource("../src/webviews/logPanel.ts", baseUrl);
}

export function panelScript(baseUrl) {
  return readSource("../src/webviews/logPanelScript.ts", baseUrl);
}

export function panelStyles(baseUrl) {
  return readSource("../src/webviews/logPanelStyles.ts", baseUrl);
}

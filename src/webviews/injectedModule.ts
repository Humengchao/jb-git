import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

/**
 * Reading a compiled module's own text so it can be injected into a Webview
 * sandbox, which has no module system.
 *
 * Two build layouts have to work. Under `tsc` the caller is
 * `dist/webviews/<file>.js` and the module it wants sits one directory up; in
 * the packaged bundle the caller's code is inlined into `out/extension.js` and
 * `scripts/bundle.mjs` copies the module beside it. `require.resolve` answered
 * only the first layout, and in the second would resolve to a path outside the
 * extension entirely.
 */
function candidatePaths(moduleName: string): string[] {
  return [
    path.join(__dirname, "..", `${moduleName}.js`),
    path.join(__dirname, `${moduleName}.js`),
  ];
}

function unreadable(moduleName: string, candidates: readonly string[]): Error {
  return new Error(`Could not read the compiled ${moduleName} module (looked in ${candidates.join(", ")})`);
}

/** Wraps a module's text so its `exports` become one global for the sandbox. */
export function asSandboxGlobal(globalName: string, source: string): string {
  return `const ${globalName} = (() => { const exports = {}; ${source}\n;return exports; })();\n`;
}

export function readInjectedModuleSync(moduleName: string): string {
  const candidates = candidatePaths(moduleName);
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // Try the other layout before giving up.
    }
  }
  throw unreadable(moduleName, candidates);
}

export async function readInjectedModule(moduleName: string): Promise<string> {
  const candidates = candidatePaths(moduleName);
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      // Try the other layout before giving up.
    }
  }
  throw unreadable(moduleName, candidates);
}

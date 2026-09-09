/**
 * Builds the extension bundle that ships in the VSIX.
 *
 * `npm run compile` stays the source of truth for type checking and for the
 * per-module `dist/` tree the unit tests import. This script is only about what
 * the extension host loads at runtime: one CommonJS file instead of the forty
 * modules `require` used to resolve and read during activation.
 *
 * The modules the Webviews inject into their sandboxes are copied beside the
 * bundle rather than built again. Their text is wrapped in a closure that
 * supplies a bare `exports` object, so it has to be the `tsc` output the sandbox
 * tests parse — an esbuild CommonJS wrapper would reach for `module` and throw
 * inside the Webview. `readInjectedModule` looks for them next to the bundle.
 */
import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "out");
const INJECTED_MODULES = ["issueNavigation", "mergeRegions"];

const missing = INJECTED_MODULES
  .map((name) => join(root, "dist", `${name}.js`))
  .filter((file) => !existsSync(file));
if (missing.length) {
  console.error(`Missing ${missing.join(", ")}. Run \`npm run compile\` before bundling.`);
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [join(root, "src", "extension.ts")],
  outfile: join(outDir, "extension.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  // VS Code 1.95 runs its extension host on Node 20; 18 leaves headroom.
  target: "node18",
  // Provided by the extension host, never installable from npm.
  external: ["vscode"],
  minify: true,
  sourcemap: true,
  logLevel: "info",
});

for (const name of INJECTED_MODULES) {
  await copyFile(join(root, "dist", `${name}.js`), join(outDir, `${name}.js`));
}
console.log(`copied ${INJECTED_MODULES.join(", ")} beside the bundle`);

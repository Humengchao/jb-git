/**
 * Runs the unit suite with an explicit file list.
 *
 * `node --test test/*.test.mjs` relied on the shell to expand the glob: bash
 * does, PowerShell does not, and Node 20's test runner does not expand
 * patterns itself (Node 21 added that), so the Windows/Node 20 CI job failed
 * with "Could not find 'test\*.test.mjs'". Listing the files here works the
 * same on every shell and every supported Node. Only `*.test.mjs` files are
 * run: the extension-host suite and its launcher also live under test/ and
 * must never be picked up by the unit runner.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = readdirSync(join(root, "test"))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join("test", name));
if (files.length === 0) {
  console.error("No test/*.test.mjs files found.");
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...files, ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);

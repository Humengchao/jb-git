import { runTests } from "@vscode/test-electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDevelopmentPath = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionTestsPath = join(extensionDevelopmentPath, "test", "suite", "index.cjs");
const version = process.argv[2] || process.env.VSCODE_TEST_VERSION;

// A shell spawned by an Electron app (an editor's integrated terminal) leaks
// ELECTRON_RUN_AS_NODE=1, which would start the downloaded VS Code as a plain
// Node process that "runs" the workspace folder instead of an extension host.
delete process.env.ELECTRON_RUN_AS_NODE;

try {
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    ...(version ? { version } : {}),
    launchArgs: [extensionDevelopmentPath, "--disable-extensions"],
  });
} catch (error) {
  console.error("VS Code Extension Host tests failed:", error);
  process.exitCode = 1;
}

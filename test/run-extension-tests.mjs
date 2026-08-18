import { runTests } from "@vscode/test-electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDevelopmentPath = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionTestsPath = join(extensionDevelopmentPath, "test", "suite", "index.cjs");
const version = process.argv[2] || process.env.VSCODE_TEST_VERSION;

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

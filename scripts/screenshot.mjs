/**
 * Opens one of this extension's surfaces in a real VS Code and photographs it.
 *
 * Every automated test here reads source text, drives Git, or activates the
 * extension host — none of them render a Webview. That gap hid a sequence
 * editor whose script did not parse: the panel opened with the right title and
 * nothing in it, and the whole test suite stayed green. This is the cheapest
 * way to see that a surface actually came up.
 *
 * Manual tool, deliberately not wired into CI: reading the picture is the point.
 *
 * Needs a display and a screen grabber:
 *
 *   apt-get install -y xvfb imagemagick libgtk-3-0 libnss3 libasound2t64 libgbm1
 *
 * On macOS nothing needs installing: the window opens on the desktop and is
 * photographed with the system's screencapture (Screen Recording permission).
 *
 *   node scripts/screenshot.mjs --list
 *   node scripts/screenshot.mjs annotate --out /tmp/annotate.png
 *
 * A workspace is created and thrown away per run unless --workspace is given.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Each scenario says how to build a repository and which command to run in it. */
const SCENARIOS = {
  annotate: {
    describe: "Editor-gutter Blame on a file with three authors",
    build: buildHistory,
    body: `const document = await vscode.workspace.openTextDocument(vscode.Uri.file(root + "/app.js"));
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      await sleep(3000);
      await vscode.commands.executeCommand("jbGit.toggleBlameAnnotations");
      await sleep(3000);
      editor.selection = new vscode.Selection(1, 0, 1, 0);`,
  },
  merge: {
    describe: "The three-pane merge editor on a real conflict",
    build: buildConflict,
    body: `await sleep(2000);
      await vscode.commands.executeCommand("jbGit.resolveConflict");`,
  },
  rebase: {
    describe: "The interactive rebase sequence editor",
    build: buildHistory,
    body: `await sleep(2000);
      const from = require("node:child_process")
        .execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: root, encoding: "utf8" }).trim();
      // Not awaited: the command settles only once the editor is closed.
      void vscode.commands.executeCommand("jbGit.interactiveRebase", root, from);`,
  },
  toolwindow: {
    describe: "The bottom Git tool window",
    build: buildHistory,
    body: `await sleep(2000);
      await vscode.commands.executeCommand("jbGit.openGitToolWindow");`,
  },
  manychanges: {
    describe: "Local Changes with more files than the render cap",
    build: (root) => {
      buildHistory(root);
      mkdirSync(join(root, "generated"), { recursive: true });
      for (let index = 0; index < 1200; index += 1) {
        writeFileSync(join(root, "generated", `file-${index}.txt`), `content ${index}\n`);
      }
      git(root, "add", "generated");
      git(root, "commit", "-qm", "add generated files");
      for (let index = 0; index < 1200; index += 1) {
        writeFileSync(join(root, "generated", `file-${index}.txt`), `changed ${index}\n`);
      }
    },
    body: `await sleep(2000);
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
      await vscode.commands.executeCommand("jbGit.openChanges");`,
  },
  branches: {
    describe: "The Log's Branches pane with Recent, Favorites and the star",
    build: (root) => {
      buildHistory(root);
      git(root, "branch", "release/2026.2");
      git(root, "branch", "feature/annotate");
      git(root, "checkout", "-q", "feature/annotate");
      git(root, "checkout", "-q", "release/2026.2");
      git(root, "checkout", "-q", "-");
    },
    body: `await sleep(2000);
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
      await vscode.commands.executeCommand("jbGit.openGitToolWindow");`,
  },
  selection: {
    describe: "History for Selection: the Log narrowed to the lines selected in the editor",
    build: buildHistory,
    body: `const document = await vscode.workspace.openTextDocument(vscode.Uri.file(root + "/app.js"));
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      await sleep(2000);
      // The greeting line: touched by the first two commits, not the third.
      editor.selection = new vscode.Selection(1, 0, 1, 30);
      // Give the Log's filter bar the whole window width, so the range chip shows.
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
      await vscode.commands.executeCommand("jbGit.historyForSelection");`,
  },
  commit: {
    describe: "The commit form pre-filled from commit.template, with the Author field open",
    build: (root) => {
      buildHistory(root);
      writeFileSync(join(root, ".gitmessage"), "feat(scope): summary\n\n# Why is this change needed?\n# Any follow-ups?\n");
      git(root, "config", "commit.template", ".gitmessage");
      writeFileSync(join(root, "app.js"), `${readFileSync(join(root, "app.js"), "utf8")}\n// staged edit\n`);
      git(root, "add", "app.js");
    },
    body: `await sleep(2000);
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
      await vscode.commands.executeCommand("jbGit.openChanges");
      await sleep(1500);
      await vscode.commands.executeCommand("workbench.action.toggleMaximizedPanel");
      // The "extensions are disabled" toast would sit on the commit buttons.
      await vscode.commands.executeCommand("notifications.clearAll");`,
  },
  changes: {
    describe: "Local Changes with a staged, a modified and an untracked file",
    build: (root) => {
      buildHistory(root);
      writeFileSync(join(root, "app.js"), `${readFileSync(join(root, "app.js"), "utf8")}\n// edited\n`);
      writeFileSync(join(root, "scratch.js"), "export const scratch = 1;\n");
      writeFileSync(join(root, ".gitignore"), "node_modules\n");
      git(root, "add", ".gitignore");
    },
    body: `await sleep(2000);
      await vscode.commands.executeCommand("jbGit.openChanges");`,
  },
};

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}

function initRepository(root) {
  git(root, "init", "-q");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "user.name", "Alice Anderson");
  git(root, "config", "user.email", "alice@example.invalid");
}

function commitAs(root, name, email, message, date) {
  git(root, "config", "user.name", name);
  git(root, "config", "user.email", email);
  git(root, "add", ".");
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", message], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

function buildHistory(root) {
  initRepository(root);
  writeFileSync(join(root, "app.js"), "function greet(name) {\n  return `Hello, ${name}!`;\n}\n\nmodule.exports = { greet };\n");
  commitAs(root, "Alice Anderson", "alice@example.invalid", "Add greeting helpers", "2024-01-15T10:00:00+0800");
  writeFileSync(join(root, "app.js"), "function greet(name) {\n  return `Hello, ${name}.`;\n}\n\nmodule.exports = { greet };\n");
  commitAs(root, "Bob Brown", "bob@example.invalid", "Make the greeting calmer", "2025-06-02T14:30:00+0800");
  writeFileSync(join(root, "app.js"), "function greet(name) {\n  return `Hello, ${name}.`;\n}\n\n// Public API\nmodule.exports = { greet };\n");
  commitAs(root, "Carol Chen", "carol@example.invalid", "Document the public API", "2026-08-20T09:15:00+0800");
}

function buildConflict(root) {
  initRepository(root);
  const config = (replicas, logging) => `service: payments\nreplicas: ${replicas}\ntimeout: 30\nretries: 3\nlogging: ${logging}\n`;
  writeFileSync(join(root, "config.yml"), config(2, "info"));
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const main = git(root, "branch", "--show-current").trim();
  git(root, "checkout", "-qb", "side");
  writeFileSync(join(root, "config.yml"), config(8, "debug"));
  git(root, "add", ".");
  git(root, "commit", "-qm", "scale up and add debug logging");
  git(root, "checkout", "-q", main);
  writeFileSync(join(root, "config.yml"), config(4, "warn"));
  git(root, "add", ".");
  git(root, "commit", "-qm", "modest scale up, quieter logs");
  try {
    git(root, "merge", "side");
  } catch {
    // The conflict is the point.
  }
}

function parseArguments(argv) {
  const options = { scenario: undefined, out: undefined, workspace: undefined, display: ":77", list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--list") options.list = true;
    else if (argument === "--out") options.out = argv[++index];
    else if (argument === "--workspace") options.workspace = argv[++index];
    else if (argument === "--display") options.display = argv[++index];
    else if (!options.scenario) options.scenario = argument;
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.list || !options.scenario) {
  console.log("Scenarios:");
  for (const [name, scenario] of Object.entries(SCENARIOS)) console.log(`  ${name.padEnd(12)} ${scenario.describe}`);
  process.exit(options.list ? 0 : 1);
}
const scenario = SCENARIOS[options.scenario];
if (!scenario) {
  console.error(`Unknown scenario '${options.scenario}'. Run with --list.`);
  process.exit(1);
}

const workspace = options.workspace ?? mkdtempSync(join(tmpdir(), "jb-git-shot-"));
if (!options.workspace) scenario.build(workspace);
const output = options.out ?? join(tmpdir(), `jb-git-${options.scenario}.png`);

// The suite holds the surface on screen; the grab happens from outside, because
// nothing inside the extension host can photograph the window it lives in.
const harness = mkdtempSync(join(tmpdir(), "jb-git-harness-"));
mkdirSync(harness, { recursive: true });
writeFileSync(join(harness, "suite.cjs"), `const { setTimeout: sleep } = require("node:timers/promises");
const vscode = require("vscode");
async function run() {
  const extension = vscode.extensions.getExtension("hmc.jb-git");
  if (!extension) throw new Error("the development extension was not found");
  await extension.activate();
  const root = ${JSON.stringify(workspace)};
  ${scenario.body}
  await sleep(4000);
  console.log("JB-SHOT-READY");
  await sleep(30000);
}
module.exports = { run };
`);
writeFileSync(join(harness, "run.mjs"), `import { runTests } from ${JSON.stringify(join(projectRoot, "node_modules/@vscode/test-electron/out/index.js"))};
delete process.env.ELECTRON_RUN_AS_NODE;
await runTests({
  extensionDevelopmentPath: ${JSON.stringify(projectRoot)},
  extensionTestsPath: ${JSON.stringify(join(harness, "suite.cjs"))},
  launchArgs: [${JSON.stringify(workspace)}, "--disable-extensions", "--disable-gpu"],
  // Pinned: the default is cwd-relative, and run from inside a demo repository
  // it writes thousands of user-data files into the workspace being shown.
  cachePath: ${JSON.stringify(join(projectRoot, ".vscode-test"))},
});
`);

// macOS has a display and its own grabber, so nothing needs to be installed
// there; the window opens on the desktop and is photographed with screencapture.
const isMac = process.platform === "darwin";
const display = options.display;
const xvfb = isMac ? undefined : spawn("Xvfb", [display, "-screen", "0", "1600x1000x24", "-nolisten", "tcp"], { stdio: "ignore" });
xvfb?.on("error", () => {
  console.error("Xvfb is not installed. See the header of this file.");
  process.exit(1);
});

const log = [];
const host = spawn(process.execPath, [join(harness, "run.mjs")], { env: isMac ? process.env : { ...process.env, DISPLAY: display } });
host.stdout.on("data", (chunk) => log.push(String(chunk)));
host.stderr.on("data", (chunk) => log.push(String(chunk)));

const deadline = Date.now() + 180_000;
const ready = async () => {
  while (Date.now() < deadline) {
    if (log.join("").includes("JB-SHOT-READY")) return true;
    if (host.exitCode !== null) return false;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
};

const shown = await ready();
if (!shown) {
  console.error("The surface never reported itself ready:\n" + log.join("").slice(-2000));
  host.kill();
  xvfb?.kill();
  process.exit(1);
}
await new Promise((resolve) => setTimeout(resolve, 2000));
try {
  if (isMac) execFileSync("screencapture", ["-x", output]);
  else execFileSync("import", ["-window", "root", output], { env: { ...process.env, DISPLAY: display } });
  console.log(`Wrote ${output}${existsSync(output) ? ` (${readFileSync(output).length} bytes)` : ""}`);
  console.log("Workspace:", workspace);
} catch {
  console.error(isMac ? "screencapture failed; grant Screen Recording permission to the terminal." : "ImageMagick's `import` is not installed. See the header of this file.");
  process.exitCode = 1;
} finally {
  host.kill();
  xvfb?.kill();
}

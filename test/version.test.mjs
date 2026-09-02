import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readSource } from "./sourceText.mjs";

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

function readText(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("keeps installable release metadata aligned", () => {
  const manifest = readJson("../package.json");
  const lockfile = readJson("../package-lock.json");
  const version = manifest.version;
  const escapedVersion = escapeRegExp(version);

  assert.equal(lockfile.version, version);
  assert.equal(lockfile.packages[""].version, version);
  assert.match(readText("../CHANGELOG.md"), new RegExp(`^## ${escapedVersion}$`, "m"));
  assert.match(readText("../README.zh-CN.md"), new RegExp(`jb-git-${escapedVersion}\\.vsix`));
});

test("raises every file that has to name the same version", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const workspace = mkdtempSync(join(tmpdir(), "jb-git-bump-"));
  // Copy only what the script touches, plus git metadata for the changelog range.
  for (const name of ["package.json", "package-lock.json", "CHANGELOG.md", "README.md", "README.zh-CN.md"]) {
    cpSync(join(root, name), join(workspace, name));
  }
  mkdirSync(join(workspace, "scripts"));
  cpSync(join(root, "scripts", "bump-version.mjs"), join(workspace, "scripts", "bump-version.mjs"));

  const before = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")).version;
  const [major, minor, patch] = before.split(".").map(Number);
  const run = (release) => execFileSync("node", ["scripts/bump-version.mjs", release], { cwd: workspace, encoding: "utf8" }).trim();

  assert.equal(run("patch"), `${major}.${minor}.${patch + 1}`);
  const bumped = `${major}.${minor}.${patch + 1}`;
  const manifest = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"));
  const lockfile = JSON.parse(readFileSync(join(workspace, "package-lock.json"), "utf8"));
  assert.equal(manifest.version, bumped);
  assert.equal(lockfile.version, bumped);
  assert.equal(lockfile.packages[""].version, bumped);
  assert.match(readFileSync(join(workspace, "CHANGELOG.md"), "utf8"), new RegExp(`^## ${bumped.replace(/\./g, "\\.")}\r?$`, "m"));
  assert.match(readFileSync(join(workspace, "README.zh-CN.md"), "utf8"), new RegExp(`jb-git-${bumped.replace(/\./g, "\\.")}\\.vsix`));

  // Only the version line may move in the manifest; re-serializing it would reformat the file.
  const originalLines = readFileSync(join(root, "package.json"), "utf8").split(/\r?\n/);
  const bumpedLines = readFileSync(join(workspace, "package.json"), "utf8").split(/\r?\n/);
  assert.equal(originalLines.length, bumpedLines.length);
  const differing = originalLines.filter((line, index) => line !== bumpedLines[index]);
  assert.deepEqual(differing, [`  "version": "${before}",`]);

  assert.equal(run("minor"), `${major}.${minor + 1}.0`);
  assert.equal(run("major"), `${major + 1}.0.0`);
  assert.throws(() => run("nonsense"), /Unknown release type/);
});

test("bumps a CRLF checkout, which is what Windows gets from git", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const workspace = mkdtempSync(join(tmpdir(), "jb-git-bump-crlf-"));
  const toCrlf = (text) => text.replace(/\r?\n/g, "\r\n");
  for (const name of ["package.json", "package-lock.json", "CHANGELOG.md", "README.md", "README.zh-CN.md"]) {
    writeFileSync(join(workspace, name), toCrlf(readFileSync(join(root, name), "utf8")));
  }
  mkdirSync(join(workspace, "scripts"));
  cpSync(join(root, "scripts", "bump-version.mjs"), join(workspace, "scripts", "bump-version.mjs"));

  const before = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")).version;
  const [major, minor, patch] = before.split(".").map(Number);
  const bumped = `${major}.${minor}.${patch + 1}`;
  const printed = execFileSync("node", ["scripts/bump-version.mjs", "patch"], { cwd: workspace, encoding: "utf8" }).trim();
  assert.equal(printed, bumped);

  const changelog = readFileSync(join(workspace, "CHANGELOG.md"), "utf8");
  // The entry must actually appear; an LF-only anchor matched nothing here and left the file
  // untouched while still reporting success.
  assert.match(changelog, new RegExp(`^## ${bumped.replace(/\./g, "\\.")}\r$`, "m"));
  assert.doesNotMatch(changelog, /[^\r]\n/, "the file's CRLF endings must be preserved");
  assert.equal(JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")).version, bumped);
  assert.match(readFileSync(join(workspace, "README.zh-CN.md"), "utf8"), new RegExp(`jb-git-${bumped.replace(/\./g, "\\.")}\\.vsix`));
});

test("does not partially bump files when a later release precondition fails", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const workspace = mkdtempSync(join(tmpdir(), "jb-git-bump-atomic-"));
  for (const name of ["package.json", "package-lock.json", "CHANGELOG.md", "README.md", "README.zh-CN.md"]) {
    cpSync(join(root, name), join(workspace, name));
  }
  mkdirSync(join(workspace, "scripts"));
  cpSync(join(root, "scripts", "bump-version.mjs"), join(workspace, "scripts", "bump-version.mjs"));
  const before = Object.fromEntries(["package.json", "package-lock.json", "CHANGELOG.md", "README.md", "README.zh-CN.md"]
    .map((name) => [name, readFileSync(join(workspace, name), "utf8")]));
  writeFileSync(join(workspace, "CHANGELOG.md"), "not a changelog\n");
  assert.throws(() => execFileSync("node", ["scripts/bump-version.mjs", "patch"], { cwd: workspace, encoding: "utf8" }), /CHANGELOG/);
  for (const name of ["package.json", "package-lock.json", "README.md", "README.zh-CN.md"]) {
    assert.equal(readFileSync(join(workspace, name), "utf8"), before[name], `${name} must remain unchanged on failure`);
  }
});

test("ships a marketplace icon the manifest can actually use", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const manifest = readJson("../package.json");
  assert.equal(manifest.icon, "assets/icon.png");
  // The manifest cannot reference an SVG icon, so the shipped asset has to be a raster image.
  assert.doesNotMatch(manifest.icon, /\.svg$/i);

  const png = readFileSync(join(root, manifest.icon));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "must be a real PNG");
  // IHDR is the first chunk: width and height are big-endian 32-bit at offsets 16 and 20.
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.equal(width, height, "the icon must be square");
  assert.ok(width >= 128, `the icon must be at least 128px, got ${width}`);
});

test("offers a status bar entry that reopens the tool window", () => {
  const source = readSource("../src/extension.ts", import.meta.url);
  const item = source.match(/const toolWindowStatus = [\s\S]*?toolWindowStatus\.command = "[^"]+";/);
  assert.ok(item, "the status bar entry should exist");
  assert.match(item[0], /vscode\.StatusBarAlignment\.Left/);
  assert.match(item[0], /toolWindowStatus\.command = "jbGit\.openGitToolWindow";/);
  // Built-in codicons only: a custom icon reference would need a contributed icon font.
  assert.match(item[0], /toolWindowStatus\.text = "\$\(source-control\) JB Git";/);
  // Closing the panel must not strand the user, so the entry does not depend on a repository.
  assert.match(source, /if \(\(vscode\.workspace\.workspaceFolders \?\? \[\]\)\.length\) toolWindowStatus\.show\(\);/);
  const declared = readJson("../package.json").contributes.commands.map((entry) => entry.command);
  assert.ok(declared.includes("jbGit.openGitToolWindow"));
});

test("keeps the Node type surface within the oldest supported extension runtime", () => {
  const manifest = readJson("../package.json");
  const nodeTypes = manifest.devDependencies["@types/node"];
  assert.match(nodeTypes, /(?:\^|~)?20\./, "VS Code 1.95 ships a Node 20 extension host");
});

test("the unit runner lists its files itself instead of trusting the shell to expand a glob", () => {
  // PowerShell does not expand `test/*.test.mjs`, and Node 20's test runner
  // does not either, which is how the Windows/Node 20 CI job failed while
  // every bash-based job passed.
  const manifest = JSON.parse(readText("../package.json"));
  assert.equal(manifest.scripts["test:unit"], "npm run compile && node scripts/run-unit-tests.mjs");
  assert.doesNotMatch(JSON.stringify(manifest.scripts), /--test test\/\*/);
  const runner = readText("../scripts/run-unit-tests.mjs");
  assert.match(runner, /name\.endsWith\("\.test\.mjs"\)/, "only unit test files run; the extension-host suite lives beside them");
  assert.match(runner, /spawnSync\(process\.execPath, \["--test", \.\.\.files/);
  assert.match(runner, /process\.exit\(result\.status \?\? 1\)/);
});

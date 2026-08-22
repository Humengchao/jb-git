import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  assert.match(readFileSync(join(workspace, "CHANGELOG.md"), "utf8"), new RegExp(`^## ${bumped.replace(/\./g, "\\.")}$`, "m"));
  assert.match(readFileSync(join(workspace, "README.zh-CN.md"), "utf8"), new RegExp(`jb-git-${bumped.replace(/\./g, "\\.")}\\.vsix`));

  // Only the version line may move in the manifest; re-serializing it would reformat the file.
  const originalLines = readFileSync(join(root, "package.json"), "utf8").split("\n");
  const bumpedLines = readFileSync(join(workspace, "package.json"), "utf8").split("\n");
  assert.equal(originalLines.length, bumpedLines.length);
  const differing = originalLines.filter((line, index) => line !== bumpedLines[index]);
  assert.deepEqual(differing, [`  "version": "${before}",`]);

  assert.equal(run("minor"), `${major}.${minor + 1}.0`);
  assert.equal(run("major"), `${major + 1}.0.0`);
  assert.throws(() => run("nonsense"), /Unknown release type/);
});

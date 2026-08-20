import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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

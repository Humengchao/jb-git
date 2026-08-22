#!/usr/bin/env node
// Raises the extension version and every file that has to agree with it.
//
// The Marketplace refuses a version it already holds, so an automated release has to bump
// before publishing. `test/version.test.mjs` asserts that the manifest, the lockfile, the
// changelog and the installation docs all name the same version, so all four move together.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const release = process.argv[2] ?? "patch";
if (!["patch", "minor", "major"].includes(release)) {
  console.error(`Unknown release type '${release}'. Use patch, minor or major.`);
  process.exit(1);
}

const read = (name) => readFileSync(join(root, name), "utf8");
const write = (name, content) => writeFileSync(join(root, name), content);

const manifest = JSON.parse(read("package.json"));
const current = manifest.version;
const parts = current.split(".").map(Number);
if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
  console.error(`Cannot bump the non-semver version '${current}'.`);
  process.exit(1);
}
const [major, minor, patch] = parts;
const next = release === "major" ? `${major + 1}.0.0` : release === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Commit subjects since the last release tag, so the changelog entry says what shipped. */
function changesSinceLastRelease() {
  const lastTag = git("describe", "--tags", "--abbrev=0", "--match", "v*");
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const subjects = git("log", range, "--no-merges", "--pretty=format:%s")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^chore: release /.test(line));
  const unique = [...new Set(subjects)];
  if (!unique.length) return ["Maintenance update with no recorded commit subjects."];
  // Before the first tag exists the range is the whole history, which would paste every
  // commit ever made into one entry.
  const limit = 20;
  return unique.length > limit
    ? [...unique.slice(0, limit), `…and ${unique.length - limit} earlier commits.`]
    : unique;
}

/**
 * Replaces a JSON string value in place. Re-serializing the file would reformat unrelated
 * parts of it, since the manifest keeps many objects on a single line.
 */
function replaceJsonVersion(name, expected, replacement, occurrences) {
  const content = read(name);
  const needle = `"version": "${expected}"`;
  let remaining = occurrences;
  const updated = content.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), (match) => (
    remaining-- > 0 ? `"version": "${replacement}"` : match
  ));
  if (remaining > 0) {
    console.error(`Expected ${occurrences} occurrence(s) of ${needle} in ${name}.`);
    process.exit(1);
  }
  write(name, updated);
}

// package.json, then package-lock.json (root version plus the root package entry).
replaceJsonVersion("package.json", current, next, 1);
replaceJsonVersion("package-lock.json", current, next, 2);

// Parse both back to prove the edit produced valid, consistent JSON.
const bumped = JSON.parse(read("package.json"));
const lockfile = JSON.parse(read("package-lock.json"));
if (bumped.version !== next || lockfile.version !== next || lockfile.packages?.[""]?.version !== next) {
  console.error("Version replacement did not land in every expected place.");
  process.exit(1);
}

// CHANGELOG.md: a new section directly under the title. The anchor and the inserted text
// have to follow the file's own line endings, or a CRLF checkout silently gains no entry.
const changelog = read("CHANGELOG.md");
const newline = changelog.includes("\r\n") ? "\r\n" : "\n";
const heading = /^# Changelog(\r?\n)+/;
if (!heading.test(changelog)) {
  console.error("CHANGELOG.md no longer starts with a '# Changelog' heading; refusing to guess where the entry goes.");
  process.exit(1);
}
const bullets = changesSinceLastRelease().map((line) => `- ${line}`).join(newline);
const entry = `## ${next}${newline}${newline}${bullets}${newline}${newline}`;
const withEntry = changelog.replace(heading, `# Changelog${newline}${newline}${entry}`);
if (withEntry === changelog) {
  console.error("Failed to insert the changelog entry.");
  process.exit(1);
}
write("CHANGELOG.md", withEntry);

// Installation docs reference the packaged file by name.
const docs = ["README.zh-CN.md", "README.md"];
for (const name of docs) {
  let content;
  try { content = read(name); } catch { continue; }
  const updated = content.replaceAll(`jb-git-${current}.vsix`, `jb-git-${next}.vsix`);
  if (updated !== content) write(name, updated);
}

console.log(next);
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `version=${next}\n`, { flag: "a" });
}

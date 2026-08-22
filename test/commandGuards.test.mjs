import assert from "node:assert/strict";
import test from "node:test";
import { readSource } from "./sourceText.mjs";

const extension = readSource("../src/extension.ts", import.meta.url);

test("aborts clone when no destination folder was chosen", () => {
  // `?? process.cwd()` sent the clone into the extension host's cwd (typically /) when the
  // user pressed Escape in the folder picker.
  assert.doesNotMatch(extension, /pickWorkspaceRoot\(\) \?\? process\.cwd\(\)/);
  const clone = extension.slice(extension.indexOf('"jbGit.cloneRepository"'));
  assert.match(clone.slice(0, 1200), /if \(!cloneRoot\) return void vscode\.window\.showInformationMessage/);
});

test("confirms restricting the working tree and validates the sparse paths", () => {
  const sparse = extension.slice(extension.indexOf('"jbGit.sparseCheckoutSet"'), extension.indexOf('"jbGit.sparseCheckoutDisable"'));
  // Setting the cone deletes every file outside it; the destructive direction was the one
  // without a confirmation.
  assert.match(sparse, /showWarningMessage\(\s*`Restrict the working tree/);
  assert.match(sparse, /modal: true/);
  assert.match(sparse, /validateInput/);
});

test("rejects resolving a file that has no conflict instead of opening another one", () => {
  const resolve = extension.slice(extension.indexOf('"jbGit.resolveConflict"'));
  assert.match(resolve.slice(0, 700), /has no merge conflict to resolve/);
});

test("keeps the tool window's repository for every forwarded command", () => {
  for (const command of ["commit", "bisectGood", "bisectBad", "bisectSkip", "bisectReset", "createChangelist", "deleteTag"]) {
    assert.match(
      extension,
      new RegExp(`registerCommand\\("jbGit\\.${command}", async \\(rootPath\\?: string\\)`),
      `${command} should accept a repository root`,
    );
  }
});

test("acts on stashes by commit id and reports conflicts as conflicts", () => {
  // Positional stash refs shift on every push/pop/drop; the confirmation modal was letting
  // the user confirm an index, not a stash.
  assert.match(extension, /applyStash\(node\.repositoryRoot, node\.entry\.ref, pop, node\.entry\.oid\)/);
  assert.match(extension, /dropStash\(node\.repositoryRoot, node\.entry\.ref, node\.entry\.oid\)/);
  assert.match(extension, /Drop the stash '\$\{node\.entry\.message \|\| node\.entry\.ref\}'/);
  assert.match(extension, /The stash was applied with conflicts\./);
  const repositorySource = readSource("../src/git/repository.ts", import.meta.url);
  assert.match(repositorySource, /private async resolveStashRef/);
});

test("continues fetching the remaining repositories when one remote fails", () => {
  const manager = readSource("../src/repositoryManager.ts", import.meta.url);
  const fetch = manager.slice(manager.indexOf("public async fetch("));
  assert.match(fetch.slice(0, 1200), /isGitAbort\(error\)/);
  assert.match(fetch.slice(0, 1200), /Fetch failed for \$\{failures\.length\} of \$\{targets\.length\}/);
  // A disposed manager must not keep scanning or setting context keys.
  assert.match(manager, /const guarded = async \(\): Promise<void> => \{\s*if \(this\.disposed\) return;/);
});

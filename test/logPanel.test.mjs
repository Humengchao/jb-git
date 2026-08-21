import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/webviews/logPanel.ts", import.meta.url), "utf8");
const scriptMatch = source.match(/const logScript = String\.raw`([\s\S]*?)`;\r?\n$/);

function graphHarness(collapsed = []) {
  assert.ok(scriptMatch);
  const graphSource = scriptMatch[1].match(/(const graphEdgeKey = [\s\S]*?)(?=\r?\n  const shortRef)/);
  assert.ok(graphSource);
  return new Function("collapsedGraphSeries", "colors", `${graphSource[1]}; return { graphModel, graphLayout };`)(new Set(collapsed), ["blue", "red", "green"]);
}

test("keeps the embedded Git tool-window script syntactically valid", () => {
  assert.ok(scriptMatch, "embedded webview script should be present");
  assert.doesNotThrow(() => new Function(scriptMatch[1]));
});

test("wires context menus for branches, commits, local changes, and changed files", () => {
  assert.ok(scriptMatch);
  assert.equal(scriptMatch[1].match(/attachContextMenu\(row,/g)?.length, 4);
  assert.match(scriptMatch[1], /event\.key === 'F10'/);
  assert.match(scriptMatch[1], /event\.key !== 'ContextMenu'/);
});

test("keeps context menus and filter popovers open across background state renders", () => {
  assert.ok(scriptMatch);
  const renderSource = scriptMatch[1].match(/function render\(\) \{([\s\S]*?)\r?\n  }\r?\n\r?\n  function repositorySelect/);
  assert.ok(renderSource);
  assert.doesNotMatch(renderSource[1], /closeContextMenu/);
  assert.doesNotMatch(scriptMatch[1], /addEventListener\('scroll'.*closeContextMenu/);
  assert.match(scriptMatch[1], /addEventListener\('wheel'/);
  assert.match(scriptMatch[1], /deferredState/);
  assert.match(scriptMatch[1], /blocksStateRender/);
});

test("does not render the removed five-button commit detail action strip", () => {
  assert.ok(scriptMatch);
  assert.doesNotMatch(scriptMatch[1], /detail-actions/);
  assert.doesNotMatch(scriptMatch[1], /actions\.append\(button\('Show Diff'.*button\('Reset…'/);
});

test("uses one commit scroll area and a mouse-and-keyboard resizable details pane", () => {
  assert.ok(scriptMatch);
  assert.match(scriptMatch[1], /scroll\.append\(head, list\)/);
  assert.match(scriptMatch[1], /splitter\.addEventListener\('mousedown'/);
  assert.match(scriptMatch[1], /event\.key !== 'ArrowUp'/);
  assert.match(scriptMatch[1], /aria-valuenow/);
});

test("supports persistent horizontal resizing for all three Git log columns", () => {
  assert.ok(scriptMatch);
  assert.match(scriptMatch[1], /columnSplitter\('branch'\)/);
  assert.match(scriptMatch[1], /columnSplitter\('details'\)/);
  assert.match(scriptMatch[1], /branchPaneWidth/);
  assert.match(scriptMatch[1], /detailsPaneWidth/);
  assert.match(scriptMatch[1], /event\.key !== 'ArrowLeft'/);
  assert.match(scriptMatch[1], /aria-valuemax/);
});

test("collapses secondary panes instead of overflowing a narrow panel", () => {
  assert.ok(scriptMatch);
  assert.match(scriptMatch[1], /workspace\.classList\.toggle\('compact', compact\)/);
  assert.match(source, /\.workspace\.compact > \.branches/);
  assert.match(source, /\.workspace\.tiny/);
});

test("supports modifier-click branch selection and multi-branch actions", () => {
  assert.ok(scriptMatch);
  assert.match(scriptMatch[1], /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(scriptMatch[1], /selectedBranchKeys/);
  assert.match(scriptMatch[1], /Compare Branches/);
  assert.match(scriptMatch[1], /Show Files Diff/);
  assert.match(scriptMatch[1], /deleteBranches/);
});

test("provides real branch, user, date, path, and ordering filters", () => {
  assert.ok(scriptMatch);
  assert.match(scriptMatch[1], /Filter loaded commits/);
  assert.match(scriptMatch[1], /branchFilterItems/);
  assert.match(scriptMatch[1], /userFilterItems/);
  assert.match(scriptMatch[1], /dateFilterItems/);
  assert.match(scriptMatch[1], /setPathFilter/);
  assert.match(scriptMatch[1], /sortMode/);
  assert.match(scriptMatch[1], /By Commit Date/);
  assert.match(scriptMatch[1], /Topologically/);
  assert.match(scriptMatch[1], /First Parent/);
  assert.match(scriptMatch[1], /No Merges/);
  assert.match(scriptMatch[1], /setLogOptions/);
  assert.match(scriptMatch[1], /author: authorFilter/);
  assert.match(scriptMatch[1], /since: dateCutoff/);
});

test("keeps filtered selection, details, and progressively loaded history consistent", () => {
  assert.ok(scriptMatch);
  assert.match(source, /type: "loadMore"/);
  assert.match(source, /logLimit = Math\.min\(5_000/);
  assert.match(scriptMatch[1], /refreshDetailsForFilter/);
  assert.match(scriptMatch[1], /Loading commit details/);
  assert.match(scriptMatch[1], /Load 300 more commits/);
});

test("virtualizes large commit lists and stops offering history past the hard cap", () => {
  assert.ok(scriptMatch);
  assert.match(scriptMatch[1], /virtualThreshold = 500/);
  assert.match(scriptMatch[1], /renderCommitWindow/);
  assert.match(source, /this\.logLimit < 5_000 && commits\.length >= this\.logLimit/);
});

test("provides safe local-change commits and repository-scoped drafts", () => {
  assert.ok(scriptMatch);
  assert.match(source, /listId\?: string/);
  assert.match(scriptMatch[1], /listId: list\.id/);
  assert.match(scriptMatch[1], /commitMessages/);
  assert.match(scriptMatch[1], /commit\.disabled = disabled/);
  assert.match(scriptMatch[1], /collapsedChangelists/);
  assert.match(scriptMatch[1], /setupChangesSplitter/);
});

test("supports keyboard navigation and a filtered incremental Git console", () => {
  assert.ok(scriptMatch);
  assert.match(scriptMatch[1], /navigateCommitRows/);
  assert.match(scriptMatch[1], /setupRovingRows/);
  assert.match(scriptMatch[1], /setupTreeKeyboard/);
  assert.match(scriptMatch[1], /consoleTraceVisible/);
  assert.match(scriptMatch[1], /appendConsoleTrace/);
  assert.match(scriptMatch[1], /Background refresh commands are hidden/);
});

test("collapses, expands, and directly interacts with real graph series", () => {
  assert.ok(scriptMatch);
  assert.match(scriptMatch[1], /Collapse Linear Branches/);
  assert.match(scriptMatch[1], /Expand Linear Branches/);
  assert.match(scriptMatch[1], /collapsedGraphSeries/);
  assert.match(scriptMatch[1], /attachGraphInteraction/);
  assert.match(scriptMatch[1], /pointToSegmentDistance/);
  assert.match(scriptMatch[1], /dottedEdges/);
});

test("keeps merge lanes bounded and replaces collapsed linear history with a dotted edge", () => {
  const commit = (hash, parents, refs = []) => ({ hash, parents, refs });
  const mergeCommits = [commit("a", ["b", "c"], ["HEAD -> main"]), commit("b", ["d"]), commit("c", ["d"], ["feature"]), commit("d", [])];
  const expanded = graphHarness();
  const mergeModel = expanded.graphModel(mergeCommits);
  const mergeLayout = expanded.graphLayout(mergeModel.commits, mergeModel);
  assert.ok(mergeLayout.every(row => Math.max(row.incoming.length, row.outgoing.length) <= 2));

  const linearCommits = [commit("a", ["b"], ["HEAD -> main"]), commit("b", ["c"]), commit("c", ["d"]), commit("d", ["e"]), commit("e", [])];
  const linearModel = expanded.graphModel(linearCommits);
  const [series] = linearModel.fragments.keys();
  assert.ok(series);
  const collapsed = graphHarness([series]).graphModel(linearCommits);
  assert.deepEqual(collapsed.commits.map(item => item.hash), ["a", "e"]);
  assert.equal(collapsed.dottedEdges.has("a>e"), true);
  assert.deepEqual(collapsed.parents.get("a"), ["e"]);
});

test("opens generated diffs read-only instead of dirty untitled editors", () => {
  // An untitled document opens dirty, so closing a patch the user only wanted to read
  // pops VS Code's unsaved-changes prompt.
  assert.doesNotMatch(source, /openTextDocument\(\{\s*content/);
  assert.doesNotMatch(source, /showDiffText/);
  assert.match(source, /private async showReadOnlyDiff\(root: string, name: string, content: string\)/);
  // The virtual scheme must be a readonly file system; a TextDocumentContentProvider still
  // lets the editor accept typing.
  const extensionSource = readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");
  assert.doesNotMatch(extensionSource, /registerTextDocumentContentProvider/);
  assert.match(extensionSource, /registerFileSystemProvider\(DiffContentProvider\.scheme, diffProvider, \{\s*isCaseSensitive: true,\s*isReadonly: true,/);
  // Anchor on each handler, not the message-type union, so the assertion covers real call sites.
  for (const anchor of ['message.type === "showPatch"', 'message.action === "compareWithLocal"', 'message.action === "showRefDiff"', "compareRefHistory("]) {
    const start = source.indexOf(anchor);
    assert.ok(start > 0, `${anchor} should exist`);
    assert.match(source.slice(start, start + 500), /this\.showReadOnlyDiff\(/, `${anchor} should use the read-only editor`);
  }
});

test("pushes without waiting for the commit notification to be dismissed", () => {
  const handler = source.match(/if \(message\.type === "commit"\) \{([\s\S]*?)type: "committed"/);
  assert.ok(handler);
  // showInformationMessage only settles once the toast closes, so awaiting it here
  // used to delay the push until the notification went away.
  assert.doesNotMatch(handler[1], /await vscode\.window\.showInformationMessage/);
  assert.match(handler[1], /void vscode\.window\.showInformationMessage/);
  assert.ok(handler[1].indexOf("manager.push") < handler[1].indexOf("void vscode.window.showInformationMessage(`Committed"));
});

test("offers IntelliJ branch operations from the branch context menu", () => {
  assert.ok(scriptMatch);
  const menu = scriptMatch[1].match(/function branchContextItems\(branch\) \{([\s\S]*?)\r?\n  }/);
  assert.ok(menu);
  for (const action of ["pushRef", "mergeRef", "rebaseOntoRef", "pullRefMerge", "pullRefRebase", "fetchRef", "tagFromRef", "deleteTag"]) {
    assert.match(menu[1], new RegExp(`act\\('${action}'\\)`), `${action} should be reachable`);
  }
  assert.match(menu[1], /Merge ' \+ branch\.name \+ ' into '/);
  assert.match(menu[1], /Rebase ' \+ into \+ ' onto '/);
  // Every new action needs a handler on the extension side.
  for (const action of ["pushRef", "mergeRef", "rebaseOntoRef", "pullRefMerge", "pullRefRebase", "fetchRef", "tagFromRef", "deleteTag"]) {
    assert.match(source, new RegExp(`message\\.action === "${action}"`), `${action} should be handled`);
  }
});

test("gives the branch column its own toolbar and name filter", () => {
  assert.ok(scriptMatch);
  const pane = scriptMatch[1].match(/function branchPane\(\) \{([\s\S]*?)\r?\n  }/);
  assert.ok(pane);
  for (const command of ["jbGit.fetch", "jbGit.pull", "jbGit.push", "jbGit.createBranch"]) {
    assert.match(pane[1], new RegExp(`command: '${command}'`), `${command} should be on the branch toolbar`);
    assert.match(source, new RegExp(`"${command}"`), `${command} must be allowed from the webview`);
  }
  assert.match(pane[1], /branch-filter/);
  assert.match(scriptMatch[1], /function refreshBranchPane\(\)/);
});

test("marks branch, remote, and tag decorations with distinct icons in rows and details", () => {
  assert.ok(scriptMatch);
  const script = scriptMatch[1];
  assert.match(script, /refIconMarkup = \{[\s\S]*tag:[\s\S]*local:[\s\S]*remote:/);
  assert.match(script, /raw\.startsWith\('tag: '\)/);
  assert.match(script, /raw\.startsWith\('HEAD -> '\)/);
  // Both the middle column and the details pane render the same chips.
  assert.match(script, /refs\.append\(refChip\(ref\)\)/);
  const details = script.match(/function detailsPane\(\) \{([\s\S]*?)\r?\n  }/);
  assert.ok(details);
  assert.match(details[1], /detail-refs/);
  assert.match(details[1], /refChip\(ref\)/);
});

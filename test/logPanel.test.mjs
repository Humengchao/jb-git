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

test("wires context menus for branches, commits, and changed files", () => {
  assert.ok(scriptMatch);
  assert.equal(scriptMatch[1].match(/attachContextMenu\(row,/g)?.length, 3);
  assert.match(scriptMatch[1], /event\.key === 'F10'/);
  assert.match(scriptMatch[1], /event\.key !== 'ContextMenu'/);
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
  assert.match(scriptMatch[1], /Text or hash/);
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

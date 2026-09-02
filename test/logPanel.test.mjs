import assert from "node:assert/strict";
import test from "node:test";
import { readSource } from "./sourceText.mjs";

const source = readSource("../src/webviews/logPanel.ts", import.meta.url);
const protocolSource = readSource("../src/webviews/logPanelProtocol.ts", import.meta.url);
const pushPreviewSource = readSource("../src/pushPreview.ts", import.meta.url);
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
  assert.match(scriptMatch[1], /splitter\.addEventListener\('pointerdown'/);
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
  assert.match(protocolSource, /"loadMore"/);
  assert.match(source, /logLimit = Math\.min\(5_000/);
  assert.match(scriptMatch[1], /refreshDetailsForFilter/);
  assert.match(scriptMatch[1], /Loading commit details/);
  assert.match(scriptMatch[1], /Load 300 more commits/);
});

test("virtualizes large commit lists and stops offering history past the hard cap", () => {
  assert.ok(scriptMatch);
  assert.match(scriptMatch[1], /virtualThreshold = 500/);
  assert.match(scriptMatch[1], /renderCommitWindow/);
  assert.match(source, /this\.logLimit < 5_000 && !this\.logCache\?\.exhausted && commits\.length >= this\.logLimit/);
});

test("provides safe local-change commits and repository-scoped drafts", () => {
  assert.ok(scriptMatch);
  assert.match(protocolSource, /listId\?: string/);
  assert.match(scriptMatch[1], /listId: list\.id/);
  assert.match(scriptMatch[1], /commitMessages/);
  assert.match(scriptMatch[1], /commit\.disabled = disabled/);
  assert.match(scriptMatch[1], /collapsedChangelists/);
  assert.match(scriptMatch[1], /setupChangesSplitter/);
  assert.match(protocolSource, /"editChangelist"/);
  assert.match(protocolSource, /"deleteChangelist"/);
  assert.match(scriptMatch[1], /changelist-description/);
});

test("exposes the Index and working tree as separate, hunk-level commit sources", () => {
  assert.ok(scriptMatch);
  assert.match(protocolSource, /type: "requestHunks"/);
  assert.match(protocolSource, /type: "applyHunk"/);
  assert.match(source, /manager\.stageHunk/);
  assert.match(source, /manager\.unstageHunk/);
  assert.match(scriptMatch[1], /HEAD → Index/);
  assert.match(scriptMatch[1], /Index → Working Tree/);
  assert.match(scriptMatch[1], /Staging area \(Index\)/);
  assert.match(scriptMatch[1], /complete contents/);
});

test("accepts full SHA-1 and SHA-256 object IDs from the log", () => {
  assert.match(source, /\[0-9a-f\]\{40\}.*\[0-9a-f\]\{64\}/);
  assert.doesNotMatch(source, /\^\[0-9a-f\]\{40\}\$/);
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
  const extensionSource = readSource("../src/extension.ts", import.meta.url);
  assert.doesNotMatch(extensionSource, /registerTextDocumentContentProvider/);
  assert.match(extensionSource, /registerFileSystemProvider\(DiffContentProvider\.scheme, diffProvider, \{\s*isCaseSensitive: true,\s*isReadonly: true,/);
  // Anchor on each handler, not the message-type union, so the assertion covers real call sites.
  for (const anchor of ['message.type === "showPatch"', 'message.action === "compareWithLocal"', 'message.action === "showRefDiff"', "compareRefHistory("]) {
    const start = source.indexOf(anchor);
    assert.ok(start > 0, `${anchor} should exist`);
    assert.match(source.slice(start, start + 500), /this\.showReadOnlyDiff\(/, `${anchor} should use the read-only editor`);
  }
});

test("routes Commit & Push through an outgoing-commit preview without waiting on notifications", () => {
  const handler = source.match(/if \(message\.type === "commit"\) \{([\s\S]*?)type: "committed"/);
  assert.ok(handler);
  // showInformationMessage only settles once the toast closes, so awaiting it here
  // used to delay the push until the notification went away.
  assert.doesNotMatch(handler[1], /await vscode\.window\.showInformationMessage/);
  assert.match(handler[1], /previewAndPush\(this\.manager, root\)/);
  assert.ok(handler[1].indexOf("previewAndPush") < handler[1].indexOf("push was not performed"));
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

test("marks each local branch with IDEA's incoming and outgoing arrows", () => {
  // ↓ what a fetch brought in, ↑ what a push would send, right-aligned; a
  // deleted upstream says 'gone' instead of showing meaningless zeros.
  assert.match(scriptMatch[1], /if \(kind === 'local' && \(branch\.ahead \|\| branch\.behind \|\| branch\.upstreamGone\)\)/);
  assert.match(scriptMatch[1], /'↓' \+ branch\.behind/);
  assert.match(scriptMatch[1], /'↑' \+ branch\.ahead/);
  assert.match(scriptMatch[1], /node\('span', 'track-gone', 'gone'\)/);
  const source = readSource("../src/webviews/logPanel.ts", import.meta.url);
  assert.match(source, /\.branch-track \{ margin-left: auto;/);
  // The fingerprint already covers %(upstream:track), so a fetch that changes
  // the counts repaints the column.
  assert.match(source, /\$\{branch\.tracking \?\? ""\}/);
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

test("routes tool-window commands to the repository the window is showing", () => {
  const extensionSource = readSource("../src/extension.ts", import.meta.url);
  // The webview invokes commands as executeCommand(id, root), so a command typed to take a
  // tree node silently dropped the root and re-prompted for a repository.
  for (const command of ["createBranch", "renameBranch", "deleteBranch", "checkoutBranch", "skipOperation"]) {
    assert.match(
      extensionSource,
      new RegExp(`registerCommand\\("jbGit\\.${command}", async \\(rootPath\\?: string\\)`),
      `${command} should accept a repository root`,
    );
  }
  assert.match(extensionSource, /"jbGit\.skipOperation"[\s\S]{0,200}pickRepository\(rootPath\)/);
  // The node classes those signatures referenced were never constructed.
  assert.doesNotMatch(extensionSource, /RepositoryNode|BranchNode/);
});

test("treats a cancelled Git command as a cancellation rather than an error", () => {
  const runnerSource = readSource("../src/git/runner.ts", import.meta.url);
  assert.match(runnerSource, /export class GitAbortError extends Error/);
  assert.match(runnerSource, /export function isGitAbort/);
  assert.match(runnerSource, /terminate\(new GitAbortError\(\)\)/);
  const extensionSource = readSource("../src/extension.ts", import.meta.url);
  // The two notification wrappers and the cancellable Update Project.
  assert.equal(extensionSource.match(/if \(isGitAbort\(error\)\)/g)?.length, 3);
  assert.match(source, /if \(isGitAbort\(error\)\) return;/);
});

test("targets refs unambiguously and guards branch operations by kind", () => {
  // git shortens a name shared by a branch and a tag to "heads/x"/"tags/x", which cannot be
  // pasted into a ref path, so operations carry the full ref.
  assert.match(readSource("../src/git/types.ts", import.meta.url), /fullName: string/);
  for (const call of [
    /diffAgainstWorkingTree\(branch\.fullName\)/,
    /createBranch\(root, name\.trim\(\), branch\.fullName\)/,
    /createTag\(root, name\.trim\(\), branch\.fullName\)/,
    /rebaseWithLocalChanges\(this\.manager, root, branch\.fullName, branch\.name\)/,
    /merge\(root, branch\.fullName\)/,
    /compareRefHistory\(left\.fullName, right\.fullName\)/,
    /checkoutWithLocalChanges\(this\.manager, root, branch\)/,
  ]) assert.match(source, call);

  const handler = source.slice(source.indexOf('message.action === "mergeRef"'));
  assert.match(handler.slice(0, 900), /if \(branch\.kind === "tag"\) return;/);
  assert.match(handler.slice(0, 1200), /if \(pull && branch\.kind !== "remote"\) return;/);
  assert.match(source.slice(source.indexOf('message.action === "fetchRef"')).slice(0, 300), /branch\.kind !== "remote"/);
  // Rebase rewrites the current branch, so it must confirm like the other rewriting actions.
  assert.match(handler.slice(0, 1200), /showWarningMessage\(\s*`Rebase/);

  const menu = scriptMatch[1].match(/function branchContextItems\(branch\) \{([\s\S]*?)\r?\n  }/);
  assert.ok(menu);
  assert.match(menu[1], /if \(!isCurrent && kind !== 'tag'\) items\.push\(/);
});

test("never guesses an integration remote and previews the exact branch push target", () => {
  const resolver = source.match(/private async remoteForBranch\([\s\S]*?\n  }/);
  assert.ok(resolver);
  // A ref left behind by `git remote remove` still looks remote; fetching some other remote
  // would silently integrate stale commits.
  assert.doesNotMatch(resolver[0], /remotes\.length === 1/);
  assert.match(resolver[0], /branch\.kind !== "remote"/);
  assert.match(source, /previewAndPush\(this\.manager, root, \{ sourceBranch: branch\.name \}\)/);
  assert.match(pushPreviewSource, /const refspec = `\$\{sourceRef\}:refs\/heads\/\$\{target\.branch\}`/);
  assert.match(pushPreviewSource, /isProtectedBranch\(target\.branch/);
});

test("ends splitter drags even when the button is released outside the window", () => {
  assert.ok(scriptMatch);
  const script = scriptMatch[1];
  // A window-level mouseup is never dispatched when the release happens outside the window,
  // which left the splitter following the cursor afterwards.
  assert.doesNotMatch(script, /addEventListener\('mousedown'/);
  assert.doesNotMatch(script, /window\.addEventListener\('mousemove'/);
  assert.doesNotMatch(script, /window\.addEventListener\('mouseup'/);
  assert.match(script, /function beginDrag\(handle, event, onMove, onEnd\)/);
  assert.match(script, /handle\.setPointerCapture\(event\.pointerId\)/);
  assert.match(script, /handle\.addEventListener\('pointercancel', finish\)/);
  assert.match(script, /handle\.addEventListener\('lostpointercapture', finish\)/);
  // All three splitters go through it.
  assert.equal(script.match(/beginDrag\(splitter, event,/g)?.length, 3);

  const merge = readSource("../src/webviews/mergeEditor.ts", import.meta.url);
  assert.doesNotMatch(merge, /window\.addEventListener\('mouseup'/);
  assert.match(merge, /splitter\.setPointerCapture\(event\.pointerId\)/);
  assert.match(merge, /splitter\.addEventListener\('lostpointercapture', up\)/);
});

test("always leaves one commit row reachable by Tab", () => {
  assert.ok(scriptMatch);
  // Rows are only tabbable when selected, so scrolling the selected commit out of the
  // virtualised window used to leave the whole list unreachable by keyboard.
  assert.match(scriptMatch[1], /if \(!list\.querySelector\('\.commit-row\[tabindex="0"\]'\)\) \{/);
});

test("opens a change diff from anywhere on the row", () => {
  assert.ok(scriptMatch);
  const row = scriptMatch[1].match(/function changeRow\(change\) \{([\s\S]*?)\r?\n  }/);
  assert.ok(row);
  // The listener used to sit on the file-name element, so double-clicking the status letter
  // or the empty part of the row did nothing.
  assert.doesNotMatch(row[1], /file\.addEventListener\('dblclick'/);
  assert.match(row[1], /row\.addEventListener\('dblclick'/);
  assert.match(row[1], /event\.target\.closest\('button, input'\)/);
  // Enter opens the diff, Space toggles inclusion, as in the IntelliJ commit tool window.
  assert.match(row[1], /event\.key === 'Enter'.*openDiff/s);
  assert.match(row[1], /event\.key === ' '[\s\S]*?togglePath/);
});

test("keeps keyboard focus and scroll position through virtual-list rebuilds", () => {
  assert.ok(scriptMatch);
  const script = scriptMatch[1];
  // replaceChildren empties the scroller, so the browser clamps scrollTop to 0: the window has
  // to be rendered for the intended offset before the offset is assigned.
  assert.match(script, /function renderCommitWindow\(existing, scrollTopOverride\)/);
  assert.match(script, /renderCommitWindow\(undefined, target\)/);
  const navigate = script.match(/function selectVirtualCommit\([\s\S]*?\n  }/);
  assert.ok(navigate);
  assert.ok(navigate[0].indexOf("renderCommitWindow(undefined, target)") < navigate[0].indexOf("scroll.scrollTop = target"));
  // The programmatic scroll must not trigger a rebuild that destroys the row just focused.
  assert.match(script, /expectedScrollTop = target/);
  assert.match(script, /Math\.abs\(scroll\.scrollTop - expectedScrollTop\) < 1/);
  // A render builds the list detached, so restoring focus has to wait for the real window.
  const restore = script.match(/function restoreScroll\(saved\) \{([\s\S]*?)\n  }/);
  assert.ok(restore);
  assert.ok(restore[1].indexOf("renderCommitWindow(undefined, commitTarget)") < restore[1].indexOf("restoreFocus"));
});

test("remembers scroll positions and focusable identities across renders", () => {
  assert.ok(scriptMatch);
  const script = scriptMatch[1];
  // Positions used to be captured per render, so leaving a tab dropped its scroll offsets.
  assert.match(script, /scrollMemory\[id\] = \{ top: element\.scrollTop, left: element\.scrollLeft \}/);
  assert.match(script, /positions: \{ \.\.\.scrollMemory \}/);
  // Elements with no id and no dataset key cannot be found again, so do not claim they can.
  assert.match(script, /focusKey: element\.dataset\?\.focusKey \|\| ''/);
  assert.match(script, /!descriptor\.branchKey && !descriptor\.focusKey\) return undefined/);
  assert.match(script, /data-focus-key="' \+ CSS\.escape\(descriptor\.focusKey\)/);
  assert.match(script, /tab\.dataset\.focusKey = 'tab:' \+ id/);
  assert.match(script, /row\.dataset\.focusKey = 'change:' \+ change\.path/);
  // Clicking a tab re-renders the header, so the old element is detached before focus() runs.
  assert.match(script, /document\.querySelector\('\[data-tab-id="' \+ target \+ '"\]'\)\?\.focus\(\)/);
});

test("toggles filter popups and never leaves an orphaned menu", () => {
  assert.ok(scriptMatch);
  const script = scriptMatch[1];
  // The document pointerdown closed the menu before the invoker's click could reopen it, so
  // filter popups flickered instead of toggling closed.
  assert.match(script, /!menuInvoker\?\.contains\(event\.target\)\) closeContextMenu\(\)/);
  assert.match(script, /if \(openMenu && menuInvoker === element\) \{ closeContextMenu\(true\); return; \}/);
  // An open menu defers state updates, so tabbing away must not leave one open.
  assert.match(script, /event\.key === 'Tab'\) \{ closeContextMenu\(\); return; \}/);
});

test("preserves details-pane scroll and re-clamps stored pane sizes", () => {
  assert.ok(scriptMatch);
  const script = scriptMatch[1];
  assert.match(script, /function replaceDetailsPane\(current\)/);
  // Two call sites plus the definition; the raw swap survives only inside the helper.
  assert.equal(script.match(/replaceDetailsPane\(current\)/g)?.length, 3);
  assert.equal(script.match(/replaceWith\(detailsPane\(\)\)/g)?.length, 1);
  // Feeding the clamped width back through the clamp made every shrink permanent.
  const observer = script.match(/function setupWorkspaceColumns[\s\S]*?\n  }/);
  assert.ok(observer);
  assert.doesNotMatch(observer[0], /readColumnWidth\(workspace, 'branch'\), readColumnWidth\(workspace, 'details'\)/);
  assert.match(observer[0], /Number\(uiState\.branchPaneWidth\) \|\| 185, Number\(uiState\.detailsPaneWidth\) \|\| 300/);
});

test("navigates a non-virtual list without rebuilding it and keeps drags touch-safe", () => {
  assert.ok(scriptMatch);
  const script = scriptMatch[1];
  // Below the threshold every row exists; rebuilding up to 500 rows per arrow key was janky.
  const navigate = script.match(/function selectVirtualCommit\([\s\S]*?\n  }/);
  assert.ok(navigate);
  assert.match(navigate[0], /virtualCommits\.length <= virtualThreshold/);
  assert.match(navigate[0], /scrollIntoView\(\{ block: 'nearest' \}\)/);
  // Touch drags on the message splitter must not turn into native panning. The rule lives
  // in the style block, not the script.
  assert.match(source, /\.detail-splitter \{[^}]*touch-action: none/);
  // The `.splitter.active` guard matched nothing; only `.dragging` exists in this webview.
  assert.doesNotMatch(script, /\.dragging, \.splitter\.active/);
  // A resize moves everything under an open menu, so it closes like native menus do.
  assert.match(script, /window\.addEventListener\('resize', \(\) => closeContextMenu\(\)\)/);
  // The Local Changes splitter re-clamps its stored size when the panel resizes.
  // \r?: the Windows runner checks out CRLF.
  const changes = script.match(/function setupChangesSplitter\([\s\S]*?\r?\n  }\r?\n/);
  assert.ok(changes);
  assert.match(changes[0], /new ResizeObserver/);
  assert.match(changes[0], /applyStored\(\)/);
});

test("keeps commit controls and selection honest while replies are pending", () => {
  assert.ok(scriptMatch);
  const script = scriptMatch[1];
  // Checkbox toggles update the count and buttons immediately; the state echo is deferred
  // while a menu is open, so the last render's values would contradict the checkboxes.
  assert.match(script, /function refreshCommitControls\(\)/);
  assert.equal(script.match(/refreshCommitControls\(\)/g)?.length, 5);
  assert.match(script, /count\.id = 'selected-count'/);
  assert.match(script, /commit\.id = 'commit-button'/);
  assert.match(script, /Staging area \(Index\)/);
  assert.match(script, /Selected files \(complete contents\)/);
  // A state push that neither answers nor invalidates an in-flight selectCommit keeps it
  // pending instead of snapping the highlight back.
  const apply = script.match(/function applyIncomingState\(next\) \{([\s\S]*?)\n  }/);
  assert.ok(apply);
  assert.match(apply[1], /const fulfilled = !pendingCommitHash/);
  assert.match(apply[1], /if \(fulfilled\) pendingCommitHash = undefined;/);
  assert.doesNotMatch(apply[1], /state = \{ \.\.\.state, \.\.\.next \}; pendingCommitHash = undefined;/);
  // An error reply will never be followed by a selection, so drop the loading placeholder.
  assert.match(script, /type === 'error'[\s\S]{0,300}pendingCommitHash = undefined; updateSelectionWithoutRerender\(\);/);
});

test("draws the dropdowns and checkboxes from the theme, not from the browser", () => {
  assert.ok(scriptMatch);
  // A native select and native checkboxes were the only browser-default controls
  // left in the panel, which made the commit form read as a web form dropped
  // into the editor.
  assert.match(source, /\.select-shell select \{[^}]*appearance: none/);
  assert.match(source, /\.select-shell select \{[^}]*var\(--vscode-dropdown-background/);
  assert.match(source, /input\[type="checkbox"\] \{[^}]*appearance: none/);
  assert.match(source, /input\[type="checkbox"\]:checked::after \{/);
  // The chevron is drawn with borders: a CSP with no img-src cannot load a
  // background image, so a data URI arrow would silently not appear.
  assert.match(source, /\.select-shell::after \{[^}]*transform: rotate\(45deg\)/);
  assert.doesNotMatch(source, /\.select-shell[^}]*background-image/);
  // Every select goes through the shell, or the styled one would be the odd
  // control out instead of the plain ones.
  const created = scriptMatch[1].match(/node\('select'\)/g) ?? [];
  const wrapped = scriptMatch[1].match(/selectShell\(/g) ?? [];
  assert.ok(created.length >= 4, "the panel should still build its selects here");
  assert.equal(wrapped.length, created.length, "every select must be wrapped for the chevron and theming");
  // Commit and Commit & Push are one decision, so they carry one style.
  assert.match(scriptMatch[1], /button\('Commit & Push',[\s\S]{0,90}?'primary'\)/);
});

test("recovers from a render throw instead of leaving the window blank", () => {
  assert.ok(scriptMatch);
  // Rendering runs again on every state message, so one throw used to leave
  // the whole tool window permanently blank with nothing to act on.
  assert.match(scriptMatch[1], /function render\(\) \{\r?\n    try \{\r?\n      renderView\(\);/);
  assert.match(scriptMatch[1], /render-error-title/);
  assert.match(scriptMatch[1], /button\('Reset view state'/);
  assert.match(scriptMatch[1], /uiState = \{\}; vscode\.setState\(undefined\); deriveUiState\(\); render\(\);/);
  // Persisted state written by an older version may not parse; the first
  // derivation heals itself rather than dying before the first render.
  assert.match(scriptMatch[1], /try \{ deriveUiState\(\); \} catch \(error\) \{ uiState = \{\}; deriveUiState\(\); \}/);
});

test("colours file names by status in both trees, like IDEA", () => {
  assert.ok(scriptMatch);
  assert.match(scriptMatch[1], /const statusClassFor = letter =>/);
  // One call in changeRow, one in commitFileRow.
  assert.equal((scriptMatch[1].match(/statusClassFor\(/g) ?? []).length, 2);
  // The name itself carries the colour, not only the status letter.
  assert.match(scriptMatch[1], /node\('div', 'change-file ' \+ statusClass\)/);
  assert.match(scriptMatch[1], /node\('span', 'file-path ' \+ statusClass/);
  assert.match(source, /\.status-R, \.status-C \{ color: var\(--vscode-gitDecoration-renamedResourceForeground/);
  assert.match(source, /\.status-A \{ color: var\(--vscode-gitDecoration-addedResourceForeground/);
});

test("keeps every commit-form control readable in a narrow column", () => {
  // Beside the select, the mode help wrapped into a six-line sliver.
  assert.match(source, /\.commit-mode-row \{ display: grid; gap: 4px;/);
  assert.doesNotMatch(source, /\.commit-mode-row \{[^}]*minmax\(160px, auto\)/);
});

test("routes user-visible strings through the translator with no duplicate keys", () => {
  assert.ok(scriptMatch);
  const script = scriptMatch[1];
  // Strings assigned to properties bypass node()/button() and must call t().
  assert.match(script, /checkbox\.title = t\('Include in commit'\)/);
  assert.match(script, /message\.placeholder = t\(state\.totalChanges \? 'Commit Message' : 'No changes to commit'\)/);
  assert.match(script, /input\.placeholder = t\(deepActive \? 'Searching all history' : 'Filter loaded commits · Enter searches all history'\)/);
  assert.match(script, /input\.placeholder = t\('src\/path or file name'\)/);
  assert.match(script, /repositories\.title = t\('Git root'\)/);
  // Counted nouns cannot be dictionary keys, so they go through one helper.
  assert.match(script, /const fileCount = count =>/);
  assert.doesNotMatch(script, /\+ ' files'/);
  // A duplicated dictionary key silently shadows its earlier entry.
  const dictSource = script.slice(script.indexOf("const zh = isZh ? {"), script.indexOf("} : {};"));
  const keys = [...dictSource.matchAll(/'((?:[^'\\]|\\.)+)'\s*:/g)].map((entry) => entry[1]);
  const seen = new Set();
  for (const key of keys) {
    assert.ok(!seen.has(key), `duplicate dictionary key: ${key}`);
    seen.add(key);
  }
});

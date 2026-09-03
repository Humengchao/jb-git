/**
 * The Git tool window's Webview script.
 *
 * A plain `String.raw` constant with no interpolation: the text below is the
 * whole body of the panel's `<script>`, injected as-is. It is not an IIFE, so
 * every `function` here hoists across the file and the last statements are the
 * boot sequence — the shared state and helpers are declared at the top,
 * before anything that runs.
 *
 * Nothing type-checks this string, which is why `test/webviewScripts.test.mjs`
 * parses it and checks that it only calls names the sandbox has, and why
 * `scripts/screenshot.mjs` exists at all.
 */
import { readFileSync } from "node:fs";

let issueNavigationScriptCache: string | undefined;

/**
 * The compiled issueNavigation module, wrapped as a global for the Webview
 * sandbox. Injecting the build the tests exercise keeps rule compilation and
 * overlap handling in one place instead of a copy that could drift.
 */
export function issueNavigationScript(): string {
  issueNavigationScriptCache ??= `const IssueNavigation = (() => { const exports = {}; ${readFileSync(require.resolve("../issueNavigation"), "utf8")}\n;return exports; })();\n`;
  return issueNavigationScriptCache;
}

export const logScript = String.raw`
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state = { repositories: [], branches: [], commits: [] };
  let uiState = vscode.getState() || {};
  const hunkState = new Map();
  const hunkRequestIds = new Map();
  let requestSequence = 0;
  let pendingSelectionRequestId;
  let pendingHeadRequestId;
  let lastStateVersion = 0;
  // What the message box held before Amend replaced it, per repository.
  const preAmendDrafts = {};

  /**
   * Puts text into the commit message box as if it had been typed, so the
   * draft is saved and the buttons re-enable through the box's own listener.
   */
  function fillCommitMessage(text) {
    const box = document.getElementById('commit-message');
    if (!box || box.disabled || typeof text !== 'string' || !text) return;
    box.value = text;
    box.dispatchEvent(new Event('input'));
  }
  let expandedChangeHunks; let search; let branchFilter; let activeToolTab; let selectedBranchKeys;
  let authorFilter; let knownAuthors; let dateFilter; let sortMode; let firstParent; let noMerges;
  let collapsedGraphSeries; let selectedGraphSeries; let consoleFilter; let consolePaused;

  /** (Re)derives every view local from persisted state, so recovery can reset them together. */
  function deriveUiState() {
    expandedChangeHunks = new Set(uiState.expandedChangeHunks || []);
    search = uiState.search || '';
    branchFilter = uiState.branchFilter || '';
    activeToolTab = uiState.activeToolTab || 'log';
    selectedBranchKeys = new Set(uiState.selectedBranchKeys || []);
    authorFilter = uiState.authorFilter || '';
    knownAuthors = new Set(uiState.knownAuthors || []);
    dateFilter = uiState.dateFilter || 'all';
    sortMode = uiState.sortMode === 'topological' ? 'topological' : 'date';
    firstParent = Boolean(uiState.firstParent);
    noMerges = Boolean(uiState.noMerges);
    collapsedGraphSeries = new Set(uiState.collapsedGraphSeries || []);
    selectedGraphSeries = uiState.selectedGraphSeries || '';
    consoleFilter = uiState.consoleFilter || 'operations';
    consolePaused = Boolean(uiState.consolePaused);
  }
  // The state VS Code restores was written by whatever version ran last, so a
  // shape this build cannot read must fall back to defaults, not leave the
  // whole window blank before the first render.
  try { deriveUiState(); } catch (error) { uiState = {}; deriveUiState(); }
  let hoveredGraphSeries = '';
  let currentGraphFragments = new Map();
  let pendingCommitHash;
  // Ctrl/Cmd- and Shift-click selection, IDEA's multi-commit workflows. Size 0
  // means the ordinary single selection (pendingCommitHash / state.selection)
  // is authoritative; the anchor is where a Shift range grows from.
  let multiSelectedHashes = new Set();
  let commitSelectionAnchor;
  // IDEA's Edit Commit Message: the commit whose message is being edited in
  // place of the details pane's read-only message, if any.
  let rewordEditingHash;
  // What has been typed so far: every state message re-renders the pane, and
  // the box must not fall back to the commit's message mid-edit.
  let rewordDraft;
  let rewordNeedsFocus = false;
  let selectedFilePath;
  let openMenu;
  let menuInvoker;
  let deferredState;
  let deferredStateVersion = 0;
  let virtualCommits = [];
  let virtualGraph = [];
  let virtualRenderFrame;
  let expectedScrollTop;
  let scrollMemory = {};
  const commitRowHeight = 27;
  const virtualThreshold = 500;
  // A change row is ~18 elements and ~8 listeners, and the whole pane is
  // rebuilt on every state message. A repository with a few thousand changed
  // files — which happens, and once happened here through editor caches — cost
  // tens of thousands of both per refresh. The rest of a long list is one
  // click away instead, the way the log offers its next page.
  const changeRowCap = 500;
  const colors = ['#4b8ff9', '#e36d75', '#55a868', '#c887d7', '#d99b42', '#45a9a5'];
  const isZh = document.documentElement.lang.toLowerCase().startsWith('zh');
  const zh = isZh ? {
    'Log': '日志', 'Git Log': 'Git 日志', 'Console': '控制台', 'Git Console': 'Git 控制台',
    'Local Changes': '本地更改', 'Shelf': '搁置', 'Shelved Changes': '已搁置的更改',
    'User operations': '用户操作', 'Errors only': '仅错误', 'All commands': '全部命令',
    'Pause scroll': '暂停滚动', 'Resume scroll': '继续滚动', 'Clear': '清空',
    'Branches': '分支', 'All': '全部', 'Local': '本地', 'Remote': '远程', 'Tags': '标签',
    'Recent': '最近', 'Favorites': '收藏', 'Add to Favorites': '添加到收藏', 'Remove from Favorites': '从收藏中移除',
    'Update Project…': '更新项目…',
    'Refresh': '刷新', 'More…': '更多…', 'New Changelist': '新建更改列表', 'Shelve': '搁置',
    'No local changes': '没有本地更改', 'No changes to commit': '没有可提交的更改',
    'Commit Changes': '提交更改', 'Commit Message': '提交消息', 'Amend': '修正提交',
    'Sign-off': '添加签署', 'Skip hooks': '跳过钩子', 'Commit': '提交', 'Commit & Push': '提交并推送',
    'Select All': '全选', 'Clear Selection': '取消全选', '+ Changelist': '+ 更改列表', '+ Shelve': '+ 搁置',
    'Include in commit': '包含在提交中', 'Filter loaded commits': '筛选已加载的提交', 'Filter branches': '筛选分支',
    'Filter the loaded commits by text or hash': '按文本或哈希筛选已加载的提交',
    'Filter branches, remotes and tags by name': '按名称筛选分支、远程和标签',
    'src/path or file name': 'src/路径 或 文件名', 'No branch matches the filter': '没有匹配的分支',
    'No user Git operations yet. Background refresh commands are hidden.': '还没有用户 Git 操作。后台刷新命令已隐藏。',
    'No matching Git command output.': '没有匹配的 Git 命令输出。', 'background': '后台', 'Git root': 'Git 仓库根',
    'Shelve selected local changes': '搁置所选本地更改', 'Shelve selected changes': '搁置所选更改',
    'Save the selected changes as a patch file': '将所选更改保存为补丁文件',
    'Rollback this change': '回滚此改动', 'Rollback': '回滚',
    'Click a graph line to select or collapse its series': '点击图形线条以选择或折叠该系列',
    'Drag to resize commit message': '拖动以调整提交消息高度', 'More Git actions': '更多 Git 操作',
    'The Git tool window failed to render': 'Git 工具窗口渲染失败', 'Reset view state': '重置视图状态',
    'Clear saved view state and render again': '清除保存的视图状态并重新渲染', 'Try again': '重试',
    'Render again without changing anything': '不做更改，重新渲染',
    'Staging area (Index)': '暂存区（Index）', 'Selected files (complete contents)': '所选文件（完整内容）',
    'Commits exactly what is in Git Index; working-tree changes stay uncommitted.': '只提交 Git Index 中已暂存的内容，工作区里未暂存的修改保持不提交。',
    'Commits all changes in each checked file, including its unstaged changes.': '提交每个勾选文件的全部改动，包括其中尚未暂存的部分。',
    'Commit selected changes': '提交所选更改', 'Commit selected changes and push': '提交所选更改并推送',
    'Commit source': '提交内容来源',
    'selected': '已选择',
    'No shelved changes': '没有已搁置的更改', 'Unshelve': '取消搁置',
    'Restore these changes and remove the shelf': '恢复这些更改并删除该搁置',
    'More shelf actions': '更多搁置操作', 'Unshelve and Keep': '取消搁置并保留',
    'Unshelve into Changelist…': '取消搁置到更改列表…',
    'Branch': '分支', 'User': '用户', 'Date': '日期', 'Paths': '路径', 'Lines': '行',
    'Only commits that changed these lines; click to show the whole file': '仅显示改动过这些行的提交；点击可查看整个文件的历史',
    'Edit Commit Message…': '编辑提交消息…', 'Undo Commit…': '撤销提交…',
    'Save Message': '保存消息', 'Rewrite the commit with this message': '用这条消息重写该提交',
    'Cancel': '取消', 'Keep the current message': '保留当前消息', 'Commit message': '提交消息',
    'Accept Yours': '接受你的版本', 'Accept Theirs': '接受对方版本', 'Ignore…': '忽略…',
    'Fixup…': '修正到此提交…', 'Author…': '作者…', 'Commit as another author': '以其他作者身份提交',
    'Author (Name <email>), leave empty for yourself': '作者（姓名 <邮箱>），留空则为本人',
    'All Branches': '所有分支', 'All Users': '所有用户', 'All Dates': '所有日期',
    'Today': '今天', 'Last 7 Days': '最近 7 天', 'Last 30 Days': '最近 30 天', 'Last Year': '最近一年',
    'Sort': '排序', 'By Commit Date': '按提交日期', 'Topologically': '按拓扑', 'Options': '选项',
    'First Parent': '仅第一父提交', 'No Merges': '隐藏合并提交', 'Branch Actions': '分支操作',
    'Collapse Linear Branches': '折叠线性分支', 'Expand Linear Branches': '展开线性分支',
    'Author': '作者', 'Parents': '父提交',
    'Show Diff': '显示差异', 'Compare with Local': '与本地比较', 'Copy Path': '复制路径',
    'Changelist': '变更列表', 'Move…': '移动…', 'some changes': '部分更改',
    'Incoming commits: fetched but not merged': '传入提交：已抓取但未合并',
    'Searching all history': '正在搜索全部历史',
    'Filter loaded commits · Enter searches all history': '筛选已加载的提交 · 回车搜索全部历史',
    'Outgoing commits: not pushed yet': '传出提交：尚未推送',
    'The upstream branch no longer exists': '上游分支已不存在',
    'Commit Message History': '提交消息历史', 'Move this change to another Changelist': '把这处更改移到其他变更列表',
    'Create Patch…': '创建补丁…', 'Copy Revision Number': '复制修订号', 'Cherry-Pick': '拣选提交',
    'Cherry-Pick Selected': '拣选所选提交', 'Compare Versions': '比较版本',
    'Squash Selected…': '压缩所选提交…', 'Drop Selected…': '丢弃所选提交…', 'Drop Commit…': '丢弃提交…',
    'Right-click the selection to cherry-pick the commits in history order, or compare two.': '右键所选内容可按历史顺序拣选这些提交，选中两个时可比较版本。',
    'Checkout': '检出', 'Rename…': '重命名…', 'Delete…': '删除…', 'New Branch…': '新建分支…',
    'Continue': '继续', 'Skip': '跳过', 'Abort': '中止', 'Reset': '重置',
    'Copy Branch Name': '复制分支名', 'Compare Branches': '比较分支', 'Show Files Diff': '显示文件差异',
    'Delete Selected Branches…': '删除所选分支…', 'Show Diff with Working Tree': '与工作区比较',
    'Checkout Revision…': '检出此修订…', 'Reset Current Branch to Here…': '将当前分支重置到这里…',
    'Revert Commit': '还原提交', 'New Tag…': '新建标签…', 'Go to Child Commit': '转到子提交',
    'Go to Parent Commit': '转到父提交', 'Move to Changelist…': '移动到更改列表…',
    'Open Repository Version': '打开仓库版本', 'Get from Revision…': '从修订获取…',
    'History Up to Here': '查看截至此处的历史', 'Load 300 more commits': '再加载 300 条提交',
    'Show commits affecting this path': '显示影响此路径的提交', 'Apply': '应用',
    'Changed Files': '已更改文件', 'Hash': '哈希', 'staged': '已暂存',
    'No matching commits': '没有匹配的提交', 'Loading commit details…': '正在加载提交详情…',
    'Select a commit to view details': '选择一个提交以查看详情',
    'No commit matches the current filters': '没有提交符合当前筛选条件',
    'Open a folder containing a Git repository.': '请打开包含 Git 仓库的文件夹。',
  } : {};
  const t = value => typeof value === 'string' ? (zh[value] || value) : value;
  const post = (type, extra = {}) => vscode.postMessage({ type, root: state.selectedRoot, ...extra });
  const nextRequestId = () => { requestSequence += 1; return requestSequence; };
  const requestHunks = (path, key) => {
    const requestId = nextRequestId(); hunkRequestIds.set(key, requestId);
    post('requestHunks', { path, requestId });
  };
  const requestCommitSelection = hash => {
    const requestId = nextRequestId(); pendingSelectionRequestId = requestId;
    post('selectCommit', { hash, requestId });
  };
  const node = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = t(text); return n; };
  const button = (label, title, handler, className = 'icon-button') => { const b = node('button', className, label); b.type = 'button'; b.title = t(title); b.addEventListener('click', handler); return b; };
  const selectShell = select => { const shell = node('div', 'select-shell'); shell.append(select); return shell; };
  const statusClassFor = letter => letter === '?' ? 'status-q' : letter === '!' ? 'status-bang' : 'status-' + letter;
  const fileCount = count => isZh ? String(count) + ' 个文件' : String(count) + (count === 1 ? ' file' : ' files');
  const saveUiState = extra => { uiState = { ...uiState, ...extra }; vscode.setState(uiState); };
  const selectToolTab = tab => {
    closeContextMenu(); activeToolTab = tab; saveUiState({ activeToolTab: tab });
    post('setActiveTab', { tab }); render();
  };
  const keyboardActivate = (element, handler) => element.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault(); handler();
  });

  function captureScroll() {
    for (const id of ['branch-pane', 'commit-scroll', 'changed-files', 'commit-details', 'changes-list', 'shelf-pane', 'console-output']) {
      const element = document.getElementById(id);
      if (element) scrollMemory[id] = { top: element.scrollTop, left: element.scrollLeft };
    }
    // Remembered across renders, so leaving a tab and coming back keeps its scroll position.
    return { positions: { ...scrollMemory }, focus: captureFocus() };
  }

  function captureFocus() {
    const element = document.activeElement;
    if (!element || element === document.body || !app.contains(element)) return undefined;
    const descriptor = {
      id: element.id || '',
      hash: element.dataset?.hash || '',
      filePath: element.dataset?.filePath || '',
      branchKey: element.dataset?.branchKey || '',
      focusKey: element.dataset?.focusKey || '',
    };
    // Without any of these the element cannot be found again, so do not claim it can be.
    if (!descriptor.id && !descriptor.hash && !descriptor.filePath && !descriptor.branchKey && !descriptor.focusKey) return undefined;
    if (typeof element.selectionStart === 'number') {
      descriptor.selectionStart = element.selectionStart; descriptor.selectionEnd = element.selectionEnd;
    }
    return descriptor;
  }

  function restoreFocus(descriptor) {
    if (!descriptor) return;
    let element = descriptor.id ? document.getElementById(descriptor.id) : undefined;
    if (!element && descriptor.hash) element = document.querySelector('[data-hash="' + CSS.escape(descriptor.hash) + '"]');
    if (!element && descriptor.filePath) element = document.querySelector('[data-file-path="' + CSS.escape(descriptor.filePath) + '"]');
    if (!element && descriptor.branchKey) element = document.querySelector('[data-branch-key="' + CSS.escape(descriptor.branchKey) + '"]');
    if (!element && descriptor.focusKey) element = document.querySelector('[data-focus-key="' + CSS.escape(descriptor.focusKey) + '"]');
    if (!element) return;
    element.focus({ preventScroll: true });
    if (typeof descriptor.selectionStart === 'number' && typeof element.setSelectionRange === 'function') {
      element.setSelectionRange(descriptor.selectionStart, descriptor.selectionEnd);
    }
  }

  function restoreScroll(saved) {
    requestAnimationFrame(() => {
      // The commit window was built while the list was still detached, so it only holds the
      // first rows. Rebuild it for the offset about to be restored, before assigning
      // scrollTop (which replaceChildren would otherwise clamp back to 0) and before
      // restoring focus, whose target row would not exist yet.
      const commitTarget = saved?.positions?.['commit-scroll']?.top;
      if (commitTarget && virtualCommits.length > virtualThreshold) renderCommitWindow(undefined, commitTarget);
      for (const [id, position] of Object.entries(saved?.positions || {})) {
        const element = document.getElementById(id);
        if (!element) continue;
        if (id === 'commit-scroll') expectedScrollTop = position.top;
        element.scrollTop = position.top; element.scrollLeft = position.left;
      }
      restoreFocus(saved?.focus);
    });
  }

  function finishRender(root, saved, graphs = false) {
    app.append(root); restoreScroll(saved);
    if (graphs) requestAnimationFrame(drawGraphs);
  }

  function closeContextMenu(restoreInvoker = false) {
    const invoker = menuInvoker;
    openMenu?.remove(); openMenu = undefined; menuInvoker = undefined;
    if (restoreInvoker && invoker?.isConnected) invoker.focus({ preventScroll: true });
    requestAnimationFrame(flushDeferredState);
  }

  function showContextMenu(event, items) {
    event.preventDefault(); event.stopPropagation(); showContextMenuAt(event.clientX, event.clientY, items, event.currentTarget);
  }

  function showContextMenuAt(clientX, clientY, items, invoker) {
    closeContextMenu();
    menuInvoker = invoker;
    const menu = node('div', 'context-menu'); menu.setAttribute('role', 'menu');
    for (const item of items) {
      if (item.heading) { menu.append(node('div', 'context-menu-heading', item.heading)); continue; }
      if (item.separator) { menu.append(node('div', 'context-menu-separator')); continue; }
      const entry = button('', item.label, () => { closeContextMenu(true); item.run(); }, 'context-menu-item');
      entry.disabled = Boolean(item.disabled); entry.setAttribute('role', 'menuitem');
      entry.append(node('span', 'context-menu-icon', item.icon || ''), node('span', '', item.label)); menu.append(entry);
    }
    document.body.append(menu); openMenu = menu;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(clientX, window.innerWidth - bounds.width - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(clientY, window.innerHeight - bounds.height - 6)) + 'px';
    menu.addEventListener('keydown', event => {
      const entries = [...menu.querySelectorAll('.context-menu-item:not(:disabled)')];
      const current = entries.indexOf(document.activeElement);
      let next = current;
      if (event.key === 'ArrowDown') next = (current + 1) % entries.length;
      else if (event.key === 'ArrowUp') next = (current + entries.length - 1) % entries.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = entries.length - 1;
      else if (event.key === 'Escape') { event.preventDefault(); closeContextMenu(true); return; }
      else if (event.key === 'Tab') { closeContextMenu(); return; }
      else return;
      event.preventDefault(); entries[next]?.focus();
    });
    menu.querySelector('.context-menu-item:not(:disabled)')?.focus();
  }

  function showMenuForElement(element, items) {
    if (openMenu && menuInvoker === element) { closeContextMenu(true); return; }
    const bounds = element.getBoundingClientRect();
    showContextMenuAt(bounds.left, bounds.bottom + 2, items, element);
  }

  function attachContextMenu(element, items) {
    const entries = () => typeof items === 'function' ? items() : items;
    element.addEventListener('contextmenu', event => showContextMenu(event, entries()));
    element.addEventListener('keydown', event => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault(); event.stopPropagation();
      const bounds = element.getBoundingClientRect();
      showContextMenuAt(bounds.left + Math.min(28, bounds.width / 2), bounds.top + Math.min(22, bounds.height), entries(), element);
    });
  }

  let composing = false;
  document.addEventListener('compositionstart', () => { composing = true; }, true);
  document.addEventListener('compositionend', () => { composing = false; }, true);

  function blocksStateRender() {
    const active = document.activeElement;
    return Boolean(composing || openMenu || document.querySelector('.dragging') ||
      (active && active.tagName === 'SELECT'));
  }

  function applyIncomingState(next) {
    if (typeof next.stateVersion === 'number' && next.stateVersion < lastStateVersion) return;
    if (typeof next.stateVersion === 'number') lastStateVersion = next.stateVersion;
    const previousRoot = state.selectedRoot;
    // Keep an in-flight selection unless this push fulfils it or removed its commit;
    // clearing it unconditionally made the highlight jump back to the previous commit.
    const fulfilled = !pendingCommitHash
      || next.selection?.commit?.hash === pendingCommitHash
      || (next.commits ? !next.commits.some(commit => commit.hash === pendingCommitHash) : false);
    state = { ...state, ...next };
    if (fulfilled) pendingCommitHash = undefined;
    for (const commit of next.commits || []) if (commit.author) knownAuthors.add(commit.author);
    saveUiState({ knownAuthors: [...knownAuthors].slice(-500) });
    if (previousRoot && state.selectedRoot && previousRoot !== state.selectedRoot) {
      search = ''; authorFilter = ''; dateFilter = 'all'; selectedFilePath = undefined;
      pendingSelectionRequestId = undefined; pendingHeadRequestId = undefined;
      hunkRequestIds.clear();
      if (!('commits' in next)) { state.commits = []; state.selection = null; }
      collapsedGraphSeries.clear(); selectedGraphSeries = ''; hoveredGraphSeries = '';
      saveUiState({ search, authorFilter, dateFilter, collapsedGraphSeries: [], selectedGraphSeries: '' });
    }
    if (state.logOptions) {
      sortMode = state.logOptions.order === 'topological' ? 'topological' : 'date';
      firstParent = Boolean(state.logOptions.firstParent); noMerges = Boolean(state.logOptions.noMerges);
      saveUiState({ sortMode, firstParent, noMerges });
    }
    const liveBranchKeys = new Set((state.branches || []).map(branchKey));
    selectedBranchKeys = new Set([...selectedBranchKeys].filter(key => liveBranchKeys.has(key)));
    if (!selectedBranchKeys.size && state.selectedRef) {
      const selectedRefBranch = (state.branches || []).find(branch => branch.name === state.selectedRef);
      if (selectedRefBranch) selectedBranchKeys.add(branchKey(selectedRefBranch));
    }
    saveUiState({ selectedBranchKeys: [...selectedBranchKeys] });
    if (state.selection && !(state.selection.files || []).some(file => file.path === selectedFilePath)) selectedFilePath = state.selection.files[0]?.path;
    render();
  }

  let errorBanner;
  function showErrorBanner(message) {
    // A full render clears the banner via replaceChildren; failures between
    // renders reuse one element instead of stacking a banner per failure.
    if (errorBanner && errorBanner.isConnected) { errorBanner.textContent = message; return; }
    errorBanner = node('div', 'error', message);
    app.prepend(errorBanner);
  }

  function flushDeferredState() {
    if (!deferredState || blocksStateRender()) return;
    const next = deferredState; deferredState = undefined; applyIncomingState(next);
    deferredStateVersion = 0;
  }

  function render() {
    try {
      renderView();
    } catch (error) {
      // Rendering runs again on every state message, so one throw here would
      // otherwise leave the tool window permanently blank with nothing to act
      // on. Show the failure and offer the two ways out.
      app.replaceChildren();
      const panel = node('div', 'render-error');
      panel.append(node('div', 'render-error-title', 'The Git tool window failed to render'));
      panel.append(node('pre', 'render-error-detail', String((error && error.stack) || error)));
      const actions = node('div', 'render-error-actions');
      actions.append(
        button('Reset view state', 'Clear saved view state and render again', () => {
          uiState = {}; vscode.setState(undefined); deriveUiState(); render();
        }, 'primary'),
        button('Try again', 'Render again without changing anything', () => render(), 'secondary'),
      );
      panel.append(actions);
      app.append(panel);
    }
  }

  function renderView() {
    const saved = captureScroll();
    app.replaceChildren(); const root = node('div', 'root');
    const tabs = node('div', 'tool-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Git tool window');
    const logTab = button('Log', 'Git Log', () => selectToolTab('log'), 'tool-tab' + (activeToolTab === 'log' ? ' active' : ''));
    const consoleTab = button('Console', 'Git Console', () => selectToolTab('console'), 'tool-tab' + (activeToolTab === 'console' ? ' active' : ''));
    const changesTab = button('Local Changes', 'Local Changes', () => selectToolTab('changes'), 'tool-tab' + (activeToolTab === 'changes' ? ' active' : ''));
    changesTab.append(node('span', 'count', String(state.totalChanges || 0)));
    const shelfTab = button('Shelf', 'Shelved Changes', () => selectToolTab('shelf'), 'tool-tab' + (activeToolTab === 'shelf' ? ' active' : ''));
    shelfTab.append(node('span', 'count', String((state.shelves || []).length)));
    for (const [tab, active, id] of [[logTab, activeToolTab === 'log', 'log'], [consoleTab, activeToolTab === 'console', 'console'], [changesTab, activeToolTab === 'changes', 'changes'], [shelfTab, activeToolTab === 'shelf', 'shelf']]) {
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
      tab.dataset.tabId = id; tab.dataset.focusKey = 'tab:' + id;
    }
    tabs.append(logTab, consoleTab, changesTab, shelfTab);
    tabs.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
      const items = [logTab, consoleTab, changesTab, shelfTab]; let index = items.indexOf(document.activeElement);
      if (event.key === 'Home') index = 0; else if (event.key === 'End') index = items.length - 1;
      else index = (index + (event.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length;
      event.preventDefault();
      const target = items[index].dataset.tabId;
      items[index].click();
      // The click re-renders the header, so the old element is already detached.
      requestAnimationFrame(() => document.querySelector('[data-tab-id="' + target + '"]')?.focus());
    });
    root.append(tabs);
    if (activeToolTab === 'console') {
      const consoleBar = node('div', 'console-toolbar');
      const filter = node('select'); filter.setAttribute('aria-label', 'Console filter');
      for (const [value, label] of [['operations', 'User operations'], ['errors', 'Errors only'], ['all', 'All commands']]) {
        const option = node('option', '', label); option.value = value; option.selected = value === consoleFilter; filter.append(option);
      }
      filter.addEventListener('change', () => { consoleFilter = filter.value; saveUiState({ consoleFilter }); render(); });
      const pause = button(consolePaused ? 'Resume scroll' : 'Pause scroll', consolePaused ? 'Resume automatic scrolling' : 'Pause automatic scrolling', () => {
        consolePaused = !consolePaused; saveUiState({ consolePaused }); render();
      }, 'action');
      consoleBar.append(node('span', '', 'Git Console'), selectShell(filter), node('span', 'spacer'), pause, button('Clear', 'Clear Git Console', () => post('clearConsole'), 'action'));
      root.append(consoleBar, consolePanel()); finishRender(root, saved); return;
    }
    if (activeToolTab === 'changes') {
      root.append(changesToolbar(), changesWorkspace()); finishRender(root, saved); return;
    }
    if (activeToolTab === 'shelf') {
      root.append(changesToolbar(), shelfPanel()); finishRender(root, saved); return;
    }
    root.append(toolbar());
    const workspace = node('div', 'workspace'); workspace.id = 'log-workspace';
    if (state.empty) workspace.append(node('div', 'empty', 'Open a folder containing a Git repository.'));
    else workspace.append(branchPane(), columnSplitter('branch'), commitPane(), columnSplitter('details'), detailsPane());
    root.append(workspace); finishRender(root, saved, true);
    if (!state.empty) requestAnimationFrame(() => setupWorkspaceColumns(workspace));
  }

  function repositorySelect() {
    const repositories = node('select'); repositories.title = t('Git root');
    for (const repo of state.repositories || []) {
      // The branch button beside this select already shows the current branch;
      // repeating it in the collapsed control read as two widgets for one fact.
      const option = node('option', '', repo.name);
      option.value = repo.root; option.selected = repo.root === state.selectedRoot; repositories.append(option);
    }
    repositories.addEventListener('change', () => { post('selectRepository', { root: repositories.value }); repositories.blur(); });
    return selectShell(repositories);
  }

  function changesToolbar() {
    const bar = node('div', 'changes-toolbar');
    bar.append(
      repositorySelect(),
      button(state.branch || 'detached HEAD', 'Branches', () => post('runCommand', { command: 'jbGit.branchesPopup' }), 'icon-button'),
      button('Refresh', 'Refresh', () => post('refresh'), 'icon-button'),
    );
    if (activeToolTab === 'changes') {
      bar.append(
        button('+ Changelist', 'New Changelist', () => post('createChangelist'), 'action'),
        button('Shelve', 'Shelve selected changes', () => post('createShelf'), 'action'),
        button('Create Patch…', 'Save the selected changes as a patch file', () => post('createLocalPatch'), 'action'),
      );
    }
    bar.append(node('span', 'spacer'), button('⋮', 'More Git actions', () => post('runCommand', { command: 'jbGit.operationsPopup' })));
    return bar;
  }

  function changesWorkspace() {
    const workspace = node('div', 'changes-workspace');
    const splitter = node('div', 'changes-splitter'); splitter.tabIndex = 0; splitter.setAttribute('role', 'separator'); splitter.setAttribute('aria-label', 'Resize commit editor');
    workspace.append(changesPane(), splitter, commitForm());
    requestAnimationFrame(() => setupChangesSplitter(workspace, splitter));
    return workspace;
  }

  function setupChangesSplitter(workspace, splitter) {
    const compact = () => window.matchMedia('(max-width: 520px)').matches;
    const applySize = requested => {
      if (compact()) {
        const maximum = Math.max(130, workspace.clientHeight - 150 - 9);
        const size = Math.max(130, Math.min(requested, maximum)); workspace.style.setProperty('--commit-height', size + 'px');
        splitter.setAttribute('aria-orientation', 'horizontal'); splitter.setAttribute('aria-valuenow', String(Math.round(size)));
      } else {
        const maximum = Math.max(220, workspace.clientWidth - 220 - 9);
        const size = Math.max(220, Math.min(requested, maximum)); workspace.style.setProperty('--commit-width', size + 'px');
        splitter.setAttribute('aria-orientation', 'vertical'); splitter.setAttribute('aria-valuenow', String(Math.round(size)));
      }
    };
    const applyStored = () => applySize(compact() ? Number(uiState.commitPaneHeight) || 220 : Number(uiState.commitPaneWidth) || 340);
    applyStored();
    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(() => {
        if (!workspace.isConnected) { observer.disconnect(); return; }
        if (!splitter.classList.contains('dragging')) applyStored();
      });
      observer.observe(workspace);
    }
    splitter.addEventListener('pointerdown', event => {
      const resize = move => { const bounds = workspace.getBoundingClientRect(); applySize(compact() ? bounds.bottom - move.clientY : bounds.right - move.clientX); };
      const started = beginDrag(splitter, event, resize, () => {
        splitter.classList.remove('dragging');
        const value = Number(splitter.getAttribute('aria-valuenow'));
        saveUiState(compact() ? { commitPaneHeight: value } : { commitPaneWidth: value });
        flushDeferredState();
      });
      if (!started) return;
      splitter.focus(); splitter.classList.add('dragging'); resize(event);
    });
    splitter.addEventListener('keydown', event => {
      const valid = compact() ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']; if (!valid.includes(event.key)) return;
      event.preventDefault(); const current = Number(splitter.getAttribute('aria-valuenow')) || (compact() ? 220 : 340);
      const grow = event.key === 'ArrowUp' || event.key === 'ArrowLeft'; applySize(current + (grow ? 16 : -16));
    });
  }

  function changesPane() {
    const pane = node('div', 'changes-list'); pane.id = 'changes-list';
    if (state.error) pane.append(node('div', 'error', state.error));
    if (state.operation && state.operation.kind !== 'none') {
      const operation = node('div', 'operation', state.operation.kind.toUpperCase() + ' is in progress');
      const actions = node('div', 'operation-actions');
      if (state.operation.canContinue) actions.append(button('Continue', 'Continue operation', () => post('runCommand', { command: 'jbGit.continueOperation' }), 'small-button'));
      if (state.operation.kind === 'rebase' || state.operation.kind === 'cherry-pick') actions.append(button('Skip', 'Skip current commit', () => post('runCommand', { command: 'jbGit.skipOperation' }), 'small-button'));
      if (state.operation.canAbort) actions.append(button(state.operation.kind === 'bisect' ? 'Reset' : 'Abort', state.operation.kind === 'bisect' ? 'End bisect session' : 'Abort operation', () => post('runCommand', { command: 'jbGit.abortOperation' }), 'small-button'));
      operation.append(actions); pane.append(operation);
    }
    if (state.empty) { pane.append(node('div', 'empty', 'Open a folder containing a Git repository.')); return pane; }
    if (!state.totalChanges) { pane.append(node('div', 'empty', 'No local changes')); return pane; }
    for (const list of state.lists || []) {
      const group = node('section', 'change-group');
      const collapsedByRoot = { ...(uiState.collapsedChangelists || {}) };
      const collapsedLists = new Set(collapsedByRoot[state.selectedRoot || ''] || []); const collapsed = collapsedLists.has(list.id);
      const header = node('div', 'group-header'); header.tabIndex = 0; header.setAttribute('role', 'treeitem'); header.setAttribute('aria-expanded', String(!collapsed));
      header.title = list.description || list.name;
      header.append(
        node('span', 'twisty', collapsed ? '›' : '⌄'),
        button(list.active ? '●' : '○', list.active ? 'Active Changelist' : 'Make active Changelist', event => { event.stopPropagation(); post('setActiveChangelist', { id: list.id }); }, list.active ? 'active-dot row-action' : 'row-action'),
        node('span', '', list.name),
        node('span', 'count', String(list.changes.length)),
      );
      const listActions = node('span', 'changelist-actions');
      listActions.append(button('✎', 'Rename or describe Changelist', event => { event.stopPropagation(); post('editChangelist', { id: list.id }); }, 'row-action'));
      if ((state.lists || []).length > 1) {
        listActions.append(button('×', 'Delete Changelist', event => { event.stopPropagation(); post('deleteChangelist', { id: list.id }); }, 'row-action'));
      }
      header.append(listActions);
      const allSelected = list.changes.length > 0 && list.changes.every(change => change.checked);
      header.append(button(allSelected ? 'Clear Selection' : 'Select All', allSelected ? 'Exclude this Changelist from commit' : 'Include this Changelist in commit', event => {
        event.stopPropagation(); post('toggleAll', { checked: !allSelected, listId: list.id });
        group.querySelectorAll('.change-row input[type="checkbox"]').forEach(box => { box.checked = !allSelected; });
        refreshCommitControls();
      }, 'select-all'));
      const toggle = () => {
        if (collapsedLists.has(list.id)) collapsedLists.delete(list.id); else collapsedLists.add(list.id);
        collapsedByRoot[state.selectedRoot || ''] = [...collapsedLists]; saveUiState({ collapsedChangelists: collapsedByRoot }); render();
      };
      header.addEventListener('click', toggle);
      header.addEventListener('keydown', event => { if (event.target === header && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(); } });
      group.append(header);
      if (!collapsed && list.description) group.append(node('div', 'changelist-description', list.description));
      if (!collapsed) {
        const uncapped = new Set((uiState.uncappedChangelists || {})[state.selectedRoot || ''] || []).has(list.id);
        const shown = uncapped ? list.changes : list.changes.slice(0, changeRowCap);
        for (const change of shown) group.append(changeRow(change));
        const hidden = list.changes.length - shown.length;
        if (hidden > 0) {
          group.append(button(
            isZh ? '显示其余 ' + hidden + ' 个更改' : 'Show ' + hidden + ' more change' + (hidden === 1 ? '' : 's'),
            'Render the rest of this Changelist',
            () => {
              const byRoot = { ...(uiState.uncappedChangelists || {}) };
              const ids = new Set(byRoot[state.selectedRoot || ''] || []); ids.add(list.id);
              byRoot[state.selectedRoot || ''] = [...ids];
              saveUiState({ uncappedChangelists: byRoot }); render();
            },
            'load-more',
          ));
        }
      }
      pane.append(group);
    }
    return pane;
  }

  function changeRow(change) {
    const item = node('div', 'change-item');
    const row = node('div', 'change-row'); row.title = change.path; row.tabIndex = 0; row.setAttribute('role', 'treeitem');
    row.dataset.focusKey = 'change:' + change.path;
    const hunkKey = (state.selectedRoot || '') + '::' + change.path;
    const canExpand = !change.conflicted && change.kind !== 'untracked' && change.kind !== 'ignored' && (change.staged || change.unstaged);
    const expanded = canExpand && expandedChangeHunks.has(hunkKey);
    const expander = button(expanded ? '⌄' : '›', expanded ? 'Hide change hunks' : 'Show change hunks', event => {
      event.stopPropagation();
      if (expandedChangeHunks.has(hunkKey)) {
        expandedChangeHunks.delete(hunkKey);
      } else {
        expandedChangeHunks.add(hunkKey);
        hunkState.set(hunkKey, { loading: true });
        requestHunks(change.path, hunkKey);
      }
      saveUiState({ expandedChangeHunks: [...expandedChangeHunks] }); render();
    }, 'hunk-toggle');
    expander.disabled = !canExpand;
    const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = change.checked; checkbox.title = t('Include in commit');
    checkbox.addEventListener('change', () => { post('togglePath', { path: change.path, checked: checkbox.checked }); refreshCommitControls(); });
    const statusClass = statusClassFor(change.status);
    const file = node('div', 'change-file ' + statusClass); file.append(node('span', 'file-name', change.fileName));
    if (change.directory) file.append(node('span', 'directory', change.directory));
    if (change.staged) file.append(node('span', 'stage-mark', change.unstaged ? 'index + worktree' : 'index'));
    else if (change.unstaged) file.append(node('span', 'stage-mark worktree-mark', 'worktree'));
    // The same file appears under every Changelist that owns part of it, so it
    // has to say that rather than look like two copies of the whole thing.
    if (change.partial) file.append(node('span', 'stage-mark partial-mark', t('some changes')));

    const actions = node('div', 'row-actions');
    const defaultDiffMode = change.unstaged ? 'unstaged' : 'staged';
    if (change.conflicted) {
      actions.append(button('↔', 'Open Merge Conflict Editor', () => post('openDiff', { path: change.path }), 'row-action'));
    } else {
      if (change.staged) actions.append(button('I', 'Show HEAD ↔ Index diff', () => post('openDiff', { path: change.path, mode: 'staged' }), 'row-action state-diff'));
      if (change.unstaged) actions.append(button('W', 'Show Index ↔ Working Tree diff', () => post('openDiff', { path: change.path, mode: 'unstaged' }), 'row-action state-diff'));
    }
    if (change.staged) actions.append(button('−', 'Unstage indexed changes', () => post('unstage', { path: change.path }), 'row-action'));
    if (change.unstaged) actions.append(button('+', 'Stage working-tree changes', () => post('stage', { path: change.path }), 'row-action'));
    actions.append(
      button('⇥', 'Move to Changelist', () => post('moveToChangelist', { path: change.path }), 'row-action'),
      button('↶', 'Rollback', () => post('discard', { path: change.path }), 'row-action'),
    );
    row.append(expander, checkbox, node('span', 'change-status ' + statusClass, change.status), file, actions);
    row.addEventListener('dblclick', event => {
      // Row actions and the checkbox handle their own clicks.
      if (event.target.closest('button, input')) return;
      post('openDiff', { path: change.path, mode: defaultDiffMode });
    });
    row.addEventListener('keydown', event => {
      if (event.target !== row) return;
      if (event.key === 'Enter') { event.preventDefault(); post('openDiff', { path: change.path, mode: defaultDiffMode }); return; }
      // Space toggles inclusion, as in the IntelliJ commit tool window.
      if (event.key === ' ') {
        event.preventDefault();
        checkbox.checked = !checkbox.checked;
        post('togglePath', { path: change.path, checked: checkbox.checked });
        refreshCommitControls();
      }
    });
    const contextItems = [];
    if (change.conflicted) contextItems.push(
      { icon: '↔', label: 'Open Merge Conflict Editor', run: () => post('openDiff', { path: change.path }) },
      { icon: '◧', label: 'Accept Yours', run: () => post('resolveWith', { path: change.path, side: 'ours' }) },
      { icon: '◨', label: 'Accept Theirs', run: () => post('resolveWith', { path: change.path, side: 'theirs' }) },
    );
    else {
      if (change.staged) contextItems.push({ icon: 'I', label: 'Show HEAD ↔ Index Diff', run: () => post('openDiff', { path: change.path, mode: 'staged' }) });
      if (change.unstaged) contextItems.push({ icon: 'W', label: 'Show Index ↔ Working Tree Diff', run: () => post('openDiff', { path: change.path, mode: 'unstaged' }) });
    }
    if (change.staged) contextItems.push({ icon: '−', label: 'Unstage Indexed Changes', run: () => post('unstage', { path: change.path }) });
    if (change.unstaged) contextItems.push({ icon: '+', label: 'Stage Working-tree Changes', run: () => post('stage', { path: change.path }) });
    contextItems.push(
      { icon: '⇥', label: 'Move to Changelist…', run: () => post('moveToChangelist', { path: change.path }) },
      { separator: true },
    );
    if (change.kind === 'untracked') contextItems.push({ icon: '⊘', label: 'Ignore…', run: () => post('ignorePath', { path: change.path }) });
    contextItems.push({ icon: '↶', label: change.kind === 'untracked' ? 'Delete…' : 'Rollback…', run: () => post('discard', { path: change.path }) });
    attachContextMenu(row, contextItems);
    item.append(row);
    if (expanded) item.append(changeHunks(change, hunkKey));
    return item;
  }

  function changeHunks(change, hunkKey) {
    const panel = node('div', 'change-hunks');
    const value = hunkState.get(hunkKey);
    if (!value || value.loading) {
      panel.append(node('div', 'hunk-empty', 'Loading change hunks…'));
      if (!value) {
        hunkState.set(hunkKey, { loading: true });
        queueMicrotask(() => requestHunks(change.path, hunkKey));
      }
      return panel;
    }
    const appendGroup = (title, source, hunks, action) => {
      if (!hunks.length) return;
      const group = node('section', 'hunk-group');
      group.append(node('div', 'hunk-group-title', title + ' · ' + hunks.length));
      hunks.forEach((hunk, index) => {
        const block = node('div', 'hunk-block');
        const header = node('div', 'hunk-header');
        const apply = button(action, action + ' this hunk', () => {
          apply.disabled = true;
          const requestId = nextRequestId(); hunkRequestIds.set(hunkKey, requestId);
          post('applyHunk', { path: change.path, source, index, requestId });
        }, 'small-button');
        header.append(node('code', '', hunk.header), node('span', 'spacer'));
        // Only a working-tree hunk can be rolled back: a staged one is the
        // Index's content, and taking it back is Unstage, not Rollback.
        if (source === 'unstaged') {
          header.append(button('Rollback', 'Rollback this change', () => post('rollbackHunk', { path: change.path, index }), 'small-button'));
        }
        header.append(apply);
        const preview = node('pre', 'hunk-preview');
        const lines = (hunk.lines || []).slice(0, 120);
        for (const line of lines) {
          const part = node('span', line.startsWith('+') ? 'hunk-add' : line.startsWith('-') ? 'hunk-delete' : 'hunk-context', line);
          preview.append(part, document.createTextNode('\n'));
        }
        if ((hunk.lines || []).length > lines.length) preview.append(node('span', 'hunk-context', '…'));
        block.append(header, preview); group.append(block);
      });
      panel.append(group);
    };
    appendGroup('HEAD → Index', 'staged', value.staged || [], 'Unstage');
    appendGroup('Index → Working Tree', 'unstaged', value.unstaged || [], 'Stage');
    appendOwnership(panel, change, value.owned || []);
    if (!(value.staged || []).length && !(value.unstaged || []).length) panel.append(node('div', 'hunk-empty', 'No text hunks available.'));
    return panel;
  }

  /**
   * Which Changelist each change in this file belongs to.
   *
   * Its own group, measured against HEAD, because ownership and staging are
   * different questions: a hunk can be staged and still belong to another
   * Changelist, so re-slicing the staged/unstaged lists would answer neither.
   */
  function appendOwnership(panel, change, owned) {
    if (!owned.length) return;
    const group = node('section', 'hunk-group');
    group.append(node('div', 'hunk-group-title', t('Changelist') + ' · ' + owned.length));
    owned.forEach(entry => {
      const block = node('div', 'hunk-block');
      const header = node('div', 'hunk-header');
      const move = button(t('Move…'), t('Move this change to another Changelist'), () => {
        move.disabled = true;
        const requestId = nextRequestId(); hunkRequestIds.set(hunkKey, requestId);
        post('moveHunk', { path: change.path, key: entry.key, requestId });
      }, 'small-button');
      header.append(
        node('code', '', entry.header),
        node('span', 'hunk-owner', entry.listName),
        node('span', 'spacer'),
        move,
      );
      const preview = node('pre', 'hunk-preview');
      const lines = (entry.lines || []).slice(0, 40);
      for (const line of lines) {
        preview.append(node('span', line.startsWith('+') ? 'hunk-add' : line.startsWith('-') ? 'hunk-delete' : 'hunk-context', line), document.createTextNode('\n'));
      }
      if ((entry.lines || []).length > lines.length) preview.append(node('span', 'hunk-context', '…'));
      block.append(header, preview);
      group.append(block);
    });
    panel.append(group);
  }

  /**
   * Syncs the selected count and Commit buttons with the checkboxes as rendered. The state
   * echo for a toggle is deferred while a menu is open or a drag is running, so without this
   * the controls contradict what the user just clicked.
   */
  function refreshCommitControls() {
    const boxes = [...document.querySelectorAll('#changes-list .change-row input[type="checkbox"]')];
    const selected = boxes.filter(box => box.checked).length;
    state.selectedCount = selected;
    const mode = document.getElementById('commit-mode')?.value || 'files';
    const available = mode === 'staged' ? Number(state.stagedCount || 0) : selected;
    const count = document.getElementById('selected-count');
    if (count) count.textContent = mode === 'staged' ? available + ' indexed files' : selected + ' ' + t('selected');
    const message = document.getElementById('commit-message');
    const disabled = !available || !(message?.value || '').trim();
    for (const id of ['commit-button', 'commit-push-button']) {
      const buttonElement = document.getElementById(id);
      if (buttonElement) buttonElement.disabled = disabled;
    }
  }

  function commitForm() {
    const form = node('div', 'commit-form');
    const title = node('div', 'commit-form-title');
    title.append(
      node('span', '', 'Commit Changes'),
      node('span', 'spacer'),
      button('↺', 'Commit Message History', () => post('messageHistory'), 'row-action'),
    );
    form.append(title);
    const drafts = { ...(uiState.commitMessages || {}) }; const root = state.selectedRoot || '';
    const message = node('textarea', 'commit-message'); message.id = 'commit-message'; message.placeholder = t(state.totalChanges ? 'Commit Message' : 'No changes to commit');
    // IDEA pre-fills the box from commit.template when nothing has been typed;
    // the template is not a draft, so an emptied box shows it again.
    const template = typeof state.commitTemplate === 'string' ? state.commitTemplate : '';
    // The same rule the host applies before committing: with a template, the
    // comment lines are the template's own and Git strips them, so a box
    // holding nothing else is empty as far as the commit is concerned.
    const commentChar = typeof state.commentChar === 'string' && state.commentChar ? state.commentChar : '#';
    message.value = drafts[root] || template; message.disabled = !state.totalChanges;
    const modeRow = node('div', 'commit-mode-row');
    const mode = node('select'); mode.id = 'commit-mode'; mode.setAttribute('aria-label', t('Commit source')); mode.title = t('Commit source');
    const stagedMode = node('option', '', 'Staging area (Index)'); stagedMode.value = 'staged';
    const fileMode = node('option', '', 'Selected files (complete contents)'); fileMode.value = 'files';
    mode.append(stagedMode, fileMode); mode.value = uiState.commitMode === 'staged' ? 'staged' : 'files';
    const modeHelp = node('div', 'commit-mode-help');
    const updateModeHelp = () => {
      modeHelp.textContent = t(mode.value === 'staged'
        ? 'Commits exactly what is in Git Index; working-tree changes stay uncommitted.'
        : 'Commits all changes in each checked file, including its unstaged changes.');
    };
    mode.addEventListener('change', () => { saveUiState({ commitMode: mode.value }); updateModeHelp(); refreshCommitControls(); });
    updateModeHelp(); modeRow.append(selectShell(mode), modeHelp);
    const options = node('div', 'commit-options');
    const amend = checkboxOption('Amend', 'amend', root);
    amend.input.id = 'amend-toggle';
    // IDEA fills the box with the message of the commit being amended, and
    // unchecking gives back what was typed before. The pre-amend draft lives in
    // module state because a background render rebuilds this whole form.
    amend.input.addEventListener('change', () => {
      if (amend.input.checked) {
        preAmendDrafts[root] = message.value;
        pendingHeadRequestId = nextRequestId();
        post('requestHeadMessage', { requestId: pendingHeadRequestId });
      } else if (root in preAmendDrafts) {
        message.value = preAmendDrafts[root];
        delete preAmendDrafts[root];
        message.dispatchEvent(new Event('input'));
      }
    });
    const signoff = checkboxOption('Sign-off', 'signoff', root);
    const noVerify = checkboxOption('Skip hooks', 'noVerify', root);
    const count = node('span', '', ''); count.id = 'selected-count';
    // IDEA's Author field: hidden until asked for, remembered per repository
    // until the commit is made, completing from the recent history's authors.
    const authors = { ...(uiState.commitAuthors || {}) };
    const authorRow = node('div', 'commit-author-row'); authorRow.hidden = !authors[root] && !uiState.authorFieldOpen;
    const authorInput = node('input'); authorInput.id = 'commit-author'; authorInput.type = 'text'; authorInput.setAttribute('list', 'commit-authors');
    authorInput.placeholder = t('Author (Name <email>), leave empty for yourself'); authorInput.value = authors[root] || '';
    authorInput.setAttribute('aria-label', t('Author'));
    const authorList = node('datalist'); authorList.id = 'commit-authors';
    for (const author of state.recentAuthors || []) { const option = node('option'); option.value = author; authorList.append(option); }
    authorInput.addEventListener('input', () => {
      const next = { ...(uiState.commitAuthors || {}) };
      if (authorInput.value.trim()) next[root] = authorInput.value; else delete next[root];
      saveUiState({ commitAuthors: next });
    });
    authorRow.append(node('span', '', 'Author'), authorInput, authorList);
    const authorToggle = button('Author…', 'Commit as another author', () => {
      authorRow.hidden = !authorRow.hidden; saveUiState({ authorFieldOpen: !authorRow.hidden });
      authorToggle.classList.toggle('active', !authorRow.hidden || Boolean(authorInput.value.trim()));
      if (!authorRow.hidden) authorInput.focus();
    }, 'author-toggle' + (!authorRow.hidden || authors[root] ? ' active' : ''));
    options.append(amend.label, signoff.label, noVerify.label, authorToggle, node('span', 'spacer'), count);
    const submit = push => post('commit', { message: message.value, mode: mode.value, amend: amend.input.checked, signoff: signoff.input.checked, noVerify: noVerify.input.checked, push, author: authorInput.value.trim() || undefined });
    const actions = node('div', 'commit-actions');
    const commit = button('Commit', 'Commit selected changes', () => submit(false), 'primary'); commit.id = 'commit-button';
    const commitPush = button('Commit & Push', 'Commit selected changes and push', () => submit(true), 'primary'); commitPush.id = 'commit-push-button';
    // With a template configured, lines starting with # are comments Git will
    // strip, so a box holding only the template is still an empty message.
    const effectivelyEmpty = value => !value.split('\n').some(line => line.trim() && !(template && line.trimStart().startsWith(commentChar)));
    const updateEnabled = () => {
      const available = mode.value === 'staged' ? Number(state.stagedCount || 0) : Number(state.selectedCount || 0);
      const disabled = !available || effectivelyEmpty(message.value); commit.disabled = disabled; commitPush.disabled = disabled;
      count.textContent = mode.value === 'staged' ? available + ' indexed files' : available + ' ' + t('selected');
    };
    message.addEventListener('input', () => { drafts[root] = message.value; saveUiState({ commitMessages: drafts, commitMessage: undefined }); updateEnabled(); });
    mode.addEventListener('change', updateEnabled);
    updateEnabled(); actions.append(commit, commitPush);
    form.append(modeRow, message, options, authorRow, actions); return form;
  }

  function checkboxOption(text, key, root) {
    const persisted = (uiState.commitOptions || {})[root] || {};
    const label = node('label'); const input = node('input'); input.type = 'checkbox'; input.checked = Boolean(persisted[key]);
    input.addEventListener('change', () => {
      // Merge over the live uiState: a render-time snapshot would overwrite
      // whatever the other checkboxes saved since this one was created.
      const options = { ...(uiState.commitOptions || {}) };
      options[root] = { ...(options[root] || {}), [key]: input.checked };
      saveUiState({ commitOptions: options });
    });
    label.append(input, node('span', '', text)); return { label, input };
  }

  function shelfPanel() {
    const pane = node('div', 'shelf-pane'); pane.id = 'shelf-pane';
    const top = node('div', 'group-header');
    top.append(node('span', '', 'Shelved Changes'), node('span', 'spacer'), button('+ Shelve', 'Shelve selected local changes', () => { selectToolTab('changes'); }, 'action'));
    pane.append(top);
    if (!(state.shelves || []).length) { pane.append(node('div', 'empty', 'No shelved changes')); return pane; }
    const expanded = new Set(uiState.expandedShelves || []);
    for (const shelf of state.shelves) {
      const item = node('div', 'shelf-row');
      const open = expanded.has(shelf.id);
      const head = node('div', 'shelf-head'); head.tabIndex = 0; head.setAttribute('role', 'treeitem'); head.setAttribute('aria-expanded', String(open));
      const twisty = node('span', 'twisty', open ? '⌄' : '›');
      const text = node('div', 'shelf-text');
      text.append(node('div', 'shelf-name', shelf.name), node('div', 'shelf-meta', new Date(shelf.createdAt).toLocaleString() + ' · ' + fileCount(shelf.paths.length)));
      head.append(twisty, text);
      const toggle = () => {
        if (expanded.has(shelf.id)) expanded.delete(shelf.id); else expanded.add(shelf.id);
        saveUiState({ expandedShelves: [...expanded] }); render();
      };
      head.addEventListener('click', toggle); keyboardActivate(head, toggle);
      const actions = node('div', 'shelf-actions');
      // IDEA's Unshelve restores and drops the entry; the rest live in the menu.
      actions.append(
        button('Unshelve', 'Restore these changes and remove the shelf', () => post('unshelve', { id: shelf.id }), 'small-button'),
        button('⋮', 'More shelf actions', event => showMenuForElement(event.currentTarget, shelfMenuItems(shelf)), 'row-action'),
      );
      head.append(node('span', 'spacer'), actions);
      item.append(head);
      attachContextMenu(head, () => shelfMenuItems(shelf));
      if (open) {
        const files = node('div', 'shelf-files');
        for (const file of shelf.paths) {
          const row = node('div', 'shelf-file');
          row.append(node('span', 'file-name', file.split('/').pop()), node('span', 'directory', file.split('/').slice(0, -1).join('/')));
          row.title = file;
          files.append(row);
        }
        item.append(files);
      }
      pane.append(item);
    }
    return pane;
  }

  /** IDEA's shelf context menu: restore with or without keeping it, retarget, rename, inspect, delete. */
  function shelfMenuItems(shelf) {
    const lists = state.lists || [];
    return [
      { icon: '↥', label: 'Unshelve', run: () => post('unshelve', { id: shelf.id }) },
      { icon: '⎘', label: 'Unshelve and Keep', run: () => post('unshelve', { id: shelf.id, keep: true }) },
      ...(lists.length > 1
        ? [{
          icon: '⇥',
          label: 'Unshelve into Changelist…',
          run: () => showMenuForElement(document.getElementById('shelf-pane'), lists.map(list => ({
            icon: list.active ? '●' : '○',
            label: list.name,
            run: () => post('unshelve', { id: shelf.id, listId: list.id }),
          }))),
        }]
        : []),
      { separator: true },
      { icon: '↔', label: 'Show Diff', run: () => post('showShelfDiff', { id: shelf.id }) },
      { icon: '✎', label: 'Rename…', run: () => post('renameShelf', { id: shelf.id }) },
      { separator: true },
      { icon: '×', label: 'Delete…', run: () => post('deleteShelf', { id: shelf.id }) },
    ];
  }

  function consolePanel() {
    const output = node('div', 'console'); output.id = 'console-output';
    const traces = (state.traces || []).filter(consoleTraceVisible);
    if (!traces.length) { output.append(node('div', 'empty', consoleFilter === 'operations' ? 'No user Git operations yet. Background refresh commands are hidden.' : 'No matching Git command output.')); return output; }
    for (const trace of traces) output.append(consoleTraceNode(trace));
    if (!consolePaused) requestAnimationFrame(() => { output.scrollTop = output.scrollHeight; });
    return output;
  }

  function consoleTraceVisible(trace) {
    if (consoleFilter === 'all') return true;
    if (consoleFilter === 'errors') return trace.exitCode !== 0;
    return !trace.background || trace.exitCode !== 0;
  }

  function consoleTraceNode(trace) {
    const block = node('details', 'trace'); if (trace.exitCode !== 0) block.open = true;
    const summary = node('summary'); const status = node('span', trace.exitCode === 0 ? 'trace-status-ok' : 'trace-status-error', trace.exitCode === 0 ? '✓' : '!');
    summary.append(status, node('span', 'trace-time', new Date(trace.startedAt).toLocaleTimeString() + ' · ' + trace.durationMs + ' ms'), node('span', 'trace-command', 'git ' + trace.args.join(' ')));
    if (trace.background) summary.append(node('span', 'trace-background', 'background'));
    const detail = node('div', 'trace-output'); detail.append(node('div', 'trace-cwd', trace.cwd));
    if (trace.stdout) detail.append(node('div', '', trace.stdout.slice(0, 4_000).trimEnd()));
    if (trace.stderr) detail.append(node('div', 'trace-error', trace.stderr.slice(0, 4_000).trimEnd()));
    block.append(summary, detail); return block;
  }

  function appendConsoleTrace(trace) {
    if (!consoleTraceVisible(trace)) return;
    const output = document.getElementById('console-output'); if (!output) return;
    const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 36;
    output.querySelector('.empty')?.remove(); output.append(consoleTraceNode(trace));
    if (!consolePaused && nearBottom) output.scrollTop = output.scrollHeight;
  }

  function toolbar() {
    const bar = node('div', 'toolbar');
    const repositories = node('select'); repositories.title = t('Git root');
    for (const repo of state.repositories || []) { const option = node('option', '', repo.name); option.value = repo.root; option.selected = repo.root === state.selectedRoot; repositories.append(option); }
    repositories.addEventListener('change', () => { post('selectRepository', { root: repositories.value }); repositories.blur(); });
    bar.append(
      selectShell(repositories),
      button('Refresh', 'Refresh repository', () => post('refresh'), 'icon-button'),
      button(state.branch || 'detached HEAD', 'Branches', () => post('runCommand', { command: 'jbGit.branchesPopup' }), 'icon-button'),
      node('span', 'spacer'),
      button('More…', 'More Git actions', () => post('runCommand', { command: 'jbGit.operationsPopup' }), 'icon-button'),
    );
    return bar;
  }

  function columnSplitter(side) {
    const splitter = node('div', 'column-splitter'); splitter.dataset.side = side; splitter.tabIndex = 0;
    splitter.setAttribute('role', 'separator'); splitter.setAttribute('aria-orientation', 'vertical');
    splitter.title = side === 'branch' ? 'Drag to resize branches' : 'Drag to resize commit details';
    return splitter;
  }

  function setupWorkspaceColumns(workspace) {
    setColumnWidths(workspace, Number(uiState.branchPaneWidth) || 185, Number(uiState.detailsPaneWidth) || 300, false);
    workspace.querySelectorAll('.column-splitter').forEach(splitter => setupColumnSplitter(workspace, splitter));
    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(() => {
        if (!workspace.isConnected) { observer.disconnect(); return; }
        // Re-clamp the stored preference, not the current width: feeding the clamped value
        // back in made every shrink permanent, so widening never restored the user's size.
        setColumnWidths(workspace, Number(uiState.branchPaneWidth) || 185, Number(uiState.detailsPaneWidth) || 300, false);
      });
      observer.observe(workspace);
    }
  }

  /**
   * Runs a drag that is guaranteed to end. Pointer capture retargets pointermove/pointerup to
   * the handle and always delivers an end event, whereas a window mouseup is never dispatched
   * when the button is released outside the window, leaving the splitter stuck to the cursor.
   */
  function beginDrag(handle, event, onMove, onEnd) {
    if (event.button !== 0) return false;
    event.preventDefault();
    let done = false;
    try { handle.setPointerCapture(event.pointerId); } catch (error) { /* capture is best effort */ }
    const move = moveEvent => onMove(moveEvent);
    const finish = () => {
      if (done) return;
      done = true;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      handle.removeEventListener('lostpointercapture', finish);
      try { handle.releasePointerCapture(event.pointerId); } catch (error) { /* already released */ }
      onEnd();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    return true;
  }

  function setupColumnSplitter(workspace, splitter) {
    const side = splitter.dataset.side;
    const resize = event => {
      const bounds = workspace.getBoundingClientRect();
      const requested = side === 'branch' ? event.clientX - bounds.left : bounds.right - event.clientX;
      const left = side === 'branch' ? requested : readColumnWidth(workspace, 'branch');
      const right = side === 'details' ? requested : readColumnWidth(workspace, 'details');
      setColumnWidths(workspace, left, right, false);
    };
    splitter.addEventListener('pointerdown', event => {
      const started = beginDrag(splitter, event, resize, () => {
        splitter.classList.remove('dragging'); persistColumnWidths(workspace);
        flushDeferredState();
      });
      if (!started) return;
      splitter.focus(); splitter.classList.add('dragging'); resize(event);
    });
    splitter.addEventListener('dblclick', () => {
      setColumnWidths(workspace, side === 'branch' ? 185 : readColumnWidth(workspace, 'branch'), side === 'details' ? 300 : readColumnWidth(workspace, 'details'), true);
    });
    splitter.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault(); const delta = event.key === 'ArrowRight' ? 16 : -16;
      const left = readColumnWidth(workspace, 'branch') + (side === 'branch' ? delta : 0);
      const right = readColumnWidth(workspace, 'details') + (side === 'details' ? -delta : 0);
      setColumnWidths(workspace, left, right, true);
    });
  }

  function readColumnWidth(workspace, side) {
    const property = side === 'branch' ? '--branch-width' : '--details-width';
    return parseFloat(getComputedStyle(workspace).getPropertyValue(property)) || (side === 'branch' ? 185 : 300);
  }

  function setColumnWidths(workspace, requestedLeft, requestedRight, persist) {
    const total = workspace.clientWidth || window.innerWidth;
    const compact = total < 650; const tiny = total < 470;
    workspace.classList.toggle('compact', compact); workspace.classList.toggle('tiny', tiny);
    const leftMinimum = 125; const rightMinimum = 190; const centerMinimum = 260; const gutters = compact ? 9 : 18;
    const maximumSides = Math.max(leftMinimum + rightMinimum, total - gutters - centerMinimum);
    let left = Math.max(leftMinimum, requestedLeft || 185);
    let right = Math.max(rightMinimum, requestedRight || 300);
    if (compact) right = Math.min(right, Math.max(rightMinimum, total - gutters - centerMinimum));
    else {
      if (left + right > maximumSides) {
        const overflow = left + right - maximumSides;
        const shrinkRight = Math.min(overflow, Math.max(0, right - rightMinimum)); right -= shrinkRight;
        left = Math.max(leftMinimum, left - (overflow - shrinkRight));
      }
      left = Math.min(left, Math.max(leftMinimum, maximumSides - rightMinimum));
      right = Math.min(right, Math.max(rightMinimum, maximumSides - left));
    }
    workspace.style.setProperty('--branch-width', Math.round(left) + 'px');
    workspace.style.setProperty('--details-width', Math.round(right) + 'px');
    const leftSplitter = workspace.querySelector('.column-splitter[data-side="branch"]');
    const rightSplitter = workspace.querySelector('.column-splitter[data-side="details"]');
    if (leftSplitter) { leftSplitter.setAttribute('aria-valuemin', String(leftMinimum)); leftSplitter.setAttribute('aria-valuemax', String(Math.max(leftMinimum, compact ? total - gutters - centerMinimum : maximumSides - rightMinimum))); leftSplitter.setAttribute('aria-valuenow', String(Math.round(left))); }
    if (rightSplitter) { rightSplitter.setAttribute('aria-valuemin', String(rightMinimum)); rightSplitter.setAttribute('aria-valuemax', String(Math.max(rightMinimum, maximumSides - leftMinimum))); rightSplitter.setAttribute('aria-valuenow', String(Math.round(right))); }
    if (persist) persistColumnWidths(workspace);
  }

  function persistColumnWidths(workspace) {
    saveUiState({ branchPaneWidth: Math.round(readColumnWidth(workspace, 'branch')), detailsPaneWidth: Math.round(readColumnWidth(workspace, 'details')) });
  }

  const branchKey = branch => JSON.stringify([branch.kind, branch.name]);
  const selectedBranches = () => (state.branches || []).filter(branch => selectedBranchKeys.has(branchKey(branch)));
  function setBranchSelection(branches) {
    selectedBranchKeys = new Set(branches.map(branchKey));
    saveUiState({ selectedBranchKeys: [...selectedBranchKeys] });
    document.querySelectorAll('.branch-row[data-branch-key]').forEach(row => {
      const active = selectedBranchKeys.has(row.dataset.branchKey);
      row.classList.toggle('selected', active); row.setAttribute('aria-selected', String(active));
    });
    const allRow = document.querySelector('.branch-row[data-branch-all]');
    if (allRow) allRow.classList.toggle('active', !selectedBranchKeys.size);
  }

  const isFavoriteBranch = branch => new Set(state.favoriteBranches || []).has(branch.kind + ':' + branch.name);

  function branchContextItems(branch) {
    if (!selectedBranchKeys.has(branchKey(branch))) setBranchSelection([branch]);
    const selected = selectedBranches();
    if (selected.length > 1) {
      const descriptors = selected.map(item => ({ name: item.name, kind: item.kind }));
      const deletable = selected.some(item => item.kind === 'local' && item.name !== state.branch);
      return [
        { icon: '↔', label: 'Compare Branches', disabled: selected.length !== 2, run: () => post('contextAction', { action: 'compareBranches', branches: descriptors }) },
        { icon: '⇄', label: 'Show Files Diff', disabled: selected.length !== 2, run: () => post('contextAction', { action: 'showBranchesDiff', branches: descriptors }) },
        { separator: true },
        { icon: '×', label: 'Delete Selected Branches…', disabled: !deletable, run: () => post('contextAction', { action: 'deleteBranches', branches: descriptors }) },
      ];
    }
    const kind = branch.kind;
    const current = state.branch;
    const isCurrent = kind === 'local' && branch.name === current;
    const into = current ? "'" + current + "'" : 'current branch';
    const act = action => () => post('contextAction', { action, ref: branch.name, kind: branch.kind });
    const items = [
      { icon: '✓', label: 'Checkout', disabled: isCurrent, run: () => post('checkout', { name: branch.name, kind: branch.kind }) },
      { icon: '+', label: "New Branch from '" + branch.name + "'…", run: act('newBranchFromRef') },
      { separator: true },
    ];
    if (kind === 'local') items.push({ icon: '↑', label: isCurrent ? 'Push…' : "Push '" + branch.name + "'…", run: act('pushRef') });
    // IDEA's per-branch Update: fast-forward it from its upstream without
    // checking it out; on the current branch that is a pull.
    if (kind === 'local' && branch.upstream && !branch.upstreamGone) {
      items.push({ icon: '⟳', label: isCurrent ? 'Update Project…' : "Update '" + branch.name + "'", run: act('updateRef') });
    }
    if (kind !== 'tag') {
      items.push({ icon: isFavoriteBranch(branch) ? '★' : '☆', label: isFavoriteBranch(branch) ? 'Remove from Favorites' : 'Add to Favorites', run: () => post('toggleFavoriteBranch', { name: branch.name, kind: branch.kind }) });
    }
    if (kind === 'remote') items.push(
      { icon: '↓', label: 'Fetch', run: act('fetchRef') },
      { icon: '⇓', label: 'Pull into ' + into + ' using Merge', disabled: !current, run: act('pullRefMerge') },
      { icon: '⇓', label: 'Pull into ' + into + ' using Rebase', disabled: !current, run: act('pullRefRebase') },
    );
    // Merging or rebasing the checked-out branch onto itself is meaningless, so leave it out
    // entirely instead of showing a disabled self-referencing entry.
    if (!isCurrent && kind !== 'tag') items.push(
      { icon: '⇤', label: 'Merge ' + branch.name + ' into ' + into, disabled: !current, run: act('mergeRef') },
      { icon: '⇧', label: 'Rebase ' + into + ' onto ' + branch.name, disabled: !current, run: act('rebaseOntoRef') },
      { icon: '⇪', label: 'Checkout ' + branch.name + ' and Rebase onto ' + into, disabled: !current, run: act('checkoutAndRebase') },
    );
    items.push(
      { separator: true },
      { icon: '↔', label: 'Show Diff with Working Tree', run: act('showRefDiff') },
      { icon: '◇', label: "New Tag at '" + branch.name + "'…", run: act('tagFromRef') },
      { icon: '▣', label: "New Worktree from '" + branch.name + "'…", run: act('createWorktreeFromRef') },
      { icon: '⧉', label: kind === 'tag' ? 'Copy Tag Name' : 'Copy Branch Name', run: act('copyBranch') },
      { separator: true },
    );
    if (kind === 'tag') items.push({ icon: '×', label: 'Delete Tag…', run: act('deleteTag') });
    else items.push(
      { icon: '✎', label: 'Rename…', disabled: kind !== 'local', run: act('renameBranch') },
      { icon: '×', label: 'Delete…', disabled: kind !== 'local' || isCurrent, run: act('deleteBranch') },
    );
    return items;
  }

  function branchPane() {
    const pane = node('aside', 'pane branches'); pane.id = 'branch-pane'; pane.setAttribute('role', 'listbox'); pane.setAttribute('aria-label', 'Branches'); pane.setAttribute('aria-multiselectable', 'true');
    const title = node('div', 'pane-title'); title.append(node('span', '', 'Branches'), node('span', 'spacer'));
    title.append(
      button('↓', 'Fetch all remotes', () => post('runCommand', { command: 'jbGit.fetch' }), 'pane-action'),
      button('⇓', 'Pull into the current branch', () => post('runCommand', { command: 'jbGit.pull' }), 'pane-action'),
      button('↑', 'Push the current branch', () => post('runCommand', { command: 'jbGit.push' }), 'pane-action'),
      button('+', 'New branch', () => post('runCommand', { command: 'jbGit.createBranch' }), 'pane-action'),
      button('⋮', 'More Git actions', () => post('runCommand', { command: 'jbGit.operationsPopup' }), 'pane-action'),
    );
    pane.append(title);
    const filter = node('input', 'branch-filter'); filter.id = 'branch-filter'; filter.type = 'search'; filter.placeholder = t('Filter branches'); filter.value = branchFilter;
    filter.setAttribute('aria-label', t('Filter branches, remotes and tags by name'));
    filter.addEventListener('input', () => { branchFilter = filter.value; saveUiState({ branchFilter }); refreshBranchPane(); });
    pane.append(filter);
    const needle = branchFilter.trim().toLowerCase();
    const matches = branch => !needle || branch.name.toLowerCase().includes(needle);
    const all = button('All', 'Show all branches', () => { setBranchSelection([]); post('selectRef', {}); }, 'branch-row' + (!state.selectedRef && !selectedBranchKeys.size ? ' active' : ''));
    all.dataset.branchAll = '1';
    pane.append(all);

    const favorites = new Set(state.favoriteBranches || []);
    const isFavorite = branch => favorites.has(branch.kind + ':' + branch.name);
    // A row can appear in more than one group (Recent, Favorites, Local), so
    // the roving-focus key has to say which group it is in, or the two copies
    // would collide on the same data-branch-key.
    const branchRow = (branch, group) => {
      const key = branchKey(branch); const selected = selectedBranchKeys.has(key);
      const row = button(branch.name, 'Filter by ' + branch.name + ' (Command/Ctrl-click to select multiple)', event => {
        if (event.metaKey || event.ctrlKey) {
          const next = new Set(selectedBranchKeys); if (next.has(key)) next.delete(key); else next.add(key);
          selectedBranchKeys = next; setBranchSelection(selectedBranches()); return;
        }
        setBranchSelection([branch]); post('selectRef', { ref: branch.name });
      }, 'branch-row' + (selected ? ' selected' : '') + (branch.kind === 'local' && branch.name === state.branch ? ' current' : ''));
      row.dataset.branchKey = key; row.dataset.focusKey = 'branch:' + group + ':' + key;
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(selected));
      // IDEA's incoming/outgoing markers: what a fetch brought in (↓) and
      // what a push would send (↑), right-aligned on the row.
      if (branch.kind === 'local' && (branch.ahead || branch.behind || branch.upstreamGone)) {
        const track = node('span', 'branch-track');
        if (branch.upstreamGone) {
          const gone = node('span', 'track-gone', 'gone');
          gone.title = t('The upstream branch no longer exists');
          track.append(gone);
        } else {
          if (branch.behind) {
            const incoming = node('span', 'track-in', '↓' + branch.behind);
            incoming.title = t('Incoming commits: fetched but not merged');
            track.append(incoming);
          }
          if (branch.ahead) {
            const outgoing = node('span', 'track-out', '↑' + branch.ahead);
            outgoing.title = t('Outgoing commits: not pushed yet');
            track.append(outgoing);
          }
        }
        row.append(track);
      }
      if (branch.kind !== 'tag') {
        // A span, not a button: a button inside a button is invalid markup and
        // the browser would take the click away from the row entirely.
        const starred = isFavorite(branch);
        const star = node('span', 'branch-star' + (starred ? ' on' : ''), starred ? '★' : '☆');
        star.title = t(starred ? 'Remove from Favorites' : 'Add to Favorites');
        star.setAttribute('role', 'button');
        star.setAttribute('aria-label', t(starred ? 'Remove from Favorites' : 'Add to Favorites'));
        star.addEventListener('click', event => {
          event.stopPropagation(); event.preventDefault();
          post('toggleFavoriteBranch', { name: branch.name, kind: branch.kind });
        });
        row.append(star);
      }
      row.addEventListener('dblclick', () => post('checkout', { name: branch.name, kind: branch.kind }));
      attachContextMenu(row, () => branchContextItems(branch));
      return row;
    };
    const appendSection = (label, branches, group) => {
      if (!branches.length) return;
      const section = node('section', 'branch-section'); section.append(node('div', 'section-title', label));
      for (const branch of branches) section.append(branchRow(branch, group));
      pane.append(section);
    };

    // IDEA's groups: recently checked out, then starred, then everything.
    const local = (state.branches || []).filter(item => item.kind === 'local');
    const recent = (state.recentBranches || [])
      .map(name => local.find(item => item.name === name))
      .filter(item => item && matches(item));
    appendSection('Recent', recent, 'recent');
    appendSection('Favorites', (state.branches || []).filter(item => item.kind !== 'tag' && isFavorite(item) && matches(item)), 'favorite');
    let shown = 0;
    for (const [kind, label] of [['local','Local'], ['remote','Remote'], ['tag','Tags']]) {
      const visible = (state.branches || []).filter(item => item.kind === kind && matches(item));
      if (!visible.length) continue;
      shown += visible.length;
      appendSection(label, visible, kind);
    }
    if (!shown && needle) pane.append(node('div', 'empty', 'No branch matches the filter'));
    requestAnimationFrame(() => setupRovingRows(pane, '.branch-row'));
    return pane;
  }

  /** Re-renders only the branch column so typing in its filter cannot disturb the rest of the layout. */
  function refreshBranchPane() {
    const existing = document.getElementById('branch-pane');
    if (!existing) return;
    const replacement = branchPane();
    existing.replaceWith(replacement);
    const input = replacement.querySelector('.branch-filter');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }

  function setupRovingRows(container, selector) {
    const rows = [...container.querySelectorAll(selector)]; if (!rows.length) return;
    const initial = rows.find(row => row.classList.contains('active') || row.classList.contains('selected')) || rows[0];
    rows.forEach(row => { row.tabIndex = row === initial ? 0 : -1; row.addEventListener('keydown', event => {
      let index = rows.indexOf(row);
      if (event.key === 'ArrowDown') index = Math.min(rows.length - 1, index + 1);
      else if (event.key === 'ArrowUp') index = Math.max(0, index - 1);
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = rows.length - 1;
      else return;
      event.preventDefault(); rows.forEach(item => { item.tabIndex = -1; }); rows[index].tabIndex = 0; rows[index].focus();
    }); });
  }

  function commitPane() {
    const pane = node('main', 'pane commit-pane');
    pane.append(commitFilterBar());
    const head = node('div', 'table-head'); head.append(node('span', '', 'Commit'), node('span', '', 'Author'), node('span', '', 'Date'), node('span', '', 'Hash'));
    const scroll = node('div', 'commit-scroll'); scroll.id = 'commit-scroll';
    const list = node('div', 'commit-list'); list.id = 'commit-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Git commits');
    scroll.addEventListener('scroll', () => {
      // Ignore the event caused by our own scroll assignment; matching on the position keeps
      // this self-healing when no event is delivered at all.
      if (expectedScrollTop !== undefined && Math.abs(scroll.scrollTop - expectedScrollTop) < 1) { expectedScrollTop = undefined; return; }
      expectedScrollTop = undefined;
      if (virtualCommits.length <= virtualThreshold || virtualRenderFrame) return;
      virtualRenderFrame = requestAnimationFrame(() => { virtualRenderFrame = undefined; renderCommitWindow(list); });
    });
    scroll.append(head, list); pane.append(scroll); renderCommitRows(list); return pane;
  }

  function filterButton(label, value, title, active, items) {
    const buttonElement = button('', title, () => showMenuForElement(buttonElement, typeof items === 'function' ? items() : items), 'filter-button' + (active ? ' active' : ''));
    buttonElement.append(node('span', '', label), node('span', 'filter-value', value ? ': ' + value : ''), node('span', '', '⌄'));
    return buttonElement;
  }

  function commitFilterBar() {
    const bar = node('div', 'commit-filters');
    const deepActive = Boolean(state.logSearch);
    const input = node('input', 'commit-search' + (deepActive ? ' deep-active' : '')); input.id = 'commit-search'; input.type = 'search';
    input.placeholder = t(deepActive ? 'Searching all history' : 'Filter loaded commits · Enter searches all history');
    input.value = deepActive ? state.logSearch : search;
    input.setAttribute('aria-label', t('Filter the loaded commits by text or hash'));
    const loadedCount = String(state.logLimit || (state.commits || []).length);
    input.title = deepActive
      ? (isZh ? '正在于整个历史中搜索：' + state.logSearch : 'Searching the whole history for: ' + state.logSearch)
      : (isZh ? '筛选当前已加载的 ' + loadedCount + ' 个提交；按 Enter 在整个历史中搜索' : 'Filters the ' + loadedCount + ' commits currently loaded; press Enter to search all history');
    input.addEventListener('input', () => {
      search = input.value; saveUiState({ search });
      // The native ✕ (or emptying the box) also ends an active whole-history
      // search, so one control clears both layers.
      if (!input.value && state.logSearch) { post('deepSearch', { text: '' }); return; }
      renderCommitRows(); refreshDetailsForFilter();
    });
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const text = input.value.trim();
      // Git applies the search over the whole walk, so the loaded-window
      // filter would only hide rows the search already matched.
      search = ''; saveUiState({ search });
      post('deepSearch', { text });
    });
    const branch = filterButton('Branch', state.selectedRef ? shortRef(state.selectedRef) : '', 'Filter by branch', Boolean(state.selectedRef), branchFilterItems);
    const user = filterButton('User', authorFilter, 'Filter by author', Boolean(authorFilter), userFilterItems);
    const dateLabels = { all: '', today: 'Today', week: '7 days', month: '30 days', year: '1 year' };
    const date = filterButton('Date', dateLabels[dateFilter] || '', 'Filter by date', dateFilter !== 'all', dateFilterItems);
    const pathValue = state.filePath ? compactPath(state.filePath) : '';
    const paths = button('', 'Filter by changed path', () => showPathFilterPopover(paths), 'filter-button' + (state.filePath ? ' active' : ''));
    paths.append(node('span', '', 'Paths'), node('span', 'filter-value', pathValue ? ': ' + pathValue : ''), node('span', '', '⌄'));
    const sort = button('⇵', 'Graph and sort options', () => showMenuForElement(sort, graphOptionItems()), 'filter-button sort-button' + ((firstParent || noMerges || sortMode === 'topological') ? ' active' : ''));
    bar.append(input, branch, user, date, paths);
    if (state.lineRange && state.filePath) {
      // IDEA's History for Selection: the walk is narrowed to the lines shown
      // here, and the × widens it back to the whole file.
      const range = state.lineRange.start === state.lineRange.end ? String(state.lineRange.start) : state.lineRange.start + '–' + state.lineRange.end;
      const lines = button('', 'Only commits that changed these lines; click to show the whole file', () => post('clearLineRange'), 'filter-button active line-range-filter');
      lines.append(node('span', '', 'Lines'), node('span', 'filter-value', ': ' + range), node('span', '', '×'));
      bar.append(lines);
    }
    bar.append(sort); return bar;
  }

  function graphOptionItems() {
    return [
      { heading: 'Sort' },
      { icon: sortMode === 'date' ? '✓' : '', label: 'By Commit Date', run: () => setLogOptions({ order: 'date' }) },
      { icon: sortMode === 'topological' ? '✓' : '', label: 'Topologically', run: () => setLogOptions({ order: 'topological' }) },
      { separator: true },
      { heading: 'Options' },
      { icon: firstParent ? '✓' : '', label: 'First Parent', run: () => setLogOptions({ firstParent: !firstParent }) },
      { icon: noMerges ? '✓' : '', label: 'No Merges', run: () => setLogOptions({ noMerges: !noMerges }) },
      { separator: true },
      { heading: 'Branch Actions' },
      { icon: '', label: 'Collapse Linear Branches', disabled: !currentGraphFragments.size, run: collapseLinearBranches },
      { icon: '', label: 'Expand Linear Branches', disabled: !collapsedGraphSeries.size, run: expandLinearBranches },
    ];
  }

  function setLogOptions(update) {
    if (update.order) sortMode = update.order;
    if (Object.prototype.hasOwnProperty.call(update, 'firstParent')) firstParent = Boolean(update.firstParent);
    if (Object.prototype.hasOwnProperty.call(update, 'noMerges')) noMerges = Boolean(update.noMerges);
    if (Object.prototype.hasOwnProperty.call(update, 'author')) authorFilter = update.author || '';
    collapsedGraphSeries.clear(); selectedGraphSeries = ''; hoveredGraphSeries = '';
    saveUiState({ sortMode, firstParent, noMerges, collapsedGraphSeries: [], selectedGraphSeries: '' });
    post('setLogOptions', { options: { order: sortMode, firstParent, noMerges, author: authorFilter || undefined, since: dateCutoff(dateFilter) } });
  }

  function collapseLinearBranches() {
    collapsedGraphSeries = new Set(currentGraphFragments.keys()); selectedGraphSeries = ''; hoveredGraphSeries = '';
    saveUiState({ collapsedGraphSeries: [...collapsedGraphSeries], selectedGraphSeries: '' }); renderCommitRows();
  }

  function expandLinearBranches() {
    collapsedGraphSeries.clear(); selectedGraphSeries = ''; hoveredGraphSeries = '';
    saveUiState({ collapsedGraphSeries: [], selectedGraphSeries: '' }); renderCommitRows();
  }

  function branchFilterItems() {
    const items = [{ icon: state.selectedRef ? '' : '✓', label: 'All Branches', run: () => { setBranchSelection([]); post('selectRef', {}); } }];
    for (const kind of ['local', 'remote', 'tag']) {
      const branches = (state.branches || []).filter(branch => branch.kind === kind);
      if (!branches.length) continue;
      items.push({ separator: true });
      for (const branch of branches) items.push({
        icon: state.selectedRef === branch.name ? '✓' : kind === 'local' ? '⑂' : kind === 'remote' ? '☁' : '◆',
        label: branch.name,
        run: () => { setBranchSelection([branch]); post('selectRef', { ref: branch.name }); },
      });
    }
    return items;
  }

  function userFilterItems() {
    const authors = [...new Set([...knownAuthors, ...(state.commits || []).map(commit => commit.author).filter(Boolean)])].sort((left, right) => left.localeCompare(right));
    return [
      { icon: authorFilter ? '' : '✓', label: 'All Users', run: () => setAuthorFilter('') },
      { separator: true },
      ...authors.map(author => ({ icon: authorFilter === author ? '✓' : '', label: author, run: () => setAuthorFilter(author) })),
    ];
  }

  function setAuthorFilter(author) {
    authorFilter = author; saveUiState({ authorFilter }); render(); setLogOptions({ author });
  }

  function dateCutoff(value) {
    if (value === 'all') return undefined;
    const now = new Date();
    if (value === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    return new Date(now.getTime() - ({ week: 7, month: 30, year: 365 }[value] || 0) * 86400000).toISOString();
  }

  function dateFilterItems() {
    return [
      ['all', 'All Dates'], ['today', 'Today'], ['week', 'Last 7 Days'], ['month', 'Last 30 Days'], ['year', 'Last Year'],
    ].map(([value, label]) => ({ icon: dateFilter === value ? '✓' : '', label, run: () => {
      dateFilter = value; saveUiState({ dateFilter }); render(); setLogOptions({ since: dateCutoff(value) });
    } }));
  }

  function showPathFilterPopover(anchor) {
    closeContextMenu();
    menuInvoker = anchor;
    const popover = node('form', 'filter-popover');
    popover.append(node('div', 'filter-popover-title', 'Show commits affecting this path'));
    const input = node('input'); input.type = 'text'; input.placeholder = t('src/path or file name'); input.value = state.filePath || '';
    const actions = node('div', 'filter-popover-actions');
    const clear = button('Clear', 'Clear path filter', () => { closeContextMenu(); post('setPathFilter', {}); }, 'action');
    clear.disabled = !state.filePath;
    const apply = button('Apply', 'Apply path filter', () => {}, 'primary'); apply.type = 'submit';
    actions.append(clear, apply); popover.append(input, actions);
    popover.addEventListener('submit', event => { event.preventDefault(); closeContextMenu(); post('setPathFilter', { path: input.value.trim() }); });
    document.body.append(popover); openMenu = popover;
    const bounds = anchor.getBoundingClientRect(); const popupBounds = popover.getBoundingClientRect();
    popover.style.left = Math.max(6, Math.min(bounds.left, window.innerWidth - popupBounds.width - 6)) + 'px';
    popover.style.top = Math.max(6, Math.min(bounds.bottom + 2, window.innerHeight - popupBounds.height - 6)) + 'px';
    input.focus(); input.select();
  }

  function compactPath(value) {
    if (value.length <= 24) return value;
    return '…/' + value.split('/').slice(-2).join('/');
  }

  function renderCommitRows(existing) {
    const list = existing || document.getElementById('commit-list'); if (!list) return;
    const model = graphModel(filteredCommits()); const commits = model.commits; const graph = graphLayout(commits, model);
    virtualCommits = commits; virtualGraph = graph;
    if (multiSelectedHashes.size) {
      // A filter or reload can drop selected commits out of the list; the
      // selection follows what is actually shown rather than acting on ghosts.
      const live = new Set(commits.map(commit => commit.hash));
      multiSelectedHashes = new Set([...multiSelectedHashes].filter(hash => live.has(hash)));
    }
    currentGraphFragments = model.fragments;
    for (const id of [...collapsedGraphSeries]) if (!currentGraphFragments.has(id)) collapsedGraphSeries.delete(id);
    if (selectedGraphSeries) {
      const liveSeries = new Set();
      for (const entry of graph) {
        liveSeries.add(entry.nodeSeriesId);
        for (const segment of graphSegments(entry)) liveSeries.add(segment.seriesId);
      }
      if (!liveSeries.has(selectedGraphSeries)) { selectedGraphSeries = ''; saveUiState({ selectedGraphSeries: '' }); }
    }
    const currentHash = pendingCommitHash || state.selection?.commit?.hash;
    if (commits.length && !commits.some(commit => commit.hash === currentHash)) {
      pendingCommitHash = commits[0].hash; requestCommitSelection(pendingCommitHash);
    }
    if (!commits.length) {
      pendingCommitHash = undefined;
      list.replaceChildren();
      const loaded = String(state.logLimit || (state.commits || []).length);
      list.append(node('div', 'empty', isZh ? '已加载的 ' + loaded + ' 个提交中没有匹配项。' : 'No match in the ' + loaded + ' loaded commits.'));
      if (state.hasMoreCommits) list.append(button('Load 300 more commits', 'Load older history', () => post('loadMore'), 'load-more'));
      return;
    }
    renderCommitWindow(list);
  }

  function renderCommitWindow(existing, scrollTopOverride) {
    const list = existing || document.getElementById('commit-list'); if (!list || !virtualCommits.length) return;
    const scroll = list.parentElement;
    const virtual = virtualCommits.length > virtualThreshold;
    const visibleHeight = Math.max(270, scroll?.clientHeight || 600);
    const offset = scrollTopOverride === undefined ? (scroll?.scrollTop || 0) : scrollTopOverride;
    const first = virtual ? Math.max(0, Math.floor(Math.max(0, offset - commitRowHeight) / commitRowHeight) - 18) : 0;
    const last = virtual ? Math.min(virtualCommits.length, first + Math.ceil(visibleHeight / commitRowHeight) + 36) : virtualCommits.length;
    const currentHash = pendingCommitHash || state.selection?.commit?.hash;
    list.replaceChildren();
    if (first) {
      const spacer = node('div', 'virtual-spacer'); spacer.style.height = String(first * commitRowHeight) + 'px'; spacer.setAttribute('role', 'presentation'); list.append(spacer);
    }
    for (let index = first; index < last; index += 1) {
      const commit = virtualCommits[index];
      const selected = multiSelectedHashes.size
        ? multiSelectedHashes.has(commit.hash)
        : (pendingCommitHash || state.selection?.commit.hash) === commit.hash;
      const row = node('div', 'commit-row' + (selected ? ' selected' : '')); row.dataset.hash = commit.hash;
      row.dataset.index = String(index); row.setAttribute('aria-posinset', String(index + 1)); row.setAttribute('aria-setsize', String(virtualCommits.length));
      row.tabIndex = selected || (!currentHash && index === 0) ? 0 : -1; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(selected));
      row.setAttribute('aria-label', (commit.subject || 'No subject') + ', ' + commit.author + ', ' + formatDate(commit.authoredAt) + ', ' + commit.hash.slice(0, 8));
      const subject = node('div', 'subject-cell'); const canvas = node('canvas', 'graph-interactive'); canvas.width = 144; canvas.height = 54; canvas.dataset.graph = JSON.stringify(virtualGraph[index]); canvas.title = t('Click a graph line to select or collapse its series'); canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Commit graph lane ' + String(virtualGraph[index].lane + 1)); attachGraphInteraction(canvas); subject.append(canvas);
      const ordered = orderedRefs(commit.refs);
      const refs = node('div', 'refs'); for (const ref of ordered.slice(0, 2)) refs.append(refChip(ref));
      if (ordered.length > 2) { const more = node('span', 'ref', '+' + String(ordered.length - 2)); more.title = ordered.slice(2).map(shortRef).join('\n'); refs.append(more); }
      subject.append(refs, node('span', 'subject', commit.subject || '(no subject)'));
      row.append(subject, node('div', '', commit.author), node('div', 'muted', formatDate(commit.authoredAt)), node('div', 'muted', commit.hash.slice(0, 8)));
      const select = () => {
        pendingCommitHash = commit.hash;
        multiSelectedHashes = new Set(); commitSelectionAnchor = commit.hash;
        document.querySelectorAll('.commit-row').forEach(item => {
          const active = item.dataset.hash === pendingCommitHash;
          item.classList.toggle('selected', active); item.setAttribute('aria-selected', String(active));
        });
        requestCommitSelection(commit.hash);
      };
      row.addEventListener('click', event => {
        if (event.ctrlKey || event.metaKey) return toggleCommitInSelection(commit.hash);
        if (event.shiftKey) return extendCommitSelection(commit.hash);
        select();
      });
      keyboardActivate(row, select);
      row.addEventListener('keydown', event => navigateCommitRows(event, row));
      row.addEventListener('dblclick', () => post('showPatch', { hash: commit.hash }));
      attachContextMenu(row, () => {
        if (multiSelectedHashes.size > 1 && multiSelectedHashes.has(commit.hash)) {
          // The host re-orders by its own log, so the set can be sent as-is.
          const hashes = [...multiSelectedHashes];
          return [
            { icon: '⌘', label: 'Cherry-Pick Selected', run: () => post('commitsAction', { action: 'cherryPickCommits', hashes }) },
            { icon: '↔', label: 'Compare Versions', disabled: hashes.length !== 2, run: () => post('commitsAction', { action: 'compareCommits', hashes }) },
            { separator: true },
            { icon: '⇊', label: 'Squash Selected…', run: () => post('commitsAction', { action: 'squashCommits', hashes }) },
            { icon: '✕', label: 'Drop Selected…', run: () => post('commitsAction', { action: 'dropCommits', hashes }) },
          ];
        }
        const parent = commit.parents?.[0];
        const child = (state.commits || []).find(item => (item.parents || []).includes(commit.hash));
        // Git decorates the checked-out commit as 'HEAD' or 'HEAD -> branch'.
        const isHead = (commit.refs || []).some(ref => ref === 'HEAD' || ref.startsWith('HEAD -> '));
        select();
        return [
          { icon: '⧉', label: 'Copy Revision Number', run: () => post('contextAction', { action: 'copyRevision', hash: commit.hash }) },
          { icon: '+', label: 'Create Patch…', run: () => post('contextAction', { action: 'createPatch', hash: commit.hash }) },
          { icon: '⌘', label: 'Cherry-Pick', run: () => post('cherryPick', { hash: commit.hash }) },
          { separator: true },
          { icon: '⑂', label: 'Checkout Revision…', run: () => post('contextAction', { action: 'checkoutRevision', hash: commit.hash }) },
          { icon: '↔', label: 'Compare with Local', run: () => post('contextAction', { action: 'compareWithLocal', hash: commit.hash }) },
          { separator: true },
          { icon: '✎', label: 'Edit Commit Message…', run: () => beginRewordEditing(commit.hash) },
          { icon: '⤵', label: 'Fixup…', run: () => post('fixupCommit', { hash: commit.hash }) },
          { icon: '⟲', label: 'Undo Commit…', disabled: !isHead || (commit.parents || []).length !== 1, run: () => post('undoCommit', { hash: commit.hash }) },
          { icon: '↶', label: 'Reset Current Branch to Here…', run: () => post('reset', { hash: commit.hash }) },
          { icon: '↩', label: 'Revert Commit', run: () => post('revert', { hash: commit.hash }) },
          { icon: '✕', label: 'Drop Commit…', run: () => post('commitsAction', { action: 'dropCommits', hashes: [commit.hash] }) },
          { icon: '+', label: 'New Branch…', run: () => post('newBranch', { hash: commit.hash }) },
          { icon: '◆', label: 'New Tag…', run: () => post('contextAction', { action: 'createTag', hash: commit.hash }) },
          { separator: true },
          { icon: '↑', label: 'Go to Child Commit', disabled: !child, run: () => child && selectCommitByHash(child.hash) },
          { icon: '↓', label: 'Go to Parent Commit', disabled: !parent, run: () => parent && selectCommitByHash(parent) },
        ];
      });
      list.append(row);
    }
    if (!list.querySelector('.commit-row[tabindex="0"]')) {
      const first = list.querySelector('.commit-row');
      if (first) first.tabIndex = 0;
    }
    if (last < virtualCommits.length) {
      const spacer = node('div', 'virtual-spacer'); spacer.style.height = String((virtualCommits.length - last) * commitRowHeight) + 'px'; spacer.setAttribute('role', 'presentation'); list.append(spacer);
    }
    if (state.hasMoreCommits) list.append(button('Load 300 more commits', 'Load older history', () => post('loadMore'), 'load-more'));
    requestAnimationFrame(drawGraphs);
  }

  function navigateCommitRows(event, row) {
    const current = Number(row.dataset.index); let next = current;
    if (event.key === 'ArrowDown') next = Math.min(virtualCommits.length - 1, current + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, current - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = virtualCommits.length - 1;
    else if (event.key === 'PageDown') next = Math.min(virtualCommits.length - 1, current + 10);
    else if (event.key === 'PageUp') next = Math.max(0, current - 10);
    else return;
    event.preventDefault();
    if (event.shiftKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const target = virtualCommits[next]; if (!target) return;
      extendCommitSelection(target.hash);
      const focusRow = document.querySelector('.commit-row[data-hash="' + target.hash + '"]');
      if (focusRow) {
        focusRow.scrollIntoView({ block: 'nearest' }); focusRow.focus({ preventScroll: true });
      } else {
        // The target can be outside the currently materialized virtual window.
        // Rebuild around it while preserving the range instead of silently
        // leaving keyboard focus on the old row.
        selectVirtualCommit(next, true, true);
      }
      return;
    }
    selectVirtualCommit(next, true);
  }

  function primarySelectedCommitHash() {
    return pendingCommitHash || state.selection?.commit?.hash;
  }

  /** Ctrl/Cmd+click: the single selection seeds the set, then the click toggles. */
  function toggleCommitInSelection(hash) {
    if (!multiSelectedHashes.size) {
      const primary = primarySelectedCommitHash();
      if (primary && virtualCommits.some(commit => commit.hash === primary)) multiSelectedHashes.add(primary);
    }
    if (multiSelectedHashes.has(hash) && multiSelectedHashes.size > 1) multiSelectedHashes.delete(hash);
    else multiSelectedHashes.add(hash);
    commitSelectionAnchor = hash;
    refreshCommitSelection();
  }

  /** Shift+click or Shift+arrow: everything between the anchor and here, in list order. */
  function extendCommitSelection(hash) {
    const order = virtualCommits.map(commit => commit.hash);
    const anchor = commitSelectionAnchor && order.includes(commitSelectionAnchor)
      ? commitSelectionAnchor
      : (primarySelectedCommitHash() ?? hash);
    const from = order.indexOf(anchor); const to = order.indexOf(hash);
    if (from < 0 || to < 0) return;
    commitSelectionAnchor = anchor;
    multiSelectedHashes = new Set(order.slice(Math.min(from, to), Math.max(from, to) + 1));
    refreshCommitSelection();
  }

  function refreshCommitSelection() {
    document.querySelectorAll('.commit-row').forEach(item => {
      const active = multiSelectedHashes.size ? multiSelectedHashes.has(item.dataset.hash) : item.dataset.hash === primarySelectedCommitHash();
      item.classList.toggle('selected', active); item.setAttribute('aria-selected', String(active));
    });
    // The details pane switches between one commit's details and the
    // selection summary without a host round trip: the subjects are already
    // in the loaded window.
    const pane = document.getElementById('details-pane');
    if (pane) replaceDetailsPane(pane);
  }

  function selectVirtualCommit(index, focus = false, preserveMulti = false) {
    const commit = virtualCommits[index]; if (!commit) return;
    pendingCommitHash = commit.hash; requestCommitSelection(commit.hash);
    if (!preserveMulti) multiSelectedHashes = new Set(); commitSelectionAnchor = commit.hash;
    if (virtualCommits.length <= virtualThreshold) {
      // Every row already exists; rebuilding them all made holding an arrow key janky.
      let target;
      document.querySelectorAll('.commit-row').forEach(item => {
        const active = item.dataset.hash === commit.hash;
        item.classList.toggle('selected', active); item.setAttribute('aria-selected', String(active));
        item.tabIndex = active ? 0 : -1;
        if (active) target = item;
      });
      target?.scrollIntoView({ block: 'nearest' });
      if (focus) target?.focus({ preventScroll: true });
      return;
    }
    const scroll = document.getElementById('commit-scroll');
    const top = commitRowHeight + index * commitRowHeight;
    const needsScroll = scroll && (top < scroll.scrollTop + commitRowHeight || top + commitRowHeight > scroll.scrollTop + scroll.clientHeight);
    const target = needsScroll ? Math.max(0, top - Math.floor(scroll.clientHeight / 2)) : undefined;
    // Render the window for the intended offset first: replaceChildren empties the scroller,
    // so assigning scrollTop beforehand is clamped back to 0 and the list never moves.
    renderCommitWindow(undefined, target);
    if (scroll && target !== undefined) {
      // The assignment fires the scroll listener, which would rebuild the window a frame later
      // and destroy the row focused below.
      expectedScrollTop = target;
      scroll.scrollTop = target;
    }
    if (focus) document.querySelector('.commit-row[data-hash="' + CSS.escape(commit.hash) + '"]')?.focus({ preventScroll: true });
  }

  function refreshDetailsForFilter() {
    const current = document.getElementById('details-pane');
    if (current) replaceDetailsPane(current);
  }

  /** Swaps the details pane while keeping the scroll positions inside it. */
  function replaceDetailsPane(current) {
    const saved = {};
    for (const id of ['changed-files', 'commit-details']) {
      const element = document.getElementById(id);
      if (element) saved[id] = { top: element.scrollTop, left: element.scrollLeft };
    }
    current.replaceWith(detailsPane());
    requestAnimationFrame(() => {
      for (const [id, position] of Object.entries(saved)) {
        const element = document.getElementById(id);
        if (element) { element.scrollTop = position.top; element.scrollLeft = position.left; }
      }
    });
  }

  function selectCommitByHash(hash) {
    const row = document.querySelector('.commit-row[data-hash="' + CSS.escape(hash) + '"]');
    if (row) { row.click(); row.scrollIntoView({ block: 'nearest' }); return; }
    const index = virtualCommits.findIndex(commit => commit.hash === hash); if (index >= 0) selectVirtualCommit(index, true);
  }

  function filteredCommits() {
    let commits = [...(state.commits || [])];
    if (search) commits = commits.filter(c => (c.subject + '\n' + c.body + '\n' + c.author + '\n' + c.email + '\n' + c.hash + '\n' + (c.refs || []).join(' ')).toLowerCase().includes(search.toLowerCase()));
    if (authorFilter) commits = commits.filter(commit => commit.author === authorFilter);
    if (dateFilter !== 'all') {
      const now = new Date(); let cutoff;
      if (dateFilter === 'today') cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      else cutoff = new Date(now.getTime() - ({ week: 7, month: 30, year: 365 }[dateFilter] || 0) * 86400000);
      commits = commits.filter(commit => new Date(commit.authoredAt) >= cutoff);
    }
    return commits;
  }

  let issueRuleCache = { key: '', rules: [] };

  /**
   * Appends text with the configured issue ids turned into tracker links,
   * IDEA's Issue Navigation. Rules compile once per configuration value.
   */
  function appendIssueLinked(parent, text) {
    const raw = state.issueRules || [];
    const key = JSON.stringify(raw);
    if (issueRuleCache.key !== key) issueRuleCache = { key, rules: IssueNavigation.compileIssueRules(raw) };
    for (const segment of IssueNavigation.linkifyIssues(String(text), issueRuleCache.rules)) {
      if (segment.url) {
        const anchor = document.createElement('a');
        anchor.className = 'issue-link';
        anchor.href = segment.url;
        anchor.textContent = segment.text;
        anchor.title = segment.url;
        parent.append(anchor);
      } else {
        parent.append(document.createTextNode(segment.text));
      }
    }
  }

  function beginRewordEditing(hash) {
    rewordEditingHash = hash; rewordDraft = undefined; rewordNeedsFocus = true;
    // The editor needs the complete message, which arrives with the selection.
    if (pendingCommitHash !== hash && state.selection?.commit?.hash !== hash) selectCommitByHash(hash);
    render();
  }

  function endRewordEditing() {
    rewordEditingHash = undefined; rewordDraft = undefined; rewordNeedsFocus = false;
    render();
  }

  /** The message of the selected commit as an editable box: Ctrl/Cmd+Enter saves, Escape cancels. */
  function rewordEditor(commit) {
    const editor = node('div', 'reword-editor');
    const box = node('textarea'); box.id = 'reword-message'; box.spellcheck = true;
    box.value = rewordDraft !== undefined ? rewordDraft : ((commit.body && commit.body.trim()) || commit.subject || '');
    box.setAttribute('aria-label', t('Commit message'));
    const save = () => {
      if (!box.value.trim()) { box.focus(); return; }
      post('rewordCommit', { hash: commit.hash, message: box.value });
      endRewordEditing();
    };
    box.addEventListener('input', () => { rewordDraft = box.value; });
    box.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); endRewordEditing(); return; }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); }
    });
    const actions = node('div', 'reword-actions');
    actions.append(
      button('Save Message', 'Rewrite the commit with this message', save, 'primary-action'),
      button('Cancel', 'Keep the current message', endRewordEditing, 'action'),
      node('span', 'hint', isZh ? 'Ctrl/Cmd+Enter 保存 · Esc 取消' : 'Ctrl/Cmd+Enter saves · Esc cancels'),
    );
    editor.append(box, actions);
    if (rewordNeedsFocus) {
      rewordNeedsFocus = false;
      requestAnimationFrame(() => { box.focus(); box.setSelectionRange(box.value.length, box.value.length); });
    }
    return editor;
  }

  function detailsPane() {
    const pane = node('aside', 'pane details'); pane.id = 'details-pane'; const selection = state.selection;
    if (multiSelectedHashes.size > 1) {
      // IDEA shows the messages of every selected commit; the subjects are in
      // the loaded window, so no host round trip is needed.
      const chosen = virtualCommits.filter(commit => multiSelectedHashes.has(commit.hash));
      const summary = node('div', 'commit-details');
      summary.append(node('div', 'detail-subject', isZh ? '已选择 ' + chosen.length + ' 个提交' : String(chosen.length) + ' commits selected'));
      const listed = node('div', 'detail-multi');
      for (const commit of chosen) {
        const line = node('div', 'multi-commit');
        line.append(node('span', 'muted', commit.hash.slice(0, 8) + '  '), node('span', '', commit.subject || t('(no subject)')));
        listed.append(line);
      }
      summary.append(listed, node('div', 'muted multi-hint', t('Right-click the selection to cherry-pick the commits in history order, or compare two.')));
      pane.append(summary);
      return pane;
    }
    const visible = new Set(filteredCommits().map(commit => commit.hash));
    if (pendingCommitHash && selection?.commit?.hash !== pendingCommitHash) { pane.append(node('div', 'empty', 'Loading commit details…')); return pane; }
    if (!selection || !visible.has(selection.commit.hash)) { pane.append(node('div', 'empty', visible.size ? 'Select a commit to view details' : 'No commit matches the current filters')); return pane; }
    const commit = selection.commit; const details = node('div', 'commit-details');
    details.id = 'commit-details';
    if (rewordEditingHash === commit.hash) {
      details.append(rewordEditor(commit));
    } else {
      const subjectLine = node('div', 'detail-subject');
      appendIssueLinked(subjectLine, commit.subject || t('(no subject)'));
      details.append(subjectLine);
    }
    if ((commit.refs || []).length) {
      const refs = node('div', 'detail-refs');
      for (const ref of orderedRefs(commit.refs)) refs.append(refChip(ref));
      details.append(refs);
    }
    const meta = node('div', 'detail-meta');
    for (const [key, value] of [['Author', commit.author + ' <' + commit.email + '>'], ['Date', new Date(commit.authoredAt).toLocaleString()], ['Commit', commit.hash], ['Parents', (commit.parents || []).map(p => p.slice(0, 10)).join(', ') || '—']]) { meta.append(node('span', '', key), node('strong', '', value)); }
    details.append(meta);
    if (rewordEditingHash !== commit.hash && commit.body && commit.body !== commit.subject) {
      const body = node('div', 'detail-body');
      appendIssueLinked(body, commit.body);
      details.append(body);
    }
    const files = node('div', 'files'); files.id = 'changed-files'; files.setAttribute('role', 'tree');
    files.append(node('div', 'pane-title', t('Changed Files') + ' (' + selection.files.length + ')'));
    const tree = node('div', 'file-tree-root'); tree.append(fileTree(selection.files, commit)); files.append(tree);
    const splitter = node('div', 'detail-splitter'); splitter.tabIndex = 0; splitter.setAttribute('role', 'separator'); splitter.setAttribute('aria-orientation', 'horizontal'); splitter.title = t('Drag to resize commit message');
    setupDetailSplitter(pane, splitter);
    pane.append(files, splitter, details);
    requestAnimationFrame(() => { setMessagePaneHeight(pane, Number(uiState.messagePaneHeight) || 160, false); setupTreeKeyboard(files); });
    return pane;
  }

  function setupTreeKeyboard(tree) {
    const visibleRows = () => [...tree.querySelectorAll('[role="treeitem"]')].filter(row => row.offsetParent !== null);
    const rows = visibleRows(); if (!rows.length) return;
    const initial = rows.find(row => row.classList.contains('selected')) || rows[0]; rows.forEach(row => { row.tabIndex = row === initial ? 0 : -1; });
    tree.addEventListener('keydown', event => {
      const current = event.target.closest?.('[role="treeitem"]'); if (!current) return;
      const live = visibleRows(); let index = live.indexOf(current);
      if (event.key === 'ArrowDown') index = Math.min(live.length - 1, index + 1);
      else if (event.key === 'ArrowUp') index = Math.max(0, index - 1);
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = live.length - 1;
      else if (event.key === 'ArrowRight' && current.getAttribute('aria-expanded') === 'false') { event.preventDefault(); current.click(); return; }
      else if (event.key === 'ArrowLeft' && current.getAttribute('aria-expanded') === 'true') { event.preventDefault(); current.click(); return; }
      else return;
      event.preventDefault(); live.forEach(row => { row.tabIndex = -1; }); live[index].tabIndex = 0; live[index].focus();
    });
  }

  function fileTree(files, commit) {
    const root = { path: '', directories: new Map(), files: [] };
    for (const file of files) {
      const parts = file.path.split('/'); let current = root; let currentPath = '';
      for (const part of parts.slice(0, -1)) {
        currentPath = currentPath ? currentPath + '/' + part : part;
        if (!current.directories.has(part)) current.directories.set(part, { name: part, path: currentPath, directories: new Map(), files: [] });
        current = current.directories.get(part);
      }
      current.files.push(file);
    }
    const container = node('div');
    for (const directory of root.directories.values()) container.append(renderDirectory(directory, 0, commit));
    for (const file of root.files) container.append(commitFileRow(file, 0, commit));
    return container;
  }

  function renderDirectory(directory, depth, commit) {
    const compacted = compactDirectory(directory); directory = compacted.directory;
    const section = node('section');
    const collapsed = new Set(uiState.collapsedFileFolders || []).has(directory.path);
    const row = node('div', 'tree-row'); row.tabIndex = 0; row.style.paddingLeft = (8 + depth * 16) + 'px'; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-expanded', String(!collapsed));
    const count = countTreeFiles(directory);
    const twisty = node('span', 'tree-twisty', collapsed ? '›' : '⌄');
    row.append(twisty, node('span', 'tree-folder', '▱ ' + compacted.name), node('span', 'tree-count', fileCount(count)));
    const children = node('div'); children.hidden = collapsed;
    for (const child of directory.directories.values()) children.append(renderDirectory(child, depth + 1, commit));
    for (const file of directory.files) children.append(commitFileRow(file, depth + 1, commit));
    const toggle = () => {
      children.hidden = !children.hidden; twisty.textContent = children.hidden ? '›' : '⌄'; row.setAttribute('aria-expanded', String(!children.hidden));
      const collapsedFolders = new Set(uiState.collapsedFileFolders || []);
      if (children.hidden) collapsedFolders.add(directory.path); else collapsedFolders.delete(directory.path);
      saveUiState({ collapsedFileFolders: [...collapsedFolders] });
    };
    row.addEventListener('click', toggle); keyboardActivate(row, toggle); section.append(row, children); return section;
  }

  function compactDirectory(directory) {
    const names = [directory.name]; let current = directory;
    while (!current.files.length && current.directories.size === 1) {
      current = current.directories.values().next().value; names.push(current.name);
    }
    return { name: names.join('/'), directory: current };
  }

  function countTreeFiles(directory) {
    let count = directory.files.length;
    for (const child of directory.directories.values()) count += countTreeFiles(child);
    return count;
  }

  function commitFileRow(file, depth, commit) {
    const selected = selectedFilePath === file.path;
    const row = node('div', 'file-row' + (selected ? ' selected' : '')); row.dataset.filePath = file.path; row.style.paddingLeft = (10 + depth * 16) + 'px';
    row.tabIndex = 0; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-selected', String(selected));
    row.title = file.originalPath ? file.originalPath + ' → ' + file.path : file.path;
    const statusClass = statusClassFor(file.status[0]);
    row.append(node('span', 'file-status ' + statusClass, file.status[0]), node('span', 'file-path ' + statusClass, file.path.split('/').pop()));
    const selectFile = () => {
      selectedFilePath = file.path;
      document.querySelectorAll('.file-row').forEach(item => {
        const active = item.dataset.filePath === selectedFilePath;
        item.classList.toggle('selected', active); item.setAttribute('aria-selected', String(active));
      });
    };
    row.addEventListener('click', selectFile);
    row.addEventListener('keydown', event => {
      if (event.key === ' ') { event.preventDefault(); selectFile(); }
      if (event.key === 'Enter') { event.preventDefault(); selectFile(); post('openCommitFile', { hash: commit.hash, path: file.path }); }
    });
    row.addEventListener('dblclick', () => post('openCommitFile', { hash: commit.hash, path: file.path }));
    attachContextMenu(row, () => {
      selectFile();
      return [
        { icon: '↔', label: 'Show Diff', run: () => post('contextAction', { action: 'showFileDiff', hash: commit.hash, path: file.path }) },
        { icon: '⇄', label: 'Compare with Local', run: () => post('contextAction', { action: 'compareFileWithLocal', hash: commit.hash, path: file.path }) },
        { icon: '□', label: 'Open Repository Version', run: () => post('contextAction', { action: 'openRepositoryFile', hash: commit.hash, path: file.path }) },
        { separator: true },
        { icon: '+', label: 'Create Patch…', run: () => post('contextAction', { action: 'createFilePatch', hash: commit.hash, path: file.path }) },
        { icon: '↓', label: 'Get from Revision…', disabled: file.status.startsWith('D'), run: () => post('contextAction', { action: 'restoreFile', hash: commit.hash, path: file.path }) },
        { icon: '◷', label: 'History Up to Here', run: () => post('contextAction', { action: 'fileHistory', hash: commit.hash, path: file.path }) },
        { separator: true },
        { icon: '⧉', label: 'Copy Path', run: () => post('contextAction', { action: 'copyPath', hash: commit.hash, path: file.path }) },
      ];
    });
    return row;
  }

  function setupDetailSplitter(pane, splitter) {
    const resize = event => {
      const bounds = pane.getBoundingClientRect();
      setMessagePaneHeight(pane, bounds.bottom - event.clientY, false);
    };
    splitter.addEventListener('pointerdown', event => {
      const started = beginDrag(splitter, event, resize, () => {
        splitter.classList.remove('dragging');
        saveUiState({ messagePaneHeight: parseFloat(getComputedStyle(pane).getPropertyValue('--message-height')) });
        flushDeferredState();
      });
      if (!started) return;
      splitter.focus(); splitter.classList.add('dragging'); resize(event);
    });
    splitter.addEventListener('dblclick', () => setMessagePaneHeight(pane, 160, true));
    splitter.addEventListener('keydown', event => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault(); const current = parseFloat(getComputedStyle(pane).getPropertyValue('--message-height')) || 160;
      setMessagePaneHeight(pane, current + (event.key === 'ArrowUp' ? 16 : -16), true);
    });
    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(() => {
        if (!pane.isConnected) { observer.disconnect(); return; }
        const current = parseFloat(getComputedStyle(pane).getPropertyValue('--message-height')) || 160;
        setMessagePaneHeight(pane, current, false);
      });
      observer.observe(pane);
    }
  }

  function setMessagePaneHeight(pane, requested, persist) {
    const maximum = Math.max(80, pane.clientHeight - 80);
    const height = Math.max(80, Math.min(requested, maximum)); pane.style.setProperty('--message-height', height + 'px');
    const splitter = pane.querySelector('.detail-splitter');
    if (splitter) { splitter.setAttribute('aria-valuemin', '80'); splitter.setAttribute('aria-valuemax', String(maximum)); splitter.setAttribute('aria-valuenow', String(Math.round(height))); }
    if (persist) saveUiState({ messagePaneHeight: height });
  }

  const graphEdgeKey = (child, parent) => child + '>' + parent;

  function graphModel(commits) {
    const byHash = new Map(commits.map(commit => [commit.hash, commit]));
    const parents = new Map(); const children = new Map(commits.map(commit => [commit.hash, []]));
    for (const commit of commits) {
      const visibleParents = (commit.parents || []).filter(hash => byHash.has(hash)); parents.set(commit.hash, visibleParents);
      for (const parent of visibleParents) children.get(parent).push(commit.hash);
    }
    const isLinearMiddle = hash => {
      const commit = byHash.get(hash);
      return Boolean(commit) && (parents.get(hash) || []).length === 1 && (children.get(hash) || []).length === 1 && !(commit.refs || []).length;
    };
    const fragments = new Map(); const seriesByEdge = new Map();
    for (const commit of commits) {
      if (isLinearMiddle(commit.hash)) continue;
      for (const firstParentHash of parents.get(commit.hash) || []) {
        const edges = []; const middle = []; let childHash = commit.hash; let parentHash = firstParentHash;
        while (parentHash) {
          edges.push(graphEdgeKey(childHash, parentHash));
          if (!isLinearMiddle(parentHash)) break;
          middle.push(parentHash); childHash = parentHash; parentHash = (parents.get(parentHash) || [])[0];
        }
        const bottomHash = parentHash || childHash; const id = graphEdgeKey(commit.hash, bottomHash);
        for (const edge of edges) seriesByEdge.set(edge, id);
        if (middle.length >= 2) fragments.set(id, { id, topHash: commit.hash, firstParentHash, bottomHash, middle });
      }
    }
    const hidden = new Set(); const replacements = new Map(); const dottedEdges = new Set();
    for (const id of collapsedGraphSeries) {
      const fragment = fragments.get(id); if (!fragment) continue;
      for (const hash of fragment.middle) hidden.add(hash);
      replacements.set(graphEdgeKey(fragment.topHash, fragment.firstParentHash), fragment.bottomHash);
      const replacementEdge = graphEdgeKey(fragment.topHash, fragment.bottomHash);
      seriesByEdge.set(replacementEdge, id); dottedEdges.add(replacementEdge);
    }
    const visibleCommits = commits.filter(commit => !hidden.has(commit.hash)); const visibleHashes = new Set(visibleCommits.map(commit => commit.hash));
    const displayParents = new Map();
    for (const commit of visibleCommits) {
      displayParents.set(commit.hash, (parents.get(commit.hash) || []).map(parent => replacements.get(graphEdgeKey(commit.hash, parent)) || parent).filter(parent => visibleHashes.has(parent)));
    }
    return { commits: visibleCommits, parents: displayParents, fragments, seriesByEdge, dottedEdges };
  }

  function graphLayout(commits, model) {
    const positions = new Map(commits.map((commit, index) => [commit.hash, index])); const lanes = [];
    return commits.map((commit, index) => {
      for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
        const target = lanes[laneIndex]; const targetPosition = target && positions.get(target.hash);
        if (target && target.hash !== commit.hash && (targetPosition === undefined || targetPosition < index)) lanes[laneIndex] = null;
      }
      let lane = lanes.findIndex(target => target?.hash === commit.hash);
      const commitParents = model.parents.get(commit.hash) || [];
      if (lane < 0) {
        lane = lanes.findIndex(target => !target); if (lane < 0) lane = lanes.length;
        const firstSeries = commitParents[0] ? model.seriesByEdge.get(graphEdgeKey(commit.hash, commitParents[0])) : commit.hash;
        lanes[lane] = { hash: commit.hash, seriesId: firstSeries || commit.hash, dotted: false };
      }
      const incoming = lanes.map(target => target ? { seriesId: target.seriesId, dotted: target.dotted } : null);
      const connections = []; const occupied = new Set();
      commitParents.forEach((parent, parentIndex) => {
        const edge = graphEdgeKey(commit.hash, parent); const seriesId = model.seriesByEdge.get(edge) || edge; const dotted = model.dottedEdges.has(edge);
        let targetLane = lanes.findIndex((target, candidate) => candidate !== lane && target?.hash === parent);
        if (parentIndex === 0 && targetLane < 0) {
          targetLane = lane; lanes[lane] = { hash: parent, seriesId, dotted };
        } else {
          if (targetLane < 0) {
            targetLane = lanes.findIndex((target, candidate) => candidate !== lane && !target && !occupied.has(candidate));
            if (targetLane < 0) targetLane = lanes.length;
            lanes[targetLane] = { hash: parent, seriesId, dotted };
          }
          connections.push({ from: lane, to: targetLane, seriesId, dotted });
          if (parentIndex === 0) lanes[lane] = null;
        }
        occupied.add(targetLane);
      });
      if (!commitParents.length) lanes[lane] = null;
      for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
        const target = lanes[laneIndex]; const targetPosition = target && positions.get(target.hash);
        if (target && (targetPosition === undefined || targetPosition <= index)) lanes[laneIndex] = null;
      }
      while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
      const outgoing = lanes.map(target => target ? { seriesId: target.seriesId, dotted: target.dotted } : null);
      const nodeSeriesId = outgoing[lane]?.seriesId || incoming[lane]?.seriesId || connections[0]?.seriesId || commit.hash;
      return { lane, incoming, outgoing, connections, nodeSeriesId };
    });
  }

  function graphColor(seriesId) {
    let hash = 0; for (let index = 0; index < seriesId.length; index++) hash = ((hash << 5) - hash + seriesId.charCodeAt(index)) | 0;
    return colors[Math.abs(hash) % colors.length];
  }

  function graphSegments(graph) {
    const scale = 2; const x = lane => 8 * scale + lane * 12 * scale; const mid = 13.5 * scale; const bottom = 27 * scale; const segments = [];
    graph.incoming.forEach((line, lane) => { if (line) segments.push({ x1: x(lane), y1: 0, x2: x(lane), y2: mid, ...line }); });
    graph.outgoing.forEach((line, lane) => { if (line) segments.push({ x1: x(lane), y1: mid, x2: x(lane), y2: bottom, ...line }); });
    graph.connections.forEach(line => segments.push({ x1: x(line.from), y1: mid, x2: x(line.to), y2: bottom, seriesId: line.seriesId, dotted: line.dotted }));
    return segments;
  }

  function drawGraphs() {
    const activeSeries = hoveredGraphSeries || selectedGraphSeries;
    document.querySelectorAll('canvas[data-graph]').forEach(canvas => {
      const graph = JSON.parse(canvas.dataset.graph); const ctx = canvas.getContext('2d'); const scale = 2; const x = lane => 8 * scale + lane * 12 * scale; const mid = 13.5 * scale;
      ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.lineCap = 'round';
      for (const segment of graphSegments(graph)) {
        ctx.globalAlpha = activeSeries && segment.seriesId !== activeSeries ? .2 : 1;
        ctx.lineWidth = (segment.seriesId === activeSeries ? 2.6 : 1.5) * scale; ctx.strokeStyle = graphColor(segment.seriesId);
        ctx.setLineDash(segment.dotted ? [3 * scale, 3 * scale] : []); ctx.beginPath(); ctx.moveTo(segment.x1, segment.y1); ctx.lineTo(segment.x2, segment.y2); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.globalAlpha = activeSeries && graph.nodeSeriesId !== activeSeries ? .25 : 1;
      ctx.fillStyle = graphColor(graph.nodeSeriesId); ctx.beginPath(); ctx.arc(x(graph.lane), mid, (graph.nodeSeriesId === activeSeries ? 4.8 : 4) * scale, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = getComputedStyle(document.body).backgroundColor; ctx.lineWidth = 1.3 * scale; ctx.stroke(); ctx.globalAlpha = 1;
    });
  }

  function graphSeriesAt(canvas, event) {
    const graph = JSON.parse(canvas.dataset.graph); const bounds = canvas.getBoundingClientRect();
    const point = { x: (event.clientX - bounds.left) * canvas.width / bounds.width, y: (event.clientY - bounds.top) * canvas.height / bounds.height };
    let selected = ''; let nearest = 12;
    for (const segment of graphSegments(graph)) {
      const distance = pointToSegmentDistance(point.x, point.y, segment.x1, segment.y1, segment.x2, segment.y2);
      if (distance < nearest) { nearest = distance; selected = segment.seriesId; }
    }
    const nodeX = 16 + graph.lane * 24; const nodeDistance = Math.hypot(point.x - nodeX, point.y - 27);
    if (nodeDistance < nearest) selected = graph.nodeSeriesId;
    return selected;
  }

  function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1; const dy = y2 - y1; const length = dx * dx + dy * dy;
    const ratio = length ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / length)) : 0;
    return Math.hypot(px - (x1 + ratio * dx), py - (y1 + ratio * dy));
  }

  function attachGraphInteraction(canvas) {
    canvas.addEventListener('mousemove', event => {
      const series = graphSeriesAt(canvas, event); canvas.style.cursor = series ? 'pointer' : 'default';
      if (series !== hoveredGraphSeries) { hoveredGraphSeries = series; drawGraphs(); }
    });
    canvas.addEventListener('mouseleave', () => { if (hoveredGraphSeries) { hoveredGraphSeries = ''; drawGraphs(); } });
    canvas.addEventListener('click', event => {
      const series = graphSeriesAt(canvas, event);
      if (!series) {
        if (selectedGraphSeries) { selectedGraphSeries = ''; saveUiState({ selectedGraphSeries: '' }); drawGraphs(); }
        return;
      }
      event.preventDefault(); event.stopPropagation(); selectedGraphSeries = series;
      if (currentGraphFragments.has(series)) {
        if (collapsedGraphSeries.has(series)) collapsedGraphSeries.delete(series); else collapsedGraphSeries.add(series);
        hoveredGraphSeries = ''; saveUiState({ collapsedGraphSeries: [...collapsedGraphSeries], selectedGraphSeries }); renderCommitRows();
      } else {
        saveUiState({ selectedGraphSeries }); drawGraphs();
      }
    });
  }

  const shortRef = ref => ref.replace(/^HEAD -> /, '').replace(/^tag: /, '');

  const refIconMarkup = {
    tag: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.6 1.5H13.9a.6.6 0 0 1 .6.6v5.3a1 1 0 0 1-.3.7l-6 6a1 1 0 0 1-1.4 0L1.6 9.1a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 .7-.3z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11.3" cy="4.7" r="1.15" fill="currentColor"/></svg>',
    local: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.2" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="4.5" cy="12.8" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11.5" cy="3.2" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 4.9v6.2M11.5 4.9v1.4a2.6 2.6 0 0 1-2.6 2.6H7.1a2.6 2.6 0 0 0-2.6 2.6" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    remote: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1.9 8h12.2M8 1.9c1.9 2.1 1.9 10.1 0 12.2M8 1.9c-1.9 2.1-1.9 10.1 0 12.2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  };

  /** Splits a git decoration such as 'HEAD -> main' or 'tag: v1.2' into a kind and a name. */
  function refInfo(ref) {
    const raw = String(ref).trim();
    if (raw.startsWith('tag: ')) return { kind: 'tag', name: raw.slice(5).trim(), head: false };
    if (raw.startsWith('HEAD -> ')) return { kind: 'local', name: raw.slice(8).trim(), head: true };
    if (raw === 'HEAD') return { kind: 'local', name: 'HEAD', head: true };
    const known = (state.branches || []).find(branch => branch.name === raw);
    if (known) return { kind: known.kind, name: raw, head: false };
    return { kind: raw.includes('/') ? 'remote' : 'local', name: raw, head: false };
  }

  /**
   * Orders decorations so the current branch, then tags, stay visible: with limited row width a
   * remote branch that merely mirrors a local one is the least informative chip to drop.
   */
  const refPriority = info => info.head ? 0 : info.kind === 'tag' ? 1 : info.kind === 'local' ? 2 : 3;
  const orderedRefs = refs => [...(refs || [])]
    .map(ref => ({ ref, info: refInfo(ref) }))
    .sort((left, right) => refPriority(left.info) - refPriority(right.info))
    .map(item => item.ref);

  function refChip(ref) {
    const info = refInfo(ref);
    const chip = node('span', 'ref ref-' + info.kind + (info.head ? ' ref-head' : ''));
    const icon = node('span', 'ref-icon'); icon.innerHTML = refIconMarkup[info.kind] || refIconMarkup.local;
    chip.append(icon, node('span', 'ref-name', info.name));
    chip.title = (info.kind === 'tag' ? 'Tag' : info.kind === 'remote' ? 'Remote branch' : info.head ? 'Current branch' : 'Local branch') + ' ' + info.name;
    return chip;
  }
  const formatDate = value => { const date = new Date(value); const now = new Date(); return date.toDateString() === now.toDateString() ? date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : date.toLocaleDateString(); };
  function updateSelectionWithoutRerender() {
    const selectedHash = state.selection?.commit.hash;
    document.querySelectorAll('.commit-row').forEach(item => {
      const active = item.dataset.hash === selectedHash;
      item.classList.toggle('selected', active); item.setAttribute('aria-selected', String(active));
    });
    const current = document.getElementById('details-pane');
    if (current) replaceDetailsPane(current);
  }

  window.addEventListener('message', event => {
    if (event.data.type === 'state') {
      const incomingVersion = event.data.state?.stateVersion;
      if (typeof incomingVersion === 'number' && incomingVersion < Math.max(lastStateVersion, deferredStateVersion)) return;
      if (blocksStateRender()) {
        deferredState = { ...deferredState, ...event.data.state };
        if (typeof incomingVersion === 'number') deferredStateVersion = incomingVersion;
      }
      else applyIncomingState(event.data.state);
    }
    if (event.data.type === 'selection') {
      if (event.data.root !== state.selectedRoot || event.data.requestId !== pendingSelectionRequestId) return;
      state.selection = event.data.selection; pendingCommitHash = undefined;
      pendingSelectionRequestId = undefined;
      if (!(state.selection.files || []).some(file => file.path === selectedFilePath)) selectedFilePath = state.selection.files[0]?.path;
      updateSelectionWithoutRerender();
    }
    if (event.data.type === 'hunks' && typeof event.data.path === 'string') {
      if (event.data.root !== state.selectedRoot) return;
      const key = (state.selectedRoot || '') + '::' + event.data.path;
      if (event.data.requestId !== hunkRequestIds.get(key)) return;
      hunkRequestIds.delete(key);
      hunkState.set(key, { staged: event.data.staged || [], unstaged: event.data.unstaged || [], owned: event.data.owned || [] });
      if (activeToolTab === 'changes' && expandedChangeHunks.has(key)) render();
    }
    if (event.data.type === 'headMessage') {
      // Filled only while Amend is still checked: the reply may arrive after
      // the user already changed their mind.
      const amendBox = document.getElementById('amend-toggle');
      if (event.data.root === state.selectedRoot && event.data.requestId === pendingHeadRequestId
        && amendBox && amendBox.checked) {
        pendingHeadRequestId = undefined;
        fillCommitMessage(event.data.message);
      }
    }
    if (event.data.type === 'applyCommitMessage') fillCommitMessage(event.data.message);
    if (event.data.type === 'trace') { state.traces = [...(state.traces || []), event.data.trace].slice(-200); if (activeToolTab === 'console') appendConsoleTrace(event.data.trace); }
    if (event.data.type === 'consoleCleared') { state.traces = []; if (activeToolTab === 'console') render(); }
    if (event.data.type === 'activateTab' && event.data.tab !== activeToolTab) { selectToolTab(event.data.tab); }
    if (event.data.type === 'committed') {
      const drafts = { ...(uiState.commitMessages || {}) }; delete drafts[state.selectedRoot || ''];
      const options = { ...(uiState.commitOptions || {}) }; delete options[state.selectedRoot || ''];
      // The author was for that one commit; the next one is the user's own again.
      const authors = { ...(uiState.commitAuthors || {}) }; delete authors[state.selectedRoot || ''];
      saveUiState({ commitMessages: drafts, commitMessage: undefined, commitOptions: options, commitAuthors: authors, authorFieldOpen: false }); render();
    }
    if (event.data.type === 'error') {
      showErrorBanner(event.data.message);
      // The reply for this request is not coming, so stop showing the loading placeholder.
      if (pendingCommitHash) { pendingCommitHash = undefined; updateSelectionWithoutRerender(); }
    }
  });
  document.addEventListener('pointerdown', event => {
    // Leave a press on the invoker alone so its own click can toggle the menu closed.
    if (openMenu && !openMenu.contains(event.target) && !menuInvoker?.contains(event.target)) closeContextMenu();
  });
  document.addEventListener('wheel', event => { if (openMenu && !openMenu.contains(event.target)) closeContextMenu(); }, { capture: true, passive: true });
  document.addEventListener('touchmove', event => { if (openMenu && !openMenu.contains(event.target)) closeContextMenu(); }, { capture: true, passive: true });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeContextMenu(true); });
  // A resize moves everything under the menu, so close it like native menus do.
  window.addEventListener('resize', () => closeContextMenu());
  document.addEventListener('focusout', () => setTimeout(flushDeferredState, 0));
  post('ready', { activeTab: activeToolTab, logOptions: { order: sortMode, firstParent, noMerges, author: authorFilter || undefined, since: dateCutoff(dateFilter) } }); render();
`;

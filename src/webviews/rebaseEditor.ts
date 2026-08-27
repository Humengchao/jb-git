import * as vscode from "vscode";
import { RepositoryManager } from "../repositoryManager";
import { REBASE_ACTIONS, validateRebasePlan, isNoOpPlan, type RebaseStep } from "../interactiveRebase";
import { isRebaseEditorMessage, originalMessage, planCoversSameCommits } from "./rebaseEditorProtocol";
import { webviewDocument } from "./html";

/** A commit as the sequence editor displays it. */
interface EditorCommit {
  readonly oid: string;
  readonly shortOid: string;
  readonly subject: string;
  /** The commit's complete existing message, used to prefill a reword or squash. */
  readonly message: string;
  readonly author: string;
}

/**
 * Opens the interactive-rebase sequence editor and hands the approved plan to
 * `runRebase`. Resolves to true when a plan was started, false when the user
 * cancelled or closed the panel.
 *
 * The plan crosses the Webview boundary as OIDs and actions only: subjects and
 * the commit set are re-read from the repository, so a tampered message cannot
 * widen what gets rewritten. Execution stays with the caller, which owns
 * progress reporting and knows how to explain a rebase that paused.
 */
export async function openRebaseEditor(
  manager: RepositoryManager,
  rootPath: string,
  base: string,
  runRebase: (steps: readonly RebaseStep[]) => Promise<void>,
): Promise<boolean> {
  const candidates = await manager.interactiveRebaseCandidates(rootPath, base);
  if (candidates.length === 0) {
    await vscode.window.showInformationMessage("There are no commits to rebase from that starting point.");
    return false;
  }

  const commits: EditorCommit[] = candidates.map((commit) => ({
    oid: commit.hash,
    shortOid: commit.hash.slice(0, 8),
    subject: commit.subject,
    message: originalMessage(commit),
    author: commit.author,
  }));
  const offered = commits.map((commit) => commit.oid);
  const subjects = new Map(commits.map((commit) => [commit.oid, commit.subject]));

  const panel = vscode.window.createWebviewPanel(
    "jbGit.rebaseEditor",
    `Rebase ${commits.length} Commit(s)`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  try {
    return await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (result: boolean | Error): void => {
        if (settled) return;
        settled = true;
        if (result instanceof Error) reject(result);
        else resolve(result);
      };

      const disposeRegistration = panel.onDidDispose(() => {
        disposeRegistration.dispose();
        // Closing the panel is a cancel, not a failure.
        finish(false);
      });

      panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (!isRebaseEditorMessage(message)) return;
        if (message.type === "ready") {
          await panel.webview.postMessage({ type: "load", commits, actions: REBASE_ACTIONS });
          return;
        }
        if (message.type === "cancel") {
          finish(false);
          panel.dispose();
          return;
        }

        if (!planCoversSameCommits(message.steps, offered)) {
          await panel.webview.postMessage({ type: "error", message: "The plan no longer matches the commits that were loaded. Close the editor and start again." });
          return;
        }
        const steps: RebaseStep[] = message.steps.map((step) => ({
          oid: step.oid,
          subject: subjects.get(step.oid) ?? "",
          action: step.action,
          message: step.message,
        }));
        const problem = validateRebasePlan(steps);
        if (problem) {
          await panel.webview.postMessage({ type: "error", message: problem });
          return;
        }
        if (isNoOpPlan(steps, offered)) {
          await panel.webview.postMessage({ type: "error", message: "This plan leaves history unchanged." });
          return;
        }

        // The panel closes before the rebase starts: it must not look editable
        // while Git rewrites the commits it was showing.
        panel.dispose();
        try {
          await runRebase(steps);
          finish(true);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });

      panel.webview.html = editorDocument();
    });
  } finally {
    panel.dispose();
  }
}

function editorDocument(): string {
  return webviewDocument("Interactive Rebase", styles(), script());
}

function styles(): string {
  // String.raw, like every other Webview here: a plain template literal
  // rewrites the escapes in the text before the sandbox ever sees it.
  return String.raw`
    :root { color-scheme: light dark; }
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; }
    #app { padding: 12px 16px 72px; }
    h1 { font-size: 1.1em; margin: 0 0 4px; }
    .hint { color: var(--vscode-descriptionForeground); margin: 0 0 12px; }
    ol { list-style: none; margin: 0; padding: 0; }
    li { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-bottom: 6px; padding: 6px 8px; display: grid; grid-template-columns: auto auto auto 1fr auto; gap: 8px; align-items: start; }
    li.dragging { opacity: 0.45; }
    li.drop-above { box-shadow: 0 -2px 0 0 var(--vscode-focusBorder); }
    li.drop-below { box-shadow: 0 2px 0 0 var(--vscode-focusBorder); }
    li.dropped .subject { text-decoration: line-through; opacity: 0.6; }
    li.dropped .oid, li.dropped .author { opacity: 0.6; }
    /* A fold joins the commit above it, so its row tucks under that one the
       way IDEA indents squash and fixup lines. */
    li.folded { margin-left: 26px; border-left: 3px solid var(--vscode-textLink-foreground); }
    .grip { cursor: grab; color: var(--vscode-descriptionForeground); padding: 2px 2px 0; user-select: none; letter-spacing: -1px; }
    .grip:active { cursor: grabbing; }
    .order { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; padding-top: 4px; min-width: 16px; text-align: right; }
    .select-shell { position: relative; display: flex; min-width: 0; }
    .select-shell::after { content: ''; position: absolute; right: 9px; top: 50%; width: 5px; height: 5px; margin-top: -4px; border-right: 1px solid var(--vscode-dropdown-foreground, var(--vscode-foreground)); border-bottom: 1px solid var(--vscode-dropdown-foreground, var(--vscode-foreground)); transform: rotate(45deg); opacity: .7; pointer-events: none; }
    .select-shell select { width: 100%; min-width: 88px; height: 26px; padding: 0 24px 0 8px; appearance: none; font: inherit; color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); background: var(--vscode-dropdown-background, var(--vscode-input-background)); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 3px; cursor: pointer; text-overflow: ellipsis; }
    .select-shell select:hover { border-color: var(--vscode-focusBorder); }
    .subject { padding-top: 4px; overflow-wrap: anywhere; }
    .oid { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); margin-right: 6px; }
    .author { color: var(--vscode-descriptionForeground); }
    textarea { grid-column: 4 / span 2; width: 100%; box-sizing: border-box; min-height: 64px; font-family: var(--vscode-editor-font-family); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; padding: 4px; resize: vertical; }
    .moves { display: flex; gap: 2px; }
    button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 2px; padding: 2px 6px; cursor: pointer; }
    button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { opacity: 0.4; cursor: default; }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 4px 14px; }
    button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    footer { position: fixed; bottom: 0; left: 0; right: 0; display: flex; align-items: center; gap: 10px; padding: 10px 16px; background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); }
    .problem { color: var(--vscode-errorForeground); flex: 1; }
    /* A fresh dialog has nothing to do yet; that is a state, not a failure. */
    .problem.quiet { color: var(--vscode-descriptionForeground); }
    :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  `;
}

function script(): string {
  // The sandbox only reorders rows and labels them; every guarantee about which
  // commits may be rewritten is re-checked on the extension side.
  //
  // String.raw is not decoration. A plain template literal turns the `\n` in
  // this script's own source into a real newline, and a real newline inside a
  // single-quoted string is a syntax error, so the whole script failed to parse
  // and the sequence editor opened as an empty panel.
  return String.raw`
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');
    const isZh = document.documentElement.lang.toLowerCase().startsWith('zh');
    const zh = isZh ? {
      'Interactive Rebase': '交互式变基',
      'The list runs oldest first, like Git. Drag a row by its handle (or press Alt+↑/↓), choose an action, then start the rebase.':
        '列表按最旧在前排列，与 Git 一致。拖动行首的手柄（或按 Alt+↑/↓）调整顺序，选择操作，然后开始变基。',
      'Start Rebase': '开始变基', 'Cancel': '取消',
      'Dropping every commit would leave nothing to replay.': '丢弃所有提交后将没有可重放的内容。',
      'The first replayed commit has nothing earlier to fold into.': '第一个重放的提交没有更早的提交可以并入。',
      'A reword or squash needs a commit message.': 'reword 或 squash 需要提交消息。',
      'This plan leaves history unchanged.': '当前计划不会改变历史。',
      'Move earlier': '上移', 'Move later': '下移', 'Drag to reorder': '拖动以重新排序',
      'Action for commit': '选择操作：提交', 'Message for commit': '提交消息：提交',
      'Keep this commit as it is': '按原样保留此提交',
      'Keep the changes and edit the commit message': '保留更改，修改提交消息',
      'Stop here to amend or test this commit, then Continue': '在此停下以修改或测试该提交，然后 Continue',
      'Fold into the previous kept commit and keep both messages': '并入上一个保留的提交，保留两者的消息',
      'Fold into the previous kept commit and discard this message': '并入上一个保留的提交，丢弃此提交的消息',
      'Remove this commit': '丢弃此提交',
    } : {};
    const t = value => zh[value] || value;
    const ACTION_HELP = {
      pick: 'Keep this commit as it is',
      reword: 'Keep the changes and edit the commit message',
      edit: 'Stop here to amend or test this commit, then Continue',

      squash: 'Fold into the previous kept commit and keep both messages',
      fixup: 'Fold into the previous kept commit and discard this message',
      drop: 'Remove this commit',
    };
    let rows = [];
    let originalOrder = [];
    let actions = ['pick'];
    let dragIndex;

    function node(tag, className, text) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = t(text);
      return element;
    }

    function needsMessage(action) { return action === 'reword' || action === 'squash'; }
    function isFold(action) { return action === 'squash' || action === 'fixup'; }

    /** The kept commit a fold at this position lands on, which is the message it joins. */
    function leaderOf(index) {
      for (let i = index - 1; i >= 0; i -= 1) {
        if (rows[i].action === 'drop') continue;
        if (!isFold(rows[i].action)) return rows[i];
      }
      return undefined;
    }

    /** Matches Git's own squash editor, which offers both messages to trim down. */
    function prefill(row, index) {
      if (row.action !== 'squash') return row.original;
      const leader = leaderOf(index);
      if (!leader) return row.original;
      return [leader.message || leader.original, row.original].filter(Boolean).join('\n\n');
    }

    /** The reason Start is disabled; quiet marks the nothing-to-do-yet state. */
    function localProblem() {
      const applied = rows.filter((row) => row.action !== 'drop');
      if (!applied.length) return { text: 'Dropping every commit would leave nothing to replay.' };
      if (isFold(applied[0].action)) return { text: 'The first replayed commit has nothing earlier to fold into.' };
      for (const row of rows) {
        if (needsMessage(row.action) && !row.message.trim()) return { text: 'A reword or squash needs a commit message.' };
      }
      if (rows.every((row, index) => row.action === 'pick' && row.oid === originalOrder[index])) {
        return { text: 'This plan leaves history unchanged.', quiet: true };
      }
      return undefined;
    }

    function move(index, delta) {
      const target = index + delta;
      if (target < 0 || target >= rows.length) return;
      const moved = rows.splice(index, 1)[0];
      rows.splice(target, 0, moved);
      render(target);
    }

    function clearDropMarks() {
      for (const item of app.querySelectorAll('li')) item.classList.remove('drop-above', 'drop-below');
    }

    function render(focusIndex) {
      app.replaceChildren();
      app.append(node('h1', undefined, 'Interactive Rebase'));
      app.append(node('p', 'hint', 'The list runs oldest first, like Git. Drag a row by its handle (or press Alt+↑/↓), choose an action, then start the rebase.'));

      const list = node('ol');
      rows.forEach((row, index) => {
        const item = node('li');
        if (row.action === 'drop') item.classList.add('dropped');
        if (isFold(row.action)) item.classList.add('folded');

        // Only the handle starts a drag: a draggable row would swallow text
        // selection in the subject and the message editor.
        const grip = node('span', 'grip', '⋮⋮');
        grip.draggable = true;
        grip.title = t('Drag to reorder');
        grip.setAttribute('aria-hidden', 'true');
        grip.addEventListener('dragstart', (event) => {
          dragIndex = index;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', String(index));
          requestAnimationFrame(() => item.classList.add('dragging'));
        });
        grip.addEventListener('dragend', () => { dragIndex = undefined; clearDropMarks(); item.classList.remove('dragging'); });
        item.append(grip);

        item.append(node('span', 'order', String(index + 1)));

        const shell = node('div', 'select-shell');
        const select = node('select');
        select.setAttribute('aria-label', t('Action for commit') + ' ' + row.shortOid);
        for (const action of actions) {
          const option = node('option', undefined, action);
          option.value = action;
          option.title = t(ACTION_HELP[action] || '');
          if (action === row.action) option.selected = true;
          select.append(option);
        }
        select.title = t(ACTION_HELP[row.action] || '');
        select.addEventListener('change', () => {
          row.action = select.value;
          if (needsMessage(row.action) && !row.message) row.message = prefill(row, index);
          render(index);
        });
        shell.append(select);
        item.append(shell);

        const subject = node('div', 'subject');
        subject.append(node('span', 'oid', row.shortOid));
        subject.append(document.createTextNode(row.subject || '(no subject)'));
        subject.append(node('span', 'author', '  ' + row.author));
        item.append(subject);

        const moves = node('div', 'moves');
        const up = node('button', undefined, '↑');
        up.title = t('Move earlier');
        up.setAttribute('aria-label', t('Move earlier') + ' ' + row.shortOid);
        up.disabled = index === 0;
        up.addEventListener('click', () => move(index, -1));
        const down = node('button', undefined, '↓');
        down.title = t('Move later');
        down.setAttribute('aria-label', t('Move later') + ' ' + row.shortOid);
        down.disabled = index === rows.length - 1;
        down.addEventListener('click', () => move(index, 1));
        moves.append(up, down);
        item.append(moves);

        if (needsMessage(row.action)) {
          const editor = node('textarea');
          editor.value = row.message;
          editor.setAttribute('aria-label', t('Message for commit') + ' ' + row.shortOid);
          editor.addEventListener('input', () => { row.message = editor.value; refreshFooter(); });
          item.append(editor);
        }

        item.addEventListener('dragover', (event) => {
          if (dragIndex === undefined) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const rect = item.getBoundingClientRect();
          const before = event.clientY < rect.top + rect.height / 2;
          clearDropMarks();
          if (index === dragIndex) return;
          item.classList.add(before ? 'drop-above' : 'drop-below');
        });
        item.addEventListener('drop', (event) => {
          if (dragIndex === undefined) return;
          event.preventDefault();
          const rect = item.getBoundingClientRect();
          const before = event.clientY < rect.top + rect.height / 2;
          let insertAt = index + (before ? 0 : 1);
          if (dragIndex < insertAt) insertAt -= 1;
          const from = dragIndex;
          dragIndex = undefined;
          clearDropMarks();
          if (insertAt === from) return;
          const moved = rows.splice(from, 1)[0];
          rows.splice(insertAt, 0, moved);
          render(insertAt);
        });
        // IDEA's keyboard reorder, from anywhere inside the row. preventDefault
        // also keeps Alt+ArrowDown from opening the action dropdown.
        item.addEventListener('keydown', (event) => {
          if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
          event.preventDefault();
          move(index, event.key === 'ArrowUp' ? -1 : 1);
        });
        list.append(item);
      });
      app.append(list);

      const footer = node('footer');
      footer.append(node('span', 'problem'));
      const start = node('button', 'primary', 'Start Rebase');
      start.addEventListener('click', () => {
        vscode.postMessage({
          type: 'start',
          steps: rows.map((row) => ({ oid: row.oid, action: row.action, message: needsMessage(row.action) ? row.message : undefined })),
        });
      });
      const cancel = node('button', undefined, 'Cancel');
      cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
      footer.append(start, cancel);
      app.append(footer);
      refreshFooter();

      if (focusIndex !== undefined) {
        const focus = list.children[focusIndex]?.querySelector('select');
        if (focus) focus.focus();
      }
    }

    function refreshFooter() {
      const problem = localProblem();
      const label = app.querySelector('.problem');
      const start = app.querySelector('button.primary');
      if (label) { label.textContent = problem ? t(problem.text) : ''; label.classList.toggle('quiet', Boolean(problem && problem.quiet)); }
      if (start) start.disabled = Boolean(problem);
    }

    window.addEventListener('message', (event) => {
      const data = event.data;
      if (data.type === 'load') {
        actions = data.actions;
        rows = data.commits.map((commit) => ({
          oid: commit.oid,
          shortOid: commit.shortOid,
          subject: commit.subject,
          author: commit.author,
          action: 'pick',
          message: '',
          original: commit.message,
        }));
        originalOrder = data.commits.map((commit) => commit.oid);
        render();
      } else if (data.type === 'error') {
        const label = app.querySelector('.problem');
        if (label) { label.textContent = data.message; label.classList.remove('quiet'); }
      }
    });

    vscode.postMessage({ type: 'ready' });
  `;
}

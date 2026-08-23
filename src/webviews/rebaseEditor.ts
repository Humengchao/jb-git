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
  return `
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; }
    #app { padding: 12px 16px 72px; }
    h1 { font-size: 1.1em; margin: 0 0 4px; }
    .hint { color: var(--vscode-descriptionForeground); margin: 0 0 12px; }
    ol { list-style: none; margin: 0; padding: 0; }
    li { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-bottom: 6px; padding: 6px 8px; display: grid; grid-template-columns: auto auto 1fr auto; gap: 8px; align-items: start; }
    li.dropped .subject { text-decoration: line-through; opacity: 0.6; }
    li.folded { border-left: 3px solid var(--vscode-textLink-foreground); }
    .order { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; padding-top: 4px; }
    select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 2px; padding: 2px 4px; }
    .subject { padding-top: 4px; overflow-wrap: anywhere; }
    .oid { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); margin-right: 6px; }
    .author { color: var(--vscode-descriptionForeground); }
    textarea { grid-column: 3 / span 2; width: 100%; box-sizing: border-box; min-height: 64px; font-family: var(--vscode-editor-font-family); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; padding: 4px; resize: vertical; }
    .moves { display: flex; gap: 2px; }
    button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 2px; padding: 2px 6px; cursor: pointer; }
    button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { opacity: 0.4; cursor: default; }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 4px 14px; }
    button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    footer { position: fixed; bottom: 0; left: 0; right: 0; display: flex; align-items: center; gap: 10px; padding: 10px 16px; background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); }
    .problem { color: var(--vscode-errorForeground); flex: 1; }
    :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  `;
}

function script(): string {
  // The sandbox only reorders rows and labels them; every guarantee about which
  // commits may be rewritten is re-checked on the extension side.
  return `
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');
    let rows = [];
    let originalOrder = [];
    let actions = ['pick'];

    function node(tag, className, text) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
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

    function localProblem() {
      const applied = rows.filter((row) => row.action !== 'drop');
      if (!applied.length) return 'Dropping every commit would leave nothing to replay.';
      if (isFold(applied[0].action)) return 'The first replayed commit has nothing earlier to fold into.';
      for (const row of rows) {
        if (needsMessage(row.action) && !row.message.trim()) return 'A reword or squash needs a commit message.';
      }
      if (rows.every((row, index) => row.action === 'pick' && row.oid === originalOrder[index])) {
        return 'This plan leaves history unchanged.';
      }
      return '';
    }

    function move(index, delta) {
      const target = index + delta;
      if (target < 0 || target >= rows.length) return;
      const moved = rows.splice(index, 1)[0];
      rows.splice(target, 0, moved);
      render(target);
    }

    function render(focusIndex) {
      app.replaceChildren();
      app.append(node('h1', undefined, 'Interactive Rebase'));
      app.append(node('p', 'hint', 'The list runs oldest first, like Git. Reorder rows, choose an action, then start the rebase.'));

      const list = node('ol');
      rows.forEach((row, index) => {
        const item = node('li');
        if (row.action === 'drop') item.classList.add('dropped');
        if (isFold(row.action)) item.classList.add('folded');
        item.append(node('span', 'order', String(index + 1)));

        const select = node('select');
        select.setAttribute('aria-label', 'Action for commit ' + row.shortOid);
        for (const action of actions) {
          const option = node('option', undefined, action);
          option.value = action;
          if (action === row.action) option.selected = true;
          select.append(option);
        }
        select.addEventListener('change', () => {
          row.action = select.value;
          if (needsMessage(row.action) && !row.message) row.message = prefill(row, index);
          render(index);
        });
        item.append(select);

        const subject = node('div', 'subject');
        subject.append(node('span', 'oid', row.shortOid));
        subject.append(document.createTextNode(row.subject || '(no subject)'));
        subject.append(node('span', 'author', '  ' + row.author));
        item.append(subject);

        const moves = node('div', 'moves');
        const up = node('button', undefined, '↑');
        up.title = 'Move earlier';
        up.setAttribute('aria-label', 'Move ' + row.shortOid + ' earlier');
        up.disabled = index === 0;
        up.addEventListener('click', () => move(index, -1));
        const down = node('button', undefined, '↓');
        down.title = 'Move later';
        down.setAttribute('aria-label', 'Move ' + row.shortOid + ' later');
        down.disabled = index === rows.length - 1;
        down.addEventListener('click', () => move(index, 1));
        moves.append(up, down);
        item.append(moves);

        if (needsMessage(row.action)) {
          const editor = node('textarea');
          editor.value = row.message;
          editor.setAttribute('aria-label', 'Message for commit ' + row.shortOid);
          editor.addEventListener('input', () => { row.message = editor.value; refreshFooter(); });
          item.append(editor);
        }
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
      if (label) label.textContent = problem;
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
        if (label) label.textContent = data.message;
      }
    });

    vscode.postMessage({ type: 'ready' });
  `;
}

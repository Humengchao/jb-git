import * as path from "node:path";
import * as vscode from "vscode";
import { RepositoryManager } from "../repositoryManager";
import { GitBlameEntry, GitBlameOptions } from "../git/types";
import {
  BlameAnnotationOptions,
  DEFAULT_BLAME_ANNOTATION_OPTIONS,
  abbreviateHash,
  formatRelativeDate,
  formatShortDate,
  layoutBlameAnnotations,
} from "../blameAnnotations";
import { canonicalPath, deepestContaining } from "../pathRouting";
import { compileIssueRules, linkifyIssues } from "../issueNavigation";

/** What a document's annotations are reading: a path in a repository, optionally at a revision. */
export interface BlameTarget {
  repositoryRoot: string;
  relativePath: string;
  /** Absent means the working tree, which is also the only case that can be dirty. */
  revision?: string;
}

/** Recomputing on every keystroke would run Git per character. */
const RECOMPUTE_DEBOUNCE_MS = 400;

/**
 * IDEA's annotation gutter, drawn with editor decorations.
 *
 * VS Code does not let an extension write into the real line-number gutter, so
 * the annotation is a `before` attachment on each line: it lives inside the
 * editor's own text area, in the editor's font, which is why padding the
 * columns lines them up.
 *
 * An unsaved buffer is annotated through `git blame --contents`, so the
 * annotation follows the lines the user is typing instead of sliding out of
 * step with them the moment the document goes dirty.
 */
export class BlameAnnotationController implements vscode.Disposable {
  private readonly targets = new Map<string, BlameTarget>();
  private readonly entries = new Map<string, GitBlameEntry[]>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly registrations: vscode.Disposable[] = [];
  private disposed = false;

  private readonly decoration = vscode.window.createTextEditorDecorationType({
    // Keeping the attachment out of the document's own text means selecting a
    // line and copying it does not drag the annotation along.
    before: {
      margin: "0 1.5em 0 0",
      color: new vscode.ThemeColor("editorCodeLens.foreground"),
      // The attachment sits inside the line, so without this it inherits the
      // style of whatever token starts that line and the column comes out
      // italic on exactly the lines that begin with a keyword.
      fontStyle: "normal",
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  /**
   * IDEA highlights every line a commit touched when you point at one of them.
   * VS Code gives an extension no pointer position over a decoration, so the
   * caret leads instead: put it on a line and the rest of that commit lights up.
   */
  private readonly commitHighlight = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    // A bar down the left of every line the commit touched, which reads at a
    // glance and stays readable whatever the commit's size. Painting the lines
    // instead was either invisible (`rangeHighlight` is a few percent of white
    // in most themes) or overwhelming (`selectionHighlight` is loud, and a
    // commit that touched most of a file would then cover most of the screen).
    borderWidth: "0 0 0 2px",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("focusBorder"),
    backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
  });

  public constructor(
    private readonly manager: RepositoryManager,
    private readonly openRevision: (target: BlameTarget, content: Buffer) => Promise<vscode.Uri>,
  ) {
    this.registrations.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderAll()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (this.targets.has(event.textEditor.document.uri.toString())) this.renderCommitHighlight(event.textEditor);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.targets.has(event.document.uri.toString()) && event.contentChanges.length) {
          this.schedule(event.document);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => this.forget(document.uri)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        // The `-w`/`-M`/`-C` options change which commit owns a line, so they
        // need Git to run again; the rest only changes how it is drawn.
        if (event.affectsConfiguration("jbGit.blame.ignoreWhitespace")
          || event.affectsConfiguration("jbGit.blame.detectMovementsWithinFile")
          || event.affectsConfiguration("jbGit.blame.detectMovementsAcrossFiles")) {
          this.refresh();
        } else if (event.affectsConfiguration("jbGit.blame")) {
          this.renderAll();
        }
      }),
    );
  }

  public isAnnotated(uri: vscode.Uri): boolean {
    return this.targets.has(uri.toString());
  }

  /** Turns annotations on for a document, or off if they are already on. Returns the new state. */
  public async toggle(document: vscode.TextDocument): Promise<boolean> {
    if (this.targets.has(document.uri.toString())) {
      this.forget(document.uri);
      this.renderAll();
      return false;
    }
    const target = await this.resolveTarget(document.uri);
    if (!target) {
      await vscode.window.showInformationMessage("The active file is not inside a discovered Git repository.");
      return false;
    }
    await this.show(document, target);
    return true;
  }

  /** Annotates a document against an explicit target, which is how a revision opened from a hover is annotated. */
  public async show(document: vscode.TextDocument, target: BlameTarget): Promise<void> {
    this.targets.set(document.uri.toString(), target);
    await this.recompute(document);
  }

  public entryAt(uri: vscode.Uri, line: number): GitBlameEntry | undefined {
    return this.entries.get(uri.toString())?.find((entry) => entry.finalLine === line + 1);
  }

  public targetFor(uri: vscode.Uri): BlameTarget | undefined {
    return this.targets.get(uri.toString());
  }

  /** Re-reads every annotated document, which is what a commit or a checkout invalidates. */
  public refresh(): void {
    for (const document of vscode.workspace.textDocuments) {
      if (this.targets.has(document.uri.toString())) void this.recompute(document);
    }
  }

  /**
   * Opens the revision a line came from and annotates it.
   *
   * Git reports the previous commit *and the path in it*, so this follows a
   * rename backwards the way IDEA does instead of asking for today's path in
   * yesterday's tree.
   */
  public async annotatePrevious(uri: vscode.Uri, line: number): Promise<void> {
    const entry = this.entryAt(uri, line);
    const target = this.targets.get(uri.toString());
    if (!entry || !target) return;
    if (entry.uncommitted) {
      await vscode.window.showInformationMessage("This line is not committed yet, so it has no previous revision.");
      return;
    }
    if (!entry.previousHash || !entry.previousPath) {
      await vscode.window.showInformationMessage(
        entry.boundary
          ? "Git stopped walking the history here, so there is no previous revision to annotate."
          : "This line was added by the first commit that touched the file, so it has no previous revision.",
      );
      return;
    }
    await this.annotateAt({
      repositoryRoot: target.repositoryRoot,
      relativePath: entry.previousPath,
      revision: entry.previousHash,
    });
  }

  /**
   * Opens a file as it stood at `revision` and annotates it.
   *
   * Shared by "Annotate Previous Revision" and by annotating a revision the
   * user named, so both land on the same read-only revision document rather
   * than on two subtly different ones.
   */
  public async annotateAt(target: BlameTarget): Promise<void> {
    const repository = this.manager.snapshot(target.repositoryRoot)?.repository;
    if (!repository) return;
    const content = await repository.fileContent(target.relativePath, target.revision);
    const revisionUri = await this.openRevision(target, content);
    const document = await vscode.workspace.openTextDocument(revisionUri);
    await vscode.window.showTextDocument(document, { preview: false });
    await this.show(document, target);
  }

  private forget(uri: vscode.Uri): void {
    const key = uri.toString();
    const timer = this.pending.get(key);
    if (timer) clearTimeout(timer);
    this.pending.delete(key);
    this.targets.delete(key);
    this.entries.delete(key);
  }

  private schedule(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing);
    this.pending.set(key, setTimeout(() => {
      this.pending.delete(key);
      void this.recompute(document);
    }, RECOMPUTE_DEBOUNCE_MS));
  }

  private async resolveTarget(uri: vscode.Uri): Promise<BlameTarget | undefined> {
    if (uri.scheme !== "file") return undefined;
    const snapshot = deepestContaining(this.manager.all, await canonicalPath(uri.fsPath), (item) => item.repository.info.rootPath);
    if (!snapshot) return undefined;
    return {
      repositoryRoot: snapshot.repository.info.rootPath,
      relativePath: path.relative(snapshot.repository.info.rootPath, uri.fsPath),
    };
  }

  private async recompute(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    const target = this.targets.get(key);
    if (!target || this.disposed) return;
    try {
      // A saved working-tree file is blamed from disk; anything else is blamed
      // against the buffer, which is both what an unsaved edit needs and what
      // lets a read-only revision document be annotated at all.
      const contents = target.revision || document.isDirty ? document.getText() : undefined;
      const entries = await this.manager.blame(target.repositoryRoot, target.relativePath, target.revision, contents, readBlameOptions());
      // The document may have been closed, or the annotation turned off, while Git ran.
      if (this.disposed || !this.targets.has(key)) return;
      this.entries.set(key, entries);
      this.renderAll();
    } catch (error) {
      this.forget(document.uri);
      this.renderAll();
      await vscode.window.showWarningMessage(`JB Git could not annotate ${target.relativePath}: ${describe(error)}`);
    }
  }

  private renderAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.render(editor);
      this.renderCommitHighlight(editor);
    }
  }

  private render(editor: vscode.TextEditor): void {
    const entries = this.entries.get(editor.document.uri.toString());
    if (!entries?.length) {
      editor.setDecorations(this.decoration, []);
      return;
    }
    const options = readAnnotationOptions();
    const configuration = vscode.workspace.getConfiguration("jbGit");
    const heatMap = configuration.get<boolean>("blame.heatMap", true);
    // The revision being annotated, so its own lines can be marked the way IDEA
    // marks them. A working-tree annotation has no such revision.
    const annotated = this.targets.get(editor.document.uri.toString())?.revision;
    const lines = layoutBlameAnnotations(entries, options);
    const decorations: vscode.DecorationOptions[] = [];
    // The layout keeps the order of `entries`, so the entry a line came from is
    // its index. Searching for it instead would be quadratic in the file.
    for (const [index, line] of lines.entries()) {
      // Blame is of the file Git saw; a buffer edited since can be shorter.
      if (line.line < 0 || line.line >= editor.document.lineCount) continue;
      const entry = entries[index];
      const own = annotated !== undefined && entry.hash === annotated;
      decorations.push({
        range: new vscode.Range(line.line, 0, line.line, 0),
        hoverMessage: hover(entry, editor.document.uri, line.line),
        renderOptions: {
          before: {
            contentText: nonBreaking(line.text),
            ...(own ? { fontWeight: "bold" } : {}),
            ...(heatMap ? { backgroundColor: heatColor(line.heat) } : {}),
          },
        },
      });
    }
    editor.setDecorations(this.decoration, decorations);
  }

  /** Lights up every line the caret's commit touched, which is IDEA's hover behaviour. */
  private renderCommitHighlight(editor: vscode.TextEditor): void {
    const entries = this.entries.get(editor.document.uri.toString());
    const enabled = vscode.workspace.getConfiguration("jbGit").get<boolean>("blame.highlightCommit", true);
    if (!entries?.length || !enabled) {
      editor.setDecorations(this.commitHighlight, []);
      return;
    }
    const caret = editor.selection.active.line;
    const current = entries.find((entry) => entry.finalLine === caret + 1);
    // An uncommitted line has no commit to gather, and gathering every other
    // uncommitted line would highlight unrelated edits.
    if (!current || current.uncommitted) {
      editor.setDecorations(this.commitHighlight, []);
      return;
    }
    const ranges: vscode.Range[] = [];
    for (const entry of entries) {
      if (entry.hash !== current.hash) continue;
      const line = entry.finalLine - 1;
      if (line < 0 || line >= editor.document.lineCount) continue;
      ranges.push(new vscode.Range(line, 0, line, 0));
    }
    editor.setDecorations(this.commitHighlight, ranges);
  }

  public dispose(): void {
    this.disposed = true;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    for (const registration of this.registrations) registration.dispose();
    this.decoration.dispose();
    this.commitHighlight.dispose();
    this.targets.clear();
    this.entries.clear();
  }
}

/** IDEA's annotation Options, which decide what Git looks through before crediting a line. */
export function readBlameOptions(): GitBlameOptions {
  const configuration = vscode.workspace.getConfiguration("jbGit");
  return {
    ignoreWhitespace: configuration.get<boolean>("blame.ignoreWhitespace", false),
    detectMovementsWithinFile: configuration.get<boolean>("blame.detectMovementsWithinFile", false),
    detectMovementsAcrossFiles: configuration.get<boolean>("blame.detectMovementsAcrossFiles", false),
  };
}

export function readAnnotationOptions(now = Date.now()): BlameAnnotationOptions {
  const configuration = vscode.workspace.getConfiguration("jbGit");
  return {
    showAuthor: configuration.get<boolean>("blame.showAuthor", DEFAULT_BLAME_ANNOTATION_OPTIONS.showAuthor),
    showDate: configuration.get<boolean>("blame.showDate", DEFAULT_BLAME_ANNOTATION_OPTIONS.showDate),
    showRevision: configuration.get<boolean>("blame.showRevision", DEFAULT_BLAME_ANNOTATION_OPTIONS.showRevision),
    dateFormat: configuration.get<"short" | "relative">("blame.dateFormat", DEFAULT_BLAME_ANNOTATION_OPTIONS.dateFormat),
    maxAuthorWidth: configuration.get<number>("blame.maxAuthorWidth", DEFAULT_BLAME_ANNOTATION_OPTIONS.maxAuthorWidth),
    now,
  };
}

/**
 * Ages a line from cool to warm.
 *
 * The alpha stays low because this paints behind the annotation text, and the
 * hue carries the age so it still reads in a light and a dark theme.
 */
export function heatColor(heat: number): string {
  const clamped = Math.min(1, Math.max(0, heat));
  // 210deg (cool blue, oldest) to 30deg (warm amber, newest).
  const hue = Math.round(210 - clamped * 180);
  return `hsla(${hue}, 70%, 50%, ${(0.10 + clamped * 0.18).toFixed(3)})`;
}

/**
 * Keeps the padding that lines the columns up.
 *
 * A decoration's text is drawn through CSS `content`, where a run of ordinary
 * spaces can collapse to a single one and an empty string takes no width at
 * all. Either would ragged the column, and the second would drop the blank
 * annotation an uncommitted line is supposed to hold open. A no-break space
 * measures the same in a monospace font and survives both.
 */
export function nonBreaking(text: string): string {
  return text.replace(/ /g, "\u00a0");
}

function markdownEscape(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (character) => `\\${character}`);
}

function hover(entry: GitBlameEntry, uri: vscode.Uri, line: number): vscode.MarkdownString {
  const message = new vscode.MarkdownString(undefined, true);
  // The command links below are ours, so the hover has to be allowed to run them.
  message.isTrusted = true;
  if (entry.uncommitted) {
    message.appendMarkdown("$(git-commit) **Not committed yet**\n\nThis line is not in any commit.");
    return message;
  }
  const argument = encodeURIComponent(JSON.stringify([{ uri: uri.toString(), line }]));
  message.appendMarkdown(`**${issueLinkedMarkdown(entry.summary || "(no commit message)")}**\n\n`);
  message.appendMarkdown(`${markdownEscape(entry.author)}${entry.authorMail ? ` <${markdownEscape(entry.authorMail)}>` : ""}\n\n`);
  message.appendMarkdown(`${formatShortDate(entry)} · ${formatRelativeDate(entry, Date.now())}\n\n`);
  message.appendMarkdown(`\`${abbreviateHash(entry.hash)}\`  ·  ${markdownEscape(entry.filename)}\n\n`);
  message.appendMarkdown(`[Show Commit](command:jbGit.blameShowCommit?${argument})`);
  message.appendMarkdown(` · [Copy Revision](command:jbGit.copyRevisionNumber?${argument})`);
  message.appendMarkdown(` · [Annotate Previous Revision](command:jbGit.annotatePreviousRevision?${argument})`);
  return message;
}

/** The commit subject with configured issue ids linked, IDEA's Issue Navigation in the hover. */
function issueLinkedMarkdown(summary: string): string {
  const rules = compileIssueRules(vscode.workspace.getConfiguration("jbGit").get<unknown[]>("issueNavigation", []));
  return linkifyIssues(summary, rules)
    .map((segment) => (segment.url ? `[${markdownEscape(segment.text)}](${segment.url})` : markdownEscape(segment.text)))
    .join("");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

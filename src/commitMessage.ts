/**
 * What Git will actually record for a typed commit message.
 *
 * With `commit.template` configured, Git's own editor drops the comment lines
 * the template carries, and JB Git commits with `--cleanup=strip` to match.
 * That means a message which is nothing but those comments becomes empty, and
 * Git aborts the commit — so the same rule has to be applied before the commit
 * is attempted, both to enable the button and to explain the refusal.
 */

/** Git's default comment character; `core.commentChar` can replace it. */
export const DEFAULT_COMMENT_CHAR = "#";

/**
 * The message with comment lines removed, the way `--cleanup=strip` removes
 * them: a line is a comment when its first non-whitespace character is the
 * comment character. Trailing whitespace and leading/trailing blank lines go
 * too, which is what makes "only comments" come out empty.
 */
export function stripCommentLines(message: string, commentChar: string = DEFAULT_COMMENT_CHAR): string {
  const marker = commentChar || DEFAULT_COMMENT_CHAR;
  return message
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(marker))
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/**
 * The text Git will keep. `stripComments` mirrors whether the commit runs with
 * `--cleanup=strip`, which JB Git turns on exactly when a commit template is
 * configured.
 */
export function effectiveCommitMessage(message: string, stripComments: boolean, commentChar: string = DEFAULT_COMMENT_CHAR): string {
  return stripComments ? stripCommentLines(message, commentChar) : message.trim();
}

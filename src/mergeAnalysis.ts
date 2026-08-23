/**
 * Base-aware analysis of a three-way merge.
 *
 * Git's working-tree conflict only shows the two sides, which is not enough to
 * resolve one correctly: the same block of text means very different things
 * depending on whether a side changed it or merely kept what was already there.
 * Recomputing the merge in `diff3` style keeps the base text with every
 * conflict, so each block can be classified and the mechanical ones resolved
 * without asking the user to guess.
 */

/** A run of text both sides agreed on, or a conflict Git could not settle. */
export type MergeBlock =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "conflict"; readonly ours: string; readonly base: string; readonly theirs: string };

/**
 * What a conflict actually represents once the base is known.
 *
 * - `identical`: both sides made the same edit.
 * - `ours-only` / `theirs-only`: one side kept the base text, so the other side's edit is the only change.
 * - `whitespace`: the sides differ only in whitespace.
 * - `conflict`: both sides changed the same text differently, which needs a human.
 */
export type ConflictKind = "identical" | "ours-only" | "theirs-only" | "whitespace" | "conflict";

/** Conflicts that can be resolved mechanically, because only one outcome preserves both sides' intent. */
const RESOLVABLE = new Set<ConflictKind>(["identical", "ours-only", "theirs-only", "whitespace"]);

export function isResolvable(kind: ConflictKind): boolean {
  return RESOLVABLE.has(kind);
}

/**
 * Classifies a conflict against its base.
 *
 * Order matters: an identical edit is reported before the one-sided cases so a
 * block both sides deleted is not described as one side's deletion.
 */
export function classifyConflict(ours: string, base: string, theirs: string): ConflictKind {
  if (ours === theirs) return "identical";
  if (ours === base) return "theirs-only";
  if (theirs === base) return "ours-only";
  // Whitespace-only disagreement is a formatting collision, not a semantic one.
  if (collapseWhitespace(ours) === collapseWhitespace(theirs)) return "whitespace";
  return "conflict";
}

/**
 * The text a resolvable conflict settles on.
 *
 * A whitespace-only disagreement keeps our side, matching how Git's own
 * whitespace-insensitive merge options break the tie, and returns undefined for
 * a real conflict so callers cannot resolve one by accident.
 */
export function resolutionFor(block: { ours: string; base: string; theirs: string }): string | undefined {
  const kind = classifyConflict(block.ours, block.base, block.theirs);
  if (kind === "conflict") return undefined;
  return kind === "theirs-only" ? block.theirs : block.ours;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

/** Matches a conflict marker line, allowing the configurable marker length Git supports. */
const OURS_MARKER = /^<{7,}(?: |$)/;
const BASE_MARKER = /^\|{7,}(?: |$)/;
const SPLIT_MARKER = /^={7,}$/;
const THEIRS_MARKER = /^>{7,}(?: |$)/;

export interface Diff3Parse {
  readonly blocks: MergeBlock[];
  /**
   * True when a `<<<<<<<` line could not be read as a complete conflict.
   *
   * That happens when the file's own content contains conflict markers, and it
   * means the surrounding blocks may be framed wrongly. Auto-resolving a
   * mis-framed block would silently corrupt the file, so callers must stop
   * rather than guess.
   */
  readonly ambiguous: boolean;
}

/**
 * Splits `diff3`-style merge output into blocks.
 *
 * Anything that is not a complete, well-formed conflict is kept as literal
 * text: a half-written marker must never be silently reinterpreted, because
 * that would drop one side of the user's file.
 */
export function parseDiff3(text: string): Diff3Parse {
  const lines = text.split("\n");
  const blocks: MergeBlock[] = [];
  let plain: string[] = [];
  let ambiguous = false;

  const flush = (): void => {
    if (plain.length === 0) return;
    blocks.push({ kind: "text", text: plain.join("\n") });
    plain = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    if (!OURS_MARKER.test(lines[index])) {
      plain.push(lines[index]);
      continue;
    }
    const parsed = readConflict(lines, index);
    if (!parsed) {
      ambiguous = true;
      plain.push(lines[index]);
      continue;
    }
    flush();
    blocks.push(parsed.block);
    index = parsed.end;
  }
  flush();
  return { blocks, ambiguous };
}

/** Reads one complete conflict starting at an `<<<<<<<` line, or nothing when it is malformed. */
function readConflict(lines: readonly string[], start: number): { block: MergeBlock; end: number } | undefined {
  const ours: string[] = [];
  const base: string[] = [];
  const theirs: string[] = [];
  let section: "ours" | "base" | "theirs" = "ours";

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    // A nested `<<<<<<<` means the outer block is not a conflict we can trust.
    if (OURS_MARKER.test(line)) return undefined;
    if (BASE_MARKER.test(line)) {
      if (section !== "ours") return undefined;
      section = "base";
      continue;
    }
    if (SPLIT_MARKER.test(line)) {
      // Without a base section this is a plain two-way conflict, which carries
      // no information about what either side started from.
      if (section !== "base") return undefined;
      section = "theirs";
      continue;
    }
    if (THEIRS_MARKER.test(line)) {
      if (section !== "theirs") return undefined;
      return {
        block: { kind: "conflict", ours: join(ours), base: join(base), theirs: join(theirs) },
        end: index,
      };
    }
    (section === "ours" ? ours : section === "base" ? base : theirs).push(line);
  }
  return undefined;
}

function join(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * Renders an unresolved conflict back into Git's default two-way markers.
 *
 * The base section is deliberately dropped: the working-tree file has to stay
 * in the form the conflict editor and every other Git tool already parse. The
 * base text remains available on the block itself for callers that display it.
 */
function renderConflict(block: { ours: string; theirs: string }, labels: Diff3Labels): string {
  return [
    `<<<<<<< ${labels.ours}`,
    ...sectionLines(block.ours),
    "=======",
    ...sectionLines(block.theirs),
    `>>>>>>> ${labels.theirs}`,
  ].join("\n");
}

/** Reverses `join`: a stored section keeps a trailing newline, which is not a final empty line. */
function sectionLines(value: string): string[] {
  return value === "" ? [] : value.slice(0, -1).split("\n");
}

export interface Diff3Labels {
  readonly ours: string;
  readonly base: string;
  readonly theirs: string;
}

export interface AutoResolution {
  /** The merged text with every mechanically resolvable conflict settled. */
  readonly text: string;
  /** How many conflicts were resolved. */
  readonly resolved: number;
  /** How many conflicts still need a human. */
  readonly remaining: number;
}

/**
 * Resolves every mechanical conflict and leaves the rest as ordinary two-way
 * conflict markers, which is what the editor and Git both already parse.
 */
export function resolveSimpleConflicts(blocks: readonly MergeBlock[], labels: Diff3Labels): AutoResolution {
  let resolved = 0;
  let remaining = 0;
  const parts = blocks.map((block) => {
    if (block.kind === "text") return block.text;
    const resolution = resolutionFor(block);
    if (resolution !== undefined) {
      resolved += 1;
      return trimTrailingNewline(resolution);
    }
    remaining += 1;
    return renderConflict(block, labels);
  });
  return { text: parts.join("\n"), resolved, remaining };
}

/** Counts each conflict by what it turned out to be, for a summary the user can act on. */
export function summarize(blocks: readonly MergeBlock[]): Record<ConflictKind, number> {
  const counts: Record<ConflictKind, number> = {
    identical: 0, "ours-only": 0, "theirs-only": 0, whitespace: 0, conflict: 0,
  };
  for (const block of blocks) {
    if (block.kind !== "conflict") continue;
    counts[classifyConflict(block.ours, block.base, block.theirs)] += 1;
  }
  return counts;
}

function trimTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

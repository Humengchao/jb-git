/**
 * Tracks conflicts in a merge result that no longer carries Git's markers.
 *
 * IDEA's merge pane shows clean file content and marks each unresolved conflict
 * as a coloured region, never as `<<<<<<<` text. Removing the markers means the
 * conflicts can no longer be recovered by re-parsing the text, so each one is
 * held as a character range and moved as the user edits around it.
 *
 * The whole model is pure so it can be tested without a Webview: the editor only
 * feeds it the old text, the new text, and which side a button chose.
 */

/** One conflict, located in the current result text. */
export interface MergeRegion {
  /** Offset of the region's first character in the result text. */
  readonly start: number;
  /** Offset one past the region's last character. */
  readonly end: number;
  /** The competing versions, kept so a side can still be applied later. */
  readonly ours: string;
  readonly theirs: string;
  /**
   * What both sides started from, when it is known.
   *
   * Git's working-tree conflict carries only the two sides, so this is filled
   * in from a separate `diff3` replay and stays undefined whenever that replay
   * could not be trusted to describe the same conflicts.
   */
  readonly base?: string;
  /** How the region reached its current text, or undefined while it is unresolved. */
  readonly resolution?: "ours" | "theirs" | "both" | "manual" | "ignored";
}

export interface MergeModel {
  /** File content with no conflict markers: what the user reads and what Apply writes. */
  readonly text: string;
  readonly regions: readonly MergeRegion[];
}

/** A single contiguous replacement, which is what any edit reduces to. */
export interface TextDelta {
  readonly start: number;
  readonly oldEnd: number;
  readonly newEnd: number;
}

const START_MARKER = /^<{7,}[^\r\n]*(?:\r?\n|$)/gm;

/**
 * Reduces an edit to one replaced range by matching the common prefix and
 * suffix. Any edit a textarea can produce, including a paste or an undo, is a
 * single replacement once its unchanged ends are removed.
 */
export function textDelta(before: string, after: string): TextDelta {
  let start = 0;
  const limit = Math.min(before.length, after.length);
  while (start < limit && before[start] === after[start]) start += 1;
  let suffix = 0;
  while (
    suffix < before.length - start
    && suffix < after.length - start
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  return { start, oldEnd: before.length - suffix, newEnd: after.length - suffix };
}

/**
 * Converts a conflicted working-tree file into clean text plus regions.
 *
 * An unresolved region shows our side, which is the version already on the
 * branch; the incoming side stays available on the region and is shown in the
 * right-hand pane, so nothing is hidden from the user.
 */
export function buildModel(markerText: string): MergeModel {
  const regions: MergeRegion[] = [];
  let text = "";
  let cursor = 0;
  START_MARKER.lastIndex = 0;
  let start: RegExpExecArray | null;
  while ((start = START_MARKER.exec(markerText))) {
    const parsed = readConflict(markerText, start);
    if (!parsed) break;
    text += markerText.slice(cursor, start.index);
    regions.push({
      start: text.length,
      end: text.length + parsed.ours.length,
      ours: parsed.ours,
      theirs: parsed.theirs,
      ...(parsed.base === undefined ? {} : { base: parsed.base }),
    });
    text += parsed.ours;
    cursor = parsed.end;
    START_MARKER.lastIndex = parsed.end;
  }
  text += markerText.slice(cursor);
  return { text, regions };
}

/** Reads the `ours`/`theirs` sections that follow a `<<<<<<<` line, and the base when the conflict carries one. */
function readConflict(text: string, start: RegExpExecArray): { ours: string; theirs: string; base?: string; end: number } | undefined {
  const from = start.index + start[0].length;
  const baseMarker = matchAt(/^\|{7,}[^\r\n]*(?:\r?\n|$)/gm, text, from);
  const divider = matchAt(/^={7,}(?:\r?\n|$)/gm, text, from);
  if (!divider) return undefined;
  const end = matchAt(/^>{7,}[^\r\n]*(?:\r?\n|$)/gm, text, divider.index + divider[0].length);
  if (!end) return undefined;
  // A diff3-style conflict puts the base between ours and the divider.
  const hasBase = baseMarker !== null && baseMarker.index < divider.index;
  const oursEnd = hasBase ? baseMarker.index : divider.index;
  return {
    ours: text.slice(from, oursEnd),
    theirs: text.slice(divider.index + divider[0].length, end.index),
    ...(hasBase ? { base: text.slice(baseMarker.index + baseMarker[0].length, divider.index) } : {}),
    end: end.index + end[0].length,
  };
}

function matchAt(pattern: RegExp, text: string, from: number): RegExpExecArray | null {
  pattern.lastIndex = from;
  return pattern.exec(text);
}

/**
 * Moves regions to follow an edit.
 *
 * A region the edit reached is marked `manual`: the user rewrote that text
 * themselves, so the tool must stop claiming it is unresolved, and must never
 * later overwrite it with a side the user did not ask for.
 *
 * One edit can reach more than one region — selecting across the boundary
 * between two adjacent conflicts and typing is enough — and then no part of
 * the new text belongs to either change on its own, so they become a single
 * region. Growing each of them separately produced ranges that overlapped, and
 * `toMarkerText` walks the ranges in order, so a serialized draft came back
 * with text duplicated. The surviving sides are concatenated in order, which
 * keeps revert and apply meaningful across the whole span.
 */
export function applyEdit(regions: readonly MergeRegion[], delta: TextDelta): MergeRegion[] {
  const shift = delta.newEnd - delta.oldEnd;
  const before: MergeRegion[] = [];
  const touched: MergeRegion[] = [];
  const after: MergeRegion[] = [];
  for (const region of regions) {
    if (region.end <= delta.start) before.push(region);
    else if (region.start >= delta.oldEnd) after.push({ ...region, start: region.start + shift, end: region.end + shift });
    else touched.push(region);
  }
  if (touched.length === 0) return [...before, ...after];
  const start = Math.min(delta.start, touched[0].start);
  const end = Math.max(delta.newEnd, touched[touched.length - 1].end + shift);
  const bases = touched.map((region) => region.base);
  return [...before, {
    start,
    end: Math.max(start, end),
    ours: touched.map((region) => region.ours).join(""),
    theirs: touched.map((region) => region.theirs).join(""),
    // Only a span whose every part knew its base can describe one.
    ...(bases.every((base) => base !== undefined) ? { base: bases.join("") } : {}),
    resolution: "manual" as const,
  }, ...after];
}

/** Replaces one region with the chosen side and moves the regions after it. */
export function resolveRegion(
  model: MergeModel,
  index: number,
  side: "ours" | "theirs" | "both",
): MergeModel {
  const region = model.regions[index];
  if (!region) return model;
  const replacement = side === "both" ? joinSides(region.ours, region.theirs) : region[side];
  const text = model.text.slice(0, region.start) + replacement + model.text.slice(region.end);
  const shift = replacement.length - (region.end - region.start);
  const regions = model.regions.map((other, position) => {
    if (position === index) return { ...other, end: other.start + replacement.length, resolution: side };
    // Regions are held in order, so position decides what moves. Comparing
    // offsets instead reordered a zero-length region that shared this one's
    // start — a conflict that took nothing from one side is exactly that — and
    // the resulting overlap made `toMarkerText` duplicate text.
    if (position > index) return { ...other, start: other.start + shift, end: other.end + shift };
    return other;
  });
  return { text, regions };
}

/**
 * Marks a region handled without changing its text, which is IDEA's `×` gutter
 * action: the user looked at the change and chose to keep the result as it is.
 */
export function ignoreRegion(model: MergeModel, index: number): MergeModel {
  const region = model.regions[index];
  if (!region || region.resolution !== undefined) return model;
  return {
    text: model.text,
    regions: model.regions.map((other, position) => (position === index ? { ...other, resolution: "ignored" as const } : other)),
  };
}

/**
 * Puts a region back to unresolved, showing our side again.
 *
 * This is IDEA's revert gutter action, and the only way back into a change
 * after a wrong button: without it a mis-click is only undoable by resetting
 * the whole file, which throws away every other decision as well.
 */
export function resetRegion(model: MergeModel, index: number): MergeModel {
  const region = model.regions[index];
  if (!region || region.resolution === undefined) return model;
  const text = model.text.slice(0, region.start) + region.ours + model.text.slice(region.end);
  const shift = region.ours.length - (region.end - region.start);
  const regions = model.regions.map((other, position) => {
    // Rebuilt without a resolution rather than spread, so the region is
    // indistinguishable from one buildModel just produced. The base is not a
    // decision, so it survives.
    if (position === index) {
      return {
        start: other.start,
        end: other.start + region.ours.length,
        ours: other.ours,
        theirs: other.theirs,
        ...(other.base === undefined ? {} : { base: other.base }),
      };
    }
    if (position > index) return { ...other, start: other.start + shift, end: other.end + shift };
    return other;
  });
  return { text, regions };
}

/** Keeps both sides, adding the separator Git would have needed between them. */
function joinSides(ours: string, theirs: string): string {
  if (!ours || !theirs) return ours + theirs;
  return /\r?\n$/.test(ours) ? ours + theirs : `${ours}\n${theirs}`;
}

export function unresolved(regions: readonly MergeRegion[]): number {
  return regions.filter((region) => region.resolution === undefined).length;
}

/**
 * Restores the marker form, used only to hand a still-conflicted result back to
 * a draft or to Git. Resolved regions contribute their settled text.
 */
export function toMarkerText(model: MergeModel, labels: { ours: string; theirs: string }): string {
  let output = "";
  let cursor = 0;
  for (const region of model.regions) {
    output += model.text.slice(cursor, region.start);
    if (region.resolution === undefined) {
      // A conflict marker exists only as a whole line. An edit can leave an
      // unresolved region mid-line — deleting the line break just above it is
      // enough, and that edit does not touch the region itself, so it stays
      // unresolved — and a `<<<<<<<` that does not start a line is not found
      // again on the way back in, so the conflict would vanish out of the
      // restored draft. The break goes back in; the closing marker has always
      // ended its own line for the same reason.
      if (output && !output.endsWith("\n")) output += "\n";
      output += `<<<<<<< ${labels.ours}\n${line(region.ours)}=======\n${line(region.theirs)}>>>>>>> ${labels.theirs}\n`;
    } else {
      output += model.text.slice(region.start, region.end);
    }
    cursor = region.end;
  }
  return output + model.text.slice(cursor);
}

/** A marker section is a run of whole lines, or nothing at all. */
function line(value: string): string {
  return value === "" || value.endsWith("\n") ? value : `${value}\n`;
}

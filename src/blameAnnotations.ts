import { GitBlameEntry } from "./git/types";

export type BlameDateFormat = "short" | "relative";

export interface BlameAnnotationOptions {
  showAuthor: boolean;
  showDate: boolean;
  showRevision: boolean;
  dateFormat: BlameDateFormat;
  /** Epoch milliseconds. Passed in so a relative date is deterministic in tests. */
  now: number;
  /** Long names otherwise push the code off screen; the rest is in the hover. */
  maxAuthorWidth: number;
}

export interface BlameAnnotationLine {
  /** Zero-based editor line. */
  line: number;
  /** Already padded, so every field lines up down the column. */
  text: string;
  hash: string;
  uncommitted: boolean;
  /** First line of a run of the same commit, which is where the separator is drawn. */
  startsRun: boolean;
  /** 0 for the oldest commit in this file, 1 for the newest. */
  heat: number;
}

export const DEFAULT_BLAME_ANNOTATION_OPTIONS: Omit<BlameAnnotationOptions, "now"> = {
  showAuthor: true,
  showDate: true,
  showRevision: false,
  dateFormat: "short",
  maxAuthorWidth: 20,
};

/** IDEA shows eight characters of the object name, which stays unique in a large repository. */
export function abbreviateHash(hash: string): string {
  return hash.slice(0, 8);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Splits a commit's own wall-clock time out of its timestamp.
 *
 * `git blame` prints the author's local date, not the reader's, so the same
 * line reads the same way for everyone and a test does not depend on the
 * timezone of the machine running it.
 */
export function authorLocalTime(entry: GitBlameEntry): Date {
  const match = /^([+-])(\d{2})(\d{2})$/.exec(entry.authorTimezone);
  const offsetMinutes = match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  return new Date((entry.authorTimestamp + offsetMinutes * 60) * 1000);
}

export function formatShortDate(entry: GitBlameEntry): string {
  const local = authorLocalTime(entry);
  return `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}`;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

export function formatRelativeDate(entry: GitBlameEntry, now: number): string {
  const seconds = Math.floor(now / 1000) - entry.authorTimestamp;
  // A commit stamped in the future is clock skew, not a prediction.
  if (seconds < MINUTE) return "just now";
  if (seconds < HOUR) return plural(Math.floor(seconds / MINUTE), "minute");
  if (seconds < DAY) return plural(Math.floor(seconds / HOUR), "hour");
  if (seconds < MONTH) return plural(Math.floor(seconds / DAY), "day");
  if (seconds < YEAR) return plural(Math.floor(seconds / MONTH), "month");
  return plural(Math.floor(seconds / YEAR), "year");
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(1, width - 1))}…`;
}

/**
 * Turns blame entries into one padded annotation per line.
 *
 * `heat` is relative to this file's own commit range rather than to an
 * absolute age, so a file whose history is entirely old still shows which of
 * its parts moved most recently.
 */
export function layoutBlameAnnotations(
  entries: readonly GitBlameEntry[],
  options: BlameAnnotationOptions,
): BlameAnnotationLine[] {
  const committed = entries.filter((entry) => !entry.uncommitted && entry.authorTimestamp > 0);
  const oldest = committed.length ? Math.min(...committed.map((entry) => entry.authorTimestamp)) : 0;
  const newest = committed.length ? Math.max(...committed.map((entry) => entry.authorTimestamp)) : 0;
  const span = newest - oldest;

  const fields = entries.map((entry) => {
    // IDEA leaves the annotation of a line that is in no commit blank rather
    // than inventing an author for it; the hover still explains it.
    if (entry.uncommitted) return { author: "", date: "", hash: "" };
    return {
      author: options.showAuthor ? truncate(entry.author, options.maxAuthorWidth) : "",
      date: options.showDate ? (options.dateFormat === "relative" ? formatRelativeDate(entry, options.now) : formatShortDate(entry)) : "",
      hash: options.showRevision ? abbreviateHash(entry.hash) : "",
    };
  });

  const width = (key: "author" | "date" | "hash"): number => fields.reduce((widest, field) => Math.max(widest, field[key].length), 0);
  const authorWidth = width("author");
  const dateWidth = width("date");
  const hashWidth = width("hash");

  return entries.map((entry, index) => {
    const field = fields[index];
    const columns: string[] = [];
    if (authorWidth) columns.push(field.author.padEnd(authorWidth));
    if (dateWidth) columns.push(field.date.padEnd(dateWidth));
    if (hashWidth) columns.push(field.hash.padEnd(hashWidth));
    return {
      line: entry.finalLine - 1,
      text: columns.join(" "),
      hash: entry.hash,
      uncommitted: entry.uncommitted,
      startsRun: index === 0 || entries[index - 1].hash !== entry.hash,
      // Work you have not committed is the newest thing in the file by definition.
      heat: entry.uncommitted ? 1 : span > 0 ? (entry.authorTimestamp - oldest) / span : 1,
    };
  });
}

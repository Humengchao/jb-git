/**
 * IDEA's Issue Navigation: patterns that turn an issue id in a commit message
 * into a link to the tracker.
 *
 * Pure so the same rules serve the host (Blame hover markdown) and the Webview
 * (commit details), and so the splitting is testable without either.
 */

export interface IssueNavigationRule {
  /** JavaScript regular expression source, e.g. `[A-Z]+-\d+`. */
  readonly pattern: string;
  /** Target with `$0` for the whole match and `$1`…`$9` for groups. */
  readonly url: string;
}

export interface IssueLinkSegment {
  readonly text: string;
  /** Present on the segments that matched a rule. */
  readonly url?: string;
}

interface CompiledRule {
  readonly expression: RegExp;
  readonly url: string;
}

/** Keep untrusted workspace settings from turning every rendered message into
 * an unbounded regular-expression or URL parser workload. */
const MAX_RULES = 100;
const MAX_PATTERN_LENGTH = 512;
const MAX_URL_LENGTH = 2_048;
const MAX_SCAN_TEXT_LENGTH = 100_000;
const MAX_MATCHES = 5_000;

/**
 * Issue links are ordinary web links.  In particular, a workspace setting
 * must never be able to manufacture a `command:`/`javascript:` link that is
 * later rendered inside a trusted Markdown hover.
 */
export function safeIssueUrl(value: string): string | undefined {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (parsed.username || parsed.password) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

/** A conservative guard against the most common catastrophic nested quantifiers. */
function looksCatastrophic(pattern: string): boolean {
  // This is deliberately a rejection heuristic, not a regex parser.  Rules
  // that do not match this shape still run under the bounded message inputs.
  return /\([^()]*[+*?][^()]*\)[+*?{]/.test(pattern)
    || /\([^()]*\{\d+,\}[^()]*\)[+*{]/.test(pattern)
    || /\([^()]*\|[^()]*\)[+*{]/.test(pattern);
}

/**
 * Compiles the configured rules, dropping the ones that cannot work.
 *
 * A malformed pattern must cost that one rule, not the whole feature, and a
 * pattern that matches the empty string would loop forever, so it is dropped
 * too.
 */
export function compileIssueRules(rules: readonly unknown[]): CompiledRule[] {
  if (!Array.isArray(rules)) return [];
  const compiled: CompiledRule[] = [];
  for (const rule of rules.slice(0, MAX_RULES)) {
    if (typeof rule !== "object" || rule === null) continue;
    const { pattern, url } = rule as Record<string, unknown>;
    if (typeof pattern !== "string" || typeof url !== "string"
      || !pattern || !url || pattern.length > MAX_PATTERN_LENGTH || looksCatastrophic(pattern)) continue;
    try {
      const expression = new RegExp(pattern, "g");
      if (expression.test("")) continue;
      expression.lastIndex = 0;
      // Validate the template itself when it has no captures.  Templates with
      // captures are validated after substitution in targetFor().
      if (!safeIssueUrl(url.replace(/\$(\d)/g, ""))) continue;
      compiled.push({ expression, url });
    } catch {
      // The broken pattern is skipped; the others still link.
    }
  }
  return compiled;
}

function targetFor(url: string, match: RegExpExecArray): string | undefined {
  return safeIssueUrl(url.replace(/\$(\d)/g, (_whole, digit) => match[Number(digit)] ?? ""));
}

/**
 * Splits text into plain and linked segments.
 *
 * Rules are applied in order and an earlier match wins overlapping text, which
 * is what makes the configuration predictable: put the more specific tracker
 * first.
 */
export function linkifyIssues(text: string, rules: readonly CompiledRule[]): IssueLinkSegment[] {
  if (!text || !Array.isArray(rules) || rules.length === 0) return text ? [{ text }] : [];
  const scanText = text.length > MAX_SCAN_TEXT_LENGTH ? text.slice(0, MAX_SCAN_TEXT_LENGTH) : text;
  // Accepted ranges stay sorted, so overlap checks remain O(log n) even for a
  // broad rule such as `.` over a long commit body.
  const matches: Array<{ start: number; end: number; url: string }> = [];
  const overlaps = (start: number, end: number): boolean => {
    let low = 0; let high = matches.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (matches[middle].start < start) low = middle + 1;
      else high = middle;
    }
    return (matches[low - 1] !== undefined && matches[low - 1].end > start)
      || (matches[low] !== undefined && matches[low].start < end);
  };
  rulesLoop: for (const rule of rules) {
    rule.expression.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.expression.exec(scanText))) {
      const start = match.index;
      const end = start + match[0].length;
      // JavaScript's RegExp.exec does not advance lastIndex for a zero-width
      // global match (lookarounds and word boundaries are common examples).
      // Skip it and force progress, otherwise a workspace setting can freeze
      // the extension host synchronously.
      if (end === start) {
        rule.expression.lastIndex = start + 1;
        continue;
      }
      const target = targetFor(rule.url, match);
      if (target && !overlaps(start, end)) {
        let insertion = 0; let high = matches.length;
        while (insertion < high) {
          const middle = (insertion + high) >>> 1;
          if (matches[middle].start < start) insertion = middle + 1;
          else high = middle;
        }
        matches.splice(insertion, 0, { start, end, url: target });
        if (matches.length >= MAX_MATCHES) break rulesLoop;
      }
    }
  }
  const segments: IssueLinkSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) segments.push({ text: text.slice(cursor, match.start) });
    segments.push({ text: text.slice(match.start, match.end), url: match.url });
    cursor = match.end;
  }
  if (cursor < scanText.length) segments.push({ text: scanText.slice(cursor) });
  if (scanText.length < text.length) segments.push({ text: text.slice(scanText.length) });
  return segments;
}

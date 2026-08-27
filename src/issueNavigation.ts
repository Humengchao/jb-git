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

/**
 * Compiles the configured rules, dropping the ones that cannot work.
 *
 * A malformed pattern must cost that one rule, not the whole feature, and a
 * pattern that matches the empty string would loop forever, so it is dropped
 * too.
 */
export function compileIssueRules(rules: readonly unknown[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    if (typeof rule !== "object" || rule === null) continue;
    const { pattern, url } = rule as Record<string, unknown>;
    if (typeof pattern !== "string" || typeof url !== "string" || !pattern || !url) continue;
    try {
      const expression = new RegExp(pattern, "g");
      if (expression.test("")) continue;
      expression.lastIndex = 0;
      compiled.push({ expression, url });
    } catch {
      // The broken pattern is skipped; the others still link.
    }
  }
  return compiled;
}

function targetFor(url: string, match: RegExpExecArray): string {
  return url.replace(/\$(\d)/g, (_whole, digit) => match[Number(digit)] ?? "");
}

/**
 * Splits text into plain and linked segments.
 *
 * Rules are applied in order and an earlier match wins overlapping text, which
 * is what makes the configuration predictable: put the more specific tracker
 * first.
 */
export function linkifyIssues(text: string, rules: readonly CompiledRule[]): IssueLinkSegment[] {
  if (!text || rules.length === 0) return text ? [{ text }] : [];
  const matches: Array<{ start: number; end: number; url: string }> = [];
  for (const rule of rules) {
    rule.expression.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.expression.exec(text))) {
      const start = match.index;
      const end = start + match[0].length;
      if (!matches.some((existing) => start < existing.end && end > existing.start)) {
        matches.push({ start, end, url: targetFor(rule.url, match) });
      }
    }
  }
  matches.sort((left, right) => left.start - right.start);
  const segments: IssueLinkSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) segments.push({ text: text.slice(cursor, match.start) });
    segments.push({ text: text.slice(match.start, match.end), url: match.url });
    cursor = match.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

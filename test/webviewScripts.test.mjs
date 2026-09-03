import assert from "node:assert/strict";
import test from "node:test";
import { readSource } from "./sourceText.mjs";

/**
 * Every embedded Webview script, and how to find it.
 *
 * These scripts run in a sandbox with no module system and no type checking, so
 * a name that does not exist is only discovered by opening the panel. One did
 * ship that way: the Local Changes tab called the merge editor's translator and
 * threw on every expanded file.
 */
const SCRIPTS = [
  ["../src/webviews/logPanelScript.ts", /export const logScript = String\.raw`([\s\S]*?)`;\n/],
  ["../src/webviews/mergeEditor.ts", /const mergeScript = String\.raw`([\s\S]*?)`;\n/],
  ["../src/webviews/branchComparison.ts", /const comparisonScript = String\.raw`([\s\S]*?)`;\n/],
  ["../src/webviews/rebaseEditor.ts", /function script\(\): string \{[\s\S]*?\n  return String\.raw`([\s\S]*?)`;\n\}/],
];

/** What the Webview sandbox provides, so calling it is not a mistake. */
const SANDBOX = new Set([
  "acquireVsCodeApi", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
  "queueMicrotask", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
  "String", "Number", "Boolean", "Array", "Object", "JSON", "Math", "Date", "Set", "Map",
  "WeakMap", "WeakSet", "RegExp", "Promise", "Error", "Symbol", "Intl", "BigInt",
  "ResizeObserver", "MutationObserver", "IntersectionObserver", "structuredClone",
  "console", "document", "window", "navigator", "alert", "confirm", "prompt", "fetch",
  "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "PointerEvent", "AbortController", "URL", "URLSearchParams", "Blob", "TextEncoder", "TextDecoder",
]);

/** Keywords that are followed by a parenthesis and are not calls. */
const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "instanceof", "void",
  "delete", "function", "await", "new", "do", "else", "try", "throw", "case", "in", "of",
  "yield", "var", "let", "const", "class", "super", "this",
]);

/** True where a `/` starts a regular expression rather than a division. */
function regexAllowed(output) {
  const previous = output.replace(/\s+$/, "").slice(-1);
  return previous === "" || "(,=:[!&|?{};+-*%~^<>".includes(previous);
}

/**
 * Removes comments and literals so prose and data cannot look like code.
 *
 * Regular expressions have to be recognised, not just skipped over: a pattern
 * such as `/['"]/` would otherwise open a string and swallow everything up to
 * the next quote, taking real declarations with it.
 */
function code(script) {
  let output = "";
  let index = 0;
  while (index < script.length) {
    const character = script[index];
    const next = script[index + 1];
    if (character === "/" && next !== "/" && next !== "*" && regexAllowed(output)) {
      index += 1;
      let inClass = false;
      while (index < script.length) {
        const inner = script[index];
        if (inner === "\\") { index += 2; continue; }
        if (inner === "[") inClass = true;
        else if (inner === "]") inClass = false;
        else if (inner === "/" && !inClass) break;
        else if (inner === "\n") break;
        index += 1;
      }
      index += 1;
      while (index < script.length && /[a-z]/.test(script[index])) index += 1;
      output += " ";
      continue;
    }
    if (character === "/" && next === "/") {
      const end = script.indexOf("\n", index);
      index = end < 0 ? script.length : end;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = script.indexOf("*/", index + 2);
      index = end < 0 ? script.length : end + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      index += 1;
      while (index < script.length && script[index] !== character) {
        // A template's ${...} is real code, so it is kept.
        if (character === "`" && script[index] === "$" && script[index + 1] === "{") {
          const close = script.indexOf("}", index);
          output += script.slice(index + 2, close < 0 ? script.length : close);
          index = close < 0 ? script.length : close + 1;
          continue;
        }
        index += script[index] === "\\" ? 2 : 1;
      }
      index += 1;
      output += " ";
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

/** Every name the script binds: declarations, parameters, and loop and catch bindings. */
function boundNames(script) {
  const names = new Set();
  const add = (list) => {
    for (const raw of list.split(",")) {
      // Handles `a`, `a = 1`, `...rest`, and `{ a, b }` well enough that a real
      // binding is never mistaken for an undefined call.
      for (const name of raw.matchAll(/[A-Za-z_$][\w$]*/g)) names.add(name[0]);
    }
  };
  for (const match of script.matchAll(/function\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g)) {
    if (match[1]) names.add(match[1]);
    add(match[2]);
  }
  for (const match of script.matchAll(/(?:const|let|var)\s+([^=;\n]+?)\s*(?:=|;|\bof\b|\bin\b)/g)) add(match[1]);
  for (const match of script.matchAll(/\(([^()]*)\)\s*=>/g)) add(match[1]);
  for (const match of script.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) names.add(match[1]);
  for (const match of script.matchAll(/catch\s*\(([^)]*)\)/g)) add(match[1]);
  return names;
}

test("calls nothing the Webview sandbox does not have", () => {
  for (const [file, pattern] of SCRIPTS) {
    const match = readSource(file, import.meta.url).match(pattern);
    assert.ok(match, `${file} should contain its embedded script`);
    const script = code(match[1]);
    const bound = boundNames(script);
    const called = new Set([...script.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((entry) => entry[1]));
    const unknown = [...called].filter((name) => !bound.has(name) && !SANDBOX.has(name) && !KEYWORDS.has(name));
    assert.deepEqual(unknown, [], `${file} calls names that do not exist in the sandbox`);
  }
});

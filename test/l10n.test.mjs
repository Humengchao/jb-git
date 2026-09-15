import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { readSource } from "./sourceText.mjs";

const bundle = JSON.parse(readFileSync(new URL("../l10n/bundle.l10n.zh-cn.json", import.meta.url), "utf8"));

function l10nKeys() {
  const keys = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { walk(`${dir}/${entry.name}`); continue; }
      if (!entry.name.endsWith(".ts")) continue;
      const source = readSource(`../${dir}/${entry.name}`, import.meta.url);
      for (const match of source.matchAll(/vscode\.l10n\.t\(\s*"((?:[^"\\]|\\.)*)"/g)) {
        keys.add(match[1].replaceAll('\\"', '"').replaceAll("\\'", "'"));
      }
    }
  };
  walk("src");
  return keys;
}

test("every host string handed to the translator has a Chinese entry", () => {
  // A key missing from the bundle silently falls back to English, which is
  // exactly the mixed-language experience this work removes.
  const used = l10nKeys();
  assert.ok(used.size >= 90, `expected the localized flows to stay localized, found ${used.size} keys`);
  for (const key of used) {
    assert.ok(key in bundle, `missing zh translation for: ${key}`);
  }
});

test("the bundle carries no entry the code no longer uses", () => {
  const used = l10nKeys();
  for (const key of Object.keys(bundle)) {
    assert.ok(used.has(key), `stale bundle entry: ${key}`);
  }
});

test("placeholders survive translation", () => {
  // {0}/{1} markers must appear in the translation, or the argument is lost.
  for (const [key, value] of Object.entries(bundle)) {
    for (const marker of key.match(/\{\d\}/g) ?? []) {
      assert.ok(value.includes(marker), `translation of "${key}" drops ${marker}`);
    }
  }
});

test("the extension manifest points VS Code at the bundles", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.l10n, "./l10n");
});

test("no decision is made by sniffing words out of a translated label", () => {
  // mode.label.includes("Amend") worked only in English: the moment the label
  // was translated every such check went false and the choice silently lost
  // its meaning. Choices must carry their semantics as data.
  for (const name of ["extension", "webviews/logPanel", "pushPreview", "smartCheckout"]) {
    const source = readSource(`../src/${name}.ts`, import.meta.url);
    assert.doesNotMatch(source, /\.label\.includes\(/, `${name} decides by label text`);
  }
});

/**
 * Reads every `.ts` under `src`, so a rule holds for the whole extension
 * rather than for the handful of files a test happened to name.
 */
function sourceFiles(dir = "src") {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const at = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sourceFiles(at));
    else if (entry.name.endsWith(".ts")) files.push(at);
  }
  return files;
}

/**
 * Every string and template literal inside one call's arguments that the
 * translator never saw.
 *
 * Scanning the whole argument list rather than the first argument is what
 * catches the real shapes: a ternary picking between two sentences, and a
 * `detail:` explaining a modal.
 */
function untranslatedLiterals(source, from) {
  const found = [];
  let depth = 0;
  for (let index = from; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") { depth += 1; continue; }
    if (character === ")") { if (depth === 0) break; depth -= 1; continue; }
    if (character !== '"' && character !== "`") continue;
    const start = index;
    for (index += 1; index < source.length; index += 1) {
      if (source[index] === "\\") { index += 1; continue; }
      if (source[index] === character) break;
    }
    // Anything the translator already owns is not a finding, and neither is a
    // nested t() argument.
    // The call may wrap, so the window has to clear a newline and its indent.
    if (/l10n\.t\(\s*$/.test(source.slice(Math.max(0, start - 60), start))) continue;
    found.push(source.slice(start + 1, index));
  }
  return found;
}

test("no notification ships a sentence the translator never saw", () => {
  // The same sentence was localized from the command palette and hardcoded in
  // the Blame gutter, so one Chinese user saw both languages for one action.
  // A literal reaching showMessage untranslated is that bug, whatever the file.
  const offenders = [];
  for (const file of sourceFiles()) {
    const source = readSource(`../${file}`, import.meta.url);
    for (const match of source.matchAll(/show(?:Warning|Information|Error)Message\(/g)) {
      for (const literal of untranslatedLiterals(source, match.index + match[0].length)) {
        // Interpolation-only text carries no prose to translate; three plain
        // words in a row is what makes it a sentence a reader would notice.
        const prose = literal.replace(/\$\{[^}]*\}/g, " ");
        if (!/[A-Za-z]+ [a-z]+ [a-z]+/.test(prose)) continue;
        offenders.push(`${file}: ${prose.trim().slice(0, 60)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "notifications must go through vscode.l10n.t");
});

test("the rebase editor translates what the host posts into it", () => {
  // Its problem label renders host-posted text as well as its own, and only
  // the local path went through the translator: a Chinese editor answered a
  // stale plan in English.
  const source = readSource("../src/webviews/rebaseEditor.ts", import.meta.url);
  assert.match(source, /label\.textContent = t\(data\.message\);/);
  for (const posted of source.matchAll(/postMessage\(\{ type: "error", message: "([^"]+)"/g)) {
    assert.match(source, new RegExp(`'${posted[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}':`), `the editor's dictionary is missing: ${posted[1]}`);
  }
});

test("the branch menu formats its labels instead of concatenating them", () => {
  // A label glued together from translated fragments freezes English word
  // order, so these six entries stayed English while the rest of the menu
  // was translated. They carry their values as {0}/{1} now.
  const script = readSource("../src/webviews/logPanelScript.ts", import.meta.url);
  const menu = script.match(/function branchContextItems\(branch\) \{([\s\S]*?)\r?\n  }/);
  assert.ok(menu, "the branch context menu should be present");
  const offenders = [...menu[1].matchAll(/label: ([^,\n]*\+[^,\n]*)/g)]
    .map((entry) => entry[1].trim())
    .filter((label) => /\+\s*(branch\.name|into)\b|\b(branch\.name|into)\s*\+/.test(label));
  assert.deepEqual(offenders, [], "branch labels must go through format()");
  assert.match(script, /const format = \(pattern, \.\.\.values\) => t\(pattern\)/);
});

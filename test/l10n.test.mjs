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

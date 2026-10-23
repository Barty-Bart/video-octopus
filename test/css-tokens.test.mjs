// Direction A (SPEC §11): the shell, memory and learning styles use theme tokens only, so every look (Night, Paper,
// Frost…) recolours them. A hex colour in a declaration fails; selectors such as #vfChat are not colours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILES = ['web/shell.css', 'web/memory.css', 'web/learning.css'];
const ALLOWED = []; // no exceptions

export function hexColours(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [];
  // A declaration: a property name after `{` or `;`, then its value up to the next `;` or `}`.
  for (const m of text.matchAll(/[{;]\s*(--?[\w-]+|[a-z-]+)\s*:([^;{}]*)/gi)) {
    for (const hex of m[2].matchAll(/#[0-9a-f]{3,8}\b/gi)) found.push(`${m[1]}: ${hex[0]}`);
  }
  return found.filter((x) => !ALLOWED.includes(x));
}

test('the hex check finds colours in values but not id selectors', () => {
  assert.deepEqual(hexColours('#add { color: var(--text); } .a{background:var(--panel,#fff);border:1px solid #DDD}'), ['background: #fff', 'border: #DDD']);
  assert.deepEqual(hexColours('@media (max-width: 9px) { #bad .x { color: var(--bad) } }'), []);
});

for (const file of FILES) {
  test(`${file} uses tokens, not hex colours`, () => {
    const css = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.deepEqual(hexColours(css), []);
  });
}

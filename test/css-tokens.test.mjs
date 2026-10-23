// Design V2 (SPEC §1.4): the app's styles use theme tokens only, so Light, Dark and every accent recolour them.
// A hex colour in a declaration fails; selectors such as #vfChat are not colours. In style.css, hex is allowed only
// inside the theme blocks: :root rules whose selector is :root plus [data-theme] / [data-accent] attributes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILES = ['web/style.css', 'web/shell.css', 'web/memory.css', 'web/learning.css', 'web/packaging.css', 'web/onboarding.css'];

const THEME_SELECTOR = /^:root(\[data-(theme|accent)="[a-z]+"\])*$/;

// style.css without its theme blocks (top-level rules with no nested rule inside).
export function withoutThemeBlocks(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return text.replace(/(?<=^|\})([^{}]+)\{[^{}]*\}/g, (whole, selector) => {
    const parts = selector.split(',').map((x) => x.trim());
    return parts.every((x) => THEME_SELECTOR.test(x)) ? ' ' : whole;
  });
}

export function hexColours(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [];
  // A declaration: a property name after `{` or `;`, then its value up to the next `;` or `}`.
  for (const m of text.matchAll(/[{;]\s*(--?[\w-]+|[a-z-]+)\s*:([^;{}]*)/gi)) {
    for (const hex of m[2].matchAll(/#[0-9a-f]{3,8}\b/gi)) found.push(`${m[1]}: ${hex[0]}`);
  }
  return found;
}

test('the hex check finds colours in values but not id selectors', () => {
  assert.deepEqual(hexColours('#add { color: var(--text); } .a{background:var(--panel,#fff);border:1px solid #DDD}'), ['background: #fff', 'border: #DDD']);
  assert.deepEqual(hexColours('@media (max-width: 9px) { #bad .x { color: var(--bad) } }'), []);
});

test('only the theme blocks may hold hex colours', () => {
  const css = ':root { --a: #fff; } :root[data-theme="dark"] { --a: #000; } :root[data-theme="dark"][data-accent="blue"] { --b: #00f; }'
    + ' :root[data-theme="dark"] .x { color: #123; } .y { color: #456; }';
  assert.deepEqual(hexColours(withoutThemeBlocks(css)), ['color: #123', 'color: #456']);
});

for (const file of FILES) {
  test(`${file} uses tokens, not hex colours`, () => {
    const css = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.deepEqual(hexColours(file === 'web/style.css' ? withoutThemeBlocks(css) : css), []);
  });
}

test('style.css defines both themes and all four accents', () => {
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  assert.match(css, /^:root \{/m);
  assert.match(css, /^:root\[data-theme="dark"\] \{/m);
  for (const accent of ['blue', 'green', 'violet']) {
    assert.match(css, new RegExp(`^:root\\[data-accent="${accent}"\\]`, 'm'), accent);
    assert.match(css, new RegExp(`^:root\\[data-theme="dark"\\]\\[data-accent="${accent}"\\]`, 'm'), `dark ${accent}`);
  }
});

test('the old looks are gone', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /looks\.css/);
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /data-look/);
});

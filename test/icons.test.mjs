// Design V2 §9: one outline icon style (24-unit grid, stroke 1.8, round caps and joins, currentColor), with the
// icons the rail and the theme switch need.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { icon, ICON_NAMES } from '../web/icons.js';

test('the V2 icon set has the new glyphs', () => {
  for (const name of ['sun', 'moon', 'sidebar', 'layers', 'upload', 'portrait', 'landscape', 'claude', 'settings', 'projects', 'recordings', 'library', 'skills', 'scheduled', 'plus']) {
    assert.ok(ICON_NAMES.includes(name), name);
  }
});

test('every icon is drawn the same way and sized for its place', () => {
  for (const name of ICON_NAMES) {
    const svg = icon(name);
    assert.match(svg, /viewBox="0 0 24 24"/, name);
    assert.match(svg, /stroke-width="1.8"/, name);
    assert.match(svg, /stroke-linecap="round" stroke-linejoin="round"/, name);
    assert.match(svg, /stroke="currentColor"/, name);
    assert.match(svg, /aria-hidden="true"/, name);
    assert.doesNotMatch(svg.replace(/(fill|stroke)="(none|currentColor)"/g, ''), /#[0-9a-f]{3,8}/i, name);
  }
  assert.match(icon('projects', 18), /width="18" height="18"/);
  assert.match(icon('projects'), /width="16" height="16"/);
});

// Design V2 (SPEC §1): the ten looks became Light, Dark or Match system. Every old look maps to a theme once, on the
// server, and the settings file keeps the new keys only. The browser's early script (web/index.html) and
// web/appearance.js map an old cached look the same way, so a dark user never flashes light after updating.
// A disposable local folder; no real settings are read or written.
//   node --test test/appearance-theme.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const local = mkdtempSync(join(tmpdir(), 'octopus-appearance-'));
const priorLocal = process.env.STUDIO_LOCAL_DIR;
process.env.STUDIO_LOCAL_DIR = local;
const { migrateAppearance, appearanceSection, saveSection, section, THEME_OF_LOOK, OLD_LOOKS } = await import('../server/settings.mjs');
const { themeOfLook } = await import('../web/theme-map.js');
test.after(() => {
  if (priorLocal === undefined) delete process.env.STUDIO_LOCAL_DIR; else process.env.STUDIO_LOCAL_DIR = priorLocal;
  rmSync(local, { recursive: true, force: true });
});

const file = join(local, 'settings.json');
const writeSettings = (value) => writeFileSync(file, JSON.stringify(value));
const readSettings = () => JSON.parse(readFileSync(file, 'utf8'));

const TABLE = {
  editbay: 'system',
  paper: 'light', swiss: 'light', clay: 'light', atelier: 'light',
  night: 'dark', frost: 'dark', control: 'dark', cinema: 'dark', split: 'dark',
};

test('every old look maps to the theme in the spec table', () => {
  assert.deepEqual(THEME_OF_LOOK, TABLE);
  assert.equal(OLD_LOOKS.length, 10);
  for (const [look, theme] of Object.entries(TABLE)) {
    const next = migrateAppearance({ look, calm: true });
    assert.deepEqual(next, { theme, migratedFrom: look }, look);
  }
});

test('a missing or unknown look counts as Edit Bay; nothing old means nothing to migrate', () => {
  assert.deepEqual(migrateAppearance({ calm: false }), { theme: 'system', migratedFrom: 'editbay' });
  assert.deepEqual(migrateAppearance({ look: 'neon' }), { theme: 'system', migratedFrom: 'editbay' });
  assert.equal(migrateAppearance({}), null);
  assert.equal(migrateAppearance(undefined), null);
  assert.equal(migrateAppearance({ theme: 'dark', accent: 'blue' }), null);
});

test('an explicit new theme next to an old look is kept', () => {
  assert.deepEqual(migrateAppearance({ look: 'night', theme: 'light', accent: 'green' }), { theme: 'light', accent: 'green', migratedFrom: 'night' });
});

test('the browser map agrees with the server table', () => {
  for (const [look, theme] of Object.entries(TABLE)) assert.equal(themeOfLook(look), theme, look);
  assert.equal(themeOfLook('neon'), 'system');
  assert.equal(themeOfLook(undefined), 'system');
});

test("index.html's early script maps the same dark looks", () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const dark = Object.keys(TABLE).filter((k) => TABLE[k] === 'dark');
  const light = Object.keys(TABLE).filter((k) => TABLE[k] === 'light');
  const darkList = /DARK_LOOKS = \/\^\(([a-z|]+)\)\$\//.exec(html)?.[1].split('|').sort();
  const lightList = /LIGHT_LOOKS = \/\^\(([a-z|]+)\)\$\//.exec(html)?.[1].split('|').sort();
  assert.deepEqual(darkList, dark.sort());
  assert.deepEqual(lightList, light.sort());
});

test('reading the settings migrates the file once and removes the old keys', () => {
  writeSettings({ studio: '', appearance: { look: 'night', calm: false } });
  const first = appearanceSection();
  assert.deepEqual(first, { theme: 'dark', accent: 'orange', sidebar: 'labels', migratedFrom: 'night' });
  assert.deepEqual(readSettings().appearance, { theme: 'dark', migratedFrom: 'night' });
  // A second read finds nothing old and changes nothing.
  assert.deepEqual(section('appearance'), first);
  assert.deepEqual(readSettings().appearance, { theme: 'dark', migratedFrom: 'night' });
});

test('saving round-trips the new keys, clears the note and refuses old or unknown values', () => {
  writeSettings({ appearance: { look: 'paper', calm: true } });
  saveSection('appearance', { accent: 'violet', sidebar: 'icons' });
  assert.deepEqual(readSettings().appearance, { theme: 'light', migratedFrom: 'paper', accent: 'violet', sidebar: 'icons' });
  saveSection('appearance', { migratedFrom: '', theme: 'system' });
  assert.deepEqual(section('appearance'), { theme: 'system', accent: 'violet', sidebar: 'icons', migratedFrom: '' });
  assert.throws(() => saveSection('appearance', { look: 'night' }), /Unknown setting/);
  assert.throws(() => saveSection('appearance', { theme: 'sepia' }), /Unknown choice/);
  assert.throws(() => saveSection('appearance', { accent: 'pink' }), /Unknown choice/);
  assert.throws(() => saveSection('appearance', { sidebar: 'wide' }), /Unknown choice/);
});

test('a new user gets Match system, orange and names in the sidebar, with no note', () => {
  writeSettings({});
  assert.deepEqual(section('appearance'), { theme: 'system', accent: 'orange', sidebar: 'labels', migratedFrom: '' });
  assert.equal(readSettings().appearance, undefined);
});

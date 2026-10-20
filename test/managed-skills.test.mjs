// Run only in an approved isolated environment:
//   node --test test/managed-skills.test.mjs
// These tests use only synthetic temporary studios, Node built-ins, and the pure
// skill-manager module. They do not start the app, run tools, or make requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import {
  activeSkillRoot, compareSkill, loadSkillCatalog, skillSelectionBrief, skillsView, syncSkills,
} from '../server/managed-skills.mjs';

const MARKER = '.octopus-skill.json';
const TARGETS = [
  '.claude/skills', 'skills/overrides', 'skills/custom',
  '.studio/skill-manager/state.json',
];
const doc = (name, body) => `---\nname: ${name}\ndescription: Synthetic test skill\n---\n\n${body}\n`;
const definition = (name = 'alpha', changes = {}) => ({
  id: `octopus.${name}`, name, version: '1.0.0',
  path: `bundled/${name}`, legacyNames: [name], dependencies: [],
  body: `Bundled ${name} version one.`, files: {}, ...changes,
});
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
};
const writeJSON = (path, value) => write(path, JSON.stringify(value, null, 2) + '\n');
const readJSON = (path) => JSON.parse(readFileSync(path, 'utf8'));
const text = (path) => readFileSync(path, 'utf8');

function snapshot(root) {
  if (!existsSync(root)) return null;
  if (lstatSync(root).isFile()) return readFileSync(root).toString('base64');
  const out = {};
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) visit(path);
      else out[relative(root, path).split(sep).join('/')] = readFileSync(path).toString('base64');
    }
  };
  visit(root);
  return out;
}

function fixture(t, initial = [definition()]) {
  // Canonicalize the temp root: /var can itself be a symlink on macOS.
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-managed-skills-'));
  const appRoot = join(root, 'app'), studio = join(root, 'studio');
  mkdirSync(appRoot);
  mkdirSync(studio);
  const protectedFiles = new Map([
    [join(studio, 'projects', 'film', 'project.json'), '{"title":"Keep this project"}\n'],
    [join(studio, 'projects', 'film', 'media.bin'), Buffer.from([0, 1, 2, 254])],
    [join(studio, '.studio', 'settings.json'), '{"theme":"personal"}\n'],
    [join(studio, '.claude', 'settings.local.json'), '{"permissions":[]}\n'],
    [join(studio, '.codex', 'config.toml'), 'model = "synthetic-model"\n'],
    [join(studio, '.pi', 'settings.json'), '{"synthetic":true}\n'],
    [join(studio, 'skills', 'notes.txt'), 'An unrelated file beside the skill roots.\n'],
    [join(studio, 'preferences', 'editing.md'), 'My pause and pacing choices.\n'],
    [join(studio, 'preferences', 'style.md'), 'My own colors and fonts.\n'],
    [join(studio, 'preferences', 'custom.bin'), Buffer.from([0, 17, 255])],
    [join(root, 'neighbor', 'untouched.txt'), 'Outside the studio.\n'],
  ]);
  for (const [path, value] of protectedFiles) write(path, value);
  t.after(() => {
    try {
      for (const [path, value] of protectedFiles) {
        assert.deepEqual(readFileSync(path), Buffer.from(value), `Unrelated file changed: ${path}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  const f = {
    root, appRoot, studio,
    options: { studio, appRoot },
    path: (...parts) => join(studio, ...parts),
    manager: (...parts) => join(studio, '.studio', 'skill-manager', ...parts),
    active: (name = 'alpha', file = 'SKILL.md') => join(studio, '.claude', 'skills', name, file),
    view: () => skillsView({ studio, appRoot }),
    sync: (options = {}) => syncSkills({ studio, appRoot, ...options }),
    action(action, id = 'octopus.alpha', extra = {}) {
      return this.sync({ action: { action, id, revision: this.view().revision, ...extra } });
    },
    release(definitions, apiVersion = 1) {
      for (const d of definitions) {
        const dir = join(appRoot, d.path);
        rmSync(dir, { recursive: true, force: true });
        write(join(dir, 'SKILL.md'), doc(d.name, d.body));
        for (const [path, value] of Object.entries(d.files)) write(join(dir, path), value);
      }
      writeJSON(join(appRoot, 'core', 'skills.json'), {
        schema: 1, apiVersion,
        skills: definitions.map(({ body, files, ...metadata }) => metadata),
      });
    },
  };
  f.release(initial);
  return f;
}

function item(view, id = 'octopus.alpha') {
  assert.equal(view.ok, true, view.error);
  const found = view.items.find((e) => e.id === id);
  assert.ok(found, `Missing skill ${id}`);
  return found;
}
const source = (f, entry, file = 'SKILL.md') => f.path(entry.overridePath, file);
const managedSnapshot = (f) => TARGETS.map((path) => snapshot(f.path(path)));
const state = (f) => readJSON(f.manager('state.json'));
const backupIDs = (f) => new Set(f.view().backups.map((b) => b.id));
function newBackup(f, previous) {
  const found = f.view().backups.find((b) => !previous.has(b.id));
  assert.ok(found, 'The operation must retain a backup receipt');
  return found;
}
function makePersonal(f, folder, name, body, id = null) {
  const dir = f.path('skills', 'custom', folder);
  write(join(dir, 'SKILL.md'), doc(name, body));
  if (id) writeJSON(join(dir, MARKER), { schema: 1, id });
  return dir;
}
function installLegacy(f, d = definition(), { manifest = true } = {}) {
  const target = f.path('.claude', 'skills', d.name);
  cpSync(join(f.appRoot, d.path), target, { recursive: true });
  if (manifest) {
    const files = {};
    for (const [path, data] of Object.entries(snapshot(target))) {
      files[`.claude/skills/${d.name}/${path}`] = createHash('sha1')
        .update(Buffer.from(data, 'base64')).digest('hex');
    }
    writeJSON(f.path('.studio', 'starter.json'), { version: 1, files, kept: [] });
  }
  return target;
}
function assertOneActive(f, name, id) {
  assert.equal(readJSON(f.active(name, MARKER)).id, id);
  const active = f.path('.claude', 'skills');
  const copies = readdirSync(active).filter((n) => {
    const path = join(active, n, MARKER);
    return existsSync(path) && readJSON(path).id === id;
  });
  assert.deepEqual(copies, [name], 'One stable identity must have exactly one active publication');
}

test('fresh install publishes defaults once and leaves personal files untouched', (t) => {
  const f = fixture(t, [definition(), definition('beta')]);
  const view = f.sync({ fresh: true });
  assert.equal(view.pending, 0);
  assert.equal(view.items.length, 2);
  for (const name of ['alpha', 'beta']) {
    const e = item(view, `octopus.${name}`);
    assert.equal(e.mode, 'default');
    assert.equal(e.disabled, false);
    assert.equal(e.overridePath, null);
    assert.equal(text(f.active(name)), doc(name, `Bundled ${name} version one.`));
    assertOneActive(f, name, e.id);
  }
  assert.equal(activeSkillRoot(f.options), f.path('.claude', 'skills'));
  assert.equal(view.release, loadSkillCatalog(f.appRoot).release);
});

test('only an exact SHA1 legacy manifest proves an old skill may become a managed default', (t) => {
  const old = definition('alpha', { files: { 'references/rules.txt': 'Old rules.\n' } });
  const f = fixture(t, [old]);
  installLegacy(f, old);
  const manifestBefore = text(f.path('.studio', 'starter.json'));
  f.release([definition('alpha', { version: '2.0.0', body: 'New bundled wording.' })]);
  const e = item(f.sync());
  assert.equal(e.mode, 'default');
  assert.equal(e.disabled, false);
  assert.equal(text(f.active()), doc('alpha', 'New bundled wording.'));
  assert.equal(text(f.path('.studio', 'starter.json')), manifestBefore);
  assert.equal(existsSync(f.path('skills', 'overrides', e.id, 'SKILL.md')), false);
});

test('modified legacy wording and additional files survive as a separate override', (t) => {
  const f = fixture(t);
  const legacy = installLegacy(f);
  write(join(legacy, 'SKILL.md'), doc('alpha', 'My edited instructions.'));
  write(join(legacy, 'notes.txt'), 'My extra file.\n');
  f.release([definition('alpha', { version: '2.0.0', body: 'Upstream update.' })]);
  const e = item(f.sync());
  assert.equal(e.mode, 'override');
  assert.equal(e.pending, true);
  assert.equal(text(source(f, e)), doc('alpha', 'My edited instructions.'));
  assert.equal(e.forkVersion, null, 'Legacy upstream labels do not establish a fork baseline');
  assert.equal(e.compatibilityBlocked, true);
  assert.equal(existsSync(f.active()), false);
  assert.equal(text(source(f, e, 'notes.txt')), 'My extra file.\n');
  f.action('confirm-compatibility');
  assert.equal(text(f.active()), doc('alpha', 'My edited instructions.'));
});

test('missing or incomplete legacy metadata never licenses overwriting existing copies', async (t) => {
  for (const metadata of ['missing', 'partial', 'extra-file']) {
    await t.test(metadata, (t) => {
      const d = definition('alpha', { files: { 'references/guide.txt': 'Preserve this.\n' } });
      const f = fixture(t, [d]);
      const legacy = installLegacy(f, d, { manifest: metadata !== 'missing' });
      if (metadata === 'partial') {
        const manifest = readJSON(f.path('.studio', 'starter.json'));
        delete manifest.files['.claude/skills/alpha/references/guide.txt'];
        writeJSON(f.path('.studio', 'starter.json'), manifest);
      }
      if (metadata === 'extra-file') write(join(legacy, 'personal.txt'), 'Not in the manifest.\n');
      f.release([definition('alpha', { version: '2.0.0', body: 'Different upstream.' })]);
      const e = item(f.sync());
      assert.equal(e.mode, 'override');
      assert.equal(text(source(f, e)), doc('alpha', d.body));
      assert.equal(text(source(f, e, 'references/guide.txt')), 'Preserve this.\n');
      if (metadata === 'extra-file') assert.equal(text(source(f, e, 'personal.txt')), 'Not in the manifest.\n');
    });
  }
});

test('missing legacy history keeps absent old skills disabled until an explicit choice', (t) => {
  const f = fixture(t);
  let e = item(f.sync());
  assert.equal(e.disabled, true);
  assert.equal(e.uncertain, true);
  assert.equal(e.pending, true);
  assert.equal(existsSync(f.active()), false);
  e = item(f.action('enable'));
  assert.equal(e.disabled, false);
  assert.equal(e.uncertain, false);
  assert.equal(existsSync(f.active()), true);
});

test('a deleted legacy skill remains deleted when its old manifest proves prior installation', (t) => {
  const f = fixture(t);
  const legacy = installLegacy(f);
  rmSync(legacy, { recursive: true });
  const e = item(f.sync());
  assert.equal(e.disabled, true);
  assert.equal(e.deleted, true);
  assert.equal(existsSync(f.active()), false);
});

test('app source path and public name changes retain the stable identity without duplicates', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  f.release([definition('alpha', {
    name: 'alpha-new', path: 'bundled/moved/alpha', version: '2.0.0', body: 'Renamed default.',
  })]);
  const view = f.sync();
  assert.equal(view.items.length, 1);
  assert.equal(item(view).name, 'alpha-new');
  assert.equal(existsSync(f.active('alpha')), false);
  assert.equal(text(f.active('alpha-new')), doc('alpha-new', 'Renamed default.'));
  assertOneActive(f, 'alpha-new', 'octopus.alpha');
});

test('moving a published default folder preserves its identity and does not create a second skill', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  renameSync(dirname(f.active()), f.path('.claude', 'skills', 'moved-by-user'));
  assert.throws(() => activeSkillRoot(f.options), /refresh|changed/i);
  const view = f.sync();
  assert.equal(view.items.length, 1);
  assert.equal(item(view).mode, 'default');
  assert.equal(item(view).disabled, false);
  assert.equal(existsSync(f.path('.claude', 'skills', 'moved-by-user')), false);
  assertOneActive(f, 'alpha', 'octopus.alpha');
});

test('a source placed in overrides is saved without silently replacing the selected core', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  const personal = f.path('skills', 'overrides', 'my-folder');
  cpSync(dirname(f.active()), personal, { recursive: true });
  write(join(personal, 'SKILL.md'), doc('alpha', 'An explicit personal override.'));
  const view = f.sync(), e = item(view);
  assert.equal(view.items.length, 1);
  assert.equal(e.mode, 'default');
  assert.equal(e.overridePath, 'skills/overrides/my-folder');
  assert.equal(text(f.active()), doc('alpha', 'Bundled alpha version one.'));
  assert.equal(text(source(f, e)), doc('alpha', 'An explicit personal override.'));
  assert.equal(e.compatibilityBlocked, true, 'A copied identity does not prove its fork API baseline');
  f.action('use-custom');
  assert.equal(existsSync(f.active()), false);
  f.action('confirm-compatibility');
  assert.equal(text(f.active()), doc('alpha', 'An explicit personal override.'));
  assertOneActive(f, 'alpha', 'octopus.alpha');
});

test('renaming a personal source folder and its skill name keeps identity and edits', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  let e = item(f.action('customize'));
  const moved = f.path('skills', 'overrides', 'my-renamed-folder');
  renameSync(dirname(source(f, e)), moved);
  write(join(moved, 'SKILL.md'), doc('my-alpha', 'My renamed wording.'));
  e = item(f.sync());
  assert.equal(e.id, 'octopus.alpha');
  assert.equal(e.overridePath, 'skills/overrides/my-renamed-folder');
  assert.equal(e.name, 'my-alpha');
  assert.equal(text(f.active('my-alpha')), doc('my-alpha', 'My renamed wording.'));
  assert.equal(existsSync(f.active('alpha')), false);
  assertOneActive(f, 'my-alpha', 'octopus.alpha');
});

test('upstream changes offer compare and keep without silently replacing an override', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  let e = item(f.action('customize'));
  write(source(f, e), doc('alpha', 'My preferred instructions.'));
  write(source(f, e, 'personal.txt'), 'A personal addition.\n');
  f.sync();
  f.release([definition('alpha', {
    version: '2.0.0', body: 'New upstream instructions.',
    files: { 'upstream.txt': 'A new bundled addition.\n' },
  })]);
  let view = f.sync();
  e = item(view);
  assert.equal(e.mode, 'override');
  assert.equal(e.pending, true);
  assert.equal(text(f.active()), doc('alpha', 'My preferred instructions.'));
  const comparison = compareSkill({ ...f.options, id: e.id, revision: view.revision });
  const files = new Map(comparison.files.map((entry) => [entry.path, entry]));
  assert.equal(files.get('SKILL.md').status, 'changed');
  assert.equal(files.get('SKILL.md').mine, doc('alpha', 'My preferred instructions.'));
  assert.equal(files.get('SKILL.md').latest, doc('alpha', 'New upstream instructions.'));
  assert.equal(files.get('personal.txt').status, 'removed');
  assert.equal(files.get('upstream.txt').status, 'added');
  assert.equal(files.has(MARKER), false);
  const beforeCompare = managedSnapshot(f);
  compareSkill({ ...f.options, id: e.id, revision: view.revision });
  assert.deepEqual(managedSnapshot(f), beforeCompare, 'Compare is read-only');
  view = f.action('keep');
  assert.equal(item(view).pending, false);
  assert.equal(item(view).mode, 'override');
  assert.equal(text(f.active()), doc('alpha', 'My preferred instructions.'));
  assert.equal(item(f.sync()).pending, false, 'Acknowledgement survives repeated refresh');
});

test('Use latest retains the saved fork and its recovery copy for explicit reselection', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  let e = item(f.action('customize'));
  write(source(f, e), doc('alpha', 'My recoverable instructions.'));
  write(source(f, e, 'private-note.txt'), 'Synthetic private note.\n');
  f.sync();
  const preservedPath = item(f.view()).overridePath;
  f.release([definition('alpha', { version: '2.0.0', body: 'Latest instructions.' })]);
  f.sync();
  const before = backupIDs(f);
  e = item(f.action('latest'));
  assert.equal(e.mode, 'default');
  assert.equal(e.pending, false);
  assert.equal(text(f.active()), doc('alpha', 'Latest instructions.'));
  assert.equal(e.forkAvailable, true);
  assert.equal(e.forkVersion, '1.0.0');
  assert.equal(e.activeVersion, '2.0.0');
  assert.equal(text(f.path(preservedPath, 'SKILL.md')), doc('alpha', 'My recoverable instructions.'));
  const backup = newBackup(f, before);
  assert.equal(backup.restorable, true);
  const saved = f.manager('backups', backup.id, 'before', '1', 'octopus.alpha');
  assert.equal(text(join(saved, 'SKILL.md')), doc('alpha', 'My recoverable instructions.'));
  assert.equal(text(join(saved, 'private-note.txt')), 'Synthetic private note.\n');
  assertOneActive(f, 'alpha', e.id);
  e = item(f.action('use-custom'));
  assert.equal(e.activeVersion, '1.0.0');
  assert.equal(e.availableVersion, '2.0.0');
  assert.equal(text(f.active()), doc('alpha', 'My recoverable instructions.'));
});

test('edits made directly to a published default become a preserved override', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  write(f.active(), doc('alpha', 'Edited in the active folder.'));
  assert.throws(() => activeSkillRoot(f.options), /refresh|changed/i);
  const e = item(f.sync());
  assert.equal(e.mode, 'override');
  assert.equal(text(source(f, e)), doc('alpha', 'Edited in the active folder.'));
  assert.equal(text(f.active()), doc('alpha', 'Edited in the active folder.'));
  assert.equal(activeSkillRoot(f.options), f.path('.claude', 'skills'));
});

test('edits to a separate override require refresh and then become the sole active copy', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  let e = item(f.action('customize'));
  write(source(f, e), doc('alpha', 'Edited in the personal source.'));
  assert.throws(() => activeSkillRoot(f.options), /refresh|changed/i,
    'An agent must not silently receive the stale publication after a source edit');
  e = item(f.sync());
  assert.equal(text(source(f, e)), doc('alpha', 'Edited in the personal source.'));
  assert.equal(text(f.active()), doc('alpha', 'Edited in the personal source.'));
  assertOneActive(f, 'alpha', e.id);
});

test('different simultaneous edits to active and override files block replacement and preserve both', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  const e = item(f.action('customize'));
  write(f.active(), doc('alpha', 'Active-side edit.'));
  write(source(f, e), doc('alpha', 'Source-side edit.'));
  const before = managedSnapshot(f);
  assert.throws(() => f.sync(), /both.*changed|reconcile/i);
  assert.deepEqual(managedSnapshot(f), before);
  assert.equal(text(f.active()), doc('alpha', 'Active-side edit.'));
  assert.equal(text(source(f, e)), doc('alpha', 'Source-side edit.'));
});

test('identical simultaneous edits may be reconciled without losing either copy', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  const e = item(f.action('customize'));
  write(f.active(), doc('alpha', 'The same edit.'));
  write(source(f, e), doc('alpha', 'The same edit.'));
  assert.equal(item(f.sync()).mode, 'override');
  assert.equal(text(f.active()), doc('alpha', 'The same edit.'));
  assert.equal(text(source(f, e)), doc('alpha', 'The same edit.'));
});

test('active deletion becomes a tombstone that later releases do not reinstall', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  rmSync(dirname(f.active()), { recursive: true });
  assert.throws(() => activeSkillRoot(f.options), /deleted|refresh/i);
  let e = item(f.sync());
  assert.equal(e.disabled, true);
  assert.equal(e.deleted, true);
  f.release([definition('alpha', { version: '2.0.0', body: 'A later default.' })]);
  e = item(f.sync());
  assert.equal(e.disabled, true);
  assert.equal(existsSync(f.active()), false);
  e = item(f.action('enable'));
  assert.equal(e.deleted, false);
  assert.equal(text(f.active()), doc('alpha', 'A later default.'));
});

test('loss of the entire published root records deletions without silently republishing all skills', (t) => {
  const f = fixture(t, [definition(), definition('beta')]);
  f.sync({ fresh: true });
  rmSync(f.path('.claude', 'skills'), { recursive: true });
  assert.throws(() => activeSkillRoot(f.options), /deleted|refresh/i);
  let view = f.sync();
  for (const name of ['alpha', 'beta']) {
    const e = item(view, `octopus.${name}`);
    assert.equal(e.disabled, true);
    assert.equal(e.deleted, true);
    assert.equal(existsSync(f.active(name)), false);
  }
  view = f.action('enable', 'octopus.alpha');
  assert.equal(item(view).disabled, false);
  assert.equal(item(view, 'octopus.beta').disabled, true);
  assertOneActive(f, 'alpha', 'octopus.alpha');
  assert.equal(existsSync(f.active('beta')), false);
});

test('deleting an override source disables it and preserves its last active copy in a backup', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  let e = item(f.action('customize'));
  write(source(f, e), doc('alpha', 'Keep a recovery copy.'));
  f.sync();
  rmSync(dirname(source(f, e)), { recursive: true });
  const before = backupIDs(f);
  e = item(f.sync());
  assert.equal(e.disabled, true);
  assert.equal(e.deleted, true);
  assert.equal(existsSync(f.active()), false);
  assert.equal(existsSync(source(f, e)), false, 'Refresh must not recreate a source the user deleted');
  assert.equal(activeSkillRoot(f.options), f.path('.claude', 'skills'), 'An intentionally deleted fork does not block other chats');
  const backup = newBackup(f, before);
  assert.equal(text(f.manager('backups', backup.id, 'before', '0', 'alpha', 'SKILL.md')),
    doc('alpha', 'Keep a recovery copy.'));
  const deletedSnapshot = managedSnapshot(f);
  assert.throws(() => f.action('enable'), /missing|restore|latest|deleted/i,
    'A missing personal source needs restoration or an explicit switch to the latest default');
  assert.deepEqual(managedSnapshot(f), deletedSnapshot);
});

test('explicit disable persists through upgrades and explicit enable restores the chosen source', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  f.action('disable');
  f.release([definition('alpha', { version: '2.0.0', body: 'Updated but disabled.' })]);
  assert.equal(item(f.sync()).disabled, true);
  assert.equal(existsSync(f.active()), false);
  assert.equal(item(f.action('enable')).disabled, false);
  assert.equal(text(f.active()), doc('alpha', 'Updated but disabled.'));
});

test('a new custom skill cannot silently take a reserved core name', (t) => {
  const f = fixture(t);
  const personal = makePersonal(f, 'my-alpha', 'alpha', 'My independent alpha.', 'user.alpha');
  let view = f.sync({ fresh: true });
  const custom = item(view, 'user.alpha'), bundled = item(view);
  assert.equal(custom.mode, 'custom');
  assert.equal(custom.pending, true);
  assert.match(custom.reason, /reserved|not activated/i);
  assert.equal(bundled.pending, false);
  assert.equal(custom.published, null);
  assert.equal(text(f.active()), doc('alpha', 'Bundled alpha version one.'));
  assert.equal(text(join(personal, 'SKILL.md')), doc('alpha', 'My independent alpha.'));
  assert.equal(readJSON(f.active('alpha', MARKER)).id, 'octopus.alpha');
  view = f.action('disable', 'user.alpha');
  assert.equal(item(view).collision, null);
  assert.equal(readJSON(f.active('alpha', MARKER)).id, 'octopus.alpha');
  assert.equal(text(join(personal, 'SKILL.md')), doc('alpha', 'My independent alpha.'));
});

test('a non-skill folder occupying a bundled name is preserved and reported', (t) => {
  const f = fixture(t);
  write(f.active('alpha', 'personal-notes.txt'), 'Unrelated folder contents.\n');
  const e = item(f.sync({ fresh: true }));
  assert.equal(e.pending, true);
  assert.equal(e.published, null);
  assert.equal(text(f.active('alpha', 'personal-notes.txt')), 'Unrelated folder contents.\n');
  assert.equal(existsSync(f.active()), false);
});

test('two personal skills with a case-insensitive name collision fail without deleting either', (t) => {
  const f = fixture(t);
  makePersonal(f, 'first-folder', 'shared', 'First personal skill.', 'user.first');
  makePersonal(f, 'second-folder', 'Shared', 'Second personal skill.', 'user.second');
  const before = managedSnapshot(f);
  assert.throws(() => f.sync({ fresh: true }), /two personal|name/i);
  assert.deepEqual(managedSnapshot(f), before);
});

test('two source folders claiming the same stable identity are rejected unchanged', (t) => {
  const f = fixture(t);
  makePersonal(f, 'one', 'one', 'First copy.', 'user.same');
  makePersonal(f, 'two', 'two', 'Second copy.', 'user.same');
  const before = managedSnapshot(f);
  assert.throws(() => f.sync({ fresh: true }), /two personal|claim/i);
  assert.deepEqual(managedSnapshot(f), before);
});

test('personal namespace collisions cannot silently change identity ownership', async (t) => {
  for (const kind of ['new-bundled-id-in-custom', 'default-in-custom', 'override-in-custom', 'custom-in-overrides']) {
    await t.test(kind, (t) => {
      const f = fixture(t);
      if (kind !== 'new-bundled-id-in-custom') f.sync({ fresh: true });
      if (kind === 'default-in-custom' || kind === 'new-bundled-id-in-custom') {
        makePersonal(f, 'stolen-default', 'personal-alpha', 'Keep this competing copy.', 'octopus.alpha');
      } else if (kind === 'override-in-custom') {
        const e = item(f.action('customize'));
        renameSync(dirname(source(f, e)), f.path('skills', 'custom', 'moved-override'));
      } else {
        const personal = makePersonal(f, 'personal', 'personal', 'Keep this custom skill.', 'user.personal');
        f.sync();
        renameSync(personal, f.path('skills', 'overrides', 'moved-custom'));
      }
      const before = managedSnapshot(f);
      assert.throws(() => f.sync({ fresh: kind === 'new-bundled-id-in-custom' }), /identity|belongs|bundled|custom/i);
      assert.deepEqual(managedSnapshot(f), before);
    });
  }
});

test('removed defaults stay disabled after reintroduction until explicitly enabled', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  f.release([]);
  let e = item(f.sync());
  assert.equal(e.removed, true);
  assert.equal(e.disabled, true);
  assert.equal(existsSync(f.active()), false);
  assert.throws(() => f.action('enable'), /removed/i);
  f.release([definition('alpha', { version: '2.0.0', body: 'Reintroduced default.' })]);
  e = item(f.sync());
  assert.equal(e.removed, false);
  assert.equal(e.disabled, true);
  assert.equal(e.returned, true);
  assert.equal(e.pending, true);
  e = item(f.action('enable'));
  assert.equal(e.returned, false);
  assert.equal(e.pending, false);
  assert.equal(text(f.active()), doc('alpha', 'Reintroduced default.'));
});

test('upstream removal preserves custom wording and lets the user acknowledge the removal', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  let e = item(f.action('customize'));
  write(source(f, e), doc('alpha', 'My still-useful version.'));
  f.sync();
  f.release([]);
  e = item(f.sync());
  assert.equal(e.mode, 'override');
  assert.equal(e.removed, true);
  assert.equal(e.disabled, false);
  assert.equal(e.pending, true);
  assert.equal(e.canUseLatest, false);
  assert.equal(text(f.active()), doc('alpha', 'My still-useful version.'));
  const comparison = compareSkill({ ...f.options, id: e.id, revision: f.view().revision });
  assert.equal(comparison.files.find((file) => file.path === 'SKILL.md').status, 'removed');
  assert.equal(item(f.action('keep')).pending, false);
  assert.equal(text(source(f, e)), doc('alpha', 'My still-useful version.'));
});

test('new requirements produce a persistent review notice and never install anything', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  f.release([definition('alpha', {
    version: '2.0.0', body: 'Requires a separately configured tool.',
    dependencies: ['ExampleTool 2 or newer', 'Optional API connection'],
  })]);
  let e = item(f.sync());
  assert.deepEqual(e.dependencies, ['ExampleTool 2 or newer', 'Optional API connection']);
  assert.equal(e.requirementsNotice, true);
  assert.match(e.reason, /nothing was installed/i);
  assert.equal(item(f.sync()).requirementsNotice, true);
  e = item(f.action('keep'));
  assert.equal(e.requirementsNotice, false);
  assert.equal(existsSync(f.path('node_modules')), false);
  assert.equal(existsSync(join(f.appRoot, 'node_modules')), false);
});

test('new bundled skills arrive on the same sync and existing customized skills remain selected', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  const customized = item(f.action('customize'));
  write(source(f, customized), doc('alpha', 'My existing choice.'));
  f.sync();
  const additions = ['beta', 'gamma', 'delta', 'epsilon', 'zeta'].map((name) => definition(name));
  f.release([definition('alpha', { version: '2.0.0', body: 'New alpha default.' }), ...additions]);
  const view = f.sync();
  assert.equal(view.items.length, 6);
  assert.equal(item(view).mode, 'override');
  assert.equal(text(f.active()), doc('alpha', 'My existing choice.'));
  for (const d of additions) {
    assert.equal(item(view, d.id).disabled, false);
    assertOneActive(f, d.name, d.id);
  }
});

test('unchanged repeated syncs are idempotent and do not manufacture new backups or revisions', (t) => {
  const f = fixture(t);
  const first = f.sync({ fresh: true });
  const before = managedSnapshot(f), backups = backupIDs(f);
  for (let i = 0; i < 3; i++) {
    const view = f.sync();
    assert.equal(view.revision, first.revision);
    assert.equal(view.release, first.release);
    assert.deepEqual(backupIDs(f), backups);
    assert.deepEqual(managedSnapshot(f), before);
  }
});

test('stale and absent revision tokens cannot apply choices or compare a different snapshot', (t) => {
  const f = fixture(t);
  const first = f.sync({ fresh: true });
  f.action('customize');
  const before = managedSnapshot(f);
  for (const revision of [undefined, first.revision, 'not-a-revision']) {
    assert.throws(() => f.sync({ action: { action: 'latest', id: 'octopus.alpha', revision } }), /changed|refresh/i);
    assert.throws(() => compareSkill({ ...f.options, id: 'octopus.alpha', revision }), /changed|refresh/i);
  }
  assert.deepEqual(managedSnapshot(f), before);
  assert.equal(f.sync({ action: { action: 'refresh' } }).ok, true);
});

test('every before/after install interruption recovers safely and preserves subsequent personal writes', async (t) => {
  for (const phase of ['before', 'after']) {
    for (let index = 0; index < TARGETS.length; index++) {
      const point = `${phase}-install-${index}`;
      await t.test(point, (t) => {
        const f = fixture(t);
        f.sync({ fresh: true });
        makePersonal(f, 'personal', 'personal', 'A custom skill that must survive.', 'user.personal');
        f.sync();
        f.release([definition('alpha', { version: '2.0.0', body: 'Updated after recovery.' })]);
        assert.throws(() => f.sync({
          fault(current) { if (current === point) throw new Error(`Synthetic interruption: ${point}`); },
        }), /Synthetic interruption/);
        assert.equal(existsSync(f.manager('journal.json')), true);
        assert.throws(() => activeSkillRoot(f.options), /recovery|restart/i);
        const journal = readJSON(f.manager('journal.json'));
        let extra;
        if (phase === 'after' && index === 0) {
          extra = f.active('alpha', 'written-after-interruption.txt');
          write(extra, 'Preserve an edit made after interruption.\n');
        }
        const view = f.sync();
        assert.equal(view.ok, true, view.error);
        assert.equal(existsSync(f.manager('journal.json')), false);
        assert.equal(text(f.active()), doc('alpha', 'Updated after recovery.'));
        assert.equal(text(f.active('personal')), doc('personal', 'A custom skill that must survive.'));
        assert.equal(activeSkillRoot(f.options), f.path('.claude', 'skills'));
        const receipt = readJSON(f.manager('backups', journal.id, 'receipt.json'));
        assert.equal(receipt.id, journal.id);
        if (phase === 'after' && index === 3) {
          assert.notEqual(receipt.recovered, true, 'A committed transaction is a completed, restorable update');
          assert.equal(f.view().backups.find((b) => b.id === journal.id).restorable, true);
        }
        if (extra) {
          const retained = snapshot(f.manager('backups', journal.id, 'interrupted'));
          assert.ok(Object.entries(retained).some(([path, data]) =>
            path.endsWith('/alpha/written-after-interruption.txt') &&
            Buffer.from(data, 'base64').toString('utf8') === 'Preserve an edit made after interruption.\n'));
        }
        const stable = f.view().revision;
        assert.equal(f.sync().revision, stable, 'Recovery is repeatable without another transaction');
      });
    }
  }
});

test('an interrupted first installation is recoverable without guessing earlier ownership', (t) => {
  const f = fixture(t);
  assert.throws(() => f.sync({
    fresh: true,
    fault(point) { if (point === 'after-install-0') throw new Error('First-install interruption'); },
  }), /First-install interruption/);
  const view = f.sync({ fresh: true });
  assert.equal(item(view).disabled, false);
  assert.equal(existsSync(f.manager('journal.json')), false);
  assertOneActive(f, 'alpha', 'octopus.alpha');
});

test('restoring a backup pins all skill choices and backs up the displaced current snapshot', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  let e = item(f.action('customize'));
  write(source(f, e), doc('alpha', 'The personal wording to restore.'));
  f.sync();
  const prior = f.view(), priorSources = TARGETS.slice(0, 3).map((path) => snapshot(f.path(path)));
  f.release([definition('alpha', { version: '2.0.0', body: 'A newer default.' })]);
  f.sync();
  const beforeLatest = backupIDs(f);
  f.action('latest');
  const replacement = newBackup(f, beforeLatest);
  assert.equal(replacement.restorable, true);
  const beforeRestore = backupIDs(f);
  let view = f.action('restore', undefined, { backup: replacement.id });
  assert.equal(view.held, true);
  assert.match(view.holdReason, /restored|resume/i);
  assert.equal(item(view).mode, 'override');
  assert.equal(text(f.active()), doc('alpha', 'The personal wording to restore.'));
  assert.deepEqual(TARGETS.slice(0, 3).map((path) => snapshot(f.path(path))), priorSources);
  assert.notEqual(view.revision, prior.revision);
  const restoringBackup = newBackup(f, beforeRestore);
  assert.equal(text(f.manager('backups', restoringBackup.id, 'before', '0', 'alpha', 'SKILL.md')),
    doc('alpha', 'A newer default.'));
  const heldRevision = view.revision, heldFiles = managedSnapshot(f);
  f.release([definition('alpha', { version: '3.0.0', body: 'An even newer default.' })]);
  view = f.sync();
  assert.equal(view.held, true);
  assert.equal(view.revision, heldRevision);
  assert.deepEqual(managedSnapshot(f), heldFiles);
  assert.equal(activeSkillRoot(f.options), f.path('.claude', 'skills'));
  view = f.sync({ action: { action: 'refresh' } });
  assert.equal(view.held, false);
  assert.equal(item(view).version, '3.0.0');
  assert.equal(text(f.active()), doc('alpha', 'The personal wording to restore.'));
});

test('rollback to an older app release preserves an override and reports the older default', (t) => {
  const v1 = definition(), v2 = definition('alpha', { version: '2.0.0', body: 'Version two.' });
  const f = fixture(t, [v1]);
  f.sync({ fresh: true });
  const e = item(f.action('customize'));
  write(source(f, e), doc('alpha', 'Personal wording across rollback.'));
  f.sync();
  f.release([v2]);
  f.sync();
  f.action('keep');
  f.release([v1]);
  const rolled = item(f.sync());
  assert.equal(rolled.rollbackNotice, true);
  assert.equal(rolled.mode, 'override');
  assert.equal(text(f.active()), doc('alpha', 'Personal wording across rollback.'));
  assert.equal(item(f.action('keep')).rollbackNotice, false);
});

test('reusing a version for different bundled content is rejected without replacing files', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  const before = managedSnapshot(f);
  f.release([definition('alpha', { body: 'Changed without a version bump.' })]);
  assert.throws(() => f.sync(), /version bump|new version/i);
  assert.deepEqual(managedSnapshot(f), before);
  assert.throws(() => activeSkillRoot(f.options), /app changed|restart/i);
});

test('malformed catalogs and unsafe source paths are rejected before studio mutation', async (t) => {
  const cases = [
    ['schema', (c) => { c.schema = 2; }],
    ['non-array skills', (c) => { c.skills = {}; }],
    ['invalid stable id', (c) => { c.skills[0].id = '../alpha'; }],
    ['invalid name', (c) => { c.skills[0].name = 'bad/name'; }],
    ['invalid version', (c) => { c.skills[0].version = 'latest'; }],
    ['path traversal', (c) => { c.skills[0].path = '../outside'; }],
    ['absolute path', (c) => { c.skills[0].path = '/outside'; }],
    ['backslash path', (c) => { c.skills[0].path = 'bundled\\alpha'; }],
    ['duplicate identity', (c) => { c.skills.push({ ...c.skills[0], name: 'beta', path: 'bundled/beta' }); }],
    ['case-insensitive duplicate name', (c) => { c.skills.push({ ...c.skills[0], id: 'octopus.other', name: 'Alpha', path: 'bundled/beta' }); }],
    ['duplicate source path', (c) => { c.skills.push({ ...c.skills[0], id: 'octopus.other', name: 'beta' }); }],
    ['mismatched frontmatter name', (c) => { c.skills[0].name = 'different'; }],
    ['bad legacy name', (c) => { c.skills[0].legacyNames = ['../alpha']; }],
    ['bad dependency metadata', (c) => { c.skills[0].dependencies = [42]; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, (t) => {
      const f = fixture(t);
      f.sync({ fresh: true });
      const before = managedSnapshot(f), path = join(f.appRoot, 'core', 'skills.json');
      const catalog = readJSON(path);
      mutate(catalog);
      writeJSON(path, catalog);
      assert.throws(() => loadSkillCatalog(f.appRoot));
      assert.throws(() => f.sync());
      assert.deepEqual(managedSnapshot(f), before);
    });
  }
});

test('symlinked bundled sources, source files, and managed roots are rejected without modifying targets', async (t) => {
  for (const kind of ['bundled-folder', 'bundled-file', 'managed-root']) {
    await t.test(kind, (t) => {
      const f = fixture(t);
      f.sync({ fresh: true });
      const outside = join(f.root, 'outside-target');
      mkdirSync(outside);
      write(join(outside, 'SKILL.md'), doc('alpha', 'Never overwrite or follow me.'));
      const target = kind === 'bundled-folder' ? join(f.appRoot, 'bundled', 'alpha')
        : kind === 'bundled-file' ? join(f.appRoot, 'bundled', 'alpha', 'SKILL.md')
          : f.path('skills', 'overrides');
      rmSync(target, { recursive: true, force: true });
      try {
        symlinkSync(kind === 'bundled-file' ? join(outside, 'SKILL.md') : outside,
          target, kind === 'bundled-file' ? 'file' : process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
          t.skip('This runner cannot create symlinks; rerun this case on a symlink-capable isolated runner.');
          return;
        }
        throw error;
      }
      const outsideBefore = snapshot(outside), stateBefore = text(f.manager('state.json'));
      assert.throws(() => f.sync(), /symbolic link|unsupported skill file/i);
      assert.deepEqual(snapshot(outside), outsideBefore);
      assert.equal(text(f.manager('state.json')), stateBefore);
      assert.equal(lstatSync(target).isSymbolicLink(), true);
    });
  }
});

test('text comparison flags binary and oversized files without returning their content', (t) => {
  const f = fixture(t, [definition('alpha', {
    files: { 'binary.bin': Buffer.from([0, 1]), 'large.txt': 'a'.repeat(40000) },
  })]);
  f.sync({ fresh: true });
  f.action('customize');
  f.release([definition('alpha', {
    version: '2.0.0',
    files: { 'binary.bin': Buffer.from([0, 2]), 'large.txt': 'b'.repeat(40000) },
  })]);
  const view = f.sync();
  const comparison = compareSkill({ ...f.options, id: 'octopus.alpha', revision: view.revision });
  const binary = comparison.files.find((entry) => entry.path === 'binary.bin');
  const large = comparison.files.find((entry) => entry.path === 'large.txt');
  assert.equal(binary.binary, true);
  assert.equal(binary.mine, null);
  assert.equal(binary.latest, null);
  assert.equal(large.tooLarge, true);
  assert.equal(large.mine, null);
  assert.equal(large.latest, null);
});

test('unrecognized identity metadata is rejected without discarding the affected copy', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  writeJSON(f.active('alpha', MARKER), { schema: 99, id: 'octopus.alpha' });
  const before = managedSnapshot(f);
  assert.throws(() => f.sync(), /identity|unrecognized/i);
  assert.deepEqual(managedSnapshot(f), before);
});

test('unmigrated or changed releases cannot be handed to a harness as an active skill root', (t) => {
  const f = fixture(t);
  assert.throws(() => activeSkillRoot(f.options), /migrate|restart/i);
  f.sync({ fresh: true });
  f.release([definition('alpha', { version: '2.0.0', body: 'A pending app release.' })]);
  assert.throws(() => activeSkillRoot(f.options), /app changed|restart/i);
  f.sync();
  assert.equal(activeSkillRoot(f.options), f.path('.claude', 'skills'));
  assert.equal(state(f).release, loadSkillCatalog(f.appRoot).release);
});

test('inactive forks remain saved through source edits, refresh and repeated Customize', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  let e = item(f.action('customize'));
  write(source(f, e), doc('alpha', 'My saved fork.'));
  f.sync();
  f.action('latest');
  f.release([definition('alpha', { version: '2.0.0', body: 'The current core.' })]);
  f.sync();
  write(source(f, e), doc('alpha', 'My edited inactive fork.'));
  assert.throws(() => activeSkillRoot(f.options), /sources changed|refresh/i);
  e = item(f.sync());
  assert.equal(e.mode, 'default');
  assert.equal(e.forkAvailable, true);
  assert.equal(e.forkVersion, '1.0.0');
  assert.equal(e.activeVersion, '2.0.0');
  assert.equal(e.availableVersion, '2.0.0');
  assert.equal(text(f.active()), doc('alpha', 'The current core.'));
  assert.equal(activeSkillRoot(f.options), f.path('.claude', 'skills'));
  const comparison = compareSkill({ ...f.options, id: e.id, revision: f.view().revision });
  assert.equal(comparison.files.find((x) => x.path === 'SKILL.md').mine, doc('alpha', 'My edited inactive fork.'));
  e = item(f.action('customize'));
  assert.equal(e.mode, 'override');
  assert.equal(e.forkVersion, '1.0.0');
  assert.equal(text(f.active()), doc('alpha', 'My edited inactive fork.'));
  assert.equal(text(source(f, e)), doc('alpha', 'My edited inactive fork.'));
});

test('editing active core cannot overwrite a different saved inactive fork', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  const e = item(f.action('customize'));
  write(source(f, e), doc('alpha', 'A saved custom version.'));
  f.sync(); f.action('latest');
  write(f.active(), doc('alpha', 'A different edit to core.'));
  const before = managedSnapshot(f);
  assert.throws(() => f.sync(), /active core.*saved custom|reconcile/i);
  assert.deepEqual(managedSnapshot(f), before);
});

test('deleting an inactive fork leaves selected core enabled and allows a new explicit fork', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  let e = item(f.action('customize'));
  f.action('latest');
  rmSync(dirname(source(f, e)), { recursive: true });
  e = item(f.sync());
  assert.equal(e.mode, 'default');
  assert.equal(e.disabled, false);
  assert.equal(e.forkAvailable, false);
  assert.equal(activeSkillRoot(f.options), f.path('.claude', 'skills'));
  assert.throws(() => f.action('use-custom'), /no saved custom/i);
  f.release([definition('alpha', { version: '2.0.0', body: 'New base.' })]);
  f.sync();
  e = item(f.action('customize'));
  assert.equal(e.forkVersion, '2.0.0');
  assert.equal(text(source(f, e)), doc('alpha', 'New base.'));
});

test('direct core edits after deleting an inactive fork start from the current publication baseline', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  let e = item(f.action('customize'));
  f.action('latest');
  rmSync(dirname(source(f, e)), { recursive: true });
  f.sync();
  f.release([definition('alpha', { version: '2.0.0', body: 'API two core.' })], 2);
  f.sync();
  write(f.active(), doc('alpha', 'A new edit to the current core.'));
  e = item(f.sync());
  assert.equal(e.forkVersion, '2.0.0');
  assert.equal(e.forkApiVersion, 2);
  assert.equal(e.compatibilityBlocked, false);
  assert.equal(text(source(f, e)), doc('alpha', 'A new edit to the current core.'));
  assert.equal(activeSkillRoot(f.options), f.path('.claude', 'skills'));
});

test('a different active copy of a disabled skill is preserved for reconciliation', (t) => {
  const f = fixture(t);
  makePersonal(f, 'personal', 'personal', 'My saved instructions.', 'user.personal');
  f.sync({ fresh: true });
  f.action('disable', 'user.personal');
  write(f.active('personal'), doc('personal', 'New instructions placed directly in active.'));
  writeJSON(f.active('personal', MARKER), { schema: 1, id: 'user.personal' });
  const before = managedSnapshot(f);
  assert.throws(() => f.sync(), /inactive skill.*different active copy/i);
  assert.deepEqual(managedSnapshot(f), before);
  assert.equal(text(f.path('skills', 'custom', 'personal', 'SKILL.md')), doc('personal', 'My saved instructions.'));
});

test('an API change withholds only the incompatible selected fork until explicit review', (t) => {
  const f = fixture(t, [definition(), definition('beta')]);
  f.sync({ fresh: true });
  let e = item(f.action('customize'));
  write(source(f, e), doc('alpha', 'My API one workflow.'));
  f.sync();
  f.release([definition('alpha', { version: '2.0.0', body: 'API two core.' }), definition('beta')], 2);
  e = item(f.sync());
  assert.equal(e.compatibilityBlocked, true);
  assert.match(e.compatibilityReason, /API 1.*API 2/i);
  assert.equal(e.forkApiVersion, 1);
  assert.equal(e.forkVersion, '1.0.0');
  assert.equal(e.activeVersion, null);
  assert.equal(e.availableVersion, '2.0.0');
  assert.equal(existsSync(f.active()), false);
  assert.equal(text(f.active('beta')), doc('beta', 'Bundled beta version one.'));
  assert.equal(activeSkillRoot(f.options), f.path('.claude', 'skills'), 'Other workflows remain usable');
  assert.match(skillSelectionBrief(f.options), /API: 2.*Unavailable selected custom workflows: alpha/i);
  assert.equal(item(f.action('keep')).compatibilityBlocked, true, 'Keep mine cannot assert compatibility');
  assert.equal(existsSync(f.active()), false);
  e = item(f.action('latest'));
  assert.equal(e.mode, 'default');
  assert.equal(e.compatibilityBlocked, true, 'Inactive saved fork still needs review');
  assert.equal(e.pending, false, 'An inactive fork is an advisory, not an outstanding action for current core');
  assert.equal(e.activeVersion, '2.0.0');
  assert.equal(text(source(f, e)), doc('alpha', 'My API one workflow.'));
  assert.equal(activeSkillRoot(f.options), f.path('.claude', 'skills'));
  assert.doesNotMatch(skillSelectionBrief(f.options), /Unavailable selected/);
  f.action('use-custom');
  assert.equal(existsSync(f.active()), false);
  write(source(f, e), doc('alpha', 'Reviewed and adapted for API two.'));
  f.sync();
  e = item(f.action('confirm-compatibility'));
  assert.equal(e.compatibilityBlocked, false);
  assert.equal(e.forkApiVersion, 2);
  assert.equal(e.forkVersion, '1.0.0', 'Review does not invent a newer fork base version');
  assert.equal(e.activeVersion, '1.0.0');
  assert.equal(text(f.active()), doc('alpha', 'Reviewed and adapted for API two.'));
  assert.equal(activeSkillRoot(f.options), f.path('.claude', 'skills'));
});

test('existing manager overrides without baseline metadata remain unknown until reviewed', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  const e = item(f.action('customize'));
  write(source(f, e), doc('alpha', 'Old manager personal instructions.'));
  f.sync();
  const old = state(f), entry = old.entries[e.id];
  for (const key of ['forkAvailable', 'forkName', 'forkVersion', 'forkApiVersion']) delete entry[key];
  delete entry.published.version; delete entry.published.apiVersion;
  entry.version = '9.9.9'; // Old managers recorded the available upstream version, not the actual fork base.
  writeJSON(f.manager('state.json'), old);
  const migrated = item(f.sync());
  assert.equal(migrated.forkVersion, null);
  assert.equal(migrated.forkApiVersion, null);
  assert.equal(migrated.compatibilityBlocked, true);
  assert.equal(existsSync(f.active()), false);
  assert.equal(text(source(f, migrated)), doc('alpha', 'Old manager personal instructions.'));
  assert.equal(item(f.action('keep')).compatibilityBlocked, true);
  assert.equal(item(f.action('confirm-compatibility')).forkVersion, null);
  assert.equal(text(f.active()), doc('alpha', 'Old manager personal instructions.'));
});

test('a held restored fork cannot bypass a newer API contract', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  let e = item(f.action('customize'));
  write(source(f, e), doc('alpha', 'Preserve this old fork.'));
  f.sync();
  const before = backupIDs(f);
  f.action('latest');
  const selectedCore = newBackup(f, before);
  f.release([definition('alpha', { version: '2.0.0', body: 'New API core.' })], 2);
  f.sync();
  const restored = f.action('restore', undefined, { backup: selectedCore.id });
  e = item(restored);
  assert.equal(restored.held, true);
  assert.equal(e.mode, 'override');
  assert.equal(e.compatibilityBlocked, true);
  assert.equal(e.published, null);
  assert.equal(existsSync(f.active()), false);
  assert.equal(text(source(f, e)), doc('alpha', 'Preserve this old fork.'));
  assert.equal(activeSkillRoot(f.options), f.path('.claude', 'skills'));
  assert.match(skillSelectionBrief(f.options), /Unavailable selected custom workflows: alpha/);
  assert.equal(item(f.sync()).compatibilityBlocked, true);
});

test('a held snapshot cannot silently resume core updates through a per-skill action', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  const before = backupIDs(f);
  f.action('customize');
  const selectedFork = newBackup(f, before);
  f.release([definition('alpha', { version: '2.0.0', body: 'Current compatible core.' })]);
  f.sync();
  const restored = f.action('restore', undefined, { backup: selectedFork.id });
  assert.equal(restored.held, true);
  assert.equal(text(f.active()), doc('alpha', 'Bundled alpha version one.'));
  const heldFiles = managedSnapshot(f);
  for (const action of ['disable', 'enable', 'latest', 'keep', 'customize', 'use-custom', 'confirm-compatibility']) {
    assert.throws(() => f.action(action), /snapshot is held.*Resume/i);
    assert.deepEqual(managedSnapshot(f), heldFiles);
  }
  assert.ok(compareSkill({ ...f.options, id: 'octopus.alpha', revision: f.view().revision }).files.length);
  const resumed = f.action('refresh');
  assert.equal(resumed.held, false);
  assert.equal(text(f.active()), doc('alpha', 'Current compatible core.'));
});

test('a held old core snapshot is rejected after an API epoch change', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  const before = backupIDs(f);
  f.action('customize');
  const selectedFork = newBackup(f, before);
  f.release([definition('alpha', { version: '2.0.0', body: 'New API core.' })], 2);
  f.sync(); f.action('latest');
  const snapshotBefore = managedSnapshot(f);
  assert.throws(() => f.action('restore', undefined, { backup: selectedFork.id }), /different or unknown app API/i);
  assert.deepEqual(managedSnapshot(f), snapshotBefore);
  const held = state(f);
  held.held = true; held.entries['octopus.alpha'].published.apiVersion = 1;
  writeJSON(f.manager('state.json'), held);
  assert.throws(() => activeSkillRoot(f.options), /incompatible|API/i, 'Held metadata cannot bypass the harness guard');
});

test('restore validates backup paths before changing any managed files', (t) => {
  const f = fixture(t);
  f.sync({ fresh: true });
  const before = backupIDs(f);
  f.action('customize');
  const backup = newBackup(f, before), path = f.manager('backups', backup.id, 'before', '3');
  const corrupt = readJSON(path);
  corrupt.entries['octopus.alpha'].published.folder = '../../outside';
  writeJSON(path, corrupt);
  const current = managedSnapshot(f);
  assert.throws(() => f.action('restore', undefined, { backup: backup.id }), /Invalid skill-state/i);
  assert.deepEqual(managedSnapshot(f), current);
});

test('existing legacy custom name collisions remain explicit without losing the selected source', (t) => {
  const f = fixture(t);
  const personal = makePersonal(f, 'my-alpha', 'alpha', 'My pre-manager alpha.', 'user.alpha');
  cpSync(personal, dirname(f.active()), { recursive: true });
  const view = f.sync({ fresh: true });
  const custom = item(view, 'user.alpha');
  assert.equal(custom.legacyCollision, true);
  assert.match(custom.reason, /reserved.*legacy selection/i);
  assert.equal(text(f.active()), doc('alpha', 'My pre-manager alpha.'));
  assert.equal(item(view).published, null);
  f.action('disable', custom.id);
  assertOneActive(f, 'alpha', 'octopus.alpha');
});

test('legacy ownership does not authorize a new collision with a reserved core name', (t) => {
  const f = fixture(t);
  const personal = makePersonal(f, 'personal', 'personal', 'My legacy workflow.', 'user.personal');
  cpSync(personal, dirname(f.active('personal')), { recursive: true });
  f.sync({ fresh: true });
  write(join(personal, 'SKILL.md'), doc('alpha', 'Renamed legacy workflow.'));
  const custom = item(f.sync(), 'user.personal');
  assert.equal(custom.published, null);
  assert.equal(custom.legacyCollision, false);
  assert.match(custom.reason, /reserved.*not activated/i);
  assert.equal(text(f.active()), doc('alpha', 'Bundled alpha version one.'));
  assert.equal(text(join(personal, 'SKILL.md')), doc('alpha', 'Renamed legacy workflow.'));
});

test('former core names are also reserved for independent custom skills', (t) => {
  const f = fixture(t, [definition('alpha', { legacyNames: ['old-alpha'] })]);
  const personal = makePersonal(f, 'personal', 'OLD-ALPHA', 'An independent skill.', 'user.personal');
  const custom = item(f.sync({ fresh: true }), 'user.personal');
  assert.equal(custom.published, null);
  assert.match(custom.reason, /reserved.*not activated/i);
  assert.equal(text(f.active()), doc('alpha', 'Bundled alpha version one.'));
  assert.equal(text(join(personal, 'SKILL.md')), doc('OLD-ALPHA', 'An independent skill.'));
});

test('catalog API metadata is an epoch, with a legacy default and no non-integer values', (t) => {
  const f = fixture(t), path = join(f.appRoot, 'core', 'skills.json');
  const catalog = readJSON(path);
  delete catalog.apiVersion; writeJSON(path, catalog);
  assert.equal(loadSkillCatalog(f.appRoot).apiVersion, 1);
  const first = loadSkillCatalog(f.appRoot).release;
  catalog.apiVersion = 2; writeJSON(path, catalog);
  assert.notEqual(loadSkillCatalog(f.appRoot).release, first);
  for (const apiVersion of [0, -1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
    writeJSON(path, { ...catalog, apiVersion });
    assert.throws(() => loadSkillCatalog(f.appRoot), /API version/i);
  }
});

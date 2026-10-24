// Flat 3 (ADDENDUM-styles-gallery.md): styles are formats listed flat, brand kits are profiles. The flat lists of
// web/style-list.js (My styles cards, the editor's style picker), the hidden No brand kit and memory isolation when a
// style changes kit. Store-level; the HTTP move endpoint is tested in test/new-video.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { styleEntries, pickerItems, setupShape, kitColor } from '../web/style-list.js';
import { ProfileStore } from '../server/profile-store.mjs';
import { MemoryStore } from '../server/memory-store.mjs';

const INFO = { tutorial: { aspect: '16:9' }, short: { aspect: '9:16' }, explainer: { aspect: '16:9' } };
const DATA = {
  profiles: [
    { id: 'A', name: 'Bart', brand: { brand: { colors: ['#1d4ed8'] } } },
    { id: 'B', name: 'Faceless AI', brand: null },
    { id: 'N', name: 'No brand', system: 'unbranded' },
    { id: 'X', name: 'Old kit', archived: true },
  ],
  formats: [
    { id: 'f1', profileId: 'A', name: 'YouTube tutorial', type: 'tutorial', activeVersion: 'v1', created: '2026-10-01T00:00:00Z' },
    { id: 'f2', profileId: 'A', name: 'Tutorial Short', type: 'short', created: '2026-10-02T00:00:00Z', description: 'One tip, fast cuts.' },
    { id: 'f3', profileId: 'B', name: 'Faceless reel', type: 'short', created: '2026-10-03T00:00:00Z' },
    { id: 'f4', profileId: 'N', name: 'Product demo', type: 'explainer', created: '2026-10-04T00:00:00Z' },
    { id: 'f5', profileId: 'A', name: 'Retired', type: 'tutorial', archived: true, created: '2026-10-05T00:00:00Z' },
    { id: 'f6', profileId: 'X', name: 'In an archived kit', type: 'tutorial', created: '2026-10-06T00:00:00Z' },
  ],
  versions: [{ id: 'v1', formatId: 'f1', number: 2 }],
  projects: [{ id: 'p1', formatId: 'f1', updated: Date.parse('2026-10-20T00:00:00Z') }, { id: 'p2', formatId: 'f1', updated: 1 }],
  drafts: new Map([['f3', 3]]),
  formatInfo: INFO,
};

test('style cards: one flat list, most recently used first, with kit chip, kind and meta', () => {
  const list = styleEntries(DATA);
  assert.deepEqual(list.map((e) => e.id), ['f1', 'f4', 'f3', 'f2'], 'used most recently first; archived styles and kits hidden');
  const [tutorial, demo, reel, short] = list;
  assert.deepEqual([tutorial.badge, tutorial.kitName, tutorial.kitColor, tutorial.meta], ['Long · 16:9', 'Bart', '#1d4ed8', 'Skill v2 · 2 videos']);
  assert.deepEqual([short.badge, short.tall, short.description, short.meta], ['Short · 9:16', true, 'One tip, fast cuts.', 'Basic · no videos yet']);
  assert.deepEqual([demo.kitName, demo.unbranded, demo.kitColor], ['No brand', true, null]);
  assert.equal(reel.changes, 3);
  assert.equal(reel.kitColor, null, 'a kit without an approved brand has no colour');
  assert.deepEqual(styleEntries(DATA, { archived: true }).filter((e) => e.archived).map((e) => e.id).sort(), ['f5', 'f6']);
  assert.deepEqual(styleEntries(DATA, { profileId: 'A' }).map((e) => e.id), ['f1', 'f2']);
  assert.equal(setupShape('short', INFO).badge, 'Short · 9:16');
  assert.equal(kitColor({ brand: { brand: { colors: ['red'] } } }), null, 'only hex brand colours');
});

test('the editor picker is a flat list of styles with their kit, then No style and New style', () => {
  const entries = styleEntries(DATA, { archived: true });
  const items = pickerItems(entries, { context: { profileId: 'A', formatId: 'f2' } });
  const styles = items.filter((i) => i.kind === 'style');
  assert.ok(items.every((i) => i.kind !== 'group'), 'no grouping by kit');
  assert.deepEqual(styles.map((i) => i.label), ['YouTube tutorial', 'Product demo', 'Faceless reel', 'Tutorial Short']);
  assert.deepEqual(styles.map((i) => i.kit), ['Bart', 'No brand', 'Faceless AI', 'Bart']);
  assert.equal(styles.find((i) => i.selected).formatId, 'f2');
  assert.deepEqual(items.slice(-2).map((i) => i.kind), ['none', 'new']);
  assert.equal(items.at(-2).selected, false);
  // The video's own archived style stays listed; other archived ones don't.
  assert.ok(pickerItems(entries, { context: { formatId: 'f5' } }).some((i) => i.formatId === 'f5'));
  assert.ok(!pickerItems(entries, { context: {} }).some((i) => i.formatId === 'f5'));
  // After Build only styles with the video's setup can be picked.
  const built = pickerItems(entries, { context: {}, built: true, type: 'short' }).filter((i) => i.kind === 'style');
  assert.deepEqual(built.filter((i) => !i.locked).map((i) => i.formatId), ['f3', 'f2']);
  // A beta.14 video pinned to a kit without a style keeps that row; No style is then not selected.
  const kitOnly = pickerItems(entries, { context: { profileId: 'B', profileName: 'Faceless AI' } });
  assert.equal(kitOnly[0].kind, 'kit-only');
  assert.equal(kitOnly.find((i) => i.kind === 'none').selected, false);
});

const studio = (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-flat3-')));
  const open = [];
  const use = (Store) => { const s = new Store(root); open.push(s); return s; };
  t.after(() => { for (const s of open) { try { s.close(); } catch {} } rmSync(root, { recursive: true, force: true }); });
  return { root, use };
};

test('No brand: one hidden profile, made on demand, not a kit, never renamed, archived or branded', (t) => {
  const { use } = studio(t);
  const s = use(ProfileStore);
  const kit = s.profile('Bart');
  assert.equal(s.list('profiles').length, 1, 'nothing is created until a style needs it');
  const demo = s.format(null, 'Product demo', 'explainer', 0, 'Screen recording');
  const none = s.get('profiles', demo.profileId);
  assert.deepEqual([none.name, none.system], ['No brand', 'unbranded']);
  assert.equal(s.format('', 'Another', 'short').profileId, none.id);
  assert.equal(s.unbrandedProfile().id, none.id);
  assert.equal(s.list('profiles').filter((p) => p.system).length, 1);
  assert.equal(demo.description, 'Screen recording');
  assert.ok(s.isUnbranded(none.id) && !s.isUnbranded(kit.id));
  assert.throws(() => s.updateProfile(none.id, { expected: 1, name: 'Mine' }), /built in/);
  assert.throws(() => s.archiveProfile(none.id, 1, true), /built in/);
  assert.throws(() => s.saveBrand(none.id, { identity: 'x' }, null), /brand kit/);
  assert.throws(() => s.research(none.id, 'https://example.com'), /brand kit/);
  const m = use(MemoryStore);
  assert.ok(!m.levelNames().some((l) => l.id === `profile:${none.id}`), 'not offered as a memory level');
  // A kit that a style uses can't be archived when asked to refuse (the API does), naming the styles to move.
  s.format(kit.id, 'Tutorial', 'tutorial');
  assert.throws(() => s.archiveProfile(kit.id, 1, true, { refuseUsed: true }), /A style uses this brand kit: Tutorial/);
  const empty = s.profile('Unused');
  assert.equal(s.archiveProfile(empty.id, 1, true, { refuseUsed: true }).archived, true);
});

test('Change kit: the style conversation follows to the new kit memories; a video stays on its pinned kit', (t) => {
  const { use } = studio(t);
  const s = use(ProfileStore);
  const A = s.profile('Kit A'), B = s.profile('Kit B');
  const f = s.format(A.id, 'Reel', 'short');
  const study = s.session(f.id, { name: 'Study' });
  s.pinContext('video-1', { profileId: A.id, formatId: f.id, formatName: f.name, profileName: A.name });
  const m = use(MemoryStore);
  const chat = `_learning_${study.id}`;
  m.register(chat);
  m.register('video-1', { project: 'video-1' });
  const approve = (x) => m.change(x.id, x.revision, { op: 'approve', supersede: [] });
  approve(m.propose({ text: 'Spell it colour.', key: 'spelling', scope: `profile:${A.id}` }));
  approve(m.propose({ text: 'Spell it color.', key: 'spelling', scope: `profile:${B.id}` }));
  assert.ok(m.context(chat).includes('colour.') && !m.context(chat).includes('color.'));

  const moved = s.moveFormat(f.id, { profileId: B.id, expected: f.revision });
  assert.equal(moved.profileId, B.id);
  assert.throws(() => s.moveFormat(f.id, { profileId: A.id, expected: f.revision }), /changed/);
  assert.equal(s.list('sessions').find((x) => x.id === study.id).formatId, f.id, 'conversations stay with the style');
  // The style's conversation now gets kit B's memories, never kit A's.
  assert.deepEqual(m.chat(chat).scopes, ['global', `profile:${B.id}`, `format:${f.id}`]);
  assert.ok(m.context(chat).includes('color.') && !m.context(chat).includes('colour.'));
  // The video made before keeps kit A: registering again doesn't fail, and it still reads A's memories only.
  assert.doesNotThrow(() => m.register('video-1', { project: 'video-1' }));
  assert.deepEqual(m.chat('video-1').scopes, ['global', `profile:${A.id}`, `format:${f.id}`, 'project:video-1']);
  assert.ok(m.context('video-1').includes('colour.') && !m.context('video-1').includes('color.'));
  assert.equal(s.projectBundle('video-1').profileId, A.id, 'the pin is untouched');
  assert.doesNotThrow(() => s.validateBundle({ ...s.projectBundle('video-1'), instructionVersion: s.instructions().id }), 'a moved style\'s old pin stays valid');

  // To No brand: the conversation keeps Everything and its format only.
  const plain = s.moveFormat(f.id, { profileId: null, expected: moved.revision });
  assert.ok(s.isUnbranded(plain.profileId));
  assert.deepEqual(m.chat(chat).scopes, ['global', `format:${f.id}`]);
  assert.ok(!m.context(chat).includes('colour.') && !m.context(chat).includes('color.'));
  assert.throws(() => s.moveFormat(f.id, { profileId: null, expected: plain.revision }), /already/);
  s.archiveProfile(B.id, s.get('profiles', B.id).revision, true);
  assert.throws(() => s.moveFormat(f.id, { profileId: B.id, expected: plain.revision }), /archived/);
});

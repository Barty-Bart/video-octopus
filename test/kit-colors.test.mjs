// Kit colours (web/kit-colors.js) and style covers (server/style-covers.mjs): every brand kit has a colour, picked
// automatically when it is made or, for an older kit, once when the studio opens; the creator can change it; the
// brand's first colour wins; No brand styles get a colour from their id; a style's cover picture comes from what the
// studio already has.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { KIT_PALETTE, kitColor, autoKitColors, nextKitColor, idColor, inkContrast, avatarInk, cleanColor } from '../web/kit-colors.js';
import { styleEntries, pickerItems, setupShape, initialOf } from '../web/style-list.js';
import { ProfileStore } from '../server/profile-store.mjs';
import { PackagingStore } from '../server/packaging-store.mjs';
import { coverFromVideos, coverFromExamples } from '../server/style-covers.mjs';
import { png } from './png-fixture.mjs';

const HEX = KIT_PALETTE.map(([hex]) => hex);
const studio = (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-kit-colors-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const open = (root, fn, Store = ProfileStore) => { const s = new Store(root); try { return fn(s); } finally { s.close(); } };

test('the palette: twelve distinct #rrggbb colours that each read with white or near-black text at 4.5:1', () => {
  assert.equal(HEX.length, 12);
  assert.equal(new Set(HEX).size, 12);
  for (const hex of HEX) {
    assert.match(hex, /^#[0-9a-f]{6}$/);
    assert.ok(inkContrast(hex) >= 4.5, `${hex} contrast ${inkContrast(hex).toFixed(2)}`);
    assert.ok(['#ffffff', '#141416'].includes(avatarInk(hex)));
  }
});

test('automatic colours: distinct, deterministic, brand kits served last, saved ones kept, No brand skipped', () => {
  const kits = [
    { id: 'a', name: 'A' }, { id: 'b', name: 'B', brand: { brand: { colors: ['#123456'] } } }, { id: 'c', name: 'C' },
    { id: 'n', name: 'No brand', system: 'unbranded' }, { id: 'd', name: 'D', color: HEX[0] }, { id: 'e', name: 'E' },
  ];
  const picks = autoKitColors(kits);
  assert.deepEqual([...picks.keys()], ['a', 'c', 'e', 'b'], 'kits without a brand colour first; d keeps its saved colour; No brand none');
  assert.equal(picks.get('a'), HEX[1], 'Indigo is taken by d, so a gets the next one');
  assert.equal(new Set([...picks.values(), HEX[0], '#123456']).size, picks.size + 2, 'all distinct from each other and from shown colours');
  assert.deepEqual([...autoKitColors(kits)], [...picks], 'the same input gives the same colours');
  // More kits than colours: still deterministic, by position.
  const many = Array.from({ length: 14 }, (_, i) => ({ id: `k${i}`, name: `K${i}` }));
  const all = autoKitColors(many);
  assert.deepEqual([...all.values()].slice(0, 12), HEX);
  assert.deepEqual([...all.values()].slice(12), [HEX[12 % 12], HEX[13 % 12]]);
  assert.equal(nextKitColor(HEX, 5), HEX[5]);
});

test('kitColor: the brand’s first colour wins, then the saved kit colour; No brand has none; idColor is stable', () => {
  assert.equal(kitColor({ color: '#4F5BD5' }), '#4f5bd5');
  assert.equal(kitColor({ color: '#4f5bd5', brand: { brand: { colors: ['#0F766E'] } } }), '#0f766e');
  assert.equal(kitColor({ color: 'red' }), null);
  assert.equal(kitColor({ system: 'unbranded', color: '#4f5bd5' }), null);
  assert.equal(cleanColor('#abc'), null);
  assert.equal(idColor('style-1'), idColor('style-1'));
  assert.ok(HEX.includes(idColor('style-1')));
  assert.ok(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(idColor)).size > 3, 'ids spread over the palette');
});

test('store: new kits get distinct colours; older kits are backfilled once, stably, without a new revision', (t) => {
  const root = studio(t);
  const made = open(root, (s) => ['One', 'Two', 'Three', 'Four', 'Five'].map((n) => s.profile(n)));
  assert.deepEqual(made.map((p) => p.color), HEX.slice(0, 5), 'each new kit takes the next free palette colour');
  open(root, (s) => {
    s.unbrandedProfile();
    s.saveBrand(made[1].id, { colors: ['#0f766e'] }, null); // a brand colour: shown instead of the kit colour
  });
  // As a studio from before kit colours: no colour saved on any kit.
  const db = new DatabaseSync(join(root, '.studio/studio.sqlite'));
  db.exec("UPDATE profiles SET data=json_remove(data,'$.color')");
  db.close();
  const after = open(root, (s) => s.viewProfiles());
  const kits = after.filter((p) => !p.system);
  assert.equal(after.find((p) => p.system).color, undefined, 'No brand gets no colour');
  assert.ok(kits.every((p) => /^#[0-9a-f]{6}$/.test(p.color)), 'every kit has a saved colour');
  assert.equal(new Set(kits.filter((p) => !p.brand).map((p) => p.color)).size, 4, 'the unbranded kits are distinct');
  assert.deepEqual(kits.filter((p) => !p.brand).map((p) => p.color), HEX.slice(0, 4), 'in creation order');
  assert.ok(kits.every((p) => p.revision === 1), 'backfill is not an edit');
  assert.equal(kitColor(kits[1]), '#0f766e', 'the brand colour wins');
  const again = open(root, (s) => s.viewProfiles());
  assert.deepEqual(again.map((p) => p.color), after.map((p) => p.color), 'stable across reopening');
  // A kit made later avoids every colour already shown.
  const sixth = open(root, (s) => s.profile('Six'));
  assert.ok(!kits.map(kitColor).includes(sixth.color));
});

test('store: the creator changes a kit colour; it is validated, revisioned and never touches the brand', (t) => {
  const root = studio(t);
  const p = open(root, (s) => s.profile('Kit'));
  const brandBefore = open(root, (s) => s.saveBrand(p.id, { colors: ['#0f766e'], identity: 'Kit' }, null));
  for (const bad of ['red', '#abc', '#12345g', '', null]) {
    assert.throws(() => open(root, (s) => s.setKitColor(p.id, { expected: 1, color: bad })), /#rrggbb/, String(bad));
  }
  const changed = open(root, (s) => s.setKitColor(p.id, { expected: 1, color: '#A043B6' }));
  assert.equal(changed.color, '#a043b6');
  assert.equal(changed.revision, 2);
  assert.throws(() => open(root, (s) => s.setKitColor(p.id, { expected: 1, color: '#2a72c0' })), /changed/);
  const custom = open(root, (s) => s.setKitColor(p.id, { expected: 2, color: '#112233' }));
  assert.equal(custom.color, '#112233', 'any #rrggbb, not only the palette');
  const none = open(root, (s) => s.unbrandedProfile());
  assert.throws(() => open(root, (s) => s.setKitColor(none.id, { expected: 1, color: '#112233' })), /No brand/);
  const view = open(root, (s) => s.viewProfiles().find((x) => x.id === p.id));
  assert.equal(view.brand.id, brandBefore.id, 'no new brand version');
  assert.deepEqual(view.brand.brand.colors, ['#0f766e'], 'brand colours unchanged');
  assert.equal(kitColor(view), '#0f766e', 'the brand colour still wins');
});

test('style entries: cover colour, camera or faceless, initial and newest videos for the cover', () => {
  const data = {
    profiles: [{ id: 'A', name: 'Bart', color: '#4f5bd5' }, { id: 'N', name: 'No brand', system: 'unbranded' }],
    formats: [
      { id: 'f1', profileId: 'A', name: 'YouTube tutorial', type: 'tutorial' },
      { id: 'f2', profileId: 'A', name: 'faceless doc', type: 'faceless' },
      { id: 'f3', profileId: 'N', name: '9 quick tips', type: 'short' },
    ],
    projects: [1, 2, 3, 4, 5].map((n) => ({ id: `p${n}`, formatId: 'f1', updated: n })),
    formatInfo: { tutorial: { aspect: '16:9', camera: true }, faceless: { aspect: '16:9', camera: false }, short: { aspect: '9:16', camera: true } },
  };
  const [one, two, three] = ['f1', 'f2', 'f3'].map((id) => styleEntries(data).find((e) => e.id === id));
  assert.deepEqual([one.kitColor, one.coverColor, one.camera, one.initial], ['#4f5bd5', '#4f5bd5', true, 'Y']);
  assert.deepEqual(one.coverVideos, ['p5', 'p4', 'p3', 'p2'], 'newest four');
  assert.deepEqual([two.camera, two.initial, two.coverVideos], [false, 'F', []]);
  assert.deepEqual([three.kitColor, three.coverColor, three.tall, three.initial], [null, idColor('f3'), true, '9']);
  assert.equal(setupShape('faceless').camera, false, 'without formatInfo, faceless is the faceless setup');
  assert.equal(initialOf('  '), '•');
  const picker = pickerItems(styleEntries(data));
  assert.equal(picker.find((x) => x.formatId === 'f1').kitColor, '#4f5bd5', 'the picker dot is the kit colour');
  assert.equal(picker.find((x) => x.formatId === 'f3').kitColor, null, 'No brand: no dot');
});

test('style covers: a video’s main Packaging thumbnail, only for the style’s own videos; else an example frame', (t) => {
  const root = studio(t);
  const { f, other } = open(root, (s) => {
    const p = s.profile('Kit');
    return { f: s.format(p.id, 'Style', 'tutorial'), other: s.format(p.id, 'Other', 'tutorial') };
  });
  const exists = () => true;
  assert.deepEqual(open(root, (s) => coverFromVideos(s, f.id, ['v1'], { exists })), { pic: null, videos: [] }, 'nothing pinned yet');
  open(root, (s) => {
    s.pinContext('v1', { formatId: f.id });
    s.pinContext('v2', { formatId: other.id });
    const put = (n) => { const r = s.files.putBuffer(png(32, 18, () => [n * 60, 20, 20]), { ext: '.png' }); return { sha256: r.sha256, size: r.size, ext: '.png' }; };
    const a = s.addItem('v1', { origin: 'uploaded', stored: put(1), name: 'Main' });
    s.mark('v1', a.id, { main: true });
    const b = s.addItem('v2', { origin: 'uploaded', stored: put(2), name: 'Main' });
    s.mark('v2', b.id, { main: true });
  }, PackagingStore);
  const found = open(root, (s) => coverFromVideos(s, f.id, ['v2', 'v1'], { exists }));
  assert.deepEqual(found.videos, ['v1'], 'another style’s video is ignored');
  assert.equal(found.pic.type, 'image/png');
  assert.equal(open(root, (s) => coverFromVideos(s, f.id, ['v1'], { exists: () => false })).pic, null, 'a removed project is skipped');
  // No video picture: a key frame a conversation of the style extracted.
  assert.equal(open(root, (s) => coverFromExamples(s, other.id)), null);
  const ref = '11111111-2222-4333-8444-555555555555';
  open(root, (s) => {
    const session = s.session(other.id, { name: 'Study' });
    s.update('sessions', { ...s.get('sessions', session.id), references: [{ id: ref, kind: 'file', name: 'example.mp4' }] });
    const dir = join(s.sessionDir(session.id), 'work/frames', ref);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'frame-0001.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]));
    writeFileSync(join(dir, 'frame-0002.svg'), '<svg/>');
  });
  const frame = open(root, (s) => coverFromExamples(s, other.id));
  assert.equal(frame.type, 'image/jpeg');
});

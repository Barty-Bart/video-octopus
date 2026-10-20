// Real turn tracking and file restoration, synthetic temporary studio only.
//   node --test test/turn-lifecycle.test.mjs
// No server, browser, agent, media processing, keys or network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const json = (path, value) => write(path, JSON.stringify(value, null, 2) + '\n');
const text = (path) => readFileSync(path, 'utf8');
const immediate = () => new Promise((done) => setImmediate(done));

test('turn snapshots survive both adapter event orders without leaking into later turns', async (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-turn-lifecycle-'));
  const studio = join(root, 'studio'), local = join(root, 'local');
  const previousLocal = process.env.STUDIO_LOCAL_DIR;
  process.env.STUDIO_LOCAL_DIR = local;
  json(join(local, 'settings.json'), { studio, projectsDir: 'projects' });
  const oldFetch = globalThis.fetch, originals = new Map();
  const deny = () => { throw new Error('External operations are forbidden in the turn-lifecycle fixture'); };
  globalThis.fetch = deny;
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    originals.set(name, childProcess[name]); childProcess[name] = deny;
  }
  syncBuiltinESMExports();
  t.after(async () => {
    await immediate();
    globalThis.fetch = oldFetch;
    for (const [name, original] of originals) childProcess[name] = original;
    syncBuiltinESMExports();
    if (previousLocal === undefined) delete process.env.STUDIO_LOCAL_DIR;
    else process.env.STUDIO_LOCAL_DIR = previousLocal;
    rmSync(root, { recursive: true, force: true });
  });
  const { trackTurns, undoTurn } = await import('../server/turns.mjs');
  const fixture = () => {
    const id = `turn-${randomUUID()}`, dir = join(studio, 'projects', id);
    json(join(dir, 'project.json'), { name: 'Synthetic turn fixture' });
    json(join(dir, 'work', 'blocks.json'), { v: 1, blocks: [{ id: 'intro', type: 'intro', label: 'Intro', source: { take: [0, 3] } }] });
    const broadcasts = [], events = [], notes = [];
    const chat = {
      listeners: new Set(), busy: false,
      emit(event) { events.push(event); for (const listener of this.listeners) listener(event); },
      setBusy(busy) { if (this.busy === busy) return; this.busy = busy; this.emit({ t: 'busy', busy }); },
      addStudioNote(note) { notes.push(note); },
    };
    trackTurns(id, chat, { broadcast: (event) => broadcasts.push(event) });
    return { id, dir, chat, broadcasts, events, notes, path: (rel) => join(dir, rel) };
  };
  const start = (f, order, brief) => {
    if (order === 'busy-user') f.chat.setBusy(true);
    f.chat.emit({ t: 'user', text: 'Change the synthetic project.', ...(brief ? { brief } : {}) });
    f.chat.setBusy(true); // adapters suppress this duplicate after their early busy event
  };
  const finish = async (f) => {
    f.chat.emit({ t: 'text', text: 'Synthetic change completed.' });
    f.chat.emit({ t: 'result', ok: true }); f.chat.setBusy(false); await immediate();
  };
  const shot = (id, start) => ({ id, start, name: id, look: { preset: 'screen' }, by: 'claude', status: 'proposed' });
  const zoom = (id, a) => ({ id, target: 'camera', a, b: a + 0.2, c: a + 0.4, d: a + 0.6, amount: 1.1, by: 'claude', status: 'proposed' });

  for (const order of ['user-busy', 'busy-user']) {
    await t.test(`${order}: an actual file edit is offered and Undo restores the exact bytes`, async () => {
      const f = fixture(), path = f.path('work/blocks.json'), before = text(path);
      start(f, order);
      write(path, before.replace('"Intro"', '"Opening"'));
      await finish(f);
      const offer = f.broadcasts.find((event) => event.t === 'undo-offer');
      assert.ok(offer, 'An edit must produce an Undo offer');
      assert.deepEqual(offer.files, ['work/blocks.json']);
      const result = undoTurn(f.id, offer.id, f.chat);
      assert.deepEqual(result.back, ['work/blocks.json']);
      assert.deepEqual(result.kept, []);
      assert.equal(text(path), before);
      assert.match(f.notes[0], /put work\/blocks\.json back exactly/);
      assert.throws(() => undoTurn(f.id, offer.id, f.chat), /nothing to undo/i);
    });

    await t.test(`${order}: only new proposed shots and zooms are announced`, async () => {
      const f = fixture();
      json(f.path('work/shots.json'), { v: 1, shots: [{ id: 'base', start: 0 }, shot('old-shot', 0.5)] });
      json(f.path('work/zooms.json'), { v: 2, items: [zoom('old-zoom', 0.2)] });
      start(f, order);
      json(f.path('work/shots.json'), { v: 1, shots: [{ id: 'base', start: 0 }, shot('old-shot', 0.5), shot('new-shot', 1.5)] });
      json(f.path('work/zooms.json'), { v: 2, items: [zoom('old-zoom', 0.2), zoom('new-zoom', 1.5)] });
      await finish(f);
      const proposals = f.events.filter((event) => event.t === 'proposals');
      assert.equal(proposals.length, 1);
      assert.deepEqual(proposals[0].shots, ['new-shot']);
      assert.deepEqual(proposals[0].zooms, ['new-zoom']);
      assert.match(proposals[0].text, /1 shot and 1 zoom/);
    });

    await t.test(`${order}: a step brief cannot become a human Undo offer`, async () => {
      const f = fixture(), path = f.path('work/blocks.json');
      start(f, order, { name: 'Synthetic app brief' });
      write(path, text(path).replace('"Intro"', '"Opening"'));
      await finish(f);
      assert.equal(f.broadcasts.some((event) => event.t === 'undo-offer'), false);
    });
  }

  await t.test('startup failure clears an earlier offer and cannot reuse its snapshot', async () => {
    const f = fixture(), path = f.path('work/blocks.json'), original = text(path);
    start(f, 'user-busy'); write(path, original.replace('"Intro"', '"Opening"')); await finish(f);
    const previousOffer = f.broadcasts.find((event) => event.t === 'undo-offer');
    assert.ok(previousOffer);
    const afterFirst = text(path), count = f.broadcasts.length;
    f.chat.setBusy(true); // startup fails before the adapter echoes a new user event
    f.chat.emit({ t: 'error', text: 'Synthetic startup failure.' });
    f.chat.setBusy(false); await immediate();
    assert.equal(f.broadcasts.length, count, 'Failed startup must not offer a stale Undo');
    assert.throws(() => undoTurn(f.id, previousOffer.id, f.chat), /nothing to undo/i);
    start(f, 'busy-user'); write(path, afterFirst.replace('"Opening"', '"Another edit"')); await finish(f);
    const latestOffer = f.broadcasts.filter((event) => event.t === 'undo-offer').at(-1);
    undoTurn(f.id, latestOffer.id, f.chat);
    assert.equal(text(path), afterFirst, 'The next turn restores its own baseline, not an older turn');
  });

  await t.test('a silent turn still snapshots proposals but does not inherit human Undo eligibility', async () => {
    const f = fixture(), path = f.path('work/blocks.json');
    start(f, 'user-busy'); write(path, text(path).replace('"Intro"', '"Opening"')); await finish(f);
    const previousOffer = f.broadcasts.find((event) => event.t === 'undo-offer');
    const oldOffers = f.broadcasts.length;
    f.chat.setBusy(true); // echo:false: no user event
    write(path, text(path).replace('"Opening"', '"Silent edit"'));
    json(f.path('work/shots.json'), { v: 1, shots: [{ id: 'base', start: 0 }, shot('silent-shot', 1)] });
    await finish(f);
    assert.equal(f.broadcasts.length, oldOffers, 'A silent turn must not reuse prior human metadata');
    assert.throws(() => undoTurn(f.id, previousOffer.id, f.chat), /nothing to undo/i);
    assert.deepEqual(f.events.filter((event) => event.t === 'proposals').at(-1).shots, ['silent-shot']);
    assert.equal(existsSync(f.path('work/shots.json')), true);
  });
});

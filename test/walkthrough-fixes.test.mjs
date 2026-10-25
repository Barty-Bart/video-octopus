// Walkthrough fixes (handoff ux-2026-10-24, A items) that are checked on the server side: what a step that didn't finish
// says (A18), Setup's Fix for an old Python (A13).
//   node --test test/walkthrough-fixes.test.mjs
// Synthetic temporary studio only: no server, browser, agent, media processing, keys or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-walkthrough-fixes-'));
const studio = join(root, 'studio'), local = join(root, 'local');
const write = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
write(join(local, 'settings.json'), { studio, projectsDir: 'projects' });
process.env.STUDIO_LOCAL_DIR = local;
test.after(() => rmSync(root, { recursive: true, force: true }));
const immediate = () => new Promise((done) => setImmediate(done));

test('A18: a step whose turn ended without its result says what is missing, not Claude’s last sentence', async () => {
  const { makesOf, pipelineStatus } = await import('../server/studio.mjs');
  assert.equal(makesOf({ files: ['renders/*intro*.mp4'] }), 'its video');
  assert.equal(makesOf({ files: ['work/production.json'] }), 'the scene plan (work/production.json)');
  assert.equal(makesOf({ worklog: 'Cut locked' }), 'its line in WORKLOG.md ("Cut locked")');
  assert.equal(makesOf({ json: ['work/blocks.json', 'marked'] }), 'the sections (work/blocks.json)');

  const { trackTurns } = await import('../server/turns.mjs');
  const { state } = await import('../server/util.mjs');
  const id = 'unfinished-intro', dir = join(studio, 'projects', id);
  write(join(dir, 'project.json'), { name: 'Synthetic', type: 'tutorial' });
  assert.equal(pipelineStatus(dir, 'tutorial').steps.find((s) => s.id === 'intro').makes, 'its video');
  const chat = { listeners: new Set(), busy: false, emit(e) { for (const l of this.listeners) l(e); }, setBusy(b) { if (this.busy !== b) { this.busy = b; this.emit({ t: 'busy', busy: b }); } }, addStudioNote() {} };
  trackTurns(id, chat, { broadcast: () => {} });
  chat.setBusy(true);
  chat.emit({ t: 'user', text: 'Build the intro…', brief: { step: 'intro', name: 'Build the intro' } });
  chat.emit({ t: 'text', text: 'Rendered renders/unfinished-intro_explainer_v1.mp4. Watch it in Scenes.' });
  chat.emit({ t: 'result', ok: true });
  chat.setBusy(false);
  await immediate(); await immediate();
  const u = state().projects[id].unfinished;
  assert.equal(u.step, 'intro');
  assert.equal(u.reason, 'Build the intro didn’t produce its video.');
  assert.ok(u.ts, 'Read still opens Claude’s reply');

  // Send again (no second user line): the turn is still the step's.
  chat.emit({ t: 'turn', text: 'Build the intro…', brief: { step: 'intro', name: 'Build the intro' } });
  chat.setBusy(true);
  chat.emit({ t: 'error', text: 'Claude Code stopped (exit 3). Error: synthetic' });
  chat.emit({ t: 'result', ok: false });
  chat.setBusy(false);
  await immediate(); await immediate();
  assert.equal(state().projects[id].unfinished.reason, 'Claude Code stopped (exit 3).');
});

test('A13: Setup’s Python row offers Fix when the Python is too old (the page promises a Fix on every row that needs a look)', () => {
  const src = readFileSync(new URL('../server/setup.mjs', import.meta.url), 'utf8');
  const at = src.indexOf("Number(j.py.split('.')[1]) < 10"), old = src.slice(at, src.indexOf('const missing =', at));
  assert.match(old, /state: 'warn', install: true/);
  assert.match(old, /fix: `Setup check "Python": \$\{py\} is Python \$\{j\.py\}/);
});

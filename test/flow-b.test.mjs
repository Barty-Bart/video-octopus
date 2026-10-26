// Flow changes from the UX walkthrough (handoff ux-2026-10-24, TRIAGE §B), first small batch: one next step (B2).
//   node --test test/flow-b.test.mjs
// Synthetic temporary studio only: no server, browser, agent, media processing, keys or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-flow-b-'));
const studio = join(root, 'studio'), local = join(root, 'local');
const write = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
// The Advanced pipeline (editor.mode advanced): a tutorial's Build is the intro. Simple builds the whole video (test/v1-followups.test.mjs).
write(join(local, 'settings.json'), { studio, projectsDir: 'projects', editor: { mode: 'advanced' } });
process.env.STUDIO_LOCAL_DIR = local;
test.after(() => rmSync(root, { recursive: true, force: true }));

test('B2: Projects names the dock’s step (pipeline current), also when only an optional step is left', async () => {
  const { listProjects, pipelineStatus } = await import('../server/studio.mjs');
  const P = (id) => join(studio, 'projects', id);
  // Cleaned up: the next required step is Split into sections, and the dock says the same.
  write(join(P('cleaned'), 'project.json'), { name: 'Cleaned', type: 'tutorial' });
  write(join(P('cleaned'), 'source', 'take_webcam.mp4'), 'synthetic');
  write(join(P('cleaned'), 'work', 'joins.json'), { joins: [] });
  // Every required step done; the optional Package step was never done or skipped, so the dock offers it.
  write(join(P('finished'), 'project.json'), { name: 'Finished', type: 'tutorial' });
  write(join(P('finished'), 'source', 'take_webcam.mp4'), 'synthetic');
  write(join(P('finished'), 'work', 'joins.json'), { joins: [] });
  write(join(P('finished'), 'work', 'blocks.json'), { marked: true, blocks: [] });
  write(join(P('finished'), 'work', 'production.json'), { scenes: [] });
  write(join(P('finished'), 'renders', 'finished_intro_v1.mp4'), 'synthetic');
  write(join(P('finished'), 'WORKLOG.md'), '- Cut locked\n- Scenes approved\n');

  const list = listProjects(), cleaned = list.find((p) => p.id === 'cleaned'), finished = list.find((p) => p.id === 'finished');
  const dock = (id) => { const s = pipelineStatus(P(id), 'tutorial'); return s.steps.find((x) => x.id === s.current); };
  assert.equal(cleaned.next, 'Split into sections');
  assert.equal(cleaned.current, dock('cleaned').name);
  assert.equal(cleaned.currentOptional, false);
  // A7 still holds: a finished video's card stage is Done (no required step left), not the optional step's stage.
  assert.equal(finished.next, null);
  assert.equal(finished.stage, null);
  assert.equal(finished.current, dock('finished').name);
  assert.equal(finished.currentOptional, true);
});

test('B11: Run in the dock, an empty state, a stage’s list or the help opens the step’s stage; the chat and panes don’t', async () => {
  const { stageToOpen, RUN_OPENS_STAGE } = await import('../web/stages.js');
  const PIPELINES = JSON.parse((await import('node:fs')).readFileSync(new URL('../core/pipelines.json', import.meta.url), 'utf8'));
  const prepare = { id: 'prepare', ...PIPELINES.shared.prepare };
  assert.equal(prepare.stage, 'Cut'); // Clean up → Cut
  const names = ['Package', 'Record', 'Cut', 'Plan', 'Build', 'Polish', 'Publish'];
  assert.deepEqual(RUN_OPENS_STAGE, ['dock', 'empty', 'menu', 'help']);
  for (const from of RUN_OPENS_STAGE) assert.equal(stageToOpen(prepare, { from, current: 'Record', names }), 'Cut', from);
  // Already there: stay.
  assert.equal(stageToOpen(prepare, { from: 'dock', current: 'Cut', names }), null);
  // Claude starting a step from the chat, or Run pressed inside a pane (Blocks band, Cut panel, ⋯ menu): stay.
  for (const from of ['chat', null, undefined, 'band', 'pane']) assert.equal(stageToOpen(prepare, { from, current: 'Record', names }), null, String(from));
  // A stage this project doesn't show, or a step without one (Learn from this project): stay.
  assert.equal(stageToOpen({ id: 'package', stage: 'Package' }, { from: 'dock', current: 'Record', names: names.filter((n) => n !== 'Package') }), null);
  assert.equal(stageToOpen({ id: 'learn', kind: 'claude' }, { from: 'dock', current: 'Record', names }), null);
  assert.equal(stageToOpen(null, { from: 'dock', names }), null);
  // Every step's own stage is one the bar has: Build the intro → Build, Plan the scenes → Plan.
  const tut = PIPELINES.formats.tutorial.steps.map((s) => (typeof s === 'string' ? { id: s, ...PIPELINES.shared[s] } : s));
  assert.equal(stageToOpen(tut.find((s) => s.id === 'intro'), { from: 'empty', current: 'Polish', names }), 'Build');
  assert.equal(stageToOpen(tut.find((s) => s.id === 'plan'), { from: 'menu', current: 'Cut', names }), 'Plan');
});

test('B11: the page wires it: rail passes where Run was pressed, runStep opens the stage after the step starts', async () => {
  const { readFileSync } = await import('node:fs');
  const rail = readFileSync(new URL('../web/rail.js', import.meta.url), 'utf8'), app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(rail, /case 'run': return run\(cur, 'dock'\)/);
  assert.match(rail, /run\(cur, 'empty'\)/);
  assert.match(rail, /run\(s, 'menu'\)/);
  assert.match(rail, /run\(cur, 'help'\)/);
  assert.match(app, /runStep: \(s, from\) => runStep\(s, \{ from \}\)/);
  const body = app.slice(app.indexOf('async function runStep(s, { from = null } = {})'), app.indexOf('// Cut tab: the Cut Editor'));
  assert.ok(body.indexOf('/step`') < body.indexOf('stageToOpen('), 'the stage opens once the step has started');
  // The Blocks band and the Cut panel's Lock call runStep without a from: they stay where they are.
  assert.match(app, /runStep: \(sid\) => \{ const s = P\.pipeline\?\.steps\.find\(\(x\) => x\.id === sid\); if \(s\) runStep\(s\); \}/);
  assert.match(app, /runLock: \(s\) => runStep\(s\)/);
});

test('B12: one Research action makes the session and runs it with its revision (the two server routes stay)', async () => {
  const { startResearch, researchActions } = await import('../web/brand-research.js');
  const calls = [];
  const call = async (path, body) => { calls.push([path, body]); return path.endsWith('/research') ? { id: 'r 1', revision: 1, status: 'draft' } : { ok: true, revision: 1 }; };
  let created = null;
  const r = await startResearch(call, 'kit/1', { url: 'https://example.com', direction: 'Synthetic' }, (x) => { created = x.id; });
  assert.equal(r.id, 'r 1');
  assert.equal(created, 'r 1');
  assert.deepEqual(calls, [
    ['/api/profiles/kit%2F1/research', { url: 'https://example.com', direction: 'Synthetic' }],
    ['/api/profile-research/r%201/run', { revision: 1 }],
  ]);
  // A run that can't start: the session exists (the page shows it, with Resume), and the error reaches the caller.
  created = null;
  const failing = async (path) => { if (path.endsWith('/run')) throw new Error('Wait for the research turn to finish.'); return { id: 'r2', revision: 1 }; };
  await assert.rejects(startResearch(failing, 'kit', { url: 'https://example.com' }, (x) => { created = x.id; }), /Wait for the research turn/);
  assert.equal(created, 'r2');
  // One button at a time for the session: Stop while running, Resume after a stop, Review once there may be a proposal.
  assert.deepEqual(researchActions('running'), { resume: false, stop: true, review: false });
  assert.deepEqual(researchActions('review'), { resume: false, stop: false, review: true });
  assert.deepEqual(researchActions('draft'), { resume: true, stop: false, review: false });
  assert.deepEqual(researchActions('interrupted'), { resume: true, stop: false, review: true });
});

test('B12: the Brand tab has one Research button and no separate Create step', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/profiles.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('Create research session'));
  assert.equal(src.match(/<button class="btn primary">Research<\/button>/g)?.length, 2); // the kit rows layout and the older card layout
  assert.match(src, /startResearch\(api, profileId,/);
});

test('B5a: after a partial Build, scenes the picked render doesn’t reach are “Not in this build”, not “To review”', async () => {
  const { sceneTone, sceneRow, TONE_LABEL } = await import('../web/scene-tone.js');
  // An intro-only render picked; an older full render made every scene "built" (server builtEnd: the longest render).
  assert.equal(sceneTone({ built: true, inRender: true }), 'none');
  assert.equal(TONE_LABEL.none, 'To review');
  assert.equal(sceneTone({ built: true, inRender: false }), 'notin');
  assert.equal(TONE_LABEL.notin, 'Not in this build');
  // No render reaches it at all: Not built yet, as before.
  assert.equal(sceneTone({ built: false, inRender: false }), 'unbuilt');
  // Approval and notes still win over where the render stops.
  assert.equal(sceneTone({ approved: true, built: true, inRender: false }), 'ok');
  assert.equal(sceneTone({ built: true, inRender: false, notes: [{ status: 'open' }] }), 'notes');
  assert.equal(sceneTone({ built: true, inRender: false, notes: [{ status: 'open', kind: 'change' }] }), 'waiting');
  // The row: a quiet picture (no black frame) with the state on it once; the line under the title stays empty (A14).
  for (const [tone, args] of [['notin', { built: true, inRender: false }], ['unbuilt', { built: false, inRender: false }]]) {
    const row = sceneRow({ tone, text: TONE_LABEL[tone], ...args });
    assert.equal(row.quiet, true, tone);
    assert.equal(row.picture, TONE_LABEL[tone], tone);
    assert.equal(row.line, null, `${tone}: said once (A14)`);
  }
  // A reached scene keeps its picture and its line; an approved scene outside the picked render is quiet but says Approved.
  assert.deepEqual(sceneRow({ tone: 'none', text: 'To review', built: true, inRender: true }), { quiet: false, picture: null, line: 'To review', busy: false });
  assert.deepEqual(sceneRow({ tone: 'ok', text: 'Approved', built: true, inRender: false }), { quiet: true, picture: null, line: 'Approved', busy: false });
});

test('B5a: Scenes uses the shared tone rules and prints the row label from them', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/scenes.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ TONE_LABEL, TONE_DOT, sceneTone, sceneRow, buildLegend \} from '\.\/scene-tone\.js'/);
  assert.ok(!/const TONE_LABEL =/.test(src), 'one copy of the labels');
  assert.ok(!src.includes("'<span class=\"s2-nbl\">Not built yet</span>'"), 'the picture label comes from sceneRow');
  assert.match(src, /row\.line == null \? ''/);
});

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
write(join(local, 'settings.json'), { studio, projectsDir: 'projects' });
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

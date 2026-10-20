// Run in an approved disposable environment with node --test.
// Synthetic folders only; no server, agent, key-store operation or network call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const write = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const sha1 = (text) => createHash('sha1').update(text).digest('hex');

test('starter updates never add, replace or stage creator preferences, even when unchanged', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'octopus-starter-ownership-'));
  const studio = join(root, 'studio'), starter = join(root, 'starter');
  const previousLocal = process.env.STUDIO_LOCAL_DIR;
  // util.mjs creates only this disposable settings directory on import.
  process.env.STUDIO_LOCAL_DIR = join(root, 'local');
  t.after(() => {
    if (previousLocal === undefined) delete process.env.STUDIO_LOCAL_DIR;
    else process.env.STUDIO_LOCAL_DIR = previousLocal;
    rmSync(root, { recursive: true, force: true });
  });
  const { applyStarter, starterPlan } = await import('../server/starter-sync.mjs');
  const protectedPaths = [
    'preferences/skills.json', 'preferences/future.json', 'memory/preferences.md',
    'memory/style.md', 'memory/new-note.md', 'BRAND.md', 'STYLE.md', 'Preferences/another.json',
  ];
  const files = {}, before = new Map();
  for (const [i, rel] of protectedPaths.entries()) {
    const original = `Original template ${rel}\n`;
    write(join(starter, rel), `Changed vendor template ${rel}\n`);
    if (i !== 1 && i !== 4) files[rel] = sha1(original);
    // Test unchanged, modified, intentionally deleted, and never-installed paths.
    if (i !== 1 && i !== 4 && i !== 6) {
      const mine = i === 3 ? 'Personal notes with exact spacing.  \n' : original;
      write(join(studio, rel), mine);
      before.set(rel, mine);
    }
  }
  files['CLAUDE.md'] = sha1('Old instructions\n');
  write(join(studio, 'CLAUDE.md'), 'Old instructions\n');
  write(join(starter, 'CLAUDE.md'), 'New instructions\n');
  write(join(starter, 'VERSION'), '6\n');
  write(join(studio, '.studio/starter.json'), JSON.stringify({ version: '5', files }));

  const plan = starterPlan(studio, { starter });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.update, ['CLAUDE.md']);
  assert.deepEqual(plan.add, []);
  assert.deepEqual(plan.keep, []);
  assert.deepEqual(plan.deleted, []);
  applyStarter(studio, { starter });
  assert.equal(readFileSync(join(studio, 'CLAUDE.md'), 'utf8'), 'New instructions\n');
  for (const rel of protectedPaths) {
    if (before.has(rel)) assert.equal(readFileSync(join(studio, rel), 'utf8'), before.get(rel));
    else assert.equal(existsSync(join(studio, rel)), false, `${rel} must stay absent`);
    assert.equal(existsSync(join(studio, '.studio/updates', rel)), false, `${rel} must not be staged`);
  }
  const after = JSON.parse(readFileSync(join(studio, '.studio/starter.json'), 'utf8'));
  for (const rel of protectedPaths) assert.equal(after.files[rel], files[rel]);
});

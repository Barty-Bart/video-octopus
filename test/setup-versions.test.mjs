// Setup's version warnings: FFmpeg below 8.1.2 and Node.js below its line's security release.
// Pure parsing plus the Node.js check on this runtime; no real studio, network or external program.
//   node --test test/setup-versions.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const local = mkdtempSync(join(tmpdir(), 'octopus-setup-versions-'));
const priorLocal = process.env.STUDIO_LOCAL_DIR;
process.env.STUDIO_LOCAL_DIR = local;
const { ffmpegRelease, ffmpegOutdated, FFMPEG_PATCHED, runCheck } = await import('../server/setup.mjs');
test.after(() => {
  if (priorLocal === undefined) delete process.env.STUDIO_LOCAL_DIR; else process.env.STUDIO_LOCAL_DIR = priorLocal;
  rmSync(local, { recursive: true, force: true });
});

test('FFmpeg version words parse release builds and leave snapshots unknown', () => {
  assert.equal(FFMPEG_PATCHED, '8.1.2');
  const cases = [
    // [the word after "ffmpeg version", release, below 8.1.2]
    ['9.0.2-https://www.martin-riedl.de', [9, 0, 2], false],
    ['n8.1.2', [8, 1, 2], false],
    ['8.1.2-essentials_build-www.gyan.dev', [8, 1, 2], false],
    ['9.0', [9, 0, 0], false],
    ['8.1.1', [8, 1, 1], true],
    ['8.0.3', [8, 0, 3], true],
    ['6.0', [6, 0, 0], true],
    ['7.1.1-tessus', [7, 1, 1], true],
    ['4.4.2-0ubuntu0.22.04.1', [4, 4, 2], true],
    // Git snapshots and unreadable words: can't tell, so never a false warning.
    ['N-12345-g0123456789', null, false],
    ['2026-03-14-git-0123456789-full_build-www.gyan.dev', null, false],
    ['git-2026-01-01-abcdef', null, false],
    ['8.1.2.1', null, false],
    ['', null, false],
    [undefined, null, false],
  ];
  for (const [word, release, outdated] of cases) {
    assert.deepEqual(ffmpegRelease(word), release, String(word));
    assert.equal(ffmpegOutdated(word), outdated, String(word));
  }
});

test('the Node.js check reports this runtime and only warns below its security release', async () => {
  const r = await runCheck('node');
  assert.equal(r.id, 'node');
  assert.ok(['ok', 'warn'].includes(r.state), `${r.state}: ${r.detail}`);
  assert.equal(r.detail, `Node.js ${process.versions.node}`);
  if (r.state === 'warn') assert.match(r.how, /still runs/);
  else assert.equal(r.how, null);
});

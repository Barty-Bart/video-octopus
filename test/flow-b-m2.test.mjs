// Flow changes from the UX walkthrough (handoff ux-2026-10-24, TRIAGE §B), medium batch 2: the live view while
// recording (B7), the idea carrying into the script (B8) and Claude's state shown the same way everywhere (B10).
//   node --test test/flow-b-m2.test.mjs
// Synthetic temporary studio only: no server, browser, agent, media processing, keys or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const web = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');

test('B7: while a take records, the canvas shows it live; after Stop "Saving the take…" until the take lands', async () => {
  const { liveMode, liveCard, LAND_WAIT_MS, mmss, meterLevel } = await import('../web/rec-live.js');
  const id = 'weekly', now = 1_000_000;
  const S = (patch) => ({ phase: 'idle', project: id, paused: false, ...patch });
  assert.equal(liveMode(S({ phase: 'recording' }), { id, now }), 'live');
  assert.equal(liveMode(S({ phase: 'recording', paused: true }), { id, now }), 'paused');
  assert.equal(liveMode(S({ phase: 'starting' }), { id, now }), 'starting');
  assert.equal(liveMode(S({ phase: 'stopping' }), { id, now }), 'saving');
  assert.equal(liveMode(S({ phase: 'saving', progress: 0.4 }), { id, now }), 'saving');
  // Another project's take, or nothing recording: the canvas is as before.
  assert.equal(liveMode(S({ phase: 'recording', project: 'other' }), { id, now }), null);
  assert.equal(liveMode(S({}), { id, now }), null);
  // Saved, but the project doesn't show it yet: still "Saving the take…"; once it shows (or after the wait), not.
  const landed = { take: 't1', at: now - 1000 };
  assert.equal(liveMode(S({ landed }), { id, now, hasTake: false }), 'saving');
  assert.equal(liveMode(S({ landed }), { id, now, hasTake: true }), null);
  assert.equal(liveMode(S({ landed: { take: 't1', at: now - LAND_WAIT_MS - 1 } }), { id, now }), null);
  // A take recorded into a block never reaches the canvas: nothing waits for it there.
  assert.equal(liveMode(S({ landed, target: 'block:intro' }), { id, now }), null);
  // The Media card says it too, instead of "No recording yet".
  assert.equal(liveCard(null), null);
  assert.equal(liveCard('live').title, 'Recording now');
  assert.equal(liveCard('paused').title, 'Recording · paused');
  assert.equal(liveCard('saving').title, 'Saving the take…');
  assert.equal(mmss(62_400), '1:02');
  assert.equal(meterLevel(-60), 0);
  assert.equal(meterLevel(0), 40);
  assert.equal(meterLevel(-30), 20);
});

test('B7: the recorder exports its live streams, marks the landed take and lets the canvas dock its bar under the script', () => {
  const rec = web('recorder.js');
  assert.match(rec, /export const liveStreams = \(\) => run\?\.d \|\| dev \|\| null;/);
  assert.match(rec, /landed: st\.ok \? \{ take, at: Date\.now\(\) \} : null/);
  assert.match(rec, /target: sel\.target, landed: null/);
  // Docking slots stack: the script's bar (pushed last) wins over the canvas's (under: true).
  assert.match(rec, /export const dockControls = \(slot, \{ under = false \} = \{\}\)/);
  assert.match(rec, /if \(under\) docks\.unshift\(slot\); else docks\.push\(slot\);/);
  assert.doesNotMatch(rec, /dockSlot/);
  const live = web('rec-live.js');
  assert.match(live, /dockControls\(ctl, \{ under: true \}\)/);
  assert.doesNotMatch(live, /stopStream|\.stop\(\)/, 'the view never stops the recorder’s streams');
  const app = web('app.js');
  assert.match(app, /makeLiveView\(\{ rec, id, hasTake, onChange: \(\) => paintStart\(\) \}\)/);
  assert.match(app, /start\.show\(empty && tab === 'canvas' && !recording\)/);
  assert.match(app, /currentCard\(mediaData, mediaActions, \{ live: lv \}\)/);
  assert.match(app, /live\.destroy\(\)/);
});

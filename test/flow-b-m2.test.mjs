// Flow changes from the UX walkthrough (handoff ux-2026-10-24, TRIAGE §B), medium batch 2: the live view while
// recording (B7), the idea carrying into the script (B8) and Claude's state shown the same way everywhere (B10).
//   node --test test/flow-b-m2.test.mjs
// Synthetic temporary studio only: no server, browser, agent, media processing, keys or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

test('B8: a card keeps its idea; Use this idea writes an outline stub (title, idea, hook and beats when it has them)', async () => {
  const { parseIdeaLine, ideaOf, outlineStub } = await import('../server/idea-script.mjs');
  assert.deepEqual(parseIdeaLine('10 MIN EDIT — the result'), { words: '10 MIN EDIT', text: 'the result' });
  assert.deepEqual(parseIdeaLine('**STOP** - a warning — hook: You are cutting too much. — beats: the mistake; the fix; the result'),
    { words: 'STOP', text: 'a warning', hook: 'You are cutting too much.', beats: ['the mistake', 'the fix', 'the result'] });
  // A card from before cards kept their idea: its name says it.
  const old = ideaOf({ name: 'Idea 3 · HOW I EDIT — steps · refined' }, { sheet: { brief: 'my editing setup' }, title: 'How I edit' });
  assert.deepEqual(old, { name: 'Idea 3', words: 'HOW I EDIT', text: 'steps', hook: '', beats: [], brief: 'my editing setup', title: 'How I edit' });
  const plain = outlineStub(old);
  assert.equal(plain, '[From Packaging: Idea 3]\n[Title: How I edit]\n[What it\'s about: my editing setup]\n[The idea: “HOW I EDIT” — steps]\n\n[Next: a hook and three beats. Write them here, or ask Claude to outline it.]\n');
  const full = outlineStub(ideaOf({ name: 'Idea 2 · STOP', brief: 'cutting less', idea: parseIdeaLine('STOP — a warning — hook: Stop cutting. — beats: one; two; three; four') }));
  assert.match(full, /\[Hook\]\nStop cutting\.\n\n\[1\] one\n\[2\] two\n\[3\] three\n$/);
  assert.doesNotMatch(full, /\[Next:|four/);
  // Brackets in the idea never break a [cue] (the prompter shows cues dim).
  assert.match(outlineStub(ideaOf({ name: 'Idea 1', brief: 'a [secret] plan' })), /\[What it's about: a secret plan\]/);
});

test('B8: a script with text is never overwritten; append or skip', async () => {
  const { writeIdeaScript } = await import('../server/idea-script.mjs');
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-idea-'));
  try {
    const f = join(dir, 'script.md');
    assert.deepEqual(writeIdeaScript(dir, '[A]\n'), { written: 'new' });
    assert.equal(readFileSync(f, 'utf8'), '[A]\n');
    writeFileSync(f, 'Mine.\r\n');
    assert.deepEqual(writeIdeaScript(dir, '[B]\n'), { written: null, exists: true, words: 1 });
    assert.equal(readFileSync(f, 'utf8'), 'Mine.\r\n');
    assert.deepEqual(writeIdeaScript(dir, '[B]\n', { append: true }), { written: 'appended' });
    assert.equal(readFileSync(f, 'utf8'), 'Mine.\n\n[B]\n');
    assert.deepEqual(writeIdeaScript(dir, '[B]\n', { append: true }), { written: 'already' });
    writeFileSync(f, '   \n');
    assert.deepEqual(writeIdeaScript(dir, '[C]\n'), { written: 'new' }, 'a blank script is empty');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B8: the board offers Use this idea and, when empty, a big Generate 6 ideas with the brief; the chat offers the outline', () => {
  const pkg = web('packaging.js');
  assert.match(pkg, /data-act="use">Use this idea \(outline in the script\)/, 'every card’s ⋯ menu');
  assert.match(pkg, /\$\{main \? '<button type="button" class="btn small pg-use" data-act="use"/, 'the main card shows it');
  assert.match(pkg, /<span class="pg-tag">Main<\/span><button type="button" class="nc-link" data-act="use">Use this idea<\/button>/, 'and the main winner slot');
  assert.match(pkg, /confirmBox\(\{ title: 'Record’s script already has text', ok: 'Add it under the script', cancel: 'Skip'/);
  assert.match(pkg, /\{ append: true \}/);
  assert.match(pkg, /class="btn primary pg-go6">Generate 6 ideas<\/button>/);
  assert.match(pkg, /brief\.oninput = \(\) => \{ gen\.elements\.brief\.value = brief\.value; \}/, 'the board’s field is the Generate brief');
  assert.match(pkg, /One generation on your ChatGPT plan\./);
  const app = web('app.js');
  assert.match(app, /const outline = \(ask\) => \{ setFold\(false\); chat\.send\(ask\); \};/, 'Ask Claude to outline it only sends a message');
  assert.match(app, /chat\.offer\(`\$\{name\} is in Record’s script as an outline\.`/);
  const srv = readFileSync(new URL('../server/packaging.mjs', import.meta.url), 'utf8');
  assert.match(srv, /op === 'use'[\s\S]{0,900}writeIdeaScript\(dir, stub, \{ append: b\.append === true \}\)/);
  // The route comes before anything that talks to Codex: Use this idea makes no model call.
  assert.ok(srv.indexOf("op === 'use'") < srv.indexOf('const c = chatFor(project);\n    if (action === \'answer\')'));
});

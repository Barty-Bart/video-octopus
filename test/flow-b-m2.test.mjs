// Flow changes from the UX walkthrough (handoff ux-2026-10-24, TRIAGE §B), medium batch 2: the live view while
// recording (B7), the idea carrying into the script (B8) and Claude's state shown the same way everywhere (B10).
//   node --test test/flow-b-m2.test.mjs
// Synthetic temporary studio only: no server, browser, agent, media processing, keys or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Source text with LF endings: a Windows checkout has CRLF.
const web = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

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
  const srv = readFileSync(new URL('../server/packaging.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(srv, /op === 'use'[\s\S]{0,900}writeIdeaScript\(dir, stub, \{ append: b\.append === true \}\)/);
  // The route comes before anything that talks to Codex: Use this idea makes no model call.
  assert.ok(srv.indexOf("op === 'use'") < srv.indexOf('const c = chatFor(project);\n    if (action === \'answer\')'));
});

test('B10: one state model: waiting, then stopped, then working, then open; the same words everywhere', async () => {
  const A = await import('../web/attention.js');
  assert.equal(A.chatState({}), 'idle');
  assert.equal(A.chatState({ busy: true, stopped: { text: 'x' } }), 'working', 'a new turn has dealt with the stop');
  assert.equal(A.chatState({ asks: 1, busy: true }), 'waiting');
  assert.equal(A.chatState({ open: [{ text: 'x' }] }), 'open');
  const snap = (chat, o) => ({ chat, asks: [], busy: false, stopped: null, open: [], ...o });
  const ask = { chat: 'p.packaging', id: 'r1', text: 'Wants to use Bash', at: 1, focus: () => 'f' };
  assert.equal(A.pickState([snap('p', { busy: true }), snap('p.packaging', { asks: [ask] })]).state, 'waiting');
  const w = A.pickState([snap('p', { busy: true }), snap('p.packaging', { asks: [ask] })]);
  assert.deepEqual([w.chat, w.count, w.text, w.focus()], ['p.packaging', 1, 'Wants to use Bash', 'f']);
  assert.equal(A.pickState([snap('p', { open: [{ text: 'a' }] }), snap('q', { stopped: { text: 'exit 3' } }), snap('r', { busy: true })]).state, 'stopped');
  assert.equal(A.pickState([snap('p', { open: [{ text: 'a' }] }), snap('r', { busy: true })]).state, 'working');
  const open = A.pickState([snap('p', { open: [{ text: 'Plan didn’t finish', count: 1 }, { text: '1 note still open', count: 1 }] })]);
  assert.deepEqual([open.state, open.count, open.text], ['open', 2, 'Plan didn’t finish · 1 note still open']);
  assert.equal(A.pickState([]).state, 'idle');

  const words = (state, o = {}) => A.describe({ state, count: 1, text: '', ...o }, 'Claude');
  assert.deepEqual([words('working').badge, words('working').line, words('working').title, words('working').mark], ['Working', 'Claude is working', '◌ ', 'working']);
  assert.deepEqual([words('waiting').badge, words('waiting', { count: 2 }).badge, words('waiting').title], ['Waiting for you', '2 waiting for you', '● Waiting for you · ']);
  assert.deepEqual([words('open', { count: 2 }).badge, words('open').line, words('open').title], ['Claude finished · 2 still open', 'Claude finished', '(1) ']);
  assert.deepEqual([words('stopped').badge, words('stopped').line, words('stopped').title], ['Claude stopped', 'Claude stopped', '! ']);
  assert.equal(A.describe({ state: 'working', agent: 'Codex' }).line, 'Codex is working', 'Packaging’s chat says Codex');
  assert.equal(words('idle').badge, '');

  // The tab title: "● Waiting for you · " kept for waiting, a quieter mark while working; a page's own title is kept.
  let t = A.titleFor('Weekly tips · Video Octopus', { state: 'working' });
  assert.deepEqual(t, { title: '◌ Weekly tips · Video Octopus', applied: '◌ ' });
  t = A.titleFor(t.title, { state: 'waiting', count: 1 }, t.applied);
  assert.equal(t.title, '● Waiting for you · Weekly tips · Video Octopus');
  t = A.titleFor(t.title, { state: 'stopped' }, t.applied);
  assert.equal(t.title, '! Weekly tips · Video Octopus');
  t = A.titleFor(t.title, { state: 'open', count: 1 }, t.applied);
  assert.deepEqual(t, { title: '(1) Weekly tips · Video Octopus', applied: '(1) ' });
  t = A.titleFor(t.title, { state: 'idle' }, t.applied);
  assert.deepEqual(t, { title: 'Weekly tips · Video Octopus', applied: '' });
  assert.equal(A.titleFor('! Exclamation video · Video Octopus', { state: 'idle' }, '').title, '! Exclamation video · Video Octopus', 'a name that starts with ! stays');
});

test('B10: chats report their state; a stop waits for Send again; open items have a hook for more (notes)', async () => {
  const A = await import('../web/attention.js');
  const id = 'b10-video';
  A.chatAgent(id, 'Claude');
  A.setWorking(id, true);
  assert.equal(A.stateOf(id).state, 'working');
  A.setWorking(id, true, { detail: 'Compacting the chat…' });
  assert.equal(A.stateOf(id).text, 'Compacting the chat…');
  A.setWorking(id, false);
  A.openItems(id, 'questions', { count: 1, text: 'Claude asked you something' });
  let sent = 0;
  A.setStopped(id, { text: 'Claude Code stopped (exit 3).', retry: () => { sent++; } });
  let st = A.stateOf(id);
  assert.equal(st.state, 'stopped');
  st.retry();
  assert.equal(sent, 1);
  A.setWorking(id, true); // Send again started a turn
  assert.equal(A.stateOf(id).state, 'working');
  A.setWorking(id, false);
  assert.equal(A.stateOf(id).state, 'open', 'the stop is gone; the question is still open');
  A.openItems(id, 'notes', { count: 1, text: '1 note still open' }); // the Polish notes summary's hook (B6)
  st = A.stateOf(id);
  assert.deepEqual([st.count, st.items.map((x) => x.key)], [2, ['questions', 'notes']]);
  A.openItems(id, 'questions', null);
  A.openItems(id, 'notes', null);
  assert.equal(A.stateOf(id).state, 'idle');
  A.waiting({ chat: `${id}.packaging`, id: 'q1', kind: 'question', text: 'Which one?' });
  A.setWorking(id, true);
  assert.equal(A.stateOf([id, `${id}.packaging`]).state, 'waiting');
  assert.equal(A.stateOf(id).state, 'working', 'the folded rail is this video’s chat only');
  A.clearChat(`${id}.packaging`);
  A.clearChat(id);
  assert.equal(A.stateOf().state, 'idle');
});

test('B10: the chat, the top bar, the folded rail and the dock all draw from attention.js', () => {
  const app = web('app.js');
  assert.match(app, /setBusy\(ev\.busy\); setWorking\(id, ev\.busy\);/, 'plain chat turns count as working, not only steps');
  assert.match(app, /setStopped\(id, \{ text: ev\.text, retry: sendAgain/);
  assert.match(app, /openItems\(id, 'questions'/);
  assert.match(app, /const asked = \/\\\?\$\/\.test\(last\) && !\/\^\\s\*\(\\d\+\[\.\)\]\|\[-\*•\]\)\\s\/\.test\(last\);/, 'a list item ending in "?" is not a question for you');
  assert.match(app, /if \(busy\) setWorking\(id, true, \{ detail: ev\.text \}\)/, 'the agent’s own status rides along');
  assert.match(app, /const st = stateOf\(mine\), d = describe\(st\)/, 'the top bar badge: this video’s chat and its Packaging chat');
  assert.match(app, /<i class="chat-state" aria-hidden="true" hidden><\/i>/, 'the folded rail’s mark');
  assert.match(app, /const rs = stateOf\(id\), rd = describe\(rs\), mark = \$\('\.chat-state', el\)/);
  // Permission requests still show once, as the banner: the badge and the dock only point at it.
  assert.equal((app.match(/data-w="1">Allow<\/button>/g) || []).length, 1);
  const rail = web('rail.js');
  assert.match(rail, /openItems\(id, 'unfinished', uf \?/, 'the dock’s Didn’t finish is an open item');
  assert.match(rail, /function paintState\(rs = running\(\)\)/);
  assert.match(rail, /onAttention\(\(\) => \{ paintEmpties\(\); paintState\(\); \}\)/);
  assert.match(rail, /data-a="st-retry">Send again<\/button>/);
  const att = web('attention.js');
  assert.match(att, /const WORKING_MARK = '◌ ', STOPPED_MARK = '! ';/);
});

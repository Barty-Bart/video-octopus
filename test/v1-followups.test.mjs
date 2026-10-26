// V1 Simple mode, the seven follow-ups Bart answered (handoff v1-followups-2026-10-26): Simple's Build builds the whole
// video (core/pipelines.json `inSimple`, server/studio.mjs forMode); the Music tool's own music from Resources (kind
// music); Also add to Resources asks "Is this a photo of you?" for a picture; Settings' words in Simple; the chat's tool
// lines and the plan-usage meter hidden in Simple; the waveform's click seeks and Restore / ⌥-click bring a part back.
// Server modules are imported only after STUDIO_LOCAL_DIR points at the temporary studio's settings.
// Synthetic temporary studios and a real disposable server with a fake agent: no model, no network, no paid call.
// Windows-safe: forward-slash paths, plain file names, CRLF normalised.
//   node --test test/v1-followups.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { png } from './png-fixture.mjs';
import { cleanTools, recordPreview, cameraCorner, scriptPanel, SCRIPT_SIDE_MIN } from '../web/simple-flow.js';
import { SIMPLE_KINDS, ACCEPT, AUDIO_ACCEPT, guessKind, fitsKind, dropKind, dropAsks, resourceFields } from '../web/resource-kinds.js';
import { editorModeText, SIMPLE_UPDATES } from '../web/simple.js';
import { clickAction, restoreTarget, waveHint, gapsOf } from '../web/simple-wave.js';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lf = (s) => String(s).replace(/\r\n/g, '\n');
const src = (f) => lf(readFileSync(join(APP, f), 'utf8'));
const write = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v, null, 2)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An in-process studio for the pipeline parts (the server modules read settings.json on every call).
const root = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-v1fu-'));
const studio = join(root, 'studio'), local = join(root, 'local');
const setMode = (mode) => write(join(local, 'settings.json'), { studio, projectsDir: 'projects', ...(mode ? { editor: { mode } } : {}) });
setMode(null);
process.env.STUDIO_LOCAL_DIR = local;
process.env.HF_HOME = join(root, 'hf');
test.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

const SCENES = [
  { id: 1, block: 'intro', start: 0, end: 2, layout: 'talking-head', status: 'planned' },
  { id: 2, block: 'intro', start: 2, end: 4, layout: 'broll', cutout: true, status: 'planned' },
  { id: 3, block: 'main', start: 4, end: 6, layout: 'screen', status: 'planned' },
  { id: 4, block: 'main', start: 6, end: 8, layout: 'broll', cutout: true, status: 'planned' },
  { id: 5, block: 'outro', start: 8, end: 9, layout: 'card', status: 'planned' },
];
function project(id) {
  const dir = join(studio, 'projects', id);
  write(join(dir, 'project.json'), { name: id, type: 'tutorial' });
  write(join(dir, 'work', 'blocks.json'), { v: 1, marked: true, blocks: [{ id: 'intro', type: 'intro', label: 'Intro', order: 1 }, { id: 'main', type: 'body', label: 'Main body', order: 2 }, { id: 'outro', type: 'outro', label: 'Outro', order: 3 }] });
  write(join(dir, 'work', 'production.json'), { scenes: structuredClone(SCENES), approved: { at: '2026-10-26T10:00:00Z', by: 'creator', scenes: 5 } });
  return dir;
}

// ---------- 1. Simple builds the whole video ----------
test('1: in Simple the tutorial’s Build builds every planned scene and the whole video; Advanced still builds the intro', async () => {
  const { forMode, pipelineStatus, stepPrompt } = await import('../server/studio.mjs');
  const core = JSON.parse(src('core/pipelines.json'));
  const build = (p, type) => p.formats[type].steps.find((s) => typeof s === 'object' && s.stage === 'Build');
  const simple = forMode(core, 'simple'), advanced = forMode(core, 'advanced');
  const s = build(simple, 'tutorial'), a = build(advanced, 'tutorial');
  assert.equal(s.id, 'intro', 'the same step id in both modes (skips, the rail, unfinished steps)');
  assert.deepEqual([s.name, s.scenes ?? null, s.done.files], ['Build the video', null, ['renders/*video_v*.mp4']]);
  assert.match(s.ask, /every scene of every section, from the first to the last \(not only the intro\)/);
  assert.match(s.ask, /the whole video into renders\/ as <project>_video_v1\.mp4/);
  assert.match(s.ask, /sheet\.py mark work\/production\.json building <scene id>/, 'B5b per-scene progress');
  assert.match(s.ask, /Scenes with \\?"cutout\\?": true get their subject cut out first/, 'the cutout path');
  assert.match(s.ask, /Never download a model or install anything/);
  assert.equal('inSimple' in s, false);
  assert.deepEqual([a.name, a.scenes, a.done.files, 'inSimple' in a], ['Build the intro', 'intro', ['renders/*intro*.mp4'], false]);
  assert.deepEqual(a, Object.fromEntries(Object.entries(build(core, 'tutorial')).filter(([k]) => k !== 'inSimple')), 'Advanced reads the step exactly as written');
  // The Short and the explainer already build the whole video: the same in both modes.
  for (const type of ['short', 'explainer', 'faceless', 'audio']) assert.deepEqual(simple.formats[type], advanced.formats[type], type);

  const dir = project('whole');
  const intro = () => pipelineStatus(dir, 'tutorial').steps.find((x) => x.id === 'intro');
  setMode(null); // no editor.mode: Simple, the default
  assert.equal(intro().name, 'Build the video');
  assert.equal(intro().done, false);
  write(join(dir, 'renders', 'whole_intro_v1.mp4'), 'synthetic');
  assert.equal(intro().done, false, 'an intro-only render is not the whole video in Simple');
  write(join(dir, 'renders', 'whole_video_v1.mp4'), 'synthetic');
  assert.equal(intro().done, true);
  assert.match(stepPrompt(dir, 'tutorial', 'intro'), /Build this whole YouTube video/);
  assert.match(pipelineStatus(dir, 'tutorial', { lines: true }).steps.find((x) => x.id === 'intro').line, /^Video rendered/, 'not “Intro rendered”');
  setMode('advanced');
  assert.deepEqual([intro().name, intro().done], ['Build the intro', true]);
  assert.match(stepPrompt(dir, 'tutorial', 'intro'), /^Build the intro \(the intro block/);
  rmSync(join(dir, 'renders', 'whole_intro_v1.mp4'));
  assert.equal(intro().done, false, 'Advanced’s intro step wants its intro');
  setMode('simple');
  assert.equal(intro().done, true);
  // An export of a project whose name has "video" in it is no Build: the done rule wants "<project>_video_v<n>".
  const other = project('untitled-video');
  write(join(other, 'renders', 'untitled-video_pip_v1.mp4'), 'synthetic');
  assert.equal(pipelineStatus(other, 'tutorial').steps.find((x) => x.id === 'intro').done, false);
});

test('1: Simple’s whole-video Build: its scope is every scene (progress, cutouts) and its render covers the whole video', async () => {
  const { pipelineStatus } = await import('../server/studio.mjs');
  const { buildSteps, renderKind } = await import('../server/built.mjs');
  const { startBuildRun, buildProgress, endBuildRun } = await import('../server/build-progress.mjs');
  const R = await import('../server/roto.mjs');
  const dir = project('scope');
  const step = () => pipelineStatus(dir, 'tutorial').steps.find((x) => x.id === 'intro');
  const mark = (sid, status) => { const f = join(dir, 'work/production.json'), p = JSON.parse(lf(readFileSync(f, 'utf8'))); p.scenes.find((x) => x.id === sid).status = status; write(f, p); };
  const probe = async () => ({ imports: { torch: true, torchvision: true, transformers: true, numpy: true, Pillow: true }, sam2: true });

  setMode('simple');
  startBuildRun('scope', dir, step(), { now: Date.now() - 1000 });
  mark(1, 'building');
  let b = buildProgress('scope', dir);
  assert.deepEqual([b.total, b.order], [5, ['1', '2', '3', '4', '5']], 'every planned scene: "Scene 1 of 5"');
  mark(1, 'planned'); endBuildRun('scope');
  R.clearRotoCache();
  let r = await R.prepareRoto(dir, step(), { python: '/py/fixture', probe, have: [], choice: 'auto' });
  assert.deepEqual(JSON.parse(lf(readFileSync(join(dir, R.CUTOUTS), 'utf8'))).scenes, ['2', '4'], 'both flagged scenes, the body’s too');
  assert.match(r.note, /--why no-model` \(2 and 4\)/);
  const steps = buildSteps('tutorial');
  assert.deepEqual(steps.map((x) => [x.step, x.block]), [['intro', null]], 'a whole-video build, like a Short');
  assert.deepEqual(renderKind('scope', 'scope_video_v2.mp4', steps).kind, 'build');
  assert.deepEqual(renderKind('scope', 'scope_pip_v1.mp4', steps).kind, 'export');

  setMode('advanced');
  startBuildRun('scope', dir, step(), { now: Date.now() - 1000 });
  mark(1, 'building');
  b = buildProgress('scope', dir);
  assert.deepEqual([b.total, b.order], [2, ['1', '2']], 'Advanced: the intro block only');
  mark(1, 'planned'); endBuildRun('scope');
  R.clearRotoCache();
  r = await R.prepareRoto(dir, step(), { python: '/py/fixture', probe, have: [], choice: 'auto' });
  assert.deepEqual(JSON.parse(lf(readFileSync(join(dir, R.CUTOUTS), 'utf8'))).scenes, ['2']);
  assert.deepEqual(buildSteps('tutorial').map((x) => [x.step, x.block]), [['intro', 'intro']]);
  setMode(null);
});

// ---------- 2. Music: the three beds, and your own ----------
const wav = (seconds = 0.2, rate = 8000) => {
  const n = Math.round(seconds * rate), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(3000 * Math.sin(i / 4)), 44 + i * 2);
  return b;
};
test('2: music is a Resources kind (sound files), known by its name; a dropped sound still gets no link', async () => {
  const { sniff } = await import('../server/brand.mjs'); // after STUDIO_LOCAL_DIR is set (server modules read it on import)
  assert.deepEqual(Object.keys(SIMPLE_KINDS), ['logo', 'font', 'photo', 'product', 'clip', 'music']);
  for (const f of ['theme.mp3', 'Bed.WAV', 'loop.m4a', 'a.aac', 'b.ogg', 'c.flac']) assert.equal(guessKind(f), 'music', f);
  assert.equal(fitsKind('theme.mp3', 'music'), true);
  assert.equal(fitsKind('theme.png', 'music'), false);
  assert.equal(fitsKind('theme.mp3', 'clip'), false);
  for (const ext of AUDIO_ACCEPT.split(',')) assert.ok(ACCEPT.split(',').includes(ext), ext);
  assert.deepEqual(resourceFields('music'), { kind: 'music', likeness: 'nobody', use: 'ask' });
  assert.equal(dropKind('voice.wav'), null, 'a voice note dropped for Claude isn’t music');
  // The upload's bytes must look like their extension.
  assert.equal(sniff('wav', wav()), true);
  assert.equal(sniff('mp3', Buffer.from('ID3\x04\x00fixture', 'latin1')), true);
  assert.equal(sniff('mp3', Buffer.from([0xff, 0xfb, 0x90, 0x00])), true);
  assert.equal(sniff('flac', Buffer.from('fLaC\x00', 'latin1')), true);
  assert.equal(sniff('ogg', Buffer.from('OggS\x00', 'latin1')), true);
  assert.equal(sniff('m4a', Buffer.from('\x00\x00\x00\x20ftypM4A ', 'latin1')), true);
  assert.equal(sniff('wav', png(2, 2, () => [0, 0, 0])), false);
  // The tool remembers which of your files it plays; anything else is dropped.
  assert.equal(cleanTools({ music: { cue: 'c1', file: 'work/music/ab-theme.mp3', resource: '0b7e-41aa', gain: -6 } }).music.resource, '0b7e-41aa');
  assert.equal(cleanTools({ music: { cue: 'c1', file: 'x', resource: '../etc' } }).music.resource, undefined);
  assert.equal(cleanTools({ music: { cue: 'c1', file: 'x', bed: 'calm', resource: 'abc' } }).music.resource, undefined, 'a made bed is a bed');
});

test('9: no tool rail in Simple: Claude is told it can do captions, music, titles and zooms; music by the command line', () => {
  const ed = src('web/simple-editor.js');
  assert.doesNotMatch(ed, /sx-tools|data-tool=|sx-panel/, 'no Captions · Music · Text · Effects buttons');
  assert.doesNotMatch(ed, /\b(onDocDown|toolOpen|paintTool|loadMine)\b/, 'nothing of the tool rail is left behind');
  assert.doesNotMatch(src('web/simple.css'), /\.sx-tools|\.sx-panel/);
  assert.match(src('web/simple.css'), /\.project\.simple \{ grid-template-columns: minmax\(340px, 440px\) minmax\(0, 1fr\); \}/, 'the width goes to the video');
  const idx = src('server/index.mjs');
  assert.match(idx, /\.\.\.\(isAdvanced\(\) \? \[\] : \[simpleChatContext\(id\)\]\)/);
  assert.match(idx, /there are no Captions, Music, Text or Effects buttons/);
  for (const w of ['captions', 'music under the voice', 'titles', 'zooms', 'music \$\{id\} calm\|bright\|warm', '--resource <id>']) assert.match(idx, new RegExp(w), w);
  const cli = src('bin/octopus.mjs');
  assert.match(cli, /octopus music <project> calm\|bright\|warm/);
  assert.match(cli, /api\(`\$\{base\}\/simple-music`, \{ resource: opt\.resource \}\)/);
  // Captions stay on by default in the Download.
  assert.equal(cleanTools({}).captions.on, true);
});

// ---------- 3. Also add to Resources asks for a picture ----------
test('3: Also add to Resources asks "Is this a photo of you?" for a picture; fonts, clips and logos by name stay automatic', () => {
  assert.equal(dropAsks('source/app shot.png'), true);
  assert.equal(dropAsks('me.JPG'), true);
  for (const f of ['acme-logo.png', 'mark.svg', 'Brand.woff2', 'b-roll.MOV', 'notes.pdf', 'voice.wav']) assert.equal(dropAsks(f), false, f);
  const ed = src('web/simple-editor.js');
  assert.match(ed, /const kind = dropKind\(j\.file\), ask = kind && dropAsks\(j\.file\);/);
  assert.match(ed, /data-kind="\$\{ask \? '' : kind\}"/);
  assert.match(ed, /kind = await askKind\(box, \{ name, src: `\$\{base\}\/media\?f=\$\{encodeURIComponent\(b\.dataset\.res\)\}` \}\);/);
  assert.match(ed, /if \(!kind\) \{ last\.textContent = `\$\{name\} is with the project\.`; return; \}/, 'Skip keeps it with the video only');
  const page = src('web/resources-page.js');
  assert.match(page, /export function askKind\(box, file\)/);
  assert.match(page, /Is this a photo of you\?/);
  assert.match(page, /data-k="photo">Yes, it’s me<\/button>/);
});

// ---------- 4. Settings' words in Simple ----------
test('4: in Simple, Settings › Editor mode and Updates name neither My styles nor skills; Advanced keeps its words', () => {
  assert.doesNotMatch(editorModeText('simple'), /styles?|skills?|brand kits|librar/i);
  assert.match(editorModeText('simple'), /Nothing is lost when you switch/);
  assert.match(editorModeText('advanced'), /Advanced brings back My styles, brand kits, skills/);
  for (const [k, v] of Object.entries(SIMPLE_UPDATES)) assert.doesNotMatch(v, /styles?|skills?|preferences/i, k);
  const up = src('web/updates.js');
  for (const k of Object.keys(SIMPLE_UPDATES).filter((x) => x !== 'section')) assert.match(up, new RegExp(`W\\?\\.${k}\\b`), k);
  assert.match(up, /const W = isAdvanced\(\) \? null : SIMPLE_UPDATES;/);
  assert.match(up, /const skillParts = isAdvanced\(\) \? \[preferences, skillGroup\] : \[\];/, 'the skill groups stay Advanced only');
  const set = src('web/settings.js');
  assert.match(set, /row\('Simple or Advanced', editorModeText\(mode\)/);
  assert.match(set, /const SIMPLE_SECTIONS = \{ updates: \['Updates', SIMPLE_UPDATES\.section\] \};/);
  assert.match(set, /const \[title, about\] = sectionOf\(k\);/);
});

// ---------- 5. Setup from Set up: unchanged ----------
test('5: Set up still opens the full Setup page at Object separation (no change)', () => {
  assert.match(src('web/cutout.js'), /SETUP_HREF = '#\/setup\/objsep'/);
});

// ---------- 6. The chat's tool lines and the usage meter: Advanced only ----------
test('6: Simple hides the chat’s tool rows, the brief under a step and the usage meter; banners and errors still show', () => {
  const css = src('web/simple.css');
  const rule = /([^{}]+)\{\s*display:\s*none\s*!important;\s*\}/g;
  const hidden = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(rule)].flatMap((m) => m[1].split(',').map((x) => x.trim())).filter(Boolean);
  for (const sel of ['.project.simple .msgs .tool', '.project.simple .msgs .ms-brief', '.project.simple .msgs .perm-line', 'html[data-mode=simple] #usage']) assert.ok(hidden.includes(sel), sel);
  assert.ok(!hidden.some((s) => /wait-banner|\.error|\.ask\b|msg-ai|\.note\b/.test(s)), 'the permission banner, questions, errors, notes and Claude’s sentences stay');
  const app = src('web/app.js');
  assert.match(app, /const waitBar = h\('<div class="wait-banner" role="alert"/, 'the banner is its own element, not a tool row');
  assert.match(app, /<div class="error"><span class="err-t">/);
  assert.match(src('web/mode.js'), /document\.documentElement\.dataset\.mode = m;/, 'data-mode is what the meter rule keys on');
});

// ---------- 7. The waveform: a click seeks; Restore or ⌥-click brings a part back ----------
test('7: a click on a greyed part seeks; ⌥/Alt-click restores it; Restore takes the selection or the part under the playhead', () => {
  const segs = [[0, 2], [3, 5], [6, 9]], D = 10;
  assert.deepEqual(gapsOf(segs, D), [[2, 3], [5, 6], [9, 10]]);
  assert.deepEqual(clickAction(segs, D, 2.5), { seek: 2.5 }, 'a plain click on a greyed part seeks');
  assert.deepEqual(clickAction(segs, D, 1), { seek: 1 });
  assert.deepEqual(clickAction(segs, D, 2.5, { alt: true }), { restore: [2, 3] });
  assert.deepEqual(clickAction(segs, D, 1, { alt: true }), { seek: 1 }, '⌥ on a kept part just seeks');
  assert.deepEqual(clickAction(segs, D, 2.5, { alt: true, editable: false }), { seek: 2.5 }, 'locked: never an edit');
  assert.deepEqual(restoreTarget(segs, D, [1.5, 3.5], 0), [1.5, 3.5], 'a selection over a greyed part');
  assert.equal(restoreTarget(segs, D, [3.2, 4.8], 2.5), null, 'a selection of kept words only: nothing to restore');
  assert.deepEqual(restoreTarget(segs, D, null, 5.5), [5, 6], 'no selection: the greyed part under the playhead');
  assert.deepEqual(restoreTarget(segs, D, [4, 4.01], 9.5), [9, 10], 'a tiny selection is a click');
  assert.equal(restoreTarget(segs, D, null, 4), null);
  const hint = waveHint({ ready: true, locked: false });
  assert.match(hint, /Click to move the playhead/);
  assert.match(hint, /Restore a greyed part/);
  assert.match(hint, /(⌥|Alt)-click a greyed part to bring it back/);
  assert.doesNotMatch(hint, /^click a greyed/i);
  assert.match(waveHint({ ready: true, locked: true }), /Unlock to edit/);
  const wave = src('web/simple-wave.js');
  assert.match(wave, /data-a="restore" disabled/);
  assert.match(wave, /const act = model\.ready \? clickAction\(model\.segs, dur\(\), d0\.t0, \{ alt: d0\.alt, editable: !model\.locked \}\) : \{ seek: d0\.t0 \};/);
  assert.doesNotMatch(wave, /if \(gap\) \{ if \(await model\.edit\(restoreRange/, 'the old click-to-restore is gone');
});

// ---------- 8. Record: a live preview of what the take records ----------
test('8: each source maps to its preview: camera + screen in the corner, camera, screen (with its picker), or the mic', () => {
  const both = recordPreview('camera-screen', { streams: { cam: 1, mic: 1 }, layout: { webcam: { x: 0.05, y: 0.06, w: 0.2 } } });
  assert.deepEqual([both.view, both.frame, both.screen, both.camera, both.pickScreen, both.changeScreen, both.ready], ['camera-screen', '16:9', true, true, true, false, false]);
  assert.deepEqual(both.corner, { x: 0.05, y: 0.06, w: 0.2 }, 'the style’s picture-in-picture box');
  const picked = recordPreview('camera-screen', { streams: { screen: 1, cam: 1, mic: 1 } });
  assert.deepEqual([picked.pickScreen, picked.changeScreen, picked.ready], [false, true, true]);
  assert.deepEqual(picked.corner, cameraCorner(null), 'no style box: the bottom-right corner');
  const camOnly = recordPreview('camera', { aspect: '9:16', streams: { cam: 1, mic: 1 } });
  assert.deepEqual([camOnly.view, camOnly.frame, camOnly.cameraFills, camOnly.corner, camOnly.pickScreen, camOnly.cameraPicker], ['camera', '9:16', true, null, false, true]);
  const screen = recordPreview('screen', { streams: { mic: 1 } });
  assert.deepEqual([screen.view, screen.camera, screen.pickScreen, screen.cameraPicker, screen.micPicker], ['screen', false, true, false, true]);
  const audio = recordPreview('audio', { streams: { mic: 1 } });
  assert.deepEqual([audio.view, audio.bigMeter, audio.screen, audio.camera, audio.ready], ['mic', true, false, false, true]);
  assert.equal(recordPreview('nonsense').view, 'camera');
  assert.deepEqual(cameraCorner({ webcam: { x: 2, y: 0, w: 0.2 } }), cameraCorner(null), 'a box off the frame is ignored');
});

test('8: the script panel is secondary: one line while empty, open with a script, beside the preview when wide', () => {
  assert.deepEqual(scriptPanel({ text: '' }), { open: false, place: 'side', words: 0, line: 'Paste or write one, or ask Claude. It scrolls as a teleprompter while you record.' });
  assert.equal(scriptPanel({ text: '', open: true }).open, true, 'opened by hand');
  const s1 = scriptPanel({ text: 'Hello there, this is my video [pause] about cuts.', width: 375 });
  assert.deepEqual([s1.open, s1.place, s1.words, s1.line], [true, 'below', 8, '8 words · under a minute']);
  assert.equal(scriptPanel({ text: 'Hi', open: false }).open, false, 'closed by hand');
  assert.equal(scriptPanel({ text: 'word '.repeat(450), width: SCRIPT_SIDE_MIN }).line, '450 words · about 3 min');
  assert.equal(scriptPanel({ width: SCRIPT_SIDE_MIN - 1 }).place, 'below');
  assert.match(src('web/simple.css'), new RegExp(`@media \\(min-width: ${SCRIPT_SIDE_MIN}px\\) \\{\\n  \\.sx-rec\\[data-script=open\\]`), 'CSS and the panel agree on the width');
});

test('8: the Record page: preview, then its controls, then "Script (optional)"; the take records the preview’s streams', () => {
  const rp = src('web/simple-record.js');
  const at = (re) => { const m = re.exec(rp); assert.ok(m, String(re)); return m.index; };
  const pv = at(/<div class="sx-pv"/), ctl = at(/<div class="sx-rec-ctl"/), scr = at(/<aside class="sx-scr"/);
  assert.ok(pv < ctl && ctl < scr, 'at 375 px the page reads preview, controls, script');
  assert.match(rp, /Choose what to share…/);
  assert.match(rp, /data-a="screen" title="Pick another screen or window">Change</);
  assert.match(rp, /Script <span class="sub">\(optional\)<\/span>/);
  assert.match(rp, /Ask Claude to write one/);
  assert.match(rp, /rec\.previewOpen\(\{ camera: pl\.camera \? picks\.camera : 'none', mic: picks\.mic \}\)/);
  assert.match(rp, /await rec\.previewScreen\(\)/);
  assert.match(rp, /rec\.previewClose\(\)/);
  assert.match(rp, /<div class="rl-stage"><div class="rl-frame">/, 'B7’s live frame (rec-live, recorder.css)');
  const r = src('web/recorder.js');
  assert.match(r, /const pre = pv && dev === pv \? pv : null;/, 'quickRecord takes the preview’s streams: no second screen picker');
  assert.match(r, /if \(want\.screen && !d\.screen\) d\.screen = await pickScreen\(\);/);
  assert.match(src('web/simple-editor.js'), /recPage\.show\(page && rec\.session\(\)\.phase === 'idle'\);/);
  // While recording without a script: the live picture, not a blank timer (Audio only keeps the big timer).
  assert.match(rp, /sources !== 'audio' \? `<div class="vt-live"/);
  // Advanced's recorder is unchanged: its panel never opens the Simple preview.
  assert.match(r, /if \(S\.phase !== 'idle' \|\| panelOpen\) return pv;/);
});

// ---------- 9. Media in Simple ----------
test('9: Media lists the takes, dropped files and the music, each with a picture or icon, a name and a length', async () => {
  const { mediaRows } = await import('../web/simple-media.js');
  const rows = mediaRows({
    items: [{ id: '2026-10-26_10-00-00', canvas: true, take: true, picture: true, duration: 71, files: [{ file: '2026-10-26_10-00-00_webcam.mp4', role: 'camera' }] },
      { id: 'b-roll', name: 'b-roll.mov', canvas: false, take: false, picture: true, duration: 9, files: [{ file: 'b-roll.mov', role: 'video' }] }],
    dropped: [{ file: 'source/app shot.png', name: 'app shot.png', bytes: 120000, picture: true }, { file: 'source/notes.pdf', name: 'notes.pdf', bytes: 2000, picture: false }],
    music: [{ id: 'c1', file: 'work/music/calm-71s.m4a', label: 'Calm pad', duration: 71, gain: -6, t: 0 }],
  });
  assert.deepEqual(rows.map((r) => [r.kind, r.sub]), [['take', 'Your recording · 1:11'], ['clip', 'Clip · 0:09'], ['picture', 'Picture · 120 KB'], ['file', 'File · 2 KB'], ['music', 'Music under the video · 1:11']]);
  assert.deepEqual(rows[0].thumb, { video: 'source/2026-10-26_10-00-00_webcam.mp4' });
  assert.deepEqual(rows[2].thumb, { img: 'source/app shot.png' });
  assert.equal(rows[4].thumb, null);
  assert.equal(rows[1].name, 'b-roll.mov');
  const ed = src('web/simple-editor.js'), me = src('web/simple-media.js');
  assert.match(ed, /cardHost\.after\(media\.el\);/, 'collapsed under the step card, in Claude’s column');
  assert.match(me, /<details class="sx-media">/);
  assert.match(me, /actions\.deleteRecording\(r\.item, \{ recording: r\.item\.canvas \}\)/, 'a take: Media’s own delete (Remove from this video, or to the Bin)');
  assert.match(me, /media-drop-remove/);
  assert.match(me, /\['Undo', \(\) => actions\.restore\(x\.trash, r\.name\)\]/);
});

test('centre: on every step the video stays in the centre; thumbnails go in the card, scenes below the video', () => {
  const ed = src('web/simple-editor.js');
  assert.doesNotMatch(ed, /sx-over/, 'nothing covers the video');
  assert.match(ed, /if \(c\.extra === 'thumbs'\) extra \+= thumbsHTML\(\);/);
  assert.match(ed, /side\.append\(sceneList\)/, 'the scene list sits below the video, in the transcript’s place');
  assert.match(src('web/simple.css'), /\.project\.simple \.center \{ order: -1; \}/, 'narrow: the video first');
});

// ---------- a real server: music from Resources, a picture as a photo of you ----------
async function fakeClaude() {
  const { appendFileSync } = await import('node:fs');
  const { createInterface } = await import('node:readline');
  const argv = process.argv.slice(2);
  const out = (item) => process.stdout.write(JSON.stringify(item) + '\n');
  if (argv.includes('--version')) { console.log('9.9.9 fixture'); return; }
  if (argv[0] === 'auth') { console.log('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"fixture"}'); return; }
  let initialized = false;
  for await (const line of createInterface({ input: process.stdin })) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type !== 'user') continue;
    appendFileSync(process.env.OCTOPUS_TEST_LOG, JSON.stringify({ kind: 'message' }) + '\n');
    if (!initialized) { initialized = true; out({ type: 'system', subtype: 'init', session_id: `fixture-${process.pid}`, model: 'fixture-model' }); }
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixture reply.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
  }
}
const freePort = () => new Promise((done, fail) => {
  const s = createServer();
  s.once('error', fail);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
});
async function startServer(t) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-v1fu-srv-'));
  const app = join(base, 'app'), studioDir = join(base, 'studio'), home = join(base, 'home'), localDir = join(base, 'local'), bin = join(base, 'bin');
  for (const dir of [app, studioDir, home, localDir, bin]) mkdirSync(dir, { recursive: true });
  for (const dir of ['server', 'core', 'starter', 'web', 'bin']) cpSync(join(APP, dir), join(app, dir), { recursive: true });
  cpSync(join(APP, 'package.json'), join(app, 'package.json'));
  write(join(app, 'server/keychain.mjs'), `export const KEY_STORE = 'synthetic test fixture';
export async function readKey() { return null; }
export async function hasKey() { return false; }
export async function saveKey() { throw new Error('Fixture does not save credentials'); }
export async function removeKey() { throw new Error('Fixture does not remove credentials'); }
`);
  write(join(bin, 'claude.cmd'), 'unused npm shim fixture');
  write(join(bin, 'node_modules/@anthropic-ai/claude-code/package.json'), JSON.stringify({ type: 'module', bin: 'fixture.mjs' }));
  write(join(bin, 'node_modules/@anthropic-ai/claude-code/fixture.mjs'), `(${fakeClaude.toString()})().catch((e) => { console.error(e.stack); process.exitCode = 1; });\n`);
  const shell = join(base, 'fixture-shell');
  write(shell, `#!${process.execPath}\nprocess.stdout.write('__P__' + process.env.PATH + '__P__');\n`);
  if (process.platform !== 'win32') execFileSync('chmod', ['700', shell]);
  const port = await freePort(), logFile = join(base, 'agent.jsonl');
  write(join(localDir, 'settings.json'), JSON.stringify({
    studio: studioDir, setup: { done: true, agent: '' }, updates: { auto: false }, scheduleCatchUp: false, permissionMode: 'auto', help: { stepsIntro: 'dismissed' },
    claude: { engine: 'claude', lean: true, ccSource: 'plan' }, claudePath: join(bin, 'claude.cmd'),
  }));
  write(join(localDir, 'schedules.json'), '{"v":1,"schedules":[]}');
  write(logFile, '');
  const env = {
    PATH: [bin, dirname(process.execPath), process.env.PATH].join(process.platform === 'win32' ? ';' : ':'),
    HOME: home, USERPROFILE: home, SHELL: shell, TMPDIR: base, TMP: base, TEMP: base, STUDIO_LOCAL_DIR: localDir, STUDIO_NO_OPEN: '1', STUDIO_NO_SCHEDULES: '1',
    CLAUDE_CONFIG_DIR: join(home, '.claude'), HF_HUB_OFFLINE: '1', PORT: String(port), LC_ALL: 'C', OCTOPUS_TEST_LOG: logFile,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
  };
  execFileSync(process.execPath, ['--input-type=module', '-e', 'const {createStudio}=await import(process.argv[1]);createStudio(process.argv[2],{use:false});',
    new URL(`file://${join(app, 'server/starter.mjs').replaceAll('\\', '/').replace(/^(?=[A-Za-z]:)/, '/')}`).href, studioDir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const child = spawn(process.execPath, [join(app, 'server/index.mjs')], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (b) => { logs += b; });
  child.stderr.on('data', (b) => { logs += b; });
  const url = `http://127.0.0.1:${port}`;
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(100); }
    rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  });
  const req = async (path, data, raw = null) => {
    const opts = raw ? { method: 'POST', headers: { 'X-Studio': '1' }, body: raw }
      : data === undefined ? {} : { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
    const r = await fetch(url + path, opts);
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };
  const ok = async (path, data, raw) => { const r = await req(path, data, raw); assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}\n${logs.slice(-1500)}`); return r.body; };
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(`${url}/api/learning`)).ok) break; } catch {}
    await sleep(100);
  }
  return { studio: studioDir, url, req, ok, project: (id) => join(studioDir, 'projects', id) };
}

test('server: your music goes into Resources and plays as this video’s bed; a dropped picture can go in as a photo of you', async (t) => {
  const s = await startServer(t);
  const v = await s.ok('/api/projects', { untitled: true, shape: 'youtube' });
  const upload = (name, kind, bytes) => s.req(`/api/simple-resources/upload?${new URLSearchParams({ name, kind })}`, undefined, bytes);
  const song = wav();
  const up = await upload('My theme.wav', 'music', song);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.deepEqual([up.body.kind, up.body.line], ['music', 'Music for your videos']);
  assert.match((await upload('fake.wav', 'music', png(2, 2, () => [1, 2, 3]))).body.error, /doesn’t look like a \.wav/);
  assert.match((await upload('cover.png', 'music', png(2, 2, () => [1, 2, 3]))).body.error, /Music is an \.mp3/);
  assert.equal((await s.ok('/api/simple-resources')).files.find((f) => f.id === up.body.id).kind, 'music');

  // The Music tool's pick: copied under the video once, then an ordinary project cue.
  const bed = await s.ok(`/api/projects/${v.id}/simple-music`, { resource: up.body.id });
  assert.match(bed.file, /^work\/music\/[0-9a-f]{12}-My theme\.wav$/);
  assert.deepEqual(readFileSync(join(s.project(v.id), bed.file)), song, 'the same bytes');
  assert.equal((await s.ok(`/api/projects/${v.id}/simple-music`, { resource: up.body.id })).file, bed.file, 'reused');
  assert.equal(lf(readFileSync(join(s.project(v.id), 'WORKLOG.md'), 'utf8')).match(/Music from Resources: My theme\.wav/g).length, 1);
  const cue = await s.ok(`/api/projects/${v.id}/sfx`, { op: 'add', file: bed.file, from: 'project', t: 0, gain: -6, label: 'Music: My theme' });
  assert.ok(cue.id);
  assert.equal((await s.req(`/api/projects/${v.id}/simple-music`, { resource: 'no-such-file' })).status, 400);
  const pic = await upload('mug.png', 'product', png(3, 3, () => [9, 9, 9]));
  assert.match((await s.req(`/api/projects/${v.id}/simple-music`, { resource: pic.body.id })).body.error, /isn’t music/);
  assert.equal((await s.req('/api/projects/nope/simple-music', { resource: up.body.id })).status, 404);
  assert.match(lf(readFileSync(join(s.project(v.id), 'packaging', 'RESOURCES.md'), 'utf8')), /\*\*My theme\.wav\*\* \(Music/, 'Claude sees it too');

  // Also add to Resources with the answer to "Is this a photo of you?": Yes → a photo of you (used in thumbnails).
  const me = (await s.ok(`/api/projects/${v.id}/drop?name=${encodeURIComponent('me at my desk.png')}`, undefined, png(4, 4, (x) => [x * 40, 10, 10]))).file;
  assert.equal(dropAsks(me), true);
  const added = await s.ok(`/api/simple-resources/upload?${new URLSearchParams({ project: v.id, file: me, kind: 'photo' })}`, {});
  assert.deepEqual([added.kind, added.line], ['photo', 'Used in thumbnails']);
  assert.ok(existsSync(join(s.project(v.id), me)), 'the video keeps its own copy');
});

test('server: Media lists dropped files and the music; Delete with Undo; the command line puts music under the video', async (t) => {
  const s = await startServer(t);
  const v = await s.ok('/api/projects', { untitled: true, shape: 'youtube' });
  const base = `/api/projects/${v.id}`;
  const shot = (await s.ok(`${base}/drop?name=${encodeURIComponent('app shot.png')}`, undefined, png(4, 4, () => [5, 5, 5]))).file;
  let m = await s.ok(`${base}/media-items`);
  assert.deepEqual(m.dropped.map((f) => [f.file, f.picture]), [[shot, true]]);
  assert.deepEqual(m.music, []);
  // Delete: to the studio's trash, and Undo brings it back.
  const gone = await s.ok(`${base}/media-drop-remove`, { file: shot });
  assert.ok(gone.trash);
  assert.equal(existsSync(join(s.project(v.id), shot)), false);
  assert.deepEqual((await s.ok(`${base}/media-items`)).dropped, []);
  await s.ok(`${base}/media-restore`, { trash: gone.trash });
  assert.ok(existsSync(join(s.project(v.id), shot)), 'back');
  for (const bad of ['project.json', 'source/../project.json', 'source/missing.png']) assert.notEqual((await s.req(`${base}/media-drop-remove`, { file: bad })).status, 200, bad);

  // Music by the command line (what Claude runs in Simple): the creator's own music from Resources.
  const up = await s.req(`/api/simple-resources/upload?${new URLSearchParams({ name: 'Theme.wav', kind: 'music' })}`, undefined, wav());
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const cli = (...args) => execFileSync(process.execPath, [join(APP, 'bin', 'octopus.mjs'), ...args], { env: { ...process.env, STUDIO_URL: s.url }, encoding: 'utf8' });
  assert.match(cli('music', v.id, '--resource', up.body.id), /Music under the video: Theme\.wav \(-6 dB\)/);
  m = await s.ok(`${base}/media-items`);
  assert.deepEqual(m.music.map((x) => [x.label, x.gain]), [['Theme.wav', -6]]);
  assert.equal((await s.ok(base)).simpleTools.music.resource, up.body.id);
  cli('music', v.id, '--resource', up.body.id, '--gain', '-9');
  assert.deepEqual((await s.ok(`${base}/media-items`)).music.map((x) => x.gain), [-9], 'replaced, not stacked');
  assert.match(cli('music', v.id, 'off'), /No music/);
  assert.deepEqual((await s.ok(`${base}/media-items`)).music, []);
});

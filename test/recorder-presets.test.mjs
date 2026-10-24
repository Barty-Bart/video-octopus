// Record's sources from the style's setup (web/rec-preset.js, server/browser-recorder.mjs recorderChoices): a faceless
// style starts with the camera off and the screen on, a camera-only one (Short) with no screen, an on-camera one with
// both; a format's own "record" goes over its setup's; what the creator picks is remembered per style (or per setup
// when the video has no style) and the next Record with that style starts the same way; other styles keep theirs.
// Plus the panel's words and its Screen On / Off control. A throwaway studio and settings folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'vo-rec-preset-'));
const studio = join(tmp, 'studio');
process.env.STUDIO_LOCAL_DIR = join(tmp, 'local');
mkdirSync(process.env.STUDIO_LOCAL_DIR, { recursive: true });
mkdirSync(join(studio, 'recordings'), { recursive: true });
writeFileSync(join(process.env.STUDIO_LOCAL_DIR, 'settings.json'), JSON.stringify({ studio, recorder: { screen: 'none', camera: 'cam-1', mic: 'mic-1' } }));
const project = (id, type) => {
  mkdirSync(join(studio, 'projects', id, 'source'), { recursive: true });
  writeFileSync(join(studio, 'projects', id, 'project.json'), JSON.stringify({ name: id, type }));
};
for (const [id, type] of [['face', 'tutorial'], ['voice', 'faceless'], ['reel', 'short'], ['demo', 'explainer'], ['old', null]]) project(id, type);

let P, rec;
before(async () => {
  P = await import('../web/rec-preset.js');
  rec = await import('../server/browser-recorder.mjs');
});
after(() => rmSync(tmp, { recursive: true, force: true }));

async function startTake(id, choices, style = null) {
  let out = null;
  await rec.recRoute({ method: 'POST' }, {}, { id, action: '/rec-start', url: new URL('http://127.0.0.1/'), send: (_r, code, body) => { out = { code, body }; },
    emit() {}, receiveTake() {}, style: () => style,
    body: async () => ({ kind: choices.screen === 'screen' ? 'screen' : 'camera', target: 'replace', tracks: { screen: { mime: 'video/webm' }, webcam: { mime: 'video/webm' } }, choices: { mic: 'mic-1', countdown: 3, ...choices } }) });
  assert.equal(out.code, 200, JSON.stringify(out.body));
  return out.body;
}

test('each setup’s sources: on camera, faceless, short, explainer; a format’s own record goes over it', () => {
  assert.deepEqual(P.presetSources('tutorial'), { screen: true, camera: true, words: 'screen and camera' });
  assert.deepEqual(P.presetSources('faceless'), { screen: true, camera: false, words: 'screen and voice, no camera' });
  assert.deepEqual(P.presetSources('short'), { screen: false, camera: true, words: 'camera only, no screen' });
  assert.equal(P.presetSources('explainer').camera, true);
  assert.deepEqual(P.presetSources('my-studio-format', { camera: false }), { screen: true, camera: false, words: 'screen and voice, no camera' }, 'unknown setups start as on camera; record.camera false wins');
  assert.deepEqual(P.presetSources('tutorial', { screen: false }), { screen: false, camera: true, words: 'camera only, no screen' });
  assert.equal(P.presetSources('short', { camera: 'yes' }).camera, true, 'only true/false count');
});

test('the start: the preset (with Settings’ camera device) unless this style remembered its own', () => {
  const face = P.presetSources('faceless');
  assert.deepEqual(P.startSources(face, null, 'cam-1'), { screen: 'screen', camera: 'none', remembered: false });
  assert.deepEqual(P.startSources(P.presetSources('tutorial'), null, 'cam-1'), { screen: 'screen', camera: 'cam-1', remembered: false });
  assert.deepEqual(P.startSources(P.presetSources('tutorial'), null, 'none'), { screen: 'screen', camera: 'default', remembered: false }, 'a camera on needs a device');
  assert.deepEqual(P.startSources(face, { screen: 'none', camera: 'cam-2' }), { screen: 'none', camera: 'cam-2', remembered: true });
  assert.equal(P.startSources(face, { screen: 'weird', camera: 1 }).remembered, false, 'an odd memory is ignored');
});

test('recorderChoices: a faceless video starts with the camera off, a Short with no screen, whatever Settings says', () => {
  const c = (id) => rec.recorderChoices(id);
  assert.deepEqual([c('voice').screen, c('voice').camera], ['screen', 'none']);
  assert.deepEqual([c('reel').screen, c('reel').camera], ['none', 'cam-1']);
  assert.deepEqual([c('face').screen, c('face').camera], ['screen', 'cam-1'], 'Settings’ screen “none” doesn’t hide the screen of an on-camera style');
  assert.deepEqual([c('demo').screen, c('demo').camera], ['screen', 'cam-1']);
  assert.deepEqual([c('old').screen, c('old').camera], ['screen', 'cam-1'], 'a video without a setup: as on camera');
  assert.equal(c('voice').mic, 'mic-1', 'the mic stays Settings’');
  assert.equal(c('voice').preset.words, 'screen and voice, no camera');
  assert.equal(c('voice').preset.key, 'setup:faceless');
});

test('a change is remembered for the style: the next Record with it starts the same way; other styles keep theirs', async () => {
  const faceless = { key: 'style:faceless-channel', name: 'Faceless channel' };
  const onCam = { key: 'style:talking', name: 'Talking head' };
  assert.equal(rec.recorderChoices('voice', faceless).preset.style, 'Faceless channel');
  assert.equal(rec.recorderChoices('voice', faceless).preset.remembered, false);
  // In the faceless style the creator turns the camera on (a second camera) and records.
  await startTake('voice', { screen: 'screen', camera: 'cam-2' }, faceless);
  const again = rec.recorderChoices('voice', faceless);
  assert.deepEqual([again.screen, again.camera, again.preset.remembered], ['screen', 'cam-2', true]);
  assert.equal(rec.recorderChoices('face', onCam).camera, 'cam-1', 'another style keeps its own (and the faceless pick isn’t the device for every style)');
  // In the on-camera style: camera only, no screen.
  await startTake('face', { screen: 'none', camera: 'cam-3' }, onCam);
  assert.deepEqual([rec.recorderChoices('face', onCam).screen, rec.recorderChoices('face', onCam).camera], ['none', 'cam-3']);
  assert.equal(rec.recorderChoices('voice', faceless).camera, 'cam-2', 'faceless still has its own');
  // Videos without a style: their setup's memory.
  await startTake('reel', { screen: 'screen', camera: 'none' });
  assert.deepEqual([rec.recorderChoices('reel').screen, rec.recorderChoices('reel').camera], ['screen', 'none']);
  const st = JSON.parse(readFileSync(join(process.env.STUDIO_LOCAL_DIR, 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(st.recStyles).sort(), ['setup:short', 'style:faceless-channel', 'style:talking']);
  // An odd key never names the memory.
  assert.equal(rec.recorderChoices('voice', { key: '../x', name: 'x' }).preset.key, 'setup:faceless');
});

test('the panel: the preset line, and Screen as On / Off with Choose window… only when it’s on', () => {
  const recjs = readFileSync(new URL('../web/recorder.js', import.meta.url), 'utf8');
  assert.match(recjs, /id="scrOnOff" role="radiogroup"/);
  assert.match(recjs, /id="scrOn">On<\/button><button type="button" role="radio" id="scrNone">Off/);
  assert.match(recjs, /\$\('#scrPick', page\)\.hidden = !on;/);
  assert.match(recjs, /Choose window…/);
  assert.doesNotMatch(recjs, /Pick a screen…<\/button>/, 'the old two-button control is gone');
});

test('the preset line’s words', async () => {
  const src = readFileSync(new URL('../web/recorder.js', import.meta.url), 'utf8');
  const fn = /export function presetLine\(p\) \{[\s\S]*?\n\}/.exec(src)[0].replace('export ', '');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const presetLine = new Function('esc', `${fn}; return presetLine;`)(esc);
  assert.match(presetLine({ style: 'Faceless <b>', words: 'screen and voice, no camera', remembered: false }), /Set up for <b>Faceless &lt;b&gt;<\/b>: screen and voice, no camera\./);
  assert.match(presetLine({ style: null, words: 'camera only, no screen', remembered: false }), /Set up for this video’s setup: camera only/);
  assert.match(presetLine({ style: 'Talking head', remembered: true }), /As you last recorded with <b>Talking head<\/b>\./);
  assert.equal(presetLine(null), '');
});

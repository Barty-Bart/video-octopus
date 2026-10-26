// Rotoscoping inside Build (V1 spec §7, Decision 6: "Roto runs in Build only for scenes that need it; if unavailable,
// the scene falls back with a Set up link").
//
// The plan flags the scenes that need their subject cut out (production sheet `cutout: true`, `cutout_subject`; the
// rules are web/cutout.js). When a Build step's brief goes out (index.mjs startStep), prepareRoto():
//   1. finds the flagged scenes in that step's scope (server/build-progress.mjs scopeOf), and with none adds nothing;
//   2. checks whether object separation can run here, without loading a model or downloading anything: the selected
//      Python imports torch, torchvision, transformers' Sam2VideoModel, numpy and Pillow (python-environments.mjs
//      probePython verify, offline), and a SAM 2.1 model is in the Hugging Face cache (the one picked in Settings, or
//      any for auto: the skill falls back to a downloaded one);
//   3. writes what it found to work/cutouts.json ({ at, step, ready, why, model, scenes }), which Video Octopus owns, so
//      a scene built while it wasn't ready shows "Built without the cutout · Set up" even if the builder says nothing;
//   4. returns the note for the brief: separate those scenes only, on their time range, mark them `cutting` while it
//      runs and record the result (`sheet.py cutout … done|skipped`), or, when not ready, build them with the plain
//      layout and record them skipped. Never download or install during Build: the model comes only from Setup's own
//      Download (server/hfmodels.mjs), which the creator presses.
import { join } from 'node:path';
import { readJSON, writeJSON, python } from './util.mjs';
import { probePython } from './python-environments.mjs';
import { sam2Have } from './sam2.mjs';
import { section } from './settings.mjs';
import { scopeOf } from './build-progress.mjs';
import { needsCutout, subjectOf, cutoutOf, whyText } from '../web/cutout.js';

export const CUTOUTS = 'work/cutouts.json';
const SHEET = 'work/production.json';
const HELPER = 'python3 ../../.claude/skills/production-sheet/scripts/sheet.py';
// The Python the check found ready (the selected one, $STUDIO_PYTHON, else the studio's): the skill runs with it.
const objsep = (py) => `"${String(py || 'python3').replaceAll('\\', '/')}" ../../.claude/skills/object-separation/scripts/objsep.py`;
const PACKAGES = ['torch', 'torchvision', 'transformers', 'numpy', 'Pillow'];

const rawScenes = (dir) => {
  const p = readJSON(join(dir, SHEET), null);
  return Array.isArray(p?.scenes) ? p.scenes.filter((s) => s && s.id != null).slice().sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0)) : [];
};
const sec = (x) => (Number(x) || 0).toFixed(2);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'speaker';
// The folder the skill writes a scene's masks to (objsep.py separate --name): one per scene, so scenes never share one.
export const maskName = (s) => `scene${slug(s.id)}-${slug(subjectOf(s))}`;

// The flagged scenes a Build step builds: [{ s, n }] (n: the scene's number in the sheet), in sheet order.
export function cutoutScenes(dir, scope = null) {
  const scenes = rawScenes(dir);
  const inScope = new Set(scopeOf(dir, scenes, scope));
  return scenes.map((s, i) => ({ s, n: i + 1 })).filter(({ s }) => inScope.has(String(s.id)) && needsCutout(s));
}

// ---- can object separation run here? ----
// The import check takes a few seconds (torch), so its answer is kept for five minutes per Python.
const probes = new Map(); // python path -> { at, r }
const TTL = 5 * 60e3;
export const clearRotoCache = () => probes.clear();

// { ready, why: null | no-python | no-packages | no-model, text, python, model }
//   opts: python (path), probe (probePython's shape), have (downloaded sizes), choice (Settings › Object separation).
export async function rotoReadiness({ python: py = python(), probe = probePython, have = null, choice = null, now = Date.now() } = {}) {
  let hit = probes.get(py);
  if (!hit || now - hit.at > TTL) { hit = { at: now, r: await probe(py, { verify: true }).catch((e) => ({ error: e.message })) }; probes.set(py, hit); }
  const r = hit.r || {};
  const out = (why, extra = {}) => ({ ready: !why, why, text: why ? whyText(why) : '', python: py, ...extra });
  if (r.error || !r.imports) return out('no-python');
  const missing = PACKAGES.filter((p) => r.imports[p] !== true);
  if (missing.length || r.sam2 !== true) return out('no-packages', { missing: missing.length ? missing : ['transformers 4.56+ (SAM 2\'s video model)'] });
  const got = have || sam2Have();
  const pick = choice || section('objsep').model || 'auto';
  if (pick === 'auto' ? !got.length : !got.includes(pick)) return out('no-model', { model: pick === 'auto' ? null : pick, have: got });
  return out(null, { model: pick === 'auto' ? got[0] : pick, auto: pick === 'auto', have: got });
}

// ---- the note for the Build brief ----
const list = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const what = ({ s, n }) => `scene ${n}${String(s.id) !== String(n) ? ` (id ${s.id})` : ''}, ${sec(s.start)}–${sec(s.end)} s: ${subjectOf(s)}`;

export function rotoNote(flagged, ready) {
  if (!flagged.length) return '';
  const ids = flagged.map(({ s }) => String(s.id));
  const head = `\nCutouts: ${flagged.length === 1 ? 'one scene needs' : `${flagged.length} scenes need`} the subject cut out of the background (production sheet "cutout"): ${flagged.map(what).join('; ')}.`;
  if (!ready.ready) {
    const code = ready.why || 'failed';
    return `${head} Object separation can't run on this computer yet (${ready.text.replace(/\.$/, '')}). Don't install, download or ask about it now: build ${flagged.length === 1 ? 'that scene' : 'those scenes'} with the plain layout (the subject as filmed, the graphic beside it or over it, not behind it), and record each with \`${HELPER} cutout work/production.json skipped <scene id> --why ${code}\` (${list(ids)}). Video Octopus shows the creator "Built without the cutout · Set up" on ${flagged.length === 1 ? 'it' : 'them'}.`;
  }
  const OBJSEP = objsep(ready.python);
  const model = `SAM 2.1${ready.model ? ` ${ready.model}` : ''} is downloaded${ready.auto ? ' (Settings: auto, so the skill takes the size recommended for this computer when it is there, else this one)' : ''}`;
  return `${head} Object separation is ready here (the selected Python imports SAM 2's video model; ${model}). Cut out these scenes only, and only their own time range, each just before you build it:
1. \`${HELPER} mark work/production.json cutting <scene id>\` (Video Octopus shows "Cutting you out for scene <n>…").
2. With the object-separation skill, on the video the scene is built on (the locked cut's render, the sheet's timeline): \`${OBJSEP} preview <video> --at <scene start>\`, pick the points, then \`${OBJSEP} separate <video> --name <mask name> --start <scene start> --end <scene end> --point …\`, and look at its \`sheet\` before going on. Mask names: ${flagged.map(({ s, n }) => `scene ${n} → ${maskName(s)}`).join(', ')}.
3. \`${HELPER} cutout work/production.json done <scene id> --masks work/objsep/<mask name>\`, then \`… mark work/production.json building <scene id>\`, build the scene with those masks (\`objsep.py behind\`, or alphamerge in your own compositing) and \`… mark work/production.json built <scene id>\`.
If separation fails, don't stop the build: build that scene with the plain layout, record \`${HELPER} cutout work/production.json skipped <scene id> --why failed\` and say so in one line. Never download a model or install packages during Build: the creator does that in Setup.`;
}

// When a Build step starts: the flagged scenes in its scope, whether object separation can run, work/cutouts.json and
// the note for the brief ('' for a step that isn't a Build or builds no flagged scene). opts go to rotoReadiness.
export async function prepareRoto(dir, step, opts = {}) {
  if (!dir || !step || step.stage !== 'Build' || (step.kind && step.kind !== 'claude')) return { note: '', ready: null, flagged: [] };
  const flagged = cutoutScenes(dir, step.scenes || null);
  if (!flagged.length) return { note: '', ready: null, flagged };
  const ready = await rotoReadiness(opts);
  writeJSON(join(dir, CUTOUTS), { at: new Date().toISOString(), step: step.id, ready: ready.ready, why: ready.why, model: ready.model || null, scenes: flagged.map(({ s }) => String(s.id)) });
  return { note: rotoNote(flagged, ready), ready, flagged };
}

// For the project view (the dock, Simple's Build card, Scenes): every flagged scene's cutout, or null when the sheet
// flags none. { ready, why, scenes: [{ id, n, subject, state, why, text }] }
export function cutoutSummary(dir) {
  const scenes = rawScenes(dir);
  if (!scenes.some(needsCutout)) return null;
  const doc = readJSON(join(dir, CUTOUTS), null);
  const out = scenes.map((s, i) => { const c = cutoutOf(s, doc); return c && { id: String(s.id), n: i + 1, ...c }; }).filter(Boolean);
  return { ready: doc ? doc.ready !== false : null, why: doc?.why || null, scenes: out };
}
// A scene's cutout from the sheet as written (for scenes.mjs readProduction), with the doc read once by the caller.
export const cutoutDoc = (dir) => readJSON(join(dir, CUTOUTS), null);

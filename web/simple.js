// Simple mode (V1 "ultra simple", handoff v1-simple-2026-10-26/SPEC.md; one-editor §0): the pure parts both the server
// and the page use. No DOM and no state here: the mode itself is web/mode.js (isAdvanced()) on the page and
// server/settings.mjs (editorMode, isAdvanced) on the server.
//
// - SHAPES: the three built-in formats a Simple video starts as (Projects › + New video ▾), each a format of the hidden
//   built-in style (server/learning-store.mjs builtinProfile / builtinFormats) on one of core/pipelines.json's video
//   setups: YouTube video → tutorial (16:9), Reel or Short → short (9:16), Audio only → audio (no picture).
// - SIMPLE_STEPS / simpleSteps / simpleProgress: the six steps Simple's editor shows (Record · Rough cut · Scenes ·
//   Build · Thumbnail · Download), mapped onto a format's pipeline steps by their stage. Audio only skips Scenes and
//   Build (its format has no Plan or Build step).
// - HIDDEN_PAGES / hiddenInSimple: the shell pages Simple hides (their routes stay): a deep link lands on Projects.

export const EDITOR_MODES = ['simple', 'advanced'];
export const DEFAULT_MODE = 'simple';

// key: what the page and POST /api/projects { shape } call it; type: the pipeline video setup; name: the built-in
// format's name (also its label in the New video menu); sub: the menu's second line; chip: the editor's shape chip.
export const SHAPES = {
  youtube: { key: 'youtube', type: 'tutorial', name: 'YouTube video', sub: 'Long form · 16:9', aspect: '16:9', chip: 'YouTube · 16:9', kind: 'YouTube', sources: 'camera-screen' },
  reel: { key: 'reel', type: 'short', name: 'Reel or Short', sub: 'Vertical · 9:16', aspect: '9:16', chip: 'Reel · 9:16', kind: 'Reel', sources: 'camera' },
  audio: { key: 'audio', type: 'audio', name: 'Audio only', sub: 'Voice, podcast or narration · no picture needed', aspect: null, chip: null, kind: 'Audio', sources: 'audio' },
};
export const SHAPE_KEYS = Object.keys(SHAPES);
// The two shapes the editor's chip switches between (Audio only has no chip).
export const SWITCHABLE = ['youtube', 'reel'];
export const isShape = (key) => SHAPE_KEYS.includes(key);

// A project's shape from its video setup: a Short is a Reel, Audio only is audio, every other setup (tutorial,
// faceless, explainer, a studio's own) is 16:9 and counts as YouTube.
export function shapeOfType(type) {
  if (type === 'short' || type === 'reel') return 'reel';
  if (type === 'audio') return 'audio';
  return 'youtube';
}

// The six Simple steps and the pipeline stages each one covers (core/pipelines.json stages: Package, Record, Cut,
// Plan, Build, Polish). Polish (Review scenes, zooms, the post kit) is folded into Build and Download in Simple
// (one-editor §0.3); Download is the export, not a pipeline step.
export const SIMPLE_STEPS = [
  { id: 'record', label: 'Record', stages: ['Record'] },
  { id: 'rough-cut', label: 'Rough cut', stages: ['Cut'] },
  { id: 'scenes', label: 'Scenes', stages: ['Plan'] },
  { id: 'build', label: 'Build', stages: ['Build'] },
  { id: 'thumbnail', label: 'Thumbnail', stages: ['Package'], optional: true },
  { id: 'download', label: 'Download', stages: [] },
];

// A format's six Simple steps with the pipeline step ids each one runs, from the format's steps
// ([{ id, stage, optional }], as /api/status formatInfo[type].steps or /api/projects/<id> pipeline.steps give them).
// A Simple step that needs a stage the format doesn't have (Audio only: Plan, Build) is skipped. Optional pipeline
// steps (Fix the cut) are listed apart: Simple runs only `run`, the creator reaches the rest by asking Claude.
//   simpleSteps([{ id: 'import', stage: 'Record' }, ...]) → [{ id: 'record', label, run: ['import'], extra: [], skipped }, ...]
export function simpleSteps(formatSteps = []) {
  return SIMPLE_STEPS.map((s) => {
    const mine = formatSteps.filter((x) => s.stages.includes(x.stage));
    const run = mine.filter((x) => !x.optional || s.optional).map((x) => x.id);
    const extra = mine.filter((x) => x.optional && !s.optional).map((x) => x.id);
    const skipped = s.id !== 'download' && mine.length === 0;
    return { id: s.id, label: s.label, optional: Boolean(s.optional), run, extra, skipped };
  });
}

// Where a project is on the six steps, from its pipeline status (/api/projects/<id> pipeline: { steps: [{ id, stage,
// done, optional, skipped }] }) and whether a final video exists (exported). Each step: state done | current | todo |
// skipped. The current step is the first one not done and not skipped; Thumbnail is optional, so a project past it
// (Download current) can still pick a thumbnail. Returns { steps, current } (current: the step id, null when done).
export function simpleProgress(pipeline, { exported = false } = {}) {
  const steps = simpleSteps(pipeline?.steps || []);
  const byId = new Map((pipeline?.steps || []).map((x) => [x.id, x]));
  const doneOf = (s) => {
    if (s.id === 'download') return Boolean(exported);
    if (s.skipped) return true;
    return s.run.length > 0 && s.run.every((id) => byId.get(id)?.done || byId.get(id)?.skipped);
  };
  let current = null;
  const out = steps.map((s) => {
    const done = doneOf(s);
    let state = s.skipped ? 'skipped' : done ? 'done' : 'todo';
    if (!current && state === 'todo' && !s.optional) { current = s.id; state = 'current'; }
    return { ...s, done, state };
  });
  // An optional step left behind (Thumbnail not picked) while a later one is current: it stays todo, not current.
  return { steps: out, current };
}

// A project tile's middle word in Simple ("YouTube · Rough cut · 2 h ago") from /api/projects' pipeline stage name
// (Package, Record, Cut, Plan, Build, Polish), or "done".
export function simpleStageOf(p) {
  if (!p?.type) return 'Earlier edit';
  if (!p.stage) return p.progress && !p.next ? 'done' : 'Record';
  const step = SIMPLE_STEPS.find((s) => s.stages.includes(p.stage));
  if (p.stage === 'Polish') return 'Download';
  return step ? step.label : p.stage;
}

// Shell pages hidden in Simple (their code and routes stay; Advanced shows them). parseRoute's page names (web/nav.js).
export const HIDDEN_PAGES = ['recordings', 'skills', 'scheduled', 'library', 'styles', 'style', 'kit'];
// The shell pages Simple shows.
export const SIMPLE_PAGES = ['projects', 'resources'];
// Is this route's page hidden in this mode? route: parseRoute(hash) ({ page }).
export const hiddenInSimple = (route, mode = DEFAULT_MODE) => mode !== 'advanced' && HIDDEN_PAGES.includes(route?.page);
// The one quiet line a hidden deep link lands with on Projects.
export const ADVANCED_NOTE = 'That’s in Advanced mode (Settings › General).';

// ---- Settings' words in Simple (V1 follow-ups) ----
// Settings › General › Editor mode's line, and Settings › Updates' words, in Simple mode: they name nothing Simple
// hides (no My styles, no skills or skill preferences). Advanced keeps its own words (web/settings.js, web/updates.js).
export const editorModeText = (mode = DEFAULT_MODE) => (mode === 'advanced'
  ? 'Simple shows Projects and Resources and makes every video in a few steps. Advanced brings back My styles, brand kits, skills, the library, schedules and recordings. Nothing is lost when you switch.'
  : 'Simple shows Projects and Resources, and Claude makes every video with you in a few steps. Advanced shows every tool and page, for editing each part by hand. Nothing is lost when you switch.');
export const SIMPLE_UPDATES = {
  section: 'New versions of Video Octopus, and opening Video Octopus when you log in.',
  copy: 'Your projects, recordings and Resources stay as they are when the app updates.',
  update: 'Update the app',
  restart: 'Restart to finish the update.',
  restartByHand: 'Restart using your original launch method to finish the update.',
  ready: 'The new version is ready.',
  busy: 'Finish the current work before updating',
  fetch: 'Fetch the new version of the app. When launched with start.sh or start.cmd, the app restarts to finish the update after current work is idle.',
  starter: 'Updates the instructions and templates your studio started with. Your projects, recordings and Resources are left alone.',
};

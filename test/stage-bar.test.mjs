// The editor's stage bar is its navigation (ADDENDUM-stage-bar.md): each stage opens its pane, the address carries the
// stage (#/p/<id>?stage=cut), the old ?tab= addresses and the old remembered tab land on the matching stage, and the
// last stage used in a project is remembered (web/stages.js). The page wiring is checked from the source as well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STAGE_ORDER, STAGE_PANE, PANE_WORDS, paneOfTab, stageOfTab, stageFromSlug, stagesOf, parseProjectHash, stageHash,
  landingStage, rememberStage, recallStage, recallLegacyTab, stageKey, stageForPane, firstNotedScene,
} from '../web/stages.js';

const PIPELINES = JSON.parse(readFileSync(new URL('../core/pipelines.json', import.meta.url), 'utf8'));

// A Storage stand-in.
function store(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

test('every stage opens the pane in the spec', () => {
  assert.deepEqual(STAGE_PANE, {
    Package: 'packaging', Record: 'canvas', Cut: 'cut', Plan: 'scenes', Build: 'canvas', Polish: 'scenes', Publish: 'publish',
  });
  assert.deepEqual(STAGE_ORDER, ['Package', 'Record', 'Cut', 'Plan', 'Build', 'Polish', 'Publish']);
  // The pipeline's stages are the same six (Publish is the UI's own), and every pane has its toolbar words.
  assert.deepEqual(PIPELINES.stages.map((s) => s.name), STAGE_ORDER.slice(0, 6));
  for (const pane of new Set(Object.values(STAGE_PANE))) assert.ok(PANE_WORDS[pane]?.name && PANE_WORDS[pane]?.about, pane);
});

test('the old tabs map to their pane and their stage', () => {
  assert.equal(paneOfTab('renders'), 'publish');
  assert.equal(paneOfTab('post'), 'publish');
  for (const t of ['packaging', 'canvas', 'scenes', 'cut', 'publish']) assert.equal(paneOfTab(t), t);
  assert.equal(paneOfTab('nowhere'), null);
  const rows = [['packaging', 'Package'], ['canvas', 'Build'], ['scenes', 'Plan'], ['cut', 'Cut'], ['renders', 'Publish'], ['post', 'Publish']];
  for (const [tab, stage] of rows) assert.equal(stageOfTab(tab), stage, tab);
  // The canvas before any take is Record.
  assert.equal(stageOfTab('canvas', { hasTake: false }), 'Record');
  assert.equal(stageOfTab('nowhere'), null);
});

test('every Show me tab in the pipelines opens a pane the stages reach', () => {
  const panes = new Set(Object.values(STAGE_PANE));
  const shows = [];
  const walk = (x) => { if (x && typeof x === 'object') { if (x.show?.tab) shows.push(x.show.tab); Object.values(x).forEach(walk); } };
  walk(PIPELINES);
  assert.ok(shows.length > 5);
  for (const t of shows) assert.ok(panes.has(paneOfTab(t)), t);
});

test('a project shows its pipeline stages plus Publish; without a format, every stage', () => {
  const pipeline = { stages: [{ name: 'Record', steps: ['import'] }, { name: 'Cut', steps: ['prepare'] }, { name: 'Plan', steps: [] }] };
  assert.deepEqual(stagesOf(pipeline).map((s) => s.name), ['Record', 'Cut', 'Plan', 'Publish']);
  assert.equal(stagesOf(pipeline).at(-1).ui, true);
  assert.deepEqual(stagesOf(pipeline).at(-1).steps, []);
  assert.deepEqual(stagesOf(null).map((s) => s.name), STAGE_ORDER);
  assert.ok(stagesOf(null).every((s) => Array.isArray(s.steps) && !s.steps.length));
});

test('the stage is in the project address, and ?tab= addresses still parse', () => {
  assert.equal(stageHash('demo', 'Cut'), '#/p/demo?stage=cut');
  assert.equal(stageHash('a b/c', 'Publish'), '#/p/a%20b%2Fc?stage=publish');
  // An old ?tab= goes, other keys stay.
  assert.equal(stageHash('demo', 'Plan', new URLSearchParams('tab=scenes&x=1')), '#/p/demo?x=1&stage=plan');
  const p = parseProjectHash('#/p/a%20b%2Fc?stage=cut');
  assert.equal(p.id, 'a b/c');
  assert.equal(p.query.get('stage'), 'cut');
  assert.equal(parseProjectHash('#/p/demo').id, 'demo');
  assert.equal(parseProjectHash('#/p/demo').query.toString(), '');
  assert.equal(parseProjectHash('#/settings'), null);
  assert.equal(parseProjectHash('#/projects?x=1'), null);
  assert.equal(stageFromSlug('POLISH'), 'Polish');
  assert.equal(stageFromSlug('nowhere'), null);
  assert.equal(stageFromSlug('package', ['Record', 'Cut']), null);
});

test('where a project opens: ?stage=, then ?tab=, then the last stage, then the old tab, then the next step', () => {
  const names = STAGE_ORDER;
  const q = (s) => new URLSearchParams(s);
  assert.equal(landingStage({ query: q('stage=cut'), remembered: 'plan', legacyTab: 'renders', next: 'Build', names }), 'Cut');
  assert.equal(landingStage({ query: 'stage=publish', names }), 'Publish');
  // Old ?tab= routes, each one.
  const tabs = [['packaging', 'Package'], ['canvas', 'Build'], ['scenes', 'Plan'], ['cut', 'Cut'], ['renders', 'Publish'], ['post', 'Publish']];
  for (const [tab, stage] of tabs) assert.equal(landingStage({ query: q(`tab=${tab}`), remembered: 'polish', names }), stage, tab);
  assert.equal(landingStage({ query: q('tab=canvas'), names, hasTake: false }), 'Record');
  // ?stage= wins over ?tab=; an unknown one is passed over.
  assert.equal(landingStage({ query: q('stage=cut&tab=post'), names }), 'Cut');
  assert.equal(landingStage({ query: q('stage=nowhere'), remembered: 'plan', names }), 'Plan');
  // The last stage used here.
  assert.equal(landingStage({ query: q(''), remembered: 'polish', legacyTab: 'cut', next: 'Build', names }), 'Polish');
  // The old remembered tab (lastTab): canvas → Build, or Record with no take; renders/post → Publish.
  assert.equal(landingStage({ legacyTab: 'canvas', next: 'Cut', names }), 'Build');
  assert.equal(landingStage({ legacyTab: 'canvas', next: 'Cut', names, hasTake: false }), 'Record');
  assert.equal(landingStage({ legacyTab: 'post', next: 'Cut', names }), 'Publish');
  assert.equal(landingStage({ legacyTab: 'packaging', next: 'Cut', names }), 'Package');
  // Nothing remembered: the next step's stage, else Publish when everything is done, else Build / Record.
  assert.equal(landingStage({ next: 'Cut', names }), 'Cut');
  assert.equal(landingStage({ allDone: true, names }), 'Publish');
  assert.equal(landingStage({ names, hasTake: false }), 'Record');
  assert.equal(landingStage({ names }), 'Build');
  // A format without Package: a remembered Package (or ?stage=package) is passed over.
  const noPkg = STAGE_ORDER.filter((n) => n !== 'Package');
  assert.equal(landingStage({ query: q('stage=package'), remembered: 'package', legacyTab: 'packaging', next: 'Record', names: noPkg }), 'Record');
});

test('the last stage is remembered per project', () => {
  const s = store();
  assert.equal(recallStage(s, 'a'), null);
  rememberStage(s, 'a', 'Cut');
  rememberStage(s, 'b', 'Publish');
  assert.equal(recallStage(s, 'a'), 'cut');
  assert.equal(recallStage(s, 'b'), 'publish');
  assert.equal(s.map.get(stageKey('a')), 'cut');
  assert.equal(landingStage({ remembered: recallStage(s, 'a'), next: 'Build' }), 'Cut');
  // Storage that throws (private windows, blocked site data) is no stage, not an error.
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.doesNotThrow(() => rememberStage(broken, 'a', 'Cut'));
  assert.equal(recallStage(broken, 'a'), null);
  assert.equal(recallStage(null, 'a'), null);
  // The old tab row's memory, from sessionStorage or localStorage; anything else is ignored.
  assert.equal(recallLegacyTab([store({ 'studio.tab.a': 'renders' })], 'a'), 'renders');
  assert.equal(recallLegacyTab([store(), store({ 'studio.tab.a': 'cut' })], 'a'), 'cut');
  assert.equal(recallLegacyTab([store({ 'studio.tab.a': 'weird' })], 'a'), null);
  assert.equal(recallLegacyTab([broken], 'a'), null);
});

test('a pane switch keeps the stage that already shows it, or takes the step\'s own stage', () => {
  const names = STAGE_ORDER;
  // Something opens the canvas while you're on Record: Record stays selected.
  assert.equal(stageForPane('canvas', { current: 'Record', names }), 'Record');
  assert.equal(stageForPane('canvas', { current: 'Cut', names }), 'Build');
  assert.equal(stageForPane('canvas', { current: 'Cut', names, hasTake: false }), 'Record');
  // Show me of a Polish step opens Scenes as Polish; a hint for another pane is ignored.
  assert.equal(stageForPane('scenes', { current: 'Cut', hint: 'Polish', names }), 'Polish');
  assert.equal(stageForPane('scenes', { current: 'Cut', hint: 'Cut', names }), 'Plan');
  assert.equal(stageForPane('scenes', { current: 'Plan', hint: 'Polish', names }), 'Polish');
  assert.equal(stageForPane('renders', { current: 'Cut', names }), 'Publish');
  assert.equal(stageForPane('post', { current: 'Publish', names }), 'Publish');
  // A format without Package: packaging has no stage to select, so the current one stays.
  assert.equal(stageForPane('packaging', { current: 'Cut', names: names.filter((n) => n !== 'Package') }), 'Cut');
  assert.equal(stageForPane('nowhere', { current: 'Cut', names }), 'Cut');
});

test('Polish opens Scenes at the first scene with open notes', () => {
  const data = {
    scenes: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
    notes: [{ scene: 's3', status: 'open' }, { scene: 's1', status: 'resolved' }, { scene: 's2', status: 'question' }, { scene: 's1', kind: 'change', status: 'open' }],
  };
  assert.equal(firstNotedScene(data), 's2');
  assert.equal(firstNotedScene({ scenes: [{ id: 's1' }], notes: [{ scene: 's1', status: 'resolved' }] }), null);
  assert.equal(firstNotedScene(null), null);
});

// ---- the page wiring, from the source ----
const APP = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const RAIL = readFileSync(new URL('../web/rail.js', import.meta.url), 'utf8');

test('the tab row is gone; a workspace toolbar keeps the tools and the folder; Publish holds Renders and Post', () => {
  assert.ok(!/class="seg tabseg"/.test(APP), 'the old tab row is still drawn');
  assert.ok(!/\bconst TABS\b/.test(APP));
  assert.match(APP, /class="ws-bar"[\s\S]*?id="tabTools"[\s\S]*?id="reveal"/);
  assert.match(APP, /data-pane="publish"[\s\S]*?data-pane="renders"[\s\S]*?data-pane="post"/);
  assert.match(APP, /id="wsBody" role="tabpanel"/);
});

test('the stage bar is a tablist of tabs with separate ▾ buttons', () => {
  assert.match(RAIL, /role="tablist" aria-label="Stages/);
  assert.match(RAIL, /role="tab"[^\n]*aria-selected="\$\{on\}"[^\n]*aria-controls="wsBody"/);
  assert.match(RAIL, /class="stg-more"[^\n]*aria-haspopup="dialog"[^\n]*aria-expanded=/);
  assert.match(RAIL, /aria-label="\$\{esc\(`\$\{name\} steps`\)\}"/);
  // Each stage button carries its pane as data-tab, so old [data-tab=…] selectors still find the way.
  assert.match(RAIL, /data-tab="\$\{STAGE_PANE\[name\]\}"/);
  // The accessible name says the progress: "Record, next step: Record".
  assert.match(RAIL, /next step: \$\{cur\.name\}/);
});

test('an address change between stages of the open project switches in place', () => {
  assert.match(APP, /projectPage\?\.id === proj\.id && projectPage\.route\(proj\.query\)/);
  // window.history: inside the project page `history` is the undo stack.
  assert.match(APP, /window\.history\.replaceState\(window\.history\.state, '', next\)/);
});

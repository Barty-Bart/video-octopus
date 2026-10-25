// A Build step's progress per scene (B5b): queued, building, built, or not in this build.
// The Build asks (core/pipelines.json) tell Claude to mark each scene with the production-sheet skill's helper as it
// works, one command per scene (`sheet.py mark work/production.json building 3`, then `… built 3`), which sets that
// scene's "status" in work/production.json. A one-scene preview render (renders/*_scene3_preview.mp4) also says the
// scene is built. While the step runs, the project view carries what that adds up to, for the dock ("Build the intro ·
// scene 3 of 10"), the Scenes list and the scene timeline. When Claude marks nothing, there is no progress (null) and
// everything shows what it showed before: the running step and how long it has run.
//
// The run starts when the step's brief goes to the chat (index.mjs startStep) and ends with the turn. Its scope: the
// step's `scenes` (a block type, "intro" for Build the intro: the scenes of that block, or of that sheet section),
// else every scene. A scene that was already built before the run counts again only once Claude marks it building
// (or a new preview of it lands), so a second build starts from queued too.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJSON } from './util.mjs';

const runs = new Map(); // project id -> { step, scope, at, start: { sid: status }, seen: Set(sid) }
const DONE = new Set(['built', 'approved']);
const PREVIEW = /_scene(\d+)_preview/i;

const sheetScenes = (dir) => {
  const p = readJSON(join(dir, 'work/production.json'), null);
  return Array.isArray(p?.scenes) ? p.scenes.filter((s) => s && s.id != null).slice().sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0)) : [];
};
const sid = (s) => String(s.id);

// The scenes a step builds: its `scenes` block type (blocks of that type in work/blocks.json, or the sheet's own
// section of that name), else all of them. A scope nothing matches builds everything (an old sheet with no blocks).
export function scopeOf(dir, scenes, type) {
  if (!type) return scenes.map(sid);
  const blocks = readJSON(join(dir, 'work/blocks.json'), null)?.blocks || [];
  const ids = new Set(blocks.filter((b) => b?.type === type || b?.id === type).map((b) => String(b.id)));
  const mine = scenes.filter((s) => ids.has(String(s.block)) || s.section === type);
  return (mine.length ? mine : scenes).map(sid);
}

export function startBuildRun(id, dir, step, { now = Date.now() } = {}) {
  if (!step || step.stage !== 'Build' || (step.kind && step.kind !== 'claude')) { runs.delete(id); return null; }
  const scenes = sheetScenes(dir);
  const run = { step: step.id, scope: step.scenes || null, at: now, start: Object.fromEntries(scenes.map((s) => [sid(s), String(s.status || 'planned')])), seen: new Set() };
  runs.set(id, run);
  return run;
}
export function endBuildRun(id) { runs.delete(id); }
export const buildRun = (id) => runs.get(id) || null;

// Previews of single scenes made since the run started: their scene ids (by the number in the name: a scene id, or
// the scene's place in the sheet when no scene has that id).
function previewsSince(dir, scenes, at) {
  const out = new Set();
  let files = [];
  try { files = readdirSync(join(dir, 'renders')); } catch { return out; }
  for (const f of files) {
    const m = PREVIEW.exec(f);
    if (!m || f.startsWith('.')) continue;
    let t = 0; try { t = statSync(join(dir, 'renders', f)).mtimeMs; } catch {}
    if (t < at) continue;
    const byId = scenes.find((s) => sid(s) === String(Number(m[1])) || sid(s) === m[1]);
    const s = byId || scenes[Number(m[1]) - 1];
    if (s) out.add(sid(s));
  }
  return out;
}

// What the run adds up to now, or null (no run, no sheet, or nothing marked yet: the fallback).
// { step, total, built, current: { id, n, k } | null, order: [sid in scope], states: { sid: queued|building|built|notin }, marked }
// n: the scene's number in the whole sheet; k: "scene k of total" (the built ones plus this one).
export function buildProgress(id, dir) {
  const run = runs.get(id);
  if (!run || !dir) return null;
  const scenes = sheetScenes(dir);
  if (!scenes.length) return null;
  const order = scopeOf(dir, scenes, run.scope), inScope = new Set(order);
  const previews = previewsSince(dir, scenes, run.at);
  const states = {};
  let built = 0, current = null, marked = false;
  scenes.forEach((s, i) => {
    const k = sid(s), st = String(s.status || 'planned');
    if (!inScope.has(k)) { states[k] = 'notin'; return; }
    if (st === 'building') run.seen.add(k);
    const fresh = DONE.has(st) && (!DONE.has(run.start[k] || 'planned') || run.seen.has(k));
    const state = st === 'building' ? 'building' : fresh || previews.has(k) ? 'built' : 'queued';
    states[k] = state;
    if (state !== 'queued') marked = true;
    if (state === 'built') built++;
    if (state === 'building' && !current) current = { id: k, n: i + 1 };
  });
  if (!marked) return null;
  if (current) current.k = Math.min(order.length, built + 1);
  return { step: run.step, total: order.length, built, current, order, states, marked };
}
// A file event while the run is on (the project's watcher): note a scene seen building between two page reads.
export function noteBuildFiles(id, dir, files) {
  if (runs.has(id) && files.some((f) => f === 'work/production.json')) buildProgress(id, dir);
}

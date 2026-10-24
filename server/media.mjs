// The editor's Media section (web/media.js): everything a video uses, and what can be done with it.
//
// An item is one take in the project's source/: the recorder's <stamp>_screen / _webcam / _audio files together, or one
// imported file (studio.mjs takeKey). Each says where it is used:
// - canvas: the canvas take (project.json activeTake, studio.mjs roles);
// - layers: the extra layers showing its files (project.json layout.layers);
// - blocks: the blocks whose own file it is (work/blocks.json).
//
// Routes (POST unless said):
// - GET /media-items: the items, the canvas take's work, the trash entries an Undo can bring back.
// - /media-use { item, confirm }: an older take goes back on the canvas. The canvas take's transcript, cut, scene plan
//   and renders stay in work/ and renders/ but no longer count (activeSince, as when a new take replaces it), so
//   that is asked first (409 { ok: false, confirm }).
// - /media-layer { item }: an item not on the canvas becomes new layers, on top.
// - /media-remove { item, confirm }: the item's source/ files and their playback copies move to the studio's trash
//   (<studio>/.trash/<when>-<item>/, browser-recorder.mjs), with a manifest saying where everything was. The item leaves
//   project.json (takes, its layers); the canvas take falls back to the take before it. Never a hard delete; the
//   recordings folder's own copy of a take is not touched (the recorder's Delete take does that).
//   Refused (409) while Claude, an export or a playback copy uses the project's files; for the canvas take once a
//   transcript, cut, scene plan or render was made from it; for a block's file. Renders made while the item was in
//   the video are asked about first (they stay in renders/).
// - /media-restore { trash }: the Undo. Everything comes back where it was; the canvas take only if nobody changed it
//   meanwhile. Layer order and visibility are the canvas's own (layout.layers order, hidden; saved through /layout).
import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readJSON, writeJSON, mtime } from './util.mjs';
import { projectMeta, saveProjectMeta, projectMedia, roles, takeKey, isAudio, isTakeFile, probe, proxyName, proxyRunning,
  makeProxies, appendWorklog } from './studio.mjs';
import { normalize, newLayers } from '../web/layout.js';
import { trashRoot, moveAside, newTrashEntry, TRASH_NAME } from './browser-recorder.mjs';

const STAMP = /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d(-\d+)?$/;
const MAX_LAYERS = 8;
const KIND = 'media-removed';
const refuse = (message) => Object.assign(new Error(message), { status: 409 });

const roleOf = (f) => (/_screen\./i.test(f) ? 'screen' : /_webcam\./i.test(f) ? 'camera' : isAudio(f) ? 'sound' : 'video');
const inSource = (ref) => (typeof ref === 'string' ? ref.replace(/^source\//, '') : null);
const blocksOf = (dir) => readJSON(join(dir, 'work', 'blocks.json'), null)?.blocks || [];
const listWords = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);

// The project's media, grouped into items, the canvas take first, then the layers, then the rest (newest first).
export function mediaItems(dir) {
  const meta = projectMeta(dir) || {};
  const layout = normalize(meta.layout, meta.type);
  // The files the canvas shows (roles: the active take's screen and camera, else its main file).
  const canvas = roles(dir), shown = [canvas.screen, canvas.webcam, canvas.main].filter(Boolean);
  const blocks = blocksOf(dir);
  const groups = new Map();
  for (const f of projectMedia(dir)) {
    const k = takeKey(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const items = [...groups].map(([key, files]) => {
    const info = files.map((f) => {
      const p = probe(dir, f);
      let bytes = 0, at = 0;
      try { const st = statSync(join(dir, 'source', f)); bytes = st.size; at = st.mtimeMs; } catch {}
      return { file: f, role: roleOf(f), duration: p?.duration || null, w: p?.w || 0, h: p?.h || 0, bytes, at,
        proxy: isAudio(f) || existsSync(join(dir, proxyName(f))) };
    });
    const main = info.find((x) => x.role === 'camera') || info.find((x) => x.role === 'screen') || info.find((x) => x.role === 'video') || info[0];
    const layers = layout.layers.filter((x) => files.includes(x.file)).map((x) => ({ id: x.id, file: x.file, hidden: Boolean(x.hidden) }));
    const usedBy = blocks.filter((b) => [inSource(b?.source?.file), inSource(b?.source?.screen)].some((f) => f && files.includes(f)))
      .map((b) => ({ id: b.id, label: b.label || b.id }));
    return {
      id: key, files: info, duration: main?.duration || null,
      bytes: info.reduce((t, x) => t + x.bytes, 0), at: Math.max(...info.map((x) => x.at)),
      recorded: STAMP.test(key) || (meta.takes || []).includes(key),
      picture: info.some((x) => x.role !== 'sound'),
      take: files.some(isTakeFile),
      canvas: shown.some((f) => files.includes(f)),
      layers, blocks: usedBy,
    };
  });
  const rank = (x) => (x.canvas ? 0 : x.layers.length ? 1 : 2);
  items.sort((a, b) => rank(a) - rank(b) || b.at - a.at);
  return { items, work: canvasWork(dir, items.find((x) => x.canvas)), removed: removedEntries(basename(dir)) };
}

// What was made from the canvas take since it went on the canvas: a transcript, a cut, a scene plan, renders.
// (A transcript the take brought along is copied as it arrives, so the first minute after that doesn't count.)
export function canvasWork(dir, item) {
  if (!item) return [];
  const since = Math.max(projectMeta(dir)?.activeSince || 0, item.at || 0) + 60000;
  const after = (rel) => mtime(join(dir, rel)) > since;
  const out = [];
  if (['work/tr/words.json', 'work/words.json'].some(after)) out.push('a transcript');
  if (['work/edl_manual.json', 'work/edl_fixed.json'].some(after)) out.push('a cut');
  if (after('work/production.json')) out.push('a scene plan');
  if (rendersSince(dir, since)) out.push('renders');
  return out;
}

function rendersSince(dir, since) {
  try {
    return readdirSync(join(dir, 'renders')).filter((f) => /\.(mp4|mov)$/i.test(f) && mtime(join(dir, 'renders', f)) > since).length;
  } catch { return 0; }
}

// The trash entries of this project's removed media, newest first (the Media section's "Recently removed").
function removedEntries(id) {
  let names = [];
  try { names = readdirSync(trashRoot()); } catch { return []; }
  return names.filter((n) => TRASH_NAME.test(n))
    .map((n) => ({ n, m: readJSON(join(trashRoot(), n, 'manifest.json'), null) }))
    .filter(({ m }) => m?.kind === KIND && m.project === id)
    .sort((a, b) => b.m.at - a.m.at).slice(0, 5)
    .map(({ n, m }) => ({ trash: n, item: m.item, files: m.files, at: m.at, wasCanvas: Boolean(m.before?.canvas) }));
}

const findItem = (dir, key) => {
  const v = mediaItems(dir), item = v.items.find((x) => x.id === key);
  if (!item) throw new Error('That isn’t in this video’s media any more.');
  return { ...v, item };
};
const label = (item) => (STAMP.test(item.id) ? `the take of ${item.id.slice(0, 10)} ${item.id.slice(11, 16).replace('-', ':')}` : `“${item.id}”`);

// The take before this one on the canvas: the newest other take in project.json takes that still has files here,
// else the newest other take (not a block's own file) in source/. One that isn't a layer comes first; a layer becomes
// the recording only when there is nothing else (its layers then go, so it doesn't show twice).
function previousTake(items, key, meta) {
  const others = items.filter((x) => x.id !== key && x.take && !x.blocks.length);
  const pick = (pool) => {
    const listed = (meta.takes || []).filter((t) => t !== key && pool.some((x) => x.id === t));
    return listed.length ? listed.at(-1) : [...pool].sort((a, b) => b.at - a.at)[0]?.id || null;
  };
  const id = pick(others.filter((x) => !x.layers.length)) || pick(others);
  return id ? items.find((x) => x.id === id) : null;
}

// ---- use an older take ----
export function useTake(dir, key, { confirm = false, busy = null } = {}) {
  if (busy) throw refuse(busy);
  const { items, item, work } = findItem(dir, key);
  if (item.canvas) throw refuse('That take is on the canvas already.');
  if (!item.take) throw refuse(`${label(item)} is a sound file, not a take: it can be a block’s file but not the canvas take.`);
  if (work.length && !confirm) {
    return { ok: false, confirm: `The canvas take has ${listWords(work)}. They stay in the project, but they belong to that take: with ${label(item)} on the canvas, Clean up and the cut start again for it.` };
  }
  const meta = projectMeta(dir) || {};
  const layout = normalize(meta.layout, meta.type);
  const files = item.files.map((x) => x.file);
  // It was a layer: it moves onto the canvas instead, so it doesn't show twice.
  const keep = layout.layers.filter((x) => !files.includes(x.file));
  const was = items.find((x) => x.canvas)?.id || meta.activeTake || null;
  saveProjectMeta(dir, { activeTake: key, activeSince: Date.now(), ...(keep.length !== layout.layers.length ? { layout: { ...layout, layers: keep } } : {}) });
  appendWorklog(dir, `Put ${item.id} back on the canvas (Media)${was ? `; ${was} stays in source/` : ''}`);
  return { ok: true, item: key, was };
}

// ---- add as a layer ----
export function addAsLayer(dir, key, { busy = null } = {}) {
  if (busy) throw refuse(busy);
  const { item } = findItem(dir, key);
  if (item.canvas) throw refuse('That take is on the canvas already.');
  if (item.layers.length) throw refuse('That is a layer already.');
  const files = item.files.filter((x) => x.role !== 'sound').map((x) => x.file);
  if (!files.length) throw refuse('A sound file has no picture to put in a box.');
  const meta = projectMeta(dir) || {};
  const layout = normalize(meta.layout, meta.type);
  if (layout.layers.length + files.length > MAX_LAYERS) throw refuse(`A video has at most ${MAX_LAYERS} layers: remove one first.`);
  const dims = Object.fromEntries(item.files.map((x) => [x.file, x.w ? [x.w, x.h] : null]));
  const added = newLayers(layout, files, dims);
  // A project made by hand may not name its canvas take: it's named now, so the layer can't take its place.
  const active = meta.activeTake ? {} : (() => { const c = roles(dir).take.find((f) => !files.includes(f)); return c ? { activeTake: takeKey(c) } : {}; })();
  saveProjectMeta(dir, { ...active, layout: { ...layout, layers: [...layout.layers, ...added] } });
  appendWorklog(dir, `Added ${item.id} as a new layer (Media): ${files.join(', ')}`);
  return { ok: true, item: key, layers: added.map((x) => x.id), files };
}

// ---- remove (to the trash) ----
export function removeMedia(dir, key, { confirm = false, busy = null } = {}) {
  if (busy) throw refuse(busy);
  const { items, item, work } = findItem(dir, key);
  const files = item.files.map((x) => x.file);
  if (proxyRunning(dir, files)) throw refuse(`A playback copy of ${label(item)} is being made: wait a moment, then remove it.`);
  if (item.blocks.length) {
    throw refuse(`${label(item)} is the file of the ${item.blocks.map((b) => `“${b.label}”`).join(', ')} block${item.blocks.length > 1 ? 's' : ''}, so it wasn’t removed. Give ${item.blocks.length > 1 ? 'them' : 'that block'} another file first.`);
  }
  if (item.canvas && work.length) {
    throw refuse(`This recording already has ${listWords(work)}, so it wasn’t deleted. Put another take on the canvas first, or record a new one.`);
  }
  const renders = item.canvas ? 0 : rendersSince(dir, item.at);
  if (renders && !confirm) {
    return { ok: false, confirm: `${renders === 1 ? 'A render was' : `${renders} renders were`} made while ${label(item)} was in this video. ${renders === 1 ? 'It stays' : 'They stay'} in renders/, but remaking ${renders === 1 ? 'it' : 'them'} won’t show it.` };
  }

  const meta = projectMeta(dir) || {};
  const layout = normalize(meta.layout, meta.type);
  const id = basename(dir);
  const entry = newTrashEntry(key.replace(/[^\w .()-]/g, '_').slice(0, 100) || 'media');
  const root = join(trashRoot(), entry);
  const manifest = { v: 1, kind: KIND, at: Date.now(), project: id, item: key, files: [], proxies: [] };
  for (const f of files) {
    moveAside(join(dir, 'source', f), join(root, 'project', 'source', f));
    manifest.files.push(f);
    const px = proxyName(f);
    if (!isAudio(f) && existsSync(join(dir, px))) { moveAside(join(dir, px), join(root, 'project', px)); manifest.proxies.push(px); }
  }
  let fallback = null, off = files;
  if (item.canvas) {
    const prev = previousTake(items, key, meta);
    fallback = prev?.id || null;
    if (prev?.layers.length) off = [...files, ...prev.files.map((x) => x.file)];
  }
  const layers = layout.layers.map((x, i) => ({ x, i })).filter(({ x }) => off.includes(x.file));
  const next = { takes: (meta.takes || []).filter((t) => t !== key) };
  if (layers.length) next.layout = { ...layout, layers: layout.layers.filter((x) => !off.includes(x.file)) };
  if (item.canvas) Object.assign(next, { activeTake: fallback, activeSince: Date.now() });
  manifest.before = {
    takes: meta.takes || [], canvas: item.canvas, activeTake: meta.activeTake ?? null, activeSince: meta.activeSince ?? null,
    layers: layers.map(({ x, i }) => ({ at: i, layer: x })),
  };
  manifest.after = { activeTake: item.canvas ? fallback : meta.activeTake ?? null };
  writeJSON(join(root, 'manifest.json'), manifest);
  const saved = { ...meta, ...next };
  if (saved.activeTake == null) { delete saved.activeTake; delete saved.activeSince; }
  writeJSON(join(dir, 'project.json'), saved);
  appendWorklog(dir, `Removed ${key} from the video (Media): ${files.join(', ')} moved to the studio's trash (${entry})${item.canvas ? fallback ? `; the canvas take is ${fallback} again` : '; the video has no take now' : ''}`);
  return { ok: true, item: key, trash: entry, files, canvas: item.canvas, activeTake: fallback };
}

// ---- the Undo ----
export function restoreMedia(dir, entry, { busy = null } = {}) {
  if (busy) throw refuse(busy);
  if (!TRASH_NAME.test(entry || '')) throw new Error('Unknown trash entry.');
  const root = join(trashRoot(), entry), m = readJSON(join(root, 'manifest.json'), null);
  if (!m || m.kind !== KIND) throw new Error('That isn’t removed media.');
  if (m.project !== basename(dir)) throw new Error('That was removed from another video.');
  for (const f of m.files) {
    if (!existsSync(join(root, 'project', 'source', f))) throw new Error('Those files aren’t in the trash any more.');
    if (existsSync(join(dir, 'source', f))) throw refuse(`source/${f} is in the project again already.`);
  }
  for (const f of m.files) moveAside(join(root, 'project', 'source', f), join(dir, 'source', f));
  for (const px of m.proxies || []) if (!existsSync(join(dir, px))) moveAside(join(root, 'project', px), join(dir, px));

  const meta = projectMeta(dir) || {}, b = m.before || {};
  const next = { ...meta };
  if ((b.takes || []).includes(m.item)) {
    const takes = (meta.takes || []).filter((t) => t !== m.item);
    takes.splice(Math.min(takes.length, Math.max(0, b.takes.indexOf(m.item))), 0, m.item);
    next.takes = takes;
  }
  // Nobody changed the canvas take since: it goes back to what it was.
  if (b.canvas && (meta.activeTake ?? null) === (m.after?.activeTake ?? null)) {
    delete next.activeTake; delete next.activeSince;
    if (b.activeTake) next.activeTake = b.activeTake;
    if (b.activeSince) next.activeSince = b.activeSince;
  }
  if (b.layers?.length) {
    const layout = normalize(meta.layout, meta.type);
    const list = [...layout.layers];
    const have = new Set(list.map((x) => x.file));
    for (const { at, layer } of b.layers) {
      if (have.has(layer.file) || list.length >= MAX_LAYERS) continue;
      list.splice(Math.min(at, list.length), 0, layer);
    }
    next.layout = { ...layout, layers: list };
  }
  writeJSON(join(dir, 'project.json'), next);
  appendWorklog(dir, `Brought back ${m.item} from the studio's trash (Media)`);
  // The entry is empty now but for its manifest: it goes.
  const left = (d) => readdirSync(d, { withFileTypes: true }).some((e) => (e.isDirectory() ? left(join(d, e.name)) : !(e.name === 'manifest.json' && d === root)));
  if (!left(root)) rmSync(root, { recursive: true, force: true });
  return { ok: true, item: m.item, files: m.files, canvas: Boolean(b.canvas && next.activeTake === b.activeTake) };
}

// ---- routes; true when answered. ctx.busy(): why the project's files can't move now (Claude, an export), or null.
// ctx.frame(file): frame a camera layer around the head (index.mjs frameCamera). ----
export async function mediaRoute(req, res, { dir, action, send, body, emit, busy = () => null, frame = null }) {
  if (!action.startsWith('/media-')) return false;
  try {
    if (action === '/media-items' && req.method === 'GET') return send(res, 200, mediaItems(dir)), true;
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }), true;
    const b = await body(req);
    const key = String(b.item || '');
    const changed = (r, proxies = false) => {
      if (r.ok) {
        if (proxies) makeProxies(dir, emit);
        emit({ t: 'files' });
      }
      return send(res, r.ok ? 200 : 409, r), true;
    };
    if (action === '/media-use') return changed(useTake(dir, key, { confirm: b.confirm === true, busy: busy() }), true);
    if (action === '/media-layer') {
      const r = addAsLayer(dir, key, { busy: busy() });
      const cam = r.files.find((f) => /_webcam\./i.test(f));
      if (cam && frame) Promise.resolve().then(() => frame(cam)).catch((e) => console.error(`Auto-frame of the new layer failed: ${e.message}`));
      return changed(r, true);
    }
    if (action === '/media-remove') return changed(removeMedia(dir, key, { confirm: b.confirm === true, busy: busy() }));
    if (action === '/media-restore') return changed(restoreMedia(dir, String(b.trash || ''), { busy: busy() }), true);
  } catch (e) { return send(res, e.status || 400, { error: e.message }), true; }
  return send(res, 404, { error: 'Unknown action' }), true;
}

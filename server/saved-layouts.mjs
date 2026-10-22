// Saved layouts: the inspector's "+ Save layout" keeps the canvas look under a name in the studio
// (<studio>/.studio/layouts.json), so every project shows it as a tile next to Screen, Camera, PiP, Split and Boxed.
// A saved layout is the look only: preset, side, mirror, the PiP box and inset, the camera framing and card edge
// (shape, zoom, focus, border, shadow) and the background. Extra layers belong to their project and stay out.
// A background file (assets/bg-…) goes into the library when the layout is saved, so another project can copy it in.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { settings, readOwnJSON, writeJSON } from './util.mjs';
import { normalize, withPreset } from '../web/layout.js';
import { listBackgrounds, saveToLibrary, useLibraryBackground, libraryFile } from './backgrounds.mjs';
import { projectDir, projectMeta } from './studio.mjs';

const FILE = () => join(settings().studio, '.studio', 'layouts.json');
const LOOK = ['preset', 'side', 'mirror', 'webcam', 'pad', 'cam', 'bg'];
const look = (l) => ({ aspect: l.aspect, ...Object.fromEntries(LOOK.map((k) => [k, l[k]])) });
const MAX = 24;

export function savedLayouts() {
  const d = readOwnJSON(FILE(), null); // a broken file is kept aside, not overwritten by the next save
  return (Array.isArray(d?.layouts) ? d.layouts : []).filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string' && x.layout)
    .map((x) => ({ id: x.id, name: x.name, at: x.at || null, bgLibrary: x.bgLibrary || null, layout: look(normalize(x.layout)) }));
}
const write = (list) => writeJSON(FILE(), { v: 1, about: 'Layouts saved from Video Octopus\'s canvas (+ Save layout). Every project shows them as tiles.', layouts: list });

// The library's copy of a project background: the one it was copied from, else a new copy.
function libraryName(dir, file) {
  const bg = listBackgrounds(dir);
  const mine = bg.project.find((x) => x.file === file);
  if (!mine) return null;
  const same = bg.library.find((x) => x.name === mine.name && x.bytes === mine.bytes);
  return same ? same.file : saveToLibrary(dir, file);
}

export function saveLayout(name, layout, dir) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!n) throw new Error('Give the layout a name.');
  const l = normalize(layout);
  const entry = { id: `ly-${randomBytes(4).toString('hex')}`, name: n, at: new Date().toISOString(), layout: look(l) };
  if (l.bg.file && dir) entry.bgLibrary = libraryName(dir, l.bg.file);
  // The same name replaces the old one (saving again updates it).
  const list = savedLayouts().filter((x) => x.name.toLowerCase() !== n.toLowerCase());
  if (list.length >= MAX) throw new Error(`You have ${MAX} saved layouts. Remove one first (right-click its tile).`);
  write([...list, entry]);
  return { saved: entry, layouts: savedLayouts() };
}

export function removeLayout(id) {
  const list = savedLayouts();
  if (!list.some((x) => x.id === id)) throw new Error('That layout is already gone.');
  write(list.filter((x) => x.id !== id));
  return { layouts: savedLayouts() };
}

// A saved layout on a project's current one: its look, the project's own frame shape and layers. A background
// file comes in from the library (assets/bg-…); if it's gone, the project keeps its own background.
export function applyLayout(id, dir) {
  const s = savedLayouts().find((x) => x.id === id);
  if (!s) throw new Error('That layout is gone.');
  const meta = projectMeta(dir) || {};
  const cur = normalize(meta.layout, meta.type);
  let next = normalize({ ...cur, ...s.layout, aspect: cur.aspect, layers: cur.layers, hidden: cur.hidden }, meta.type);
  // Saved on the other frame shape: the PiP box goes to the same corner of this one.
  if (s.layout.aspect !== cur.aspect && next.preset === 'pip') {
    const w = s.layout.webcam, corner = `${w.y + w.w / 2 < 0.5 ? 't' : 'b'}${w.x + w.w / 2 < 0.5 ? 'l' : 'r'}`;
    next = withPreset({ ...next, aspect: s.layout.aspect }, { aspect: cur.aspect }, null);
    next = withPreset(next, { corner }, null);
  }
  let note = null;
  if (s.layout.bg.file) {
    if (s.bgLibrary && libraryFile(s.bgLibrary)) next.bg = useLibraryBackground(dir, s.bgLibrary);
    else if (!existsSync(join(dir, s.layout.bg.file))) { next.bg = cur.bg; note = 'Its background file is gone from the library, so the background stays as it was.'; }
  }
  return { layout: next, note };
}

// /api/layouts: GET lists them; POST { op: 'save', name, layout, project } | { op: 'remove', id } | { op: 'apply', id, project }.
export async function layoutsRoute(req, res, { send, body, touched }) {
  if (req.method === 'GET') return send(res, 200, { layouts: savedLayouts() });
  const b = await body(req);
  try {
    const dir = b.project ? projectDir(String(b.project)) : null;
    if (b.op === 'save') return send(res, 200, saveLayout(b.name, b.layout, dir));
    if (b.op === 'remove') return send(res, 200, removeLayout(String(b.id || '')));
    if (b.op === 'apply') {
      if (!dir) throw new Error('No such project');
      touched?.(String(b.project)); // the window's own change: it goes into the change package
      return send(res, 200, applyLayout(String(b.id || ''), dir));
    }
    throw new Error('Unknown layouts action');
  } catch (e) { return send(res, 400, { error: e.message }); }
}

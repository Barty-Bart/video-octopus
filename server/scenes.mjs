// Scenes: the production sheet (work/production.json) shown as scenes, the creator's review notes
// (work/notes.json: segment-review's note shape plus the moment, the pin on the picture and a status), and
// direct edits to scene elements (work/overrides.json, applied by the scene kit core/kit/octopus-scene.js
// every time a scene is drawn, in the app and in renders).
// Times are on the production sheet's timeline: the locked cut, which is also the renders' timeline.
import { existsSync, readFileSync, readdirSync, copyFileSync, mkdirSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { readJSON, writeJSON, mtime, settings, APP_DIR } from './util.mjs';
import { appendWorklog, projectMeta, probeFile } from './studio.mjs';
import { EXPORT_NAME, builtEnd, isBuilt } from './built.mjs';
import { listBackgrounds } from './backgrounds.mjs';
import { listLibrary, AUDIO } from './library.mjs';
import { underVoiceDb } from './sound.mjs';

export const KIT = join(APP_DIR, 'core', 'kit', 'octopus-scene.js');
export const KIT_IN_PROJECT = 'assets/octopus-scene.js';
const PRODUCTION = 'work/production.json', NOTES = 'work/notes.json', OVERRIDES = 'work/overrides.json';

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
const list = (x) => (Array.isArray(x) ? x.map(String) : x ? [String(x)] : []);
const clock = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); return `${m}:${(t % 60).toFixed(1).padStart(4, '0')}`; };

// A short name for a scene: its own title, else the first clause of what's shown.
function titleOf(s, i) {
  if (s.title) return String(s.title);
  const v = String(s.visual || s.shown || s.line || '').split(/[:.;(]/)[0].trim();
  return v ? (v.length > 42 ? `${v.slice(0, 40).trim()}…` : v) : `Scene ${i + 1}`;
}

export function readProduction(dir) {
  const p = readJSON(join(dir, PRODUCTION), null);
  if (!p || !Array.isArray(p.scenes)) return null;
  const scenes = p.scenes
    .map((s, i) => ({ s, i, start: num(s.start), end: num(s.end) }))
    .filter((x) => x.start != null && x.end != null && x.end > x.start)
    .sort((a, b) => a.start - b.start)
    .map(({ s, i, start, end }, k) => ({
      id: String(s.id ?? i + 1), n: k + 1, start, end, title: titleOf(s, i),
      line: String(s.line || s.text || ''), layout: String(s.layout || s.shot || ''), transition: String(s.transition_in || s.transition || ''),
      visual: String(s.visual || s.shown || ''), sfx: list(s.sfx), skills: list(s.skills), section: String(s.section || ''),
      // The look the creator can change in Video Octopus (Scenes › Look): background, and when each effect plays.
      background: String(s.background || ''), sfxAt: Array.isArray(s.sfx_at) ? s.sfx_at.map(num).filter((x) => x != null) : [],
      // Each effect's level when the sheet has one (sfx_db: dB on top of the default, one number or one per effect).
      sfxDb: Array.isArray(s.sfx_db) ? s.sfx_db.map(num) : num(s.sfx_db) != null ? list(s.sfx).map(() => num(s.sfx_db)) : [],
      // The project block the scene belongs to (intro, main body, sponsor read, outro…); planned for M3b, optional.
      block: String(s.block || s.section || ''),
      beats: Array.isArray(s.beats) ? s.beats.filter((b) => Array.isArray(b) && b.length >= 2).map(([a, b]) => [String(a), String(b)]) : [],
    }));
  if (!scenes.length) return null;
  return {
    file: PRODUCTION, at: mtime(join(dir, PRODUCTION)), scenes,
    sections: Array.isArray(p.sections) ? p.sections : [], theme: String(p.theme || ''), story: String(p.visual_story || ''),
    source: typeof p.source === 'string' ? p.source : null, render: typeof p.render === 'string' ? p.render : null,
    sceneFile: typeof p.scene_file === 'string' ? p.scene_file : null, fps: num(p.fps) > 1 ? num(p.fps) : 30,
  };
}

export const sceneAt = (prod, t) => prod?.scenes.find((s) => t >= s.start && t < s.end) || (prod && t >= prod.scenes.at(-1).end ? prod.scenes.at(-1) : null);

// A render that is still being written has no complete 'moov' box yet: walk the top-level boxes.
const complete = new Map();
function mp4Complete(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size, mtimeMs } = fstatSync(fd);
    const key = `${path}:${size}:${mtimeMs}`;
    if (complete.has(key)) return complete.get(key);
    const head = Buffer.alloc(16);
    let pos = 0, moov = false, ok = true;
    for (let i = 0; i < 64 && pos < size; i++) {
      if (readSync(fd, head, 0, 16, pos) < 8) { ok = false; break; }
      let len = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (len === 1) len = Number(head.readBigUInt64BE(8));
      else if (len === 0) len = size - pos;
      if (len < 8 || pos + len > size) { ok = false; break; }
      if (type === 'moov') moov = true;
      pos += len;
    }
    const done = ok && moov;
    complete.set(key, done);
    return done;
  } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
}

// Renders that show the scenes, newest first (the canvas's own exports and files still being written are left out).
function sceneRenders(dir, prod) {
  let files = [];
  try { files = readdirSync(join(dir, 'renders')).filter((f) => /\.(mp4|mov|m4v)$/i.test(f) && !EXPORT_NAME.test(f) && !f.startsWith('.') && !/\.part\./.test(f)); } catch {}
  const out = files.filter((f) => mp4Complete(join(dir, 'renders', f)))
    .map((f) => ({ file: `renders/${f}`, at: mtime(join(dir, 'renders', f)), version: /_v(\d+)\b/i.exec(f)?.[0].slice(1) || basename(f, extname(f)),
      duration: probeFile(join(dir, 'renders', f))?.duration || null })) // how far it reaches: scenes after it aren't built yet
    .sort((a, b) => b.at - a.at);
  return out;
}

// The scene's HTML file (the one with seek(t)), and whether it loads the scene kit.
function sceneFileOf(dir, prod) {
  const file = [prod?.sceneFile, 'scene.html', 'scenes.html', 'work/scene.html'].find((f) => f && !f.includes('..') && existsSync(join(dir, f)));
  if (!file) return null;
  let text = '';
  try { text = readFileSync(join(dir, file), 'utf8'); } catch {}
  const layers = /Octopus\.layers\s*=\s*\[([^\]]*)\]/.exec(text)?.[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  return { file, kit: /octopus-scene\.js/.test(text), layers: layers?.length ? layers : [null] };
}
// The kit's version: the project's copy (what its scenes load) and Video Octopus's own. 0 = no copy in the project.
const kitVersion = (path) => { try { return Number(/\bkit:\s*(\d+)/.exec(readFileSync(path, 'utf8'))?.[1] || 1); } catch { return 0; } };
export const KIT_LATEST = kitVersion(KIT);

function wordsOf(dir) {
  const f = ['work/words.json', 'work/rough_words.json', 'work/tr/words.json'].find((x) => existsSync(join(dir, x)));
  const raw = f ? readJSON(join(dir, f), []) : [];
  const words = (Array.isArray(raw) ? raw : []).filter((w) => Array.isArray(w) && w.length >= 3 && Number.isFinite(w[0]) && Number.isFinite(w[1]))
    .map(([a, b, t]) => [a, b, String(t)]);
  return { file: f || null, words };
}

export function frameOf(dir) {
  const ly = projectMeta(dir)?.layout;
  const type = projectMeta(dir)?.type;
  return (ly?.aspect || (type === 'short' || type === 'reel' ? '9:16' : '16:9')) === '9:16' ? [1080, 1920] : [1920, 1080];
}

// ---- sections: the project's blocks (intro, main body, sponsor read…) as groups of scenes ----
// A scene's section is its "block" (M3b's work/blocks.json id, or the sheet's section id). The label comes from
// blocks.json when that block exists there, else the sheet's sections made readable. Scenes without one fall
// into the sheet section whose time range holds them, else one group.
const SECTION_NAME = [[/^intro/i, 'Intro'], [/^(body|main)/i, 'Main body'], [/^outro|^end/i, 'Outro'], [/^sponsor/i, 'Sponsor read'], [/^hook/i, 'Hook'], [/^cta/i, 'Call to action']];
const readable = (id) => {
  const hit = SECTION_NAME.find(([re]) => re.test(id));
  const n = /-(\d+)$/.exec(id)?.[1];
  if (hit) return hit[1] + (n && n !== '1' ? ` ${n}` : '');
  return id.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
};
export function sectionsOf(dir, prod) {
  const blocks = readJSON(join(dir, 'work/blocks.json'), null)?.blocks;
  const label = new Map((Array.isArray(blocks) ? blocks : []).filter((b) => b?.id).map((b) => [String(b.id), String(b.label || b.id)]));
  const sheet = (prod.sections || []).filter((x) => x && x.id != null).map((x) => ({ id: String(x.id), start: num(x.start), end: num(x.end), label: x.label ? String(x.label) : null }));
  const keyOf = (s) => s.block || sheet.find((x) => x.start != null && x.end != null && s.start >= x.start - 0.05 && s.start < x.end)?.id || '';
  const out = [];
  for (const s of prod.scenes) {
    const key = keyOf(s);
    const last = out.at(-1);
    if (last && last.id === key) { last.scenes.push(s.id); last.end = s.end; continue; }
    const sh = sheet.find((x) => x.id === key);
    out.push({ id: key, block: label.has(key) ? key : null, label: label.get(key) || sh?.label || (key ? readable(key) : 'All scenes'), start: s.start, end: s.end, scenes: [s.id] });
  }
  return out;
}

// ---- what the Look tab offers: layouts, backgrounds, transitions and the library's sounds ----
const BASE_LAYOUTS = [['talking-head', 'Talking head'], ['cutout', 'Cutout'], ['split', 'Split'], ['visual-storytelling', 'Storytelling'], ['card', 'Card'], ['boxed', 'Boxed']];
const BASE_TRANSITIONS = [['cut', 'Cut'], ['morph', 'Morph'], ['diagonal-bars', 'Bars'], ['wipe', 'Wipe']];
const BASE_BACKGROUNDS = [['stars', 'Stars'], ['led', 'LED wave'], ['night', 'Night Desk'], ['plain', 'Plain'], ['camera', 'Camera']];
function lookOptions(dir, prod) {
  const withSheet = (base, key) => {
    const out = base.map(([id, label]) => ({ id, label }));
    for (const s of prod.scenes) {
      const v = s[key];
      if (v && v !== 'none' && !out.some((x) => x.id === v)) out.push({ id: v, label: readable(v) });
    }
    return out;
  };
  const backgrounds = BASE_BACKGROUNDS.map(([id, label]) => ({ id, label, kind: 'preset' }));
  try {
    const bg = listBackgrounds(dir);
    for (const x of bg.library || []) backgrounds.push({ id: `library:${x.file || x.name}`, label: x.name || x.file, kind: 'library', file: x.file });
    for (const x of bg.project || []) if (!x.inLibrary) backgrounds.push({ id: x.file, label: x.name || x.file, kind: 'project', file: x.file });
  } catch {}
  for (const s of prod.scenes) if (s.background && !backgrounds.some((x) => x.id === s.background)) backgrounds.push({ id: s.background, label: readable(s.background), kind: 'sheet' });
  let sounds = [];
  try {
    sounds = (listLibrary().kinds.find((k) => k.key === 'sfx')?.items || []).filter((x) => AUDIO.test(x.file))
      .map((x) => ({ file: x.file, name: basename(x.file, extname(x.file)), note: x.note || '' })).slice(0, 200);
  } catch {}
  return { layouts: withSheet(BASE_LAYOUTS, 'layout'), transitions: withSheet(BASE_TRANSITIONS, 'transition'), backgrounds, sounds };
}

// ---- notes ----
export function notesDoc(dir) {
  const d = readJSON(join(dir, NOTES), null);
  return { v: 1, notes: Array.isArray(d?.notes) ? d.notes.filter((n) => n && n.id) : [], approved: d?.approved && typeof d.approved === 'object' ? d.approved : {} };
}
export const saveNotes = (dir, doc) => writeJSON(join(dir, NOTES), doc);
const who = () => settings().userName || userInfo().username || 'creator';
const STATUSES = ['open', 'sent', 'done', 'question', 'resolved'];
// Changes: layout, background, transition (per scene), sfx (add/remove an effect), timing (a scene edge or an
// element's in/out), style and text (an element's font, size, colour or words).
// enter / leave: how an element comes on and goes off screen (Scenes › an element's Timing); level: a sound effect's level.
const CHANGE_FIELDS = ['layout', 'background', 'transition', 'sfx', 'timing', 'style', 'text', 'cut', 'blocks', 'look', 'enter', 'leave', 'level'];
const FIELD_LABEL = { layout: 'Layout', background: 'Background', transition: 'Transition in', sfx: 'Sound', timing: 'Timing', style: 'Style', text: 'Text', cut: 'Cut', blocks: 'Blocks', look: 'Look', enter: 'Enters', leave: 'Leaves', level: 'Sound level' };
// A cut change (from the Cut tab): the kept parts of the take before and after, {segments: [[start, end], …]} in take
// seconds. One open item for the whole video; later saves replace it, keeping the cut it started from.
const r3 = (x) => Math.round(x * 1000) / 1000;
function cutVal(v) {
  const segs = Array.isArray(v?.segments) ? v.segments : [];
  return { segments: segs.filter((x) => Array.isArray(x) && num(x[0]) != null && num(x[1]) != null && x[1] > x[0]).slice(0, 5000).map(([a, b]) => [r3(a), r3(b)]) };
}
// What changed between two cuts, in order along the old cut (the timeline the sheet, the scenes and renders use):
// [{kind: 'removed'|'restored', take: [a, b], dur, at (old cut seconds), shift (seconds everything after moves)}].
export function cutEdits(from, to) {
  const minus = (A, B) => { const out = []; for (const [a, b] of A) { let parts = [[a, b]]; for (const [c, d] of B) parts = parts.flatMap(([x, y]) => (d <= x || c >= y ? [[x, y]] : [[x, Math.min(y, c)], [Math.max(x, d), y]].filter(([p, q]) => q - p > 0.02))); out.push(...parts); } return out; };
  const onOld = (t) => from.reduce((s, [a, b]) => s + Math.max(0, Math.min(t, b) - a), 0);
  const edits = [...minus(from, to).map((r) => ({ kind: 'removed', take: r })), ...minus(to, from).map((r) => ({ kind: 'restored', take: r }))]
    .map((e) => ({ ...e, take: e.take.map(r3), dur: r3(e.take[1] - e.take[0]), at: r3(onOld(e.take[0])) })).sort((a, b) => a.at - b.at || a.take[0] - b.take[0]);
  let shift = 0;
  for (const e of edits) { shift += e.kind === 'removed' ? -e.dur : e.dur; e.shift = r3(shift); }
  return edits;
}
const cutLen = (segs) => segs.reduce((s, [a, b]) => s + b - a, 0);
function cutText(from, to) {
  const ed = cutEdits(from.segments, to.segments);
  const one = (e) => `${e.kind === 'removed' ? '−' : '+'}${e.dur.toFixed(2)} s at ${clock2(e.at)}`;
  return `${ed.length} edit${ed.length === 1 ? '' : 's'}: ${ed.slice(0, 4).map(one).join(', ')}${ed.length > 4 ? ` and ${ed.length - 4} more` : ''} · ${clock2(cutLen(from.segments))} → ${clock2(cutLen(to.segments))}`;
}
// A change value: a string, a number, or a small object of those (timing {start, end} or {in, out}; style {font, size, color}; sfx {add|remove}).
function val(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  if (typeof v === 'string') return v.slice(0, 300);
  if (typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v).slice(0, 8)) if (/^\w{1,20}$/.test(k) && x != null && typeof x !== 'object') o[k] = typeof x === 'number' ? Math.round(x * 100) / 100 : String(x).slice(0, 200);
    return o;
  }
  return null;
}
const showVal = (v) => (v == null || v === '' ? 'none' : typeof v === 'number' ? clock(v)
  : typeof v === 'object' ? Object.entries(v).map(([k, x]) => (/^(start|end|in|out|t)$/.test(k) && typeof x === 'number' ? `${k} ${clock2(x)}` : `${k} ${x}`)).join(', ') : String(v));
const dB = (v) => (typeof v === 'number' ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)} dB` : 'as set');
// Timing to the hundredth: an element landing on a word is a matter of frames.
function clock2(t) { t = Math.max(0, t || 0); const m = Math.floor(t / 60); return `${m}:${(t % 60).toFixed(2).padStart(5, '0')}`; }
function changeText(n) {
  const who = n.target ? `${n.target.label}: ` : '';
  if (n.field === 'sfx') return n.to?.add ? `Add sound “${n.to.add}”` : n.to?.remove ? `Remove sound “${n.to.remove}”` : 'Sound';
  if (n.field === 'cut') return `The cut changed: ${cutText(n.from, n.to)}`;
  if (n.field === 'level') return `Sound “${n.target?.label || ''}” level ${dB(n.from)} → ${dB(n.to)}`;
  if (n.field === 'enter' || n.field === 'leave') return `${who}${n.field === 'enter' ? 'enters' : 'leaves'} ${n.from || 'as made'} → ${n.to || 'as made'}`;
  return `${who}${FIELD_LABEL[n.field]} ${showVal(n.from)} → ${showVal(n.to)}`;
}

// The one open "cut" item, kept in step with the cut by the server (cutsync.mjs): created, updated in place (same
// id), or dropped when the cut is back where it started. Returns { created, removed }.
export function setCutChange(dir, from, to) {
  const doc = notesDoc(dir);
  const open = doc.notes.find((n) => n.kind === 'change' && n.field === 'cut' && n.status === 'open');
  const f = cutVal({ segments: from }), t = cutVal({ segments: to });
  if (!cutEdits(f.segments, t.segments).length) {
    if (open) { doc.notes = doc.notes.filter((n) => n !== open); saveNotes(dir, doc); }
    return { created: false, removed: Boolean(open) };
  }
  if (open && JSON.stringify(open.from) === JSON.stringify(f) && JSON.stringify(open.to) === JSON.stringify(t)) return { created: false };
  const now = new Date().toISOString();
  const n = open || { id: `n${Date.now().toString(36)}${randomBytes(2).toString('hex')}`, seg: null, scene: null, by: who(), status: 'open', kind: 'change', field: 'cut' };
  Object.assign(n, { from: f, to: t, at: now });
  n.text = changeText(n);
  if (!open) doc.notes.push(n);
  saveNotes(dir, doc);
  return { created: !open, item: n };
}

// One open item for a whole-video document (the blocks, the canvas look), kept in step by the server
// (cutsync.mjs): edits are short sentences of what changed since Claude last got the package.
export function setListChange(dir, field, edits) {
  const doc = notesDoc(dir);
  const open = doc.notes.find((n) => n.kind === 'change' && n.field === field && n.status === 'open');
  if (!edits.length) {
    if (open) { doc.notes = doc.notes.filter((n) => n !== open); saveNotes(dir, doc); }
    return { created: false, removed: Boolean(open) };
  }
  const text = `${FIELD_LABEL[field]} changed: ${edits.slice(0, 6).join('; ')}${edits.length > 6 ? `; and ${edits.length - 6} more` : ''}`;
  if (open && open.text === text) return { created: false };
  const n = open || { id: `n${Date.now().toString(36)}${randomBytes(2).toString('hex')}`, seg: null, scene: null, by: who(), status: 'open', kind: 'change', field, from: null, to: null };
  Object.assign(n, { text, edits: edits.slice(0, 40), at: new Date().toISOString() });
  if (!open) doc.notes.push(n);
  saveNotes(dir, doc);
  return { created: !open, item: n };
}

export function notesOp(dir, b) {
  const doc = notesDoc(dir);
  const prod = readProduction(dir);
  const now = new Date().toISOString();
  const find = () => { const n = doc.notes.find((x) => x.id === b.id); if (!n) throw new Error('That note is gone.'); return n; };
  if (b.op === 'list') return doc;
  if (b.op === 'add') {
    const text = String(b.text || '').trim().slice(0, 4000);
    if (!text && b.kind !== 'change') throw new Error('Write the note first.');
    const t = num(b.t);
    const scene = b.scene != null ? String(b.scene) : t != null ? sceneAt(prod, t)?.id || null : null;
    const n = { id: `n${Date.now().toString(36)}${randomBytes(2).toString('hex')}`, seg: scene != null && /^\d+$/.test(scene) ? Number(scene) : scene, scene, text, at: now, by: who(), status: 'open' };
    if (t != null) n.t = Math.round(t * 100) / 100;
    if (Array.isArray(b.range) && b.range.length === 2 && b.range.every((x) => num(x) != null)) n.range = b.range.map((x) => Math.round(x * 100) / 100);
    if (b.pos && num(b.pos.x) != null && num(b.pos.y) != null) n.pos = { x: Math.round(Math.min(1, Math.max(0, b.pos.x)) * 1000) / 1000, y: Math.round(Math.min(1, Math.max(0, b.pos.y)) * 1000) / 1000 };
    if (b.el?.id) n.el = { id: String(b.el.id).slice(0, 60), label: String(b.el.label || b.el.id).slice(0, 80) };
    if (b.on) n.on = String(b.on).slice(0, 20);
    const block = b.block || prod?.scenes.find((x) => x.id === scene)?.block;
    if (block) n.block = String(block).slice(0, 40);
    if (b.render) { n.render = String(b.render).slice(0, 200); n.version = /_v(\d+)\b/i.exec(n.render)?.[0].slice(1) || basename(n.render, extname(n.render)); }
    if (b.re) n.re = String(b.re).slice(0, 40);
    if (b.kind === 'change') {
      // A change from the Look tab, the scene timeline or the element panel. A newer change to the same thing
      // replaces the open one (keeping where it started); changing it back to where it started drops it.
      const field = CHANGE_FIELDS.includes(b.field) ? b.field : null;
      if (!field) throw new Error('Unknown change.');
      n.kind = 'change'; n.field = field;
      if (b.target?.id) n.target = { id: String(b.target.id).slice(0, 60), label: String(b.target.label || b.target.id).slice(0, 80) };
      const same = (x) => x.kind === 'change' && x.status === 'open' && x.scene === n.scene && x.field === field && (x.target?.id || '') === (n.target?.id || '') && field !== 'sfx';
      const prev = doc.notes.find(same);
      const v = field === 'cut' ? cutVal : val;
      n.from = prev ? prev.from : v(b.from);
      n.to = v(b.to);
      doc.notes = doc.notes.filter((x) => !same(x));
      if (JSON.stringify(n.from) === JSON.stringify(n.to)) { saveNotes(dir, doc); return doc; }
      if (!n.text) n.text = changeText(n);
    }
    doc.notes.push(n);
  } else if (b.op === 'update') {
    const n = find();
    if (typeof b.text === 'string' && b.text.trim()) n.text = b.text.trim().slice(0, 4000);
    if (STATUSES.includes(b.status)) { n.status = b.status; n[`${b.status}_at`] = now; }
  } else if (b.op === 'delete') {
    doc.notes = doc.notes.filter((x) => x.id !== b.id);
  } else if (b.op === 'approve' || b.op === 'unapprove') {
    const id = String(b.scene ?? '');
    const sc = prod?.scenes.find((s) => s.id === id);
    if (!sc) throw new Error('Unknown scene.');
    // Only a scene a render has built can be approved (the rest have no picture to approve yet).
    if (b.op === 'approve' && !isBuilt(sc, builtEnd(dir))) throw new Error(`Scene ${sc.n} isn't built yet: there's no render of it to approve.`);
    if (b.op === 'approve') {
      doc.approved[id] = now;
      for (const n of doc.notes) if (n.scene === id && n.status === 'done') { n.status = 'resolved'; n.resolved_at = now; }
    } else delete doc.approved[id];
  } else throw new Error('Unknown note action.');
  saveNotes(dir, doc);
  // Every built scene approved (the scenes a render reaches; a tutorial builds only its intro): the review step is done.
  const built = prod.scenes.filter((s) => isBuilt(s, builtEnd(dir)));
  if (b.op === 'approve' && built.length && built.every((s) => doc.approved[s.id])) {
    let log = '';
    try { log = readFileSync(join(dir, 'WORKLOG.md'), 'utf8'); } catch {}
    const r = sceneRenders(dir, prod)[0];
    const what = built.length === prod.scenes.length ? `${prod.scenes.length} scenes` : `${built.length} built scenes of ${prod.scenes.length}`;
    if (!log.includes('Scenes approved')) appendWorklog(dir, `Scenes approved (${what}${r ? `, ${r.file}` : ''}) in Video Octopus`);
  }
  return doc;
}

// ---- direct edits ----
export function overridesDoc(dir) {
  const d = readJSON(join(dir, OVERRIDES), null);
  return { v: 1, scenes: d?.scenes && typeof d.scenes === 'object' ? d.scenes : {} };
}

export function setOverride(dir, b) {
  const scene = String(b.scene ?? ''), el = String(b.el ?? '');
  if (!/^[\w*.-]{1,40}$/.test(scene) || !/^[\w.-]{1,60}$/.test(el)) throw new Error('Bad scene or element.');
  const doc = overridesDoc(dir);
  const ov = b.ov;
  const round = (x, k) => Math.round(x * k) / k;
  const keys = keysOf(ov?.keys);
  const isNoop = ov && !keys.length && !Math.round(ov.dx || 0) && !Math.round(ov.dy || 0) && Math.abs((ov.scale || 1) - 1) < 0.005;
  if (!ov || isNoop) {
    if (doc.scenes[scene]) { delete doc.scenes[scene][el]; if (!Object.keys(doc.scenes[scene]).length) delete doc.scenes[scene]; }
  } else {
    const c = (x, a, z, d) => (Number.isFinite(Number(x)) ? Math.min(z, Math.max(a, Number(x))) : d);
    doc.scenes[scene] = { ...(doc.scenes[scene] || {}), [el]: {
      dx: round(c(ov.dx, -4000, 4000, 0), 1), dy: round(c(ov.dy, -4000, 4000, 0), 1), scale: round(c(ov.scale, 0.1, 8, 1), 1000),
      ...(keys.length ? { keys } : {}), ...(b.label ? { label: String(b.label).slice(0, 80) } : {}), at: new Date().toISOString() } };
  }
  // "Every scene" and this scene don't both hold the same element.
  if (scene === '*') for (const k of Object.keys(doc.scenes)) if (k !== '*' && doc.scenes[k]?.[el]) { delete doc.scenes[k][el]; if (!Object.keys(doc.scenes[k]).length) delete doc.scenes[k]; }
  writeJSON(join(dir, OVERRIDES), doc);
  return doc;
}

// Keyframes (the scene timeline's ◆): [{t, dx, dy, s, o, e}], sorted, one per moment, at most 64. t = seconds on the
// render's timeline; s = scale, o = opacity 0–1, e = "linear" | "hold" (default: ease in and out). Read by the kit.
function keysOf(list) {
  if (!Array.isArray(list)) return [];
  const n = (x, a, z, d) => (Number.isFinite(Number(x)) ? Math.min(z, Math.max(a, Number(x))) : d);
  const out = new Map();
  for (const k of list.slice(0, 64)) {
    if (!k || !Number.isFinite(Number(k.t))) continue;
    const t = Math.round(n(k.t, 0, 36000, 0) * 1000) / 1000;
    out.set(t, { t, dx: Math.round(n(k.dx, -4000, 4000, 0)), dy: Math.round(n(k.dy, -4000, 4000, 0)), s: Math.round(n(k.s, 0.05, 8, 1) * 1000) / 1000,
      o: Math.round(n(k.o, 0, 1, 1) * 1000) / 1000, ...(['linear', 'hold'].includes(k.e) ? { e: k.e } : {}) });
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

// Bring the project's copy of the kit up to Video Octopus's (keys and motion markers need kit 2, rows nested under their
// parent and the type bar kit 3; it only adds).
export function updateKit(dir) {
  const had = kitVersion(join(dir, KIT_IN_PROJECT));
  installKit(dir);
  const adds = [had < 2 && 'keyframes, motion markers', had < 3 && 'elements nested under their parent, which ones are text'].filter(Boolean).join('; ');
  if (had && had < KIT_LATEST) appendWorklog(dir, `Updated the Video Octopus scene kit in ${KIT_IN_PROJECT} (kit ${had} → ${KIT_LATEST}: ${adds})`);
  return { ok: true, version: KIT_LATEST, was: had };
}

// Copy the kit into the project so the scene (and its file:// renders) can load it.
export function installKit(dir) {
  mkdirSync(join(dir, 'assets'), { recursive: true });
  copyFileSync(KIT, join(dir, KIT_IN_PROJECT));
  return KIT_IN_PROJECT;
}

// ---- what the Scenes tab needs ----
export function scenesView(dir) {
  const prod = readProduction(dir);
  if (!prod) return { ready: false, why: existsSync(join(dir, PRODUCTION)) ? 'work/production.json has no scenes with start and end times yet.' : 'No production sheet yet. Plan the scenes writes work/production.json; its scenes show up here.' };
  const words = wordsOf(dir);
  const notes = notesDoc(dir);
  const scene = sceneFileOf(dir, prod);
  const source = prod.source && !prod.source.includes('..') && existsSync(join(dir, prod.source)) ? prod.source : null;
  return {
    ready: true, ...prod, renders: sceneRenders(dir, prod), builtEnd: builtEnd(dir), words: words.words, wordsFile: words.file, frame: frameOf(dir),
    sceneFile: scene?.file || null, kit: scene ? { has: scene.kit, layers: scene.layers, version: kitVersion(join(dir, KIT_IN_PROJECT)), latest: KIT_LATEST } : null, sourceVideo: source,
    notes: notes.notes, approved: notes.approved, overrides: overridesDoc(dir),
    cutScenes: readJSON(join(dir, 'work/cut_scenes.json'), null)?.segments || null, // the cut the sheet and renders are on
    cutWaiting: cutWaitingOf(notes.notes), // cut changes not sent yet: where they sit on that timeline
    cutStamp: Math.max(mtime(join(dir, 'work/edl_manual.json')), mtime(join(dir, 'work/edl_fixed.json'))), // the cut files changed: Scenes re-reads the take
    sections: sectionsOf(dir, prod), options: lookOptions(dir, prod),
    plan: planState(dir), // B4: the plan's approval (Approve plan / Ask for changes in the Plan panel)
  };
}

// ---- the plan's approval (B4) ----
// work/production.json "approved": {at, by: "creator", scenes} once the creator presses Approve plan; only Video Octopus
// writes it (server/turns.mjs takes out one an agent wrote). Plan the scenes is done then and Build is next. Ask for
// changes takes it out again (the plan is about to change). Approve scene in Polish is separate (notes.json approved).
export function planState(dir) {
  const p = readJSON(join(dir, PRODUCTION), null);
  const a = p?.approved && typeof p.approved === 'object' ? p.approved : p?.approved ? { at: null } : null;
  return { approved: a ? { at: typeof a.at === 'string' ? a.at : null } : null };
}
export function approvePlan(dir) {
  const p = readJSON(join(dir, PRODUCTION), null);
  if (!Array.isArray(p?.scenes) || !p.scenes.length) throw new Error('There is no scene plan to approve yet: Plan the scenes writes it.');
  p.approved = { at: new Date().toISOString(), by: 'creator', scenes: p.scenes.length };
  writeJSON(join(dir, PRODUCTION), p);
  appendWorklog(dir, `Plan approved in Video Octopus (${p.scenes.length} scene${p.scenes.length === 1 ? '' : 's'})`);
  return p.approved;
}
export function unapprovePlan(dir) {
  const p = readJSON(join(dir, PRODUCTION), null);
  if (!p || p.approved == null) return false;
  delete p.approved;
  writeJSON(join(dir, PRODUCTION), p);
  return true;
}

// The open cut change's edits, placed on the scenes' timeline (t) and on the new cut (tNew, where the Cut tab finds it).
function cutWaitingOf(notes) {
  const n = notes.find((x) => x.kind === 'change' && x.field === 'cut' && x.status === 'open');
  if (!n?.from?.segments || !n?.to?.segments) return [];
  const B = n.to.segments, onNew = (x) => { let d = 0; for (const [a, b] of B) { if (x < a) return d; if (x <= b) return d + x - a; d += b - a; } return d; };
  return cutEdits(n.from.segments, B).map((e) => ({ t: e.at, tNew: r3(onNew(e.take[0])), dur: e.dur, kind: e.kind,
    label: `${e.kind === 'removed' ? '−' : '+'}${e.dur.toFixed(2)} s` }));
}

// A light summary for the project view (rail and tab badges).
export function scenesSummary(dir) {
  const prod = readProduction(dir);
  if (!prod) return null;
  const { notes, approved } = notesDoc(dir);
  const count = (s) => notes.filter((n) => n.status === s).length;
  // of: the scenes there are to approve (the built ones once a render exists; before any, all of them).
  const end = builtEnd(dir), built = prod.scenes.filter((s) => isBuilt(s, end));
  return { count: prod.scenes.length, of: end > 0 ? built.length : prod.scenes.length, built: built.length, approved: (end > 0 ? built : prod.scenes).filter((s) => approved[s.id]).length,
    open: count('open') + pendingMoves(dir, prod).length, sent: count('sent'), done: count('done') + count('question') };
}
// Moves and keyframes in work/overrides.json newer than the newest render: in the package with the notes.
function pendingMoves(dir, prod) {
  const since = sceneRenders(dir, prod)[0]?.at || 0;
  return Object.entries(overridesDoc(dir).scenes).flatMap(([scene, els]) => Object.entries(els)
    // Only moves made in the window count (Video Octopus stamps those with "at"); what Claude writes has none.
    .filter(([, o]) => o.at && Date.parse(o.at) > since).map(([el, o]) => ({ scene, el, o })));
}

// ---- "Apply my notes": the brief for the in-app Claude ----
export function applyBrief(dir, { preview = false, first = null } = {}) {
  const doc = notesDoc(dir);
  const prod = readProduction(dir);
  const all = doc.notes.filter((n) => n.status === 'open');
  const open = all.filter((n) => n.kind !== 'change');
  const changes = all.filter((n) => n.kind === 'change');
  const renders = sceneRenders(dir, prod);
  const since = renders[0]?.at || 0;
  const ov = overridesDoc(dir);
  const moves = Object.entries(ov.scenes).flatMap(([scene, els]) => Object.entries(els)
    .filter(([, o]) => !o.at || Date.parse(o.at) > since)
    .map(([el, o]) => `- ${scene === '*' ? 'every scene' : `scene ${scene}`} · ${o.label || el} (${el}): ${describeMove(o)}`));
  if (!open.length && !moves.length && !changes.length) throw new Error('The change package is empty: there are no new notes, changes or moves to send.');
  const [W, H] = frameOf(dir);
  const title = (id) => prod?.scenes.find((s) => s.id === id)?.title;
  const lines = [`Here is my change package for this video from Video Octopus: ${[open.length && `${open.length} note${open.length > 1 ? 's' : ''}`, changes.length && `${changes.length} change${changes.length > 1 ? 's' : ''}`, moves.length && `${moves.length} move${moves.length > 1 ? 's' : ''}`].filter(Boolean).join(', ')}. Start by confirming you have it (how many items, which scenes), then work through it.`];
  if (open.length) lines.push('', `Notes (in work/notes.json; I marked these ${open.length} as "sent"):`);
  for (const n of open) {
    const where = [n.scene ? `scene ${n.scene}${title(n.scene) ? ` "${title(n.scene)}"` : ''}` : 'whole video', n.t != null ? `at ${clock(n.t)}` : '',
      n.range ? `range ${clock(n.range[0])}–${clock(n.range[1])}` : '', n.version ? `on ${n.version}` : '',
      n.pos ? `pinned at x ${Math.round(n.pos.x * W)}, y ${Math.round(n.pos.y * H)} px of the ${W}×${H} frame` : '', n.el ? `on the element "${n.el.label}" (${n.el.id})` : '',
      n.on === 'canvas' ? 'on the canvas' : ''].filter(Boolean).join(' · ');
    lines.push(`- ${n.id} · ${where}: ${n.text.replace(/\s+/g, ' ')}`);
  }
  // The cut: say exactly what moved where, so everything on the old timeline can be re-aligned before rendering.
  for (const n of changes.filter((x) => x.field === 'cut')) {
    const ed = cutEdits(n.from.segments, n.to.segments);
    const before = `work/cut_before_${n.id}.json`;
    if (!preview) writeJSON(join(dir, before), { segments_sec: n.from.segments, note: `The cut before the change ${n.id} (Video Octopus's Cut tab); the cut now is work/edl_manual.json.` });
    lines.push('', `${n.id} · The cut changed in the Cut tab: ${ed.length} edit${ed.length === 1 ? '' : 's'}, ${clock2(cutLen(n.from.segments))} → ${clock2(cutLen(n.to.segments))}. The cut before is ${before}${preview ? ' (written when I send this)' : ''}, the cut now is work/edl_manual.json. Positions are on the old cut, the timeline the production sheet, the scene files and the renders use:`);
    for (const e of ed) lines.push(`- at ${clock2(e.at)}: ${e.kind === 'removed' ? 'removed' : 'brought back'} ${e.dur.toFixed(2)} s of the take (${clock2(e.take[0])}–${clock2(e.take[1])}); from here on everything sits ${Math.abs(e.shift).toFixed(2)} s ${e.shift < 0 ? 'earlier' : 'later'} than before`);
    if (n.retimed) lines.push(`Video Octopus already re-timed these to the new cut (copies of the old files in ${n.retimed.backup}/): ${n.retimed.files.join('; ')}. Sound cues (work/sfx.json) and blocks sit on the take and follow by themselves. Still to do: re-time the scene HTML and any compose or render scripts from ${before} to work/edl_manual.json (apply_edit.py: tools/cut/apply_edit.py in the studio folder, tools/cut-editor/apply_edit.py in a studio made before it moved; with --retime: python3 apply_edit.py ${before} work/edl_manual.json <the source> <new rough cut> --retime <files>; check the diff), and any B-roll or overlays placed by time. Tell me about anything that sat inside a removed part (moved to the next kept moment, or dropped). Then re-render the scenes the cut touched.`);
    else lines.push(prod
      ? `Before re-rendering, re-align everything that sits on the old timeline: the scene start/end times in work/production.json, the times in the scene HTML and any compose or render scripts (apply_edit.py: tools/cut/apply_edit.py in the studio folder, tools/cut-editor/apply_edit.py in a studio made before it moved; does this through the take with --retime: python3 apply_edit.py ${before} work/edl_manual.json <the source> <new rough cut> --retime <files>; check the diff), the keyframes and element times in work/overrides.json, the note times in work/notes.json, and any B-roll or overlays placed on the timeline. Sound cues (work/sfx.json) and blocks sit on the take and follow by themselves. Tell me about anything that sat inside a removed part (moved to the next kept moment, or dropped). Then re-render the scenes the cut touched.`
      : 'There are no scenes yet, so nothing needs re-aligning: just use the new cut from now on.');
  }
  const others = changes.filter((x) => x.field !== 'cut');
  if (others.length) {
    lines.push('', `Changes I made in Video Octopus (notes of kind "change" in work/notes.json, also marked "sent"). Update the production sheet's field for the scene where there is one (layout, transition_in, background, sfx, sfx_at, start/end), change the scene to match, and treat each like a note:`);
    for (const n of others) {
      const t = title(n.scene);
      const where = n.scene ? `scene ${n.scene}${t ? ` "${t}"` : ''}` : 'whole video';
      let what = `${FIELD_LABEL[n.field]}${n.target ? ` of ${n.target.label} (${n.target.id})` : ''}: ${showVal(n.from)} → ${showVal(n.to)}`;
      if (n.field === 'sfx') what = n.to?.add ? `add the sound "${n.to.add}"${n.to.file ? ` (library ${n.to.file})` : ''}${n.to.t != null ? ` at ${clock(n.to.t)}` : ''}` : `remove the sound "${n.to?.remove}"`;
      if (n.field === 'timing' && !n.target) what += " (move the scene boundary in the sheet and the scene's graphics timing; don't cut audio, the cut belongs to the Cut tab)";
      if (n.field === 'timing' && n.target) what += ' (when this element is on screen)';
      if (n.field === 'blocks') what = `${n.text} (the video's blocks in work/blocks.json; update the sections and scenes that follow from them: their order, which part of the take each scene uses, then re-render what moved)`;
      if (n.field === 'look') what = `${n.text} (the canvas look in project.json "layout"; keep the scenes' framing and backgrounds in line with it where they follow the canvas)`;
      if (n.field === 'enter' || n.field === 'leave') what = `${n.target ? `${n.target.label} (${n.target.id})` : 'the element'} ${n.field === 'enter' ? 'comes on screen' : 'goes off screen'}: ${n.from || 'as made'} → ${n.to || 'as made'} (its animation in the scene's code; keep its timing)`;
      if (n.field === 'level') what = `the sound "${n.target?.label || ''}": level ${dB(n.from)} → ${dB(n.to)} (dB on top of the default level, which sits about ${underVoiceDb()} dB under the voice; put it in the sheet's sfx_db)`;
      lines.push(`- ${n.id} · ${where}: ${what}`);
    }
  }
  if (moves.length) lines.push('', 'I also moved or resized these elements directly in Video Octopus (work/overrides.json; scenes that load the scene kit apply them by themselves when drawn, so re-rendering picks them up):', ...moves);
  const fs = first != null && prod?.scenes.find((x) => x.id === String(first));
  if (fs) lines.push('', `Show me scene ${fs.id} "${fs.title}" first: once its changes are in, render just that scene as a short preview (check stills, then the scene as a snippet in renders/, e.g. …_scene${fs.id}_preview.mp4), tell me where it is, and wait for my OK before the full render.`);
  lines.push('', 'Work through them in this project\'s own style: its pinned channel brand and format guide when it has them (its project context), else the studio\'s style notes (BRAND.md, STYLE.md when there is one, memory/style.md). Re-render only what changed (check stills or a short snippet first), then the video into renders/ with the next version number, on the same timeline, so Video Octopus shows the new render scene by scene. After each note, set its "status" to "done" in work/notes.json with a one-line "reply" saying what you changed (or status "question" with your question in "reply"). Don\'t change or remove other notes.');
  const text = lines.join('\n');
  if (preview) return { text, notes: open.length, changes: changes.length, moves: moves.length };
  const now = new Date().toISOString();
  for (const n of all) { n.status = 'sent'; n.sent_at = now; }
  saveNotes(dir, doc);
  return { text, notes: open.length, changes: changes.length, moves: moves.length };
}

function describeMove(o) {
  if (o.keys?.length) {
    const k = (x) => `${clock2(x.t)} (x ${x.dx >= 0 ? '+' : ''}${x.dx}, y ${x.dy >= 0 ? '+' : ''}${x.dy}, size ${Math.round((x.s ?? 1) * 100)}%, opacity ${Math.round((x.o ?? 1) * 100)}%${x.e ? `, ${x.e}` : ''})`;
    return `${o.keys.length} keyframe${o.keys.length > 1 ? 's' : ''}: ${o.keys.map(k).join(' → ')}`;
  }
  const parts = [];
  if (o.dx) parts.push(`${Math.abs(o.dx)} px ${o.dx > 0 ? 'right' : 'left'}`);
  if (o.dy) parts.push(`${Math.abs(o.dy)} px ${o.dy > 0 ? 'down' : 'up'}`);
  if (o.scale && o.scale !== 1) parts.push(`${Math.round(o.scale * 100)}% size`);
  return parts.join(', ') || 'back to where it was';
}

// Ask Claude to make an existing scene's elements movable (after copying the kit in).
export function kitBrief(dir) {
  const prod = readProduction(dir);
  const scene = sceneFileOf(dir, prod);
  if (!scene) throw new Error('This project has no scene HTML file (scene.html) yet.');
  const kit = installKit(dir);
  return `Make the elements of ${scene.file} movable in Video Octopus. I copied the Video Octopus scene kit to ${kit}. Load it in ${scene.file} before the scene's own script, call Octopus.use(<the 2D context>) and set Octopus.layers to the layer names seek(t, layer) takes (bottom to top), then draw each title, card, window and box inside Octopus.el('<stable-id>', [x, y, w, h], () => { ...the same drawing... }, { label: '<plain name>' }) with its box in the current drawing coordinates (HTML elements get data-studio="<id>" instead). Don't change how anything looks or moves. Check a few stills with the scene's renderer afterwards.`;
}

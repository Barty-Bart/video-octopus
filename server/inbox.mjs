// The Library inbox: pieces Claude proposes for the library (a scheduled run in "ask before changes" mode, or the
// Video Octopus assistant) wait in <library>/inbox/ until the creator adds them to a section or puts them aside.
// Layout: inbox/<run folder>/<piece>/ (a folder with a README.md saying what it is) or a single file; a piece can
// also sit straight in inbox/. "Put aside" moves it to inbox/.aside/, never deletes it.
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, renameSync, rmdirSync } from 'node:fs';
import { join, basename, relative, sep } from 'node:path';
import { libraryDir, KINDS, addIndexLine, freeName, typeOf } from './library.mjs';
import { inside } from './util.mjs';

export const inboxDir = () => join(libraryDir(), 'inbox');
const ASIDE = '.aside';
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const names = (d) => { try { return readdirSync(d).filter((n) => !n.startsWith('.')); } catch { return []; } };
const filesIn = (d, base = d, out = []) => { for (const n of names(d)) { const p = join(d, n); if (isDir(p)) filesIn(p, base, out); else out.push(relative(base, p).split(sep).join('/')); } return out; };
const readme = (d) => { for (const n of ['README.md', 'readme.md', 'README.txt']) { try { return readFileSync(join(d, n), 'utf8'); } catch {} } return ''; };

// Which section a piece most likely belongs in: a "kind:" line in its README, else by its files.
function guessKind(text, files) {
  const m = /^\s*(?:kind|section|type)\s*:\s*(\w+)/im.exec(text);
  const said = m && KINDS.find((k) => k.key === m[1].toLowerCase() || k.label.toLowerCase() === m[1].toLowerCase());
  if (said) return said.key;
  const types = files.map(typeOf);
  if (types.length && types.every((t) => t === 'audio')) return 'sfx';
  if (types.length && types.every((t) => t === 'video')) return 'broll';
  if (types.some((t) => t === 'html' || t === 'code')) return 'components';
  if (types.length && types.every((t) => t === 'image')) return 'stills';
  return 'components';
}
// One line saying what it is: the README's first sentence after any heading.
const summaryOf = (text) => (text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !/^(kind|section|type)\s*:/i.test(l)) || '').replace(/[*_`]/g, '').slice(0, 240);

function piece(abs, from) {
  const dir = isDir(abs), files = dir ? filesIn(abs) : [basename(abs)], text = dir ? readme(abs) : '';
  const rel = relative(inboxDir(), abs).split(sep).join('/');
  return { id: rel, name: basename(abs), from, folder: dir, files, readme: text.slice(0, 1500), summary: summaryOf(text), kind: guessKind(text, files.filter((f) => !/^readme\./i.test(f))), at: statSync(abs).mtimeMs };
}

export function inboxItems() {
  const root = inboxDir(), out = [];
  for (const n of names(root)) {
    const p = join(root, n);
    if (!isDir(p)) { out.push(piece(p, null)); continue; }
    // A folder with a README is a piece itself; otherwise it's a run's folder holding pieces.
    if (readme(p)) { out.push(piece(p, null)); continue; }
    for (const c of names(p)) out.push(piece(join(p, c), n));
  }
  return out.sort((a, b) => b.at - a.at);
}

const resolveItem = (id) => {
  const p = inside(inboxDir(), String(id || ''));
  if (!p || p === inboxDir() || String(id).split('/').includes(ASIDE) || !existsSync(p)) throw new Error('That piece is no longer in the inbox.');
  return p;
};
const tidy = (p) => { const parent = join(p, '..'); if (parent !== inboxDir() && !names(parent).length) { try { rmdirSync(parent); } catch {} } };

// Add to the library: the piece moves into the section (a folder stays a folder), with a line in its INDEX.md.
export function acceptItem(id, kind, note) {
  const src = resolveItem(id);
  if (!KINDS.some((k) => k.key === kind)) throw new Error('Pick a library section.');
  const it = piece(src, null), dir = join(libraryDir(), kind);
  const line = [note || it.summary || 'proposed by Claude', `from the inbox ${new Date().toISOString().slice(0, 10)}`].join(' · ');
  mkdirSync(dir, { recursive: true });
  // A component stays a folder. Other sections hold files: the piece's files move in, its README goes aside.
  if (it.folder && kind !== 'components') {
    const files = it.files.filter((f) => !/^readme\.(md|txt)$/i.test(basename(f)));
    if (!files.length) throw new Error('This piece has no files besides its README.');
    const moved = files.map((f) => { const name = freeName(dir, basename(f)); renameSync(join(src, f), join(dir, name)); addIndexLine(kind, name, line); return `${kind}/${name}`; });
    asideItem(id);
    return { file: moved[0], files: moved };
  }
  const name = freeName(dir, it.name);
  renameSync(src, join(dir, name));
  addIndexLine(kind, it.folder ? `${name}/` : name, line);
  tidy(src);
  return { file: `${kind}/${name}`, files: [`${kind}/${name}`] };
}

// Put aside: out of the inbox, kept in inbox/.aside/ (nothing is deleted).
export function asideItem(id) {
  const src = resolveItem(id);
  const dir = join(inboxDir(), ASIDE);
  mkdirSync(dir, { recursive: true });
  const name = freeName(dir, basename(src));
  renameSync(src, join(dir, name));
  tidy(src);
  return { ok: true, moved: `inbox/${ASIDE}/${name}` };
}

export async function inboxRoute(req, res, url, { send, body }) {
  const p = url.pathname;
  if (!p.startsWith('/api/library/inbox')) return false;
  try {
    if (p === '/api/library/inbox' && req.method === 'GET') return send(res, 200, { dir: inboxDir(), items: inboxItems(), kinds: KINDS.map(({ key, label }) => ({ key, label })) }), true;
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }), true;
    const b = await body(req);
    if (p === '/api/library/inbox/accept') return send(res, 200, acceptItem(b.id, b.kind, b.note)), true;
    if (p === '/api/library/inbox/aside') return send(res, 200, asideItem(b.id)), true;
    return send(res, 404, { error: 'Unknown inbox action' }), true;
  } catch (e) { return send(res, 400, { error: e.message }), true; }
}

// Packaging records (thumbnails now; titles and hooks later) in the studio database, and their readable projection in
// the project folder. SQLite is the authority; `<project>/packaging/` is regenerated from it:
//   PACKAGING.md     the title, main thumbnail, winners and shortlist with the creator's notes (agents read this)
//   packaging.json   { main, title, winners } (the rail's Package step is done when main is set)
//   thumbnails/      copies of the main thumbnail, winners and starred cards
//   RESOURCES.md     the resources this video can use, by level, and resources/<level>/ copies of their files
// Images live in the content-addressed file store. Copies are copy-on-write clones, never links.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ProfileStore } from './profile-store.mjs';
import { safeFile } from './learning-store.mjs';
import { scopeChain, visibleAt, parseScope, LEVELS, RESOURCE_LEVELS } from './scope-chain.mjs';
import { listResources, canAttach, RESOURCE_KINDS, LIKENESS } from './resource-store.mjs';
import { hashFile } from './file-store.mjs';

export const MAX_WINNERS = 3;
const STATUSES = new Set(['candidate', 'old', 'rejected']);
const ORIGINS = new Set(['sheet-cell', 'refined', 'uploaded', 'chat']);
const now = () => new Date().toISOString();
const fail = (message) => { throw new Error(message); };
const parse = (row) => (row ? JSON.parse(row.data) : null);
const short = (id) => String(id).replace(/-/g, '').slice(0, 8);
const LEVEL_FOLDER = { global: 'all-channels', profile: 'channel', format: 'format', project: 'this-video' };

export class PackagingStore extends ProfileStore {
  constructor(root) {
    super(root);
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS packaging_projects(project TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS packaging_sheets(id TEXT PRIMARY KEY, project TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS packaging_sheets_project ON packaging_sheets(project);
        CREATE TABLE IF NOT EXISTS packaging_items(id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS packaging_items_project ON packaging_items(project);
      `);
    } catch (e) { this.close(); throw e; }
  }

  // ---- the scope ladder and its resources ----
  // A project's channel and format come from its pinned setup (or its learning pin for older projects).
  projectIds(project) {
    const b = this.projectBundle(project) || {};
    const l = this.binding(project) || {};
    const formatId = b.formatId || l.formatId || null;
    let profileId = b.profileId || l.profileId || null;
    if (formatId && !profileId) profileId = this.get('formats', formatId).profileId;
    return { profileId, formatId, project };
  }
  resourceChain(project) {
    return scopeChain(this.projectIds(project), { levels: RESOURCE_LEVELS });
  }
  // The resources one video can use, each with the level it shows at (a record at a level that is switched off shows
  // under the nearest broader one, with `from`). Another channel's or video's resources are never in it.
  chainResources(project, { levels = RESOURCE_LEVELS } = {}) {
    const ids = this.projectIds(project);
    const out = [];
    for (const scope of scopeChain(ids, { levels: LEVELS })) {
      for (const r of listResources(this, [scope])) {
        const shown = visibleAt(r.scope, ids, { levels });
        if (shown) out.push({ ...r, shownAt: shown.shownAt, from: shown.from });
      }
    }
    return out;
  }

  // ---- records ----
  packagingMeta(project) {
    return parse(this.db.prepare('SELECT data FROM packaging_projects WHERE project=?').get(project)) || { project, title: '', main: null, revision: 0 };
  }
  saveMeta(project, patch) {
    const next = { ...this.packagingMeta(project), ...patch, project, updated: now() };
    next.revision = (next.revision || 0) + 1;
    this.db.prepare('INSERT INTO packaging_projects(project, data) VALUES(?, ?) ON CONFLICT(project) DO UPDATE SET data=excluded.data').run(project, JSON.stringify(next));
    return next;
  }
  item(project, id) {
    const x = parse(this.db.prepare('SELECT data FROM packaging_items WHERE id=? AND project=?').get(String(id), project));
    return x || fail('That card is no longer on the board.');
  }
  items(project) {
    return this.db.prepare('SELECT data FROM packaging_items WHERE project=? ORDER BY rowid').all(project).map(parse);
  }
  sheet(project, id) {
    return parse(this.db.prepare('SELECT data FROM packaging_sheets WHERE id=? AND project=?').get(String(id), project)) || fail('That sheet no longer exists.');
  }
  sheets(project) {
    return this.db.prepare('SELECT data FROM packaging_sheets WHERE project=? ORDER BY rowid').all(project).map(parse);
  }
  saveItem(x) {
    this.db.prepare('INSERT INTO packaging_items(id, project, kind, data) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(x.id, x.project, x.kind, JSON.stringify(x));
    return x;
  }
  saveSheet(x) {
    this.db.prepare('INSERT INTO packaging_sheets(id, project, data) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(x.id, x.project, JSON.stringify(x));
    return x;
  }

  // What the Packaging tab shows: the newest sheet or card first, a sheet's cards in their order 1–6, rejected last.
  board(project) {
    const meta = this.packagingMeta(project);
    const items = this.items(project).reverse();
    const group = new Map();
    for (const x of items) if (!group.has(x.sheet || x.id)) group.set(x.sheet || x.id, group.size);
    const rank = (x) => [x.status === 'rejected' ? 1 : 0, group.get(x.sheet || x.id), x.cell || 0];
    items.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
    });
    return {
      project, title: meta.title || '', main: meta.main || null, revision: meta.revision || 0,
      winners: items.filter((x) => x.winner).map((x) => x.id),
      items, sheets: this.sheets(project).reverse(), limits: { winners: MAX_WINNERS },
    };
  }

  // A Generate run: the sheet record exists before Codex answers, so a failure or a missing image is visible.
  createSheet(project, { brief = '', prompt = '', resources = [], grid, more = [] } = {}) {
    const s = { id: randomUUID(), project, status: 'running', grid, brief: String(brief).slice(0, 4000), prompt, more,
      resources: resources.map((r) => ({ id: r.id, hash: r.hash || null })), provider: 'codex', created: now() };
    return this.saveSheet(s);
  }
  failSheet(project, id, { message, kind = 'failed', resetsAt = null }) {
    const s = this.sheet(project, id);
    if (s.status !== 'running') return s;
    return this.saveSheet({ ...s, status: 'failed', failure: { kind, message, resetsAt }, finished: now() });
  }
  // The sheet image and its cards, in one transaction: cells = [{ n, box, stored: { sha256, size, ext }, size }].
  finishSheet(project, id, { stored, size, revisedPrompt, boxes, cells, problem = null, wire = null }) {
    return this.tx(() => {
      const s = this.sheet(project, id);
      const made = cells.map((c) => this.saveItem(this.newItem(project, {
        origin: 'sheet-cell', sheet: s.id, cell: c.n, box: c.box, stored: c.stored, size: c.size, prompt: s.prompt, revisedPrompt,
        resources: s.resources, name: `Idea ${c.n}`,
      })));
      return this.saveSheet({ ...s, status: 'done', hash: stored.sha256, ext: stored.ext, bytes: stored.size, size, revisedPrompt,
        boxes, items: made.map((x) => x.id), problem, wire, finished: now() });
    });
  }
  newItem(project, { origin, stored, size = null, status = 'candidate', parent = null, sheet = null, cell = null, box = null,
    prompt = '', revisedPrompt = null, resources = [], name = '', note = '', wire = null }) {
    if (!ORIGINS.has(origin)) fail('Unknown card origin.');
    if (!STATUSES.has(status)) fail('Unknown card status.');
    return { id: randomUUID(), project, kind: 'thumbnail', origin, status, parent, sheet, cell, box,
      hash: stored.sha256, ext: stored.ext || '.png', bytes: stored.size, size, prompt, revisedPrompt, provider: origin === 'uploaded' ? null : 'codex',
      resources, name: String(name).slice(0, 120), note: String(note).slice(0, 2000), star: false, winner: false, ...(wire ? { wire } : {}), created: now() };
  }
  addItem(project, fields) {
    if (fields.parent) this.item(project, fields.parent);
    return this.saveItem(this.newItem(project, fields));
  }

  // The board's marks. Winners are at most three; the main thumbnail is always one of them (choosing it adds it when
  // there is room). Rejecting a card takes it out of the winners and the main spot.
  mark(project, id, { star, winner, main, rejected, note } = {}) {
    return this.tx(() => {
      const x = this.item(project, id);
      let meta = this.packagingMeta(project);
      const next = { ...x };
      if (star !== undefined) next.star = Boolean(star);
      if (note !== undefined) {
        if (typeof note !== 'string' || note.length > 2000) fail('A note can be at most 2000 characters.');
        next.note = note.trim();
      }
      if (rejected !== undefined) {
        next.status = rejected ? 'rejected' : x.origin === 'uploaded' ? 'old' : 'candidate';
        if (rejected) { next.winner = false; next.star = false; }
      }
      if (main === true || winner === true) {
        if (next.status === 'rejected') fail('Bring the card back first.');
        if (!next.winner) {
          const count = this.items(project).filter((y) => y.winner && y.id !== x.id).length;
          if (count >= MAX_WINNERS) fail(`Up to ${MAX_WINNERS} winners. Take one out first.`);
          next.winner = true;
        }
      }
      if (winner === false) next.winner = false;
      this.saveItem(next);
      if (main === true) meta = this.saveMeta(project, { main: x.id });
      else if ((main === false || !next.winner) && meta.main === x.id) meta = this.saveMeta(project, { main: null });
      return { item: next, main: meta.main || null };
    });
  }
  setTitle(project, title) {
    if (typeof title !== 'string' || title.length > 200) fail('A title can be at most 200 characters.');
    return this.saveMeta(project, { title: title.replace(/\s+/g, ' ').trim() });
  }

  // ---- projections ----
  // PACKAGING.md, packaging.json and thumbnails/ for one project. Safe to run any time; only app-owned files change.
  writePackaging(project, dir) {
    const root = safeFile(dir, 'packaging');
    mkdirSync(root, { recursive: true });
    const b = this.board(project);
    const byId = new Map(b.items.map((x) => [x.id, x]));
    const files = new Map();
    const place = (x, name) => {
      if (!x || files.has(name)) return null;
      files.set(name, x);
      return `thumbnails/${name}`;
    };
    const main = b.main ? byId.get(b.main) : null;
    const mainPath = main ? place(main, `main${main.ext}`) : null;
    const winners = b.items.filter((x) => x.winner).map((x, i) => ({ x, path: place(x, `winner-${i + 1}${x.ext}`) }));
    const starred = b.items.filter((x) => x.star && !x.winner).map((x) => ({ x, path: place(x, `starred-${short(x.id)}${x.ext}`) }));
    this.syncFolder(safeFile(root, 'thumbnails'), files);
    const label = (x) => `${x.name || 'Card'}${x.origin === 'uploaded' ? ' (uploaded)' : ''}`;
    const line = ({ x, path }) => `- ${label(x)}: ${path}${x.note ? ` — the creator's note: ${x.note}` : ''}`;
    const rejected = b.items.filter((x) => x.status === 'rejected');
    const md = [
      '# Packaging',
      '',
      'Video Octopus writes this file from its database whenever the board changes. Do not edit it; the creator decides on the Packaging board.',
      '',
      `Title: ${b.title || '(none yet)'}`,
      `Main thumbnail: ${mainPath ? `${mainPath} (${label(main)})` : '(not chosen yet)'}`,
      '',
      `## Winners (up to ${MAX_WINNERS})`,
      ...(winners.length ? winners.map(line) : ['(none yet)']),
      '',
      '## Shortlisted (starred)',
      ...(starred.length ? starred.map(line) : ['(none)']),
      '',
      `## Rejected: ${rejected.length}`,
      ...rejected.filter((x) => x.note).map((x) => `- ${label(x)} — the creator's note: ${x.note}`),
      '',
    ].join('\n');
    writeAtomic(safeFile(root, 'PACKAGING.md'), md);
    writeAtomic(safeFile(root, 'packaging.json'), `${JSON.stringify({ main: b.main, title: b.title, winners: b.winners, updated: now() }, null, 2)}\n`);
    return { main: b.main };
  }

  // RESOURCES.md and resources/<level>/ copies for one project, from its live chain.
  writeResources(project, dir) {
    const root = safeFile(dir, 'packaging');
    mkdirSync(root, { recursive: true });
    const list = this.chainResources(project);
    const ids = this.projectIds(project);
    const files = new Map();
    const where = new Map();
    for (const r of list) {
      // Someone else's photo, or a resource marked "never", is listed but not copied where an agent could pick it up.
      if (!r.hash || r.likeness === 'other' || r.use === 'never') continue;
      const level = parseScope(r.shownAt)?.level || 'global';
      const path = `${LEVEL_FOLDER[level]}/${short(r.id)}-${r.name}`;
      files.set(path, r);
      where.set(r.id, `resources/${path}`);
    }
    this.syncFolder(safeFile(root, 'resources'), files);
    const levelName = (scope) => {
      const p = parseScope(scope);
      if (p.level === 'global') return 'All styles';
      if (p.level === 'profile') return `Style: ${ids.profileId ? this.get('profiles', ids.profileId).name : ''}`;
      if (p.level === 'format') return 'Format';
      return 'This video';
    };
    const uses = { always: 'use in every thumbnail', ask: 'use when it fits', never: 'do not use' };
    const sections = [];
    for (const scope of this.resourceChain(project)) {
      const rows = list.filter((r) => r.shownAt === scope);
      sections.push(`## ${levelName(scope)}`, '');
      if (!rows.length) sections.push('(nothing yet)', '');
      for (const r of rows) {
        const who = r.kind === 'note' ? '' : ` · who is in it: ${LIKENESS[r.likeness] || 'not said'}`;
        const send = r.kind === 'note' ? '' : canAttach(r) ? '' : ' · never send this picture to an image model';
        const body = r.kind === 'note' ? `\n  ${r.text.replace(/\n/g, '\n  ')}` : where.has(r.id) ? ` · ${where.get(r.id)}` : ' · kept in Video Octopus only';
        sections.push(`- **${r.name}** (${RESOURCE_KINDS[r.kind]}${who} · ${uses[r.use]}${send}${r.from ? ` · from ${r.from.split(':')[0]}` : ''})${r.note ? ` — ${r.note}` : ''}${body}`);
      }
      sections.push('');
    }
    const md = [
      '# Resources for this video',
      '',
      'Live: Video Octopus rewrites this file and resources/ whenever the creator changes a resource (Brand tab or the Packaging tab). Re-read it when the creator mentions new resources. Do not edit either.',
      'Open only the files you need. Photos marked "Someone else" or "never send" must never go to an image model.',
      '',
      ...sections,
    ].join('\n');
    writeAtomic(safeFile(root, 'RESOURCES.md'), md);
    return list;
  }

  // Make folder hold exactly these files (relative path → record with hash): clones from the file store; anything else
  // in the folder is removed (the folder is app-owned and named so in RESOURCES.md / PACKAGING.md).
  syncFolder(folder, files) {
    mkdirSync(folder, { recursive: true });
    const wanted = new Set(files.keys());
    for (const [rel, x] of files) {
      const dest = safeFile(folder, rel);
      if (existsSync(dest)) {
        try { if (this.sameFile(dest, x.hash)) continue; } catch {}
      }
      this.files.project(x.hash, dest);
    }
    const walk = (dir, prefix = '') => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) { walk(join(dir, e.name), rel); continue; }
        if (!wanted.has(rel)) rmSync(join(dir, e.name), { force: true });
      }
    };
    walk(folder);
  }
  sameFile(path, sha256) {
    return hashFile(path) === sha256;
  }
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

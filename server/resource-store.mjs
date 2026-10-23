// Resources: the files and notes a creator keeps for generation (photos of themselves, logos, shapes, reference
// thumbnails, fonts, style notes), each at one scope of the ladder (server/scope-chain.mjs): `global` (All channels),
// `profile:<id>` (a channel) or `project:<id>` (one video). SQLite holds the record (table `resources`); the bytes live
// in the content-addressed file store (`<studio>/.studio/files`, server/file-store.mjs). Resources stay live: a new or
// changed one reaches videos in progress (the project's packaging/RESOURCES.md is regenerated from here).
// Functions take an open store (LearningStore or a subclass: db, files, root, tx, meta, setMeta). No network, settings
// or agent processes.
import { randomUUID, createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseScope } from './scope-chain.mjs';
import { cleanFileName, extensionOf, mimeOf } from './file-store.mjs';

export const RESOURCE_KINDS = {
  photo: 'Photo',
  logo: 'Logo',
  image: 'Image or shape',
  reference: 'Reference thumbnail',
  font: 'Font',
  note: 'Style note',
};
// "Who is in it" (a photo must say): me, someone who agreed, someone else (never sent to an image model), nobody.
export const LIKENESS = {
  self: 'Me',
  permission: 'Someone who agreed',
  other: 'Someone else (never sent)',
  nobody: 'No people',
};
// always: attached to every Generate; ask: listed for the agent; never: kept here only.
export const USES = ['always', 'ask', 'never'];
export const MAX_RESOURCE_BYTES = 50 * 1024 * 1024;
export const MAX_RESOURCES_PER_SCOPE = 300;
const IMAGE = /\.(png|jpe?g|webp|gif|svg)$/i;
const FONT = /\.(ttf|otf|woff2?)$/i;
const SHA = /^[a-f0-9]{64}$/;

const now = () => new Date().toISOString();
const fail = (message) => { throw new Error(message); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const words = (value, max, label) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) fail(`${label} can be at most ${max} characters.`);
  return value.trim();
};

export function ensureResourceTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY, scope TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS resources_scope ON resources(scope);
  `);
}

export function checkResourceScope(scope) {
  const parsed = parseScope(scope);
  if (!parsed || parsed.level === 'format') fail('Choose All channels, a channel or a video for this resource.');
  return scope;
}

// Validated creator fields. A photo must say who is in it; other kinds default to "No people".
function cleanFields(input, previous = {}) {
  const kind = input.kind ?? previous.kind ?? 'image';
  if (!RESOURCE_KINDS[kind]) fail('Choose what kind of resource this is.');
  const likeness = input.likeness ?? previous.likeness ?? (kind === 'photo' ? null : 'nobody');
  if (kind === 'photo' && !['self', 'permission', 'other'].includes(likeness)) fail('Say who is in this photo.');
  if (likeness !== null && !LIKENESS[likeness]) fail('Choose who is in it.');
  const use = input.use ?? previous.use ?? 'ask';
  if (!USES.includes(use)) fail('Choose when to use this resource.');
  const name = words(input.name ?? previous.name, 180, 'The name');
  if (!name) fail('Give the resource a name.');
  return {
    name,
    kind,
    likeness,
    use,
    note: words(input.note ?? previous.note ?? '', 2000, 'The note'),
    tags: Array.isArray(input.tags ?? previous.tags) ? (input.tags ?? previous.tags).map((t) => words(t, 40, 'A tag')).filter(Boolean).slice(0, 12) : [],
  };
}

const parse = (row) => (row ? JSON.parse(row.data) : null);

export function getResource(store, id) {
  return parse(store.db.prepare('SELECT data FROM resources WHERE id=?').get(String(id))) || fail('That resource no longer exists.');
}

// Resources at these scopes, in the order they were added. Archived ones only when asked.
export function listResources(store, scopes, { archived = false } = {}) {
  const out = [];
  for (const scope of scopes) {
    for (const row of store.db.prepare('SELECT data FROM resources WHERE scope=? ORDER BY rowid').all(scope)) {
      const r = JSON.parse(row.data);
      if (archived || !r.archived) out.push(r);
    }
  }
  return out;
}

// Can this resource go to an image model as a picture? Images only, never "never", never someone else's likeness, and a
// photo only when it is the creator or someone who agreed.
export function canAttach(r) {
  if (!r || r.archived || !r.hash || !IMAGE.test(r.ext || '') || r.ext === '.svg') return false;
  if (r.use === 'never' || r.likeness === 'other' || r.likeness === null) return false;
  return r.kind !== 'photo' || ['self', 'permission'].includes(r.likeness);
}

// Add one resource: a file (tempPath on the same disk, or bytes) or, for a style note, text.
export function addResource(store, { scope, tempPath = null, bytes = null, text = null, source = { via: 'upload' }, id = null, ...fields }) {
  checkResourceScope(scope);
  const clean = cleanFields(fields);
  const count = store.db.prepare('SELECT count(*) n FROM resources WHERE scope=?').get(scope).n;
  if (count >= MAX_RESOURCES_PER_SCOPE) fail(`A level can hold at most ${MAX_RESOURCES_PER_SCOPE} resources.`);
  const record = { id: id || randomUUID(), scope, ...clean, source, created: now(), revision: 1, archived: false };
  if (clean.kind === 'note') {
    record.text = words(text, 20000, 'The note text');
    if (!record.text) fail('Write the style note.');
  } else {
    const fileName = cleanFileName(clean.name);
    const ext = extensionOf(fileName);
    if (!(clean.kind === 'font' ? FONT : IMAGE).test(ext)) fail(clean.kind === 'font' ? 'Choose a font file (.ttf, .otf, .woff, .woff2).' : 'Choose an image (.png, .jpg, .webp, .gif or .svg).');
    let stored;
    if (tempPath) {
      if (lstatSync(tempPath).size > MAX_RESOURCE_BYTES) fail('Resources can be at most 50 MB.');
      stored = store.files.putFile(tempPath, { ext, maxBytes: MAX_RESOURCE_BYTES });
    } else if (bytes) {
      if (bytes.length > MAX_RESOURCE_BYTES) fail('Resources can be at most 50 MB.');
      stored = store.files.putBuffer(bytes, { ext });
    } else fail('Choose a file.');
    Object.assign(record, { name: fileName, hash: stored.sha256, size: stored.size, ext, mime: mimeOf(fileName) });
  }
  store.db.prepare('INSERT INTO resources(id, scope, data) VALUES(?, ?, ?)').run(record.id, scope, JSON.stringify(record));
  return record;
}

// Change a resource's fields, or move it to another level (an explicit, logged change of its one scope string).
export function updateResource(store, id, { expected, scope, ...fields } = {}) {
  return store.tx(() => {
    const r = getResource(store, id);
    if (expected !== undefined && expected !== r.revision) fail('This resource changed. Reload first.');
    const next = { ...r, ...cleanFields(fields, r), revision: r.revision + 1, updated: now() };
    if (r.kind !== 'note' && next.kind === 'note') fail('A file cannot become a style note.');
    if (r.kind === 'note' && next.kind !== 'note') fail('A style note cannot become a file.');
    if (r.kind === 'note' && fields.text !== undefined) next.text = words(fields.text, 20000, 'The note text') || fail('Write the style note.');
    if (r.kind !== 'note' && fields.name !== undefined) next.name = cleanFileName(next.name);
    if (scope !== undefined && scope !== r.scope) {
      checkResourceScope(scope);
      next.scope = scope;
      next.moves = [...(r.moves || []), { from: r.scope, to: scope, at: now() }];
    }
    store.db.prepare('UPDATE resources SET scope=?, data=? WHERE id=?').run(next.scope, JSON.stringify(next), r.id);
    return next;
  });
}

export function archiveResource(store, id, { expected, archived = true } = {}) {
  return store.tx(() => {
    const r = getResource(store, id);
    if (expected !== undefined && expected !== r.revision) fail('This resource changed. Reload first.');
    const next = { ...r, archived: Boolean(archived), revision: r.revision + 1, updated: now() };
    store.db.prepare('UPDATE resources SET data=? WHERE id=?').run(JSON.stringify(next), r.id);
    return next;
  });
}

// The stored file's path, checked against its hash.
export function resourcePath(store, r) {
  if (!r?.hash) fail('This resource has no file.');
  return store.files.verify(r.hash);
}

// Every file-store hash a resource or a packaging record uses, with where (for the Storage page's unused report:
// these must never be listed as unused). Archived resources keep their file.
export function otherFileUses(db) {
  const has = (table) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const uses = [];
  if (has('resources')) {
    for (const row of db.prepare('SELECT data FROM resources').all()) {
      const r = JSON.parse(row.data);
      if (r.hash) uses.push({ sha256: r.hash, file: r.name, resource: r.id, scope: r.scope });
    }
  }
  for (const table of ['packaging_items', 'packaging_sheets']) {
    if (!has(table)) continue;
    for (const row of db.prepare(`SELECT project, data FROM ${table}`).all()) {
      const x = JSON.parse(row.data);
      if (x.hash) uses.push({ sha256: x.hash, file: x.file || `${x.id}${x.ext || '.png'}`, packaging: row.project });
    }
  }
  return uses.filter((u) => SHA.test(u.sha256));
}

// ---- Phase 0: brand assets used to be SQLite blobs (profile_assets). They move once to `resources` at
// profile:<id> with the bytes in the file store, keeping their ids (brand versions name them). The database is backed
// up first; each file is written and verified; only then are the blob rows removed, in one transaction. Safe to run
// again and to resume after a crash (a moved row is recognised by its id and hash). ----
export function migrateProfileAssets(store, { fault } = {}) {
  if (store.meta('profile-assets-migration') === 'done') return { moved: 0, done: true };
  try {
    return moveProfileAssets(store, fault);
  } catch (e) {
    if (fault) throw e;
    // The studio still opens: unmoved assets are read from SQLite and moved on the next attempt.
    console.error('Brand asset migration will retry:', e.message);
    return { moved: 0, done: false, error: e.message };
  }
}

function moveProfileAssets(store, fault) {
  const has = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='profile_assets'").get();
  const rows = has ? store.db.prepare('SELECT id, profile_id, name, hash FROM profile_assets ORDER BY rowid').all() : [];
  if (!rows.length) {
    store.setMeta('profile-assets-migration', 'done');
    return { moved: 0, done: true };
  }
  if (!store.meta('profile-assets-migration-backup')) {
    const backup = join(store.root, '.studio', 'profile-assets-migration-backups', randomUUID(), 'studio.sqlite');
    mkdirSync(dirname(backup), { recursive: true });
    store.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    store.setMeta('profile-assets-migration-backup', backup);
    store.setMeta('profile-assets-migration-started', now());
    store.setMeta('profile-assets-migration', 'running');
  }
  fault?.('after-backup');
  const moved = [], problems = [];
  for (const [i, row] of rows.entries()) {
    const existing = parse(store.db.prepare('SELECT data FROM resources WHERE id=?').get(row.id));
    if (existing && existing.hash === row.hash && store.files.has(row.hash)) {
      store.files.verify(row.hash);
      moved.push(row);
      continue;
    }
    const bytes = store.db.prepare('SELECT bytes FROM profile_assets WHERE id=?').get(row.id).bytes;
    if (sha256(bytes) !== row.hash) { problems.push(row.id); continue; }
    // The name stays exactly as it was: pinned projects' context files are named after it.
    const ext = extensionOf(row.name);
    const stored = store.files.putBuffer(bytes, { ext, expect: row.hash });
    store.files.verify(stored.sha256);
    if (!existing) {
      const record = {
        id: row.id, scope: `profile:${row.profile_id}`, name: row.name, kind: FONT.test(ext) ? 'font' : 'image',
        likeness: 'nobody', use: 'ask', note: '', tags: [], hash: row.hash, size: bytes.length, ext, mime: mimeOf(row.name),
        source: { via: 'migration', from: 'profile_assets' }, created: now(), revision: 1, archived: false,
      };
      store.db.prepare('INSERT INTO resources(id, scope, data) VALUES(?, ?, ?)').run(record.id, record.scope, JSON.stringify(record));
    }
    moved.push(row);
    fault?.(`after-file-${i}`);
  }
  fault?.('before-drop');
  store.tx(() => {
    for (const row of moved) {
      store.files.verify(row.hash);
      store.db.prepare('DELETE FROM profile_assets WHERE id=?').run(row.id);
    }
    if (problems.length) store.setMeta('profile-assets-migration-problems', JSON.stringify(problems));
    store.setMeta('profile-assets-migration-finished', now());
    if (!problems.length) store.setMeta('profile-assets-migration', 'done');
  });
  // Give the space back. Best effort: another open connection can make SQLite refuse, which is harmless.
  try { store.db.exec('VACUUM'); } catch {}
  return { moved: moved.length, problems, done: !problems.length };
}

// The bytes of a resource file (brand assets are small; packaging uses the stored path instead).
export const resourceBytes = (store, r) => readFileSync(resourcePath(store, r));

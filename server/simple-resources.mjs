// Simple mode's Resources page (V1 spec §4, board "V1 Resources"): the built-in brand ("My brand", LearningStore
// builtinProfile) and one grid of files. Nothing new is stored here; this module only joins what exists:
//   - Your look = brand versions on the built-in profile (ProfileStore saveBrand / commitBrand): colours (the first is
//     the kit colour, web/kit-colors.js), fonts, voice, and as its assets the logo and font files of the grid.
//     "Get my look from my website" is the existing brand research (B12) on that profile; its proposal is only saved
//     when the creator approves it here (ProfileStore approveResearch).
//   - Files = resources (server/resource-store.mjs) at the built-in profile's level, profile:<id> (the scope ladder,
//     server/scope-chain.mjs), bytes in the file store. Kinds: web/resource-kinds.js.
//   - Remove = the resource is archived (never deleted) and an entry goes to the studio's trash
//     (<studio>/.trash/<when>-<name>/manifest.json, kind "resource-removed"): Undo here, or Put back in
//     Settings › Storage › Trash (server/trash.mjs), unarchives it.
// What agents see is what they see for any kit's resources: every change rewrites packaging/RESOURCES.md and
// packaging/resources/ (PackagingStore writeResources) of the videos on the built-in profile, and their pinned context
// (ProfileStore contextText) points the project chat there. A new look reaches the videos on the built-in profile that
// have no Build yet (their pin follows, like the shape chip's rule); built videos keep the look they were built with.
//
// Routes (/api/simple-resources…):
//   GET  /api/simple-resources                         → view(): { profileId, look, brandVersion, files, research }
//   GET  /api/simple-resources/<id>/file               → the file, with ranges (previews: images, fonts, clips)
//   POST /api/simple-resources/profile                 → { profileId } (made the first time, for brand research)
//   POST /api/simple-resources/upload?name=&kind=      → the new file (raw body; checked against its extension)
//   POST /api/simple-resources/<id> { name?, kind?, expected } → renamed / another kind
//   POST /api/simple-resources/<id>/remove { expected } → { trash, file }
//   POST /api/simple-resources/restore { trash }       → the file again (Undo)
//   POST /api/simple-resources/look { colors, fonts, voice, expected } → the new brand version
//   POST /api/simple-resources/research/<id>/approve { revision, token } → the approved brand version
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { PackagingStore } from './packaging-store.mjs';
import { cleanBrand } from './profile-store.mjs';
import { settings, readJSON } from './util.mjs';
import { settingsChanged } from './settings.mjs';
import { listProjects, projectDir, projectMeta, saveProjectMeta, appendWorklog } from './studio.mjs';
import { addResource, updateResource, archiveResource, getResource, listResources, maxBytesFor } from './resource-store.mjs';
import { mimeOf } from './file-store.mjs';
import { sniff } from './brand.mjs';
import { trashRoot, TRASH_NAME, newTrashEntry } from './browser-recorder.mjs';
import { projectBuilt } from './profiles.mjs';
import { BUILTIN } from './learning-store.mjs';
import { SIMPLE_KINDS, simpleKindOf, resourceFields, fitsKind, renamed, lookColors } from '../web/resource-kinds.js';

export const TRASH_KIND = 'resource-removed';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const use = (fn) => { const s = new PackagingStore(settings().studio || fail('Choose a studio folder first.')); try { return fn(s); } finally { s.close(); } };
const scopeOf = (pid) => `profile:${pid}`;
// The built-in profile if it exists (a read never makes it), or the one made now (create: true).
const builtin = (s, create = false) => (create ? s.builtinProfile() : s.list('profiles').find((p) => p.system === BUILTIN) || null);

// One file as the grid shows it.
function tile(r) {
  const kind = simpleKindOf(r);
  return {
    id: r.id, name: r.name, kind, other: kind ? null : r.kind, line: kind ? SIMPLE_KINDS[kind].line : 'Added in a video',
    ext: r.ext || '', mime: r.mime || mimeOf(r.name), size: r.size || 0, revision: r.revision, created: r.created,
  };
}

// The look and its files' ids: the logo and font files of the grid are the look's assets.
const lookAssets = (s, pid) => listResources(s, [scopeOf(pid)]).filter((r) => r.hash && ['logo', 'font'].includes(r.kind)).map((r) => r.id);

export function view(s) {
  const p = builtin(s);
  if (!p) return { profileId: null, look: { colors: [], fonts: '', voice: '', assets: [] }, brandVersion: null, files: [], research: null };
  const head = s.brand(p.id), b = head?.brand || {};
  const files = listResources(s, [scopeOf(p.id)]).filter((r) => r.hash).map(tile).reverse(); // newest first
  const last = s.list('brand_research').filter((r) => r.profileId === p.id).at(-1) || null;
  return {
    profileId: p.id,
    look: { colors: b.colors || [], fonts: b.fonts || '', voice: b.voice || '', assets: b.assets || [] },
    brandVersion: head?.id || null,
    files,
    research: last ? { id: last.id, url: last.url, status: last.status, error: last.error || null, revision: last.revision } : null,
  };
}

// ---- after a change: the look's assets, the videos' pins, their RESOURCES.md ----
// The look names the grid's logo and font files (a brand version's assets). A change to them is a new version.
function syncLookAssets(s, pid) {
  const head = s.brand(pid), want = lookAssets(s, pid);
  const have = head?.brand.assets || [];
  if (JSON.stringify([...want].sort()) === JSON.stringify([...have].sort())) return head;
  if (!head && !want.length) return null;
  return s.saveBrand(pid, { ...(head?.brand || {}), assets: want }, head?.id || null, 'Logo and fonts changed in Resources');
}

// Videos on the built-in profile with no Build yet take the current look (their pinned brand version follows), the
// same re-pin the shape chip and Repair use: database pin, project.json and the context files together, or not at all.
export function followLook(s, pid) {
  const head = s.brand(pid);
  if (!head) return [];
  const moved = [];
  for (const p of listProjects()) {
    const b = s.projectBundle(p.id), dir = projectDir(p.id);
    if (!b || !dir || b.profileId !== pid || b.brandVersion === head.id) continue;
    const meta = projectMeta(dir) || {};
    if (projectBuilt(dir, meta.type)) continue;
    const next = s.validateBundle({ ...b, brandVersion: head.id });
    let files = null;
    try {
      s.tx(() => {
        s.pinContext(p.id, next);
        files = s.replaceProjectFiles(p.id, dir, 'before-look');
        saveProjectMeta(dir, { context: next });
      });
      appendWorklog(dir, 'Your look changed in Resources: this video uses the new one from now on.');
      moved.push(p.id);
    } catch (e) {
      files?.undo();
      console.error(`Resources look for ${p.id}:`, e.message);
    }
  }
  return moved;
}

// packaging/RESOURCES.md and packaging/resources/ of every video on the built-in profile (or just these ids).
export function refreshVideos(s, pid, ids = null) {
  const out = [];
  for (const p of listProjects()) {
    if (ids && !ids.includes(p.id)) continue;
    const dir = projectDir(p.id);
    if (!dir) continue;
    try {
      if (s.projectIds(p.id).profileId !== pid) continue;
      s.writeResources(p.id, dir);
      out.push(p.id);
    } catch (e) { console.error(`Resources for ${p.id}:`, e.message); }
  }
  return out;
}

function changed(s, pid, { look = false } = {}) {
  syncLookAssets(s, pid);
  const moved = followLook(s, pid);
  refreshVideos(s, pid);
  if (look || moved.length) settingsChanged('profile'); // chats pick up the new context when they're idle
  return moved;
}

// A Simple video was made: its RESOURCES.md is there from the start.
export function resourcesForNewVideo(id) {
  if (!settings().studio) return;
  try { use((s) => { const p = builtin(s); if (p) refreshVideos(s, p.id, [id]); }); } catch (e) { console.error('Resources:', e.message); }
}

// ---- the files ----
const own = (s, pid, id) => {
  const r = getResource(s, id);
  if (r.scope !== scopeOf(pid) || !r.hash) fail('That file isn’t one of your Resources.', 404);
  return r;
};

export function addFile(s, { tempPath, name, kind }) {
  const p = builtin(s, true);
  if (!SIMPLE_KINDS[kind]) fail('Choose what this is: logo, font, photo of you, product or clip.');
  if (!fitsKind(String(name || ''), kind)) fail(kind === 'font' ? 'A font is a .ttf, .otf, .woff or .woff2 file.' : kind === 'clip' ? 'A clip is an .mp4, .mov, .m4v or .webm file.' : 'Choose a picture (.png, .jpg, .webp, .gif or .svg).');
  // Does the start of the file look like its extension says? (So a renamed program never lands as a "logo".)
  const ext = String(name).slice(String(name).lastIndexOf('.') + 1).toLowerCase();
  const head = Buffer.alloc(65536), fd = openSync(tempPath, 'r');
  let n = 0;
  try { n = readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
  if (!n) fail('The file was empty.');
  if (!sniff(ext, head.subarray(0, n))) fail(`That doesn’t look like a .${ext} file.`);
  const r = addResource(s, { scope: scopeOf(p.id), tempPath, name, ...resourceFields(kind), note: '', source: { via: 'resources-page' } });
  changed(s, p.id);
  return tile(r);
}

export function editFile(s, id, { name, kind, expected } = {}) {
  const p = builtin(s) || fail('That file isn’t one of your Resources.', 404);
  const r = own(s, p.id, id);
  const patch = { expected };
  if (name !== undefined) patch.name = renamed(name, r.ext);
  if (kind !== undefined) {
    if (!fitsKind(r.name, kind)) fail(kind === 'font' || kind === 'clip' || r.kind === 'font' || r.kind === 'clip' ? 'Only a picture can be a logo, a photo of you or a product.' : 'That kind doesn’t fit this file.');
    Object.assign(patch, resourceFields(kind));
  }
  const next = updateResource(s, id, patch);
  changed(s, p.id);
  return tile(next);
}

// Remove: archived (the record and its file stay), with an entry in the studio's trash that says what it was.
export function removeFile(s, id, { expected } = {}) {
  const p = builtin(s) || fail('That file isn’t one of your Resources.', 404);
  const r = own(s, p.id, id);
  if (r.archived) fail('That file is removed already.');
  if (expected !== undefined && expected !== r.revision) fail('This file changed. Reload first.');
  const entry = newTrashEntry(r.name.replace(/[^\w .()-]/g, '_').slice(0, 100) || 'resource');
  const root = join(trashRoot(), entry);
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ v: 1, kind: TRASH_KIND, at: Date.now(), item: r.name, resource: r.id, scope: r.scope, size: r.size || 0 }, null, 2));
  try { archiveResource(s, id, { expected: r.revision }); } catch (e) { rmSync(root, { recursive: true, force: true }); throw e; } // only the manifest just written
  changed(s, p.id);
  return { trash: entry, file: tile(r) };
}

// The trash entry of a removed file, or why it can't come back.
function entryOf(entry) {
  if (!TRASH_NAME.test(String(entry || ''))) fail('That isn’t in the trash any more.');
  const root = join(trashRoot(), entry), m = readJSON(join(root, 'manifest.json'), null);
  if (!m || m.kind !== TRASH_KIND) fail('That isn’t a file removed from Resources.');
  return { root, m };
}
export function whyNotBack(s, m) {
  let r;
  try { r = getResource(s, m.resource); } catch { return 'Its record isn’t in the studio any more.'; }
  if (!r.archived) return 'It’s back in Resources already.';
  return null;
}
// Undo, and the Trash page's Put back: the file is in Resources again; its trash entry (a manifest only) goes.
export function restoreFile(s, entry) {
  const { root, m } = entryOf(entry);
  const why = whyNotBack(s, m);
  if (why) fail(why, 409);
  const back = archiveResource(s, m.resource, { archived: false });
  rmSync(root, { recursive: true, force: true });
  const pid = back.scope.startsWith('profile:') ? back.scope.slice('profile:'.length) : null;
  if (pid) changed(s, pid);
  return { file: tile(back), kind: TRASH_KIND };
}
// For server/trash.mjs (no store of its own): describe and put back an entry of this kind.
export const describeRemoved = (m) => { try { return use((s) => whyNotBack(s, m)); } catch (e) { return e.message; } };
export const putBackRemoved = (entry) => use((s) => restoreFile(s, entry));

// ---- the look ----
export function saveLook(s, { colors, fonts, voice, expected } = {}) {
  const p = builtin(s, true);
  const head = s.brand(p.id);
  const list = Array.isArray(colors) ? lookColors(colors[0], colors.slice(1)) : head?.brand.colors || [];
  const brand = {
    ...(head?.brand || {}),
    colors: list,
    fonts: fonts === undefined ? head?.brand.fonts || '' : String(fonts).slice(0, 400),
    voice: voice === undefined ? head?.brand.voice || '' : String(voice).slice(0, 400),
    assets: lookAssets(s, p.id),
  };
  const v = s.saveBrand(p.id, brand, expected ?? null, 'Your look, edited in Resources');
  changed(s, p.id, { look: true });
  return v;
}

// Approve the brand research's proposal as the look, with its evidence kept and the grid's logo and font files as its
// assets. The same checks as ProfileStore approveResearch (the reviewed proposal, not one still running), but it goes
// on top of the current look: a logo uploaded or a colour edited while Claude was reading is no reason to refuse.
export function approveLook(s, researchId, { revision, token } = {}) {
  const p = builtin(s) || fail('Start with Get my look from my website.');
  const r = s.researchGet(researchId);
  if (r.profileId !== p.id) fail('That research belongs to another brand.');
  const proposal = s.researchProposal(researchId);
  if (r.status === 'running' || r.status === 'approved' || revision !== r.revision || token !== proposal.token) fail('Research changed or is still running. Review again.');
  const brand = cleanBrand({ ...proposal.brand, assets: lookAssets(s, p.id) });
  const v = s.tx(() => {
    const version = s.commitBrand(p.id, brand, s.brand(p.id)?.id || null, 'Approved brand research (Resources)');
    s.update('brand_research', { ...r, status: 'approved', approvedVersion: version.id, revision: r.revision + 1 });
    return version;
  });
  changed(s, p.id, { look: true });
  return v;
}

// ---- the route ----
async function receive(req, dest, max) {
  let size = 0;
  const limit = new Transform({ transform(chunk, enc, done) { size += chunk.length; if (size > max) done(Object.assign(new Error(max > 1e9 ? 'A clip can be at most 2 GB.' : 'Files can be at most 50 MB.'), { status: 413 })); else done(null, chunk); } });
  await pipeline(req, limit, createWriteStream(dest));
  return size;
}

// A file for the page's preview: never run as a page (an SVG's scripts stay off), with ranges for clips.
function serveFile(req, res, path, r) {
  const st = statSync(path);
  const head = { 'Content-Type': r.mime || mimeOf(r.name), 'Cache-Control': 'private, max-age=31536000, immutable', 'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" };
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return createReadStream(path, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, 'Content-Length': st.size });
  createReadStream(path).pipe(res);
}

export async function simpleResourcesRoute(req, res, url, { send, body }) {
  const parts = url.pathname.split('/').slice(3).map(decodeURIComponent); // /api/simple-resources/<id>/<action>
  const reply = (data, status = 200) => { send(res, status, data); return true; };
  try {
    if (req.method === 'GET') {
      if (parts[0] && parts[1] === 'file') {
        // The stored file by its hash (its full check runs when it is stored and when it is copied to a video).
        const { r, path } = use((s) => { const p = builtin(s) || fail('Not found.', 404); const x = own(s, p.id, parts[0]); return { r: x, path: s.files.locate(x.hash) }; });
        if (!path || !existsSync(path)) fail('Not found.', 404);
        serveFile(req, res, path, r);
        return true;
      }
      if (parts.length) return reply({ error: 'Not found.' }, 404);
      return reply(use(view));
    }
    if (req.method !== 'POST') return reply({ error: 'POST required.' }, 405);
    if (parts[0] === 'upload') {
      const q = Object.fromEntries(url.searchParams);
      if (!SIMPLE_KINDS[q.kind]) fail('Choose what this is: logo, font, photo of you, product or clip.');
      const studio = settings().studio || fail('Choose a studio folder first.');
      const tmp = join(studio, '.studio', 'resources-tmp', randomUUID());
      mkdirSync(tmp, { recursive: true });
      try {
        const file = join(tmp, 'upload');
        await receive(req, file, maxBytesFor(SIMPLE_KINDS[q.kind].kind));
        return reply(use((s) => addFile(s, { tempPath: file, name: q.name, kind: q.kind })));
      } finally { rmSync(tmp, { recursive: true, force: true }); } // the upload's own temporary copy
    }
    const b = await body(req);
    if (parts[0] === 'profile' && parts.length === 1) return reply(use((s) => ({ profileId: builtin(s, true).id })));
    if (parts[0] === 'look' && parts.length === 1) return reply(use((s) => saveLook(s, b)));
    if (parts[0] === 'restore' && parts.length === 1) return reply(use((s) => restoreFile(s, String(b.trash || ''))));
    if (parts[0] === 'research' && parts[2] === 'approve') return reply(use((s) => approveLook(s, parts[1], b)));
    if (parts[0] && parts[1] === 'remove') return reply(use((s) => removeFile(s, parts[0], b)));
    if (parts[0] && parts.length === 1) return reply(use((s) => editFile(s, parts[0], b)));
    return reply({ error: 'Unknown Resources action.' }, 404);
  } catch (e) { return reply({ error: e.message }, e.status || 400); }
}

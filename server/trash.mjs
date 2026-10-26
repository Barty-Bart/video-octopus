// The studio's trash (Settings › Storage › Trash), and the Recordings page's Delete.
//
// Three things move files to <studio>/.trash/<when>-<name>/, each with a manifest.json saying where everything was:
// - the record panel's Delete take and the Recordings page's Delete (kind "deleted", browser-recorder.mjs deleteTake);
// - the record panel's Restart (kind "discarded": the parts of a take that was never saved);
// - the editor's Media section, Remove from this video and Delete recording (kind "media-removed", media.mjs; a deleted
//   recording's entry also holds the recordings folder's copy, as take/);
// - the Resources page's Remove (kind "resource-removed", simple-resources.mjs): the resource is archived and its entry
//   holds only a manifest (the file stays in the studio's file store); Put back unarchives it.
// Delete recording and the Recordings page's Delete then send their entry on to the computer's own Bin (os-trash.mjs):
// the Trash on a Mac, the Recycle Bin on Windows. When no Bin takes it, it stays here and the toast says so; Finder's
// Put Back returns an entry here, where Put back works as usual.
// Nothing in Video Octopus deletes them by itself. Here the creator sees what's there and how big it is, puts an item
// back (the same Undo as where it came from, so a target that exists again is refused and the canvas take only goes
// back if nobody changed it since), and empties the trash: the only permanent delete in the app, and only on an
// explicit request ({ confirm: true }), all of it or the items older than some days.
//
// Routes (POST unless said):
// - GET /api/trash: { items, count, bytes, where }.
// - /api/trash/restore { trash }: put one item back.
// - /api/trash/empty { confirm: true, olderThanDays? }: delete for good; { removed, bytes }.
// - /api/takes/delete { take, confirm }: the Recordings page's Delete. The take's folder moves to the trash and from there
//   to the computer's Bin; refused while it is recording or saving. When videos use it they're named and it asks first
//   (409 { ok: false, confirm }): each keeps its own copy in its source/.
// - /api/takes/restore { trash }: its Undo (while it's still in the studio's trash).
// - /api/trash/from-bin { token }: the Undo of a delete that went to the Bin, for a few minutes, when the Bin said where
//   it put it: the entry comes back here, then is put back as above.
import { existsSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readJSON, settings } from './util.mjs';
import { projectDir, projectMeta } from './studio.mjs';
import { trashRoot, TRASH_NAME, deleteTake, restoreTake } from './browser-recorder.mjs';
import { restoreMedia } from './media.mjs';
import { sendToBin, binName, rememberUndo, undoFromBin } from './os-trash.mjs';
import { TRASH_KIND as RESOURCE_REMOVED, describeRemoved, putBackRemoved } from './simple-resources.mjs';

const DAY = 86400000;
const refuse = (message) => Object.assign(new Error(message), { status: 409 });

// A real folder inside the trash (never a link out of it).
const isEntry = (n) => {
  if (!TRASH_NAME.test(n)) return false;
  try { return lstatSync(join(trashRoot(), n)).isDirectory(); } catch { return false; }
};

// Bytes in a folder, not following links.
function sizeOf(path) {
  let st;
  try { st = lstatSync(path); } catch { return 0; }
  if (!st.isDirectory()) return st.isFile() ? st.size : 0;
  let total = 0;
  try { for (const n of readdirSync(path)) total += sizeOf(join(path, n)); } catch {}
  return total;
}

const videoName = (id) => {
  const dir = id ? projectDir(id) : null;
  return dir ? projectMeta(dir)?.name || id : null;
};

// One entry as the Trash list shows it: what it was, where it came from, and whether Put back can work now.
function describe(n) {
  const root = join(trashRoot(), n), m = readJSON(join(root, 'manifest.json'), null);
  let at = m?.at || 0;
  if (!at) { try { at = lstatSync(root).mtimeMs; } catch {} }
  const item = { trash: n, at, bytes: sizeOf(root), kind: m?.kind || 'unknown', name: m?.item || m?.take || n, project: m?.project || null };
  const video = item.project ? videoName(item.project) : null;
  if (m?.kind === 'deleted') {
    item.what = m.project ? `Deleted take, was in “${video || m.projectName || m.project}”` : 'Deleted take, from Recordings';
    if (m.project && !video) item.why = 'Its video is gone or archived, so it can’t go back there.';
    else if (!existsSync(join(root, 'take')) && !m.project) item.why = 'Its files aren’t in the trash any more.';
  } else if (m?.kind === 'media-removed') {
    item.what = m.take ? `Deleted recording, was in “${video || m.project}” and Recordings` : m.parked ? `Removed from “${video || m.project}”; the file waits in Recordings` : `Removed from “${video || m.project}”`;
    if (!video) item.why = 'Its video is gone or archived, so it can’t go back there.';
    // An imported file taken off its video (A17) is in the recordings folder, not here; Put back fetches it from there.
    else if (m.parked && !existsSync(join(settings().recordingsDir, m.parked.folder))) item.why = 'Its file isn’t in Recordings any more: a video uses it now, or it was deleted.';
  } else if (m?.kind === RESOURCE_REMOVED) {
    item.what = 'Removed from Resources';
    const why = describeRemoved(m);
    if (why) item.why = why;
  } else if (m?.kind === 'discarded') {
    item.what = 'Dropped by Restart while recording';
    item.why = 'It was never saved as a take, so there’s nothing to put back.';
  } else {
    item.what = 'Unknown item';
    item.why = 'Video Octopus doesn’t know where this came from.';
  }
  item.restorable = !item.why;
  return item;
}

export function trashView() {
  let names = [];
  try { names = readdirSync(trashRoot()); } catch {}
  const items = names.filter(isEntry).map(describe).sort((a, b) => b.at - a.at);
  return { items, count: items.length, bytes: items.reduce((t, x) => t + x.bytes, 0), where: trashRoot() };
}

// Put back: the Undo of wherever it came from. busy(id, dir): why that video's files can't change now, or null.
export function putBack(entry, { busy = () => null } = {}) {
  if (!isEntry(String(entry || ''))) throw new Error('That isn’t in the trash any more.');
  const m = readJSON(join(trashRoot(), entry, 'manifest.json'), null);
  if (m?.kind === 'deleted') {
    const dir = m.project ? projectDir(m.project) : null;
    if (m.project && !dir) throw refuse('Its video is gone or archived, so it can’t go back there.');
    const why = dir ? busy(m.project, dir) : null;
    if (why) throw refuse(why);
    return { ...restoreTake(m.project || null, entry), kind: m.kind };
  }
  if (m?.kind === 'media-removed') {
    const dir = projectDir(m.project);
    if (!dir) throw refuse('Its video is gone or archived, so it can’t go back there.');
    return { ...restoreMedia(dir, entry, { busy: busy(m.project, dir) }), kind: m.kind, project: m.project };
  }
  if (m?.kind === RESOURCE_REMOVED) return putBackRemoved(entry);
  throw refuse(describe(entry).why || 'That can’t be put back.');
}

// Empty the trash: the one permanent delete. Only on { confirm: true }; olderThanDays keeps the newer items.
export function emptyTrash({ confirm = false, olderThanDays = null } = {}) {
  if (confirm !== true) throw new Error('Emptying the trash deletes its files for good, so it needs your confirmation.');
  const days = olderThanDays == null ? null : Number(olderThanDays);
  if (days !== null && !(days >= 1 && days <= 3650)) throw new Error('Pick a number of days between 1 and 3650.');
  const cutoff = days === null ? Infinity : Date.now() - days * DAY;
  let removed = 0, bytes = 0;
  for (const item of trashView().items) {
    if (!(item.at < cutoff)) continue;
    rmSync(join(trashRoot(), item.trash), { recursive: true, force: true });
    removed++;
    bytes += item.bytes;
  }
  return { ok: true, removed, bytes };
}

// Delete recording's and Recordings' last step: the whole entry goes to the computer's Bin. null when no Bin took it (it
// stays in the studio's trash); else { where: 'the Trash', how, undo: a token for /api/trash/from-bin or null }.
export async function binEntry(entry) {
  if (!isEntry(String(entry || ''))) return null;
  const root = join(trashRoot(), entry);
  let r = null;
  try { r = await sendToBin(root); } catch (e) { console.error(`Moving to the Bin failed: ${e.message}`); }
  if (!r || existsSync(root)) return null;
  return { where: r.where || binName() || 'the Bin', how: r.how || null, putBack: Boolean(r.putBack), undo: rememberUndo(r, root) };
}

// ---- routes; true when answered. ctx.busy(id, dir): why that project's files can't change now, or null. ----
export async function trashRoute(req, res, url, { send, body, busy = () => null, emit = () => {}, toBin = binEntry }) {
  const p = url.pathname;
  if (!['/api/trash', '/api/trash/restore', '/api/trash/empty', '/api/trash/from-bin', '/api/takes/delete', '/api/takes/restore'].includes(p)) return false;
  try {
    if (p === '/api/trash' && req.method === 'GET') return send(res, 200, trashView()), true;
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }), true;
    const b = await body(req);
    if (p === '/api/trash/restore') {
      const r = putBack(String(b.trash || ''), { busy });
      if (r.project) emit(r.project, { t: 'files' });
      return send(res, 200, r), true;
    }
    if (p === '/api/trash/empty') return send(res, 200, emptyTrash({ confirm: b.confirm === true, olderThanDays: b.olderThanDays ?? null })), true;
    if (p === '/api/takes/delete') {
      const r = deleteTake(null, String(b.take || ''), { confirm: b.confirm === true });
      if (r.ok === false) return send(res, 409, r), true;
      return send(res, 200, { ...r, bin: await toBin(r.trash) }), true;
    }
    if (p === '/api/trash/from-bin') {
      const entry = basename(undoFromBin(b.token, binName() || 'the Bin'));
      const r = putBack(entry, { busy });
      if (r.project) emit(r.project, { t: 'files' });
      return send(res, 200, r), true;
    }
    if (p === '/api/takes/restore') {
      const entry = String(b.trash || '');
      const m = isEntry(entry) ? readJSON(join(trashRoot(), entry, 'manifest.json'), null) : null;
      if (m?.kind !== 'deleted' || m.project) throw new Error('That isn’t a take deleted from Recordings.');
      return send(res, 200, restoreTake(null, entry)), true;
    }
  } catch (e) { return send(res, e.status || 400, { error: e.message }), true; }
  return send(res, 404, { error: 'Unknown action' }), true;
}

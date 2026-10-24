// A style card's cover picture (My styles), when the studio already has one. Nothing new is stored for it; the cover
// is looked up from what exists, in this order:
//   1. the main Packaging thumbnail of a video made with the style (newest video first),
//   2. a frame of such a video (server/thumbs.mjs: its newest render, playback copy or take, cached in local/thumbs),
//   3. a key frame of an example the style studied (saved with a skill version, else a draft conversation's frames).
// Without one the card draws its own cover in the kit colour (web/channel.js). Read-only on the database.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { imageType } from './images.mjs';
import { safeFile, learningId } from './learning-store.mjs';
import { projectDir } from './studio.mjs';

const MAX_PROJECTS = 4;
const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

const table = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const json = (row) => (row ? JSON.parse(row.data) : null);

// A file that is a picture we serve (PNG, JPEG or WebP, by its bytes; no SVG), as { bytes, type }.
function picture(path) {
  try {
    if (!path || !existsSync(path) || !statSync(path).isFile() || statSync(path).size > MAX_BYTES) return null;
    const bytes = readFileSync(path);
    const type = TYPES[imageType(bytes)];
    return type ? { bytes, type } : null;
  } catch { return null; }
}

// The style's videos among the ids the page asked about (newest first): only projects pinned to this format.
function stylesVideos(store, formatId, ids, exists) {
  if (!table(store.db, 'project_context')) return [];
  const pin = store.db.prepare('SELECT data FROM project_context WHERE project=?');
  return [...new Set(ids)].slice(0, MAX_PROJECTS).filter((id) => {
    const b = json(pin.get(id));
    return b?.formatId === formatId && exists(id);
  });
}

function packagingMain(store, project) {
  if (!table(store.db, 'packaging_projects') || !table(store.db, 'packaging_items')) return null;
  const meta = json(store.db.prepare('SELECT data FROM packaging_projects WHERE project=?').get(project));
  if (!meta?.main) return null;
  const item = json(store.db.prepare('SELECT data FROM packaging_items WHERE id=? AND project=?').get(String(meta.main), project));
  if (!item?.hash || item.status === 'rejected') return null;
  try { return picture(store.files.verify(item.hash)); } catch { return null; }
}

function exampleFrame(store, format) {
  const versions = store.list('versions').filter((v) => v.formatId === format.id)
    .sort((a, b) => (a.id === format.activeVersion ? -1 : b.id === format.activeVersion ? 1 : (b.number || 0) - (a.number || 0)));
  for (const v of versions) {
    for (const ex of v.package?.examples || []) {
      const frames = ex.frames || [];
      const fr = frames[Math.floor(frames.length / 2)];
      if (!fr?.sha256) continue;
      try { const pic = picture(store.files.verify(fr.sha256)); if (pic) return pic; } catch {}
    }
  }
  // A conversation that extracted frames but has no saved version yet.
  for (const s of store.list('sessions').filter((x) => x.formatId === format.id).reverse()) {
    for (const ref of s.references || []) {
      try {
        const dir = safeFile(store.sessionDir(s.id), `work/frames/${learningId(ref.id)}`);
        if (!existsSync(dir)) continue;
        const names = readdirSync(dir).filter((x) => /^frame-\d+\.jpg$/.test(x)).sort();
        const pic = names.length && picture(safeFile(dir, names[Math.floor(names.length / 2)]));
        if (pic) return pic;
      } catch {}
    }
  }
  return null;
}

// The lookups that need the database (an open LearningStore/ProfileStore, used synchronously):
//   coverFromVideos → { pic, videos }: the newest video's main Packaging thumbnail, and the style's videos to try next;
//   coverFromExamples → pic: a key frame of a studied example.
// projects: ids of the style's videos, newest first, as the page lists them (checked against the pins here).
// exists(id): whether the project folder is there (the studio's projects folder by default; tests pass their own).
export function coverFromVideos(store, formatId, projects = [], { exists = (id) => Boolean(projectDir(id)) } = {}) {
  const format = store.get('formats', formatId);
  const videos = stylesVideos(store, format.id, projects, exists);
  for (const id of videos) { const pic = packagingMain(store, id); if (pic) return { pic, videos }; }
  return { pic: null, videos };
}
export const coverFromExamples = (store, formatId) => exampleFrame(store, store.get('formats', formatId));

// The whole lookup, for the route: thumbFor (server/thumbs.mjs) grabs a video frame between the two database steps,
// with no store open while ffmpeg runs. withStore(fn) opens a store, runs fn and closes it.
export async function styleCover(withStore, formatId, projects, { thumbFor } = {}) {
  const first = withStore((s) => coverFromVideos(s, formatId, projects));
  if (first.pic) return first.pic;
  if (thumbFor) for (const id of first.videos) { const pic = picture(await thumbFor(id, projectDir(id))); if (pic) return pic; }
  return withStore((s) => coverFromExamples(s, formatId));
}

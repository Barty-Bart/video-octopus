// The starter studio: Setup's "Create my studio" copies the app's starter/ folder (CLAUDE.md, memory/, the default
// skills, the Cut Editor and join check, a library skeleton) into a new studio folder, never over a file that is
// already there, and points Video Octopus at it. <studio>/.studio/starter.json records which starter files went in and
// their sha1, so a later updater can tell files the creator never touched from ones they changed.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, copyFileSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { APP_DIR, expandHome, readJSON, writeJSON, saveSettings, tildePath, IS_MAC, IS_WIN } from './util.mjs';
import { settingsChanged } from './settings.mjs';

export const STARTER_DIR = join(APP_DIR, 'starter');
export const MANIFEST = join('.studio', 'starter.json');
const SKIP = new Set(['.DS_Store', '__pycache__', 'Thumbs.db', 'desktop.ini']);

export const starterVersion = () => { try { return readFileSync(join(STARTER_DIR, 'VERSION'), 'utf8').trim() || '1'; } catch { return '1'; } };

// The suggested place: a "Video Octopus" folder in the home folder (~/Video Octopus on a Mac, C:\Users\<name>\Video Octopus on Windows).
// Not Desktop or Documents (iCloud's "Desktop & Documents" syncs them) and not Videos (OneDrive's folder backup).
export const defaultStudioPath = () => join(homedir(), 'Video Octopus');

// A cloud-synced folder uploads every take and render, and can swap files for online-only placeholders mid-render.
export function syncWarning(p) {
  const abs = resolve(expandHome(String(p || '').trim()));
  const home = homedir();
  const under = (...parts) => { const d = join(home, ...parts); return abs === d || abs.startsWith(d + sep); };
  const low = abs.toLowerCase();
  if (low.includes('onedrive')) return 'This folder is in OneDrive, which uploads every take and render and can make files online-only. Pick a folder outside it, like the suggested one.';
  if (low.includes('dropbox') || low.includes('google drive') || low.includes('googledrive')) return 'This folder is in a cloud drive, which uploads every take and render. Pick a folder outside it, like the suggested one.';
  if (IS_MAC) {
    if (under('Library', 'Mobile Documents')) return 'This folder is in iCloud Drive, which uploads every take and render and can make files online-only. Pick a folder outside it, like the suggested one.';
    if (under('Library', 'CloudStorage')) return 'This folder is in a cloud drive (iCloud, OneDrive, Dropbox or Google Drive), which uploads every take and render. Pick a folder outside it, like the suggested one.';
    if (under('Desktop') || under('Documents')) return 'iCloud\'s "Desktop & Documents" setting syncs this folder when it\'s on, uploading every take and render. A folder in your home folder, like the suggested one, stays on this Mac.';
  }
  if (IS_WIN && ['Desktop', 'Documents', 'Pictures', 'Videos', 'Music'].some((d) => under(d))) {
    return 'OneDrive\'s folder backup can sync this folder, uploading every take and render. A folder directly in your user folder, like the suggested one, stays on this computer.';
  }
  return null;
}

// What Setup shows for a path the creator typed: where it is, whether it's there already, the sync warning.
export function studioPathInfo(p) {
  const raw = String(p || '').trim() || defaultStudioPath();
  const abs = resolve(expandHome(raw));
  let exists = false, isDir = false, files = 0;
  try { const st = statSync(abs); exists = true; isDir = st.isDirectory(); if (isDir) files = readdirSync(abs).filter((n) => !n.startsWith('.')).length; } catch {}
  return { path: abs, shown: tildePath(abs), relative: !isAbsolute(expandHome(raw)), exists, isDir, empty: isDir && files === 0, warning: syncWarning(abs),
    studio: isDir && existsSync(join(abs, 'CLAUDE.md')), inApp: abs === APP_DIR || abs.startsWith(APP_DIR + sep) };
}

// Every file of the starter (or of another starter folder), as studio-relative paths with forward slashes.
export function starterFiles(dir = STARTER_DIR, out = [], root = dir) {
  for (const n of readdirSync(dir)) {
    if (SKIP.has(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) starterFiles(p, out, root);
    else if (n !== 'VERSION') out.push(relative(root, p).split(sep).join('/'));
  }
  return out.sort();
}
export const sha1 = (p) => createHash('sha1').update(readFileSync(p)).digest('hex');

// Copy the starter into `target` without overwriting anything, then (unless use: false) make it Video Octopus's studio:
// studio = target, projectsDir = projects, recordingsDir = <target>/recordings. Returns what was added and kept.
export function createStudio(target, { use = true } = {}) {
  const raw = String(target || '').trim();
  if (!raw) throw new Error('Type where the studio should go.');
  const dir = resolve(expandHome(raw));
  if (!isAbsolute(expandHome(raw))) throw new Error('Give the full path of the folder, like ~/Video Octopus.');
  if (dir === APP_DIR || dir.startsWith(APP_DIR + sep)) throw new Error('Put the studio outside the app\'s own folder, so app updates never touch it.');
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw new Error('There is a file with that name. Pick another folder.');
  if (!existsSync(STARTER_DIR)) throw new Error('The starter studio is missing from the app (its starter/ folder).');
  mkdirSync(dir, { recursive: true });

  const old = readJSON(join(dir, MANIFEST), null);
  const files = { ...(old?.files || {}) };
  const added = [], kept = [], same = [];
  for (const rel of starterFiles()) {
    const from = join(STARTER_DIR, ...rel.split('/'));
    const to = join(dir, ...rel.split('/'));
    const hash = sha1(from);
    if (existsSync(to)) {
      // Already there: never overwritten. It counts as a starter file only if it's identical to the starter's.
      if (sha1(to) === hash) { same.push(rel); if (!files[rel]) files[rel] = hash; } else kept.push(rel);
      continue;
    }
    mkdirSync(join(to, '..'), { recursive: true });
    copyFileSync(from, to, constants.COPYFILE_EXCL); // fails rather than overwrite, if something appeared meanwhile
    files[rel] = hash;
    added.push(rel);
  }
  const now = new Date().toISOString();
  writeJSON(join(dir, MANIFEST), { version: starterVersion(), created: old?.created || now, ...(old ? { updated: now } : {}), files, kept });
  for (const sub of ['projects', 'recordings']) mkdirSync(join(dir, sub), { recursive: true });
  if (use) {
    saveSettings({ studio: dir, projectsDir: 'projects', recordingsDir: join(dir, 'recordings') });
    settingsChanged('folders');
  }
  return { studio: dir, shown: tildePath(dir), added: added.length, kept, same: same.length, version: starterVersion() };
}

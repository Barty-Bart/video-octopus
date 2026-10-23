// Content-addressed file store for skill files (assets, knowledge, key frames): <studio>/.studio/files/<2 hex>/<sha256><.ext>.
// SQLite keeps the records (names, notes, versions, sizes); this folder keeps the bytes, each identical file once.
// Writes are temp + fsync + rename. Projections into skill folders are copy-on-write clones (a plain copy where the
// disk cannot clone), never symlinks or hard links. Importing performs no IO.
import {
  closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  readSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

// Per skill (assets and knowledge together) and per file. The UI shows both.
export const MAX_SKILL_FILES = 300;
export const MAX_SKILL_FILE_BYTES = 1024 ** 3;
export const FILE_STORE_DIR = '.studio/files';
// Small generated text stays in SQLite (learning_blobs); every other approved file lives in the file store.
export const TEXT_FILES = new Set(['guide.md', 'SKILL.md']);
// Written into a generated skill folder: the files listed here are projections of the file store. The managed-skills
// snapshot neither copies nor stores them; the projector clones them in after publishing.
export const PROJECTED_MANIFEST = '.octopus-files.json';
export const PROJECTED_OWNER = 'video-octopus-file-store';

const SHA = /^[a-f0-9]{64}$/;
const EXT = /^\.[a-z0-9]{1,10}$/;
const PROJECTED_PATH = /^(assets|knowledge|examples)\/[^/\\]+(\/[^/\\]+)?$/;
const CHUNK = 1024 * 1024;
const fail = (message) => { throw new Error(message); };

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.avif': 'image/avif', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.json': 'application/json', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.md': 'text/markdown', '.txt': 'text/plain', '.css': 'text/css', '.html': 'text/html',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.lottie': 'application/zip', '.zip': 'application/zip',
};
export const mimeOf = (name) => MIME[extensionOf(name)] || 'application/octet-stream';
export function extensionOf(name) {
  const dot = String(name || '').lastIndexOf('.');
  const ext = dot > 0 ? String(name).slice(dot).toLowerCase() : '';
  return EXT.test(ext) ? ext : '';
}
// Knowledge is read by agents: documents, data and pictures.
export const KNOWLEDGE_TYPES = /\.(md|txt|csv|tsv|json|pdf|png|jpe?g|webp|gif|svg)$/i;
// A readable, safe file name for a projected skill file.
export function cleanFileName(name) {
  const base = basename(String(name || '').replace(/\\/g, '/')).normalize('NFC');
  const ext = extensionOf(base);
  const stem = (ext ? base.slice(0, -ext.length) : base).replace(/[^\p{L}\p{N} ._()+-]+/gu, '-').replace(/^[.\s-]+|[\s.]+$/g, '').slice(0, 120);
  return `${stem || 'file'}${ext}`;
}

// No symbolic links anywhere on the path, ancestors included; never outside its root.
function inside(root, rel) {
  const base = resolve(root), path = resolve(base, rel), r = relative(base, path);
  if (isAbsolute(rel) || r.startsWith('..') || isAbsolute(r)) fail('Path is outside the file store.');
  for (let p = path; p !== dirname(p); p = dirname(p)) {
    let st = null;
    try { st = lstatSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (st?.isSymbolicLink()) fail('Skill file storage cannot use symbolic links.');
  }
  return path;
}

// ---- Hashing. Large files are read in chunks; a verified hash is remembered for that exact file (device, inode, size
// and modification time), so repeated checks of an unchanged file are cheap. ----
const verified = new Map();
const stamp = (st) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
export function hashFile(path) {
  const st = lstatSync(path);
  if (!st.isFile()) fail(`Not a regular file: ${basename(path)}`);
  const known = verified.get(path);
  if (known && known.stamp === stamp(st)) return known.sha256;
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(CHUNK), fd = openSync(path, 'r');
  try {
    for (let n; (n = readSync(fd, buffer, 0, CHUNK, null)) > 0;) hash.update(buffer.subarray(0, n));
  } finally { closeSync(fd); }
  const sha256 = hash.digest('hex');
  verified.set(path, { stamp: stamp(lstatSync(path)), sha256 });
  if (verified.size > 20000) verified.delete(verified.keys().next().value);
  return sha256;
}
export const forgetHash = (path) => verified.delete(path);

function fsyncFile(path) {
  const fd = openSync(path, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function fsyncDir(path) {
  try { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } catch {}
}
// Copy-on-write where the disk supports it (APFS, Btrfs, ReFS…), otherwise Node falls back to a normal copy.
export function cloneFile(src, dst) {
  copyFileSync(src, dst, constants.COPYFILE_FICLONE);
}
// Clone into place atomically: a dot temp beside the target, then rename.
export function cloneInto(src, dst) {
  mkdirSync(dirname(dst), { recursive: true });
  const tmp = join(dirname(dst), `.${basename(dst)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    cloneFile(src, tmp);
    renameSync(tmp, dst);
  } finally { rmSync(tmp, { force: true }); }
  forgetHash(dst);
}

// The files a generated skill folder lists as file-store projections (relative paths), or an empty set.
export function projectedPaths(dir) {
  const file = join(dir, PROJECTED_MANIFEST);
  let st = null;
  try { st = lstatSync(file); } catch { return new Set(); }
  if (!st.isFile() || st.size > 4 * 1024 * 1024) return new Set();
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (manifest?.owner !== PROJECTED_OWNER || !Array.isArray(manifest.files)) return new Set();
    return new Set(manifest.files.map((f) => f?.path).filter((p) => typeof p === 'string' && PROJECTED_PATH.test(p) && !p.split('/').includes('..')));
  } catch { return new Set(); }
}
export function readProjectedManifest(dir) {
  const allowed = projectedPaths(dir);
  if (!allowed.size) return [];
  const manifest = JSON.parse(readFileSync(join(dir, PROJECTED_MANIFEST), 'utf8'));
  return manifest.files.filter((f) => allowed.has(f.path) && SHA.test(f.sha256));
}
export function projectedManifest(files) {
  return `${JSON.stringify({ owner: PROJECTED_OWNER, schema: 1,
    note: 'These files are copies of the studio file store. Video Octopus restores them when they change; edit the format in Video formats instead.',
    files: files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })) }, null, 2)}\n`;
}

export class FileStore {
  constructor(studio) {
    this.studio = resolve(studio);
    this.root = inside(this.studio, FILE_STORE_DIR);
  }
  objectPath(sha256, ext = '') {
    if (!SHA.test(sha256)) fail('Invalid file hash.');
    if (ext && !EXT.test(ext)) fail('Invalid file extension.');
    return inside(this.root, `${sha256.slice(0, 2)}/${sha256}${ext}`);
  }
  // The stored object for a hash, whatever its extension, or null. Regular files only.
  locate(sha256) {
    if (!SHA.test(sha256)) return null;
    const dir = inside(this.root, sha256.slice(0, 2));
    if (!existsSync(dir)) return null;
    for (const name of readdirSync(dir)) {
      if (name !== sha256 && !(name.startsWith(`${sha256}.`) && EXT.test(name.slice(64)))) continue;
      const path = join(dir, name);
      if (lstatSync(path).isFile()) return path;
    }
    return null;
  }
  // Present with the expected size (cheap). Full verification is verify().
  has(sha256, size) {
    const path = this.locate(sha256);
    return Boolean(path) && (size === undefined || size === null || lstatSync(path).size === size);
  }
  verify(sha256) {
    const path = this.locate(sha256) || fail(`A skill file is missing from the file store (${sha256.slice(0, 12)}…). Restore the file store backup.`);
    if (hashFile(path) !== sha256) fail(`A skill file in the file store failed verification (${sha256.slice(0, 12)}…). Restore the file store backup.`);
    return path;
  }
  // A damaged object is kept aside, never deleted, and the correct bytes are written again.
  quarantine(path) {
    const aside = inside(this.root, `.damaged/${basename(path)}.${Date.now()}-${randomBytes(3).toString('hex')}`);
    mkdirSync(dirname(aside), { recursive: true });
    renameSync(path, aside);
    forgetHash(path);
  }
  // An existing object with the same hash is reused (dedupe) after checking it.
  existing(sha256) {
    const path = this.locate(sha256);
    if (!path) return null;
    if (hashFile(path) === sha256) return path;
    this.quarantine(path);
    return null;
  }
  incoming() {
    const dir = inside(this.root, '.incoming');
    mkdirSync(dir, { recursive: true });
    return join(dir, `.${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  }
  settle(tmp, sha256, ext, size) {
    const found = this.existing(sha256);
    if (found) { rmSync(tmp, { force: true }); return { sha256, size, path: found, created: false }; }
    const path = this.objectPath(sha256, ext);
    mkdirSync(dirname(path), { recursive: true });
    renameSync(tmp, path);
    fsyncDir(dirname(path));
    return { sha256, size, path, created: true };
  }
  // Store a file by cloning it first and hashing the clone, so a source that changes meanwhile cannot mismatch.
  putFile(src, { ext = extensionOf(src), expect = null, maxBytes = MAX_SKILL_FILE_BYTES } = {}) {
    const st = lstatSync(src);
    if (!st.isFile()) fail('Only regular files can be stored.');
    if (st.size > maxBytes) fail(`Files can be at most ${formatBytes(maxBytes)}.`);
    const tmp = this.incoming();
    try {
      cloneFile(src, tmp);
      fsyncFile(tmp);
      const size = lstatSync(tmp).size, sha256 = hashFile(tmp);
      forgetHash(tmp);
      if (expect && sha256 !== expect) fail('A file changed while it was being saved. Review the draft again.');
      return this.settle(tmp, sha256, ext, size);
    } finally { rmSync(tmp, { force: true }); }
  }
  putBuffer(bytes, { ext = '', expect = null } = {}) {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (expect && sha256 !== expect) fail('Stored bytes failed verification.');
    const found = this.existing(sha256);
    if (found) return { sha256, size: bytes.length, path: found, created: false };
    const tmp = this.incoming();
    try {
      const fd = openSync(tmp, 'wx');
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      return this.settle(tmp, sha256, ext, bytes.length);
    } finally { rmSync(tmp, { force: true }); }
  }
  // Every stored object: [{ sha256, ext, size, path }].
  list() {
    const out = [];
    if (!existsSync(this.root)) return out;
    for (const dir of readdirSync(this.root)) {
      if (!/^[a-f0-9]{2}$/.test(dir)) continue;
      const folder = inside(this.root, dir);
      if (!lstatSync(folder).isDirectory()) continue;
      for (const name of readdirSync(folder)) {
        const sha256 = name.slice(0, 64), ext = name.slice(64);
        if (!SHA.test(sha256) || !sha256.startsWith(dir) || (ext && !EXT.test(ext))) continue;
        const st = lstatSync(join(folder, name));
        if (st.isFile()) out.push({ sha256, ext, size: st.size, path: join(folder, name) });
      }
    }
    return out;
  }
  remove(sha256) {
    const path = this.locate(sha256);
    if (!path) return false;
    rmSync(path);
    forgetHash(path);
    return true;
  }
  // Clone a stored object to dest and confirm the copy matches; a damaged store object is reported, not projected.
  project(sha256, dest) {
    const src = this.locate(sha256) || fail(`A skill file is missing from the file store (${sha256.slice(0, 12)}…). Restore the file store backup.`);
    cloneInto(src, dest);
    if (hashFile(dest) !== sha256) {
      rmSync(dest, { force: true });
      forgetHash(dest);
      fail(`A skill file in the file store failed verification (${sha256.slice(0, 12)}…). Restore the file store backup.`);
    }
    return dest;
  }
  // Incremental backup to another folder, same layout: objects already there with the right size are skipped.
  backupTo(folder) {
    if (typeof folder !== 'string' || !isAbsolute(folder)) fail('Choose an absolute folder path for the backup.');
    let st;
    try { st = lstatSync(folder); } catch { fail('That backup folder does not exist. Create it first.'); }
    if (st.isSymbolicLink() || !st.isDirectory()) fail('Choose a plain folder (not a link) for the backup.');
    const dest = inside(folder, 'Video Octopus skill files');
    const r = relative(this.studio, dest);
    if (!r.startsWith('..') && !isAbsolute(r)) fail('Choose a folder outside this studio for the backup.');
    let copied = 0, skipped = 0, bytes = 0;
    for (const object of this.list()) {
      const target = inside(dest, `${object.sha256.slice(0, 2)}/${object.sha256}${object.ext}`);
      let present = null;
      try { present = lstatSync(target); } catch {}
      if (present?.isFile() && present.size === object.size) { skipped++; continue; }
      cloneInto(object.path, target);
      if (hashFile(target) !== object.sha256) { rmSync(target, { force: true }); fail(`Backup copy failed verification for ${object.sha256.slice(0, 12)}…. Nothing else was changed.`); }
      copied++;
      bytes += object.size;
    }
    writeFileSync(join(dest, 'README.txt'), 'Video Octopus skill files, stored by content hash (<first 2 hex>/<sha256><.ext>).\n' +
      'To restore, copy these folders back into <studio>/.studio/files/. The studio database lists which file each hash is.\n');
    return { path: dest, copied, skipped, bytes };
  }
}

export function formatBytes(n) {
  if (n >= 1024 ** 3) return `${Math.round((n / 1024 ** 3) * 10) / 10} GB`;
  if (n >= 1024 ** 2) return `${Math.round((n / 1024 ** 2) * 10) / 10} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

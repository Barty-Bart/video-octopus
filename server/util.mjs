// Shared helpers: settings, paths, small file utilities.
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, realpathSync, renameSync, copyFileSync, rmSync,
  openSync, closeSync, fsyncSync, constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, basename, resolve, sep, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Settings, chats and keys of this install (STUDIO_LOCAL_DIR: a separate one, for tests).
export const LOCAL_DIR = process.env.STUDIO_LOCAL_DIR ? resolve(process.env.STUDIO_LOCAL_DIR) : join(APP_DIR, 'local');
mkdirSync(LOCAL_DIR, { recursive: true });

// Windows and Mac (Linux works too): where command-line tools usually live besides PATH, and their file names.
export const IS_WIN = process.platform === 'win32', IS_MAC = process.platform === 'darwin';
const EXE = IS_WIN ? '.exe' : '';
const TOOL_DIRS = IS_WIN
  ? [join(homedir(), '.local', 'bin'), join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links')]
  : [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];

export const expandHome = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
// The Hugging Face cache, where huggingface_hub (faster-whisper, transformers) keeps downloaded models: HF_HUB_CACHE,
// else HF_HOME/hub, else ~/.cache/huggingface/hub (the same on Windows, under the user's folder).
export const hfHub = () => resolve(expandHome(process.env.HF_HUB_CACHE || join(process.env.HF_HOME || join(homedir(), '.cache', 'huggingface'), 'hub')));

// A JSON file anyone may write (a project's project.json and work/*.json, which agents edit too): missing, half-written
// or unreadable is the fallback, and the file is left alone. For the app's own files, see readOwnJSON below.
export function readJSON(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

// A JSON file this app owns and rewrites (local/settings.json, state.json, schedules.json, the saved layouts): a missing
// file is the fallback. One that's there but isn't a JSON object (cut short by a crash, edited by hand) is moved aside
// to <name>.corrupt-<time> first, so nothing is lost and the next save can't write defaults over it. Any other read
// error (no permission, locked on Windows) throws: a save never replaces a file it couldn't read.
export function readOwnJSON(path, fallback = null) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  let data, problem = null;
  try { data = JSON.parse(text); } catch (e) { problem = e.message; }
  if (!problem && (!data || typeof data !== 'object' || Array.isArray(data))) problem = 'not a JSON object';
  if (!problem) return data;
  const kept = keepAside(path, 'corrupt');
  console.warn(`${basename(path)} couldn't be read (${problem}). It was kept as ${kept}; Video Octopus uses the defaults until it's fixed.`);
  return fallback;
}

// Move a file out of the way as <path>.<why>-<time>, without overwriting an earlier one. A file that can't be moved
// (open in another program on Windows) is copied instead; if neither works this throws, and the file stays where it is.
function keepAside(path, why) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let aside = `${path}.${why}-${stamp}`;
  for (let n = 2; existsSync(aside); n++) aside = `${path}.${why}-${stamp}-${n}`;
  try { renameSync(path, aside); } catch { copyFileSync(path, aside, fsConstants.COPYFILE_EXCL); }
  return aside;
}

// Write a JSON file so a crash or power cut can't leave it half-written: the text goes into a temporary file next to it,
// is flushed to the disk, then replaces the old file in one rename (a reader sees the old file or the new one, never a
// mix). If the write fails, the temporary file is removed and the old file is as it was.
export function writeJSON(path, data) {
  writeFileAtomic(path, JSON.stringify(data, null, 2) + '\n');
}

export function writeFileAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  // A dot file in the same folder: the rename stays on one disk, and folder listings and globs skip it.
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    const fd = openSync(tmp, 'wx');
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    replaceWith(tmp, path, text);
  } finally {
    rmSync(tmp, { force: true }); // gone already after a rename; a failed write leaves no stray file
  }
}

// Windows can refuse to rename over a file another program has open (an editor, a virus scanner, a backup tool):
// EPERM, EACCES or EBUSY, usually for a moment. Try again a few times (about a third of a second in all), then write
// the file in place: not atomic, but better than losing the save. If that fails too, the caller gets the error.
const LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY']);
function replaceWith(tmp, path, text) {
  for (let wait = 10; ; wait *= 2) {
    try { return renameSync(tmp, path); }
    catch (e) {
      if (!LOCKED.has(e.code)) throw e;
      if (wait > 160) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait); // a short synchronous pause
    }
  }
  writeFileSync(path, text);
}

// ---- request bodies ----
// An error a route answers with its own HTTP status: the routes' catches send `e.status || 400` (or 500).
export const httpError = (status, message) => Object.assign(new Error(message), { status });

// A request's JSON body. The chunks are joined before decoding, so a character split between two network chunks
// (Polish letters, emoji, curly quotes) stays whole. An empty body is {} (many routes take that as "no options").
// A body over `limit` bytes is a 413 and one that isn't JSON a 400, never an empty save. The rest of an oversized
// body is still read (and dropped), so the browser gets the answer instead of a reset connection.
export async function readJSONBody(req, limit = 1e6) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw httpError(413, `That request is too large (more than ${limit >= 1e6 ? `${Math.round(limit / 1e6)} MB` : `${Math.round(limit / 1e3)} KB`}).`);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); }
  catch { throw httpError(400, "The request wasn't valid JSON, so nothing was saved."); }
}

// ---- settings (local/settings.json, never committed) ----
const SETTINGS_PATH = join(LOCAL_DIR, 'settings.json');
const DEFAULTS = {
  studio: '',                       // the creator's studio folder
  projectsDir: 'projects',          // where projects live inside the studio
  recordingsDir: '',                 // where takes are saved; empty = <studio>/recordings (see settings())
  port: 4800,
  permissionMode: 'auto',           // manual | acceptEdits | auto | bypassPermissions (auto still asks before risky steps)
  model: '',                        // empty = Claude Code's own default
};

// Reading for display and for the rest of the app: a settings or state file that can't be read right now (locked, no
// permission) gives the defaults with a warning instead of stopping every request. Saves read with readOwnJSON
// directly, so they fail instead of writing defaults over it.
const warned = new Set();
function readOrDefault(path, fallback) {
  try { return readOwnJSON(path, fallback); }
  catch (e) {
    if (!warned.has(e.message)) { warned.add(e.message); console.warn(`${basename(path)} couldn't be read (${e.message}); using the defaults for now.`); }
    return fallback;
  }
}

export function settings() {
  const s = { ...DEFAULTS, ...readOrDefault(SETTINGS_PATH, {}) };
  s.studio = expandHome(s.studio);
  // Takes go in <studio>/recordings (Create my studio sets it too); before there's a studio, in the user's videos
  // folder. A folder set in Settings → Recording stays as it is.
  s.recordingsDir = expandHome(String(s.recordingsDir || '').trim())
    || (s.studio ? join(s.studio, 'recordings') : join(homedir(), IS_MAC ? 'Movies' : 'Videos', 'Video Octopus recordings'));
  return s;
}

// A broken settings.json was moved aside by readOwnJSON before this writes, so the save starts from the defaults
// and the creator's old file is still there to recover.
export function saveSettings(patch) {
  const current = readOwnJSON(SETTINGS_PATH, {});
  writeJSON(SETTINGS_PATH, { ...current, ...patch });
  return settings();
}

// ---- app state (session ids per project) ----
const STATE_PATH = join(LOCAL_DIR, 'state.json');
const withProjects = (s) => ({ ...s, projects: s.projects && typeof s.projects === 'object' ? s.projects : {} });
export const state = () => withProjects(readOrDefault(STATE_PATH, {}));
export function patchState(patch) {
  const s = withProjects(readOwnJSON(STATE_PATH, {}));
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete s[k]; else s[k] = v; }
  writeJSON(STATE_PATH, s);
}
export function setProjectState(id, patch) {
  const s = withProjects(readOwnJSON(STATE_PATH, {}));
  s.projects[id] = { ...(s.projects[id] || {}), ...patch };
  writeJSON(STATE_PATH, s);
}

// ---- tools the studio uses ----
export function studioTool(name) {
  const s = settings();
  if (s[name]) return expandHome(s[name]);
  const inVenv = IS_WIN ? join(s.studio, '.venv', 'Scripts', name + EXE) : join(s.studio, '.venv', 'bin', name);
  if (s.studio && existsSync(inVenv)) return inVenv;
  for (const dir of TOOL_DIRS) {
    if (existsSync(join(dir, name + EXE))) return join(dir, name + EXE);
  }
  return name;
}
// H.264 for this computer: the Mac's hardware encoder, else libx264 (Windows, Linux) at the same bitrate.
export const h264 = (rate = '8M') => IS_MAC
  ? ['-c:v', 'h264_videotoolbox', '-b:v', rate]
  : ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', rate];
// Export filters consume software frames. VideoToolbox can supply them on Mac;
// elsewhere use software decoding. Requesting a hardware type absent from the
// FFmpeg build can fail decoder setup as ENOMEM while binding the filtergraph.
export const videoDecodeArgs = (platform = process.platform) => platform === 'darwin' ? ['-hwaccel', 'videotoolbox'] : [];
export const python = () => { const p = studioTool('python'); return p !== 'python' ? p : IS_WIN ? 'python' : 'python3'; };

// The PATH a Terminal would have (login shell), so Claude and skills find the same tools.
let loginPath = null;
export function shellPath() {
  if (loginPath) return Promise.resolve(loginPath);
  // Windows has no login shell to ask: the server's own PATH is already the user's.
  if (IS_WIN) return Promise.resolve(loginPath = [...new Set([...(process.env.PATH || '').split(delimiter).filter(Boolean), ...TOOL_DIRS])].join(delimiter));
  return new Promise((done) => {
    const shell = process.env.SHELL || '/bin/zsh';
    execFile(shell, ['-ilc', 'printf "__P__%s__P__" "$PATH"'], { timeout: 4000, env: process.env }, (err, out) => {
      const m = /__P__(.*)__P__/s.exec(out || '');
      const parts = (m ? m[1] : process.env.PATH || '').split(delimiter).filter(Boolean);
      loginPath = [...new Set([...parts, ...TOOL_DIRS])].join(delimiter);
      done(loginPath);
    });
  });
}

// The environment for a child process, with that PATH. Windows spells it "Path": drop every spelling first, or the
// child could get two.
export async function childPathEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^path$/i.test(k)));
  const chosen = settings().python;
  const path = await shellPath();
  return { ...env, PATH: chosen ? `${dirname(expandHome(chosen))}${delimiter}${path}` : path, ...(chosen ? { STUDIO_PYTHON: expandHome(chosen) } : {}), ...extra };
}

// Show a file in Finder / File Explorer (a folder opens).
export function reveal(p) {
  const dir = (() => { try { return statSync(p).isDirectory(); } catch { return false; } })();
  if (IS_MAC) return execFile('open', dir ? [p] : ['-R', p]);
  if (IS_WIN) return execFile('explorer.exe', dir ? [p] : [`/select,${p}`]);
  return execFile('xdg-open', [dir ? p : dirname(p)]);
}

// ---- safety: keep every path inside its folder ----
// Where a path really is, even when it doesn't exist yet: the longest part of it that exists, with symlinks followed
// (and the real letter case, on a Mac and Windows), then the rest as written.
function realPlace(p) {
  const rest = [];
  for (let head = p; ; head = dirname(head)) {
    try { return join(realpathSync.native(head), ...rest); } catch {}
    if (dirname(head) === head) return p;
    rest.unshift(basename(head));
  }
}
// The full path of `rel` (relative to `base`, or absolute) when it is `base` itself or inside it, else null. Both are
// resolved and their symlinks followed, so a link inside the folder that points out of it doesn't count as inside.
// Windows compares without letter case; "C:\" or a root with a trailing slash works too.
export function inside(base, rel = '.') {
  const root = resolve(base), p = resolve(root, String(rel));
  const fold = (s) => (IS_WIN ? s.toLowerCase() : s);
  const r = fold(realPlace(root)), q = fold(realPlace(p));
  return q === r || q.startsWith(r.endsWith(sep) ? r : r + sep) ? p : null;
}

// A path as the creator reads it: the home folder as ~ (~/Video Octopus on a Mac, ~\Video Octopus on Windows).
export function tildePath(p) {
  const s = String(p || ''), home = homedir();
  const head = s.slice(0, home.length);
  const same = IS_WIN ? head.toLowerCase() === home.toLowerCase() : head === home;
  return same && (s.length === home.length || /[\\/]/.test(s[home.length])) ? `~${s.slice(home.length)}` : s;
}

// An npm install on Windows is a .cmd shim, which Node can't start without a shell (and a shell would mangle the
// long prompt arguments): run the package's own script (its package.json "bin") with Node instead, or the program
// itself when the package ships one (an .exe). Anything else runs as it is. Returns { exec, pre }: the program and
// the arguments that go before Video Octopus's own.
export function npmProgram(bin, pkg) {
  if (!/\.cmd$/i.test(bin || '')) return { exec: bin, pre: [] };
  const dir = join(dirname(bin), 'node_modules', ...pkg.split('/'));
  const b = readJSON(join(dir, 'package.json'), {})?.bin;
  const rel = typeof b === 'string' ? b : b?.[basename(bin).replace(/\.cmd$/i, '')] || Object.values(b || {})[0];
  const target = rel ? join(dir, rel) : null;
  if (!target || !existsSync(target)) return { exec: bin, pre: [] };
  return /\.exe$/i.test(target) ? { exec: target, pre: [] } : { exec: process.execPath, pre: [target] };
}

// A chat's agent couldn't be started (a wrong path in Settings, a broken install): what the chat says.
export const startError = (name, bin, e) => `${name} couldn't start (${bin}): ${e.code === 'ENOENT' ? 'there is no program there' : e.message}. Check that it's installed, or pick another agent in Settings → Agent & model.`;

// Simple glob: only "*" inside the last path segment ("renders/*intro*.mp4").
export function globExists(base, pattern) {
  if (!pattern.includes('*')) return existsSync(join(base, pattern));
  const dir = join(base, dirname(pattern));
  const name = pattern.split('/').pop();
  const re = new RegExp('^' + name.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  try { return readdirSync(dir).some((f) => re.test(f)); } catch { return false; }
}

export function mtime(p) {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

export const slugify = (s) =>
  String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'project';

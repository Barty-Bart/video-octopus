// Bounded, opt-in discovery. No recursive disk crawl, installs, model loads or provider calls. Project and app
// environments are looked for at most two folders deep in a fixed list of common folders, with hard caps on the
// folders read and the time spent (findProjectEnvironments); nothing is written.
import { existsSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, delimiter, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execFile } from 'node:child_process';

export const PACKAGES = { numpy: 'numpy', 'faster-whisper': 'faster_whisper', 'mlx-whisper': 'mlx_whisper', 'parakeet-mlx': 'parakeet_mlx', torch: 'torch', torchvision: 'torchvision', transformers: 'transformers', Pillow: 'PIL' };
const children = p => { try { return readdirSync(p, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => join(p, x.name)).sort().slice(0, 80); } catch { return []; } };
const file = p => { try { return statSync(p).isFile(); } catch { return false; } };
const folder = p => { try { return statSync(p).isDirectory(); } catch { return false; } };
const tilde = (p, home) => p === home ? '~' : p.startsWith(home + '/') || p.startsWith(home + '\\') ? '~' + p.slice(home.length) : p;
const expand = (p, home) => p === '~' ? home : p.startsWith('~/') || p.startsWith('~\\') ? join(home, p.slice(2)) : p;

// Project and app environments: a .venv, venv or env folder (or a folder with pyvenv.cfg) in a fixed list of common
// folders, read breadth-first so the shallowest places are covered first when a cap is reached. Never follows
// symlinked folders, never enters hidden folders, app bundles, photo/video libraries or node_modules, and on a Mac
// skips Apple's own Application Support folders (Contacts, Calls and the like). Read-only: one readdir per folder.
export const PROJECT_LIMITS = { dirs: 1500, ms: 2000, found: 16, perDir: 200 };
const VENV_NAMES = ['.venv', 'venv', 'env'];
const SKIP = /^(node_modules|Library|Applications|site-packages|__pycache__|Caches?|Logs|Trash|\$RECYCLE\.BIN|System Volume Information|AppData)$/i;
const BUNDLE = /\.(app|bundle|framework|photoslibrary|photolibrary|fcpbundle|imovielibrary|tvlibrary|musiclibrary|logicx|band|lrdata|lrcat-data|xcodeproj|xcworkspace|lproj|sparsebundle|dmg|pkg)$/i;
const APPLE = /^(com\.apple\..*|AddressBook|CallHistory.*|CloudDocs|FaceTime|Knowledge|MobileSync|DifferentialPrivacy|CrashReporter|SyncServices|Animoji|FileProvider|DiskImages|Dock|iCloud|Accounts|AppleMediaServices|CoreParsec|homeenergyd|identityservicesd|icdd|networkserviceproxy|Safari|Mail|Messages|Photos|Music|TV|News|Stocks|Weather|Notes|Reminders|Calendars?|Contacts|default\.store.*)$/i;
// Apps whose data folder is not named after the app (OpenToolkit keeps its speech environment in "Pico").
const KNOWN_APPS = { Pico: 'OpenToolkit' };
export function projectRoots({ home = homedir(), platform = process.platform, env = process.env, studio = '' } = {}) {
  const win = platform === 'win32', roots = [];
  const add = (path, depth, kind = 'project') => { if (path) roots.push({ path, depth, kind }); };
  // The studio's parent holds its sibling projects; when that is the home folder, the home row below covers it.
  if (studio && resolve(dirname(resolve(studio))) !== resolve(home)) add(dirname(resolve(studio)), 2);
  for (const n of ['Movies', 'Videos', 'Developer', 'Projects', 'projects', 'code', 'Code', 'src', 'dev', 'Documents', 'Downloads', 'Desktop', ...(win ? ['source/repos'] : [])]) add(join(home, n), 2);
  add(home, 1);
  if (platform === 'darwin') add(join(home, 'Library/Application Support'), 2, 'app');
  else if (win) { add(env.LOCALAPPDATA || join(home, 'AppData/Local'), 2, 'app'); add(env.APPDATA || join(home, 'AppData/Roaming'), 2, 'app'); }
  else add(join(home, '.local/share'), 2, 'app');
  return roots;
}
export function findProjectEnvironments({ home = homedir(), platform = process.platform, env = process.env, studio = '', limits = {}, now = Date.now } = {}) {
  const L = { ...PROJECT_LIMITS, ...limits }, start = now(), found = [], seen = new Set(), roots = projectRoots({ home, platform, env, studio });
  const real = p => { try { const r = realpathSync(p); return platform === 'win32' || platform === 'darwin' ? r.toLowerCase() : r; } catch { return null; } };
  const queue = [], searched = [];
  for (const r of roots) { const k = real(r.path); if (!k || seen.has(k) || !folder(r.path)) continue; seen.add(k); queue.push({ dir: r.path, depth: 0, max: r.depth, kind: r.kind, root: r.path }); searched.push({ path: tilde(r.path, home), depth: r.depth, kind: r.kind }); }
  let visited = 0, capped = null;
  const label = (item, venvDir) => {
    if (item.kind !== 'app') return 'Project environment';
    const app = venvDir.slice(item.root.length + 1).split(/[\\/]/)[0];
    return `App environment (${KNOWN_APPS[app] ? `${KNOWN_APPS[app]}, in ${app}` : app})`;
  };
  // Breadth-first: every root's own folder, then their children, then grandchildren.
  for (let i = 0; i < queue.length; i++) {
    if (found.length >= L.found) { capped = 'found'; break; }
    if (visited >= L.dirs) { capped = 'folders'; break; }
    if (now() - start > L.ms) { capped = 'time'; break; }
    const item = queue[i];
    let entries; try { entries = readdirSync(item.dir, { withFileTypes: true }); } catch { continue; } finally { visited++; }
    if (entries.some(e => e.name === 'pyvenv.cfg' && e.isFile())) { found.push({ root: item.dir, source: label(item, item.dir) }); continue; }
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
    for (const n of VENV_NAMES) if (dirs.includes(n)) found.push({ root: join(item.dir, n), source: label(item, join(item.dir, n)) });
    if (item.depth >= item.max) continue;
    for (const n of dirs.slice(0, L.perDir)) {
      if (n.startsWith('.') || VENV_NAMES.includes(n) || SKIP.test(n) || BUNDLE.test(n) || (item.kind === 'app' && item.depth === 0 && APPLE.test(n))) continue;
      const child = join(item.dir, n), k = real(child);
      if (!k || seen.has(k)) continue;
      seen.add(k); queue.push({ ...item, dir: child, depth: item.depth + 1 });
    }
  }
  return { found: found.slice(0, L.found), searched, visited, capped, ms: now() - start };
}

export function discoverPython({ home = homedir(), platform = process.platform, env = process.env, path = env.PATH || '', studio = '', configured = '', extra = '', suggested = [], projects = true, limits = {}, now } = {}) {
  const win = platform === 'win32', candidates = [], seen = new Set(); let truncated = false, search = null;
  const add = (p, source) => {
    if (!p || !file(p)) return;
    p = resolve(p);
    // Do not realpath the interpreter: different venv executables can point at the same base Python.
    // Canonicalize only its parent so aliases to an environment deduplicate without collapsing venvs.
    let key; try { key = join(realpathSync(dirname(p)), /^(python(?:3(?:\.\d+)?)?)(?:\.exe)?$/i.test(p.split(/[\\/]/).pop()) ? 'python' : p); } catch { return; }
    if (win) key = key.toLowerCase();
    if (seen.has(key)) return;
    if (candidates.length >= 32) { truncated = true; return; }
    seen.add(key); candidates.push({ path: p, source });
  };
  const at = (root, source) => {
    if (!root) return;
    for (const p of win ? [join(root, 'Scripts/python.exe'), join(root, 'python.exe')] : [join(root, 'bin/python'), join(root, 'bin/python3')]) add(p, source);
  };
  if (configured) add(expand(configured, home), 'Currently selected');
  // Explicit choice goes first, so a large global inventory cannot hide it.
  if (extra) {
    const p = expand(String(extra).trim(), home);
    if (!isAbsolute(p)) throw Error('Give an absolute path to a Python executable, environment or project folder.');
    if (file(p)) add(p, 'Chosen location');
    else if (folder(p)) { at(p, 'Chosen location'); for (const n of ['.venv', 'venv', 'env']) at(join(p, n), 'Chosen project'); }
    else throw Error('That location does not exist.');
  }
  // Places the assistant reported after its own read-only search (octopus python suggest): only those that exist.
  for (const raw of Array.isArray(suggested) ? suggested.slice(0, 8) : []) {
    const p = expand(String(raw || '').trim(), home);
    if (!isAbsolute(p)) continue;
    if (file(p)) add(p, 'Found by the assistant');
    else if (folder(p)) { at(p, 'Found by the assistant'); for (const n of VENV_NAMES) at(join(p, n), 'Found by the assistant'); }
  }
  if (studio) { at(join(studio, '.venv'), 'Studio environment'); at(join(studio, 'venv'), 'Studio environment'); }
  at(env.VIRTUAL_ENV, 'Active environment'); at(env.CONDA_PREFIX, 'Active Conda environment');
  // Project and app environments before the bare global Pythons, so the 32-candidate cap drops those first.
  if (projects) { search = findProjectEnvironments({ home, platform, env, studio, limits, ...(now ? { now } : {}) }); for (const f of search.found) at(f.root, f.source); }
  for (const dir of path.split(win ? ';' : delimiter).filter(Boolean)) {
    for (const name of win ? ['python.exe', 'python3.exe'] : ['python3', 'python']) add(join(dir, name), 'Global / PATH');
  }
  for (const dir of [join(home, '.local/bin'), ...(win ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])]) {
    for (const name of win ? ['python.exe'] : ['python3', 'python']) add(join(dir, name), 'Global');
  }
  for (const root of [join(home, '.venvs'), join(home, '.virtualenvs'), join(home, '.pyenv/versions'), join(home, '.local/share/uv/python'), join(home, '.local/share/uv/tools'), join(home, '.local/share/mise/installs/python'), ...(platform === 'darwin' ? ['/Library/Frameworks/Python.framework/Versions'] : [])]) {
    for (const p of children(root)) at(p, 'Environment manager');
  }
  for (const root of [join(home, 'miniconda3'), join(home, 'anaconda3'), join(home, 'miniforge3'), join(home, '.conda'), ...(win ? [join(env.LOCALAPPDATA || join(home, 'AppData/Local'), 'miniconda3')] : ['/opt/anaconda3', '/opt/miniconda3'])]) {
    at(root, 'Conda'); for (const p of children(join(root, 'envs'))) at(p, 'Conda environment');
  }
  if (win) for (const p of children(join(env.LOCALAPPDATA || join(home, 'AppData/Local'), 'Programs/Python'))) at(p, 'Global');
  return { candidates, truncated, search };
}

const metadata = `import sys,json,platform,importlib.metadata as md,importlib.util as util
out={"version":platform.python_version(),"arch":platform.machine(),"prefix":sys.prefix,"packages":{}}
for name,mod in ${JSON.stringify(PACKAGES)}.items():
    try: out["packages"][name]=md.version(name) if util.find_spec(mod) else None
    except Exception: out["packages"][name]=None
print(json.dumps(out))`;
const imports = `import json,importlib,sys
out={"imports":{},"sam2":False,"errors":{}}
for name,mod in ${JSON.stringify(PACKAGES)}.items():
    try: importlib.import_module(mod); out["imports"][name]=True
    except Exception as e: out["imports"][name]=False; out["errors"][name]=type(e).__name__+": "+str(e)[:240]
try:
    from transformers import Sam2VideoModel, Sam2VideoProcessor
    out["sam2"]=True
except Exception: pass
print(json.dumps(out))`;
export function probePython(path, { verify = false, timeout = verify ? 60000 : 5000, env = process.env } = {}) {
  // Explicit interpreter, no shell, no current-directory or PYTHONPATH imports, offline model libraries. Never construct a model.
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => /^(PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_ALL|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH)$/i.test(k)));
  return new Promise(done => execFile(path, ['-E', '-B', '-c', 'import sys,os; sys.path=[p for p in sys.path if p and os.path.abspath(p)!=os.getcwd()]\n' + (verify ? imports : metadata)], { cwd: tmpdir(), timeout, maxBuffer: 128 * 1024, env: { ...clean, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' } }, (err, out) => {
    if (err) return done({ error: err.killed ? 'Check timed out.' : 'Python could not complete the check.' });
    try { done(JSON.parse(String(out).trim().split('\n').pop())); } catch { done({ error: 'Python returned an unreadable check result.' }); }
  }));
}
export function describeEnvironment(item, machine = {}) {
  const p = item.packages || {}, [major, minor] = String(item.version || '0').split('.').map(Number);
  const supported = major === 3 && minor >= 10;
  const nativeMLX = machine.arm64 && ['arm64', 'aarch64'].includes(item.arch);
  const available = name => Boolean(p[name]) && (!item.verification || item.verification.imports?.[name] === true);
  // engine: the Whisper build (mlx | faster-whisper). Parakeet (parakeet-mlx, Apple Silicon's GPU) is a separate choice.
  const engine = nativeMLX && available('mlx-whisper') ? 'mlx' : available('faster-whisper') ? 'faster-whisper' : null;
  const parakeet = Boolean(nativeMLX && available('parakeet-mlx'));
  const engines = [nativeMLX && available('mlx-whisper') && 'mlx', parakeet && 'parakeet', available('faster-whisper') && 'faster-whisper'].filter(Boolean);
  const editing = supported && available('numpy');
  const transcription = editing && engines.length > 0;
  const objectSeparation = editing && ['torch', 'torchvision', 'transformers', 'Pillow'].every(available) && (!item.verification || item.verification.sam2 === true);
  // Another app's own environment (OpenToolkit's, say) works but changes when that app updates: a project's ranks first.
  const appOwned = String(item.source || '').startsWith('App environment');
  const score = supported ? (transcription ? 100 : 0) + (editing ? 20 : 0) + (objectSeparation ? 30 : 0) + (engine === 'mlx' ? 5 : 0) + (parakeet ? 4 : 0)
    + (engines.length > 1 ? 2 : 0) - (appOwned ? 3 : 0) + (item.source === 'Currently selected' ? 1 : 0) : -1;
  return { ...item, supported, engine, parakeet, engines, editing, transcription, objectSeparation, appOwned, score, verified: Boolean(item.verification && !item.verification.error), status: item.error || item.verification?.error ? 'Could not complete check' : !supported ? 'Python 3.10+ required' : transcription ? (item.verification ? 'Imports checked' : 'Packages found · verify before use') : 'Python found · additional libraries needed' };
}
// What the scan looked through, in one sentence for the page and the agent.
export function searchedText(search) {
  if (!search) return 'PATH, standard Python managers, the selected studio and your explicitly chosen location.';
  const two = search.searched.filter(x => x.depth === 2 && x.kind === 'project').map(x => x.path), one = search.searched.filter(x => x.depth === 1).map(x => x.path), apps = search.searched.filter(x => x.kind === 'app').map(x => x.path);
  return `PATH, standard Python managers and the selected studio; .venv, venv and env folders up to two folders deep in ${two.join(', ') || 'no common folders'}${one.length ? `, one deep in ${one.join(', ')}` : ''}${apps.length ? `, and apps' environments in ${apps.join(', ')}` : ''}. ${search.visited} folders read in ${(search.ms / 1000).toFixed(1)} s${search.capped ? ` (stopped at the ${search.capped === 'time' ? 'time' : search.capped === 'found' ? 'environment' : 'folder'} limit)` : ''}. No recursive file scan.`;
}
export async function scanPython(options = {}, machine = {}, probe = probePython) {
  const { candidates, truncated, search } = discoverPython(options), results = [];
  // Two workers keep startup and native library probing bounded.
  let next = 0;
  await Promise.all([0, 1].map(async () => { while (next < candidates.length) { const c = candidates[next++]; results.push(describeEnvironment({ ...c, ...await probe(c.path) }, machine)); } }));
  const unique = new Map();
  for (const item of results) {
    const key = item.prefix || item.path;
    const prior = unique.get(key);
    const priority = x => x.source === 'Currently selected' ? 3 : x.source.startsWith('Chosen') ? 2 : 1;
    if (!prior || priority(item) > priority(prior)) unique.set(key, item);
  }
  results.splice(0, results.length, ...unique.values());
  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { environments: results, recommended: results.find(x => x.transcription)?.path || null, truncated, scope: searchedText(search), searched: search?.searched || [], capped: search?.capped || null };
}

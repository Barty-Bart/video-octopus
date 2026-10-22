// Bounded, opt-in discovery. No recursive disk crawl, installs, model loads or provider calls.
import { existsSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, delimiter, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execFile } from 'node:child_process';

export const PACKAGES = { numpy: 'numpy', 'faster-whisper': 'faster_whisper', 'mlx-whisper': 'mlx_whisper', torch: 'torch', torchvision: 'torchvision', transformers: 'transformers', Pillow: 'PIL' };
const children = p => { try { return readdirSync(p, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => join(p, x.name)).sort().slice(0, 80); } catch { return []; } };
const file = p => { try { return statSync(p).isFile(); } catch { return false; } };
const folder = p => { try { return statSync(p).isDirectory(); } catch { return false; } };
const expand = (p, home) => p === '~' ? home : p.startsWith('~/') || p.startsWith('~\\') ? join(home, p.slice(2)) : p;

export function discoverPython({ home = homedir(), platform = process.platform, env = process.env, path = env.PATH || '', studio = '', configured = '', extra = '' } = {}) {
  const win = platform === 'win32', candidates = [], seen = new Set(); let truncated = false;
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
  if (studio) { at(join(studio, '.venv'), 'Studio environment'); at(join(studio, 'venv'), 'Studio environment'); }
  at(env.VIRTUAL_ENV, 'Active environment'); at(env.CONDA_PREFIX, 'Active Conda environment');
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
  return { candidates, truncated };
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
  const engine = nativeMLX && available('mlx-whisper') ? 'mlx' : available('faster-whisper') ? 'faster-whisper' : null;
  const editing = supported && available('numpy');
  const transcription = editing && Boolean(engine);
  const objectSeparation = editing && ['torch', 'torchvision', 'transformers', 'Pillow'].every(available) && (!item.verification || item.verification.sam2 === true);
  const score = supported ? (transcription ? 100 : 0) + (editing ? 20 : 0) + (objectSeparation ? 30 : 0) + (engine === 'mlx' ? 5 : 0) + (item.source === 'Currently selected' ? 1 : 0) : -1;
  return { ...item, supported, engine, editing, transcription, objectSeparation, score, verified: Boolean(item.verification && !item.verification.error), status: item.error || item.verification?.error ? 'Could not complete check' : !supported ? 'Python 3.10+ required' : transcription ? (item.verification ? 'Imports checked' : 'Packages found · verify before use') : 'Python found · additional libraries needed' };
}
export async function scanPython(options = {}, machine = {}, probe = probePython) {
  const { candidates, truncated } = discoverPython(options), results = [];
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
  return { environments: results, recommended: results.find(x => x.transcription)?.path || null, truncated, scope: 'PATH, standard Python managers, selected studio and your explicitly chosen location. No recursive file scan.' };
}

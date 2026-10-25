// Python discovery beyond PATH and the managers (project and app environments, bounded), its ranking, the assistant's
// read-only search offer, and Parakeet as a transcription engine (settings' choice, transcribe.py's model pick and
// words). Filesystem fixtures only: no real environment, model or agent. Windows-safe (paths built with join).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { findProjectEnvironments, discoverPython, scanPython, describeEnvironment, searchedText, projectRoots, PACKAGES } from '../server/python-environments.mjs';
import { localEngine, parakeetPick, parakeetReady, AUTO_ORDER } from '../server/settings.mjs';
import { bestMatch, askAgentShown, pythonSearchBrief, enginesText } from '../web/python-search.js';
import { lookOnly } from '../server/readonly.mjs';
import { APP_DIR } from '../server/util.mjs';

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'octopus-scan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const venv = (rel, win = false) => { const p = join(dir, rel, win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python'); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, ''); return p; };
  return { dir, venv, base: { home: dir, path: '', env: {}, platform: 'darwin' } };
}
const ALL = { numpy: '2', 'mlx-whisper': '0.4', 'parakeet-mlx': '0.5', 'faster-whisper': '1.2' };

test('finds project and app environments one or two folders deep, and nothing deeper or hidden', t => {
  const { dir, venv, base } = home(t);
  const motion = venv('Movies/motion-design/.venv'), deep2 = venv('Documents/clients/acme/venv'), homeLevel = venv('scratch/env');
  const app = venv('Library/Application Support/Pico/Speech/venv');
  const tooDeep = venv('Documents/a/b/c/.venv'), hidden = venv('Movies/.secret/.venv'), modules = venv('Projects/site/node_modules/x/.venv');
  const apple = venv('Library/Application Support/com.apple.something/x/venv'), bundle = venv('Movies/Edit.fcpbundle/.venv');
  const homeDeep = venv('scratch/one/.venv'); // the home folder itself is read one level deep only
  // A folder with pyvenv.cfg is an environment by itself (python -m venv anything).
  const cfg = venv('Developer/tools-env'); writeFileSync(join(dir, 'Developer/tools-env/pyvenv.cfg'), 'home = /usr/bin\n');
  const r = discoverPython(base), paths = r.candidates.map(x => x.path);
  for (const p of [motion, deep2, homeLevel, app, cfg]) assert(paths.includes(p), p);
  for (const p of [tooDeep, hidden, modules, apple, bundle, homeDeep]) assert(!paths.includes(p), p);
  assert.equal(r.candidates.find(x => x.path === motion).source, 'Project environment');
  assert.equal(r.candidates.find(x => x.path === app).source, 'App environment (OpenToolkit, in Pico)');
  assert(r.search.searched.some(x => x.path === join('~', 'Movies') && x.depth === 2));
  assert(r.search.searched.some(x => x.path === '~' && x.depth === 1));
  assert.match(searchedText(r.search), /two folders deep in .*Movies.*one deep in ~.*Application Support.*No recursive file scan/);
});

test('project discovery can be turned off and respects the folder, time and environment caps', t => {
  const { venv, base } = home(t);
  for (let i = 0; i < 30; i++) venv(`Movies/p${String(i).padStart(2, '0')}/.venv`);
  assert(!discoverPython({ ...base, projects: false }).candidates.some(x => x.source === 'Project environment'));
  const folders = findProjectEnvironments({ ...base, limits: { dirs: 4 } });
  assert.equal(folders.capped, 'folders'); assert(folders.visited <= 4);
  let clock = 0; const slow = findProjectEnvironments({ ...base, limits: { ms: 50 }, now: () => (clock += 20) });
  assert.equal(slow.capped, 'time'); assert(slow.visited < 5);
  const found = findProjectEnvironments({ ...base, limits: { found: 3 } });
  assert.equal(found.found.length, 3); assert.equal(found.capped, 'found');
  const all = findProjectEnvironments(base);
  assert.equal(all.found.length, 16); // PROJECT_LIMITS.found
  assert(discoverPython(base).candidates.length <= 32);
});

test('Windows layouts: Scripts\\python.exe venvs under Documents and LOCALAPPDATA', t => {
  const { dir, venv, base } = home(t);
  const proj = venv('Documents/video/.venv', true), app = venv('AppData/Local/SpeechApp/env', true);
  const found = discoverPython({ ...base, platform: 'win32', env: { LOCALAPPDATA: join(dir, 'AppData/Local') } }).candidates.map(x => x.path);
  assert(found.includes(proj)); assert(found.includes(app));
  assert(projectRoots({ home: dir, platform: 'win32', env: {} }).some(r => r.path.endsWith(join('source', 'repos'))));
});

test('the studio\'s parent folder is searched for sibling projects', t => {
  const { dir, venv, base } = home(t);
  const sibling = venv('Work/other-project/.venv');
  mkdirSync(join(dir, 'Work/Video Octopus'), { recursive: true });
  assert(discoverPython({ ...base, studio: join(dir, 'Work/Video Octopus') }).candidates.some(x => x.path === sibling));
  assert(!discoverPython(base).candidates.some(x => x.path === sibling));
});

test('ranks a project environment with every engine first, an app\'s own environment after it, a bare one last', async t => {
  const { venv, base } = home(t);
  const motion = venv('Movies/motion-design/.venv'), app = venv('Library/Application Support/Pico/Speech/venv'), bare = venv('Desktop/tests/.venv');
  const whisperOnly = venv('Downloads/ai-video-studio/.venv');
  const pkgs = { [motion]: ALL, [app]: ALL, [whisperOnly]: { numpy: '2', 'mlx-whisper': '0.4' }, [bare]: {} };
  const r = await scanPython(base, { arm64: true }, async p => ({ version: '3.12.14', arch: 'arm64', prefix: p, packages: pkgs[p] || {} }));
  assert.equal(r.recommended, motion);
  const order = r.environments.map(x => x.path);
  assert(order.indexOf(motion) < order.indexOf(app) && order.indexOf(app) < order.indexOf(whisperOnly) && order.indexOf(whisperOnly) < order.indexOf(bare));
  const best = r.environments[0];
  assert.deepEqual(best.engines, ['mlx', 'parakeet', 'faster-whisper']); assert.equal(best.parakeet, true); assert.equal(best.engine, 'mlx');
  assert.equal(r.environments.find(x => x.path === app).appOwned, true);
  assert.match(r.scope, /Movies/);
});

test('Parakeet alone counts as transcription on Apple Silicon only, and only when its import passes', () => {
  assert.equal(PACKAGES['parakeet-mlx'], 'parakeet_mlx');
  const item = { version: '3.12.1', arch: 'arm64', packages: { numpy: '2', 'parakeet-mlx': '0.5' } };
  const mac = describeEnvironment(item, { arm64: true });
  assert.equal(mac.transcription, true); assert.equal(mac.engine, null); assert.deepEqual(mac.engines, ['parakeet']);
  assert.equal(describeEnvironment(item, { arm64: false }).transcription, false);
  assert.equal(describeEnvironment({ ...item, verification: { imports: { numpy: true, 'parakeet-mlx': false } } }, { arm64: true }).transcription, false);
});

test('places the assistant reported join the scan, ahead of the caps, and missing ones are ignored', t => {
  const { dir, venv, base } = home(t);
  const far = venv('Volumes-like/deep/a/b/c/env');
  const r = discoverPython({ ...base, suggested: [join(dir, 'Volumes-like/deep/a/b/c'), join(dir, 'missing'), 'relative/path'] });
  assert.equal(r.candidates.find(x => x.path === far)?.source, 'Found by the assistant');
});

test('the "ask the assistant" line shows only when the scan found nothing that can transcribe', () => {
  const ready = { path: '/p/.venv/bin/python', supported: true, transcription: true, engines: ['mlx', 'parakeet'] };
  assert.equal(askAgentShown({ environments: [ready], recommended: ready.path }), false);
  assert.equal(bestMatch({ environments: [ready], recommended: ready.path }), ready);
  assert.equal(askAgentShown({ environments: [], recommended: null }), true);
  assert.equal(askAgentShown({ environments: [{ path: '/usr/bin/python3', supported: true, transcription: false }], recommended: null }), true);
  assert.equal(askAgentShown(null), false); // before any scan
  assert.equal(enginesText(ready), 'MLX Whisper, Parakeet');
});

test('the assistant\'s search brief is read-only and leaves selection to the creator', () => {
  const b = pythonSearchBrief({ scope: '~/Movies two deep' });
  assert.match(b, /read-only/); assert.match(b, /do not install, download, create, move, change or delete anything/);
  assert.match(b, /no pip, no venv creation, no model downloads/);
  for (const w of ['mdfind', 'find ~', 'node_modules', '.Trash', '.git', 'timeout 60', 'huggingface', 'OpenToolkit', 'numpy', 'mlx_whisper', 'parakeet_mlx', 'faster_whisper', '~/Movies two deep']) assert(b.includes(w), w);
  assert.match(b, /python suggest/); assert.match(b, /Do not select it yourself/); assert.match(b, /Use this/);
  assert(!/pip install|venv create|models download/.test(b));
  // The page sends exactly this brief to the studio chat.
  const page = readFileSync(new URL('../web/setup-environments.js', import.meta.url), 'utf8');
  assert.match(page, /\/api\/projects\/_studio\/chat', \{ text: pythonSearchBrief\(/);
});

test('octopus python suggestions is read-only for a chat; suggest is a change', () => {
  const cli = join(APP_DIR, 'bin', 'octopus.mjs');
  assert.equal(lookOnly(`node "${cli}" python suggestions`, APP_DIR), true);
  assert.equal(lookOnly(`node "${cli}" python suggest /tmp/x`, APP_DIR), false);
});

test('engine choice: Parakeet only with an Apple Silicon Mac and a selected Python that has it', () => {
  const mac = { arm64: true, whisper: { engine: 'mlx' } };
  assert.equal(parakeetReady({ mac, python: '/p', pythonParakeet: true }), true);
  assert.equal(parakeetReady({ mac: { arm64: false }, python: '/p', pythonParakeet: true }), false);
  assert.equal(localEngine({ choice: 'parakeet', mac, python: '/p', pythonParakeet: true }), 'parakeet');
  assert.equal(localEngine({ choice: 'parakeet', mac, python: '/p', pythonParakeet: false, have: { mlx: ['large-v3-turbo'], whisper: [] } }), 'mlx');
  assert.equal(localEngine({ choice: 'parakeet', mac: { arm64: false, whisper: { engine: 'faster-whisper' } }, python: '/p', pythonParakeet: true }), 'faster-whisper');
  // Auto leaves a build with only tiny models for the other build's medium or large one.
  assert.equal(localEngine({ mac, have: { mlx: ['tiny', 'tiny.en'], whisper: ['medium.en'] } }), 'faster-whisper');
  assert.equal(localEngine({ mac, have: { mlx: ['large-v3-turbo', 'tiny'], whisper: ['medium.en'] } }), 'mlx');
  assert.equal(localEngine({ mac, have: { mlx: [], whisper: ['small.en'] } }), 'faster-whisper');
  assert(AUTO_ORDER.en.indexOf('large-v3-turbo') < AUTO_ORDER.en.indexOf('tiny.en'));
});

test('Parakeet model by language: v2 for English, v3 for other European languages and Detect', () => {
  const both = ['parakeet-tdt-0.6b-v2', 'parakeet-tdt-0.6b-v3'];
  assert.equal(parakeetPick('en', both).model, 'parakeet-tdt-0.6b-v2');
  assert.equal(parakeetPick('en', ['parakeet-tdt-0.6b-v3']).model, 'parakeet-tdt-0.6b-v3');
  assert.equal(parakeetPick(null, both).model, 'parakeet-tdt-0.6b-v3');
  assert.equal(parakeetPick('pl', ['parakeet-tdt-0.6b-v2']).model, null);
  assert.equal(parakeetPick('pl', ['parakeet-tdt-0.6b-v2']).wanted, 'parakeet-tdt-0.6b-v3');
  assert.equal(parakeetPick('ja', both).model, null);
});

test('settings: Parakeet is a stored choice, and the brief names it without a Whisper size', async t => {
  const { dir } = home(t);
  const cache = join(dir, 'hub');
  for (const v of ['v2', 'v3']) {
    const repo = join(cache, `models--mlx-community--parakeet-tdt-0.6b-${v}`), sha = 'a'.repeat(40);
    mkdirSync(join(repo, 'refs'), { recursive: true }); writeFileSync(join(repo, 'refs', 'main'), sha);
    mkdirSync(join(repo, 'snapshots', sha), { recursive: true });
    for (const f of ['config.json', 'model.safetensors']) writeFileSync(join(repo, 'snapshots', sha, f), '{}');
  }
  const util = new URL('../server/util.mjs', import.meta.url).href, settings = new URL('../server/settings.mjs', import.meta.url).href;
  const script = `import {saveSettings} from ${JSON.stringify(util)};
    import {saveSection,section,settingsBrief,transcribeHow,whisperEngine,machineInfo,whisperModels} from ${JSON.stringify(settings)};
    saveSettings({python:${JSON.stringify(join(dir, 'py'))},pythonParakeet:true,studio:${JSON.stringify(dir)}});
    saveSection('transcribe',{whisperEngine:'parakeet',model:'tiny.en',language:'en'});
    const how=await transcribeHow({fill:true});
    console.log(JSON.stringify({choice:section('transcribe').whisperEngine,engine:await whisperEngine(),arm64:(await machineInfo()).arm64,have:whisperModels('parakeet'),how,brief:settingsBrief({STUDIO_TRANSCRIBE_ENGINE:'parakeet'})}));`;
  const v = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: dir, USERPROFILE: dir, STUDIO_LOCAL_DIR: join(dir, 'local'), HF_HUB_CACHE: cache }, encoding: 'utf8' }).trim().split('\n').pop());
  assert.equal(v.choice, 'parakeet');
  assert.deepEqual(v.have, ['parakeet-tdt-0.6b-v2', 'parakeet-tdt-0.6b-v3']);
  if (v.arm64) {
    assert.equal(v.engine, 'parakeet'); assert.equal(v.how.model, 'parakeet-tdt-0.6b-v2');
    assert.match(v.how.text, /--engine parakeet --model auto --out work\/tr --fill-out work\/tr_fill --lang en/);
    assert.match(v.brief, /STUDIO_TRANSCRIBE_ENGINE=parakeet/);
  } else {
    assert.notEqual(v.engine, 'parakeet'); assert.doesNotMatch(v.how.text, /--engine parakeet/);
  }
  assert.match(v.brief, /do not offer to create a new environment first/);
  assert.match(v.brief, /Python environments/);
});

// transcribe.py's own Parakeet pieces, with a fake Hugging Face cache and fake parakeet-mlx tokens (no import of it).
function python() {
  for (const p of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const r = spawnSync(p, ['-c', 'import sys; print(sys.version_info[:2] >= (3, 8))'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'True') return p;
  }
  return null;
}
test('transcribe.py: Parakeet model pick, its args, and SentencePiece tokens to words.json words', t => {
  const py = python();
  if (!py) { t.skip('No Python 3.8+ on this computer'); return; }
  const { dir } = home(t), cache = join(dir, 'hub');
  const snap = join(cache, 'models--mlx-community--parakeet-tdt-0.6b-v3', 'snapshots', 'x');
  mkdirSync(snap, { recursive: true }); for (const f of ['config.json', 'model.safetensors']) writeFileSync(join(snap, f), '{}');
  const scripts = new URL('../starter/.claude/skills/transcribe/scripts/', import.meta.url);
  const code = `import sys, json
sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])
import transcribe as t
class Tok:
    def __init__(s, text, start, dur): s.text, s.start, s.end = text, start, start + dur
class Sent:
    def __init__(s, toks): s.tokens, s.text = toks, "".join(x.text for x in toks).strip()
words = t.parakeet_words([Sent([Tok(" Hel", 0.0, 0.2), Tok("lo", 0.2, 0.1), Tok(" world", 0.4, 0.3), Tok(".", 0.7, 0.05)]), Sent([Tok(" Next", 1.0, 0.3)])])
segs = t.collect(words, 10.0)
print(json.dumps({"words": segs[0], "en": t.pick_parakeet("auto", "en"), "auto": t.pick_parakeet("auto", None),
  "pl": t.pick_parakeet("auto", "pl"), "ja": t.pick_parakeet("auto", "ja"), "v2": t.pick_parakeet("parakeet-tdt-0.6b-v2", "en"),
  "v2pl": t.pick_parakeet("v2", "pl")}))`;
  const r = spawnSync(py, ['-B', '-c', code, decodeURIComponent(scripts.pathname).replace(/^\/([A-Za-z]:)/, '$1')], { encoding: 'utf8', env: { ...process.env, HF_HUB_CACHE: cache, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(v.words, [[10, 10.3, 'Hello'], [10.4, 10.75, 'world.'], [11, 11.3, 'Next']]);
  assert.deepEqual(v.en, ['mlx-community/parakeet-tdt-0.6b-v3', null]); // v2 not downloaded: v3 for English
  assert.deepEqual(v.auto, ['mlx-community/parakeet-tdt-0.6b-v3', null]);
  assert.deepEqual(v.pl, ['mlx-community/parakeet-tdt-0.6b-v3', null]);
  assert.equal(v.ja[0], null); assert.match(v.ja[1], /no model for language ja/);
  assert.equal(v.v2[0], null); assert.match(v.v2[1], /isn't downloaded/);
  assert.equal(v.v2pl[0], null); assert.match(v.v2pl[1], /English only/);
  const help = spawnSync(py, ['-B', join(decodeURIComponent(scripts.pathname).replace(/^\/([A-Za-z]:)/, '$1'), 'transcribe.py'), '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /parakeet/);
});

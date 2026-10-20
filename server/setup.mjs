// First-time Setup: one live check per thing Video Octopus needs, plus the routes for Settings, keys and the profile.
// A failing check carries `fix` (a request for the Video Octopus assistant, see assistant.mjs) or `how` (what the
// creator does by hand: installing and signing in to the agent is theirs alone, the app never touches that login).
import { existsSync, statSync, accessSync, constants } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { settings, studioTool, python, childPathEnv, tildePath as tilde, IS_WIN, IS_MAC, APP_DIR, LOCAL_DIR } from './util.mjs';
import { claudeInfo } from './claude.mjs';
import { ccSource, sourceProblem, settingsCredentials } from './claude-source.mjs';
import { codexInfo } from './codex.mjs';
import { piInfo } from './pi.mjs';
import { engineName, ENGINES } from './engines.mjs';
import { cutEditorPath } from './cuteditor.mjs';
import { formats } from './studio.mjs';
import { settingsView, saveSection, section, profile, saveProfile, testKey, KEYS, machineInfo, whisperModels, MODELS, settingsChanged } from './settings.mjs';
import { saveKey, removeKey, hasKey } from './keychain.mjs';
import { createStudio, studioPathInfo, defaultStudioPath } from './starter.mjs';

export const CHECKS = [
  ['claude', 'Agent (Claude Code, Codex or pi)'], // id "claude" from when Claude Code was the only one
  ['ffmpeg', 'ffmpeg and ffprobe'],
  ['python', 'Python and transcription'],
  ['recorder', 'Recorder'],
  ['folders', 'Your studio and projects folders'],
  ['cuteditor', 'Cut Editor'],
];

const run = async (bin, args, ms = 8000) => {
  const env = await childPathEnv();
  return new Promise((done) => execFile(bin, args, { timeout: ms, env }, (err, out, errOut) => done({ ok: !err, out: String(out || '').trim(), err: String(errOut || '').trim() })));
};

// The last result of each check, for the Video Octopus assistant's context.
export const lastChecks = new Map();

export async function runCheck(id) {
  const title = (CHECKS.find((c) => c[0] === id) || [])[1];
  if (!title) throw new Error('Unknown check.');
  const r = { id, title, fix: null, how: null, ...(await CHECK[id]()) };
  lastChecks.set(id, r);
  return r;
}

// Whether an agent can run Video Octopus's chats: { ok, detail } when it can, else { ok: false, detail, how }.
const shell = IS_WIN ? 'PowerShell' : 'Terminal';
async function agentReady(engine) {
  const c = section('claude');
  if (engine === 'codex') {
    const x = await codexInfo(true), local = ['lmstudio', 'ollama'].includes(c.codexProvider);
    if (!x.installed) return { ok: false, detail: x.error || 'Codex not found on this computer.', how: x.error ? 'Fix or remove codexPath in Video Octopus\'s local/settings.json, so Video Octopus looks for Codex itself.' : `Install Codex in ${shell} (${x.install}), then run codex login.` };
    if (!local && !x.signedIn) return { ok: false, detail: `Codex ${x.version} is installed but not signed in.`, how: `Open ${shell}, run codex login and sign in, then press Check again. Video Octopus uses that sign-in and never sees it.` };
    return { ok: true, detail: `Codex ${x.version}${local ? ` · ${c.codexProvider === 'ollama' ? 'Ollama' : 'LM Studio'}` : ` · signed in${x.plan ? ` · ${x.plan}` : ''}`}` };
  }
  if (engine === 'pi') {
    const x = await piInfo(true), endpoint = c.piSource === 'endpoint';
    if (!x.installed) return { ok: false, detail: x.error || 'pi not found on this computer.', how: x.error ? 'Fix or remove piPath in Video Octopus\'s local/settings.json, so Video Octopus looks for pi itself.' : `Install pi in ${shell} (${x.install}) and set up a provider in it, or use "Any OpenAI-compatible endpoint" in Settings → Agent & model.` };
    if (endpoint && (!c.piBaseUrl || !c.piModel)) return { ok: false, detail: `pi ${x.version} · the endpoint has no URL or model yet.`, how: 'Give the endpoint a URL and a model in Settings → Agent & model.' };
    return { ok: true, detail: `pi ${x.version}${endpoint ? ` · ${c.piModel} at ${c.piBaseUrl}` : c.piModel ? ` · ${c.piModel}` : ''}` };
  }
  const x = await claudeInfo(true);
  if (!x.installed) return { ok: false, detail: x.error || 'Claude Code not found on this computer.', how: x.error ? 'Fix or remove claudePath in Video Octopus\'s local/settings.json, so Video Octopus looks for Claude Code itself.' : `Install Claude Code in ${shell} (${x.install}), then run claude once and sign in with your Claude account.` };
  // Another model source (claude-source.mjs) needs no Claude sign-in, only its URL and model.
  const src = ccSource();
  if (src.id !== 'plan') {
    const problem = sourceProblem(src, { conflicts: src.id === 'provider' ? settingsCredentials() : [] });
    return problem ? { ok: false, detail: `Claude Code ${x.version} · ${src.label}: not set up yet.`, how: problem } : { ok: true, detail: `Claude Code ${x.version} · ${src.label} · ${src.model}` };
  }
  if (!x.signedIn) return { ok: false, detail: `Claude Code ${x.version} is installed but not signed in.`, how: `Open ${shell}, run claude and sign in with your Claude account, then press Check again. Video Octopus uses that sign-in and never sees it.` };
  return { ok: true, detail: `Claude Code ${x.version} · signed in${x.plan ? ` · ${x.plan}` : ''}` };
}

const CHECK = {
  // Video Octopus needs one of three agents, the one picked in Settings → Agent & model: Claude Code (signed in), Codex or
  // pi. The Video Octopus assistant runs on it, so setting it up is the creator's to do (how, never fix).
  async claude() {
    const picked = engineName(), r = await agentReady(picked);
    if (r.ok) return { state: 'ok', detail: r.detail };
    // Another agent that's ready: switching to it is quicker than setting this one up.
    let other = null;
    for (const e of Object.keys(ENGINES).filter((x) => x !== picked)) if ((await agentReady(e)).ok) { other = e; break; }
    return { state: 'fail', detail: r.detail,
      how: `${r.how} Video Octopus needs one of three agents: Claude Code, Codex or pi, the one picked in Settings → Agent & model (now ${ENGINES[picked]}).${other ? ` ${ENGINES[other]} is ready on this computer: pick it there instead.` : ''}` };
  },

  async ffmpeg() {
    const [ff, fp] = [studioTool('ffmpeg'), studioTool('ffprobe')];
    const [a, b] = await Promise.all([run(ff, ['-version']), run(fp, ['-version'])]);
    const ver = (r) => (/version (\S+)/.exec(r.out) || [])[1];
    const missing = [!a.ok && 'ffmpeg', !b.ok && 'ffprobe'].filter(Boolean);
    if (missing.length) return { state: 'fail', detail: `${missing.join(' and ')} not found.`,
      fix: `Setup check "ffmpeg and ffprobe" failed: Video Octopus can't find ${missing.join(' or ')}. Video Octopus looks on the PATH, in the studio's .venv, in ~/.local/bin and ${IS_WIN ? 'winget\'s Links folder' : '/opt/homebrew/bin and /usr/local/bin'} (or the "ffmpeg" / "ffprobe" paths in Video Octopus's local/settings.json). Get ${missing.join(' and ')} working on this computer so Video Octopus finds ${missing.length > 1 ? 'them' : 'it'}${IS_WIN ? ' (winget install Gyan.FFmpeg is the usual way on Windows)' : ''}. Tell me your plan first and ask before installing anything.` };
    return { state: 'ok', detail: `ffmpeg ${ver(a) || ''} · ffprobe ${ver(b) || ''}`.replace(/ +·/, ' ·').trim() };
  },

  async python() {
    const py = python();
    // cv2 (OpenCV 4): Auto-frame finds the face with it on Windows and Linux (tools/face.py); a Mac uses Vision.
    const code = 'import sys, json\nout = {"py": sys.version.split()[0]}\nfor m in ("faster_whisper", "numpy", "cv2"):\n    try:\n        out[m] = __import__(m).__version__\n    except Exception:\n        out[m] = None\nprint(json.dumps(out))';
    const r = await run(py, ['-c', code], 20000);
    let j = null;
    try { j = JSON.parse(r.out.split('\n').pop()); } catch {}
    if (!j) return { state: 'fail', detail: `Python not found (${tilde(py)}).`,
      fix: `Setup check "Python and transcription" failed: Video Octopus can't run Python (it tried ${py}). Transcription (faster-whisper) and the Cut Editor (numpy) need Python 3.9 or newer. Set it up on this computer (a venv in the studio folder at .venv is what Video Octopus looks for first${IS_WIN ? '; on Windows, winget install Python.Python.3.12' : ''}). Tell me your plan first and ask before installing anything.` };
    const missing = [!j.faster_whisper && 'faster-whisper', !j.numpy && 'numpy'].filter(Boolean);
    const mac = await machineInfo();
    const t = section('transcribe');
    const want = t.model === 'auto' ? mac.whisper.model : t.model;
    const have = whisperModels();
    const base = `Python ${j.py}${j.faster_whisper ? ` · faster-whisper ${j.faster_whisper}` : ''}`;
    if (missing.length) return { state: 'fail', detail: `${base} · missing ${missing.join(' and ')}.`,
      fix: `Setup check "Python and transcription" failed: Python ${j.py} (${py}) is there but ${missing.join(' and ')} can't be imported. faster-whisper is for transcribing on this computer, numpy is for the Cut Editor. Install ${missing.join(' and ')} for that Python (pip; if it says "externally managed", use the studio's .venv). Ask me before installing.` };
    const noModel = t.engine === 'local' && !have.includes(want), noCv = !IS_MAC && !j.cv2;
    if (noModel || noCv) return { state: 'warn',
      detail: [base, noModel && `the ${want} model isn't downloaded yet (about ${MODELS[want] || 'a few GB'})`, noCv && 'no OpenCV, which Auto-frame needs'].filter(Boolean).join(' · ') + '.',
      fix: [`Setup check "Python and transcription" (${py}):`,
        noModel && `the faster-whisper model ${want} (about ${MODELS[want] || 'a few GB'}) isn't downloaded on this computer yet${have.length ? ` (these are: ${have.join(', ')})` : ''}. Download it into the usual Hugging Face cache with that Python, for example by loading faster_whisper.WhisperModel("${want}") once.`,
        noCv && `OpenCV 4 isn't installed for that Python; Video Octopus's Auto-frame finds the face with it on this computer. Install it with pip: "opencv-python-headless<5" (it's in the studio's requirements.txt).`,
        'Ask me before downloading or installing anything.'].filter(Boolean).join(' ') };
    return { state: 'ok', detail: `${base} · models here: ${have.length ? have.join(', ') : 'none (cloud transcription)'}${IS_MAC ? '' : ` · OpenCV ${j.cv2}`}` };
  },

  // The recorder runs in the page, in Chrome or Edge (the page adds a note when this browser can't record
  // everything), and Video Octopus saves each take in the takes folder: it has to be there, or be makeable, and writable.
  async recorder() {
    const dir = settings().recordingsDir;
    let at = dir;
    while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
    let ok = false;
    try { ok = statSync(at).isDirectory(); accessSync(at, constants.W_OK); } catch { ok = false; }
    if (!ok) return { state: 'fail', detail: `Takes can't be saved in ${tilde(dir)}: ${tilde(at)} can't be written to.`,
      fix: `Setup check "Recorder" failed: Video Octopus saves recorded takes in ${tilde(dir)} (Settings → Recording → Where takes are saved), but ${tilde(at)} isn't a folder this user can write to. Find out why (permissions, a drive that isn't connected) and tell me how to fix it, or suggest another folder. Ask me before changing anything.` };
    return { state: 'ok', detail: `Records your screen, camera and mic in Chrome or Edge · takes go in ${tilde(dir)}` };
  },

  async folders() {
    const s = settings();
    // No studio yet (or it's gone): offer to create one from the starter at ~/Video Octopus, or to use a folder that exists.
    if (!s.studio || !existsSync(s.studio)) return { state: 'fail', detail: s.studio ? `${tilde(s.studio)} doesn't exist.` : 'No studio folder yet.', pick: true,
      create: studioPathInfo(defaultStudioPath()) };
    const root = join(s.studio, s.projectsDir);
    if (!existsSync(root)) return { state: 'fail', detail: `Video Octopus ${tilde(s.studio)} · the projects folder ${s.projectsDir}/ isn't there.`,
      fix: `Setup check "Your studio and projects folders" failed: the projects folder ${root} doesn't exist. Make it (an empty folder is fine) and say when it's there. Ask before creating it.` };
    return { state: 'ok', detail: `${tilde(s.studio)} · projects in ${s.projectsDir}/` };
  },

  async cuteditor() {
    const p = cutEditorPath();
    const s = settings();
    if (!p && (!s.studio || !existsSync(s.studio))) return { state: 'fail', detail: 'Comes with the starter studio: create your studio above.' };
    if (!p) return { state: 'fail', detail: 'tools/cut-editor/server.py not found in the studio.',
      fix: `Setup check "Cut Editor" failed: Video Octopus can't find the Cut Editor (it looks for ${join(s.studio || '<studio>', 'tools', 'cut-editor', 'server.py')}, or the "cutEditor" path in Video Octopus's local/settings.json). Look for it on this computer and tell me what you find; if it's somewhere else, set "cutEditor" in ${join(LOCAL_DIR, 'settings.json')} to its server.py, after asking me.` };
    return { state: 'ok', detail: s.studio && p.startsWith(s.studio) ? relative(s.studio, p) : tilde(p) };
  },
};

export const setupNeeded = () => { const s = settings(); return !section('setup', s).done || !s.studio || !existsSync(s.studio); };

// ---- routes: /api/app/* (Settings, keys, profile, Setup). Returns true when it answered. ----
export async function appRoute(req, res, url, { send, body }) {
  const p = url.pathname;
  if (!p.startsWith('/api/app/')) return false;
  const post = req.method === 'POST';
  const b = post ? await body(req) : {};
  try {
    if (p === '/api/app/settings' && !post) return send(res, 200, { ...(await settingsView()), claude: await claudeInfo(), formats: formats() }), true;
    if (p === '/api/app/settings' && post) {
      saveSection(String(b.section || ''), { ...(b.values || {}) });
      return send(res, 200, { ...(await settingsView()), claude: await claudeInfo(), formats: formats() }), true;
    }
    if (p === '/api/app/keys' && post) {
      if (!KEYS[b.name]) throw new Error('Unknown key.');
      if (b.remove) await removeKey(b.name); else await saveKey(b.name, b.value);
      settingsChanged('keys'); // the chats restart with the new environment
      return send(res, 200, { name: b.name, set: await hasKey(b.name) }), true;
    }
    if (p === '/api/app/keys/test' && post) {
      if (!KEYS[b.name]) throw new Error('Unknown key.');
      return send(res, 200, await testKey(b.name)), true;
    }
    if (p === '/api/app/profile') return send(res, 200, post ? saveProfile(b) : profile() || {}), true;
    if (p === '/api/app/setup' && !post) return send(res, 200, { needed: setupNeeded(), done: section('setup').done, checks: CHECKS.map(([id, title]) => ({ id, title })), formats: formats() }), true;
    if (p === '/api/app/setup' && post) { saveSection('setup', { done: Boolean(b.done) }); return send(res, 200, { done: section('setup').done }), true; }
    if (p === '/api/app/setup/check') return send(res, 200, await runCheck(url.searchParams.get('id'))), true;
    // Create my studio: where it would go (the sync warning, whether the folder is there), then the copy itself.
    if (p === '/api/app/setup/studio-path' && !post) return send(res, 200, studioPathInfo(url.searchParams.get('path'))), true;
    if (p === '/api/app/setup/create-studio' && post) return send(res, 200, createStudio(b.path)), true;
    if (p === '/api/app/setup/studio' && post) {
      saveSection('folders', { studio: b.studio, ...(b.projectsDir ? { projectsDir: b.projectsDir } : {}) });
      return send(res, 200, { ok: true }), true;
    }
  } catch (e) { return send(res, 400, { error: e.message }), true; }
  return false;
}


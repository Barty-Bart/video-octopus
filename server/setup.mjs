// First-time Setup: one live check per thing Video Octopus needs, plus the routes for Settings, keys and the profile.
// A failing check carries `fix` (a request for the Video Octopus assistant, see assistant.mjs) or `how` (what the
// creator does by hand: installing and signing in to the agent is theirs alone, the app never touches that login).
import { existsSync, statSync, accessSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { settings, studioTool, python, childPathEnv, tildePath as tilde, hfHub, IS_WIN, IS_MAC, APP_DIR } from './util.mjs';
import { claudeInfo } from './claude.mjs';
import { ccSource, sourceProblem, settingsCredentials } from './claude-source.mjs';
import { codexInfo } from './codex.mjs';
import { piInfo } from './pi.mjs';
import { engineName, ENGINES } from './engines.mjs';
import { formats } from './studio.mjs';
import { settingsView, saveSection, section, profile, saveProfile, testKey, KEYS, PROVIDERS, machineInfo, whisperModels, autoWhisper, whisperEngine, needsLocalPython, MODELS, settingsChanged } from './settings.mjs';
import { saveKey, removeKey, hasKey } from './keychain.mjs';
import { createStudio, studioPathInfo, defaultStudioPath } from './starter.mjs';
import { SAM2_MODELS, sam2Have, sam2Recommend, sam2Machine, sam2Download } from './sam2.mjs';
import { sources, sourceLine, downloadState, startDownload, stopDownload } from './hfmodels.mjs';

// What the object-separation skill needs from Python: torch (and the device it can use), torchvision (transformers' SAM 2
// image processor won't load without it), transformers with SAM 2's video model, numpy and Pillow.
const SAM2_PROBE = `import sys, json
out = {"py": sys.version.split()[0]}
try:
    import torch
    out["torch"] = torch.__version__.split("+")[0]
    if torch.cuda.is_available():
        p = torch.cuda.get_device_properties(0)
        out.update(device="cuda", gpu=p.name, vram=round(p.total_memory / 2**30, 1))
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        out["device"] = "mps"
    else:
        out["device"] = "cpu"
except Exception:
    out["torch"] = None
for name, mod in (("torchvision", "torchvision"), ("transformers", "transformers"), ("numpy", "numpy"), ("pillow", "PIL")):
    try:
        out[name] = __import__(mod).__version__
    except Exception:
        out[name] = None
if out["torch"] and out["transformers"]:
    try:
        from transformers import Sam2VideoModel, Sam2VideoProcessor
        out["sam2video"] = True
    except Exception:
        out["sam2video"] = False
print(json.dumps(out))`;

// The Setup page's cards: tools (ffmpeg first), then the machine's recommendations (models). The agent check (id
// "claude", from when Claude Code was the only one) is for the assistant's context; the page's Agents card is the
// scan in onboarding.mjs.
export const CHECKS = [
  ['ffmpeg', 'ffmpeg: renders and exports your videos'],
  ['recorder', 'Recorder'],
  ['folders', 'Your studio and projects folders'],
  ['python', 'Python'],
  ['claude', 'Agent (Claude Code, Codex or pi)'],
  ['whisper', 'Transcription model (Whisper)'],
  ['objsep', 'Object separation (SAM 2)'],
];
const CARD = { ffmpeg: 'tools', recorder: 'tools', folders: 'tools', python: 'tools', claude: 'agents', whisper: 'machine', objsep: 'machine' };

// How ffmpeg gets installed here with one command, after the creator's OK: Homebrew on a Mac, winget on Windows (with
// winget's package agreements, which the OK covers). Null when neither is there: the row links the manual install.
export function ffmpegInstaller() {
  if (IS_MAC) { const b = studioTool('brew'); return existsSync(b) ? { bin: b, args: ['install', 'ffmpeg'], cmd: 'brew install ffmpeg' } : null; }
  if (IS_WIN) { const w = studioTool('winget'); return { bin: w, args: ['install', '--id', 'Gyan.FFmpeg', '-e', '--accept-source-agreements', '--accept-package-agreements'], cmd: 'winget install --id Gyan.FFmpeg -e' }; }
  return null;
}

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
    const inst = ffmpegInstaller();
    if (missing.length) return { state: 'fail', detail: `${missing.join(' and ')} not found: exporting needs ${missing.length > 1 ? 'them' : 'it'}.`,
      install: inst ? { action: 'ffmpeg', cmd: inst.cmd } : null, manual: 'https://ffmpeg.org/download.html',
      fix: `Setup check "ffmpeg" failed: Video Octopus can't find ${missing.join(' or ')}. Video Octopus looks on the PATH, in the studio's .venv, in ~/.local/bin and ${IS_WIN ? 'winget\'s Links folder' : '/opt/homebrew/bin and /usr/local/bin'} (or the "ffmpeg" / "ffprobe" paths in Video Octopus's local/settings.json). Get ${missing.join(' and ')} working on this computer so Video Octopus finds ${missing.length > 1 ? 'them' : 'it'}${IS_WIN ? ' (winget install Gyan.FFmpeg is the usual way on Windows)' : ''}. Tell me your plan first and ask before installing anything.` };
    return { state: 'ok', detail: `ffmpeg ${ver(a) || ''} · ffprobe ${ver(b) || ''}`.replace(/ +·/, ' ·').trim() };
  },

  // Only when something on this computer needs it (settings.mjs needsLocalPython): else "Not needed", greyed out, and
  // it never blocks. Needed and missing: an Install that asks the Video Octopus assistant (it asks before each step).
  async python() {
    if (!(await needsLocalPython())) return { state: 'skip', detail: 'Not needed: nothing here runs models on this computer (a cloud agent and cloud transcription). The rough cut, join check and apply_edit ask for Python the first time they need it.' };
    const py = python(), mlx = await whisperEngine() === 'mlx';
    // cv2 (OpenCV 4): Auto-frame finds the face with it on Windows and Linux (tools/face.py); a Mac uses Vision.
    const code = 'import sys, json, platform\nout = {"py": sys.version.split()[0], "arch": platform.machine()}\nfor m in ("faster_whisper", "numpy", "cv2", "mlx_whisper"):\n    try:\n        out[m] = getattr(__import__(m), "__version__", "ok")\n    except Exception:\n        out[m] = None\nprint(json.dumps(out))';
    const r = await run(py, ['-c', code], 20000);
    let j = null;
    try { j = JSON.parse(r.out.split('\n').pop()); } catch {}
    const need = 'Python is needed to run models on this computer';
    if (!j) return { state: 'fail', install: true, detail: `${need}: it isn't found (${tilde(py)}).`,
      fix: `Setup check "Python" failed: Video Octopus can't run Python (it tried ${py}). Transcription on this computer (faster-whisper${mlx ? ' or MLX Whisper' : ''}) and the rough cut and join check skills (numpy) need Python 3.10 or newer. Set it up on this computer (a venv in the studio folder at .venv is what Video Octopus looks for first${IS_WIN ? '; on Windows, winget install Python.Python.3.12' : ''}), then install the studio's requirements.txt into it. Tell me your plan first and ask before installing anything.` };
    const missing = [!j.faster_whisper && 'faster-whisper', !j.numpy && 'numpy', mlx && !j.mlx_whisper && 'mlx-whisper'].filter(Boolean);
    const base = `Python ${j.py}${j.faster_whisper ? ` · faster-whisper ${j.faster_whisper}` : ''}${mlx && j.mlx_whisper ? ` · mlx-whisper ${j.mlx_whisper}` : ''}`;
    if (mlx && j.arch !== 'arm64') return { state: 'warn', install: true, detail: `${base} · this Python is an Intel build (${j.arch}), which can't run MLX Whisper: transcription falls back to faster-whisper.`,
      fix: `Setup check "Python": ${py} is an Intel (${j.arch}) Python running under Rosetta, so MLX Whisper can't run on it. Set up a native arm64 Python 3.10+ for the studio's .venv and install requirements.txt into it. Ask me before installing anything.` };
    if (missing.length) return { state: 'fail', install: true, detail: `${need}: Python ${j.py} is there, but ${missing.join(' and ')} ${missing.length > 1 ? 'aren\'t' : 'isn\'t'} installed.`,
      fix: `Setup check "Python" failed: Python ${j.py} (${py}) is there but ${missing.join(' and ')} can't be imported. faster-whisper${mlx ? ' and mlx-whisper are' : ' is'} for transcribing on this computer, numpy is for the rough cut and join check skills. Install ${missing.join(' and ')} for that Python (pip; if it says "externally managed", use the studio's .venv; the studio's requirements.txt lists them). Ask me before installing.` };
    // The Whisper model itself has its own row (whisper, below).
    if (!IS_MAC && !j.cv2) return { state: 'warn', detail: `${base} · no OpenCV, which Auto-frame needs.`,
      fix: `Setup check "Python and transcription" (${py}): OpenCV 4 isn't installed for that Python; Video Octopus's Auto-frame finds the face with it on this computer. Install it with pip: "opencv-python-headless<5" (it's in the studio's requirements.txt). Ask me before installing anything.` };
    return { state: 'ok', detail: `${base}${IS_MAC ? '' : ` · OpenCV ${j.cv2}`}` };
  },

  // The transcription model (faster-whisper): every size Video Octopus knows with where it comes from (Hugging Face's
  // API, hfmodels.mjs), the one recommended for this computer (machineInfo), the creator's pick (Settings →
  // Transcription; auto = the transcribe skill's own pick, the best verbatim model already downloaded), whether it's
  // downloaded, and the row's Download. `whisper` carries what the row draws.
  async whisper() {
    const t = section('transcribe'), mac = await machineInfo(), rec = mac.whisper;
    // The build: MLX Whisper (Apple Silicon's GPU, mlx-community's models) or faster-whisper (Systran's).
    const engine = await whisperEngine(), fam = engine === 'mlx' ? 'mlx' : 'whisper';
    const have = whisperModels(engine), src = await sources(fam), dl = downloadState(fam);
    const auto = autoWhisper(t.language === 'auto' ? null : t.language, have);
    // What Download offers: the pick, or for Auto the model it uses, else the recommended one.
    const picked = t.model !== 'auto' ? t.model : have.includes(auto) ? auto : rec.model;
    const there = have.includes(picked), size = (id) => src[id]?.size ? ` (${src[id].size})` : '';
    // The one recommended for this computer, in its own build (MLX Whisper's model is mlx-community's), for the row's
    // short view: its source, whether it's here, and the download (of either build) under way.
    const recFam = rec.engine === 'mlx' ? 'mlx' : 'whisper', recSrc = recFam === fam ? src : await sources(recFam);
    const dls = ['whisper', 'mlx'].map((f) => ({ ...downloadState(f), family: f }));
    const whisper = { family: fam, engine, engineChoice: t.whisperEngine, engineRec: rec.engine, mlxOk: Boolean(mac.arm64), cloud: t.engine === 'cloud',
      choice: t.model, picked, recommended: rec.model, why: `${mac.chip}${mac.ramGB ? ` with ${mac.ramGB} GB` : ''}`, speed: rec.speed, auto, cache: tilde(hfHub()), there,
      rec: { id: rec.model, family: recFam, engine: rec.engine, have: whisperModels(rec.engine).includes(rec.model), source: { ...recSrc[rec.model], line: sourceLine(recSrc[rec.model]) } },
      models: MODELS.map((id) => ({ id, have: have.includes(id), source: { ...src[id], line: sourceLine(src[id]) } })),
      download: dls.find((d) => d.state === 'downloading') || dls.find((d) => (d.family === fam && d.size === picked) || (d.family === recFam && d.size === rec.model)) || { state: 'idle' } };
    const recLine = `recommended for this computer: ${rec.model} on ${rec.engine === 'mlx' ? 'MLX Whisper' : 'faster-whisper'} (${rec.speed})`;
    if (t.engine === 'cloud') return { state: 'ok', whisper, detail: `Transcription goes to ${PROVIDERS[t.provider]?.label || 'a cloud service'} (Settings → Transcription): no model needed here${have.length ? ` · downloaded: ${have.join(', ')}` : ''}` };
    if (!there) return { state: 'warn', whisper,
      detail: `${t.model === 'auto' ? `Auto uses the best model already downloaded, and none is yet: ${picked}${size(picked)} is the one recommended for this computer (${rec.speed})` : `${picked}${size(picked)}, your pick, isn't downloaded yet · ${recLine}`}${have.length ? ` · downloaded: ${have.join(', ')}` : ''}.` };
    return { state: 'ok', whisper, detail: `${t.model === 'auto' ? `Auto: ${picked}, the best downloaded for a verbatim transcript` : `${picked}, your pick`} on ${engine === 'mlx' ? 'MLX Whisper' : 'faster-whisper'} · ${recLine} · in ${tilde(hfHub())}` };
  },

  // Object separation (the object-separation skill, starter/.claude/skills): torch, torchvision, transformers (SAM 2's
  // video model), numpy and Pillow for that Python, and the SAM 2.1 model picked in Settings → Rendering (auto = the one
  // recommended here) in the Hugging Face cache. The packages go the Whisper way (Fix: the assistant installs them,
  // asking first); the model has the row's own Download button. `sam2` carries what the row draws: the three models
  // with their sizes and speed, the recommendation, the choice, the download.
  async objsep() {
    // Only for a studio that has the skill (every studio from the starter does; one set up by hand may not).
    const studio = settings().studio;
    if (studio && existsSync(studio) && !existsSync(join(studio, '.claude', 'skills', 'object-separation'))) return { state: 'skip', hidden: true, detail: 'This studio has no object-separation skill.' };
    const py = python();
    const r = await run(py, ['-c', SAM2_PROBE], 60000);
    let j = null;
    try { j = JSON.parse(r.out.split('\n').pop()); } catch {}
    const mac = await machineInfo(), hw = sam2Machine(mac);
    // torch's own view of the device when it's there (the skill decides the same way), else the hardware's.
    const rec = sam2Recommend(j?.torch ? { device: j.device, vramGB: j.vram, gpu: j.gpu } : hw);
    const choice = section('objsep').model, picked = choice === 'auto' ? rec.size : choice;
    const have = sam2Have(), there = have.includes(picked), dl = sam2Download(), src = await sources('sam2');
    const sam2 = { family: 'sam2', choice, picked, recommended: rec.size, why: rec.why, slow: rec.slow, cache: tilde(hfHub()), there,
      rec: { id: rec.size, family: 'sam2', have: have.includes(rec.size), source: { ...src[rec.size], line: sourceLine(src[rec.size]) } },
      models: Object.entries(SAM2_MODELS).map(([id, m]) => ({ id, repo: m.repo, speed: m.speed, for: m.for, have: have.includes(id), source: { ...src[id], line: sourceLine(src[id]) } })),
      download: dl.state === 'downloading' || dl.size === picked || dl.size === rec.size ? { ...dl, family: 'sam2' } : { state: 'idle' } };
    const model = `SAM 2.1 ${picked} (${[src[picked]?.size, choice === 'auto' ? `recommended for ${rec.why}` : 'your pick'].filter(Boolean).join(', ')})`;
    const slow = rec.slow ? ' · no GPU it can use: it runs on the CPU, which takes seconds a frame, so separate short parts' : '';
    const ask = 'Leave the model alone: the Download button on this Setup row fetches it into the Hugging Face cache. Tell me your plan first and ask before installing anything.';
    if (!j) return { state: 'fail', sam2, detail: `Python not found (${tilde(py)}).`,
      fix: `Setup check "Object separation (SAM 2)" failed: Video Octopus can't run Python (it tried ${py}). The object-separation skill needs Python 3.10 or newer with PyTorch (torch and torchvision), transformers 4.56 or newer, numpy and Pillow, best in the studio's .venv (what Video Octopus looks for first). Set Python up, then install what the studio's requirements.txt lists. ${ask}` };
    const old = j.transformers && j.torch && j.sam2video === false;
    const missing = [!j.torch && 'torch', !j.torchvision && 'torchvision', !j.transformers && 'transformers', !j.numpy && 'numpy', !j.pillow && 'Pillow'].filter(Boolean);
    if (missing.length || old) {
      const torchHow = IS_MAC ? 'plain pip is right on a Mac' : hw.device === 'cuda' ? `this computer has ${hw.gpu}: the CUDA build from pytorch.org's install selector, since plain pip can give the slower CPU build`
        : IS_WIN ? 'plain pip gives the CPU build, which is right without an NVIDIA card' : 'without an NVIDIA card the CPU wheels from pytorch.org, since plain pip on Linux gives the large CUDA build';
      const what = [missing.length && `missing ${missing.join(', ')}`, old && `transformers ${j.transformers} has no SAM 2 video model (it needs 4.56 or newer)`].filter(Boolean).join('; ');
      return { state: 'fail', sam2, detail: `Python ${j.py}${j.torch ? ` · torch ${j.torch}` : ''} · ${what}.`,
        fix: `Setup check "Object separation (SAM 2)" failed: Python ${j.py} (${py}): ${what}. The object-separation skill (separating a person or an object from the background, on this computer, with SAM 2.1 through transformers) needs torch, torchvision, transformers 4.56 or newer, numpy and Pillow for that Python (pip; if it says "externally managed", use the studio's .venv), as the studio's requirements.txt lists them.${!j.torch ? ` For torch and torchvision: ${torchHow}.` : ''} ${ask}` };
    }
    // An NVIDIA card that torch can't use: a CPU build of torch.
    const cpuTorch = hw.device === 'cuda' && j.device === 'cpu';
    const on = { mps: 'Apple Silicon (MPS)', cuda: rec.why, cpu: 'the CPU' }[j.device];
    const base = `torch ${j.torch} on ${on} · transformers ${j.transformers}`;
    const fixCuda = cpuTorch ? `Setup check "Object separation (SAM 2)": this computer has ${hw.gpu}, but the torch for ${py} is a CPU build (torch ${j.torch}), so object separation runs on the CPU, which is slow. Install the CUDA build of torch for that Python from pytorch.org's install selector. Ask me before installing anything.` : null;
    const cudaNote = cpuTorch ? ` · torch here can't use ${hw.gpu} (a CPU build)` : '';
    if (!there) return { state: 'warn', sam2, fix: fixCuda,
      detail: `${base} · ${model} isn't downloaded yet${have.length ? ` (downloaded: ${have.join(', ')})` : ''}${slow}${cudaNote}.` };
    return { state: cpuTorch ? 'warn' : 'ok', sam2, fix: fixCuda, detail: `${base} · ${model}, in ${tilde(hfHub())}${slow}${cudaNote}` };
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
    if (p === '/api/app/setup' && !post) return send(res, 200, { needed: setupNeeded(), done: section('setup').done, checks: CHECKS.map(([id, title]) => ({ id, title, card: CARD[id] })), formats: formats() }), true;
    if (p === '/api/app/setup' && post) { saveSection('setup', { done: Boolean(b.done) }); return send(res, 200, { done: section('setup').done }), true; }
    if (p === '/api/app/setup/check') return send(res, 200, await runCheck(url.searchParams.get('id'))), true;
    // A model row's download (sam2: object separation, whisper: transcription): its progress, start it (the row's
    // picked model unless one is named), stop it.
    const md = /^\/api\/app\/setup\/(sam2|whisper|mlx)(\/download|\/stop)?$/.exec(p);
    if (md) {
      const fam = md[1], have = fam === 'sam2' ? sam2Have() : whisperModels(fam === 'mlx' ? 'mlx' : 'faster-whisper');
      if (!md[2] && !post) return send(res, 200, { ...downloadState(fam), have }), true;
      if (md[2] === '/stop' && post) return send(res, 200, stopDownload(fam)), true;
      if (md[2] === '/download' && post) {
        const id = fam === 'sam2' ? 'objsep' : 'whisper';
        const size = b.size ? String(b.size) : (lastChecks.get(id) || await runCheck(id))[id === 'objsep' ? 'sam2' : 'whisper'].picked;
        return send(res, 200, startDownload(fam, size)), true;
      }
    }
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


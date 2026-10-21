// The Settings page's data: one section per row (Claude, Transcription, Rendering, Recording, Sound, Folders,
// Appearance, Look). Appearance is how Video Octopus itself looks (web/looks.css); Look is the video's own look.
// Non-secret values go in local/settings.json next to the app's other settings; API keys live in the system's key
// store (keychain.mjs: the Keychain on a Mac, DPAPI on Windows) and reach Claude Code and the skills only as
// environment variables.
import { existsSync, readdirSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { settings, saveSettings, readJSON, writeJSON, expandHome, hfHub, IS_MAC, LOCAL_DIR } from './util.mjs';
import { hasKey, readKey, KEY_STORE } from './keychain.mjs';
import { SAM2_MODELS, SAM2_SIZES, sam2Have, sam2Recommend, sam2Machine } from './sam2.mjs';
import { FAMILIES, downloaded, sources, sourceLine } from './hfmodels.mjs';

// Cloud transcription providers. A Test button only where the provider documents a plain auth check:
// Deepgram GET /v1/projects (Authorization: Token), AssemblyAI GET /v2/transcript (Authorization: <key>),
// OpenAI GET /v1/models (Bearer). ElevenLabs keys can be limited to some endpoints, so no Test there.
export const PROVIDERS = {
  deepgram: { label: 'Deepgram', key: 'DEEPGRAM_API_KEY', site: 'https://console.deepgram.com' },
  assemblyai: { label: 'AssemblyAI', key: 'ASSEMBLYAI_API_KEY', site: 'https://www.assemblyai.com/dashboard' },
  openai: { label: 'OpenAI', key: 'OPENAI_API_KEY', site: 'https://platform.openai.com/api-keys' },
  elevenlabs: { label: 'ElevenLabs', key: 'ELEVENLABS_API_KEY', site: 'https://elevenlabs.io/app/settings/api-keys' },
};

// Every key Video Octopus knows, and how its Test asks the provider "is this key good?" (nothing else is sent).
export const KEYS = {
  ANTHROPIC_API_KEY: { label: 'Claude API key', test: (k) => ['https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': k, 'anthropic-version': '2023-06-01' }] },
  DEEPGRAM_API_KEY: { label: 'Deepgram key', test: (k) => ['https://api.deepgram.com/v1/projects', { Authorization: `Token ${k}` }] },
  ASSEMBLYAI_API_KEY: { label: 'AssemblyAI key', test: (k) => ['https://api.assemblyai.com/v2/transcript?limit=1', { Authorization: k }] },
  OPENAI_API_KEY: { label: 'OpenAI key', test: (k) => ['https://api.openai.com/v1/models', { Authorization: `Bearer ${k}` }] },
  ELEVENLABS_API_KEY: { label: 'ElevenLabs key', test: null },
  // The OpenAI-compatible endpoint pi uses when Settings → Claude & Codex → pi → "Any OpenAI-compatible endpoint".
  OPENAI_COMPATIBLE_API_KEY: { label: 'Endpoint key', test: null },
  // The provider Claude Code uses when its model source is "Another provider" (claude-source.mjs). It only ever goes to
  // that provider, as Claude Code's token: never into other chats' environments.
  ANTHROPIC_COMPATIBLE_API_KEY: { label: 'Provider key', test: null },
};

// faster-whisper models, biggest first (their repos, sizes, makers and licences: server/hfmodels.mjs, from Hugging Face).
export const MODELS = Object.keys(FAMILIES.whisper.models);
// Video Octopus's looks (Settings → Appearance, web/looks.css). Edit Bay is today's look and the default.
export const LOOKS = ['editbay', 'night', 'paper', 'frost', 'swiss', 'clay', 'atelier', 'control', 'cinema', 'split'];
export const LANGS = { auto: 'Detect', en: 'English', de: 'German', es: 'Spanish', fr: 'French', it: 'Italian', nl: 'Dutch', pl: 'Polish', pt: 'Portuguese' };

const SECTIONS = {
  // Settings → Agent & model. Named "claude" from when Claude Code was the only agent; it holds Codex's and pi's fields
  // too. The name stays: it's how settings.json already stores it.
  claude: { useApiKey: false, engine: 'claude', codexProvider: 'chatgpt', codexModel: '', piSource: 'pi', piModel: '', piBaseUrl: '', piVision: false, piContext: 128000,
    // Claude Code's model source (claude-source.mjs): plan | ollama | lmstudio | provider; URL (empty = the local server's
    // default), model, context window (0 = 32K for a local model, Claude Code's own idea for a provider's).
    ccSource: 'plan', ccUrl: '', ccModel: '', ccContext: 0,
    // Clean chats: Claude Code with only the studio's own skills and settings (claude.mjs). On by default.
    lean: true },
  // whisperEngine: the Whisper build on this computer: mlx (Apple Silicon's GPU) or faster-whisper; auto = the recommended one.
  transcribe: { engine: 'local', model: 'auto', whisperEngine: 'auto', provider: 'deepgram', language: 'auto', vocab: [] },
  render: { engine: 'local', jobs: 0, size: '1080p', codec: 'h264' },
  // Settings → Recording: what the record panel starts with. screen 'screen' (the browser's picker) or 'none' (camera
  // or mic only); camera and mic are the browser's device ids ('default' = the system's, 'none' = don't record it).
  recorder: { screen: 'screen', camera: 'default', mic: 'default', target: 'replace', countdown: 3 },
  sound: { claude: true, epidemic: false, library: '', fxDb: -18 },
  look: { background: 'night-desk', pip: 'rounded', colors: [], fonts: '' },
  appearance: { look: 'editbay', calm: false },
  editing: { trimHighlight: false, trimLens: false },
  // Settings → Rendering → Object separation: the SAM 2.1 model the object-separation skill uses; auto = the one
  // Setup recommends for this computer (server/sam2.mjs).
  objsep: { model: 'auto' },
  // agent: what the creator connected on the onboarding screen ('' until they click Connect).
  setup: { done: false, agent: '' },
  updates: { auto: true }, // Settings → Updates: check GitHub quietly when Video Octopus starts (server/updates.mjs)
  // First-time help that shows once (in settings, not the browser, so it never comes back): stepsIntro = the
  // "How a video gets made here" dialog on the first project page (web/rail.js); 'dismissed' after Got it or Start.
  help: { stepsIntro: '' },
};
export const section = (name, s = settings()) => (name === 'recorder' ? recorderSection(s) : { ...SECTIONS[name], ...(s[name] || {}) });

// The recorder's choices, only the keys it has. Older settings files kept the screen, camera and mic under
// recorder.browser, next to keys of an earlier recorder (engine, display, camera, mic, mode): the recorder.browser
// choices are taken from there, the rest is ignored and dropped from the file on the next save (saveSection,
// browser-recorder.mjs).
export function recorderSection(s = settings()) {
  const r = s.recorder && typeof s.recorder === 'object' ? s.recorder : {};
  const old = ['browser', 'engine', 'display', 'mode'].some((k) => k in r);
  const pick = old ? (r.browser && typeof r.browser === 'object' ? r.browser : {}) : r;
  const out = { ...SECTIONS.recorder };
  if (['screen', 'none'].includes(pick.screen)) out.screen = pick.screen;
  for (const k of ['camera', 'mic']) if (typeof pick[k] === 'string' && pick[k].trim()) out[k] = pick[k].trim().slice(0, 300);
  if (['replace', 'layer'].includes(r.target)) out.target = r.target;
  const n = Number(r.countdown);
  if (r.countdown !== undefined && r.countdown !== null && r.countdown !== '' && Number.isFinite(n)) out.countdown = Math.min(10, Math.max(0, Math.round(n)));
  return out;
}

// What each field may hold: a list of choices, [min, max] for numbers, or a kind.
const RULES = {
  claude: { useApiKey: 'bool', engine: ['claude', 'codex', 'pi'], codexProvider: ['chatgpt', 'lmstudio', 'ollama'], codexModel: 'str',
    piSource: ['pi', 'endpoint'], piModel: 'str', piBaseUrl: 'str', piVision: 'bool', piContext: [4096, 4000000],
    ccSource: ['plan', 'ollama', 'lmstudio', 'provider'], ccUrl: 'url', ccModel: 'str', ccContext: [0, 4000000], lean: 'bool' },
  transcribe: { engine: ['local', 'cloud'], model: ['auto', ...MODELS], whisperEngine: ['auto', 'mlx', 'faster-whisper'], provider: Object.keys(PROVIDERS), language: Object.keys(LANGS), vocab: 'words' },
  render: { engine: ['local'], jobs: [0, 64], size: ['1080p', '4k'], codec: ['h264', 'hevc', 'prores'] },
  recorder: { screen: ['screen', 'none'], camera: 'str', mic: 'str', target: ['replace', 'layer'], countdown: [0, 10] },
  sound: { claude: 'bool', epidemic: 'bool', library: 'str', fxDb: [-40, 0] },
  look: { background: ['night-desk', 'stars', 'led'], pip: ['rounded', 'circle', 'frame'], colors: 'colors', fonts: 'str' },
  appearance: { look: LOOKS, calm: 'bool' },
  editing: { trimHighlight: 'bool', trimLens: 'bool' },
  objsep: { model: ['auto', ...SAM2_SIZES] },
  setup: { done: 'bool', agent: ['', 'claude', 'codex', 'pi', 'lmstudio', 'ollama'] },
  updates: { auto: 'bool' },
  help: { stepsIntro: ['', 'dismissed'] },
};

function clean(rule, v) {
  if (Array.isArray(rule) && typeof rule[0] === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error('Expected a number.');
    return Math.min(rule[1], Math.max(rule[0], Math.round(n)));
  }
  if (Array.isArray(rule)) { if (!rule.includes(v)) throw new Error(`Unknown choice: ${v}`); return v; }
  if (rule === 'bool') return Boolean(v);
  if (rule === 'str') return String(v ?? '').slice(0, 300);
  if (rule === 'url') { const u = String(v ?? '').trim().slice(0, 300); if (u && !/^https?:\/\/[^\s/]+\S*$/i.test(u)) throw new Error('A URL starts with http:// or https://.'); return u; }
  if (rule === 'words') return (Array.isArray(v) ? v : String(v ?? '').split(/[,\n]/)).map((w) => String(w).trim()).filter(Boolean).slice(0, 200);
  if (rule === 'colors') return (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).map((c) => c.trim()).filter((c) => /^#[0-9a-f]{3,8}$/i.test(c)).slice(0, 8);
  throw new Error('Unknown field.');
}

const listeners = new Set();
export const onSettingsChange = (fn) => listeners.add(fn);
export const settingsChanged = (what) => { for (const fn of listeners) fn(what); };

// Save one section from the page. Claude's permission mode and model and the folders are top-level settings.
export function saveSection(name, patch = {}) {
  const top = {};
  if (name === 'claude') {
    const modes = ['manual', 'acceptEdits', 'auto', 'bypassPermissions'];
    if ('permissionMode' in patch) { if (!modes.includes(patch.permissionMode)) throw new Error('Unknown permission mode.'); top.permissionMode = patch.permissionMode; }
    if ('model' in patch) { if (!/^[\w.[\]-]{0,60}$/.test(patch.model)) throw new Error('Bad model name.'); top.model = patch.model; }
    delete patch.permissionMode; delete patch.model;
  }
  if (name === 'folders') return saveFolders(patch);
  if (name === 'recording' || name === 'recorder') {
    // Empty = the default again: <studio>/recordings (util.mjs settings()).
    if ('recordingsDir' in patch) { top.recordingsDir = String(patch.recordingsDir || '').trim() || undefined; delete patch.recordingsDir; }
    name = 'recorder';
  }
  const rules = RULES[name];
  if (!rules) throw new Error('Unknown section.');
  const next = name === 'recorder' ? recorderSection() : { ...(settings()[name] || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in rules)) throw new Error(`Unknown setting: ${k}`);
    next[k] = clean(rules[k], v);
  }
  saveSettings({ ...top, [name]: next });
  settingsChanged(name);
  return settings();
}

function saveFolders(p) {
  const top = {};
  const rel = (v, what) => {
    v = String(v ?? '').trim().replace(/^\.\/|\/$/g, '');
    if (!v || isAbsolute(v) || v.split('/').includes('..') || v.startsWith('~')) throw new Error(`The ${what} folder is a name inside the studio folder, like "projects".`);
    return v;
  };
  if ('studio' in p) {
    const v = String(p.studio || '').trim();
    if (!v || !existsSync(expandHome(v))) throw new Error('That studio folder does not exist.');
    top.studio = v;
  }
  if ('projectsDir' in p) top.projectsDir = rel(p.projectsDir, 'projects');
  if ('libraryDir' in p) top.libraryDir = rel(p.libraryDir, 'library');
  saveSettings(top);
  settingsChanged('folders');
  return settings();
}

// Restart a chat with the new settings once it's idle (the next message reopens the same conversation).
export function restartWhenIdle(chat) {
  if (!chat?.proc) return;
  if (!chat.busy) return chat.restart();
  if (chat.restartPending) return;
  chat.restartPending = true;
  const fn = (ev) => {
    if (ev.t !== 'busy' || ev.busy) return;
    chat.listeners.delete(fn);
    chat.restartPending = false;
    chat.restart();
  };
  chat.listeners.add(fn);
}

// ---- keys and environment for child processes ----
export async function keyStatus() {
  const names = Object.keys(KEYS);
  const set = await Promise.all(names.map((n) => hasKey(n).catch(() => false)));
  return Object.fromEntries(names.map((n, i) => [n, set[i]]));
}

// Environment for Claude Code and the scripts Video Octopus starts: saved keys plus STUDIO_TRANSCRIBE and friends.
// The Claude API key only when "Use an API key instead" is on (Claude Code then bills that key, not the plan) and
// Claude Code runs on the plan; the provider key of Claude Code's other model source never (claude-source.mjs passes it).
export async function childEnv() {
  const s = settings();
  const t = section('transcribe', s);
  const env = {};
  const c = section('claude', s), useApi = c.useApiKey && (c.ccSource || 'plan') === 'plan';
  const names = Object.keys(KEYS).filter((n) => (n !== 'ANTHROPIC_API_KEY' || useApi) && n !== 'ANTHROPIC_COMPATIBLE_API_KEY');
  const values = await Promise.all(names.map((n) => readKey(n).catch(() => null)));
  names.forEach((n, i) => { if (values[i]) env[n] = values[i]; });
  // A cloud service without its key saved transcribes on this computer (the brief and the system prompt say so).
  const cloud = t.engine === 'cloud' && PROVIDERS[t.provider] && env[PROVIDERS[t.provider].key];
  env.STUDIO_TRANSCRIBE = cloud ? t.provider : 'local';
  if (t.engine !== 'cloud' && t.model !== 'auto') env.STUDIO_TRANSCRIBE_MODEL = t.model;
  if (!cloud) env.STUDIO_TRANSCRIBE_ENGINE = await whisperEngine(); // mlx | faster-whisper, for the transcribe skill
  if (t.language !== 'auto') env.STUDIO_TRANSCRIBE_LANGUAGE = t.language;
  const o = section('objsep', s);
  if (o.model !== 'auto') env.STUDIO_OBJSEP_MODEL = o.model; // the object-separation skill's model (else its own pick)
  if (t.vocab.length) env.STUDIO_TRANSCRIBE_VOCAB = t.vocab.join(', ');
  return env;
}

// A few lines for every chat's system prompt: the engines picked here and which keys are in the environment
// (names only). `env` is childEnv()'s result.
export function settingsBrief(env = {}, { profileScoped = false } = {}) {
  const s = settings();
  const t = section('transcribe', s), r = section('render', s), so = section('sound', s), lk = section('look', s);
  const p = PROVIDERS[t.provider];
  const lines = ['Video Octopus settings (the creator changes these in Video Octopus\'s Settings page):'];
  lines.push(t.engine === 'cloud' && env[p.key]
    ? `- Transcription: cloud, ${p.label} (STUDIO_TRANSCRIBE=${t.provider}, key in $${p.key}). Transcribe through ${p.label}'s API and write the same files the transcribe skill writes (words.json [[start, end, word], …] and the SRT).`
    : t.engine === 'cloud'
      ? `- Transcription: Settings pick ${p.label}, but no ${p.label} key is saved, so transcribe on this computer with the transcribe skill (--model auto); unless a note from Video Octopus in the chat already says so, tell the creator once that the key goes in Settings → Transcription.`
      : `- Transcription: on this computer with the transcribe skill (STUDIO_TRANSCRIBE=local, ${t.model !== 'auto' ? `model ${t.model}` : '--model auto: the best verbatim model already downloaded'}). Never run two transcriptions side by side; the rough cut's filler pass goes in the same run (--fill-out).`);
  if (t.language !== 'auto' || t.vocab.length) lines.push(`- Transcription language: ${LANGS[t.language]}${t.vocab.length ? `. Always spell these right (pass them as the prompt): ${t.vocab.join(', ')}` : ''}.`);
  lines.push(`- Rendering: on this computer${r.jobs ? `, up to ${r.jobs} jobs in parallel` : ''}; default output ${r.size === '4k' ? '4K' : '1080p'} ${{ h264: 'H.264', hevc: 'HEVC', prores: 'ProRes' }[r.codec]}.`);
  lines.push('- Python: transcription on this computer, the rough cut, join check, tools/cut/apply_edit.py and object separation run Python (the studio\'s .venv first). When a step needs it and it isn\'t there (Setup may have said "Not needed"), say so in one line, offer to set it up (Python 3.10+, a .venv in the studio with its requirements.txt) and ask before installing anything.');
  const o = section('objsep', s), sam = sam2Have();
  lines.push(`- Object separation: the object-separation skill with SAM 2.1 ${o.model === 'auto' ? 'as recommended for this computer (--model left out: its own pick)' : `${o.model} (STUDIO_OBJSEP_MODEL=${o.model})`}; downloaded: ${sam.length ? sam.join(', ') : 'none yet'}. The skill never downloads a model: when it isn't there, the creator presses Download in Video Octopus's Setup (Object separation row) or picks another one in Settings → Rendering.`);
  lines.push(`- Sound sources: ${[so.claude && 'made by Claude', so.epidemic && 'Epidemic Sound (through its connector)', so.library && `the library folder ${so.library}`].filter(Boolean).join(', ') || 'none picked'}; effects sit about ${Math.abs(so.fxDb)} dB under the voice (an effect's loudest 0.2 s against the voice's level while it talks: Video Octopus's export and canvas mix sound cues this way, so mix your renders the same).`);
  lines.push(`- Look defaults: background ${{ 'night-desk': 'Night Desk', stars: 'Stars', led: 'LED wave' }[lk.background]}, picture-in-picture frame ${lk.pip}${!profileScoped && lk.colors.length ? `, brand colours ${lk.colors.join(' ')}` : ''}${!profileScoped && lk.fonts ? `, fonts ${lk.fonts}` : ''}.`);
  const keys = Object.keys(KEYS).filter((n) => env[n]);
  lines.push(`- API keys from ${KEY_STORE} are in your environment${keys.length ? `: ${keys.join(', ')}` : ' (none saved yet)'}. Never print, log or write a key anywhere; check one only by whether it is set or by its length. Never ask the creator to paste a key into a chat: keys go in Video Octopus's Settings, which keeps them in ${KEY_STORE}.`);
  const pr = profileScoped ? null : profile();
  if (pr && (pr.who || pr.make || pr.brand || pr.creators || pr.tone || pr.formats?.length)) {
    lines.push(`- About the creator (Setup interview): ${[pr.who && `who: ${pr.who}`, pr.make && `makes ${pr.make}`, pr.formats?.length && `formats: ${pr.formats.join(', ')}`, pr.tone && `tone: ${pr.tone}`, pr.brand && `brand: ${pr.brand}`, pr.creators && `likes the editing of ${pr.creators}`].filter(Boolean).join('; ')}.`);
  }
  // The studio's own brand and style notes (Setup writes BRAND.md; STYLE.md is the fuller guide the assistant drafts).
  const own = !profileScoped && s.studio ? ['BRAND.md', 'STYLE.md'].filter((f) => existsSync(join(s.studio, f))) : [];
  if (own.length) lines.push(`- The creator's brand and style: ${own.join(' and ')} in the studio folder. Read ${own.length > 1 ? 'them' : 'it'} before planning or building graphics; brand files are in the library's brand/ folder.`);
  return lines.join('\n');
}

// ---- the creator's answers from Setup (local/profile.json, inside the app, never the studio) ----
const PROFILE = join(LOCAL_DIR, 'profile.json');
export const profile = () => readJSON(PROFILE, null);
export function saveProfile(p = {}) {
  const str = (v) => String(v ?? '').trim().slice(0, 2000);
  const out = { who: str(p.who), make: str(p.make), formats: (Array.isArray(p.formats) ? p.formats : []).map(str).filter(Boolean).slice(0, 12), tone: str(p.tone), brand: str(p.brand), creators: str(p.creators), updated: new Date().toISOString() };
  writeJSON(PROFILE, out);
  settingsChanged('profile');
  return out;
}

// ---- this computer (for Rendering and Transcription) ----
const run = (bin, args, ms = 6000) => new Promise((done) => execFile(bin, args, { timeout: ms }, (err, out) => done(err ? '' : String(out).trim())));
let machine = null;
export async function machineInfo() {
  if (machine) return machine;
  if (!IS_MAC) return (machine = await otherMachine());
  const [chip, mem, perf, eff, ncpu, gpu, arm, rosetta] = await Promise.all([
    run('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']), run('/usr/sbin/sysctl', ['-n', 'hw.memsize']),
    run('/usr/sbin/sysctl', ['-n', 'hw.perflevel0.physicalcpu']), run('/usr/sbin/sysctl', ['-n', 'hw.perflevel1.physicalcpu']),
    run('/usr/sbin/sysctl', ['-n', 'hw.ncpu']), run('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json'], 10000),
    run('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']), run('/usr/sbin/sysctl', ['-n', 'sysctl.proc_translated']),
  ]);
  let gpuCores = null;
  try { gpuCores = Number(JSON.parse(gpu).SPDisplaysDataType?.[0]?.sppci_cores) || null; } catch {}
  const ramGB = Math.round(Number(mem) / 2 ** 30) || null;
  // Apple Silicon running natively (not an Intel build under Rosetta, which can't use MLX).
  const apple = /apple/i.test(chip) || arm === '1', arm64 = apple && rosetta !== '1';
  const m = { chip: chip || 'This computer', ramGB, cores: Number(ncpu) || null, perf: Number(perf) || null, eff: Number(eff) || null, gpuCores, apple, arm64,
    whisper: whisperPick({ apple, arm64, ramGB }) };
  return (machine = { ...m, sam: sam2Recommend(sam2Machine(m)) });
}

// The Whisper model and build for a computer (the transcribe skill's table). The size ladder by memory: 32 GB+ →
// large-v3, 16 GB → medium.en, smaller → small.en. Apple Silicon running natively: MLX Whisper (the Mac's GPU) at that
// size. An NVIDIA card: faster-whisper on CUDA, large-v3 with 8 GB+, else medium.en. Anything else (an Intel Mac, a
// Mac under Rosetta, Windows or Linux without NVIDIA): faster-whisper on the CPU (int8), one size down the ladder.
export function whisperPick({ apple = false, arm64 = false, ramGB = 0, gpu = null, vramMB = 0 } = {}) {
  const ladder = ['large-v3', 'medium.en', 'small.en', 'base.en'], step = ramGB >= 32 ? 0 : ramGB >= 16 ? 1 : 2;
  if (apple && arm64) return { model: ladder[step], engine: 'mlx', speed: 'on the Mac\'s GPU (MLX)' };
  if (gpu) return Number(vramMB) >= 8000 ? { model: 'large-v3', engine: 'faster-whisper', speed: 'faster than real time on the NVIDIA card' }
    : { model: 'medium.en', engine: 'faster-whisper', speed: 'about real time on the NVIDIA card' };
  return { model: ladder[step + 1], engine: 'faster-whisper', speed: 'on the CPU (int8): slower, so a size smaller' };
}

// The Whisper build in use: Settings → Transcription's, or for auto the recommended one (MLX only where it runs).
// Auto keeps to a build that has a model here: until an MLX model is downloaded, a computer with faster-whisper models
// goes on using them.
export async function whisperEngine(s = settings()) {
  const e = section('transcribe', s).whisperEngine, mac = await machineInfo();
  if (e === 'faster-whisper' || (e === 'mlx' && !mac.arm64)) return 'faster-whisper';
  if (e === 'mlx') return 'mlx';
  return mac.whisper.engine === 'mlx' && !downloaded('mlx').length && downloaded('whisper').length ? 'faster-whisper' : mac.whisper.engine;
}

// Whether something on this computer needs Python: transcription here (picked, or a cloud service whose key isn't
// saved), or a local model (LM Studio or Ollama behind Claude Code or Codex). Setup shows Python as "Not needed"
// otherwise and never blocks on it; the skills that still run Python (rough cut, join check, apply_edit, Auto-frame
// on Windows and Linux) ask for it the first time they need it.
export async function needsLocalPython(s = settings(), { has = hasKey } = {}) {
  const t = section('transcribe', s), c = section('claude', s), p = PROVIDERS[t.provider];
  const localTx = t.engine !== 'cloud' || !p || !(await has(p.key).catch(() => false));
  const engine = ['claude', 'codex', 'pi'].includes(c.engine) ? c.engine : 'claude';
  const localModel = (engine === 'claude' && ['lmstudio', 'ollama'].includes(c.ccSource)) || (engine === 'codex' && ['lmstudio', 'ollama'].includes(c.codexProvider));
  return localTx || localModel;
}

// Windows and Linux: the CPU and memory from Node, and an NVIDIA card if nvidia-smi is there (faster-whisper runs on
// CUDA; otherwise on the CPU, which is slower, so the pick is smaller).
async function otherMachine() {
  const list = cpus();
  const ramGB = Math.round(totalmem() / 2 ** 30) || null;
  const nv = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  const [gpu, vram] = nv ? nv.split('\n')[0].split(',').map((x) => x.trim()) : [];
  return { chip: (list[0]?.model || 'This computer').trim(), ramGB, cores: list.length || null, perf: null, eff: null, gpuCores: null, gpu: gpu || null,
    vramGB: Number(vram) ? Math.round(Number(vram) / 1024) : null, apple: false, arm64: false, whisper: whisperPick({ ramGB, gpu, vramMB: Number(vram) || 0 }),
    sam: sam2Recommend(sam2Machine({ gpu, vramGB: Number(vram) ? Number(vram) / 1024 : null })) };
}

// Whisper models already downloaded (the Hugging Face cache), for faster-whisper (Systran's repos) or MLX
// (mlx-community's): refs/main names a snapshot with the weights and the files around them (hfmodels.mjs), so a
// download that didn't finish never counts.
export const whisperModels = (engine = 'faster-whisper') => downloaded(engine === 'mlx' ? 'mlx' : 'whisper');

// What --model auto picks (the transcribe skill's order): the best verbatim model already downloaded, else medium.en
// for English (medium otherwise), which isn't downloaded yet.
export function autoWhisper(lang, have = whisperModels()) {
  const english = !lang || lang === 'en';
  return (english ? AUTO_ORDER.en : AUTO_ORDER.other).find((m) => have.includes(m)) || (english ? 'medium.en' : 'medium');
}

// How Clean up (and Transcribe) transcribe, from Settings → Transcription, as a few sentences for the step's brief:
// cloud with a key → that provider; cloud without one → this computer, and Video Octopus says once that no key is set;
// local → the model picked, or for Auto the transcribe skill's --model auto pick (the best verbatim model already
// downloaded: medium.en for English, then large-v3, medium, …; the same order as transcribe.py pick_model).
// fill: also the rough cut's filler pass into work/tr_fill/ (one run, one model loaded, the passes one after the
// other: two side by side took 4–5 min for a 2:43 take on an Apple Silicon Mac, one run ~1.5 min).
// Returns { text, fallback: the provider's name when it fell back to this computer, else null, model }.
export const AUTO_ORDER = { en: ['medium.en', 'large-v3', 'medium', 'small.en', 'small', 'base.en', 'tiny.en'], other: ['large-v3', 'medium', 'small', 'base', 'tiny'] };
// has: whether a key is saved (the Keychain; a test passes its own).
export async function transcribeHow({ fill = false, has = hasKey } = {}) {
  const t = section('transcribe');
  const p = PROVIDERS[t.provider];
  const lang = t.language !== 'auto' ? t.language : null;
  if (t.engine === 'cloud' && p && await has(p.key).catch(() => false)) {
    const fillers = { assemblyai: 'AssemblyAI: disfluencies on', deepgram: 'Deepgram: filler_words on', openai: 'OpenAI: a prompt full of fillers, like "Umm, uh, so, like, you know"' }[t.provider];
    return { model: null, fallback: null, text: `How (Settings → Transcription): through ${p.label}'s API, with the key in $${p.key} (never print it). Send the audio once with word timestamps${fill ? ` and filler words kept${fillers ? ` (${fillers})` : ''}` : ''}${lang ? `, language ${lang}` : ''}${t.vocab.length ? `, with these spelled right: ${t.vocab.join(', ')}` : ''}, and write the transcribe skill's files from it: words.json as [[start, end, word], …] and the SRT into work/tr/${fill ? ', and the same words.json into work/tr_fill/ (that one request is the filler pass too)' : ''}.` };
  }
  // On this computer: the model picked, or what --model auto picks, with the Whisper build (MLX or faster-whisper).
  const engine = await whisperEngine(), have = whisperModels(engine);
  const model = t.model !== 'auto' ? t.model : autoWhisper(lang, have);
  const size = have.includes(model) ? '' : (await sources(engine === 'mlx' ? 'mlx' : 'whisper', { cached: true }))[model]?.size;
  const extra = [lang && `--lang ${lang}`, t.vocab.length && `--prompt "${t.vocab.join(', ').replace(/"/g, '')}"`].filter(Boolean).join(' ');
  const cmd = `transcribe.py <file> --engine ${engine} --model ${t.model === 'auto' ? 'auto' : model} --out work/tr${fill ? ' --fill-out work/tr_fill' : ''}${extra ? ` ${extra}` : ''}`;
  const fallback = t.engine === 'cloud' && p ? p.label : null;
  const text = `${fallback ? `Settings → Transcription picks ${p.label}, but no ${p.label} key is saved, so transcribe on this computer this time. ` : ''}`
    + `How${fallback ? '' : ' (Settings → Transcription)'}: on this computer with ${model}${engine === 'mlx' ? ' on MLX Whisper' : ''}${fill ? ', both passes in one run (the model loads once and they go one after the other)' : ''}: the transcribe skill's ${cmd}.`
    + `${fill ? ' Never two transcriptions side by side: they fight over the same cores and take three times as long.' : ''}`
    + `${have.includes(model) ? '' : ` The ${model} model isn't downloaded on this computer yet${have.length ? ` (these are: ${have.join(', ')})` : ''}: the creator downloads it in Video Octopus's Setup (Transcription model (Whisper) → Download${size ? `, ${size}` : ''}), or ask me before downloading it, or use one that is here.`}`;
  return { model, fallback, text };
}

// The view the Settings page draws: values, which keys are set (never the keys), and what was found.
export async function settingsView() {
  const s = settings();
  return {
    values: {
      claude: { ...section('claude', s), permissionMode: s.permissionMode, model: s.model },
      transcribe: section('transcribe', s), render: section('render', s),
      recorder: { ...section('recorder', s), recordingsDir: s.recordingsDir },
      sound: section('sound', s), look: section('look', s), appearance: section('appearance', s), editing: section('editing', s), objsep: section('objsep', s),
      folders: { studio: s.studio, projectsDir: s.projectsDir, libraryDir: s.libraryDir || 'library', recordingsDir: s.recordingsDir },
      setup: section('setup', s), updates: section('updates', s),
    },
    keys: await keyStatus(), keyStore: KEY_STORE,
    keyInfo: Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, { label: v.label, test: Boolean(v.test) }])),
    providers: PROVIDERS, models: MODELS, langs: LANGS,
    machine: await machineInfo(), whisperEngine: await whisperEngine(s),
    downloaded: whisperModels(await whisperEngine(s)), autoWhisper: autoWhisper(section('transcribe', s).language === 'auto' ? null : section('transcribe', s).language, whisperModels(await whisperEngine(s))),
    // Where each model comes from, as last checked (Setup asks Hugging Face; a page that must answer at once only reads
    // what's kept, and a stale or missing one is asked again in the background for the next look).
    whisperSources: await modelSources(await whisperEngine(s) === 'mlx' ? 'mlx' : 'whisper'),
    // Object separation's models; the recommendation from the hardware here (Setup's row also asks torch).
    sam2: { models: SAM2_MODELS, have: sam2Have(), recommended: sam2Recommend(sam2Machine(await machineInfo())), sources: await modelSources('sam2') },
    envApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
  };
}

// The kept sources with each one's line, and a quiet refresh of what's missing or more than a day old.
async function modelSources(family) {
  const out = await sources(family, { cached: true });
  sources(family).catch(() => {});
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { ...v, line: sourceLine(v) }]));
}

// Test a saved key against the provider's documented auth check. Returns a sentence, never the key.
export async function testKey(name) {
  const k = KEYS[name];
  if (!k?.test) return { ok: false, text: 'There is no test for this key.' };
  const value = await readKey(name);
  if (!value) return { ok: false, text: 'No key saved.' };
  const [url, headers] = k.test(value);
  const host = new URL(url).host;
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (r.ok) return { ok: true, text: `Key works (${host} said yes).` };
    if (r.status === 401 || r.status === 403) return { ok: false, text: `${host} didn't accept this key (HTTP ${r.status}).` };
    return { ok: false, text: `Couldn't check: ${host} answered HTTP ${r.status}.` };
  } catch (e) {
    return { ok: false, text: `Couldn't reach ${host} (${e.name === 'TimeoutError' ? 'timed out' : e.message}).` };
  }
}

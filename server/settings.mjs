// The Settings page's data: one section per row (Claude, Transcription, Rendering, Recording, Sound, Folders,
// Appearance, Look). Appearance is how Video Octopus itself looks (theme, accent, sidebar: web/appearance.js); Look is
// the video's own look.
// Non-secret values go in local/settings.json next to the app's other settings; API keys live in the system's key
// store (keychain.mjs: the Keychain on a Mac, DPAPI on Windows) and reach Claude Code and the skills only as
// environment variables.
import { existsSync, readdirSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { settings, saveSettings, readJSON, writeJSON, expandHome, hfHub, IS_MAC, LOCAL_DIR } from './util.mjs';
import { EFFORTS, validModel } from './agent-choices.mjs';
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
// Settings → General → Appearance (design V2, 23 Oct 2026): Light, Dark or Match system, one of four accents, and the
// sidebar as icons only or icons and names. These replaced ten "looks"; THEME_OF_LOOK maps each old look to its theme
// (web/index.html's early script and web/appearance.js map an old browser cache the same way).
export const THEMES = ['light', 'dark', 'system'];
export const ACCENTS = ['orange', 'blue', 'green', 'violet'];
export const SIDEBARS = ['icons', 'labels'];
export const THEME_OF_LOOK = {
  editbay: 'system',
  paper: 'light', swiss: 'light', clay: 'light', atelier: 'light',
  night: 'dark', frost: 'dark', control: 'dark', cinema: 'dark', split: 'dark',
};
export const OLD_LOOKS = Object.keys(THEME_OF_LOOK);
export const LANGS = { auto: 'Detect', en: 'English', de: 'German', es: 'Spanish', fr: 'French', it: 'Italian', nl: 'Dutch', pl: 'Polish', pt: 'Portuguese' };

const SECTIONS = {
  // Settings → Agent & model. Named "claude" from when Claude Code was the only agent; it holds Codex's and pi's fields
  // too. The name stays: it's how settings.json already stores it.
  claude: { useApiKey: false, engine: 'claude', codexProvider: 'chatgpt', codexModel: '', piSource: 'pi', piModel: '', piBaseUrl: '', piVision: false, piContext: 128000,
    // Claude Code's model source (claude-source.mjs): plan | ollama | lmstudio | provider; URL (empty = the local server's
    // default), model, context window (0 = 32K for a local model, Claude Code's own idea for a provider's).
    ccSource: 'plan', ccUrl: '', ccModel: '', ccContext: 0,
    // Clean chats: Claude Code with only the studio's own skills and settings (claude.mjs). On by default.
    lean: true,
    // The studio-wide defaults the chat panel's pickers start from (server/agent-choices.mjs): '' = the agent's own.
    // Claude's model is the top-level `model` (older settings files have it there).
    claudeEffort: '', codexEffort: '', piThinking: '' },
  // whisperEngine: the engine on this computer: mlx (MLX Whisper, Apple Silicon's GPU), faster-whisper, or parakeet
  // (Parakeet through parakeet-mlx, Apple Silicon's GPU, offered when the selected Python has it); auto = the recommended Whisper build.
  transcribe: { engine: 'local', model: 'auto', whisperEngine: 'auto', provider: 'deepgram', language: 'auto', vocab: [] },
  render: { engine: 'local', jobs: 0, size: '1080p', codec: 'h264' },
  // Settings → Recording: what the record panel starts with. screen 'screen' (the browser's picker) or 'none' (camera
  // or mic only); camera and mic are the browser's device ids ('default' = the system's, 'none' = don't record it).
  recorder: { screen: 'screen', camera: 'default', mic: 'default', target: 'replace', countdown: 3 },
  sound: { claude: true, epidemic: false, library: '', fxDb: -18 },
  look: { background: 'night-desk', pip: 'rounded', colors: [], fonts: '' },
  // migratedFrom: the old look's id after the one-time migration, until the creator dismisses the note ('' after).
  appearance: { theme: 'system', accent: 'orange', sidebar: 'labels', migratedFrom: '' },
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
  // Settings › Storage: what Delete recording does. ask = the two-choice question each time; video = Remove from this
  // video (the take stays in Recordings); bin = Delete recording (this video and Recordings, to the computer's Bin).
  storage: { deleteRecording: 'ask' },
};
export const section = (name, s = settings()) => {
  if (name === 'recorder') return recorderSection(s);
  if (name === 'appearance') return appearanceSection(s);
  return { ...SECTIONS[name], ...(s[name] || {}) };
};

// The appearance a settings file had before the themes: { look, calm } → { theme, migratedFrom }. Pure, for tests.
// Returns null when there is nothing to migrate (no old keys). A missing or unknown look counts as Edit Bay, the old
// default, which becomes Match system.
export function migrateAppearance(stored) {
  const a = stored && typeof stored === 'object' ? stored : {};
  if (!('look' in a) && !('calm' in a)) return null;
  const look = OLD_LOOKS.includes(a.look) ? a.look : 'editbay';
  const next = { ...a };
  delete next.look;
  delete next.calm;
  if (!THEMES.includes(next.theme)) next.theme = THEME_OF_LOOK[look];
  next.migratedFrom = look;
  return next;
}

// Settings → Appearance, migrated once: a file that still has `look` gets the theme written in its place (and the old
// keys removed) the first time it is read, so the change happens server side for every page and browser.
export function appearanceSection(s = settings()) {
  let stored = s.appearance && typeof s.appearance === 'object' ? s.appearance : {};
  const migrated = migrateAppearance(stored);
  if (migrated) {
    try { saveSettings({ appearance: migrated }); } catch {}
    stored = migrated;
  }
  const out = { ...SECTIONS.appearance };
  if (THEMES.includes(stored.theme)) out.theme = stored.theme;
  if (ACCENTS.includes(stored.accent)) out.accent = stored.accent;
  if (SIDEBARS.includes(stored.sidebar)) out.sidebar = stored.sidebar;
  if (OLD_LOOKS.includes(stored.migratedFrom)) out.migratedFrom = stored.migratedFrom;
  return out;
}

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
    ccSource: ['plan', 'ollama', 'lmstudio', 'provider'], ccUrl: 'url', ccModel: 'str', ccContext: [0, 4000000], lean: 'bool',
    claudeEffort: ['', ...EFFORTS.claude], codexEffort: ['', ...EFFORTS.codex], piThinking: ['', ...EFFORTS.pi] },
  transcribe: { engine: ['local', 'cloud'], model: ['auto', ...MODELS], whisperEngine: ['auto', 'mlx', 'faster-whisper', 'parakeet'], provider: Object.keys(PROVIDERS), language: Object.keys(LANGS), vocab: 'words' },
  render: { engine: ['local'], jobs: [0, 64], size: ['1080p', '4k'], codec: ['h264', 'hevc', 'prores'] },
  recorder: { screen: ['screen', 'none'], camera: 'str', mic: 'str', target: ['replace', 'layer'], countdown: [0, 10] },
  sound: { claude: 'bool', epidemic: 'bool', library: 'str', fxDb: [-40, 0] },
  look: { background: ['night-desk', 'stars', 'led'], pip: ['rounded', 'circle', 'frame'], colors: 'colors', fonts: 'str' },
  appearance: { theme: THEMES, accent: ACCENTS, sidebar: SIDEBARS, migratedFrom: ['', ...OLD_LOOKS] },
  editing: { trimHighlight: 'bool', trimLens: 'bool' },
  objsep: { model: ['auto', ...SAM2_SIZES] },
  setup: { done: 'bool', agent: ['', 'claude', 'codex', 'pi', 'lmstudio', 'ollama'] },
  updates: { auto: 'bool' },
  help: { stepsIntro: ['', 'dismissed'] },
  storage: { deleteRecording: ['ask', 'video', 'bin'] },
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
    if ('model' in patch) { if (patch.model && !validModel('claude', patch.model)) throw new Error('Bad model name.'); top.model = patch.model; }
    if ('codexModel' in patch && patch.codexModel && !validModel('codex', String(patch.codexModel).trim())) throw new Error('Bad model name.');
    if ('piModel' in patch && patch.piModel && !validModel('pi', String(patch.piModel).trim())) throw new Error('Bad model name.');
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
  const next = name === 'recorder' ? recorderSection()
    : name === 'appearance' ? appearanceSection()
      : { ...(settings()[name] || {}) };
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
  if (s.python) env.STUDIO_PYTHON = expandHome(s.python);
  const c = section('claude', s), useApi = c.useApiKey && (c.ccSource || 'plan') === 'plan';
  const names = Object.keys(KEYS).filter((n) => (n !== 'ANTHROPIC_API_KEY' || useApi) && n !== 'ANTHROPIC_COMPATIBLE_API_KEY');
  const values = await Promise.all(names.map((n) => readKey(n).catch(() => null)));
  names.forEach((n, i) => { if (values[i]) env[n] = values[i]; });
  // A cloud service without its key saved transcribes on this computer (the brief and the system prompt say so).
  const cloud = t.engine === 'cloud' && PROVIDERS[t.provider] && env[PROVIDERS[t.provider].key];
  env.STUDIO_TRANSCRIBE = cloud ? t.provider : 'local';
  const local = cloud ? null : await whisperEngine(); // mlx | faster-whisper | parakeet, for the transcribe skill
  // A Whisper size means nothing to Parakeet: it picks its own model by language (--model auto).
  if (t.engine !== 'cloud' && t.model !== 'auto' && local !== 'parakeet') env.STUDIO_TRANSCRIBE_MODEL = t.model;
  if (!cloud) env.STUDIO_TRANSCRIBE_ENGINE = local;
  if (t.language !== 'auto') env.STUDIO_TRANSCRIBE_LANGUAGE = t.language;
  const o = section('objsep', s);
  if (o.model !== 'auto') env.STUDIO_OBJSEP_MODEL = o.model; // the object-separation skill's model (else its own pick)
  if (t.vocab.length) env.STUDIO_TRANSCRIBE_VOCAB = t.vocab.join(', ');
  return env;
}

// A path in the agent's brief, quoted but exactly as it is on disk: JSON quoting would double every Windows backslash
// (C:\\Users\\…), which is not the path an agent should type. JSON only for a path that itself contains a quote.
export function quotedPath(path) {
  return /["\r\n]/.test(path) ? JSON.stringify(path) : `"${path}"`;
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
      : t.whisperEngine === 'parakeet' && env.STUDIO_TRANSCRIBE_ENGINE === 'parakeet'
        ? `- Transcription: on this computer with the transcribe skill and Parakeet on the Mac's GPU (STUDIO_TRANSCRIBE=local, STUDIO_TRANSCRIBE_ENGINE=parakeet, --engine parakeet --model auto: parakeet-tdt-0.6b-v2 for English, v3 for other European languages, only ones already downloaded). Never run two transcriptions side by side; --fill-out writes the same words again (Parakeet takes no prompt).`
        : `- Transcription: on this computer with the transcribe skill (STUDIO_TRANSCRIBE=local, ${t.model !== 'auto' ? `model ${t.model}` : '--model auto: the best verbatim model already downloaded'}). Never run two transcriptions side by side; the rough cut's filler pass goes in the same run (--fill-out).`);
  if (t.language !== 'auto' || t.vocab.length) lines.push(`- Transcription language: ${LANGS[t.language]}${t.vocab.length ? `. Always spell these right (pass them as the prompt): ${t.vocab.join(', ')}` : ''}.`);
  lines.push(`- Rendering: on this computer${r.jobs ? `, up to ${r.jobs} jobs in parallel` : ''}; default output ${r.size === '4k' ? '4K' : '1080p'} ${{ h264: 'H.264', hevc: 'HEVC', prores: 'ProRes' }[r.codec]}.`);
  if (s.python) lines.push(`- Selected Python: ${quotedPath(expandHome(s.python))}. Use this executable (also STUDIO_PYTHON) for all Python tools. Its directory is on PATH. Do not substitute another project environment or install into this shared environment without permission.`);
  lines.push(`- Python: transcription on this computer, the rough cut, join check, tools/cut/apply_edit.py and object separation run Python ($STUDIO_PYTHON, the Python selected in Video Octopus, first; otherwise the studio's .venv).${s.python ? '' : ' No Python is selected yet.'} When a step needs Python and neither is there (Setup may have said "Not needed"), do not offer to create a new environment first: this computer may already have one (a project's .venv, or another app's, such as OpenToolkit's). Say so in one line and point the creator to Video Octopus's Setup → Check my computer → Python environments, which finds them and offers "Use this" on the best match. Only if none fits, offer to set one up (Python 3.10+, a .venv in the studio with its requirements.txt), and ask before installing anything.`);
  const o = section('objsep', s), sam = sam2Have();
  lines.push(`- Object separation: the object-separation skill with SAM 2.1 ${o.model === 'auto' ? 'as recommended for this computer (--model left out: its own pick)' : `${o.model} (STUDIO_OBJSEP_MODEL=${o.model})`}; downloaded: ${sam.length ? sam.join(', ') : 'none yet'}. The skill never downloads a model: when it isn't there, the creator presses Download in Video Octopus's Setup (Object separation row) or picks another one in Settings → Rendering.`);
  lines.push(`- Sound sources: ${[so.claude && 'made by Claude', so.epidemic && 'Epidemic Sound (through its connector)', so.library && `the library folder ${so.library}`].filter(Boolean).join(', ') || 'none picked'}; effects sit about ${Math.abs(so.fxDb)} dB under the voice (an effect's loudest 0.2 s against the voice's level while it talks: Video Octopus's export and canvas mix sound cues this way, so mix your renders the same).`);
  // With channel profiles, brand identity comes only from a channel's approved brand (pinned per project): the
  // install-wide colours and fonts, the Setup interview's brand line and the studio's BRAND.md would contradict it.
  const profiles = Boolean(s.studio && existsSync(join(s.studio, '.studio', 'profile-storage.json')));
  const legacyBrand = !profileScoped && !profiles;
  lines.push(`- Look defaults: background ${{ 'night-desk': 'Night Desk', stars: 'Stars', led: 'LED wave' }[lk.background]}, picture-in-picture frame ${lk.pip}${legacyBrand && lk.colors.length ? `, brand colours ${lk.colors.join(' ')}` : ''}${legacyBrand && lk.fonts ? `, fonts ${lk.fonts}` : ''}.`);
  const keys = Object.keys(KEYS).filter((n) => env[n]);
  lines.push(`- API keys from ${KEY_STORE} are in your environment${keys.length ? `: ${keys.join(', ')}` : ' (none saved yet)'}. Never print, log or write a key anywhere; check one only by whether it is set or by its length. Never ask the creator to paste a key into a chat: keys go in Video Octopus's Settings, which keeps them in ${KEY_STORE}.`);
  const pr = profileScoped ? null : profile();
  if (pr && (pr.who || pr.make || pr.brand || pr.creators || pr.tone || pr.formats?.length)) {
    const about = [pr.who && `who: ${pr.who}`, pr.make && `makes ${pr.make}`, pr.formats?.length && `formats: ${pr.formats.join(', ')}`, pr.tone && `tone: ${pr.tone}`, legacyBrand && pr.brand && `brand: ${pr.brand}`, pr.creators && `likes the editing of ${pr.creators}`].filter(Boolean);
    if (about.length) lines.push(`- About the creator (Setup interview): ${about.join('; ')}.`);
  }
  if (profiles && !profileScoped) lines.push('- Brand: each channel has its own approved brand (Video formats → the channel); a project uses the one it was made with. There is no studio-wide brand to apply.');
  // The studio's own brand and style notes (Setup writes BRAND.md; STYLE.md is the fuller guide the assistant drafts).
  const own = legacyBrand && s.studio ? ['BRAND.md', 'STYLE.md'].filter((f) => existsSync(join(s.studio, f))) : [];
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
// Parakeet only where it runs: Apple Silicon running natively, with a selected Python whose check found parakeet-mlx;
// otherwise the Whisper pick below. Auto also leaves a build whose best downloaded model is a small one (tiny, base,
// small) for the other build's medium or large one: tiny.en on the GPU is no better pick than medium.en on the CPU.
export async function whisperEngine(s = settings()) {
  return localEngine({ choice: section('transcribe', s).whisperEngine, mac: await machineInfo(), python: s.python, pythonEngine: s.pythonEngine, pythonParakeet: s.pythonParakeet,
    have: { mlx: downloaded('mlx'), whisper: downloaded('whisper') } });
}
// The Whisper build alone (for the Whisper rows, and when Parakeet has no model for the language): never parakeet.
export async function whisperBuild(s = settings()) {
  const choice = section('transcribe', s).whisperEngine;
  return localEngine({ choice: choice === 'parakeet' ? 'auto' : choice, mac: await machineInfo(), python: s.python, pythonEngine: s.pythonEngine, have: { mlx: downloaded('mlx'), whisper: downloaded('whisper') } });
}
export const parakeetReady = ({ mac = {}, python = '', pythonParakeet = false } = {}) => Boolean(mac.arm64 && python && pythonParakeet);
const STRONG = ['large-v3', 'large-v3-turbo', 'distil-large-v3', 'medium', 'medium.en'];
export function localEngine({ choice = 'auto', mac = {}, python = '', pythonEngine = '', pythonParakeet = false, have = { mlx: [], whisper: [] } } = {}) {
  if (choice === 'parakeet' && parakeetReady({ mac, python, pythonParakeet })) return 'parakeet';
  if (choice === 'faster-whisper' || (choice === 'mlx' && !mac.arm64)) return 'faster-whisper';
  if (choice === 'mlx') return 'mlx';
  if (python && ['mlx', 'faster-whisper'].includes(pythonEngine)) return pythonEngine === 'mlx' && !mac.arm64 ? 'faster-whisper' : pythonEngine;
  const pick = mac.whisper?.engine || 'faster-whisper';
  if (pick !== 'mlx') return pick;
  const strong = (list) => list.some((m) => STRONG.includes(m));
  return (!have.mlx.length && have.whisper.length) || (!strong(have.mlx) && strong(have.whisper)) ? 'faster-whisper' : 'mlx';
}

// Parakeet's model for a language, from the ones downloaded (the transcribe skill's pick_parakeet): v2 for English,
// v3 for the other European languages it knows, and for Detect (v3 detects the language itself). Null: none fits.
export const PARAKEET_V3_LANGS = ['bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk'];
export function parakeetPick(lang, have = downloaded('parakeet')) {
  const v2 = 'parakeet-tdt-0.6b-v2', v3 = 'parakeet-tdt-0.6b-v3';
  const order = lang === 'en' ? [v2, v3] : !lang ? [v3, v2] : PARAKEET_V3_LANGS.includes(lang) ? [v3] : [];
  return { model: order.find((m) => have.includes(m)) || null, wanted: order[0] || null };
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
export const whisperModels = (engine = 'faster-whisper') => downloaded(engine === 'mlx' ? 'mlx' : engine === 'parakeet' ? 'parakeet' : 'whisper');

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
export const AUTO_ORDER = { en: ['medium.en', 'large-v3', 'large-v3-turbo', 'medium', 'small.en', 'small', 'base.en', 'tiny.en'], other: ['large-v3', 'large-v3-turbo', 'medium', 'small', 'base', 'tiny'] };
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
  const engine = await whisperEngine();
  if (engine === 'parakeet') {
    const pk = parakeetPick(lang, whisperModels('parakeet'));
    if (pk.model) {
      const cmd = `transcribe.py <file> --engine parakeet --model auto --out work/tr${fill ? ' --fill-out work/tr_fill' : ''}${lang ? ` --lang ${lang}` : ''}`;
      return { model: pk.model, fallback: null, text: `How (Settings → Transcription): on this computer with Parakeet (${pk.model}, parakeet-mlx on the Mac's GPU): the transcribe skill's ${cmd}, with the selected Python ($STUDIO_PYTHON).${fill ? ' Parakeet takes no prompt, so one pass writes both folders (--fill-out gets the same words); it can leave out some ums and repeats, so the rough cut finds fewer fillers.' : ''}${t.vocab.length ? ` Parakeet takes no spelling hints: check ${t.vocab.join(', ')} in the text afterwards.` : ''}` };
    }
    // No Parakeet model for this language here: the Whisper pick, said once.
  }
  const wengine = engine === 'parakeet' ? await whisperBuild() : engine;
  const note = engine === 'parakeet' ? `Settings → Transcription picks Parakeet, but no Parakeet model for ${lang ? LANGS[lang] || lang : 'this language'} is downloaded (${parakeetPick(lang, []).wanted || 'Parakeet does not know this language'}), so use Whisper this time. ` : '';
  return whisperHow({ t, p, lang, fill, engine: wengine, note });
}
async function whisperHow({ t, p, lang, fill, engine, note = '' }) {
  const have = whisperModels(engine);
  const model = t.model !== 'auto' ? t.model : autoWhisper(lang, have);
  const size = have.includes(model) ? '' : (await sources(engine === 'mlx' ? 'mlx' : 'whisper', { cached: true }))[model]?.size;
  const extra = [lang && `--lang ${lang}`, t.vocab.length && `--prompt "${t.vocab.join(', ').replace(/"/g, '')}"`].filter(Boolean).join(' ');
  const cmd = `transcribe.py <file> --engine ${engine} --model ${t.model === 'auto' ? 'auto' : model} --out work/tr${fill ? ' --fill-out work/tr_fill' : ''}${extra ? ` ${extra}` : ''}`;
  const fallback = t.engine === 'cloud' && p ? p.label : null;
  const text = `${note}${fallback ? `Settings → Transcription picks ${p.label}, but no ${p.label} key is saved, so transcribe on this computer this time. ` : ''}`
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
      setup: section('setup', s), updates: section('updates', s), storage: section('storage', s),
    },
    // The effort levels each agent's CLI takes (server/agent-choices.mjs), for Settings › Agent & model's defaults.
    efforts: EFFORTS,
    keys: await keyStatus(), keyStore: KEY_STORE,
    keyInfo: Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, { label: v.label, test: Boolean(v.test) }])),
    providers: PROVIDERS, models: MODELS, langs: LANGS,
    machine: await machineInfo(), whisperEngine: await whisperEngine(s),
    // Parakeet (Settings → Transcription offers it when the selected Python has parakeet-mlx on Apple Silicon).
    parakeet: { ready: parakeetReady({ mac: await machineInfo(), python: s.python, pythonParakeet: s.pythonParakeet }), python: s.python || '', have: whisperModels('parakeet'),
      pick: parakeetPick(section('transcribe', s).language === 'auto' ? null : section('transcribe', s).language, whisperModels('parakeet')).model },
    // The Whisper rows (model, downloaded, sources) are the Whisper build's, also while Parakeet is picked.
    whisperBuild: await whisperBuild(s),
    downloaded: whisperModels(await whisperBuild(s)), autoWhisper: autoWhisper(section('transcribe', s).language === 'auto' ? null : section('transcribe', s).language, whisperModels(await whisperBuild(s))),
    // Where each model comes from, as last checked (Setup asks Hugging Face; a page that must answer at once only reads
    // what's kept, and a stale or missing one is asked again in the background for the next look).
    whisperSources: await modelSources(await whisperBuild(s) === 'mlx' ? 'mlx' : 'whisper'),
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

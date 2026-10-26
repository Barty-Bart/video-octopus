import { TERMS } from './terms.js';
// Settings (#/settings/<group>[/<section>]), the Video Octopus assistant (a side panel on Setup, a drawer elsewhere)
// and the routing for the app-level pages. Design V2 §8: six groups in the shell, each a page of plain rows (label and
// one line on the left, the control on the right); API keys show as "•••• set ✓ · Replace · Test · Remove" and never
// come back to the page.
import { $, esc, h, api, toast, tilde, ENGINES } from './ui.js';
import { setupPage, studioCreator } from './setup.js';
import { renderDashboard } from './dashboard.js';
import { renderDatabaseRecovery } from './learning.js';
import { SETTINGS_SECTION_GROUP } from './nav.js';
import { currentAppearance, saveAppearance } from './appearance.js';
import { OLD_LOOK_NAMES } from './theme-map.js';
import { sidebarMarkup, topBarMarkup, wireShell } from './shell.js';
import { icon } from './icons.js';
import { updatesSection, markUpdateBadge } from './updates.js';
import { support, browserName } from './recorder.js';
import { usageView } from './plan-usage.js';
import { trashSection } from './trash.js';
import { isAdvanced, setEditorMode } from './mode.js';

let CTX = null;          // { app, makeChat, loadStatus, status, railAgent, newVideo } from app.js
let askAvailable = false; // the Ask Claude drawer and ⌘J: every page but a project's (it has its own chat) and Setup

// Called by app.js's router for every route; returns a page ({ teardown }) or null for the app's own pages.
export async function appPage(hash, ctx) {
  CTX = ctx;
  closeDrawer({ remember: false });
  // The project you're in: outside projects, the drawer's "This project" is this one.
  const pm = /^#\/p\/([^/?]+)/.exec(hash);
  if (pm) rememberProject(decodeURIComponent(pm[1]));
  askAvailable = !(hash.startsWith('#/p/') || hash === '#/setup' || hash === '#/setup/objsep');
  // The drawer opens again on a page where it was left open (each page remembers on its own).
  page = pageKey(hash);
  if (askAvailable && drawerWasOpen(page)) setTimeout(() => { if (page === pageKey(location.hash)) openDrawer(); }, 0);
  if (hash.startsWith('#/settings')) return settingsPage(hash);
  if (hash === '#/setup') return setupPage(ctx, { back: backTo, assistantPanel });
  // Set up from a scene built without its cutout (V1 §7, web/cutout.js SETUP_HREF): Setup at Object separation.
  if (hash === '#/setup/objsep') return setupPage(ctx, { back: backTo, assistantPanel, focus: 'objsep' });
  // Style pages (#/style…, #/styles…) stay behind this gate, like Home (Direction A decision 6).
  if (!hash.startsWith('#/p/') && !hash.startsWith('#/recordings') && !hash.startsWith('#/skills')) {
    // First time (or no studio folder yet): Setup opens by itself, until it's finished or skipped this session.
    const st = await api('/api/app/setup').catch(() => null);
    let skipped = false;
    try { skipped = sessionStorage.getItem('studio.setupSkipped') === '1'; } catch {}
    if (st?.needed && !skipped) { history.replaceState(null, '', '#/setup'); askAvailable = false; return setupPage(ctx, { back: '#/', assistantPanel }); }
  }
  backTo = hash || '#/';
  return null;
}
let backTo = '#/';       // where Setup's "Back" goes: the last page that wasn't Settings or Setup

// Ask Claude: the rail's button (any [data-open-assistant]) and ⌘J / Ctrl J open the Video Octopus assistant drawer
// from the right, for the whole studio or the last project's own chat (the drawer's switch). Inside a project its own
// chat takes over (its rail and ⌘J).
document.addEventListener('click', (e) => { if (e.target.closest?.('[data-open-assistant]')) { e.preventDefault(); openDrawer(); } });
document.addEventListener('keydown', (e) => {
  if (!askAvailable || !(e.metaKey || e.ctrlKey) || (e.key !== 'j' && e.key !== 'J')) return;
  if (!isAdvanced()) return; // Simple mode: no assistant drawer (V1 spec §5; the project's own chat is the one Claude)
  e.preventDefault();
  if (drawer) closeDrawer(); else openDrawer();
});

const ICON = {
  back: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M8.5 3L4.5 7l4 4"/></svg>',
  claude: '<svg class="ic-claude" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2"/></svg>',
  send: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 12V2M3 6l4-4 4 4"/></svg>',
  close: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8"/></svg>',
  check: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2l2.4 2.4 4.6-5"/></svg>',
};

// The six groups: [id, label, line in the list, its sections in page order].
const GROUPS = [
  ['general', 'General', 'Editor mode, theme, updates', ['editor', 'appearance', 'updates']],
  ['agent', 'Agent', 'Claude Code, Codex or pi', ['claude', 'planusage']],
  ['recording', 'Recording', 'Camera, mic, screen, transcription', ['recorder', 'transcribe']],
  ['editing', 'Editing & sound', 'Cuts, effects, video defaults', ['editing', 'sound', 'look']],
  ['export', 'Export', 'Rendering and output', ['render']],
  ['storage', 'Storage', 'Folders, backups, playback, trash, usage', ['folders', 'storage', 'playback', 'trash', 'usage']],
];
// Each section: its heading and one line about it.
const SECTIONS = {
  editor: ['Editor mode', ''],
  appearance: ['Appearance', 'How Video Octopus looks. Your videos keep their own look, under Editing & sound › Video defaults.'],
  updates: ['Updates', 'New versions of Video Octopus, your skills and preferences, and opening Video Octopus when you log in.'],
  claude: ['Agent & model', 'The agent behind every chat (Claude Code, Codex or pi), how much it may do without asking, and the model.'],
  planusage: ['Plan usage', 'What your Claude plan has used, as Claude Code last reported it.'],
  recorder: ['Recorder', 'Your camera, microphone and screen for Record, and where takes go.'],
  transcribe: ['Transcription', 'Where your speech becomes words: on this computer or with a cloud service.'],
  editing: ['Editing', 'How trimming feels in the Cut tab, and how your changes reach Claude.'],
  sound: ['Sound', 'Where sound effects come from, and how they sit under your voice.'],
  look: ['Video defaults', `Starting background and framing for your videos. Each brand kit provides colours and fonts; each style’s Skill provides approved guidance. Existing edits remain under your control.`],
  render: ['Rendering', 'How videos are rendered, and the defaults for new exports.'],
  folders: ['Folders', 'The studio is the home for your local database, projects and media. Skills are managed in the app; you do not need to arrange their folders.'],
  storage: ['Storage & backups', 'Back up and restore the local database, and look after the skill file store.'],
  playback: ['Playback', 'What the editor plays while you edit: your original files, or 720p copies for smooth scrubbing. Exports always use the originals, at full quality.'],
  trash: ['Trash', 'Deleted takes and media removed from videos wait here. Nothing is emptied automatically: put an item back, or empty the trash yourself.'],
  usage: ['Usage', 'What you’ve made with Video Octopus, counted from your own folders and a usage log that stays on this computer.'],
};
// More words the settings search finds a section by: its rows' labels and what people call them.
const FIND = {
  editor: 'editor mode simple advanced styles brand kits skills library schedules recordings everything',
  appearance: 'theme dark light mode match system colours colors accent orange blue green violet sidebar icons names rail look looks',
  updates: 'version git github update restart starter files log in login startup autostart open when i log in skills preferences',
  claude: 'claude code codex pi permissions ask before changes file edits auto full access model opus sonnet haiku fable effort reasoning thinking api key ollama lm studio provider clean chats',
  planusage: 'usage limits 5 hours 7 days plan',
  recorder: 'camera microphone mic screen countdown take where takes are saved recordings folder',
  transcribe: 'whisper mlx faster-whisper model language words spell deepgram assemblyai openai elevenlabs cloud',
  editing: 'trim cut highlight fine-trim pop-up lens save changes',
  sound: 'effects sfx epidemic library folder voice mix db',
  look: 'background night desk stars led picture-in-picture pip frame formats brand',
  render: 'parallel jobs size 1080p 4k codec h.264 hevc prores object separation sam cut out rotoscope mask model',
  folders: 'studio folder projects folder library folder new studio skills learning database',
  storage: 'backup restore database sqlite skill files disk',
  playback: 'playback copy copies proxy proxies 720p optimise optimize editing keep originals scrub smooth disk space free delete copies',
  trash: 'trash bin deleted takes removed media put back restore empty trash free space disk delete permanently',
  usage: 'dashboard statistics stats made videos hours',
};
const groupOf = (section) => GROUPS.find((g) => g[3].includes(section));

// ---------- the Settings page ----------
let settingsQuery = ''; // the search, kept while moving between groups
async function settingsPage(hash) {
  const [, , groupId, sectionId] = hash.split('?')[0].split('/');
  const G = GROUPS.find((g) => g[0] === groupId) || (SETTINGS_SECTION_GROUP[groupId] && groupOf(groupId)) || GROUPS[0];
  const [id, label, , sections] = G;
  document.body.classList.add('in-home', 'in-app-page');
  document.title = `${label} · Settings · Video Octopus`;
  const [V0, counts, takes] = await Promise.all([
    api('/api/app/settings'),
    api('/api/app/counts').catch(() => ({})),
    api('/api/takes').catch(() => []),
    CTX.status?.() ? null : CTX.loadStatus?.().catch(() => null),
  ]);
  let V = V0;
  const findText = (g) => [g[1], g[2], ...g[3].flatMap((k) => [...(SECTIONS[k] || []), FIND[k] || ''])].join(' ').toLowerCase();
  const el = h(`<div class="home shell settings-shell">
    ${topBarMarkup('Settings')}
    ${sidebarMarkup({ active: { page: 'settings' }, counts, takes, agent: CTX.railAgent?.(), forceIcons: true })}
    <div class="home-main set-sheet">
      <nav class="set-nav" aria-label="Settings groups">
        <h1>Settings</h1>
        <label class="search set-search">${icon('search', 14)}<span class="vh">Search settings</span><input id="setQ" type="search" placeholder="Search settings" autocomplete="off"></label>
        ${GROUPS.map((g) => `<a class="set-i${g[0] === id ? ' on' : ''}" href="#/settings/${g[0]}" data-find="${esc(findText(g))}"${g[0] === id ? ' aria-current="page"' : ''}><span>${esc(g[1])}</span><small>${esc(g[2])}</small></a>`).join('')}
        <p class="set-none sub" hidden>Nothing matches. Try another word.</p>
      </nav>
      <div class="set-main"><div class="set-wrap" id="setBody"></div></div>
    </div>
  </div>`);
  CTX.app.replaceChildren(el);
  const shell = wireShell(el, { onNewVideo: () => CTX.newVideo?.() });
  markUpdateBadge(el);

  const body = $('#setBody', el);
  const save = async (section, values, quiet) => {
    try {
      V = await api('/api/app/settings', { section, values });
      if (!quiet) flash(body);
      return true;
    } catch (e) { toast(e.message); return false; }
  };

  // Search: the groups whose rows mention it stay in the list (Enter opens the first); on this page, the rows that
  // don't are hidden, and a section with none left too.
  const q = $('#setQ', el);
  const filter = () => {
    const t = q.value.trim().toLowerCase();
    settingsQuery = q.value;
    let shown = 0;
    for (const a of el.querySelectorAll('.set-i')) {
      a.hidden = Boolean(t) && !a.dataset.find.includes(t);
      if (!a.hidden) shown++;
    }
    $('.set-none', el).hidden = shown > 0;
    for (const sec of body.querySelectorAll('.set-sec')) {
      const head = sec.querySelector(':scope > .set-sec-h')?.textContent.toLowerCase() || '';
      const headHit = !t || head.includes(t) || (FIND[sec.dataset.section] || '').includes(t);
      let rowsShown = 0;
      for (const r of sec.querySelectorAll('.set-row')) {
        r.hidden = Boolean(t) && !headHit && !r.textContent.toLowerCase().includes(t);
        if (!r.hidden) rowsShown++;
      }
      sec.hidden = Boolean(t) && !headHit && rowsShown === 0;
    }
  };
  q.value = settingsQuery;
  q.oninput = filter;
  q.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const a = [...el.querySelectorAll('.set-i')].find((x) => !x.hidden);
    if (a) location.hash = a.getAttribute('href');
  };

  let parts = [];
  const draw = () => {
    for (const p of parts) p?.teardown?.();
    const wrap = h(`<div class="set-page"><div class="set-head"><h2>${esc(label)}</h2><span class="set-saved" id="saved" aria-live="polite"></span></div></div>`);
    // General's rarely used options: the optional starter files and Setup again, in Advanced at the bottom.
    const advanced = id === 'general'
      ? h(`<details class="set-adv"><summary>Advanced</summary><div class="set-adv-body"></div></details>`) : null;
    parts = [];
    for (const k of sections) {
      const node = DRAW[k](V, save, draw, { advanced: advanced && $('.set-adv-body', advanced) });
      if (!node) continue;
      parts.push(node);
      const [title, about] = SECTIONS[k];
      const sec = h(`<section class="set-sec" id="set-${k}" data-section="${k}" aria-labelledby="set-${k}-h"><h3 class="set-sec-h" id="set-${k}-h">${esc(title)}</h3>${about ? `<p class="set-about sub">${esc(about)}</p>` : ''}</section>`);
      sec.append(node);
      // A group titled like its section ("Recorder" in Recorder) needs no second heading.
      for (const h4 of sec.querySelectorAll('.set-group > h4')) if (h4.textContent.trim() === title) h4.remove();
      wrap.append(sec);
    }
    if (advanced) {
      $('.set-adv-body', advanced).append(group('Setup', row('Run setup again', 'The first-time steps: your studio folder, the agent, transcription and the optional extras.', h('<a class="btn small" href="#/setup">Run setup again</a>'))));
      wrap.append(advanced);
    }
    body.replaceChildren(wrap);
    if (settingsQuery) filter();
  };
  draw();
  // An address with a section (#/settings/storage/usage, or an old #/settings/usage) opens scrolled to it, and stays
  // there while the sections above finish loading (Updates, Storage and Usage load their own data), until the
  // creator scrolls or clicks.
  let stopJump = () => {};
  if (sectionId) {
    let stopped = false;
    const jump = () => { if (!stopped) document.getElementById(`set-${sectionId}`)?.scrollIntoView({ block: 'start' }); };
    const ro = new ResizeObserver(jump);
    const main = $('.set-main', el);
    stopJump = () => {
      stopped = true;
      ro.disconnect();
      for (const t of ['wheel', 'pointerdown', 'keydown', 'touchstart']) main.removeEventListener(t, stopJump);
    };
    for (const t of ['wheel', 'pointerdown', 'keydown', 'touchstart']) main.addEventListener(t, stopJump, { passive: true });
    ro.observe(body);
    // Timers too: a page in a background tab gets no resize notifications until it is shown.
    for (const ms of [0, 400, 1200]) setTimeout(jump, ms);
    setTimeout(stopJump, 4000);
  }
  return {
    teardown: () => {
      stopJump();
      for (const p of parts) p?.teardown?.();
      shell.teardown();
      document.body.classList.remove('in-home', 'in-app-page');
    },
  };
}

function flash(body) {
  const s = $('#saved', body);
  if (!s) return;
  s.textContent = 'Saved'; s.classList.add('on');
  clearTimeout(s._t); s._t = setTimeout(() => s.classList.remove('on'), 1600);
}

// One setting: label and hint on the left, the control on the right.
const row = (label, hint, control, cls = '') => {
  const r = h(`<div class="set-row ${cls}"><div class="set-l"><b>${label}</b>${hint ? `<span class="sub">${hint}</span>` : ''}</div><div class="set-c"></div></div>`);
  $('.set-c', r).append(...[].concat(control));
  return r;
};
const group = (title, ...rows) => { const g = h(`<div class="set-group">${title ? `<h4>${title}</h4>` : ''}</div>`); g.append(...rows.filter(Boolean)); return g; };
const frag = (...nodes) => { const f = document.createDocumentFragment(); f.append(...nodes.filter(Boolean)); return f; };

function seg(options, value, onPick, { disabled = {} } = {}) {
  const s = h(`<div class="seg" role="radiogroup"></div>`);
  for (const [k, label] of options) {
    const b = h(`<button type="button" role="radio" aria-checked="${k === value}" class="${k === value ? 'on' : ''}"${disabled[k] ? ' disabled' : ''}>${label}</button>`);
    b.onclick = () => { if (k !== value) onPick(k); };
    s.append(b);
  }
  return s;
}
function select(options, value, onPick) {
  const s = h(`<select class="field sel">${options.map(([k, label]) => `<option value="${esc(k)}"${String(k) === String(value) ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`);
  s.onchange = () => onPick(s.value);
  return s;
}
// The browser's cameras or mics in a Settings select (after Default and None). Their names only show once the
// browser lets Video Octopus use them; a device picked earlier that isn't listed stays chosen.
async function fillDevices(sel, kind, value) {
  let list = [];
  try { list = (await navigator.mediaDevices.enumerateDevices()).filter((x) => x.kind === kind && x.deviceId && !['default', 'communications'].includes(x.deviceId)); } catch {}
  const opts = list.map((x, i) => [x.deviceId, x.label || `${kind === 'videoinput' ? 'Camera' : 'Microphone'} ${i + 1}`]);
  if (!['default', 'none'].includes(value) && !opts.some(([k]) => k === value)) opts.push([value, 'The one picked last time']);
  for (const [k, label] of opts) sel.append(new Option(label, k, false, k === value));
  sel.value = value;
}
function toggle(on, onFlip, label = '') {
  const t = h(`<label class="toggle"><input type="checkbox"${on ? ' checked' : ''}><span class="sw"></span>${label ? `<span>${label}</span>` : ''}</label>`);
  $('input', t).onchange = (e) => onFlip(e.target.checked);
  return t;
}
function text(value, onSave, { placeholder = '', mono = false, wide = false } = {}) {
  const i = h(`<input class="field${mono ? ' mono' : ''}${wide ? ' wide' : ''}" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off">`);
  let was = i.value;
  const commit = () => { if (i.value !== was) { was = i.value; onSave(i.value); } };
  i.onchange = commit;
  i.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } };
  return i;
}

// An API key: "•••• set ✓ · Replace · Test · Remove", or a password field when there's none. The value goes
// straight to the system's key store (V.keyStore: the Keychain on a Mac); nothing here ever reads it back.
function keyField(V, name, { placeholder, site, onChange } = {}) {
  const box = h(`<div class="key-field" data-key="${esc(name)}"></div>`);
  const info = V.keyInfo[name] || {};
  const store = V.keyStore || 'the Keychain';
  let replacing = false;
  const msg = (t, ok) => { const m = $('.key-msg', box); if (m) { m.textContent = t; m.className = `key-msg ${ok === true ? 'ok' : ok === false ? 'bad' : ''}`; } };
  const draw = () => {
    const set = V.keys[name];
    if (set && !replacing) {
      box.replaceChildren(h(`<div class="key-set"><span class="key-dots" aria-hidden="true">••••</span><span class="key-ok">set ✓</span>
        <button type="button" class="btn small ghost" data-a="replace">Replace</button>
        ${info.test ? '<button type="button" class="btn small ghost" data-a="test">Test</button>' : ''}
        <button type="button" class="btn small ghost danger" data-a="remove">Remove</button></div>`), h(`<div class="key-msg" aria-live="polite"></div>`));
      $('[data-a=replace]', box).onclick = () => { replacing = true; draw(); $('input', box)?.focus(); };
      $('[data-a=remove]', box).onclick = async () => {
        if (!confirm(`Remove the ${info.label || name} from ${store}?`)) return;
        try { const r = await api('/api/app/keys', { name, remove: true }); V.keys[name] = r.set; draw(); onChange?.(); toast(`${info.label || name} removed from ${store}.`); } catch (e) { msg(e.message, false); }
      };
      const t = $('[data-a=test]', box);
      if (t) t.onclick = async () => {
        t.disabled = true; msg('Testing…');
        try { const r = await api('/api/app/keys/test', { name }); msg(r.text, r.ok); } catch (e) { msg(e.message, false); }
        t.disabled = false;
      };
    } else {
      box.replaceChildren(h(`<form class="key-new" autocomplete="off">
        <input class="field mono" type="password" name="k" placeholder="${esc(placeholder || 'Paste the key')}" spellcheck="false" autocomplete="new-password" aria-label="${esc(info.label || name)}">
        <button class="btn small dark" type="submit">Save key</button>
        ${replacing ? '<button class="btn small ghost" type="button" data-a="cancel">Cancel</button>' : ''}</form>`),
        h(`<div class="key-msg sub">Kept by ${esc(store)}, never in your studio or a project.${site ? ` <a href="${esc(site)}" target="_blank" rel="noopener">Get a key</a>` : ''}</div>`));
      const f = $('form', box);
      f.onsubmit = async (e) => {
        e.preventDefault();
        const input = f.elements.k;
        const value = input.value.trim();
        input.value = '';
        if (!value) return;
        try { const r = await api('/api/app/keys', { name, value }); V.keys[name] = r.set; replacing = false; draw(); onChange?.(); toast(`${info.label || name} saved. New chats get it.`); }
        catch (err) { msg(err.message, false); }
      };
      const c = $('[data-a=cancel]', box);
      if (c) c.onclick = () => { replacing = false; draw(); };
    }
  };
  draw();
  return box;
}

// Settings → Agent & model → Model, for Claude Code on the Claude plan.
// The studio-wide effort default each video's chat starts from (the chat panel's picker can change it per video).
const EFFORT_WORDS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', minimal: 'Minimal', off: 'Off', ultra: 'Ultra' };
const effortPick = (V, key, own, v, save) => select([['', own], ...((V.efforts || {})[key] || []).map((e) => [e, EFFORT_WORDS[e] || e])], v || '', (x) => save('claude', { [`${key}${key === 'pi' ? 'Thinking' : 'Effort'}`]: x }));
const MODEL_PICKS = [['', "Claude Code's default"], ['opus', 'Opus'], ['opus[1m]', 'Opus · 1M context (uses usage credits)'], ['sonnet', 'Sonnet'], ['sonnet[1m]', 'Sonnet · 1M context (uses usage credits)'], ['claude-fable-5-1', 'Fable'], ['haiku', 'Haiku']];
const MODES = [['manual', 'Ask before changes'], ['acceptEdits', 'File edits OK'], ['auto', 'Auto (safe steps)'], ['bypassPermissions', 'Full access']];

// Settings → Agent & model → Claude Code → Model source (server/claude-source.mjs). The plan is today's Claude Code; the
// others start it against another server that speaks Anthropic's Messages API, with the model picked here.
const CC_SOURCES = [['plan', 'Claude plan'], ['ollama', 'Ollama'], ['lmstudio', 'LM Studio'], ['provider', 'Other provider']];
const CC_HINT = {
  plan: 'Claude Code as it is: your Claude plan (or a Claude API key, below). The others run Claude Code on another model: a local one in Ollama or LM Studio, or one at another provider.',
  ollama: 'A local model in Ollama on this computer (Ollama 0.14 or newer speaks Anthropic\'s API). Nothing leaves your computer.',
  lmstudio: 'A local model in LM Studio on this computer (0.4.1 or newer speaks Anthropic\'s API; start its server). Nothing leaves your computer.',
  provider: 'Any server that speaks Anthropic\'s Messages API: OpenRouter (https://openrouter.ai/api), a LiteLLM gateway, your own. Only the provider\'s own key is sent there.',
};
const CC_DEFAULT_URL = { ollama: 'http://127.0.0.1:11434', lmstudio: 'http://127.0.0.1:1234' };
function ccSourceGroup(V, v, save, redraw) {
  const src = v.ccSource || 'plan';
  const pick = seg(CC_SOURCES, src, (x) => save('claude', { ccSource: x, ccUrl: '', ccModel: '', ccContext: 0 }).then(redraw));
  pick.classList.add('cc-src');
  const rows = [row('Model source', CC_HINT[src], pick)];
  if (src === 'plan') return group('Model', ...rows);
  const local = src !== 'provider';
  // What the server says (read-only lists: its version and models), and the models to pick from.
  const status = h(`<div class="found"><span class="sub">Asking ${esc(src === 'provider' ? 'the provider' : CC_SOURCES.find((x) => x[0] === src)[1])}…</span></div>`);
  const modelBox = h(`<div class="cc-model"></div>`);
  const drawModels = (models = []) => {
    const cur = v.ccModel || '';
    const field = text(cur, (m) => save('claude', { ccModel: m.trim() }), { placeholder: local ? 'qwen3-coder:30b' : 'provider/model-id', mono: true, wide: true });
    if (!models.length) return modelBox.replaceChildren(field);
    const opts = [['', 'Pick a model'], ...models.map((m) => [m.id, m.label || m.id]), ...(cur && !models.some((m) => m.id === cur) ? [[cur, `${cur} (typed)`]] : [])];
    const sel = select(opts, cur, async (id) => {
      const m = models.find((x) => x.id === id);
      // A model LM Studio has loaded tells its context: Claude Code compacts in time with it.
      await save('claude', { ccModel: id, ...(m?.loaded && m.context ? { ccContext: m.context } : {}) });
      redraw();
    });
    modelBox.replaceChildren(sel);
  };
  const check = async (refresh) => {
    status.innerHTML = '<span class="sub">Checking…</span>';
    try {
      const E = await api(`/api/app/engines?source${refresh ? '&refresh' : ''}`);
      const c = E.ccCheck || {};
      const name = src === 'provider' ? 'The provider' : E.ccSource.label;
      status.innerHTML = `<span class="dot ${c.ok ? 'ok' : 'bad'}"></span><b>${esc(c.ok ? (c.version ? `${name} ${c.version}` : name) + (c.messagesApi ? ' · speaks Anthropic\'s API ✓' : ' · answers ✓') : c.unset ? `${name}: not set up yet` : c.running ? `${name}: can't be used yet` : `${name} isn't answering`)}</b><span class="sub">${esc(c.note || '')}</span><button type="button" class="btn small ghost" data-a="recheck">Check again</button>`;
      $('[data-a=recheck]', status).onclick = () => check(true);
      drawModels(c.models || []);
    } catch (e) { status.innerHTML = `<span class="dot bad"></span><b>Couldn't check</b><span class="sub">${esc(e.message)}</span>`; drawModels([]); }
  };
  drawModels([]);
  check(false);
  rows.push(row('Server', 'What Video Octopus found. It only asks for the server\'s version and list of models, never a chat.', status),
    row(local ? 'Server URL' : 'Provider URL', local ? `Where ${src === 'ollama' ? 'Ollama' : 'LM Studio'} listens. Leave it empty for ${CC_DEFAULT_URL[src]}.` : 'The base URL, without /v1 (Claude Code adds /v1/messages).',
      text(v.ccUrl || '', (u) => save('claude', { ccUrl: u.trim() }).then(redraw), { placeholder: local ? CC_DEFAULT_URL[src] : 'https://openrouter.ai/api', mono: true, wide: true })),
    row('Model', local ? 'Claude Code uses this one model for everything (its Opus, Sonnet and Haiku slots).' : 'The model id the provider expects. Claude Code uses it for everything.', modelBox));
  if (!local) rows.push(row('Provider key', 'Kept by the system key store and given only to Claude Code, as this provider\'s token. Leave it empty if the server needs none.', keyField(V, 'ANTHROPIC_COMPATIBLE_API_KEY', { placeholder: 'sk-or-…', onChange: () => check(true) })));
  rows.push(row('Context window', `How many tokens the model takes, so Claude Code compacts in time.${local ? ' 32768 when empty; load the model with at least that much.' : ' Empty: Claude Code decides.'}`,
    text(v.ccContext ? String(v.ccContext) : '', (n) => save('claude', { ccContext: Math.max(0, Math.round(Number(n) || 0)) }), { placeholder: local ? '32768' : 'Claude Code decides', mono: true })));
  rows.push(h(`<div class="notice small cc-caveats"><b>Good to know.</b> Claude Code needs a model with a big context (32K tokens or more) that's good at using tools. Small local models struggle with Video Octopus's long jobs, like Clean up or editing a scene: they lose track or stop halfway. Pick the biggest model this computer runs well. Claude Code is made for Claude models, so some things (web search, reading images) may not work with others; check Claude Code's terms before you rely on it. Your plan's usage meter is hidden while another model source is on, and chats start fresh when you switch.</div>`));
  return group('Model', ...rows);
}

const DRAW = {
  claude(V, save, redraw) {
    const c = V.claude, v = V.values.claude;
    const found = !c.installed ? `<span class="dot bad"></span><b>Not installed</b><span class="sub">Install it in Terminal: <code>${esc(c.install)}</code>, then run <code>claude</code> once to sign in.</span>`
      : `<span class="dot ${c.signedIn ? 'ok' : 'bad'}"></span><b>Claude Code ${esc(c.version)}</b><span class="sub">${c.signedIn ? `Signed in ✓${c.plan ? ` · ${esc(c.plan)}` : ''}` : 'Not signed in: run claude in Terminal and sign in.'} · ${esc(tilde(c.bin))}</span>`;
    const card = h(`<div class="found">${found}<button type="button" class="btn small ghost" id="recheck">Check again</button></div>`);
    $('#recheck', card).onclick = async () => { await CTX.loadStatus(true); V.claude = (await api('/api/app/settings')).claude; redraw(); };
    const model = text(v.model, (m) => save('claude', { model: m.trim() }), { placeholder: "Claude Code's default", mono: true });
    model.setAttribute('list', 'modelList');
    const list = h(`<datalist id="modelList">${['opus', 'sonnet', 'haiku', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((m) => `<option value="${m}">`).join('')}</datalist>`);
    // The model: Claude Code's default, the usual ones, the 1M-context ones (on a Claude plan Claude Code says they
    // "draw from usage credits", billed on top of the plan), or any other name typed in.
    let otherModel = !MODEL_PICKS.some(([k]) => k === (v.model || ''));
    const modelPick = select([...MODEL_PICKS, ['other', 'Other…']], otherModel ? 'other' : (v.model || ''), (m) => {
      otherModel = m === 'other';
      model.hidden = !otherModel;
      if (otherModel) model.focus(); else save('claude', { model: m });
    });
    model.hidden = !otherModel;
    const apiOn = v.useApiKey;
    // The agent: Claude Code (your Claude plan) or Codex (your ChatGPT plan, or a local model in LM Studio or Ollama).
    // Switching starts fresh chats; earlier conversations stay in each chat's session list.
    const codex = v.engine === 'codex';
    // Simple mode offers Claude Code and Codex; pi stays in Advanced (shown while it's the agent, to switch away).
    const engine = seg(Object.entries(ENGINES).filter(([k]) => isAdvanced() || k !== 'pi' || v.engine === 'pi'), v.engine || 'claude', (e) => save('claude', { engine: e }).then(redraw));
    const cxCard = h(`<div class="found"><span class="sub">Looking for Codex…</span></div>`);
    if (codex) api('/api/app/engines').then((E) => {
      const x = E.codex;
      cxCard.innerHTML = !x.installed ? `<span class="dot bad"></span><b>Codex isn't installed</b><span class="sub">Install it in a terminal: <code>${esc(x.install)}</code>, then run <code>codex login</code> once.</span>`
        : `<span class="dot ${x.signedIn || v.codexProvider !== 'chatgpt' ? 'ok' : 'bad'}"></span><b>Codex ${esc(x.version)}</b><span class="sub">${x.signedIn ? `Signed in ✓${x.plan ? ` · ${esc(x.plan)}` : ''}` : 'Not signed in: run codex login in a terminal.'} · ${esc(tilde(x.bin))}</span>`;
    }).catch(() => { cxCard.innerHTML = '<span class="sub">Couldn\'t check Codex.</span>'; });
    const source = seg([['chatgpt', 'ChatGPT plan'], ['lmstudio', 'LM Studio (local)'], ['ollama', 'Ollama (local)']].filter(([k]) => isAdvanced() || k === 'chatgpt' || k === v.codexProvider), v.codexProvider || 'chatgpt', (x) => save('claude', { codexProvider: x }).then(redraw));
    const cxModel = text(v.codexModel || '', (m) => save('claude', { codexModel: m.trim() }), { placeholder: v.codexProvider === 'chatgpt' ? "Codex's default" : 'gpt-oss:20b', mono: true });
    const engineGroup = group('', row('Agent', codex
      ? 'Codex, signed in with your ChatGPT plan, or running a local model. Your studio\'s skills, notes and permission mode apply the same way. New chats start on it; earlier ones stay in each chat\'s list.'
      : v.engine === 'pi' ? 'pi, an open-source agent: any model it knows, or any OpenAI-compatible endpoint (OpenRouter, LM Studio, Ollama…). Experimental in Video Octopus.'
        : 'Claude Code with your Claude plan. Codex (a ChatGPT plan or a local model) and pi (any model or endpoint) are the other choices.', engine));
    if (v.engine === 'pi') {
      // pi: its own providers, or any OpenAI-compatible endpoint (Video Octopus registers it as the provider "studio").
      const piCard = h(`<div class="found"><span class="sub">Looking for pi…</span></div>`);
      const pick = h(`<div class="pi-models"><span class="sub">Loading pi's models…</span></div>`);
      api('/api/app/engines?models').then((E) => {
        const x = E.pi;
        piCard.innerHTML = !x.installed ? `<span class="dot bad"></span><b>pi isn't installed</b><span class="sub">Install it in a terminal: <code>${esc(x.install)}</code>, then set up a provider in pi (or use an endpoint below).</span>`
          : `<span class="dot ok"></span><b>pi ${esc(x.version)}</b><span class="sub">${esc(tilde(x.bin))} · Video Octopus brings its own small extension for approvals; nothing to install.</span>`;
        const list = (E.piModels || []);
        const opts = [['', list.length ? "pi's default" : 'No models found in pi'], ...list.map((m) => [`${m.provider}/${m.model}`, `${m.provider} · ${m.model} · ${m.context}${m.images ? ' · sees images' : ' · text only'}`])];
        pick.replaceChildren(select(opts, v.piModel || '', (x2) => save('claude', { piModel: x2 })));
      }).catch(() => { piCard.innerHTML = '<span class="sub">Couldn\'t check pi.</span>'; });
      const src = seg([['pi', "pi's own providers"], ['endpoint', 'Any OpenAI-compatible endpoint']], v.piSource || 'pi', (x) => save('claude', { piSource: x, piModel: '' }).then(redraw));
      const endpoint = v.piSource === 'endpoint';
      const vision = 'Video Octopus works best with a model that can see images: some steps look at frames and pictures. pi support is experimental, so a few things may not work with every model.';
      return frag(engineGroup,
        group('', row('pi', 'Video Octopus runs the pi installed on this computer, with the providers you set up in it. It never reads your keys.', piCard)),
        group('Model',
          row('Model source', endpoint ? 'Any server that speaks OpenAI\'s Chat Completions API: OpenRouter (https://openrouter.ai/api/v1), LM Studio (http://localhost:1234/v1), Ollama (http://localhost:11434/v1), vLLM, your own gateway.' : 'The providers and models you set up in pi (its API keys, local servers, logins).', src),
          ...(endpoint ? [
            row('Endpoint URL', 'The base URL, ending in /v1 for most servers.', text(v.piBaseUrl || '', (u) => save('claude', { piBaseUrl: u.trim() }), { placeholder: 'https://openrouter.ai/api/v1', mono: true })),
            row('Model', 'The model id the server expects, e.g. qwen/qwen3.6-35b-a3b on OpenRouter.', text(v.piModel || '', (m) => save('claude', { piModel: m.trim() }), { placeholder: 'provider/model-id', mono: true })),
            row('Endpoint key', 'Kept by the system key store and passed to pi only while it runs. Local servers usually need none.', keyField(V, 'OPENAI_COMPATIBLE_API_KEY', { placeholder: 'sk-or-…' })),
            row('Model sees images', vision, toggle(Boolean(v.piVision), (on) => save('claude', { piVision: on }))),
            row('Context window', 'How many tokens the model takes, for the context meter and compacting.', text(String(v.piContext || 128000), (n) => save('claude', { piContext: Number(n) || 128000 }), { mono: true })),
          ] : [row('Model', vision, pick)])),
        group('Defaults for every chat',
          row('Permission mode', 'How much the agent may do without asking. The Video Octopus assistant always asks.', select(MODES, v.permissionMode, (m) => save('claude', { permissionMode: m }))),
          row('Thinking', 'How hard pi thinks before it answers (pi --thinking). Each video’s chat can pick its own next to the permission mode.', effortPick(V, 'pi', "pi's default", v.piThinking, save))));
    }
    if (codex) {
      return frag(engineGroup,
        group('', row('Codex', 'Video Octopus runs the Codex installed on this computer, with its own sign-in. It never asks for, reads or stores that login.', cxCard)),
        group('Model',
          row('Model source', v.codexProvider === 'chatgpt' ? 'Your ChatGPT plan, the way Codex signed in.' : `A model on this computer, through ${v.codexProvider === 'lmstudio' ? 'LM Studio (start its server and load a model first)' : 'Ollama (start it and pull a model first)'}. Local models are slower and weaker at long jobs like Clean up; pick a large one.`, source),
          row('Model', 'Leave empty for the default, or type a model name. Each video’s chat can pick its own next to the permission mode.', cxModel)),
        group('Defaults for every chat',
          row('Permission mode', 'How much the agent may do without asking. The Video Octopus assistant always asks.', select(MODES, v.permissionMode, (m) => save('claude', { permissionMode: m }))),
          ...(v.codexProvider === 'chatgpt' || !v.codexProvider ? [row('Reasoning effort', 'How hard Codex reasons before it answers (its reasoning effort). Each video’s chat can pick its own.', effortPick(V, 'codex', "Codex's default", v.codexEffort, save))] : [])));
    }
    // Claude Code's model source (server/claude-source.mjs): the plan as it is, or a model in Ollama, LM Studio or at
    // another provider that speaks Anthropic's Messages API. The plan-only rows (model alias, API key) hide meanwhile.
    const src = v.ccSource || 'plan';
    if (src !== 'plan') {
      return frag(engineGroup,
        group('', row('Claude Code', 'Video Octopus uses the Claude Code installed on this computer. With another model source it needs no Claude sign-in, and your Claude login and Claude API key are never sent to that server.', card)),
        ccSourceGroup(V, v, save, redraw),
        group('Defaults for every chat',
          row('Permission mode', 'How much Claude may do without asking. The Video Octopus assistant always asks.', select(MODES, v.permissionMode, (m) => save('claude', { permissionMode: m })))));
    }
    return frag(
      engineGroup,
      group('', row('Claude Code', 'Video Octopus uses the Claude Code installed on this computer, with your own sign-in. It never asks for, reads or stores that login.', card)),
      ccSourceGroup(V, v, save, redraw),
      group('Defaults for every chat',
        row('Permission mode', 'How much Claude may do without asking. The Video Octopus assistant always asks.', select(MODES, v.permissionMode, (m) => save('claude', { permissionMode: m }))),
        row('Model', 'Which Claude model the chats use. The 1M-context ones hold five times more of a long edit, but on a Claude plan they draw from usage credits, billed on top of the plan. Each video’s chat can pick its own next to the permission mode.', [modelPick, model, list]),
        row('Effort', 'How hard Claude thinks before it answers (claude --effort). Higher is slower and uses more of the plan.', effortPick(V, 'claude', "Claude Code's default", v.claudeEffort, save)),
        (v.ccSource || 'plan') === 'plan'
          ? row('Clean chats', 'Only your studio\'s own skills and settings in Video Octopus\'s chats: no connected apps (claude.ai connectors and MCP servers), no plugins or their hooks, no Claude Code extras. Every chat starts about 30–40k tokens lighter. Turn off to use a connected app (Figma, Notion…) from a Video Octopus chat.', toggle(v.lean !== false, (on) => save('claude', { lean: on })))
          : row('Clean chats', 'Always on with another model source: Claude Code would otherwise send every connected app\'s tools to that model.', h('<span class="sub">On</span>'))),
      group('API key (optional)',
        row('Use an API key instead', 'Pay per use: Claude Code then bills this key at API prices instead of your plan, in every Video Octopus chat.', toggle(apiOn, (on) => save('claude', { useApiKey: on }).then(redraw))),
        apiOn ? row('Claude API key', V.keys.ANTHROPIC_API_KEY ? 'Video Octopus passes it to Claude Code as ANTHROPIC_API_KEY.' : 'Until a key is saved, Video Octopus keeps using your plan.', keyField(V, 'ANTHROPIC_API_KEY', { placeholder: 'sk-ant-…', site: 'https://platform.claude.com/settings/keys' })) : null,
        V.envApiKey ? h(`<div class="notice small">Video Octopus was started with ANTHROPIC_API_KEY already set in its environment, so Claude Code bills that key whatever this switch says.</div>`) : null),
    );
  },

  transcribe(V, save, redraw) {
    const t = V.values.transcribe, m = V.machine;
    const engine = seg([['local', 'On this computer'], ['cloud', 'Cloud']], t.engine, (e) => save('transcribe', { engine: e }).then(redraw));
    const parts = [group('', row('Engine', t.engine === 'local' ? 'Whisper (or Parakeet) runs on this computer. Nothing is uploaded.' : 'Your audio is uploaded to the provider when you transcribe.', engine))];
    if (t.engine === 'local') {
      const have = new Set(V.downloaded), S = V.whisperSources;
      const opts = [['auto', `Auto: the best one downloaded (${V.autoWhisper}); recommended here: ${m.whisper.model}`],
        ...V.models.map((k) => [k, `${k}${S[k]?.size ? ` · ${S[k].size}` : ''}${have.has(k) ? ' · downloaded ✓' : ''}${k === m.whisper.model ? ' · recommended' : ''}`])];
      const src = h(`<div class="sub"></div>`);
      const showSrc = (k) => src.replaceChildren(h(`<span>${srcLink(S[k === 'auto' ? V.autoWhisper : k])}</span>`));
      showSrc(t.model);
      const eng = (e) => (e === 'mlx' ? 'MLX Whisper' : e === 'parakeet' ? 'Parakeet' : 'faster-whisper');
      const P = V.parakeet || { ready: false, have: [] }, pkOn = P.ready || t.whisperEngine === 'parakeet';
      const pkWhy = !m.arm64 ? 'Parakeet needs an Apple Silicon Mac.' : P.ready ? `Parakeet (NVIDIA's model through parakeet-mlx) also runs on the GPU with the selected Python: fast, with word times; it takes no spelling hints and can leave out some ums.` : 'Parakeet becomes a choice when the Python selected in Setup → Python environments has parakeet-mlx.';
      const seat = [['auto', `Auto (${eng(m.whisper.engine)})`], ['mlx', 'MLX Whisper'], ['faster-whisper', 'faster-whisper'], ...(m.arm64 ? [['parakeet', 'Parakeet (on this Mac\'s GPU)']] : [])];
      const weak = V.whisperEngine !== 'parakeet' && /^(tiny|base|small)/.test(t.model) && V.autoWhisper && !/^(tiny|base|small)/.test(V.autoWhisper) && V.downloaded.includes(V.autoWhisper);
      parts.push(group('On this computer',
        row('Runs on', `${m.arm64 ? 'MLX Whisper uses this Mac\'s GPU (mlx-community\'s models); faster-whisper runs on the CPU.' : 'faster-whisper (MLX Whisper needs an Apple Silicon Mac).'} ${pkWhy} Now: ${eng(V.whisperEngine)}.`,
          seg(seat, t.whisperEngine, (x) => save('transcribe', { whisperEngine: x }).then(redraw), { disabled: { mlx: !m.arm64, parakeet: !pkOn } })),
        m.arm64 ? row('Parakeet models', P.have.length ? `Downloaded: v2 is English only, v3 also knows 24 other European languages. ${P.ready ? `With this language it uses ${P.pick || 'none of them (Whisper instead)'}.` : ''}` : 'None downloaded. The transcribe skill never downloads one without asking.', h(`<div class="sub mono">${P.have.length ? esc(P.have.join(' · ')) : '—'}</div>`)) : null,
        weak ? h(`<div class="notice small">${esc(t.model)} is the smallest kind of Whisper model. ${esc(V.autoWhisper)} is already downloaded here: pick it, or Auto, for a more accurate transcript.</div>`) : null,
        row('Model', `${V.whisperEngine === 'parakeet' ? 'Whisper\'s model, for a language Parakeet has no model for. ' : ''}${esc(m.chip)}${m.ramGB ? `, ${m.ramGB} GB` : ''}. Recommended for this computer: ${esc(m.whisper.model)} (${esc(m.whisper.speed)}); .en models are English-only and more accurate for English. Setup → Transcription model downloads the one you pick.`, select(opts, t.model, (x) => { showSrc(x); return save('transcribe', { model: x }); })),
        row('Source', '', src),
        row('Downloaded models', '', h(`<div class="sub mono">${V.downloaded.length ? esc(V.downloaded.join(' · ')) : 'None yet: Setup → Transcription model downloads the one you pick.'}</div>`))));
    } else {
      const P = V.providers[t.provider];
      const list = h(`<div class="prov-list" role="radiogroup" aria-label="Provider"></div>`);
      for (const [k, p] of Object.entries(V.providers)) {
        const b = h(`<button type="button" role="radio" aria-checked="${k === t.provider}" class="prov${k === t.provider ? ' on' : ''}"><b>${esc(p.label)}</b><small>${V.keys[p.key] ? 'key set ✓' : 'no key yet'}</small></button>`);
        b.onclick = () => { if (k !== t.provider) save('transcribe', { provider: k }).then(redraw); };
        list.append(b);
      }
      parts.push(group('Cloud',
        row('Provider', `Video Octopus passes STUDIO_TRANSCRIBE=${esc(t.provider)} and the key to Claude, which transcribes through the provider and writes the same word times.`, list),
        row(`${esc(P.label)} key`, `Reaches Claude and the skills as ${esc(P.key)}.${V.keyInfo[P.key]?.test ? '' : ' There is no Test for this one: its keys can be limited to some endpoints, so a check could say no to a good key.'}`, keyField(V, P.key, { placeholder: `Paste your ${P.label} key`, site: P.site, onChange: () => { const b = document.querySelector(`.prov[aria-checked=true] small`); if (b) b.textContent = V.keys[P.key] ? 'key set ✓' : 'no key yet'; } }))));
    }
    const vocab = h(`<textarea class="field area" rows="2" placeholder="Claude, ffmpeg, Figma" spellcheck="false">${esc(t.vocab.join(', '))}</textarea>`);
    vocab.onchange = () => save('transcribe', { vocab: vocab.value });
    parts.push(group('Words',
      row('Language', 'Detect works for most takes; pick one when you only ever speak that language.', select(Object.entries(V.langs), t.language, (x) => save('transcribe', { language: x }))),
      row('Always spell right', 'Names, brands and jargon, separated by commas. They go to the transcriber as a hint.', vocab)));
    return frag(...parts);
  },

  render(V, save, redraw) {
    const r = V.values.render, m = V.machine;
    const hw = `${esc(m.chip)}${m.cores ? ` · ${m.cores} cores${m.perf ? ` (${m.perf} performance, ${m.eff} efficiency)` : ''}` : ''}${m.gpuCores ? ` · ${m.gpuCores}-core GPU` : ''}${m.ramGB ? ` · ${m.ramGB} GB` : ''}`;
    const jobs = [[0, 'Auto (each skill decides)'], ...[1, 2, 4, 6, 8, 12, 16].filter((n) => !m.cores || n <= m.cores).map((n) => [n, `${n} at a time`])];
    return frag(
      group('', row('Where', 'Renders happen on this computer. Cloud rendering is coming later.', seg([['local', 'On this computer'], ['cloud', 'Cloud · Coming later']], 'local', () => {}, { disabled: { cloud: true } })),
        row('This computer', '', h(`<div class="found"><span class="dot ok"></span><b>${hw}</b></div>`)),
        row('Parallel jobs', 'How many frame renders or encodes may run at once.', select(jobs, r.jobs, (x) => save('render', { jobs: Number(x) })))),
      group('Output defaults',
        row('Size', 'For Claude\'s renders. The Export button renders 1080p for now.', seg([['1080p', '1080p'], ['4k', '4K']], r.size, (x) => save('render', { size: x }).then(redraw))),
        row('Codec', 'H.264 plays everywhere; HEVC is smaller; ProRes is for further editing.', seg([['h264', 'H.264'], ['hevc', 'HEVC'], ['prores', 'ProRes']], r.codec, (x) => save('render', { codec: x }).then(redraw)))),
      samGroup(V, save),
    );
  },

  recorder(V, save, redraw) {
    const r = V.values.recorder, sp = support();
    const ready = sp.ok ? `Records in ${browserName()} · nothing else to install` : `${browserName()} can't record everything here (missing: ${sp.missing.join(', ') || 'a video format'}). Use Chrome or Edge.`;
    const device = (kind, key, dflt, none) => {
      const s = select([['default', dflt], ['none', none]], r[key], (v) => save('recorder', { [key]: v }));
      fillDevices(s, kind, r[key]);
      return s;
    };
    const dir = text(tilde(r.recordingsDir), (x) => save('recorder', { recordingsDir: x }), { mono: true, wide: true });
    return frag(
      group('Recorder',
        row('Recorder', 'Video Octopus records your screen, camera and mic right here in the browser, and each take goes straight into the project you record it for.',
          h(`<div class="found"><span class="dot ${sp.ok ? 'ok' : 'warn'}"></span><b>${esc(ready)}</b></div>`))),
      group('Defaults for Record',
        row('Screen', 'The browser shows its own picker (a screen, a window or a tab) each time. No screen records the camera, or only the mic.',
          seg([['screen', 'Record a screen'], ['none', 'No screen']], r.screen, (x) => save('recorder', { screen: x }).then(redraw))),
        row('Camera', 'The names show once the browser lets Video Octopus use the camera (the Record panel asks once).', device('videoinput', 'camera', 'Default camera', 'No camera')),
        row('Microphone', 'Recorded as it is: no echo cancelling, noise suppression or auto gain; 48 kHz when the mic can.', device('audioinput', 'mic', 'Default microphone', 'No microphone')),
        row('Countdown', '', seg([[0, 'Off'], [3, '3 s'], [5, '5 s']], r.countdown, (x) => save('recorder', { countdown: x }).then(redraw))),
        row('A new take goes', '', seg([['replace', 'In place of the current take'], ['layer', 'Next to it, as a layer']], r.target, (x) => save('recorder', { target: x }).then(redraw)))),
      group('Takes', row('Where takes are saved', 'Video Octopus saves each take in its own folder here and lists your recordings from it. Leave it empty for the recordings folder in your studio.', dir)),
    );
  },

  editing(V, save) {
    const s = V.values.editing || {};
    const always = () => h('<span class="always">Always on</span>');
    // A small picture of each trim: plain (A), the trimmed part in red (B), the hidden parts faded (C).
    const pic = (row_, kind) => {
      const H = [30, 55, 40, 70, 45, 60, 35, 65, 50, 40];
      const c = (i) => (kind === 'b' && (i === 3 || i === 4) ? 'var(--bad)' : kind === 'c' && (i < 2 || i > 6) ? 'var(--line-2)' : 'var(--muted)');
      $('.set-l', row_).prepend(h(`<span class="trim-pic" aria-hidden="true">${H.map((v, i) => `<i style="height:${v}%;background:${c(i)}"></i>`).join('')}<b></b></span>`));
      row_.classList.add('has-pic');
      return row_;
    };
    return frag(
      group('Trimming at a cut',
        pic(row('Pull the line (A)', 'Grab a cut’s red line: the left half is the part before, the right half the part after. Pull ◀ or ▶ and it trims or brings back as you go; the picture and a blip of sound follow the edge.', always()), 'a'),
        pic(row('Highlight first (B)', 'What you’re trimming turns red and what you’re bringing back blue, word by word, and the gap only closes when you let go.', toggle(s.trimHighlight, (on) => save('editing', { trimHighlight: on }))), 'b'),
        pic(row('Fine-trim pop-up (C)', 'Click a cut without dragging for a close-up of just that cut: the part before on top, the part after below, what the cut hides shown faded. Arrow keys nudge a frame.', toggle(s.trimLens, (on) => save('editing', { trimLens: on }))), 'c')),
      group('Telling Claude',
        row('Save changes → Claude', 'Your changes to the cut, the scenes, the blocks and the look wait in the change package (what Claude changes itself applies at once, with Undo in the chat). Save changes sends them all: Video Octopus re-times the sheet, keyframes and notes to a new cut, and Claude confirms, re-aligns the rest (scene graphics, B-roll) and re-renders what changed.', always())),
    );
  },
  sound(V, save, redraw) {
    const s = V.values.sound;
    const lib = text(s.library, (x) => save('sound', { library: x.trim() }), { placeholder: 'e.g. library/sfx or ~/Music/SFX', mono: true, wide: true });
    const range = h(`<div class="range"><input type="range" min="-30" max="-6" step="1" value="${s.fxDb}" aria-label="Effects under the voice"><span class="mono">${Math.abs(s.fxDb)} dB under</span></div>`);
    const ri = $('input', range);
    ri.oninput = () => { $('span', range).textContent = `${Math.abs(ri.value)} dB under`; };
    ri.onchange = () => save('sound', { fxDb: Number(ri.value) });
    return frag(
      group('Sources',
        row('Made by Claude', 'Sounds Claude designs in code: swooshes, clicks, risers.', toggle(s.claude, (on) => save('sound', { claude: on }))),
        row('Epidemic Sound', 'Through Claude\'s Epidemic Sound connector, when you have one connected.', toggle(s.epidemic, (on) => save('sound', { epidemic: on }))),
        row('A free library folder', 'A folder of sound files you\'re allowed to use. Inside the studio or anywhere on this computer.', lib)),
      group('Mix', row('Voice vs effects', 'Your voice stays on top; effects sit this far under it (their loudest moment against your voice while you talk). The export, the canvas preview and Claude’s own renders all use this one level.', range)),
    );
  },

  folders(V, save, redraw) {
    const f = V.values.folders;
    const studio = h(`<input class="field mono wide" value="${esc(tilde(f.studio))}" spellcheck="false" autocomplete="off">`);
    const projects = h(`<input class="field mono" value="${esc(f.projectsDir)}" spellcheck="false" autocomplete="off">`);
    const library = h(`<input class="field mono" value="${esc(f.libraryDir)}" spellcheck="false" autocomplete="off">`);
    const apply = h(`<button type="button" class="btn dark">Save folders</button>`);
    apply.onclick = async () => {
      const vals = {};
      if (studio.value.trim() !== tilde(f.studio)) vals.studio = studio.value.trim();
      if (projects.value.trim() !== f.projectsDir) vals.projectsDir = projects.value.trim();
      if (library.value.trim() !== f.libraryDir) vals.libraryDir = library.value.trim();
      if (!Object.keys(vals).length) return toast('Nothing changed.');
      if ((vals.studio || vals.projectsDir) && !confirm('Video Octopus will look for projects in the new place. Nothing is moved. Go ahead?')) return;
      if (await save('folders', vals)) redraw();
    };
    // Create a new studio from the starter (a second one, or a fresh start): it becomes the studio once it's made.
    const open = h(`<button type="button" class="btn">Create a new studio…</button>`);
    const box = h(`<div class="set-create"></div>`);
    open.onclick = async () => {
      open.hidden = true;
      const suggest = await api(`/api/app/setup/studio-path?path=`).catch(() => null);
      box.append(studioCreator({ suggest, button: 'Create studio', onCreated: async () => { if (await save('folders', {}, true)) redraw(); } }).el);
      box.querySelector('input')?.focus();
    };
    return frag(
      group('',
        row('Your studio folder', 'Home for your projects, recordings, library and local SQLite database. New studios use application storage by default; you can choose another location.', studio),
        isAdvanced() ? row('Skills & learning', 'Saved in <b>.studio/studio.sqlite</b> inside this studio, including versions and approvals. Any skill folders are app-generated working copies for agents.', h('<a class="btn small" href="#/skills">Open Skills</a>')) : null,
        row('Projects folder', `Recordings and source media, editing work and renders. Inside the studio: ${esc(tilde(f.studio))}/<b>${esc(f.projectsDir)}</b>`, projects),
        row('Library folder', `Inside the studio: reusable backgrounds, sounds and cards. ${esc(tilde(f.studio))}/<b>${esc(f.libraryDir)}</b>`, library),
        row('', 'To move the files themselves, ask the Video Octopus assistant.', apply)),
      group('New studio',
        row('Start a new studio', 'From Video Octopus\'s starter, in a new folder. Video Octopus switches to it; your current studio stays as it is, and you can switch back above.', [open, box])),
    );
  },

  // Settings › General › Appearance (design V2 §1): Light, Dark or Match system, an accent and the sidebar's width. A
  // pick shows at once on every page (web/appearance.js) and is saved; there's no Save button. After the one-time
  // move from the old looks, a note says which theme the old look became, until OK.
  // Settings › General › Editor mode (V1 spec §1): Simple | Advanced. Switching changes only this setting: nothing is
  // deleted or moved, and the page (its sidebar too) draws again in the new mode.
  editor(V) {
    const mode = V.values.editor?.mode === 'advanced' ? 'advanced' : 'simple';
    const pick = async (next) => {
      try {
        V = await api('/api/app/settings', { section: 'editor', values: { mode: next } });
        setEditorMode(next);
        await CTX.loadStatus?.().catch(() => null);
        toast(next === 'advanced' ? 'Advanced mode: everything is back in the sidebar.' : 'Simple mode: Projects, Resources and Settings.');
        dispatchEvent(new HashChangeEvent('hashchange')); // the router draws Settings again, with the new sidebar
      } catch (e) { toast(e.message); }
    };
    return group('', row('Simple or Advanced', 'Simple shows Projects and Resources and makes every video in a few steps. Advanced brings back My styles, brand kits, skills, the library, schedules and recordings. Nothing is lost when you switch.',
      seg([['simple', 'Simple'], ['advanced', 'Advanced']], mode, pick)));
  },
  appearance(V, save, redraw) {
    const a = { ...currentAppearance(), ...(V.values.appearance || {}) };
    const pick = async (patch) => {
      if (!(await saveAppearance(patch))) return;
      V.values.appearance = { ...a, ...patch };
      redraw();
      flash(document.getElementById('setBody'));
    };
    const THEME_NAMES = { light: 'Light', dark: 'Dark', system: 'Match system' };
    const rows = [];
    if (a.migratedFrom) {
      const note = h(`<div class="set-note" role="status"><span>Looks are now Light, Dark or Match system. You were using ${esc(OLD_LOOK_NAMES[a.migratedFrom] || 'Edit Bay')}, so we picked ${esc(THEME_NAMES[a.theme])}.</span><button type="button" class="btn small">OK</button></div>`);
      $('button', note).onclick = async () => {
        if (await save('appearance', { migratedFrom: '' }, true)) { V.values.appearance = { ...a, migratedFrom: '' }; redraw(); }
      };
      rows.push(note);
    }
    rows.push(row('Theme', 'Match system follows your computer’s light or dark setting.',
      seg(Object.entries(THEME_NAMES), a.theme, (x) => pick({ theme: x }))));
    const ACCENTS = [['orange', 'Orange'], ['blue', 'Blue'], ['green', 'Green'], ['violet', 'Violet']];
    const swatches = h(`<div class="accent-pick" role="radiogroup" aria-label="Accent"></div>`);
    for (const [k, name] of ACCENTS) {
      const b = h(`<button type="button" role="radio" class="accent-sw" data-accent-swatch="${k}" aria-checked="${k === a.accent}" aria-label="${name}" title="${name}"></button>`);
      b.onclick = () => { if (k !== a.accent) pick({ accent: k }); };
      swatches.append(b);
    }
    rows.push(row('Accent', 'Marks the next step, recording and anything new.', swatches));
    rows.push(row('Sidebar', 'Icons only, or icons with names. The toggle at the foot of the sidebar switches it too.',
      seg([['icons', 'Icons'], ['labels', 'Icons and names']], a.sidebar, (x) => pick({ sidebar: x }))));
    return group('', ...rows);
  },

  // Settings › Agent › Plan usage: the 5-hour and 7-day meters the sidebar card used to show (Claude plan only).
  planusage() {
    const st = CTX.status?.();
    if (!st?.agent?.planUsage) return null;
    const v = usageView(st.usage, st.engine || 'claude');
    const meter = (value) => (value == null ? h('<span class="sub">Not reported yet</span>')
      : h(`<div class="usage-meter"><i><b style="width:${value}%"></b></i><span class="mono">${value}%</span></div>`));
    return group('',
      row('Last 5 hours', '', meter(v.fiveHour)),
      row('Last 7 days', esc(v.note), meter(v.sevenDay)));
  },

  look(V, save, redraw) {
    const l = V.values.look;
    const sw = h(`<div class="swatches" role="radiogroup" aria-label="Default background"></div>`);
    for (const [k, label] of [['night-desk', 'Night Desk'], ['stars', 'Stars'], ['led', 'LED wave']]) {
      const b = h(`<button type="button" role="radio" aria-checked="${k === l.background}" class="swatch${k === l.background ? ' on' : ''}"><span class="sw-pic ${k}" aria-hidden="true"></span><span>${label}</span></button>`);
      b.onclick = () => save('look', { background: k }).then(redraw);
      sw.append(b);
    }
    const colors = h(`<div class="colors"></div>`);
    const drawColors = () => {
      colors.replaceChildren(...l.colors.map((c, i) => {
        const w = h(`<span class="color"><input type="color" value="${esc(c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c.slice(0, 7))}" aria-label="Brand colour ${i + 1}"><button type="button" class="x" aria-label="Remove colour">${ICON.close}</button></span>`);
        $('input', w).onchange = (e) => { l.colors[i] = e.target.value; save('look', { colors: l.colors }); };
        $('.x', w).onclick = () => { l.colors.splice(i, 1); save('look', { colors: l.colors }); drawColors(); };
        return w;
      }));
      if (l.colors.length < 8) {
        const add = h(`<button type="button" class="btn small">+ Colour</button>`);
        add.onclick = () => { l.colors.push('#c2410c'); save('look', { colors: l.colors }); drawColors(); };
        colors.append(add);
      }
    };
    drawColors();
    return frag(
      group('Video defaults',
        // Simple mode has no styles or brand kits (its look is Resources): these two pointers are Advanced's.
        isAdvanced() ? row('Styles', 'For pacing, captions, storytelling and style-specific visual rules, use a style’s Skill. Review the scene plan before applying those rules to a video.', h('<a class="btn small" href="#/styles">Open My styles</a>')) : null,
        row('Background', 'Behind the picture in the picture-in-picture, Boxed and Split layouts.', sw),
        row('Picture-in-picture frame', '', seg([['rounded', 'Rounded'], ['circle', 'Circle'], ['frame', 'Whole frame']], l.pip, (x) => save('look', { pip: x }).then(redraw)))),
      isAdvanced() ? group('Style brand',
        row('Colours, fonts and brand assets', 'Set these in a brand kit. New video loads the approved brand of the style’s kit; these global video controls do not replace it.', h('<a class="btn small" href="#/styles/kits">Open brand kits</a>'))) : null,
    );
  },
};
// Settings → Updates lives in updates.js (it loads its own data from /api/app/updates).
DRAW.updates = (V, save, redraw, { advanced } = {}) => updatesSection(V, save, { row, group, toggle, advanced });

// Settings → Storage & backups and Usage (Direction A): the former Storage and Dashboard pages. Brand and
// Instructions moved to each channel's Brand tab and All channels › Instructions (web/channel.js).
DRAW.storage = () => {
  const box = h('<div class="set-embed"><p class="sub">Loading…</p></div>');
  renderDatabaseRecovery(box).catch((e) => { box.replaceChildren(h(`<p class="notice">${esc(e.message)}</p>`)); });
  return box;
};
// Settings › Storage › Playback (server/playback.mjs): Keep originals or Optimise for editing, the question after an
// export, and the space the 720p editing copies use, with Delete all copies (for good: they can be made again).
DRAW.playback = (V, save, redraw) => {
  const s = V.values.storage || {}, mode = s.playback || 'originals';
  const gb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(b ? 1 : 0, Math.round(b / 1e6))} MB`);
  const list = h('<div class="pb-copies"><p class="sub">Counting…</p></div>');
  const paint = (d) => {
    const rows = d.projects.map((p) => `<li><a href="#/p/${encodeURIComponent(p.id)}">${esc(p.name)}</a><span class="sub">${esc(gb(p.bytes))} · ${p.files} ${p.files === 1 ? 'copy' : 'copies'}${p.files > (p.editing?.files || 0) ? ' · needed to play' : ''}${p.own ? ` · ${p.own === 'optimise' ? 'Optimise for editing' : 'Keep originals'} for this video` : ''}</span></li>`).join('');
    list.replaceChildren(h(`<div><p><b>${esc(gb(d.bytes))}</b> in ${d.files} ${d.files === 1 ? 'copy' : 'copies'}${d.projects.length ? ` across ${d.projects.length} ${d.projects.length === 1 ? 'video' : 'videos'}` : ''}.</p>
      ${rows ? `<ul class="pb-list">${rows}</ul>` : '<p class="sub">No playback copies on this computer.</p>'}
      <button type="button" class="btn small danger" data-a="all"${d.files ? '' : ' disabled'}>Delete all copies</button>
      <p class="sub">Deleted for good, not moved to the Bin: they are only for editing and are made again when a video needs one. Your originals and exports stay.</p></div>`));
    const b = $('[data-a=all]', list);
    b.onclick = async () => {
      b.disabled = true;
      try { const r = await api('/api/app/playback-copies/delete', {}); toast(r.files === 0 ? 'There was nothing to delete.' : `Deleted ${r.files ?? 0} ${r.files === 1 ? 'copy' : 'copies'}.`); paint(r); }
      catch (e) { toast(e.message); b.disabled = false; }
    };
  };
  api('/api/app/playback-copies').then(paint).catch((e) => list.replaceChildren(h(`<p class="notice">${esc(e.message)}</p>`)));
  return frag(
    group('While you edit',
      row('Playback', mode === 'optimise'
        ? 'Optimise for editing: a 720p copy of every video, for smooth scrubbing on any computer. Until it is ready the editor plays the original, so nothing waits.'
        : 'Keep originals: the editor plays your own files, so no second copy takes up space. A file the browser can’t play gets a 720p copy, and the editor says why.',
      seg([['originals', 'Keep originals'], ['optimise', 'Optimise for editing']], mode, async (x) => { if (await save('storage', { playback: x })) { const st = CTX.status?.(); if (st) st.storage = { ...(st.storage || {}), playback: x }; redraw(); } })),
      row('After an export', 'Ask whether to delete a video’s 720p editing copies once it is exported. Each video can also choose in its Media section.',
        toggle(s.askDeleteCopies !== false, (on) => { save('storage', { askDeleteCopies: on }); const st = CTX.status?.(); if (st) st.storage = { ...(st.storage || {}), askDeleteCopies: on }; }, 'Offer to delete copies'))),
    group('Space used by playback copies', list));
};
// Settings › Storage › Trash (web/trash.js): what's in the studio's trash, Put back, and Empty trash.
DRAW.trash = (V, save) => trashSection({ row, group, pref: select([['ask', 'Ask each time'], ['video', 'Remove it from the video only'], ['bin', 'Delete it to the Bin']],
  V.values.storage?.deleteRecording || 'ask', (x) => { save('storage', { deleteRecording: x }); const st = CTX.status?.(); if (st) st.storage = { ...(st.storage || {}), deleteRecording: x }; }) });
DRAW.usage = () => {
  const box = h('<div class="set-embed"></div>');
  renderDashboard(box, { recordingsDir: tilde(CTX.status?.()?.recordingsDir || ''), embedded: true });
  return box;
};

// ---------- the Video Octopus assistant: an app-level chat (id "_studio"), same Claude Code login, own session ----------
// `id` another chat instead: the drawer's "This project" shows a project's own chat (the same conversation as inside
// the project). `scopeEl`: a node for the header in place of the scope chip (the drawer's switch).
export function assistantPanel({ hint = '', onResult, onBusy, closable = false, onClose, title = 'Video Octopus assistant', scope = '', scopeEl = null, id = '_studio', open = '' } = {}) {
  const studio = id === '_studio', base = `/api/projects/${encodeURIComponent(id)}`;
  const el = h(`<section class="col chat as-panel" aria-label="${esc(title)}">
    <div class="chat-head">${ICON.claude}<span class="title">${esc(title)}</span>${scope ? `<span class="as-scope">${esc(scope)}</span>` : ''}<span class="as-slot"></span><span id="sessionInfo"></span>
      ${studio ? '<span class="as-mode" title="Every change comes to you as an Allow / Deny card">Asks before each change</span>' : `<a class="as-mode as-go" href="${esc(open)}" title="Open the project">Open project →</a>`}
      ${closable ? `<button type="button" class="btn ghost small as-x" aria-label="Close the assistant">${ICON.close}</button>` : ''}</div>
    <div class="msgs" id="msgs"><div class="empty-chat" id="emptyChat">${esc(hint || 'I look after Video Octopus itself: setup, settings, folders, formats.')}<br><span class="sub">${studio ? 'Not tied to a project. Same Claude Code, its own chat.' : 'The project’s files, notes and WORKLOG are its memory.'}</span></div></div>
    <div class="working" id="working" hidden><span class="spin"></span><span id="workText">Working…</span></div>
    <div class="composer"><label class="vh" for="input">${studio ? 'Message the Video Octopus assistant' : 'Message this project’s chat'}</label><textarea id="input" rows="1" placeholder="${!studio ? 'Ask Claude about this project…' : title === 'Claude' ? 'Ask Claude about the studio…' : 'Ask the Video Octopus assistant…'}"></textarea>
      <button class="send" id="sendBtn" aria-label="Send"><span class="l-send">${ICON.send}</span><i class="stop-sq l-stop" aria-hidden="true"></i></button></div>
  </section>`);
  if (scopeEl) $('.as-slot', el).replaceWith(scopeEl); else $('.as-slot', el).remove();
  const chat = CTX.makeChat(el, id);
  const es = new EventSource(`${base}/events`);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.t === 'files' || ev.t === 'usage') return;
    chat.handle(ev);
    if (ev.t === 'busy') onBusy?.(ev.busy, ev.replay);
    if (ev.t === 'result' && !ev.replay) onResult?.(ev);
  };
  if (closable) $('.as-x', el).onclick = () => onClose?.();
  return {
    el,
    send: (text) => api(`${base}/chat`, { text }),
    focus: () => $('#input', el).focus(),
    destroy: () => { es.close(); chat.destroy?.(); },
  };
}

// The drawer (outside a project): the Video Octopus assistant for the whole studio, or, with the switch on "This project",
// that project's own chat, the same conversation as inside it. "This project" is the project you opened last (else the
// one edited last); with no project yet there's no switch. Inside a project its docked chat takes over.
let drawer = null, page = '#/';
const pageKey = (hash) => { const k = (hash || '#/').split('?')[0]; return k.startsWith('#/settings') ? '#/settings' : k === '' || k === '#' ? '#/' : k; };
const drawerWasOpen = (k) => { try { return localStorage.getItem(`studio.drawer.${k}`) === '1'; } catch { return false; } };
const rememberDrawer = (open) => { try { localStorage.setItem(`studio.drawer.${page}`, open ? '1' : '0'); } catch {} };
const drawerScope = () => { try { return localStorage.getItem('studio.drawer.scope') === 'project' ? 'project' : 'studio'; } catch { return 'studio'; } };
const lastProject = () => { try { return localStorage.getItem('studio.lastProject') || ''; } catch { return ''; } };
const rememberProject = (id) => { try { localStorage.setItem('studio.lastProject', id); } catch {} };
async function drawerProject() {
  const list = await api('/api/projects').catch(() => []);
  const ok = (Array.isArray(list) ? list : []).filter((p) => p.app);
  return ok.find((p) => p.id === lastProject()) || ok.sort((a, b) => b.updated - a.updated)[0] || null;
}
async function openDrawer() {
  if (drawer) return drawer.panel?.focus();
  rememberDrawer(true);
  const wrap = h(`<div class="as-drawer" role="dialog" aria-modal="false" aria-label="Ask Claude"></div>`);
  const onKey = (e) => { if (e.key === 'Escape' && !e.target.closest?.('.as-drawer textarea')) closeDrawer(); };
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  document.body.classList.add('as-open');
  const me = drawer = { wrap, panel: null, onKey, project: null };
  me.project = await drawerProject();
  if (drawer !== me) return; // closed or the page changed meanwhile
  mountDrawer(me.project && drawerScope() === 'project' ? 'project' : 'studio');
}
function mountDrawer(scope) {
  const d = drawer;
  if (!d) return;
  d.panel?.destroy();
  const p = scope === 'project' ? d.project : null;
  let sw = null;
  if (d.project) {
    sw = seg([['studio', 'Whole studio'], ['project', 'This project']], scope, (x) => { try { localStorage.setItem('studio.drawer.scope', x); } catch {} mountDrawer(x); });
    sw.classList.add('as-scope-seg');
    sw.setAttribute('aria-label', 'What Claude looks at');
    sw.querySelector('[role=radio]:last-child').title = `${d.project.name}: its own chat, the same one as inside the project`;
  }
  const close = () => closeDrawer();
  d.panel = p
    ? assistantPanel({ id: p.id, open: `#/p/${encodeURIComponent(p.id)}`, closable: true, onClose: close, title: `Claude · ${p.name}`, scopeEl: sw,
      hint: `This is ${p.name}’s own chat, the same one you see inside the project. Ask about its cut, scenes, renders or what’s next; changes ask first as they do there.` })
    : assistantPanel({ closable: true, onClose: close, title: 'Claude', scope: sw ? '' : 'Whole studio', scopeEl: sw, hint: 'I look after the whole studio: settings, projects, the library and its inbox, scheduled runs, formats, keys and setup. Try “turn on the trim lens”, “sweep my projects into the library every Sunday” or “what’s waiting in the library inbox?”' });
  d.wrap.setAttribute('aria-label', p ? `Claude · ${p.name}` : 'Video Octopus assistant');
  d.wrap.replaceChildren(d.panel.el);
  setTimeout(() => d.panel?.focus(), 30);
}
// Closed by the creator (✕ or Esc): this page remembers it. A page change closes it without that.
function closeDrawer({ remember = true } = {}) {
  if (!drawer) return;
  if (remember) rememberDrawer(false);
  drawer.panel?.destroy();
  drawer.wrap.remove();
  document.body.classList.remove('as-open');
  document.removeEventListener('keydown', drawer.onKey);
  drawer = null;
}

// Settings → Rendering → Object separation: the SAM 2.1 model the object-separation skill uses (Auto = the one
// recommended for this computer), with each model's download size, speed and whether it's downloaded. Setup's Object
// separation row downloads the picked one.
function samGroup(V, save) {
  const S = V.sam2, have = new Set(S.have), rec = S.recommended;
  const opts = [['auto', `Auto: ${rec.size}, recommended for ${rec.why}`],
    ...Object.entries(S.models).map(([k, m]) => [k, `${k}${S.sources[k]?.size ? ` · ${S.sources[k].size}` : ''} · ${m.speed}${have.has(k) ? ' · downloaded ✓' : ''}`])];
  const src = h(`<div class="sub"></div>`);
  const showSrc = (k) => src.replaceChildren(h(`<span>${srcLink(S.sources[k === 'auto' ? rec.size : k])}</span>`));
  showSrc(V.values.objsep.model);
  return group('Object separation',
    row('Model', `SAM 2.1 for the object-separation skill (cutting a person or an object out of the background, on this computer). ${rec.slow ? 'No GPU here: it runs on the CPU, which takes seconds a frame.' : ''}`.trim(), select(opts, V.values.objsep.model, (x) => { showSrc(x); return save('objsep', { model: x }); })),
    row('Source', '', src),
    row('Downloaded models', '', h(`<div class="sub mono">${S.have.length ? esc(S.have.join(' · ')) : 'None yet: Setup → Object separation downloads the picked one.'}</div>`)));
}

// A model's source line ("From Hugging Face · <repo> (<maker>) · <size> · licence: …", the server's words) with the repo
// as a link to its page.
const srcLink = (s) => (s?.repo ? esc(s.line || '').replace(esc(s.repo), `<a href="${esc(s.url)}" target="_blank" rel="noopener" class="mono">${esc(s.repo)}</a>`) : '');

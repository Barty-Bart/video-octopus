import { TERMS } from './terms.js';
// Settings (#/settings/<section>), the Video Octopus assistant (a side panel here and on Setup, a drawer on Home) and
// the routing for the app-level pages. Design brief 2, §5–6: one section per row in a left list; API keys show
// as "•••• set ✓ · Replace · Test · Remove" and never come back to the page.
import { $, esc, h, api, toast, tilde, ENGINES } from './ui.js';
import { setupPage, studioCreator } from './setup.js';
import { renderDashboard } from './dashboard.js';
import { renderDatabaseRecovery } from './learning.js';
import { channelHref } from './nav.js';
import { LOOKS, applyLook } from './appearance.js';
import { updatesSection, markUpdateBadge } from './updates.js';
import { support, browserName } from './recorder.js';

let CTX = null;          // { app, makeChat, loadStatus } from app.js
let backTo = '#/';       // where "Back" goes: the last page that wasn't Settings or Setup

// Called by app.js's router for every route; returns a page ({ teardown }) or null for the app's own pages.
export async function appPage(hash, ctx) {
  CTX = ctx;
  closeDrawer({ remember: false });
  // The project you're in: outside projects, the drawer's "This project" is this one.
  const pm = /^#\/p\/([^/?]+)/.exec(hash);
  if (pm) rememberProject(decodeURIComponent(pm[1]));
  const show = !(hash.startsWith('#/p/') || hash === '#/setup');
  askButton(show);
  // The drawer opens again on a page where it was left open (each page remembers on its own).
  page = pageKey(hash);
  if (show && drawerWasOpen(page)) setTimeout(() => { if (page === pageKey(location.hash)) openDrawer(); }, 0);
  if (hash.startsWith('#/settings')) return settingsPage(hash.split('/')[2] || 'claude');
  if (hash === '#/setup') return setupPage(ctx, { back: backTo, assistantPanel });
  // Channel pages (#/channel…, #/channels…) stay behind this gate, like Home (Direction A decision 6).
  if (!hash.startsWith('#/p/') && !hash.startsWith('#/recordings') && !hash.startsWith('#/skills')) {
    // First time (or no studio folder yet): Setup opens by itself, until it's finished or skipped this session.
    const st = await api('/api/app/setup').catch(() => null);
    let skipped = false;
    try { skipped = sessionStorage.getItem('studio.setupSkipped') === '1'; } catch {}
    if (st?.needed && !skipped) { history.replaceState(null, '', '#/setup'); askButton(false); return setupPage(ctx, { back: '#/', assistantPanel }); }
  }
  backTo = hash || '#/';
  return null;
}

// The sidebar entry Home adds under Skills. (The Video Octopus assistant is the Ask Claude button now, bottom right.)
// counts.update: new commits for Video Octopus on GitHub (the quiet check), shown as "New" and opening Settings → Updates.
export const homeNav = (counts = {}) => counts.update
  ? `<a class="nav-i" href="#/settings/updates">${ICON.gear}<span>Settings</span><span class="n wait" title="A new version of Video Octopus is ready (Settings → Updates)">New</span></a>`
  : `<a class="nav-i" href="#/settings">${ICON.gear}<span>Settings</span></a>`;

// One Claude button, bottom right on Home, Recordings, Library, Skills and Settings: the Video Octopus assistant, for the
// whole studio, or the last project's own chat (the drawer's switch). Inside a project its own chat takes over (its rail
// and ⌘J).
let askEl = null;
function askButton(show) {
  if (!askEl) {
    askEl = h(`<button type="button" class="ask-claude" data-open-assistant aria-label="Ask Claude about the whole studio">${ICON.claude}<span>Ask Claude</span><span class="ac-scope">· Video Octopus</span></button>`);
    document.body.append(askEl);
  }
  askEl.hidden = !show;
  askScope(lastProject() ? { name: 'this project' } : null);
}
document.addEventListener('click', (e) => { if (e.target.closest?.('[data-open-assistant]')) { e.preventDefault(); openDrawer(); } });

const ICON = {
  gear: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3"/></svg>',
  assistant: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/><path d="M5.5 7h.01M8 7h.01M10.5 7h.01" stroke-width="1.8" stroke-linecap="round"/></svg>',
  back: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M8.5 3L4.5 7l4 4"/></svg>',
  claude: '<svg class="ic-claude" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2"/></svg>',
  send: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 12V2M3 6l4-4 4 4"/></svg>',
  close: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8"/></svg>',
  check: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2l2.4 2.4 4.6-5"/></svg>',
};

// [id, label, line in the list, what the page is about, icon]
const SECTIONS = [
  ['claude', 'Agent & model', 'Claude Code, Codex or pi; permissions'],
  ['transcribe', 'Transcription', 'On this computer or a cloud service'],
  ['render', 'Rendering', 'This computer, output defaults'],
  ['recorder', 'Recording', 'Camera, mic, screen, takes'],
  ['editing', 'Editing', 'Trimming at a cut, telling Claude'],
  ['sound', 'Sound', 'Sources, voice vs effects'],
  ['appearance', 'Appearance', 'How Video Octopus looks'],
  ['look', 'Video defaults', 'Starting background and framing'],
  ['folders', 'Folders', 'Studio, media and local database'],
  ['storage', 'Storage & backups', 'Database backups and skill files'],
  ['usage', 'Usage', 'What you’ve made, from a local log'],
  ['updates', 'Updates', 'New versions, starter files, log-in'],
];
const ABOUT = {
  claude: 'The agent behind every chat (Claude Code, Codex or pi), how much it may do without asking, and the model.',
  transcribe: 'Where your speech becomes words: on this computer or with a cloud service.',
  render: 'How videos are rendered, and the defaults for new exports.',
  recorder: 'Your camera, microphone and screen for Record, and where takes go.',
  editing: 'How trimming feels in the Cut tab, and how your changes reach Claude.',
  sound: 'Where sound effects come from, and how they sit under your voice.',
  folders: 'The studio is the home for your local database, projects and media. Skills are managed in the app; you do not need to arrange their folders.',
  appearance: 'How Video Octopus looks. Your videos keep their own look, under Look.',
  look: 'Starting background and framing for your videos. Each channel’s Brand tab provides colours and fonts; its formats provide approved format guidance. Existing edits remain under your control.',
  storage: 'Back up and restore the local database, and look after the skill file store.',
  usage: 'What you’ve made with Video Octopus, counted from your own folders and a usage log that stays on this computer.',
  updates: 'New versions of Video Octopus, the starter files in your studio, and opening Video Octopus when you log in.',
};
// More words the settings search finds a section by.
const FIND = { appearance: `theme dark light mode colours colors style ${LOOKS.map((l) => l[1]).join(' ')}`, render: 'object separation sam cut out rotoscope mask model' };
const SEC_ICON = {
  claude: '<path d="M8 1.8v12.4M1.8 8h12.4M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8"/>',
  transcribe: '<path d="M2.5 4h11M2.5 7h11M2.5 10h7M2.5 13h5"/>',
  render: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6.5 6.2v3.6L9.6 8z"/>',
  recorder: '<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="2.2"/>',
  editing: '<circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="11.5" r="2"/><path d="M5.8 10l6-7.5M10.2 10l-6-7.5"/>',
  sound: '<path d="M2.5 6v4h2.5L8.5 13V3L5 6z"/><path d="M11 5.5a3.5 3.5 0 010 5M12.8 3.8a6 6 0 010 8.4"/>',
  folders: '<path d="M2 4.5h4.2l1.4 1.5H14v6.5a1 1 0 01-1 1H3a1 1 0 01-1-1z"/>',
  appearance: '<circle cx="8" cy="8" r="5.8"/><path d="M8 2.2v11.6A5.8 5.8 0 018 2.2z" fill="currentColor" stroke="none"/>',
  look: '<rect x="2.2" y="3" width="11.6" height="10" rx="1.5"/><path d="M2.6 11.4l3.4-3.4 2.6 2.6 1.8-1.8 3.2 3.2"/><circle cx="10.6" cy="6.1" r="1"/>',
  storage: '<ellipse cx="8" cy="4" rx="5.5" ry="2"/><path d="M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/>',
  usage: '<path d="M2.5 13.5h11"/><rect x="3" y="8" width="2.4" height="4" rx=".6"/><rect x="6.8" y="4.5" width="2.4" height="7.5" rx=".6"/><rect x="10.6" y="6.5" width="2.4" height="5.5" rx=".6"/>',
  updates: '<path d="M13 8a5 5 0 01-8.6 3.5M3 8a5 5 0 018.6-3.5"/><path d="M11.8 2.2v2.6H9.2M4.2 13.8v-2.6h2.6"/>',
};
const secIcon = (k) => `<span class="sec-ic" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16">${SEC_ICON[k] || ''}</svg></span>`;

// ---------- the Settings page ----------
async function settingsPage(sec) {
  if (!SECTIONS.some((s) => s[0] === sec)) sec = 'claude';
  document.body.classList.add('in-home', 'in-app-page');
  document.title = `Settings · Video Octopus`;
  let V = await api('/api/app/settings');
  const el = h(`<div class="app-page">
    <nav class="side-nav set-nav" aria-label="Settings sections">
      <a class="brand" href="#/"><span class="logo" aria-hidden="true"><i></i></span>Video Octopus</a>
      <a class="nav-i back" href="${esc(backTo)}">${ICON.back}<span>Back</span></a>
      <label class="search set-search"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="6" cy="6" r="4.2"/><path d="M9.2 9.2l3 3"/></svg><span class="vh">Search settings</span><input id="setQ" type="search" placeholder="Search settings" autocomplete="off"></label>
      <div class="set-h">Settings</div>
      ${SECTIONS.map(([k, label, sub]) => `<a class="nav-i set-i${k === sec ? ' on' : ''}" href="#/settings/${k}" data-find="${esc(`${label} ${sub} ${ABOUT[k] || ''} ${FIND[k] || ''}`.toLowerCase())}"${k === sec ? ' aria-current="page"' : ''}>${secIcon(k)}<span class="set-t"><span>${label}</span><small>${sub}</small></span></a>`).join('')}
      <span class="gap"></span>
      <a class="btn small wide" href="#/setup">Run setup again</a>
    </nav>
    <div class="set-main"><div class="set-wrap" id="setBody"></div></div>
  </div>`);
  CTX.app.replaceChildren(el);
  markUpdateBadge(el);
  // Search: narrow the list to the sections that mention it; Enter opens the first.
  const q = $('#setQ', el);
  q.oninput = () => { const t = q.value.trim().toLowerCase(); el.querySelectorAll('.set-i').forEach((a) => { a.hidden = Boolean(t) && !a.dataset.find.includes(t); }); };
  q.onkeydown = (e) => { if (e.key === 'Enter') { const a = [...el.querySelectorAll('.set-i')].find((x) => !x.hidden); if (a) location.hash = a.getAttribute('href'); } };

  const body = $('#setBody', el);
  const save = async (section, values, quiet) => {
    try {
      V = await api('/api/app/settings', { section, values });
      if (!quiet) flash(body);
      return true;
    } catch (e) { toast(e.message); return false; }
  };
  let sectionNode;
  const draw = () => {
    sectionNode?.teardown?.();
    sectionNode=DRAW[sec](V, save, draw);
    const [, label] = SECTIONS.find((s) => s[0] === sec);
    body.replaceChildren(h(`<div class="set-head">${secIcon(sec).replace('sec-ic', 'sec-ic big')}<div class="sh-t"><h1>${label}</h1><span class="sub">${esc(ABOUT[sec] || '')}</span></div><span class="set-saved" id="saved" aria-live="polite"></span></div>`), sectionNode);
  };
  draw();
  return { teardown: () => {sectionNode?.teardown?.();document.body.classList.remove('in-home', 'in-app-page');} };
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
const group = (title, ...rows) => { const g = h(`<section class="set-group">${title ? `<h2>${title}</h2>` : ''}</section>`); g.append(...rows.filter(Boolean)); return g; };
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
    const engine = seg(Object.entries(ENGINES), v.engine || 'claude', (e) => save('claude', { engine: e }).then(redraw));
    const cxCard = h(`<div class="found"><span class="sub">Looking for Codex…</span></div>`);
    if (codex) api('/api/app/engines').then((E) => {
      const x = E.codex;
      cxCard.innerHTML = !x.installed ? `<span class="dot bad"></span><b>Codex isn't installed</b><span class="sub">Install it in a terminal: <code>${esc(x.install)}</code>, then run <code>codex login</code> once.</span>`
        : `<span class="dot ${x.signedIn || v.codexProvider !== 'chatgpt' ? 'ok' : 'bad'}"></span><b>Codex ${esc(x.version)}</b><span class="sub">${x.signedIn ? `Signed in ✓${x.plan ? ` · ${esc(x.plan)}` : ''}` : 'Not signed in: run codex login in a terminal.'} · ${esc(tilde(x.bin))}</span>`;
    }).catch(() => { cxCard.innerHTML = '<span class="sub">Couldn\'t check Codex.</span>'; });
    const source = seg([['chatgpt', 'ChatGPT plan'], ['lmstudio', 'LM Studio (local)'], ['ollama', 'Ollama (local)']], v.codexProvider || 'chatgpt', (x) => save('claude', { codexProvider: x }).then(redraw));
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
          row('Permission mode', 'How much the agent may do without asking. The Video Octopus assistant always asks.', select(MODES, v.permissionMode, (m) => save('claude', { permissionMode: m })))));
    }
    if (codex) {
      return frag(engineGroup,
        group('', row('Codex', 'Video Octopus runs the Codex installed on this computer, with its own sign-in. It never asks for, reads or stores that login.', cxCard)),
        group('Model',
          row('Model source', v.codexProvider === 'chatgpt' ? 'Your ChatGPT plan, the way Codex signed in.' : `A model on this computer, through ${v.codexProvider === 'lmstudio' ? 'LM Studio (start its server and load a model first)' : 'Ollama (start it and pull a model first)'}. Local models are slower and weaker at long jobs like Clean up; pick a large one.`, source),
          row('Model', 'Leave empty for the default, or type a model name.', cxModel)),
        group('Defaults for every chat',
          row('Permission mode', 'How much the agent may do without asking. The Video Octopus assistant always asks.', select(MODES, v.permissionMode, (m) => save('claude', { permissionMode: m })))));
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
        row('Model', 'Which Claude model the chats use. The 1M-context ones hold five times more of a long edit, but on a Claude plan they draw from usage credits, billed on top of the plan.', [modelPick, model, list]),
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
    const parts = [group('', row('Engine', t.engine === 'local' ? 'faster-whisper runs on this computer. Nothing is uploaded.' : 'Your audio is uploaded to the provider when you transcribe.', engine))];
    if (t.engine === 'local') {
      const have = new Set(V.downloaded), S = V.whisperSources;
      const opts = [['auto', `Auto: the best one downloaded (${V.autoWhisper}); recommended here: ${m.whisper.model}`],
        ...V.models.map((k) => [k, `${k}${S[k]?.size ? ` · ${S[k].size}` : ''}${have.has(k) ? ' · downloaded ✓' : ''}${k === m.whisper.model ? ' · recommended' : ''}`])];
      const src = h(`<div class="sub"></div>`);
      const showSrc = (k) => src.replaceChildren(h(`<span>${srcLink(S[k === 'auto' ? V.autoWhisper : k])}</span>`));
      showSrc(t.model);
      const eng = (e) => (e === 'mlx' ? 'MLX Whisper' : 'faster-whisper');
      parts.push(group('On this computer',
        row('Runs on', `${m.arm64 ? 'MLX Whisper uses this Mac\'s GPU (mlx-community\'s models); faster-whisper runs on the CPU.' : 'faster-whisper (MLX Whisper needs an Apple Silicon Mac).'} Now: ${eng(V.whisperEngine)}.`,
          seg([['auto', `Auto (${eng(m.whisper.engine)})`], ['mlx', 'MLX Whisper'], ['faster-whisper', 'faster-whisper']], t.whisperEngine, (x) => save('transcribe', { whisperEngine: x }).then(redraw), { disabled: { mlx: !m.arm64 } })),
        row('Model', `${esc(m.chip)}${m.ramGB ? `, ${m.ramGB} GB` : ''}. Recommended for this computer: ${esc(m.whisper.model)} (${esc(m.whisper.speed)}); .en models are English-only and more accurate for English. Setup → Transcription model downloads the one you pick.`, select(opts, t.model, (x) => { showSrc(x); return save('transcribe', { model: x }); })),
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
        row('Save changes → Claude', 'Changes to the cut, the scenes, the blocks and the look wait in the change package. Save changes sends them all: Video Octopus re-times the sheet, keyframes and notes to a new cut, and Claude confirms, re-aligns the rest (scene graphics, B-roll) and re-renders what changed.', always())),
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
        row('Skills & learning', 'Saved in <b>.studio/studio.sqlite</b> inside this studio, including versions and approvals. Any skill folders are app-generated working copies for agents.', h('<a class="btn small" href="#/skills">Open Skills</a>')),
        row('Projects folder', `Recordings and source media, editing work and renders. Inside the studio: ${esc(tilde(f.studio))}/<b>${esc(f.projectsDir)}</b>`, projects),
        row('Library folder', `Inside the studio: reusable backgrounds, sounds and cards. ${esc(tilde(f.studio))}/<b>${esc(f.libraryDir)}</b>`, library),
        row('', 'To move the files themselves, ask the Video Octopus assistant.', apply)),
      group('New studio',
        row('Start a new studio', 'From Video Octopus\'s starter, in a new folder. Video Octopus switches to it; your current studio stays as it is, and you can switch back above.', [open, box])),
    );
  },

  // Settings → Appearance: ten looks for Video Octopus itself. A pick shows at once on every page
  // (web/appearance.js) and is saved; there's no Save button. Paper Desk's card has its calmer option.
  appearance(V, save, redraw) {
    const a = { look: 'editbay', calm: false, ...(V.values.appearance || {}) };
    const pick = async (patch) => {
      const prev = { ...a }, next = { ...a, ...patch };
      applyLook(next);
      if (await save('appearance', next)) redraw(); else applyLook(prev);
    };
    const grid = h(`<div class="lk-grid" role="radiogroup" aria-label="Video Octopus look"></div>`);
    for (const [id, name, tag, one] of LOOKS) {
      const on = id === a.look;
      const card = h(`<div class="lk-card${on ? ' on' : ''}">
        <button type="button" class="lk-pick" role="radio" aria-checked="${on}">
          <span class="lk-th"><img src="/looks/${id}.jpg" alt="" loading="lazy" draggable="false">${on ? `<i class="lk-ck" aria-hidden="true">${ICON.check}</i>` : ''}</span>
          <span class="lk-top"><b>${esc(name)}</b>${id === 'editbay' ? '<em class="lk-def">Default</em>' : ''}<span class="lk-tag${tag === 'Dark' ? ' dark' : ''}">${tag}</span></span>
          <span class="lk-one">${esc(one)}</span></button></div>`);
      $('.lk-pick', card).onclick = () => { if (!on) pick({ look: id }); };
      // Paper Desk, chosen: "Bold outlines" (off = the calmer version: thinner lines, fewer hard shadows).
      if (id === 'paper' && on) { const c = h(`<div class="lk-calm"></div>`); c.append(toggle(!a.calm, (bold) => pick({ calm: !bold }), 'Bold outlines')); card.append(c); }
      grid.append(card);
    }
    const [, name, tag, one] = LOOKS.find((l) => l[0] === a.look) || LOOKS[0];
    const now = h(`<div class="lk-now"><div><b>${esc(name)}</b> <span class="sub">· ${tag.toLowerCase()} · ${esc(one.charAt(0).toLowerCase() + one.slice(1))}</span></div><span class="gap"></span>
      ${a.look !== 'editbay' ? '<button type="button" class="btn small">Back to Edit Bay</button>' : ''}</div>`);
    const back = $('button', now);
    if (back) back.onclick = () => pick({ look: 'editbay', calm: false });
    const g = group('', h(`<div class="lk-h"><b>Video Octopus look</b><span class="sub">Pick one: it changes every page at once. The layout stays the same.</span></div>`), grid, now);
    g.classList.add('lk-group');
    return frag(g, h(`<p class="lk-note">Changes how Video Octopus looks. Your videos keep their own look (<a href="#/settings/look">Settings → Look</a>).</p>`));
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
        row('Formats', 'For pacing, captions, storytelling and format-specific visual rules, use a channel’s formats. Review the scene plan before applying those rules to a video.', h(`<a class="btn small" href="${channelHref('_', 'formats')}">Open formats</a>`)),
        row('Background', 'Behind the picture in the picture-in-picture, Boxed and Split layouts.', sw),
        row('Picture-in-picture frame', '', seg([['rounded', 'Rounded'], ['circle', 'Circle'], ['frame', 'Whole frame']], l.pip, (x) => save('look', { pip: x }).then(redraw)))),
      group('Channel brand',
        row('Colours, fonts and brand assets', 'Set these in each channel’s Brand tab. New video loads the channel’s approved brand; these global video controls do not replace it.', h(`<a class="btn small" href="${channelHref('_', 'brand')}">Open the Brand tab</a>`))),
    );
  },
};
// Settings → Updates lives in updates.js (it loads its own data from /api/app/updates).
DRAW.updates = (V, save) => updatesSection(V, save, { row, group, toggle });
FIND.updates = 'version git github update restart starter log in login startup autostart open when i log in';

// Settings → Storage & backups and Usage (Direction A): the former Storage and Dashboard pages. Brand and
// Instructions moved to each channel's Brand tab and All channels › Instructions (web/channel.js).
DRAW.storage = () => {
  const box = h('<div class="set-embed"><p class="sub">Loading…</p></div>');
  renderDatabaseRecovery(box).catch((e) => { box.replaceChildren(h(`<p class="notice">${esc(e.message)}</p>`)); });
  return box;
};
DRAW.usage = () => {
  const box = h('<div class="set-embed"></div>');
  renderDashboard(box, { recordingsDir: tilde(CTX.status?.()?.recordingsDir || ''), embedded: true });
  return box;
};
FIND.storage = 'backup restore database sqlite skill files disk';
FIND.usage = 'dashboard statistics stats made videos hours';

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
function askScope(project) {
  const on = project && drawerScope() === 'project';
  if (!askEl) return;
  $('.ac-scope', askEl).textContent = on ? '· This project' : '· Video Octopus';
  askEl.setAttribute('aria-label', on ? `Ask Claude about ${project.name}` : 'Ask Claude about the whole studio');
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
  askScope(d.project);
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

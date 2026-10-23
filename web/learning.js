import { TERMS } from './terms.js';
import { $, esc, h, api, toast, confirmBox } from './ui.js';
import { addSkillsDialog } from './brand.js';
import { projectProfilePanel } from './profiles.js';
import { loadScript, scriptCard } from './prompter.js';
const E='/api/learning';
const videoSetups=[
 {id:'tutorial',name:'Long-form · on camera',example:'Long-form explainers with me on camera',hint:'A landscape tutorial with a presenter or screen recording. Starts with the tutorial workflow.'},
 {id:'faceless',name:'Long-form · voiceover',example:'Narrated documentary explainers',hint:'A landscape video led by narration and supporting visuals, without a talking-head workflow.'},
 {id:'short',name:'Short / Reel',example:'YouTube Shorts',hint:'A vertical short video. Starts with the short-form workflow.'},
 {id:'explainer',name:'Product explainer',example:'Product demonstrations',hint:'A landscape explainer built around a product or idea. Starts with the explainer workflow.'},
];

const kindLabel=k=>({'core':'Core','customized-core':'Customized core','personal':'Personal','format':'Format skill'}[k]||k);
const button=(label,action,kind='')=>`<button class="btn ${kind}" data-action="${action}">${label}</button>`;
const field=(label,name,value='',kind='input',placeholder='')=>`<label>${label}${kind==='textarea'?`<textarea name="${name}" rows="4">${esc(value)}</textarea>`:`<input name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${name==='summary'?'maxlength="320"':''} required>`}</label>`;
const options=(list,value)=>list.map(x=>`<option value="${esc(x.id)}"${x.id===value?' selected':''}>${esc(x.name)}</option>`).join('');
function dialog(title,markup,save,label='Save') {
 const modal=$('#modal'),el=h(`<form class="dialog learn-dialog" role="dialog" aria-modal="true"><h2>${esc(title)}</h2>${markup}<p class="learn-error" role="alert"></p><div class="learn-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${esc(label)}</button></div></form>`);
 modal.replaceChildren(el);modal.hidden=false;el.querySelector('input,textarea,select,button')?.focus();el.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();modal.hidden=true;}};$('[data-close]',el).onclick=()=>modal.hidden=true;
 el.onsubmit=async e=>{e.preventDefault();const b=$('[type=submit]',el);b.disabled=true;try{await save(Object.fromEntries(new FormData(el)));modal.hidden=true;}catch(err){$('.learn-error',el).textContent=err.message;}finally{b.disabled=false;}};
 return el;
}

// ---- Video formats: channels › formats › format home, plus the "Talk to this format" conversation panel. ----
// UI words: a learning profile is a channel, a learning session is a conversation, an approved version is the skill.

const SELECTION_KEY = 'octopus.videoFormats.selection';
const AREAS = [
  { id: 'scripting', name: 'Script' },
  { id: 'pacing', name: 'Pacing' },
  { id: 'visuals', name: 'Visuals' },
  { id: 'captions', name: 'Captions' },
  { id: 'sound', name: 'Sound' },
  { id: 'knowledge', name: 'Knowledge' },
];
const TABS = ['skill', 'files', 'examples', 'learnings', 'videos', 'history'];
// Skill files: same limits as server/file-store.mjs (shown to the creator, enforced by the server).
const MAX_FILES = 300;
const MAX_FILE_BYTES = 1024 ** 3;
const KNOWLEDGE_TYPES = /\.(md|txt|csv|tsv|json|pdf|png|jpe?g|webp|gif|svg)$/i;
const fileSize = (n) => {
  if (n === null || n === undefined) return '';
  if (n >= 1024 ** 3) return `${Math.round((n / 1024 ** 3) * 10) / 10} GB`;
  if (n >= 1024 ** 2) return `${Math.round((n / 1024 ** 2) * 10) / 10} MB`;
  return n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`;
};
const areaName = (id) => AREAS.find((a) => a.id === id)?.name || id;
const conversationStatus = (status) => ({
  draft: 'Open',
  running: 'Working',
  review: 'Draft ready',
  interrupted: 'Paused',
  failed: 'Stopped',
  approved: 'Saved',
  cancelled: 'Closed',
}[status] || status);
const studyLabel = (status) => ({
  running: 'Studying…',
  review: 'Study again',
  interrupted: 'Resume study',
  failed: 'Try again',
}[status] || TERMS.studyAdded);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const setupName = (f) => videoSetups.find((s) => s.id === f.type)?.name || f.type;
const targetText = (seconds) => {
  if (!seconds) return '';
  return seconds < 60 || seconds % 60 ? `${seconds} s target` : `${seconds / 60} min target`;
};
function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}
const linkLines = (text) => String(text || '').split(/\n/).map((x) => x.trim()).filter(Boolean);
const isLinkList = (text) => {
  const lines = linkLines(text);
  return lines.length > 0 && lines.every((x) => /^https?:\/\/\S+$/i.test(x));
};
// Drafts that are simply not there yet are normal; anything else is a problem the creator should see.
const quietDraftError = (message) => /^No proposal yet|has no rule changes/.test(message || '');
const PENCIL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>';

// A POST that keeps the HTTP status, so 409 ("rebase needed") can be told apart from other refusals.
async function post(path, data) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio': '1' },
    body: JSON.stringify(data),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(json.error || `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return json;
}

// A small options menu beside its button. Fixed to the viewport, so scrolling panes never clip it.
let openMenu = null;
function closeMenu() {
  if (!openMenu) return;
  openMenu.menu.remove();
  openMenu.anchor.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', openMenu.outside, true);
  document.removeEventListener('keydown', openMenu.key, true);
  openMenu = null;
}
function showMenu(anchor, items) {
  const again = openMenu?.anchor === anchor;
  closeMenu();
  if (again) return;
  const menu = h('<div class="vf-menu" role="menu"></div>');
  for (const item of items) {
    if (item === '-') {
      menu.append(h('<div class="vf-menu-sep" role="separator"></div>'));
      continue;
    }
    const el = item.href
      ? h(`<a class="vf-mi" role="menuitem" href="${esc(item.href)}">${esc(item.label)}</a>`)
      : h(`<button type="button" class="vf-mi${item.danger ? ' danger' : ''}" role="menuitem">${esc(item.label)}</button>`);
    el.onclick = async () => {
      closeMenu();
      if (!item.run) return;
      try { await item.run(); } catch (e) { toast(e.message); }
    };
    menu.append(el);
  }
  document.body.append(menu);
  const box = anchor.getBoundingClientRect();
  const width = menu.offsetWidth, height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(box.left, innerWidth - width - 8))}px`;
  menu.style.top = `${box.bottom + height + 8 > innerHeight ? Math.max(8, box.top - height - 4) : box.bottom + 4}px`;
  const outside = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeMenu(); anchor.focus(); } };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  anchor.setAttribute('aria-expanded', 'true');
  openMenu = { menu, anchor, outside, key };
  menu.querySelector('.vf-mi')?.focus();
}

export async function renderLearning(root, { makeChat, startVideo } = {}) {
  const params = new URLSearchParams(location.hash.split('?')[1]);
  let remembered = {};
  try { remembered = JSON.parse(localStorage.getItem(SELECTION_KEY) || '{}') || {}; } catch {}
  let live = true;
  let data = null;
  let view = {};
  let pid = params.get('profile') || remembered.profileId || null;
  let fid = params.has('profile') ? params.get('format') : params.get('format') || remembered.formatId || null;
  let sid = params.get('session');
  let tab = TABS.includes(params.get('tab')) ? params.get('tab') : TABS.includes(remembered.tab) ? remembered.tab : 'skill';
  let talking = Boolean(sid);
  let showArchived = false;
  let firstLoad = true;
  let search = '';
  let legacyStyle = params.get('legacyStyle');
  let chat = null;
  let events = null;
  let intakeBusy = false;
  let fileKind = 'all'; // Files tab filter: all, asset or knowledge
  const settings = new Map(); // per conversation: name, direction and study depth not yet saved
  const choices = new Map(); // per draft (conversation + token): Keep / Discard picked in the panel

  const cleanup = () => {
    events?.close();
    chat?.destroy?.();
    events = null;
    chat = null;
  };
  // Disables the clicked control while its work runs; errors become a toast.
  const run = (fn) => async (e) => {
    const b = e?.currentTarget;
    if (b) b.disabled = true;
    try { await fn(e); } catch (err) { toast(err.message); } finally { if (b) b.disabled = false; }
  };
  const conversation = (id) => data.sessions.find((s) => s.id === id) || null;
  const versionNumber = (versionId) => data.versions.find((v) => v.id === versionId)?.number;
  const nextNumber = () => data.versions.filter((v) => v.formatId === fid).length + 1;
  const activeNumber = () => versionNumber(view.format?.activeVersion);
  const warn = (result, fallback) => { if (result?.warning) toast(result.warning); else if (fallback) toast(fallback); };
  const choiceMap = (sessionId, token) => {
    const key = `${sessionId}:${token}`;
    if (!choices.has(key)) choices.set(key, new Map());
    return choices.get(key);
  };
  const referenceName = (referenceId) => {
    for (const s of data.sessions) {
      const r = s.references.find((x) => x.id === referenceId);
      if (r) return r.name;
    }
    return 'an example';
  };
  const conversationLabel = (s) => [s.name, conversationStatus(s.status), shortDate(s.updated || s.created)].filter(Boolean).join(' · ');
  const newestConversations = (formatId) => data.sessions
    .filter((s) => s.formatId === formatId)
    .sort((a, b) => String(b.updated || b.created).localeCompare(String(a.updated || a.created)));

  // ---- Loading and selection ----

  async function load() {
    data = await api(E);
    const chosen = data.sessions.find((s) => s.id === sid);
    if (chosen) fid = chosen.formatId; else sid = null;
    const chosenFormat = data.formats.find((f) => f.id === fid);
    if (chosenFormat) pid = chosenFormat.profileId;
    // A deep link to something archived shows archived items rather than silently jumping elsewhere.
    if (firstLoad && (chosenFormat?.archived || data.profiles.find((p) => p.id === pid)?.archived)) showArchived = true;
    firstLoad = false;
    const profiles = data.profiles.filter((p) => showArchived || !p.archived);
    pid = profiles.some((p) => p.id === pid) ? pid : profiles[0]?.id || null;
    const formats = data.formats.filter((f) => f.profileId === pid && (showArchived || !f.archived));
    fid = formats.some((f) => f.id === fid) ? fid : formats[0]?.id || null;
    if (sid && conversation(sid)?.formatId !== fid) sid = null;
    const format = formats.find((f) => f.id === fid) || null;
    const conversations = format ? newestConversations(format.id) : [];
    if (talking && !sid) sid = conversations.find((s) => s.status !== 'cancelled')?.id || null;
    const [videoRows, active, skill, files] = await Promise.all([
      Promise.all(formats.map((f) => api(`${E}/formats/${f.id}/videos`).catch(() => []))),
      format?.activeVersion ? api(`${E}/versions/${format.activeVersion}`).catch((e) => ({ error: e.message })) : null,
      format ? api(`${E}/formats/${format.id}/skill`).catch(() => null) : null,
      format ? api(`${E}/formats/${format.id}/files`).catch((e) => ({ error: e.message })) : null,
    ]);
    view = {
      profiles,
      profile: profiles.find((p) => p.id === pid) || null,
      formats,
      format,
      conversations,
      versions: data.versions.filter((v) => v.formatId === fid).sort((a, b) => a.number - b.number),
      active: active && !active.error ? active : null,
      activeError: active?.error || null,
      skill,
      files,
      videos: new Map(formats.map((f, i) => [f.id, videoRows[i]])),
      ...(format ? await findDrafts(conversations) : { panel: null, panelError: null, draft: null }),
    };
  }

  // The panel shows the open conversation's draft. The Skill tab shows that draft, or else the newest other one.
  async function findDrafts(conversations) {
    const probe = async (s) => {
      try { return { session: s, proposal: await api(`${E}/sessions/${s.id}/proposal`) }; } catch (e) { return { session: s, error: e.message }; }
    };
    let panel = null, panelError = null;
    if (sid) {
      const found = await probe(conversation(sid));
      if (found.proposal) panel = found;
      else if (!quietDraftError(found.error)) panelError = found.error;
    }
    let draft = panel;
    if (!draft) {
      const others = conversations.filter((s) => s.id !== sid && !['running', 'cancelled', 'approved'].includes(s.status)).slice(0, 4);
      for (const s of others) {
        const found = await probe(s);
        if (found.proposal) { draft = found; break; }
      }
    }
    return { panel, panelError, draft };
  }

  function remember() {
    try { localStorage.setItem(SELECTION_KEY, JSON.stringify({ profileId: pid || null, formatId: fid || null, tab })); } catch {}
    const query = new URLSearchParams();
    if (pid) query.set('profile', pid);
    if (fid) query.set('format', fid);
    if (talking && sid) query.set('session', sid);
    if (tab !== 'skill') query.set('tab', tab);
    if (legacyStyle) query.set('legacyStyle', legacyStyle);
    window.history.replaceState(null, '', `#/learning${query.size ? '?' + query : ''}`);
  }

  async function paint() {
    const scrolls = [...root.querySelectorAll('[data-scroll]')].map((el) => [el.dataset.scroll, el.scrollTop]);
    const pageScroll = root.scrollTop;
    closeMenu();
    cleanup();
    await load();
    if (!live) return;
    remember();
    root.innerHTML = page();
    for (const [key, top] of scrolls) {
      const el = root.querySelector(`[data-scroll="${key}"]`);
      if (el) el.scrollTop = top;
    }
    root.scrollTop = pageScroll;
    applySearch();
    if (talking && view.format && sid) mountConversation();
  }
  // Tabs and inline changes repaint the format home only, so the conversation panel keeps running.
  function paintHome() {
    const home = $('.vf3-home', root);
    if (home) home.innerHTML = homeInner();
    remember();
  }

  // ---- Markup ----

  function page() {
    const open = talking && view.format;
    const notice = legacyStyle
      ? `<p class="notice vf-legacy">Use legacy style notes as an example: <b>${esc(legacyStyle)}</b>. Choose the channel and format, open ${TERMS.talk} and start a new conversation; the notes are added to it. The original files and projects stay unchanged.</p>`
      : '';
    return `<div class="learn-page vf3-page">${notice}
      <div class="vf3${open ? ' talking' : ''}">
        ${channelsPane()}
        ${formatsPane()}
        <section class="vf3-pane vf3-home" data-scroll="home" aria-label="${esc(view.format?.name || TERMS.formats)}">${homeInner()}</section>
        ${open ? panelMarkup() : ''}
      </div>
    </div>`;
  }

  function channelsPane() {
    const rows = view.profiles.map((p) => {
      const count = data.formats.filter((f) => f.profileId === p.id && (showArchived || !f.archived)).length;
      const on = p.id === pid;
      return `<div class="vf-chan${on ? ' on' : ''}${p.archived ? ' archived' : ''}">
        <button type="button" class="vf-chan-pick" data-profile="${p.id}" aria-pressed="${on}">
          <span class="vf-chan-name">${esc(p.name)}</span>${p.archived ? '<span class="badge">Archived</span>' : ''}
          <span class="vf-count" aria-label="${plural(count, 'format')}">${count}</span>
        </button>
        <button type="button" class="vf-icon vf-dots" data-channel-menu="${p.id}" aria-haspopup="menu" aria-expanded="false" aria-label="Options for ${esc(p.name)}">···</button>
      </div>`;
    }).join('');
    return `<section class="vf3-pane vf3-channels" aria-label="${TERMS.channels}" data-scroll="channels">
      <div class="vf-pane-head">
        <h2 class="vf-label">${TERMS.channels}</h2>
        <button type="button" class="vf-icon" data-action="channel" aria-label="Add a channel" title="Add a channel">+</button>
      </div>
      <div class="vf-chan-list">${rows || '<p class="vf-none">No channels yet.</p>'}</div>
      <div class="vf-pane-foot">
        <label class="learn-check vf-toggle"><input type="checkbox" data-show-archived${showArchived ? ' checked' : ''}>Show archived</label>
        <details class="vf-how"><summary>How formats work</summary>
          <p><b>A channel</b> is a YouTube channel, brand or series. It is shared with Brand settings and New video.</p>
          <p><b>A format</b> is a repeatable kind of video. Its <b>skill</b> is the guide you teach it by talking to it, reviewed and saved as versions.</p>
          <p>Saving a new version affects only future videos; existing videos keep the version they started with. <a href="#/settings/brand">Brand profiles</a> hold identity and voice; <a href="#/settings/look">Video defaults</a> hold starting appearance.</p>
        </details>
      </div>
    </section>`;
  }

  // Shown instead of the channels pane on narrower screens and while the conversation panel is open.
  function channelSelect() {
    const list = view.profiles.map((p) => `<option value="${p.id}"${p.id === pid ? ' selected' : ''}>${esc(p.name)}${p.archived ? ' (archived)' : ''}</option>`).join('');
    return `<div class="vf-chan-select">
      <label class="vf-grow"><span class="vh">${TERMS.channel}</span><select data-channel-select aria-label="${TERMS.channel}">${list}<option value="__new">+ New channel…</option></select></label>
      ${view.profile ? `<button type="button" class="vf-icon vf-dots" data-channel-menu="${view.profile.id}" aria-haspopup="menu" aria-expanded="false" aria-label="Options for ${esc(view.profile.name)}">···</button>` : ''}
    </div>`;
  }

  function skillStatus(f) {
    if (f.activeVersion) return { label: `${TERMS.skill} v${versionNumber(f.activeVersion) ?? ''}`, kind: 'ok' };
    if (data.sessions.some((s) => s.formatId === f.id && ['running', 'review'].includes(s.status))) return { label: 'Studying', kind: 'warn' };
    return { label: 'Basic', kind: 'none' };
  }

  function formatsPane() {
    const p = view.profile;
    if (!p) {
      return `<section class="vf3-pane vf3-formats" aria-label="Formats" data-scroll="formats">
        <div class="vf-pane-head"><h2>Formats</h2><button type="button" class="btn small" data-action="channel">+ ${TERMS.channel}</button></div>
        <p class="vf-none">Create a channel first.</p>
      </section>`;
    }
    const rows = view.formats.map((f) => {
      const on = f.id === fid, st = skillStatus(f), used = view.videos.get(f.id)?.length || 0;
      return `<button type="button" class="vf-fmt${on ? ' on' : ''}${f.archived ? ' archived' : ''}" data-format="${f.id}" data-name="${esc(f.name.toLowerCase())}" aria-pressed="${on}">
        <span class="vf-fmt-top"><b>${esc(f.name)}</b><span class="vf-pill ${st.kind}">${esc(st.label)}</span></span>
        <small>${esc(setupName(f))} · ${used ? plural(used, 'video') : 'no videos yet'}${f.archived ? ' · Archived' : ''}</small>
      </button>`;
    }).join('');
    const empty = p.archived
      ? `<div class="vf-empty"><b>This channel is archived</b><p class="sub">It is hidden from New video. Nothing was deleted.</p>${button('Restore channel', 'unarchiveChannel', 'small')}</div>`
      : `<div class="vf-empty"><b>No formats yet</b><p class="sub">A format is a repeatable kind of video, such as long-form explainers or Shorts.</p>${button('+ Format', 'format', 'small primary')}</div>`;
    return `<section class="vf3-pane vf3-formats" aria-label="Formats in ${esc(p.name)}" data-scroll="formats">
      ${channelSelect()}
      <div class="vf-pane-head">
        <h2 class="vf-formats-title">${esc(p.name)}</h2>
        ${p.archived ? '' : `<button type="button" class="btn small" data-action="format">+ Format</button>`}
      </div>
      ${p.archived && view.formats.length ? `<p class="sub">This channel is archived. ${button('Restore channel', 'unarchiveChannel', 'small')}</p>` : ''}
      ${view.formats.length > 4 ? `<input type="search" class="vf-search" data-search placeholder="Search formats" aria-label="Search formats" value="${esc(search)}">` : ''}
      <div class="vf-fmt-list">${rows || empty}</div>
    </section>`;
  }

  function applySearch() {
    const q = search.trim().toLowerCase();
    root.querySelectorAll('.vf-fmt[data-name]').forEach((row) => { row.hidden = Boolean(q) && !row.dataset.name.includes(q); });
  }

  function homeInner() {
    const { format: f, profile: p } = view;
    if (!p) {
      return `<div class="empty vf-home-empty"><b>Create a channel to begin</b><p class="sub">A channel can be a YouTube channel, a brand or a series. Add its video formats next; each one learns its own skill.</p>${button(`+ ${TERMS.channel}`, 'channel', 'primary')}</div>`;
    }
    if (!f) {
      return p.archived
        ? `<div class="empty vf-home-empty"><b>${esc(p.name)} is archived</b><p class="sub">Restore it to add formats and make new videos.</p>${button('Restore channel', 'unarchiveChannel', 'primary')}</div>`
        : `<div class="empty vf-home-empty"><b>Add the first format to ${esc(p.name)}</b><p class="sub">A format is a repeatable kind of video, such as long-form explainers or Shorts. It is ready for New video as soon as you save it.</p>${button('+ New format', 'format', 'primary')}</div>`;
    }
    const used = view.videos.get(f.id)?.length || 0;
    const number = activeNumber();
    const archived = f.archived || p.archived;
    const meta = [
      setupName(f),
      targetText(f.targetSeconds),
      number ? `${TERMS.skill} v${number}` : 'No skill yet',
      `used in ${plural(used, 'video')}`,
    ].filter(Boolean).join(' · ');
    const drafting = view.draft ? ` · <button type="button" class="link-btn" data-action="openDraft">v${nextNumber()} being drafted</button>` : '';
    const examples = view.conversations.reduce((n, s) => n + s.references.length, 0);
    const learnings = (view.active?.learnings?.length || 0);
    const tabs = [
      ['skill', TERMS.skill],
      ['files', `Files · ${view.files?.totals?.count || 0}`],
      ['examples', `Examples · ${examples}`],
      ['learnings', `Insights · ${learnings}`],
      ['videos', `Videos · ${used}`],
      ['history', view.versions.length ? `History · v1–v${view.versions.at(-1).number}` : 'History'],
    ];
    return `<header class="vf-home-head">
        <div class="vf-home-title">
          <p class="vf-crumb">${esc(p.name)} › ${esc(f.name)}</p>
          <div class="vf-name-row">
            <h1>${esc(f.name)}</h1>
            <button type="button" class="vf-icon" data-action="editFormat" aria-label="Rename or edit format setup" title="Rename or edit setup">${PENCIL}</button>
          </div>
          <p class="sub vf-meta">${esc(meta)}${drafting}</p>
        </div>
        <div class="vf-home-actions">
          <button type="button" class="btn${talking ? ' on' : ''}" data-action="talk" aria-pressed="${Boolean(talking)}">${TERMS.talk}</button>
          <button type="button" class="btn primary" data-action="newVideo"${archived ? ' disabled title="Restore this format to make new videos"' : ''}>New video</button>
          <button type="button" class="vf-icon vf-dots vf-more" data-action="formatMenu" aria-haspopup="menu" aria-expanded="false" aria-label="More options for ${esc(f.name)}">···</button>
        </div>
      </header>
      ${archived ? `<p class="notice">${f.archived ? 'This format is archived' : 'Its channel is archived'}. It is hidden from New video; existing videos are untouched. ${f.archived ? button('Restore format', 'unarchiveFormat', 'small') : button('Restore channel', 'unarchiveChannel', 'small')}</p>` : ''}
      <div class="vf-tabs" role="tablist" aria-label="Format sections">
        ${tabs.map(([key, label]) => `<button type="button" role="tab" class="vf-tab" data-tab="${key}" aria-selected="${tab === key}" aria-controls="vfTabBody">${esc(label)}</button>`).join('')}
      </div>
      <div class="vf-tab-body" id="vfTabBody" role="tabpanel">${tabBody()}</div>`;
  }

  function tabBody() {
    if (tab === 'files') return filesTab();
    if (tab === 'examples') return examplesTab();
    if (tab === 'learnings') return learningsTab();
    if (tab === 'videos') return videosTab();
    if (tab === 'history') return historyTab();
    return skillTab();
  }

  // Where a saved rule came from: a direct edit, a chat instruction, or the conversation that studied examples.
  function ruleSource(rule) {
    const evidence = rule.evidence || [];
    if (evidence.some((e) => e.kind === 'manual')) return { label: 'Edited by you', kind: 'src-you' };
    if (evidence.some((e) => e.kind === 'instruction')) return { label: 'Edited in chat', kind: 'src-chat' };
    const refs = new Set(evidence.map((e) => e.referenceId).filter(Boolean));
    const s = conversation(rule.sourceSession) || data.sessions.find((x) => x.references.some((r) => refs.has(r.id)));
    return { label: s?.name || 'Study', kind: 'src-study' };
  }

  function ruleRow(rule, { mark = null, was = null, removed = false, discarded = false, draftSession = null } = {}) {
    const source = ruleSource(rule);
    const tag = mark ? `<span class="vf-tag ${mark.toLowerCase()}">${discarded ? `${mark} · discarded` : mark}</span>` : '';
    return `<div class="vf-rule${mark ? ' pending' : ''}${discarded ? ' discarded' : ''}">
      <div class="vf-rule-text">
        ${removed ? `<s>${esc(rule.text)}</s>` : `<span>${esc(rule.text)}</span>`}
        ${was ? `<s class="vf-was">${esc(was)}</s>` : ''}
      </div>
      ${tag}
      <span class="vf-src ${source.kind}" title="${esc(source.label)}">${esc(source.label)}</span>
      <button type="button" class="vf-icon" data-edit-rule="${esc(rule.id)}"${draftSession ? ` data-draft-rule="1"` : ''} aria-label="Edit rule: ${esc(rule.text.slice(0, 60))}">${PENCIL}</button>
    </div>`;
  }

  function skillTab() {
    const { active, draft, format: f } = view;
    const proposal = draft?.proposal || null;
    const picked = proposal ? choiceMap(draft.session.id, proposal.token) : new Map();
    const saved = active?.rules || [];
    if (view.activeError) {
      return `<div class="notice">The saved skill could not be read: ${esc(view.activeError)} ${button('Restore generated files', 'restoreActive', 'small')}</div>`;
    }
    if (!saved.length && !proposal) {
      return `<div class="vf-skill-grid"><section class="vf-card vf-empty-card">
          <b>No skill yet</b>
          <p class="sub">${esc(f.name)} uses the core ${esc(setupName(f))} workflow for now. Talk to it to teach it from example videos, or add a rule yourself. Every change is a draft you review before it is saved as v1.</p>
          <div class="learn-actions">${button(TERMS.talk, 'talk', 'primary small')}${button('+ Add a rule', 'addRule', 'small')}</div>
        </section>${skillSide()}</div>`;
    }
    const changed = new Map(), removed = new Map();
    for (const r of proposal?.rules || []) if (r.change === 'changed') changed.set(r.id, r);
    for (const r of proposal?.removals || []) removed.set(r.id, r);
    const savedIds = new Set(saved.map((r) => r.id));
    const groups = new Map(AREAS.map((a) => [a.id, []]));
    const put = (area, row) => { if (!groups.has(area)) groups.set(area, []); groups.get(area).push(row); };
    for (const rule of saved) {
      const next = changed.get(rule.id), gone = removed.get(rule.id);
      if (next) put(next.area, ruleRow({ ...next, evidence: next.evidence }, { mark: 'Changed', was: rule.text, discarded: picked.get(rule.id) === 'discard', draftSession: draft.session }));
      else if (gone) put(rule.area, ruleRow(rule, { mark: 'Removed', removed: true, discarded: picked.get(rule.id) === 'discard' }));
      else put(rule.area, ruleRow(rule));
    }
    // New rules, and changes to rules that are no longer in the active version (a stale draft).
    for (const r of proposal?.rules || []) {
      if (savedIds.has(r.id)) continue;
      put(r.area, ruleRow(r, { mark: r.change === 'changed' ? 'Changed' : 'New', was: r.previous?.text || null, discarded: picked.get(r.id) === 'discard', draftSession: draft.session }));
    }
    const count = proposal ? proposal.rules.length + proposal.removals.length : 0;
    const body = [...groups].filter(([, rows]) => rows.length)
      .map(([area, rows]) => `<div class="vf-area"><h3 class="vf-area-name">${esc(areaName(area))}</h3>${rows.join('')}</div>`).join('');
    const stale = proposal?.stale
      ? `<p class="notice vf-stale">This draft started from v${proposal.baseNumber || '—'}, but the skill is now v${activeNumber() || '—'}. Rebase it onto the current version before saving. ${button('Rebase draft', 'rebaseDraft', 'small')}</p>`
      : '';
    return `<div class="vf-skill-grid">
      <section class="vf-card vf-rules" aria-label="Rules">
        <div class="vf-card-head">
          <h2>Rules</h2>
          ${count ? `<button type="button" class="link-btn sub" data-action="openDraft">${plural(count, 'change')} waiting for review in “${esc(draft.session.name)}”</button>` : `<span class="sub">${active ? `${TERMS.skill} v${active.number}` : ''}</span>`}
          ${button('+ Rule', 'addRule', 'small')}
        </div>
        ${stale}
        ${body}
      </section>
      ${skillSide()}
    </div>`;
  }

  function skillSide() {
    const { skill, active, format: f, profile: p } = view;
    const examples = view.conversations.reduce((n, s) => n + s.references.length, 0);
    const files = [
      ['SKILL.md', active ? `v${active.number}` : ''],
      ['rules.md', active ? plural(active.rules.length, 'rule') : ''],
      ['examples/', String(examples)],
      ['assets/', String(active?.assets?.length || 0)],
      ['knowledge/', String(active?.knowledge?.length || 0)],
      ['learnings.md', String(active?.learnings?.length || 0)],
      ['videos.md', String(view.videos.get(f.id)?.length || 0)],
    ];
    let state = 'Appears after the first saved version.';
    if (skill?.problem) state = `Needs attention: ${skill.problem}`;
    else if (skill?.archived) state = 'Not published while the format is archived.';
    else if (skill?.published && skill.current) state = `Published · v${skill.activeNumber}`;
    else if (active) state = 'Waiting to be rebuilt. It retries when agents finish, or now:';
    const actions = [
      skill?.path ? button('Show in Finder', 'revealSkill', 'small') : '',
      active && !skill?.current && !skill?.archived ? button('Rebuild', 'rebuildSkill', 'small') : '',
    ].join('');
    return `<aside class="vf-skill-side">
      <section class="vf-card vf-folder" aria-label="Skill folder">
        <b>Skill folder</b>
        <div class="vf-tree">
          <div>${esc(skill?.name || 'format-skill')}/</div>
          ${files.map(([name, size]) => `<div class="vf-tree-row"><span>${esc(name)}</span><span>${esc(size)}</span></div>`).join('')}
        </div>
        <p class="sub">${esc(state)}</p>
        ${actions ? `<div class="learn-actions">${actions}</div>` : ''}
      </section>
      <section class="vf-card vf-note">Picked automatically when a new video is for <b>${esc(p.name)} › ${esc(f.name)}</b>. Videos keep the skill version they started with.</section>
    </aside>`;
  }

  // ---- Files: the skill's assets and knowledge, with the open draft's New / Changed / Removed files inline ----

  function fileRow(file, { mark = null, discarded = false, staged = false } = {}) {
    const title = file.kind === 'knowledge' && file.title ? file.title : file.name;
    const added = file.addedIn?.number ? `added in v${file.addedIn.number}` : staged ? 'in the draft' : '';
    const meta = [file.kind === 'knowledge' ? 'Knowledge' : 'Asset', fileSize(file.size), added].filter(Boolean).join(' · ');
    const tag = mark ? `<span class="vf-tag ${mark.toLowerCase()}">${discarded ? `${mark} · discarded` : mark}</span>` : '';
    const path = esc(file.path || file.file);
    let actions = '';
    if (staged) actions = `<button type="button" class="btn small ghost" data-file-unstage="${path}">Take out of draft</button>`;
    else if (mark === 'Removed') actions = `<button type="button" class="btn small ghost" data-file-unstage="${path}">Keep it</button>`;
    else {
      actions = `<button type="button" class="btn small" data-file-reveal="${path}">Show in Finder</button>
        <button type="button" class="btn small ghost" data-file-remove="${path}" aria-label="Remove ${esc(title)} from the skill">Remove</button>`;
    }
    return `<li class="vf-file${mark ? ' pending' : ''}${discarded ? ' discarded' : ''}">
      <div class="vf-file-main">
        ${mark === 'Removed' ? `<s>${esc(title)}</s>` : `<b>${esc(title)}</b>`}
        ${title !== file.name ? `<small class="vf-file-name">${esc(file.name)}</small>` : ''}
        ${file.note ? `<span class="vf-file-note">${esc(file.note)}</span>` : ''}
        <small>${esc(meta)}</small>
      </div>
      ${tag}
      <span class="vf-file-actions">${actions}</span>
    </li>`;
  }

  function filesTab() {
    const listed = view.files;
    if (listed?.error) return `<div class="notice">The skill files could not be read: ${esc(listed.error)}</div>`;
    const saved = listed?.files || [];
    const draft = view.draft;
    const pending = draft?.proposal?.files || { added: [], removed: [] };
    const picked = draft?.proposal ? choiceMap(draft.session.id, draft.proposal.token) : new Map();
    const removed = new Set(pending.removed.map((r) => r.path));
    const replaced = new Set(pending.added.map((a) => a.path));
    const shown = (kind) => fileKind === 'all' || fileKind === kind;
    const rows = [
      ...pending.added.filter((a) => shown(a.kind)).map((a) => fileRow(a, { mark: a.change === 'changed' ? 'Changed' : 'New', staged: true, discarded: picked.get(`file:${a.path}`) === 'discard' })),
      ...saved.filter((x) => shown(x.kind) && !replaced.has(x.file)).map((x) => fileRow(x, { mark: removed.has(x.file) ? 'Removed' : null, discarded: picked.get(`file:${x.file}`) === 'discard' })),
    ];
    const totals = listed?.totals || { count: 0, assets: 0, knowledge: 0, bytes: 0 };
    const changes = pending.added.length + pending.removed.length;
    const filter = [['all', 'All', totals.count], ['asset', 'Assets', totals.assets], ['knowledge', 'Knowledge', totals.knowledge]]
      .map(([key, label, n]) => `<button type="button" class="vf-seg${fileKind === key ? ' on' : ''}" data-file-kind="${key}" aria-pressed="${fileKind === key}">${label} · ${n}</button>`).join('');
    const empty = !saved.length && !pending.added.length
      ? `<div class="vf-empty-files"><b>No files yet</b><p class="sub"><b>Assets</b> are files videos use directly: backgrounds, icons, logos, motion graphics, styles. <b>Knowledge</b> is what the agent reads when a video needs the facts: product sheets, specs, brand facts, price lists. Added files go into a draft you review and save as a new version.</p></div>`
      : rows.length ? '' : '<p class="sub vf-none">No files of this kind.</p>';
    return `<section class="vf-card vf-files" aria-label="Skill files">
      <div class="vf-card-head">
        <h2>Files</h2>
        ${changes ? `<button type="button" class="link-btn sub" data-action="openDraft">${plural(changes, 'file change')} waiting for review in “${esc(draft.session.name)}”</button>` : ''}
        ${button('Add files', 'addFiles', 'small primary')}
      </div>
      <div class="vf-files-bar">
        <div class="vf-segs" role="group" aria-label="Show files">${filter}</div>
        <span class="sub">${totals.count} of ${MAX_FILES} files · ${fileSize(totals.bytes) || '0 bytes'} · up to ${fileSize(MAX_FILE_BYTES)} each</span>
      </div>
      ${empty}
      ${rows.length ? `<ul class="vf-file-list">${rows.join('')}</ul>` : ''}
    </section>`;
  }

  // Uploads go into a conversation draft (the open one, or the draft the Skill tab shows), never straight into the skill.
  function addFilesDialog(sessionId = null) {
    const f = view.format;
    const el = dialog('Add files to the skill', `<p class="sub">Files go into a draft. Review and save it as a new skill version; videos already made keep theirs.</p>
      <label>Kind<select name="kind">
        <option value="asset">Asset · used in videos (backgrounds, icons, logos, motion graphics, styles)</option>
        <option value="knowledge">Knowledge · facts the agent reads (product sheets, specs, price lists)</option>
      </select></label>
      <label>Files<input type="file" name="files" multiple required></label>
      <label>Note (optional)<input name="note" maxlength="2000" placeholder="When the agent should use these files"></label>
      <p class="sub">Up to ${MAX_FILES} files per skill, ${fileSize(MAX_FILE_BYTES)} each. Knowledge can be Markdown, text, CSV, JSON, PDF or images.</p>
      <p class="sub" role="status" data-upload-status></p>`, async (b) => {
      const files = [...$('[name=files]', el).files];
      if (!files.length) throw Error('Choose at least one file.');
      for (const file of files) {
        if (file.size > MAX_FILE_BYTES) throw Error(`${file.name} is larger than ${fileSize(MAX_FILE_BYTES)}.`);
        if (b.kind === 'knowledge' && !KNOWLEDGE_TYPES.test(file.name)) throw Error(`${file.name}: knowledge can be Markdown, text, CSV, JSON, PDF or an image.`);
      }
      let target = sessionId ? conversation(sessionId) : draftTarget();
      let revision = target?.revision;
      let last = null;
      for (const [i, file] of files.entries()) {
        $('[data-upload-status]', el).textContent = `Adding ${file.name} (${i + 1} of ${files.length})…`;
        const query = new URLSearchParams({ kind: b.kind, name: file.name, note: b.note || '' });
        if (target) { query.set('sessionId', target.id); query.set('revision', String(revision)); }
        const res = await fetch(`${E}/formats/${f.id}/files?${query}`, { method: 'POST', headers: { 'X-Studio': '1' }, body: file });
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw Error(`${file.name}: ${r.error || `HTTP ${res.status}`}${i ? ' Earlier files were added.' : ''}`);
        last = r;
        target = r.session;
        revision = r.session.revision;
      }
      sid = last.session.id;
      await paint();
      toast(last.proposalError ? `Added to the draft, but it needs attention: ${last.proposalError}` : `Added ${plural(files.length, 'file')} to the draft in “${last.session.name}”. Review and save it when ready.`);
    }, 'Add to draft');
  }

  async function fileChange(action, path) {
    const target = draftTarget();
    const body = { action, path };
    if (target) { body.sessionId = target.id; body.revision = target.revision; }
    const res = await api(`${E}/formats/${fid}/draft-file`, body);
    sid = res.session.id;
    await paint();
    toast(action === 'remove' ? `Removal added to the draft in “${res.session.name}”.` : 'Taken out of the draft.');
  }

  function examplesTab() {
    const cited = new Set((view.active?.rules || []).flatMap((r) => (r.evidence || []).map((e) => e.referenceId)).filter(Boolean));
    const frames = new Map((view.active?.examples || []).map((x) => [x.referenceId, x.frames?.length || 0]));
    const groups = view.conversations.filter((s) => s.references.length).map((s) => {
      const saved = (s.approvedVersions || (s.approvedVersion ? [s.approvedVersion] : [])).map(versionNumber).filter(Boolean);
      const rows = s.references.map((r) => {
        const detail = r.url
          ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.url)}</a>`
          : r.note ? `<span>${esc(r.note.slice(0, 240))}</span>` : `<span>${Math.round((r.size || 0) / 1024)} KB · local copy</span>`;
        const notes = [cited.has(r.id) ? 'Evidence in the saved skill' : '', frames.get(r.id) ? plural(frames.get(r.id), 'key frame') : ''].filter(Boolean).join(' · ');
        return `<li><b>${esc(r.name)}</b>${detail}${notes ? `<small>${esc(notes)}</small>` : ''}</li>`;
      }).join('');
      return `<section class="vf-card"><div class="vf-card-head"><h2>${esc(s.name)}</h2><span class="sub">${esc(conversationStatus(s.status))}${saved.length ? ` · saved v${saved.join(', v')}` : ''}</span>${button('Open', `openConversation:${s.id}`, 'small')}</div><ul class="vf-examples">${rows}</ul></section>`;
    }).join('');
    return groups || `<div class="vf-card vf-empty-card"><b>No examples yet</b><p class="sub">Drop example videos or paste links in ${TERMS.talk}. The originals stay in the conversation's folder; the skill folder keeps notes, links and a few key frames.</p>${button(TERMS.talk, 'talk', 'small')}</div>`;
  }

  function learningsTab() {
    const saved = view.active?.learnings || [];
    const pending = view.draft?.proposal?.learnings || [];
    const row = (l, isNew) => {
      const s = conversation(l.sourceSession);
      const source = s ? s.name : (l.evidence || []).some((e) => e.kind === 'instruction') ? 'Chat' : '';
      return `<li class="vf-learning">${isNew ? '<span class="vf-tag new">New</span>' : ''}<span>${esc(l.text)}</span>${source ? `<small>${esc(source)}${l.versionId ? ` · v${versionNumber(l.versionId) ?? ''}` : ''}</small>` : ''}</li>`;
    };
    if (!saved.length && !pending.length) {
      return `<div class="vf-card vf-empty-card"><b>No insights yet</b><p class="sub">Insights are observations from studies that aren't rules, for example which hooks kept viewers watching. They appear here once a saved version includes them.</p></div>`;
    }
    return `<section class="vf-card"><ul class="vf-learnings">${pending.map((l) => row(l, true)).join('')}${saved.map((l) => row(l, false)).join('')}</ul></section>`;
  }

  function videosTab() {
    const rows = view.videos.get(fid) || [];
    const current = view.format.activeVersion;
    if (!rows.length) {
      return `<div class="vf-card vf-empty-card"><b>No videos use this format yet</b><p class="sub">New videos for this format start with its current skill and keep that version.</p>${view.format.archived ? '' : button('New video', 'newVideo', 'small primary')}</div>`;
    }
    return `<section class="vf-card"><ul class="vf-videos">${rows.map((r) => `<li>
        ${r.exists ? `<a href="#/p/${encodeURIComponent(r.project)}">${esc(r.name)}</a>` : `<span>${esc(r.name)} <small>(project folder not found)</small></span>`}
        <span class="vf-pill ${r.versionId && r.versionId === current ? 'ok' : 'none'}">${r.number ? `${TERMS.skill} v${r.number}` : 'No skill'}</span>
        <small>${esc(shortDate(r.created))}</small>
      </li>`).join('')}</ul></section>`;
  }

  function historyTab() {
    if (!view.versions.length) {
      return `<div class="vf-card vf-empty-card"><b>No saved versions yet</b><p class="sub">Each time you review and save a draft, it becomes a new version here. You can read, restore or switch back to any of them.</p></div>`;
    }
    const f = view.format;
    return `<p class="sub">Changing the active version affects future videos. Existing videos stay on their version.</p>
      ${[...view.versions].reverse().map((v) => `<section class="vf-card vf-version" data-version="${v.id}">
        <div class="vf-card-head">
          <h2>v${v.number} · ${esc(v.name)}</h2>
          ${v.id === f.activeVersion ? '<span class="vf-pill ok">Active</span>' : ''}
          <span class="sub">${esc(shortDate(v.created))}${v.copiedFrom ? ` · copied from ${esc(v.copiedFrom.profileName)} › ${esc(v.copiedFrom.formatName)} v${v.copiedFrom.number}` : ''}</span>
        </div>
        <div class="learn-actions">
          ${button('Read', `readVersion:${v.id}`, 'small')}
          ${button('Use for a new video', `versionProject:${v.id}`, 'small')}
          ${v.id !== f.activeVersion ? button('Make active', `activateVersion:${v.id}`, 'small') : ''}
          ${button('Restore generated files', `regenerateVersion:${v.id}`, 'small')}
        </div>
        <div class="vf-version-body" hidden></div>
      </section>`).join('')}`;
  }

  // ---- The conversation panel ----

  function panelMarkup() {
    const f = view.format;
    const list = view.conversations.map((s) => `<option value="${s.id}"${s.id === sid ? ' selected' : ''}>${esc(conversationLabel(s))}</option>`).join('');
    const head = `<div class="chat-head vf-chat-head">
        <label class="vf-grow"><span class="vh">${TERMS.conversation}</span><select data-conversation aria-label="${TERMS.conversation}">${sid ? '' : '<option value="" selected>Choose a conversation</option>'}${list}</select></label>
        <span id="sessionInfo" class="vh"></span>
        <button type="button" class="btn small" data-action="newConversation">+ New conversation</button>
        <button type="button" class="vf-icon" data-action="closePanel" aria-label="Close the conversation panel" title="Close">×</button>
      </div>`;
    if (!sid) {
      return `<aside class="vf3-chat" id="vfChat" aria-label="${TERMS.talk}"><section class="col chat vf-chat">${head}
        <div class="vf-chat-empty">
          <b>Talk to ${esc(f.name)}</b>
          <p class="sub">Drop example videos, paste links, or ask for a change in plain words, like “use blue instead of red for the progress bar”. Changes become a draft you review and save as a new skill version; videos already made keep theirs.</p>
          ${view.conversations.length ? '<p class="sub">Pick an earlier conversation above, or start a new one.</p>' : ''}
          ${button('Start a conversation', 'newConversation', 'primary')}
        </div>
      </section></aside>`;
    }
    const s = conversation(sid);
    const conf = settingsFor(s);
    return `<aside class="vf3-chat" id="vfChat" aria-label="${TERMS.talk}">
      <section class="col chat learn-chat vf-chat">
        ${head}
        <div class="msgs" id="msgs"><div class="empty-chat" id="emptyChat">Drop example videos or files, paste links, or ask for a change. With no examples yet, ask the assistant to find some, for example “find five faceless camping reels with bold captions”.</div></div>
        <div class="working" id="working" hidden><span class="spin"></span><span id="workText">Working…</span></div>
        <div class="vf-dock">
          <div id="vfDraft"></div>
          <div id="learnSuggestions"></div>
        </div>
        <div class="vf-compose" id="learnDrop">
          <div class="vf-added" id="vfAdded"></div>
          <p id="learnIntakeStatus" class="sub" role="status"></p>
          <div class="composer"><textarea id="input" rows="2" aria-label="Message the format assistant" placeholder="Drop videos or files, paste links, or ask for a change"></textarea><button class="send" id="sendBtn" aria-label="Send"><span class="l-send">↑</span><i class="stop-sq l-stop"></i></button></div>
          <div class="vf-compose-tools">
            <button type="button" class="btn small" data-action="attach" title="Add example videos or files to study">Attach files</button>
            <button type="button" class="btn small" data-action="addFilesHere" title="Add assets or knowledge to the skill">Add to skill</button>
            <button type="button" class="btn small" data-action="study">${esc(studyLabel(s.status))}</button>
            <span class="sub vf-grow" id="learnRunHint">Changes are drafts until you save them.</span>
            <button type="button" class="vf-icon" data-action="studySettings" aria-expanded="false" aria-controls="vfSettings" aria-label="Study settings" title="Study settings">⚙</button>
          </div>
          <div class="vf-settings" id="vfSettings" hidden>
            <label>Conversation name<input id="learnName" maxlength="200" value="${esc(conf.name)}"></label>
            <label>What should a study pay attention to? (optional)<textarea id="learnDirection" rows="2" maxlength="12000" placeholder="Leave blank to discover the patterns, or say what you like about these examples.">${esc(conf.direction)}</textarea></label>
            <label>Study depth<select id="learnStudy"><option value="overview"${conf.study === 'overview' ? ' selected' : ''}>Quick · representative scenes and transitions</option><option value="detailed"${conf.study === 'detailed' ? ' selected' : ''}>Detailed · up to 4 frames per second</option></select></label>
            <p class="sub">Frame extraction is optional. Detailed extraction covers up to five minutes per video, with a limit of 2,400 frames per conversation.</p>
            <div class="learn-actions">
              ${button('Add a written note', 'note', 'small')}
              ${button('Extract reference frames', 'extract', 'small')}
              ${button('Extraction status', 'extraction', 'small')}
              ${button('Stop extraction', 'extract-stop', 'small')}
              ${button('Close this conversation', 'closeConversation', 'small')}
            </div>
          </div>
          <input type="file" id="learnUpload" multiple hidden accept=".mp4,.mov,.m4v,.webm,.mp3,.wav,.m4a,.ogg,.flac,.png,.jpg,.jpeg,.webp,.txt,.md,.pdf">
        </div>
      </section>
    </aside>`;
  }

  function settingsFor(s) {
    if (!settings.has(s.id)) {
      settings.set(s.id, { name: s.name, direction: s.direction || '', study: s.study || 'overview', saved: { name: s.name, direction: s.direction || '', study: s.study || 'overview' } });
    }
    return settings.get(s.id);
  }

  // Saves edited conversation settings first, so a study or message uses them. Refuses to overwrite edits made elsewhere.
  async function saveSettings(id) {
    const conf = settings.get(id);
    const latest = await api(`${E}/sessions/${id}`);
    if (!conf) return latest;
    if (latest.name === conf.name && latest.direction === conf.direction && latest.study === conf.study) return latest;
    if (['name', 'direction', 'study'].some((key) => latest[key] !== conf.saved[key])) throw Error('Conversation settings changed elsewhere. Reload before saving.');
    const updated = await api(`${E}/sessions/${id}/configure`, { revision: latest.revision, name: conf.name, direction: conf.direction, study: conf.study });
    conf.saved = { name: updated.name, direction: updated.direction, study: updated.study };
    return updated;
  }

  function mountConversation() {
    const id = sid, panel = $('#vfChat', root);
    if (!panel || !makeChat) return;
    paintAdded();
    paintDraft();
    updateStudy();
    loadSuggestions().catch(() => {});
    const conf = settings.get(id);
    for (const [selector, key] of [['#learnName', 'name'], ['#learnDirection', 'direction'], ['#learnStudy', 'study']]) {
      $(selector, panel).oninput = (e) => { conf[key] = e.target.value; };
    }
    $('#learnName', panel).onchange = run(() => saveSettings(id));
    chat = makeChat($('.vf-chat', panel), `_learning_${id}`, { beforeSend: (text) => beforeSend(id, text) }, { base: `${E}/sessions/${id}` });
    const input = $('#input', panel);
    // Pasting only complete links into an empty message box adds them as examples straight away.
    input.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text/plain') || '';
      if (input.value.trim() || !isLinkList(text)) return;
      e.preventDefault();
      run(() => addLinks(id, linkLines(text)))();
    });
    $('#learnUpload', panel).onchange = run((e) => upload(id, [...e.target.files]));
    panel.ondragover = (e) => { e.preventDefault(); panel.classList.add('dragging'); };
    panel.ondragleave = (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('dragging'); };
    panel.ondrop = run(async (e) => {
      e.preventDefault();
      panel.classList.remove('dragging');
      if (e.dataTransfer.files.length) return upload(id, [...e.dataTransfer.files]);
      const links = e.dataTransfer.getData('text/uri-list').split('\n').filter((x) => x && !x.startsWith('#')).join('\n') || e.dataTransfer.getData('text/plain');
      if (isLinkList(links)) return addLinks(id, linkLines(links));
      input.value = input.value ? `${input.value}\n${links}` : links;
      input.focus();
    });
    events = new EventSource(`${E}/sessions/${id}/events`);
    events.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      chat?.handle(ev);
      if (ev.t !== 'busy') return;
      const s = conversation(id);
      if (s && ev.busy) s.status = 'running';
      updateStudy();
      if (!ev.busy && !ev.replay) afterTurn(id).catch(() => {});
    };
  }

  async function beforeSend(id, text) {
    if (isLinkList(text)) {
      await addLinks(id, linkLines(text));
      return null;
    }
    await saveSettings(id);
    return text;
  }

  // Adding examples: each successful item is kept even if a later one fails; uploads are never retried invisibly.
  async function intake(id, work) {
    if (intakeBusy) throw Error('Still adding the previous examples. Try again in a moment.');
    intakeBusy = true;
    const panel = $('#vfChat', root);
    panel?.querySelectorAll('.vf-compose-tools button, .vf-added button').forEach((b) => { b.disabled = true; });
    try {
      await saveSettings(id);
      await work();
    } finally {
      intakeBusy = false;
      panel?.querySelectorAll('.vf-compose-tools button, .vf-added button').forEach((b) => { b.disabled = false; });
      if (live && sid === id) await refreshConversation(id);
    }
  }
  const status = (text) => { const el = $('#learnIntakeStatus', root); if (el) el.textContent = text; };

  function upload(id, files) {
    return intake(id, async () => {
      let latest = await api(`${E}/sessions/${id}`);
      for (const file of files) {
        status(`Adding ${file.name}…`);
        const res = await fetch(`${E}/sessions/${id}/upload?revision=${latest.revision}&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'X-Studio': '1' }, body: file });
        const r = await res.json();
        if (!res.ok) { status(''); throw Error(`${file.name}: ${r.error}. Earlier files were kept.`); }
        latest = r;
      }
      status(`Added ${plural(files.length, 'file')}. Add more, or click ${TERMS.studyAdded}.`);
    });
  }

  function addLinks(id, lines, name = null) {
    const urls = lines.map((line) => {
      let u;
      try { u = new URL(line); } catch { throw Error('Use one complete HTTP or HTTPS link per line.'); }
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error('Use public HTTP or HTTPS links without credentials.');
      return u;
    });
    return intake(id, async () => {
      let latest = await api(`${E}/sessions/${id}`);
      for (const u of urls) {
        if (latest.references.some((r) => r.url === u.href)) continue;
        latest = await api(`${E}/sessions/${id}/references`, { kind: 'link', name: (name || u.hostname + u.pathname).slice(0, 200), url: u.href, revision: latest.revision });
      }
      status(`Added ${plural(urls.length, 'link')}. Links are opened when the study starts; if one can't be opened, the assistant says so.`);
    });
  }

  async function refreshConversation(id) {
    const s = await api(`${E}/sessions/${id}`);
    const i = data.sessions.findIndex((x) => x.id === id);
    if (i >= 0) data.sessions[i] = s; else data.sessions.push(s);
    view.conversations = newestConversations(fid);
    if (!live || sid !== id) return s;
    const option = $(`[data-conversation] option[value="${id}"]`, root);
    if (option) option.textContent = conversationLabel(s);
    paintAdded();
    updateStudy();
    return s;
  }

  function paintAdded() {
    const box = $('#vfAdded', root), s = conversation(sid);
    if (!box || !s) return;
    box.innerHTML = s.references.length
      ? `<span class="sub">Added ${s.references.length}/20</span>${s.references.map((r) => `<span class="vf-chip" title="${esc(r.url || r.note || r.name)}"><span>${esc(r.name)}</span><button type="button" data-remove-reference="${r.id}" aria-label="Remove ${esc(r.name)}">×</button></span>`).join('')}`
      : '';
  }

  function updateStudy() {
    const s = conversation(sid), b = $('[data-action=study]', root), hint = $('#learnRunHint', root);
    if (!s || !b) return;
    b.textContent = studyLabel(s.status);
    b.disabled = s.status === 'running' || !s.references.length;
    b.classList.toggle('primary', s.references.length > 0 && !['running', 'review'].includes(s.status) && !view.panel);
    if (hint) {
      hint.textContent = s.status === 'failed' && s.error
        ? `The last turn stopped: ${s.error}`
        : s.status === 'running' ? 'Working. Answer permission requests in the chat.' : 'Changes are drafts until you save them.';
    }
  }

  async function loadSuggestions() {
    const id = sid;
    const rows = await api(`${E}/sessions/${id}/suggestions`);
    const box = $('#learnSuggestions', root), s = conversation(id);
    if (!box || !live || sid !== id || !s) return;
    const fresh = rows.filter((r) => !s.references.some((x) => x.url === r.url));
    box.replaceChildren();
    if (!fresh.length) return;
    const list = h('<details class="learn-suggestions"><summary>Suggested by the assistant</summary></details>');
    for (const r of fresh) {
      const row = h(`<article class="learn-suggestion"><div><b>${esc(r.name)}</b><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.url)}</a>${r.note ? `<small>${esc(r.note)}</small>` : ''}</div><button class="btn small" type="button">Add</button></article>`);
      $('button', row).onclick = run(() => addLinks(id, [r.url], r.name));
      list.append(row);
    }
    box.append(list);
  }

  // A finished agent turn may have written or changed the draft: refresh the panel and the Skill tab, not the chat.
  async function afterTurn(id) {
    await refreshConversation(id);
    if (!live || sid !== id) return;
    loadSuggestions().catch(() => {});
    const before = view.panel?.proposal?.token;
    const found = await findDrafts(view.conversations);
    if (!live || sid !== id) return;
    Object.assign(view, found);
    paintDraft();
    updateStudy();
    if (tab === 'skill' || tab === 'files') {
      view.files = await api(`${E}/formats/${fid}/files`).catch((e) => ({ error: e.message }));
      paintHome();
    }
    if (found.panel && found.panel.proposal.token !== before) toast('Draft ready. Keep or discard each change, then review and save.');
  }

  function changeRow(item, choice) {
    const kind = item.change === 'new' ? 'new rule' : item.change === 'changed' ? 'change' : 'removal';
    const text = item.change === 'removed'
      ? `<s>${esc(item.text)}</s>`
      : `<span>${esc(item.text)}</span>${item.previous ? `<s class="vf-was">${esc(item.previous.text)}</s>` : ''}`;
    const keep = choice !== 'discard';
    return `<li class="vf-change${keep ? '' : ' discarded'}">
      <div class="vf-change-text"><span class="sub">${esc(areaName(item.area))} · ${kind}</span>${text}</div>
      <span class="vf-keep" role="group" aria-label="Decision">
        <button type="button" class="btn small${keep ? ' on' : ''}" data-choice="keep" data-rule="${esc(item.id)}" aria-pressed="${keep}">Keep</button>
        <button type="button" class="btn small ghost${keep ? '' : ' on'}" data-choice="discard" data-rule="${esc(item.id)}" aria-pressed="${!keep}">Discard</button>
      </span>
    </li>`;
  }

  function fileChangeRow(item, choice) {
    const kind = item.change === 'removed' ? 'file removal' : item.change === 'changed' ? 'file change' : 'new file';
    const label = item.kind === 'knowledge' ? (item.title || item.name) : item.name;
    const keep = choice !== 'discard';
    return `<li class="vf-change${keep ? '' : ' discarded'}">
      <div class="vf-change-text"><span class="sub">${item.kind === 'knowledge' ? 'Knowledge' : 'Asset'} · ${kind} · ${esc(fileSize(item.size))}</span>${item.change === 'removed' ? `<s>${esc(label)}</s>` : `<span>${esc(label)}</span>`}</div>
      <span class="vf-keep" role="group" aria-label="Decision">
        <button type="button" class="btn small${keep ? ' on' : ''}" data-choice="keep" data-rule="file:${esc(item.path)}" aria-pressed="${keep}">Keep</button>
        <button type="button" class="btn small ghost${keep ? '' : ' on'}" data-choice="discard" data-rule="file:${esc(item.path)}" aria-pressed="${!keep}">Discard</button>
      </span>
    </li>`;
  }

  function paintDraft() {
    const box = $('#vfDraft', root);
    if (!box) return;
    if (view.panelError) {
      box.innerHTML = `<p class="notice vf-draft-error">The draft needs attention: ${esc(view.panelError)} Ask the assistant to repair it.</p>`;
      return;
    }
    const d = view.panel;
    if (!d) { box.innerHTML = ''; return; }
    const p = d.proposal, next = nextNumber(), picked = choiceMap(d.session.id, p.token);
    const items = [...p.rules, ...p.removals];
    const fileItems = [...(p.files?.added || []), ...(p.files?.removed || [])];
    box.innerHTML = `<details class="vf-draft" open>
      <summary><b>Draft · ${plural(items.length + fileItems.length, 'change')}</b><span class="sub">saves as v${next}</span></summary>
      ${p.stale ? `<p class="vf-stale sub">Started from v${p.baseNumber || '—'}; the skill is now v${activeNumber() || '—'}. ${button('Rebase draft', 'rebasePanel', 'small')}</p>` : ''}
      <ul class="vf-changes">${items.map((item) => changeRow(item, picked.get(item.id))).join('')}${fileItems.map((item) => fileChangeRow(item, picked.get(`file:${item.path}`))).join('')}</ul>
      ${p.learnings.length ? `<p class="sub">Also saves ${plural(p.learnings.length, 'insight')}.</p>` : ''}
      <div class="learn-actions">${button(`Review and save as v${next}`, 'review', 'primary')}</div>
    </details>`;
  }

  // ---- Review and save: a decision for every rule and every removal; 409 means the skill moved on (rebase). ----

  const evidenceText = (list) => (list || []).map((e) => {
    if (e.kind === 'manual') return 'Edited by you';
    if (e.kind === 'instruction') return `You said: “${esc(e.quote)}”`;
    return `${esc(e.note)} · ${esc(referenceName(e.referenceId))}`;
  }).join('<br>');

  async function reviewDialog(id) {
    let p = await api(`${E}/sessions/${id}/proposal`);
    const modal = $('#modal');
    const el = h('<div class="dialog learn-dialog vf-review" role="dialog" aria-modal="true" aria-labelledby="vfReviewTitle"></div>');
    modal.replaceChildren(el);
    modal.hidden = false;
    const close = () => { modal.hidden = true; };
    el.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    const errorBox = () => $('.learn-error', el);

    const rebase = async () => {
      const latest = await api(`${E}/sessions/${id}`);
      await post(`${E}/sessions/${id}/rebase`, { revision: latest.revision });
      p = await api(`${E}/sessions/${id}/proposal`);
      render();
      toast('Draft rebased onto the current skill. Check it, then save.');
    };

    const render = () => {
      const picked = choiceMap(id, p.token), next = nextNumber();
      const select = (item) => {
        const choice = picked.get(item.id) === 'discard' ? 'discard' : 'keep';
        const opts = item.change === 'removed'
          ? [['keep', 'Remove this rule'], ['discard', 'Keep the rule (discard the removal)']]
          : [['keep', 'Keep'], ['edit', 'Keep with my edits'], ['discard', 'Discard this change']];
        return `<label>Decision<select>${opts.map(([value, label]) => `<option value="${value}"${value === choice ? ' selected' : ''}>${label}</option>`).join('')}</select></label>`;
      };
      const ruleCard = (r) => `<article class="learn-rule" data-review="${esc(r.id)}" data-kind="rule">
          <div class="vf-review-head"><b>${esc(areaName(r.area))}</b><span class="vf-tag ${r.change}">${r.change === 'new' ? 'New' : 'Changed'}</span><span class="badge">${esc(r.confidence)} confidence</span></div>
          ${r.previous ? `<p class="sub">Was: <s>${esc(r.previous.text)}</s></p>` : ''}
          <textarea rows="3" aria-label="Rule text">${esc(r.text)}</textarea>
          <p class="sub">${evidenceText(r.evidence)}</p>
          ${select(r)}
        </article>`;
      const removalCard = (r) => `<article class="learn-rule" data-review="${esc(r.id)}" data-kind="removal">
          <div class="vf-review-head"><b>${esc(areaName(r.area))}</b><span class="vf-tag removed">Removed</span></div>
          <p><s>${esc(r.text)}</s></p>
          <p class="sub">${evidenceText(r.evidence)}</p>
          ${select(r)}
        </article>`;
      const fileCard = (x) => {
        const choice = picked.get(`file:${x.path}`) === 'discard' ? 'discard' : 'keep';
        const opts = x.change === 'removed'
          ? [['keep', 'Remove this file'], ['discard', 'Keep the file (discard the removal)']]
          : [['keep', x.change === 'changed' ? 'Replace the saved file' : 'Add this file'], ['discard', 'Discard this file']];
        const label = x.kind === 'knowledge' ? (x.title || x.name) : x.name;
        const open = x.change !== 'removed' ? ` · <a target="_blank" rel="noopener" href="${E}/sessions/${id}/asset?file=${encodeURIComponent(x.file)}">Open</a>` : '';
        return `<article class="learn-rule" data-review-file="${esc(x.path)}">
          <div class="vf-review-head"><b>${x.kind === 'knowledge' ? 'Knowledge' : 'Asset'}</b><span class="vf-tag ${x.change}">${x.change === 'new' ? 'New' : x.change === 'changed' ? 'Changed' : 'Removed'}</span></div>
          <p>${x.change === 'removed' ? `<s>${esc(label)}</s>` : esc(label)} <span class="sub">${esc(x.path)} · ${esc(fileSize(x.size))}${open}</span></p>
          ${x.note ? `<p class="sub">${esc(x.note)}</p>` : ''}
          <label>Decision<select>${opts.map(([value, text]) => `<option value="${value}"${value === choice ? ' selected' : ''}>${text}</option>`).join('')}</select></label>
        </article>`;
      };
      el.innerHTML = `<h2 id="vfReviewTitle">Review and save as v${next}</h2>
        <p class="sub">Every change needs a decision. Saving makes v${next} the skill new videos use; videos already made keep their version.</p>
        ${p.stale ? `<div class="notice">This draft started from v${p.baseNumber || '—'}, but the format's skill changed since (now v${versionNumber(p.activeVersion) || '—'}). Rebase it onto the current version, check it, then save. ${button('Rebase draft', 'rebase', 'small')}</div>` : ''}
        ${p.rules.map(ruleCard).join('')}
        ${p.removals.map(removalCard).join('')}
        ${[...p.files.added, ...p.files.removed].map(fileCard).join('')}
        ${p.learnings.length ? `<details open><summary>Insights saved with it (${p.learnings.length})</summary><ul>${p.learnings.map((l) => `<li>${esc(l.text)}</li>`).join('')}</ul></details>` : ''}
        <details${p.workflowChanged || !p.baseVersion ? ' open' : ''}><summary>Workflow${p.baseVersion && !p.workflowChanged ? ' (unchanged)' : ''}</summary><pre>${esc(p.workflow)}</pre></details>
        <p class="sub">After saving, the skill holds ${p.files.count} of ${MAX_FILES} files (${esc(fileSize(p.files.bytes) || '0 bytes')}).</p>
        <label class="learn-check"><input type="checkbox" id="learnReviewed">I reviewed every change, the workflow and the files.</label>
        <p class="learn-error" role="alert"></p>
        <div class="learn-actions"><button type="button" class="btn" data-close>Cancel</button>${button(`Save as v${next}`, 'approve', 'primary')}</div>`;
      el.querySelectorAll('[data-review][data-kind=rule] textarea').forEach((t) => {
        t.oninput = () => { t.closest('article').querySelector('select').value = 'edit'; };
      });
      $('[data-close]', el).onclick = close;
      const rebaseButton = $('[data-action=rebase]', el);
      if (rebaseButton) rebaseButton.onclick = run(async () => { try { await rebase(); } catch (e) { errorBox().textContent = e.message; } });
      $('[data-action=approve]', el).onclick = run(approve);
      el.querySelector('select, textarea, button')?.focus();
    };

    const approve = async () => {
      errorBox().textContent = '';
      if (!$('#learnReviewed', el).checked) throw Error('Review the complete draft before saving.');
      const decisions = [...el.querySelectorAll('[data-review]')].map((card) => {
        const action = $('select', card).value;
        return card.dataset.kind === 'rule' ? { id: card.dataset.review, action, text: $('textarea', card).value } : { id: card.dataset.review, action };
      });
      let v;
      try {
        const fileDecisions = [...el.querySelectorAll('[data-review-file]')].map((card) => ({ path: card.dataset.reviewFile, action: $('select', card).value }));
        v = await post(`${E}/sessions/${id}/approve`, { revision: p.revision, token: p.token, decisions, fileDecisions });
      } catch (e) {
        if (e.status !== 409) { errorBox().textContent = e.message; return; }
        errorBox().innerHTML = `${esc(e.message)} ${button('Rebase draft', 'rebase409', 'small')}`;
        $('[data-action=rebase409]', el).onclick = run(async () => { try { await rebase(); } catch (err) { errorBox().textContent = err.message; } });
        return;
      }
      close();
      toast(v.warning || `Saved as ${TERMS.skill.toLowerCase()} v${v.number}. Videos already made keep their version.`);
      await paint();
    };
    render();
  }

  // ---- Dialogs ----

  function newChannel() {
    dialog('New channel', '<p class="sub">A YouTube channel, brand or series. Add its video formats next; each one learns its own skill.</p>' + field('Channel name', 'name', '', 'input', 'My main YouTube channel'), async (b) => {
      const p = await api(`${E}/profiles`, b);
      pid = p.id; fid = null; sid = null; talking = false;
      await paint();
    }, 'Create channel');
  }

  function renameChannel(p) {
    dialog('Rename channel', field('Channel name', 'name', p.name) + '<p class="sub">Existing videos keep the names they were made with.</p>', async (b) => {
      warn(await api(`${E}/profiles/${p.id}/update`, { expected: p.revision || 1, name: b.name }));
      await paint();
    }, 'Rename');
  }

  async function archiveChannel(p, archive) {
    if (archive && !await confirmBox({ title: `Archive ${p.name}?`, text: 'The channel and its formats are hidden from Video formats and New video. Nothing is deleted, existing videos are untouched, and you can restore it with Show archived.', ok: 'Archive channel' })) return;
    warn(await api(`${E}/profiles/${p.id}/${archive ? 'archive' : 'unarchive'}`, { expected: p.revision || 1 }), archive ? `${p.name} archived.` : `${p.name} restored.`);
    if (archive && p.id === pid) { pid = null; fid = null; sid = null; talking = false; }
    await paint();
  }

  function newFormat() {
    const choicesList = data.profiles.filter((p) => !p.archived);
    if (!choicesList.length) return newChannel();
    const el = dialog('New format', `<label>${TERMS.channel}<select name="profileId">${options(choicesList, pid)}</select></label><p class="sub">Choose a starting setup and give your format a name. It is ready for New video as soon as you save. Teaching it a skill is optional.</p><label>Video setup<select name="type">${options(videoSetups, 'tutorial')}</select></label><p class="sub" id="formatSetupHint"></p>` + field('Your format name', 'name', '', 'input', 'Long-form explainers with me on camera') + '<p class="sub">This is your own name, not another preset. You can create several formats with the same video setup and teach each one a different skill.</p><label>Target length in seconds (optional)<input name="targetSeconds" type="number" min="0" max="7200" placeholder="e.g. 600 for a 10-minute video"></label>', async (b) => {
      const x = await api(`${E}/formats`, b);
      pid = b.profileId; fid = x.id; sid = null; talking = false; tab = 'skill';
      await paint();
      toast('Format saved. You can use it in New video now.');
    }, 'Create format');
    const change = () => {
      const x = videoSetups.find((s) => s.id === $('[name=type]', el).value);
      $('#formatSetupHint', el).textContent = x.hint;
      $('[name=name]', el).placeholder = x.example;
    };
    $('[name=type]', el).onchange = change;
    change();
  }

  function editFormat() {
    const f = view.format;
    dialog('Edit format', field('Format name', 'name', f.name) + `<label>Video setup<select name="type">${options(videoSetups, f.type)}</select></label><label>Target length in seconds (optional)<input name="targetSeconds" type="number" min="0" max="7200" value="${f.targetSeconds || ''}" placeholder="e.g. 30 for a reel"></label><p class="sub">Setup and target length apply to future videos. Videos already made keep theirs, and saved skill versions don't change.</p>`, async (b) => {
      const body = { expected: f.revision || 1 };
      if (b.name !== f.name) body.name = b.name;
      if (b.type !== f.type) body.type = b.type;
      if ((Number(b.targetSeconds) || 0) !== (f.targetSeconds || 0)) body.targetSeconds = Number(b.targetSeconds) || 0;
      if (Object.keys(body).length === 1) return;
      warn(await api(`${E}/formats/${f.id}/update`, body), 'Saved. It applies to future videos.');
      await paint();
    });
  }

  async function archiveFormat(archive) {
    const f = view.format;
    if (archive && !await confirmBox({ title: `Archive ${f.name}?`, text: 'It is hidden from Video formats and New video, and its generated skill is unpublished. Nothing is deleted, existing videos are untouched, and you can restore it with Show archived.', ok: 'Archive format' })) return;
    warn(await api(`${E}/formats/${f.id}/${archive ? 'archive' : 'unarchive'}`, { expected: f.revision || 1 }), archive ? `${f.name} archived.` : `${f.name} restored.`);
    if (archive) { fid = null; sid = null; talking = false; }
    await paint();
  }

  // The conversation a direct edit should join: the visible draft when it is based on the current skill.
  function draftTarget() {
    const candidates = [view.draft?.session, talking && sid ? conversation(sid) : null].filter(Boolean);
    return candidates.find((s) => s.baseVersion === view.format.activeVersion && !['running', 'approved', 'cancelled'].includes(s.status)) || null;
  }

  function ruleDialog(ruleId) {
    const f = view.format;
    const saved = (view.active?.rules || []).find((r) => r.id === ruleId) || null;
    const drafted = (view.draft?.proposal?.rules || []).find((r) => r.id === ruleId) || null;
    const rule = drafted || saved;
    const el = dialog(rule ? 'Edit rule' : 'Add a rule', `<p class="sub">Your edit goes into a draft. Review and save it as a new skill version; videos already made keep theirs.</p>
      <label>Area<select name="area">${options(AREAS, rule?.area || 'visuals')}</select></label>
      <label>Rule<textarea name="text" rows="4">${esc(rule?.text || '')}</textarea></label>
      ${saved ? '<label class="learn-check"><input type="checkbox" name="remove">Remove this rule from the skill</label>' : ''}`, async (b) => {
      const remove = b.remove === 'on';
      const text = String(b.text || '').trim();
      if (!remove && !text) throw Error('Write the rule first.');
      if (!remove && rule && text === rule.text && b.area === rule.area) throw Error('Nothing changed.');
      const body = remove ? { ruleId: rule.id, remove: true } : { area: b.area, text, ...(rule ? { ruleId: rule.id } : {}) };
      const target = draftTarget();
      if (target) { body.sessionId = target.id; body.revision = target.revision; }
      const res = await api(`${E}/formats/${f.id}/draft-rule`, body);
      sid = res.session.id;
      await paint();
      toast(res.proposalError ? `Added to the draft, but it needs attention: ${res.proposalError}` : `Added to the draft in “${res.session.name}”. Review and save it when ready.`);
    }, 'Add to draft');
    const remove = $('[name=remove]', el);
    if (remove) remove.onchange = () => { $('[name=text]', el).disabled = remove.checked; $('[name=area]', el).disabled = remove.checked; };
  }

  async function newConversation() {
    const f = view.format;
    const s = await api(`${E}/sessions`, { formatId: f.id, name: `${TERMS.conversation} ${view.conversations.length + 1}` });
    if (legacyStyle) {
      const res = await fetch(`/api/library/file?f=${encodeURIComponent('styles/' + legacyStyle + '.md')}`);
      if (!res.ok) throw Error('Could not read the legacy style. The new conversation was kept.');
      const note = await res.text();
      await api(`${E}/sessions/${s.id}/references`, { revision: s.revision, kind: 'note', name: `Legacy style: ${legacyStyle}`.slice(0, 200), note });
      legacyStyle = null;
    }
    sid = s.id;
    talking = true;
    await paint();
    revealPanel();
    $('#input', root)?.focus({ preventScroll: true });
  }

  async function readVersion(id, el) {
    const body = $('.vf-version-body', el.closest('.vf-version'));
    if (!body.hidden) { body.hidden = true; return; }
    const v = await api(`${E}/versions/${id}`);
    const changes = v.changes ? [plural(v.changes.new.length, 'new rule'), plural(v.changes.changed.length, 'change'), plural(v.changes.removed.length, 'removal')].join(' · ') : '';
    const groups = AREAS.map((a) => [a, v.rules.filter((r) => r.area === a.id)]).filter(([, rules]) => rules.length);
    body.innerHTML = `${changes ? `<p class="sub">${changes}</p>` : ''}
      ${groups.map(([a, rules]) => `<h3 class="vf-area-name">${esc(a.name)}</h3><ul>${rules.map((r) => `<li>${esc(r.text)}</li>`).join('')}</ul>`).join('')}
      ${v.learnings?.length ? `<h3 class="vf-area-name">Insights</h3><ul>${v.learnings.map((l) => `<li>${esc(l.text)}</li>`).join('')}</ul>` : ''}
      <details><summary>Workflow</summary><pre>${esc(v.workflow)}</pre></details>`;
    body.hidden = false;
  }

  function formatMenuItems() {
    const f = view.format, archived = f.archived;
    return [
      { label: `Copy an approved format into ${view.profile.name}`, run: () => reuseFormat() },
      ...(view.active ? [{ label: 'Start with an idea or script', run: () => projectDialog(view.active.id) }] : []),
      { label: 'Personal skills for this format', run: () => chooseSkills() },
      '-',
      archived ? { label: 'Restore format', run: () => archiveFormat(false) } : { label: 'Archive format', danger: true, run: () => archiveFormat(true) },
      { label: 'Back up local database', run: async () => { const x = await api(`${E}/backup`, {}); toast(`Recovery backup saved: ${x.path}`); } },
    ];
  }

  function channelMenuItems(p) {
    return [
      { label: 'Rename channel', run: () => renameChannel(p) },
      { label: 'Brand, voice and colours', href: '#/settings/brand' },
      '-',
      p.archived ? { label: 'Restore channel', run: () => archiveChannel(p, false) } : { label: 'Archive channel', danger: true, run: () => archiveChannel(p, true) },
    ];
  }

  async function chooseSkills() {
    const f = view.format;
    const inv = await api(`${E}/skills`);
    const list = inv.items.filter((s) => s.kind === 'personal' && !s.name.startsWith('learned-') && !s.disabled && s.published && !s.compatibilityBlocked);
    dialog('Personal skills for this format', `<p>Enabled core workflows and this format's own skill are included automatically. Personal skills belong to your studio and can be selected in formats of any channel.</p>${list.map((s) => `<label class="learn-check"><input type="checkbox" name="skill-${s.id}"${f.skillIds?.includes(s.id) ? ' checked' : ''}>${esc(s.name)} — ${esc(s.summary || '')}</label>`).join('') || '<p>No enabled personal workflows available.</p>'}`, async (b) => {
      await api(`/api/profiles/${pid}/skills`, { formatId: f.id, ids: Object.keys(b).filter((k) => k.startsWith('skill-')).map((k) => k.slice(6)), expected: f.skillIds || [] });
      await paint();
    });
  }

  // On narrow screens the panel sits below the format home: bring it into view when it opens.
  function revealPanel() {
    if (!talking || !matchMedia('(max-width: 980px)').matches) return;
    $('#vfChat', root)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- Events: one delegated handler, so repainting part of the page never loses its bindings. ----

  const actions = {
    channel: () => newChannel(),
    format: () => newFormat(),
    unarchiveChannel: () => archiveChannel(view.profile, false),
    unarchiveFormat: () => archiveFormat(false),
    editFormat: () => editFormat(),
    newVideo: () => startVideo(view.format),
    formatMenu: (el) => showMenu(el, formatMenuItems()),
    talk: async () => { talking = !talking; if (!talking) sid = null; await paint(); revealPanel(); },
    closePanel: async () => { talking = false; sid = null; await paint(); },
    openDraft: async () => { sid = view.draft.session.id; talking = true; await paint(); revealPanel(); },
    openConversation: async (el, id) => { sid = id; talking = true; await paint(); revealPanel(); },
    addRule: () => ruleDialog(null),
    addFiles: () => addFilesDialog(),
    addFilesHere: () => addFilesDialog(sid),
    rebaseDraft: async () => {
      const s = await api(`${E}/sessions/${view.draft.session.id}`);
      await post(`${E}/sessions/${s.id}/rebase`, { revision: s.revision });
      await paint();
    },
    rebasePanel: async () => {
      const s = await api(`${E}/sessions/${sid}`);
      await post(`${E}/sessions/${sid}/rebase`, { revision: s.revision });
      await paint();
    },
    restoreActive: async () => { await api(`${E}/versions/${view.format.activeVersion}/regenerate`, {}); await paint(); },
    revealSkill: async () => { await api(`${E}/formats/${fid}/reveal-skill`, {}); },
    rebuildSkill: async () => { const x = await api(`${E}/formats/${fid}/skill`, {}); warn(x, 'Skill folder rebuilt.'); await paint(); },
    readVersion: (el, id) => readVersion(id, el),
    versionProject: (el, id) => projectDialog(id),
    activateVersion: async (el, id) => {
      warn(await api(`${E}/formats/${fid}/activate`, { versionId: id, expected: view.format.activeVersion }), `v${versionNumber(id)} is now active for future videos.`);
      await paint();
    },
    regenerateVersion: async (el, id) => { await api(`${E}/versions/${id}/regenerate`, {}); toast('Restored from SQLite. Any edited files were kept separately.'); await paint(); },
    newConversation: () => newConversation(),
    review: () => reviewDialog(sid),
    attach: () => $('#learnUpload', root)?.click(),
    studySettings: (el) => { const box = $('#vfSettings', root); box.hidden = !box.hidden; el.setAttribute('aria-expanded', String(!box.hidden)); },
    study: async () => {
      const id = sid;
      await intake(id, async () => {
        const latest = await saveSettings(id);
        await api(`${E}/sessions/${id}/run`, { revision: latest.revision });
        status('');
        toast('Study started. Follow progress and answer permission requests in the chat.');
      });
    },
    note: () => {
      const id = sid;
      dialog('Written example', field('Label', 'name') + field('Notes or project observations', 'note', '', 'textarea'), async (b) => {
        await intake(id, async () => {
          const latest = await api(`${E}/sessions/${id}`);
          await api(`${E}/sessions/${id}/references`, { ...b, kind: 'note', revision: latest.revision });
        });
      }, 'Add example');
    },
    extract: async () => { await saveSettings(sid); const x = await api(`${E}/sessions/${sid}/extract`, {}); toast(`Extraction ${x.status}. Resume reuses completed references; coverage is saved for the agent.`); },
    extraction: async () => { const x = await api(`${E}/sessions/${sid}/extraction`); toast(`${x.status}: ${x.completed || 0}/${x.total || 0} videos. ${x.error || ''}`); },
    'extract-stop': async () => { await api(`${E}/sessions/${sid}/extract-stop`, {}); toast('Stopping extraction. Completed references are kept.'); },
    closeConversation: async () => {
      if (!await confirmBox({ title: 'Close this conversation?', text: 'Any running study stops. Its examples, chat and drafts stay on disk, and saved versions are not affected.', ok: 'Close conversation' })) return;
      const latest = await api(`${E}/sessions/${sid}`);
      await api(`${E}/sessions/${sid}/cancel`, { revision: latest.revision });
      settings.delete(sid);
      sid = null;
      await paint();
    },
  };

  root.onclick = async (e) => {
    const el = e.target.closest('[data-action],[data-profile],[data-format],[data-tab],[data-channel-menu],[data-edit-rule],[data-choice],[data-remove-reference],[data-file-kind],[data-file-reveal],[data-file-remove],[data-file-unstage]');
    if (!el || !root.contains(el) || el.disabled) return;
    const busy = (fn) => run(fn)({ currentTarget: el });
    if (el.dataset.action) {
      const [name, arg] = el.dataset.action.split(':');
      const fn = actions[name];
      if (!fn) return;
      // Menus and toggles stay clickable; everything else is disabled while it runs.
      if (['formatMenu', 'studySettings', 'attach'].includes(name)) { try { await fn(el, arg); } catch (err) { toast(err.message); } return; }
      await busy(() => fn(el, arg));
      return;
    }
    if (el.dataset.profile) {
      if (el.dataset.profile === pid) return;
      pid = el.dataset.profile; fid = null; sid = null;
      await busy(paint);
      return;
    }
    if (el.dataset.format) {
      if (el.dataset.format === fid) return;
      fid = el.dataset.format; sid = null;
      await busy(paint);
      return;
    }
    if (el.dataset.tab) {
      tab = el.dataset.tab;
      paintHome();
      $(`[data-tab="${tab}"]`, root)?.focus();
      return;
    }
    if (el.dataset.channelMenu) {
      const p = data.profiles.find((x) => x.id === el.dataset.channelMenu);
      if (p) showMenu(el, channelMenuItems(p));
      return;
    }
    if (el.dataset.editRule) { ruleDialog(el.dataset.editRule); return; }
    if (el.dataset.fileKind) { fileKind = el.dataset.fileKind; paintHome(); return; }
    if (el.dataset.fileReveal) { await busy(() => api(`${E}/formats/${fid}/reveal-file`, { path: el.dataset.fileReveal })); return; }
    if (el.dataset.fileRemove) { await busy(() => fileChange('remove', el.dataset.fileRemove)); return; }
    if (el.dataset.fileUnstage) { await busy(() => fileChange('unstage', el.dataset.fileUnstage)); return; }
    if (el.dataset.choice) {
      const d = view.panel?.proposal ? view.panel : view.draft;
      if (!d) return;
      choiceMap(d.session.id, d.proposal.token).set(el.dataset.rule, el.dataset.choice);
      paintDraft();
      if (tab === 'skill' || tab === 'files') paintHome();
      return;
    }
    if (el.dataset.removeReference) {
      const id = sid;
      await busy(() => intake(id, async () => {
        const latest = await api(`${E}/sessions/${id}`);
        await api(`${E}/sessions/${id}/remove-reference`, { revision: latest.revision, referenceId: el.dataset.removeReference });
      }));
    }
  };

  root.onchange = async (e) => {
    const el = e.target;
    if (el.matches('[data-show-archived]')) {
      showArchived = el.checked;
      await run(paint)();
    } else if (el.matches('[data-channel-select]')) {
      if (el.value === '__new') { el.value = pid || ''; newChannel(); return; }
      pid = el.value; fid = null; sid = null;
      await run(paint)();
    } else if (el.matches('[data-conversation]')) {
      sid = el.value || null;
      await run(paint)();
    }
  };

  root.oninput = (e) => {
    if (!e.target.matches('[data-search]')) return;
    search = e.target.value;
    applySearch();
  };

  // Arrow keys move between tabs, as in other tab lists.
  root.onkeydown = (e) => {
    const current = e.target.closest?.('[role=tab]');
    if (!current || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const i = TABS.indexOf(current.dataset.tab) + (e.key === 'ArrowRight' ? 1 : -1);
    tab = TABS[(i + TABS.length) % TABS.length];
    paintHome();
    $(`[data-tab="${tab}"]`, root)?.focus();
  };

 async function reuseFormat(){
  if(!pid)throw Error('Create the destination profile first.');
  const choices=data.formats.filter(f=>f.activeVersion);
  if(!choices.length)throw Error('Approve a learned format first, then copy it here. Personal skills can already be reused through Format skills.');
  const target=data.profiles.find(p=>p.id===pid);let reviewed=null,request=0;
  const el=dialog('Copy an existing format',`<p>Make an independent format in <b>${esc(target.name)}</b>. Later changes to the copy won't change the original.</p><label>Approved format to copy<select name="source">${options(choices.map(f=>({id:f.id,name:`${data.profiles.find(p=>p.id===f.profileId)?.name} / ${f.name}`})),choices[0].id)}</select></label>`+field('Name of the new format','name',choices[0].name)+`<div id="reusePreview" class="sub">Loading the approved guide…</div><p class="sub">Copies the guide, workflow, reusable assets and personal-skill selections. Profile brand settings and earlier sessions stay with the original profile. Review the copied content for channel-specific wording or logos.</p><label class="learn-check"><input name="reviewed" type="checkbox" required>I reviewed this guide for the destination profile.</label>`,async b=>{
   if(!reviewed||reviewed.formatId!==b.source)throw Error('Wait for the selected guide to load.');
   const copy=await api(`${E}/formats/${b.source}/copy`,{profileId:pid,name:b.name,expected:reviewed.id,reviewed:b.reviewed==='on'});fid=copy.id;sid=null;await paint();if(copy.warning)toast(copy.warning);
  },'Copy format');
  const load=async()=>{const token=++request;reviewed=null;$('[name=reviewed]',el).checked=false;const f=choices.find(x=>x.id===$('[name=source]',el).value);$('[name=name]',el).value=f.name;$('#reusePreview',el).textContent='Loading the approved guide…';try{const v=await api(`${E}/versions/${f.activeVersion}`);if(token!==request)return;reviewed=v;$('#reusePreview',el).replaceChildren(h(`<div><p><b>${esc(f.name)} · approved v${v.number}</b> · ${esc(videoSetups.find(x=>x.id===f.type)?.name||f.type)}</p><details open><summary>Rules and workflow</summary><pre>${esc(v.rules.map(r=>`${r.area}: ${r.text}`).join('\n\n')+'\n\n'+v.workflow)}</pre></details><p>Reusable assets: ${v.assets.map(a=>esc(a.file)+' — '+esc(a.note)).join('; ')||'None'}</p></div>`));}catch(e){if(token===request)$('#reusePreview',el).textContent=e.message;}};
  $('[name=source]',el).onchange=load;await load();
 }
 function projectDialog(versionId){dialog('Start a project',field('Project name','name')+'<label>Start with<select name="entry"><option value="idea">An idea</option><option value="script">A script</option><option value="footage">Existing footage / narration</option></select></label>'+field('Idea, direction or script','brief','','textarea')+'<label>Build preference<select name="build"><option value="scene">Scene by scene</option><option value="full">Full build, with approval checkpoints</option></select></label><p class="sub">The project keeps this version. You can record or import footage in the editor.</p>',async b=>{const p=await api(`${E}/projects`,{...b,versionId});location.hash=`#/p/${encodeURIComponent(p.id)}`;});}

  await paint();
  return { teardown() { live = false; closeMenu(); cleanup(); } };
}


// A generated format skill, read-only: edits go through the format's reviewed drafts.
function readOnlySkill(x){
 const modal=$('#modal');
 const el=h(`<div class="dialog learn-dialog" role="dialog" aria-modal="true" aria-label="${esc(x.name)}"><h2>${esc(x.name)} · generated</h2><p class="sub">Generated from the format's active skill version. To change it, open the format in ${TERMS.formats} and talk to it, or edit a rule; every change is reviewed and saved as a new version.</p><pre>${esc(x.text)}</pre><div class="learn-actions"><button type="button" class="btn" data-close>Close</button></div></div>`);
 modal.replaceChildren(el);modal.hidden=false;
 const close=()=>{modal.hidden=true;};
 $('[data-close]',el).onclick=close;el.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();close();}};$('[data-close]',el).focus();
}
export async function renderSkillDatabase(root){
 const data=await api(`${E}/skills`);
 root.innerHTML=`<div class="home-wrap wide learn-page"><div class="home-head"><div><h1>Skills</h1><p class="sub">Stored and versioned in local SQLite. Core updates keep your personal versions.</p></div>${button('+ Personal skill','create')}${button('Import from GitHub','import')}${button('Refresh / import file edits','refresh')}${button('Rebuild agent files','regenerate')}</div><div class="learn-toolbar"><label>Show<select id="skillKind"><option value="all">All skills</option><option value="core">Core</option><option value="customized-core">Customized core</option><option value="personal">Personal</option><option value="format">Format skills</option></select></label><a class="btn" href="#/settings/updates">Update & compatibility review</a></div><p class="learn-error">${esc(data.error||'')}</p><div class="skill-grid" id="skillRows"></div><details><summary>Database version history</summary><div id="skillHistory"></div></details></div>`;
 const run=fn=>async()=>{try{await fn();}catch(e){toast(e.message);}};
 // Format skills are generated from a format's active version: read them here, change them in Video formats.
 const formatCard=s=>`<article class="skill-card"><span class="badge">${esc(kindLabel(s.kind))}</span><b>${esc(s.label||('/'+s.name))}</b><span class="sub">Generated from ${TERMS.formats} · /${esc(s.name)}</span><p class="skill-explanation">${esc(s.summary||'The rules and workflow of this format’s active skill version. Change it by talking to the format.')}</p>${s.reason?`<p class="sub">${esc(s.reason)}</p>`:''}<div class="learn-actions">${button('Read','read-'+s.id)}${s.formatId?`<a class="btn" href="#/learning?format=${encodeURIComponent(s.formatId)}">Open format</a>`:''}</div></article>`;
 const card=s=>s.kind==='format'?formatCard(s):`<article class="skill-card"><span class="badge">${esc(kindLabel(s.kind))}</span><b>${esc(s.label||('/'+s.name))}</b><span class="sub">${s.activeVersion?'v'+esc(s.activeVersion):'Personal version'} · ${s.disabled?'Disabled':'Enabled'}</span><p class="skill-explanation">${esc(s.summary||'Open Read / edit to inspect this skill and add a short explanation.')}</p>${s.reason?`<p class="sub">${esc(s.reason)}</p>`:''}${button('Read / edit','edit-'+s.id)}${button(s.disabled?'Enable':'Disable','toggle-'+s.id)}</article>`;
 const rows=()=>{
  const kind=$('#skillKind',root).value;
  $('#skillRows',root).innerHTML=(data.items||[]).filter(s=>kind==='all'||s.kind===kind).map(card).join('');
  root.querySelectorAll('[data-action^=read-]').forEach(b=>b.onclick=run(async()=>{const x=await api(`${E}/skills/${b.dataset.action.slice(5)}`);readOnlySkill(x);}));
 root.querySelectorAll('[data-action^=edit-]').forEach(b=>b.onclick=run(async()=>{const id=b.dataset.action.slice(5),x=await api(`${E}/skills/${id}`);dialog(`${x.name} · ${x.kind}`,`<p class="sub">${x.kind==='core'?'Changing the workflow creates your own customized core version. Editing only the explanation keeps it Core.':x.name.startsWith('learned-')?'This edits the reusable skill copy. Pinned projects retain their approved snapshot. To change approved rules, talk to the format in Video formats.':'Saving creates a database revision.'}</p>`+field('Short explanation (shown on the card)','summary',x.summary)+field('Skill Markdown','text',x.text,'textarea'),async form=>{await api(`${E}/skills/${id}`,{action:form.text===x.text?'describe':'edit',text:form.text,summary:form.summary,revision:x.revision});await renderSkillDatabase(root);});}));
 root.querySelectorAll('[data-action^=toggle-]').forEach(b=>b.onclick=run(async()=>{const id=b.dataset.action.slice(7),s=data.items.find(x=>x.id===id);await api(`${E}/skills/${id}`,{action:s.disabled?'enable':'disable',revision:data.revision});await renderSkillDatabase(root);}));};rows();$('#skillKind',root).onchange=rows;
  $('[data-action=import]',root).onclick=()=>addSkillsDialog({onDone:()=>renderSkillDatabase(root)});
 $('[data-action=create]',root).onclick=()=>dialog('New personal skill',field('Short explanation (shown on the card)','summary')+field('Skill Markdown','text','---\nname: my-workflow\ndescription: Describe when this skill should be used.\n---\n\n# Workflow\n','textarea'),async b=>{await api(`${E}/skills`,{action:'create',text:b.text,summary:b.summary,revision:data.revision});await renderSkillDatabase(root);});
 for(const a of ['refresh','regenerate'])$(`[data-action=${a}]`,root).onclick=run(async()=>{await api(`${E}/skills`,{action:a,revision:data.revision});await renderSkillDatabase(root);});
 for(const v of data.history||[]){const row=h(`<p><span>${esc(v.created)} · ${esc(v.reason)}</span> <button class="btn small">Restore this version</button></p>`);$('#skillHistory',root).append(row);$('button',row).onclick=run(async()=>{if(!await confirmBox({title:'Restore skill version?',text:'Current skills stay in database history. This older version will be held until you resume updates.',ok:'Restore'}))return;await api(`${E}/skills`,{action:'restore-sql',snapshot:v.id,revision:data.revision});await renderSkillDatabase(root);});}
}

export async function projectLearningPanel(root,id,meta,{send}={}){
 const holder=h('<details class="project-learning"><summary>Script & approved guide</summary><div class="project-learning-body"></div></details>');root.append(holder);if(meta.learning?.entry!=='footage'&&meta.learning)holder.open=true;const el=$('.project-learning-body',holder);
 await projectProfilePanel(root,id);
 await loadScript(id);if(!holder.isConnected)return;const sc=h('<div></div>');el.append(sc);scriptCard(sc,id);
 if(!meta.learning){el.append(h('<p class="sub">Choose an approved guide in New video to pin it to your project.</p>'));return;}
 const v=await api(`${E}/versions/${meta.learning.versionId}`);
 el.prepend(h(`<p><b>${esc(v.name)} · v${v.number}</b> · pinned for this project</p><p class="sub">${esc(meta.learning.entry)} · ${esc(meta.learning.build==='full'?'Full build with checkpoints':'Scene by scene')}</p>`));
 const actions=h(`<div class="learn-actions">${button('Develop script','script')}${button('Review scene plan','plan')}${button('Study this project','recap')}${button('Review version upgrade','upgrade')}</div>`);el.append(actions);
 $('[data-action=script]',actions).onclick=()=>send?.('Develop or revise script.md using this project’s pinned format skill, direction and target duration. Show the script for review before recording or building. Preserve any existing draft until changes are agreed.');
 $('[data-action=plan]',actions).onclick=async()=>{try{const p=await api(`${E}/projects/${id}/plan-review`,{});dialog('Approve scene plan',`<p>Review the scene plan and timing. Approval applies to this exact plan, cut and guide version.</p><pre>${esc(JSON.stringify(p.plan,null,2))}</pre>`,async()=>{await api(`${E}/projects/${id}/approve-plan`,{token:p.token});toast('Scene plan approved. You can start the build.');});}catch(e){toast(e.message);}};
 $('[data-action=recap]',actions).onclick=()=>dialog('Study this project',field('What worked, what changed and why','note','','textarea'),async b=>{const s=await api(`${E}/projects/${id}/recap`,b);location.hash=`#/learning?session=${s.id}`;});
 $('[data-action=upgrade]',actions).onclick=async()=>{try{const all=await api(E),f=all.formats.find(f=>f.id===meta.learning.formatId);if(f.activeVersion===v.id){toast('This project already uses the active version.');return;}const diff=await api(`${E}/projects/${id}/upgrade-preview`,{versionId:f.activeVersion});dialog('Review format upgrade',`<h3>Current rules</h3><pre>${esc(diff.oldRules.map(r=>r.text).join('\n\n'))}</pre><h3>New rules</h3><pre>${esc(diff.newRules.map(r=>r.text).join('\n\n'))}</pre>${diff.notices?.length?`<div class="notice">${diff.notices.map(n=>`<p>${esc(n)}</p>`).join('')}</div>`:''}<p>Existing cuts, graphics and overrides stay as they are. Ask the agent to review changes before rebuilding.</p>`,async()=>{await api(`${E}/projects/${id}/upgrade`,{versionId:diff.to,expected:diff.from});location.reload();});}catch(e){toast(e.message);}};
}

// Storage: database backups and restore, plus the skill file store (size, unused files, backup to another folder).
export async function renderDatabaseRecovery(root) {
  const [backups, files] = await Promise.all([
    api(`${E}/backups`),
    api(`${E}/files`).catch((e) => ({ error: e.message })),
  ]);
  const size = (n) => n >= 1024 ** 3 ? `${Math.round((n / 1024 ** 3) * 10) / 10} GB` : n >= 1024 ** 2 ? `${Math.round((n / 1024 ** 2) * 10) / 10} MB` : `${Math.max(0, Math.round((n || 0) / 1024))} KB`;
  const unused = files.unused || [];
  const missing = files.missing || [];
  root.innerHTML = `<div class="home-wrap learn-page storage-page">
    <h1>Local database recovery</h1>
    <p>Skills, approved guides, sound catalog metadata and their relationships are stored in SQLite. A backup includes their saved content. Skill files (assets, knowledge and key frames) are kept in the file store below and need their own backup, as do large media and draft intake.</p>
    ${button('Create database backup', 'backup')}
    <div id="dbBackups"></div>
    <p class="sub">A full restore preserves the displaced database and refuses backups that would break a current project’s version pin. Skill files a restored version needs but the file store lacks are listed, not fatal. For ordinary changes, use skill history or format history instead.</p>
    <section class="vf-card storage-files" aria-labelledby="storageFilesTitle">
      <h2 id="storageFilesTitle">Skill files</h2>
      ${files.error ? `<p class="notice">${esc(files.error)}</p>` : `
      <p>${files.objects} stored file${files.objects === 1 ? '' : 's'} · ${size(files.bytes)}. Each identical file is stored once in <code>${esc(files.root)}</code>. Skill folders hold copy-on-write clones of these files.</p>
      ${missing.length ? `<div class="notice"><b>${missing.length} file${missing.length === 1 ? ' is' : 's are'} missing from the file store.</b> Restore them from a skill file backup.<ul>${missing.slice(0, 20).map((m) => `<li>${esc(m.file)} · ${esc(m.uses.map((u) => `${u.format || 'format'} v${u.number}`).join(', '))}</li>`).join('')}</ul></div>` : ''}
      <h3>Unused files</h3>
      ${unused.length ? `<p>${unused.length} file${unused.length === 1 ? '' : 's'} no saved version uses · ${size(files.unusedBytes)}. They are never deleted automatically.</p>
        <ul class="storage-unused">${unused.slice(0, 50).map((u) => `<li><span>${esc(u.name)}</span><small>${size(u.size)}${u.created ? ` · ${esc(u.created.slice(0, 10))}` : ''}</small></li>`).join('')}</ul>
        ${unused.length > 50 ? `<p class="sub">…and ${unused.length - 50} more.</p>` : ''}
        ${button(`Delete ${unused.length} unused file${unused.length === 1 ? '' : 's'}`, 'deleteUnused', 'small')}` : '<p class="sub">None: every stored file is used by a saved skill version.</p>'}
      <h3>Back up skill files</h3>
      <p class="sub">Copies the file store to a folder, such as an external drive. Later backups to the same folder copy only new files.</p>
      <div class="learn-toolbar storage-backup">
        <label class="vf-grow">Backup folder (full path)<input id="fileBackupFolder" placeholder="/Volumes/Backup" autocomplete="off"></label>
        ${button('Back up skill files', 'backupFiles', 'small')}
      </div>`}
    </section>
  </div>`;
  $('[data-action=backup]', root).onclick = async () => {
    try {
      const b = await api(`${E}/backup`, {});
      toast(`Saved ${b.path}`);
      await renderDatabaseRecovery(root);
    } catch (e) { toast(e.message); }
  };
  const del = $('[data-action=deleteUnused]', root);
  if (del) {
    del.onclick = async () => {
      if (!await confirmBox({ title: 'Delete unused skill files?', text: `${unused.length} file${unused.length === 1 ? '' : 's'} (${size(files.unusedBytes)}) that no saved skill version uses will be deleted from the file store. Files a version uses are refused.`, ok: 'Delete unused files' })) return;
      try {
        const r = await api(`${E}/files/delete`, { hashes: unused.map((u) => u.sha256) });
        toast(`Deleted ${r.deleted} unused file${r.deleted === 1 ? '' : 's'} (${size(r.bytes)}).`);
        await renderDatabaseRecovery(root);
      } catch (e) { toast(e.message); }
    };
  }
  const backupFiles = $('[data-action=backupFiles]', root);
  if (backupFiles) {
    backupFiles.onclick = async () => {
      backupFiles.disabled = true;
      try {
        const r = await api(`${E}/files/backup`, { folder: $('#fileBackupFolder', root).value.trim() });
        toast(`Skill files backed up to ${r.path}: ${r.copied} copied, ${r.skipped} already there.`);
      } catch (e) { toast(e.message); } finally { backupFiles.disabled = false; }
    };
  }
  for (const b of backups) {
    const row = h(`<section class="learn-version"><b>${esc(b.created)}</b><p>${b.profiles} profiles · ${b.versions} guide versions · ${b.sounds || 0} catalog sounds · ${Math.round(b.bytes / 1024)} KB</p><button class="btn">Review restore</button></section>`);
    $('#dbBackups', root).append(row);
    $('button', row).onclick = async () => {
      try {
        const p = await api(`${E}/backups/${b.id}/preview`, {});
        if (p.missingPins.length) throw Error('This backup lacks versions used by: ' + p.missingPins.join(', '));
        const lacking = p.missingFiles || [];
        const filesNote = lacking.length
          ? `<div class="notice"><b>${lacking.length} skill file${lacking.length === 1 ? ' is' : 's are'} not in the file store.</b> The restore still works; restore these from a skill file backup afterwards.<ul>${lacking.slice(0, 20).map((m) => `<li>${esc(m.file)}${m.format ? ` · ${esc(m.format)} v${m.version}` : ''}</li>`).join('')}</ul></div>`
          : '';
        dialog('Restore database backup', `<p>This replaces the current registry with the reviewed backup. The displaced database is kept for recovery. Media files remain in place.</p>${filesNote}<pre>${esc(JSON.stringify(p.counts, null, 2))}</pre>`, async () => {
          const result = await api(`${E}/backups/${b.id}/restore`, { token: p.token });
          toast(result.warning || (result.missingFiles?.length ? result.note : 'Database restored.'));
          await renderDatabaseRecovery(root);
        }, 'Restore backup');
      } catch (e) { toast(e.message); }
    };
  }
}

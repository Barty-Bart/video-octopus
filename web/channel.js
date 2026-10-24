// My styles, one level (Flat 3, ADDENDUM-styles-gallery.md). A style is a learning format; a brand kit is a learning
// profile, shared by every style that uses it (format.profileId). Code, API and tables keep the profile/format names.
//   #/styles                          My styles: the kits bar and one flat card per style
//   #/styles/instructions, /memories  Studio instructions, Memories for everything
//   #/styles/kits                     Brand kits: one row per kit
//   #/styles/kit/<profileId>/<tab>    a kit: Brand · People & places · Memories · Styles
//   #/style/<formatId>/<tab>          a style: Skill · Examples · Brand · People & places · Memories
import { $, esc, h, api, toast, confirmBox } from './ui.js';
import { styleHref, kitHref } from './nav.js';
import { TERMS } from './terms.js';
import { channelAvatar, avatarInk } from './shell.js';
import {
  renderLearning, newStyleDialog, newKitDialog, renameKitDialog, archiveKit, changeKitDialog, showMenu, dialog, field,
  realKits, rememberedChannel, rememberChannel, videoSetups,
} from './learning.js';
import { profileSettings, instructionSettings } from './profiles.js';
import { renderMemories } from './memory.js';
import { mountResources } from './resources.js';
import { themeSwitch } from './appearance.js';
import { styleEntries, setupShape, kitColor, initialOf, COLOR } from './style-list.js';
import { idColor } from './kit-colors.js';
import { icon } from './icons.js';

const E = '/api/learning';
const DOTS = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const list = (names) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// A cover in the kit colour (a data colour, allowed inline), with white text unless that fails 4.5:1 (avatarInk), and a
// chip background that reads on it. Every kit has a colour (web/kit-colors.js); without one (No brand) the caller
// passes a colour derived from the style's id.
function coverStyle(color) {
  if (!COLOR.test(color || '')) return '';
  const ink = avatarInk(color);
  const chip = ink === '#ffffff' ? 'rgb(0 0 0 / 0.24)' : 'rgb(255 255 255 / 0.42)';
  return ` style="--kit:${color};--kit-ink:${ink};--kit-chip:${chip}"`;
}
// A filled dot in the kit colour. No brand has no kit, so no dot.
const kitDot = (color) => (COLOR.test(color || '') ? `<i class="kit-dot" aria-hidden="true" style="background:${color}"></i>` : '');

// The drawn part of a cover: the style's initial, large and quiet, and a frame in its orientation showing how it is
// made: a presenter (on camera) or a waveform with captions (faceless). currentColor is the cover's ink.
const ART = {
  'wide-camera': '<svg viewBox="0 0 160 90"><circle cx="80" cy="37" r="13.5"/><path d="M47 90c0-21 14.5-31 33-31s33 10 33 31z"/><circle cx="14" cy="13" r="3.5" class="o6"/><rect x="22" y="10.5" width="20" height="5" rx="2.5" class="o4"/></svg>',
  'tall-camera': '<svg viewBox="0 0 90 160"><circle cx="45" cy="60" r="15"/><path d="M12 160v-32c0-21 14-34 33-34s33 13 33 34v32z"/><rect x="17" y="122" width="56" height="8" rx="4" class="cap"/><rect x="27" y="134" width="36" height="6" rx="3" class="cap o7"/></svg>',
  'wide-voice': '<svg viewBox="0 0 160 90"><g class="wave">' + [6, 14, 24, 16, 30, 20, 34, 22, 12, 26, 18, 8].map((h, i) => `<rect x="${31 + i * 9}" y="${36 - h / 2}" width="4.5" height="${h}" rx="2.25"/>`).join('') + '</g><rect x="38" y="64" width="84" height="7" rx="3.5"/><rect x="54" y="75" width="52" height="6" rx="3" class="o6"/></svg>',
  'tall-voice': '<svg viewBox="0 0 90 160"><g class="wave">' + [8, 18, 28, 16, 34, 22, 12].map((h, i) => `<rect x="${17 + i * 8.5}" y="${66 - h / 2}" width="4.5" height="${h}" rx="2.25"/>`).join('') + '</g><rect x="14" y="110" width="62" height="8" rx="4"/><rect x="24" y="122" width="42" height="6" rx="3" class="o6"/></svg>',
};
const coverArt = (e) => `<span class="stc-art" aria-hidden="true"><b class="stc-mono">${esc(e.initial || initialOf(e.name))}</b><span class="stc-frame ${e.tall ? 'tall' : 'wide'}">${ART[`${e.tall ? 'tall' : 'wide'}-${e.camera === false ? 'voice' : 'camera'}`]}</span></span>`;

// The cover picture, when the studio has one (server/style-covers.mjs: a video's main thumbnail or frame, else a key
// frame of an example). It is laid over the drawn cover once it loads; a style with none keeps the drawn cover.
const coverPic = (e) => (e.coverVideos?.length || e.studied
  ? `<img class="stc-pic" alt="" loading="lazy" decoding="async" src="${E}/formats/${encodeURIComponent(e.id)}/cover?${new URLSearchParams({ projects: e.coverVideos.join(','), v: String(e.lastUsed || 0) })}">`
  : '');
function wireCovers(root) {
  for (const img of root.querySelectorAll('img.stc-pic')) {
    const done = () => img.closest('.stc-cover')?.classList.add('has-pic');
    if (img.complete && img.naturalWidth) done();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', () => img.remove(), { once: true });
  }
}

// Changes waiting in the newest draft of each style (sessions in review), for the cards' accent line.
async function draftCounts(sessions) {
  const waiting = sessions.filter((s) => s.status === 'review');
  const counts = new Map();
  await Promise.all(waiting.map(async (s) => {
    const p = await api(`${E}/sessions/${s.id}/proposal`).catch(() => null);
    const n = p ? p.rules.length + p.removals.length + (p.files?.added?.length || 0) + (p.files?.removed?.length || 0) : 0;
    if (n) counts.set(s.formatId, Math.max(counts.get(s.formatId) || 0, n));
  }));
  return counts;
}

// Everything the style cards need: profiles (with brands), formats, versions, sessions, projects.
async function loadStyles(formatInfo, projects) {
  const [profiles, learning, rows] = await Promise.all([
    api('/api/profiles'), api(E), projects ? Promise.resolve(projects) : api('/api/projects').catch(() => []),
  ]);
  const drafts = await draftCounts(learning.sessions);
  return { profiles: profiles.profiles, formats: profiles.formats, versions: profiles.versions, sessions: learning.sessions, projects: rows, drafts, formatInfo };
}

// One style card (board Flat 3): the cover (its picture, else drawn in the kit colour), the kind badge and the kit
// chip, then name, description and meta.
function styleCard(e, query = '') {
  return `<a class="stc${e.archived ? ' archived' : ''}" href="${styleHref(e.id, 'skill')}${query}">
    <span class="stc-cover${e.unbranded ? ' unbranded' : ''}"${coverStyle(e.kitColor || e.coverColor || idColor(e.id))}>
      ${coverArt(e)}
      ${coverPic(e)}
      <span class="stc-chip stc-badge">${esc(e.badge)}</span>
      <span class="stc-chip stc-kit" title="Brand kit: ${esc(e.kitName)}">${kitDot(e.kitColor)}<span>${esc(e.kitName)}</span></span>
      ${e.archived ? '<span class="stc-chip stc-arch">Archived</span>' : ''}
    </span>
    <span class="stc-t">
      <b>${esc(e.name)}</b>
      ${e.description ? `<span class="stc-desc">${esc(e.description)}</span>` : ''}
      <span class="stc-meta">${esc(e.meta)}${e.changes ? ` · <span class="stc-review">${plural(e.changes, 'change')} to review</span>` : ''}</span>
    </span>
  </a>`;
}
const newCard = (first = false) => `<button type="button" class="stc stc-new" data-new-style>
    <span class="stc-cover"><span class="stc-new-ic" aria-hidden="true">${icon('plus', 20)}</span><b>${first ? 'Create your first style' : 'New style'}</b><span>${first ? 'One kind of video you make, like “Faceless reel”' : 'One kind of video, from examples or a link'}</span></span>
  </button>`;
// Styles that studied an example (a saved version, or a conversation with references) may have a key frame to show.
const studiedFormats = (data) => new Set([
  ...data.formats.filter((f) => f.activeVersion).map((f) => f.id),
  ...data.sessions.filter((x) => x.references?.length).map((x) => x.formatId),
]);

// ---------- My styles (#/styles) ----------
// ctx: { tab: 'styles' | 'instructions' | 'memories', query, counts, projects, formatInfo, onChannelsChange }.
export async function renderStyles(main, { tab, query, counts = {}, projects = null, formatInfo = {} }) {
  const sub = { instructions: 'Studio instructions', memories: 'Memories for everything' }[tab] || '';
  document.title = `${sub ? `${sub} · ` : ''}${TERMS.myStyles} · Video Octopus`;
  main.replaceChildren(h(`<div class="sty">
    <header class="sty-head">
      ${sub ? `<div class="sty-title"><p class="eyebrow"><a href="#/styles">${TERMS.myStyles}</a></p><h1>${esc(sub)}</h1></div>` : `<h1>${TERMS.myStyles}</h1>`}
      <span class="gap"></span>
      <span data-theme-slot></span>
      ${sub ? '' : '<button type="button" class="btn primary" data-new-style>New style</button>'}
    </header>
    <div class="sty-body" id="styBody"></div>
  </div>`));
  main.querySelector('[data-theme-slot]')?.replaceWith(themeSwitch());
  const body = $('#styBody', main);

  if (tab === 'instructions') {
    const node = instructionSettings();
    body.append(h('<p class="sty-intro">Shared by every style: how your agent should work on every video. Brand identity belongs to each brand kit.</p>'), node);
    return { teardown: () => node.teardown?.() };
  }
  if (tab === 'memories') return renderMemories(body, { scope: 'global' });

  const data = await loadStyles(formatInfo, projects);
  // Library's "Use notes as an example": the notes go to the style picked here (its Talk to this style).
  const legacy = query?.get('legacyStyle') || '';
  const carry = legacy ? `?legacyStyle=${encodeURIComponent(legacy)}` : '';
  const kits = realKits(data.profiles);
  let showArchived = false;
  const draw = () => {
    const studied = studiedFormats(data);
    const all = styleEntries(data, { archived: true }).map((e) => ({ ...e, studied: studied.has(e.id) }));
    const shown = all.filter((e) => showArchived || !e.archived);
    const archivedCount = all.filter((e) => e.archived).length;
    const pendingGlobal = counts.waiting?.memories || 0;
    body.replaceChildren(h(`<div class="sty-page">
      ${legacy ? `<p class="notice">Pick the style these legacy notes should teach: <b>${esc(legacy)}</b>. It opens with ${TERMS.talk}; start a conversation there and the notes are added.</p>` : ''}
      <nav class="kits-bar" aria-label="${TERMS.kits}">
        <b>${TERMS.kits}</b>
        ${kits.map((k) => `<a class="kit-pill" href="${kitHref(k.id, 'brand')}">${kitDot(kitColor(k))}${esc(k.name)}</a>`).join('') || '<span class="sub">None yet</span>'}
        <span class="gap"></span>
        <a class="kits-manage" href="#/styles/kits">Manage brand kits</a>
      </nav>
      <div class="stc-grid">
        ${shown.map((e) => styleCard(e, carry)).join('')}
        ${newCard(!all.length)}
      </div>
      ${archivedCount ? `<label class="learn-check sty-archived"><input type="checkbox" data-archived${showArchived ? ' checked' : ''}> Show archived (${archivedCount})</label>` : ''}
      <section class="sty-shared" aria-labelledby="styShared">
        <h2 id="styShared">Shared by every style</h2>
        <div class="sty-shared-rows">
          <a class="sty-link" href="#/styles/instructions"><span class="sty-link-ic">${icon('instructions', 18)}</span><span class="sty-link-t"><b>Studio instructions</b><span class="sty-meta">How your agent works on every video</span></span>${icon('forward', 16)}</a>
          <a class="sty-link" href="#/styles/memories"><span class="sty-link-ic">${icon('memory', 18)}</span><span class="sty-link-t"><b>Memories for everything</b><span class="sty-meta">Preferences that apply to every style</span></span>${pendingGlobal ? `<span class="pill accent">${pendingGlobal} to review</span>` : ''}${icon('forward', 16)}</a>
        </div>
      </section>
    </div>`));
    wireCovers(body);
    for (const b of main.querySelectorAll('[data-new-style]')) b.onclick = () => newStyleDialog({ profiles: data.profiles });
    const toggle = body.querySelector('[data-archived]');
    if (toggle) toggle.onchange = () => { showArchived = toggle.checked; draw(); };
  };
  draw();
  return { teardown() {} };
}

// ---------- the style page (#/style/<formatId>/<tab>) ----------
const STYLE_TAB_NAMES = { skill: 'Skill', examples: 'Examples', brand: 'Brand', people: 'People & places', memories: 'Memories' };

// `_` or an id that isn't a style: a session or format in the query picks the style; a kit's id goes to the kit.
async function resolveStyle(id, tab, query, data) {
  if (data.formats.some((f) => f.id === id)) return { id };
  if (data.profiles.some((p) => p.id === id)) return { redirect: kitHref(id, ['brand', 'memories', 'people'].includes(tab) ? tab : 'styles') };
  if (id !== '_') return {};
  if (query.get('format') && data.formats.some((f) => f.id === query.get('format'))) return { id: query.get('format') };
  if (query.get('session')) {
    const s = (await api(E).catch(() => null))?.sessions.find((x) => x.id === query.get('session'));
    if (s) return { id: s.formatId };
  }
  return { redirect: '#/styles' };
}

// ctx: { id, tab, panel, query, makeChat, startVideo, counts, projects, formatInfo, onChannelsChange, onFormatsChange }.
export async function renderStylePage(main, ctx) {
  const { tab, panel, query, makeChat, startVideo, counts = {}, projects = [], formatInfo = {}, onChannelsChange, onFormatsChange } = ctx;
  const data = await api('/api/profiles');
  const found = await resolveStyle(ctx.id, tab, query, data);
  if (found.redirect) { location.replace(found.redirect); return null; }
  const f = data.formats.find((x) => x.id === found.id);
  if (!f) {
    document.title = 'Style not found · Video Octopus';
    main.replaceChildren(h(`<div class="home-wrap"><div class="empty"><b>This style doesn’t exist</b><span class="sub">It may have been removed from this studio.</span><a class="btn" href="#/styles">${TERMS.myStyles}</a></div></div>`));
    return null;
  }
  if (found.id !== ctx.id) history.replaceState(null, '', styleHref(f.id, tab, Object.fromEntries([...query].filter(([k]) => k !== 'format'))));
  const kit = data.profiles.find((p) => p.id === f.profileId) || null;
  const unbranded = !kit || Boolean(kit.system);
  // The cover's colour: the kit's (every kit has one); a No brand style's is derived from its id.
  const color = (unbranded ? null : kitColor(kit)) || idColor(f.id);
  const shape = setupShape(f.type, formatInfo);
  const learning = await api(E).catch(() => ({ sessions: [] }));
  const sessions = learning.sessions.filter((s) => s.formatId === f.id);
  const examples = sessions.reduce((n, s) => n + s.references.length, 0);
  const number = f.activeVersion ? data.versions.find((v) => v.id === f.activeVersion)?.number : null;
  const people = unbranded ? 0 : await api(`/api/resources?profile=${encodeURIComponent(kit.id)}`)
    .then((r) => r.levels.find((l) => l.level === 'profile')?.items.length || 0).catch(() => 0);
  const pending = unbranded ? 0 : (counts.channels || []).find((c) => c.id === kit.id)?.pendingMemories || 0;
  const archived = Boolean(f.archived || kit?.archived);
  const sharing = unbranded ? [] : data.formats.filter((x) => x.profileId === kit.id && x.id !== f.id && !x.archived);
  document.title = `${f.name} · ${STYLE_TAB_NAMES[tab]} · Video Octopus`;

  const tabs = [
    ['skill', 'Skill', number ? `v${number}` : 'Basic'],
    ['examples', 'Examples', String(examples)],
    ['brand', 'Brand', unbranded ? TERMS.noBrand : ''],
    ['people', 'People &amp; places', unbranded ? '' : String(people)],
    ['memories', 'Memories', pending ? `<span class="pill accent" title="${plural(pending, 'memory')} to review">${pending}</span>` : ''],
  ];
  main.replaceChildren(h(`<div class="hub stp${tab === 'skill' || tab === 'examples' ? ' hub-formats' : ''}">
    <div class="stp-top">
      <header class="stp-cover"${coverStyle(color)}>
        <span class="stp-frame ${shape.tall ? 'tall' : 'wide'}" aria-hidden="true">${ART[`${shape.tall ? 'tall' : 'wide'}-${shape.camera ? 'camera' : 'voice'}`]}</span>
        <div class="stp-in">
          <div class="stp-bar">
            <nav class="stp-crumb" aria-label="Breadcrumb"><a href="#/styles">${TERMS.myStyles}</a><span aria-hidden="true">/</span><span aria-current="page">${esc(f.name)}</span></nav>
            <span class="gap"></span>
            <span data-theme-slot></span>
            <button type="button" class="stp-icon" data-style-menu aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ${esc(f.name)}">${DOTS}</button>
          </div>
          <div class="stp-foot">
            <div class="stp-title">
              <span class="stp-badge">${esc(shape.badge)} · brand: ${esc(unbranded ? TERMS.noBrand : kit.name)}</span>
              <h1>${esc(f.name)}</h1>
              ${f.description ? `<p>${esc(f.description)}</p>` : ''}
            </div>
            <button type="button" class="btn stp-new" data-new-video${archived ? ' disabled title="Restore the style to make new videos"' : ''}>New video in this style</button>
          </div>
        </div>
      </header>
      ${archived ? `<div class="notice hub-archived stp-archived"><span>${f.archived ? 'This style is archived' : 'Its brand kit is archived'}. It is hidden from New video. Nothing was deleted.</span>${f.archived ? '<button type="button" class="btn small" data-restore>Restore</button>' : `<a class="btn small" href="${kitHref(kit.id, 'brand')}">Open the kit</a>`}</div>` : ''}
      <nav class="hub-tabs stp-tabs scroll-row" aria-label="${esc(f.name)} sections">
        ${tabs.map(([key, label, extra]) => `<a class="hub-tab${key === tab ? ' on' : ''}" data-tab="${key}" href="${styleHref(f.id, key)}"${key === tab ? ' aria-current="page"' : ''}>${label}${extra ? ` <span class="tab-status">${extra}</span>` : ''}</a>`).join('')}
      </nav>
    </div>
    <div class="hub-body" id="hubBody"></div>
  </div>`));
  main.querySelector('[data-theme-slot]')?.replaceWith(themeSwitch());
  const reload = () => onChannelsChange?.();
  main.querySelector('[data-new-video]').onclick = () => startVideo({ format: f });
  main.querySelector('[data-style-menu]').onclick = (e) => showMenu(e.currentTarget, styleMenu(f, { reload }));
  const restore = main.querySelector('[data-restore]');
  if (restore) restore.onclick = () => archiveStyle(f, false).then(reload).catch((err) => toast(err.message));

  const body = $('#hubBody', main);
  const pad = () => { const box = h('<div class="hub-pad stp-pad"></div>'); body.append(box); return box; };
  const changeKit = () => changeKitDialog(f, { profiles: data.profiles, onDone: reload });
  let part = null;
  if (tab === 'skill' || tab === 'examples') {
    part = await renderLearning(body, {
      makeChat, formatId: f.id, tab, panel, orientation: shape.tall ? 'tall' : 'wide',
      basePath: styleHref(f.id, tab), startVideo: (format) => startVideo({ format }),
      onFormatsChange, onChannelChange: reload,
    });
  } else if (tab === 'brand') {
    const box = pad();
    if (unbranded) {
      box.append(h(`<div class="stp-kit-head"><p><b>${TERMS.noBrand}</b> · this style doesn’t use a brand kit. Videos get no brand colours, fonts or voice, and only Everything memories.</p><button type="button" class="btn primary small" data-change-kit>Pick a brand kit</button></div>`));
    } else {
      box.append(h(`<div class="stp-kit-head"><p>Uses the <a href="${kitHref(kit.id, 'brand')}"><b>${esc(kit.name)}</b></a> brand kit${sharing.length ? ` · also used by ${esc(list(sharing.map((x) => x.name)))}` : ''}. Changes here apply to every style using it.</p><button type="button" class="btn small" data-change-kit>Change kit</button></div>`));
      const node = profileSettings({ makeChat, profileId: kit.id, rows: true, onBrandChange: () => onFormatsChange?.() });
      box.append(node);
      part = node;
    }
    box.querySelector('[data-change-kit]').onclick = changeKit;
  } else if (tab === 'people') {
    const box = pad();
    if (unbranded) {
      box.append(h(`<div class="stp-kit-head"><p>Pick a brand kit to add people and places. They belong to the kit and are shared by every style that uses it.</p><button type="button" class="btn primary small" data-change-kit>Pick a brand kit</button></div>`));
      box.querySelector('[data-change-kit]').onclick = changeKit;
    } else {
      box.append(h(`<div class="stp-kit-head"><p>From the <a href="${kitHref(kit.id, 'people')}"><b>${esc(kit.name)}</b></a> kit · shared by ${plural(sharing.length + 1, 'style')}</p></div>`));
      const host = h('<div class="rs-panel"></div>');
      box.append(host);
      mountResources(host, { profileId: kit.id, only: 'profile' });
      part = host;
    }
  } else {
    const box = pad();
    if (unbranded) {
      box.append(h(`<div class="stp-kit-head"><p>${TERMS.noBrand}: this style uses <b>Everything</b> memories only. Pick a brand kit to keep preferences for a group of styles.</p></div>`));
      const host = h('<div></div>');
      box.append(host);
      part = await renderMemories(host, { scope: 'global' });
    } else {
      box.append(h(`<div class="stp-kit-head"><p>Shared by styles using the <a href="${kitHref(kit.id, 'memories')}"><b>${esc(kit.name)}</b></a> kit. A style’s own pace and layout belong in its Skill rules.</p></div>`));
      const host = h('<div></div>');
      box.append(host);
      part = await renderMemories(host, { profileId: kit.id, profileName: kit.name });
    }
  }
  return { name: f.name, teardown: () => { part?.teardown?.(); } };
}

async function archiveStyle(f, archive) {
  if (archive && !await confirmBox({ title: `Archive ${f.name}?`, text: 'It is hidden from My styles and New video, and its generated skill is unpublished. Nothing is deleted, existing videos are untouched, and you can restore it with Show archived.', ok: 'Archive style' })) return;
  const r = await api(`${E}/formats/${f.id}/${archive ? 'archive' : 'unarchive'}`, { expected: f.revision || 1 });
  toast(r.warning || (archive ? `${f.name} archived.` : `${f.name} restored.`));
}

// The style's … menu: Rename, Edit description, Edit setup, Duplicate, Archive or Restore.
function styleMenu(f, { reload }) {
  const update = async (body, done) => {
    const r = await api(`${E}/formats/${f.id}/update`, { expected: f.revision || 1, ...body });
    toast(r.warning || done);
    await reload();
  };
  return [
    { label: 'Rename', run: () => dialog('Rename style', field('Style name', 'name', f.name) + '<p class="sub">Existing videos keep the names they were made with.</p>', (b) => update({ name: b.name }, 'Renamed.')) },
    { label: 'Edit description', run: () => dialog('Edit description', `<label>Description<input name="description" value="${esc(f.description || '')}" maxlength="200" placeholder="B-roll only, AI voice, punchy captions"></label>`, (b) => update({ description: b.description || '' }, 'Saved.')) },
    { label: 'Edit setup', run: () => dialog('Edit setup', `<label>Kind<select name="type">${videoSetups.map((x) => `<option value="${x.id}"${x.id === f.type ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label><label>Target length in seconds (optional)<input name="targetSeconds" type="number" min="0" max="7200" value="${f.targetSeconds || ''}"></label><p class="sub">Applies to future videos. Videos already made keep theirs, and saved skill versions don’t change.</p>`, (b) => update({ type: b.type, targetSeconds: Number(b.targetSeconds) || 0 }, 'Saved. It applies to future videos.')) },
    { label: 'Duplicate', run: async () => {
      try {
        const copy = await api(`${E}/formats/${f.id}/duplicate`, { expected: f.revision || 1 });
        toast(copy.warning || `Made ${copy.name}.`);
        location.hash = styleHref(copy.id, 'skill');
      } catch (e) { toast(e.message); }
    } },
    '-',
    f.archived
      ? { label: 'Restore style', run: () => archiveStyle(f, false).then(reload).catch((e) => toast(e.message)) }
      : { label: 'Archive style', danger: true, run: () => archiveStyle(f, true).then(reload).catch((e) => toast(e.message)) },
  ];
}

// ---------- Brand kits (#/styles/kits) ----------
export async function renderKits(main, { formatInfo = {}, onChannelsChange }) {
  document.title = `${TERMS.kits} · ${TERMS.myStyles} · Video Octopus`;
  const data = await api('/api/profiles');
  let showArchived = false;
  main.replaceChildren(h(`<div class="sty">
    <header class="sty-head">
      <div class="sty-title"><p class="eyebrow"><a href="#/styles">${TERMS.myStyles}</a></p><h1>${TERMS.kits}</h1></div>
      <span class="gap"></span><span data-theme-slot></span>
      <button type="button" class="btn primary" data-new-kit>New kit</button>
    </header>
    <div class="sty-body" id="styBody"></div>
  </div>`));
  main.querySelector('[data-theme-slot]')?.replaceWith(themeSwitch());
  main.querySelector('[data-new-kit]').onclick = () => newKitDialog({ onCreated: (p) => { location.hash = kitHref(p.id, 'brand'); } });
  const body = $('#styBody', main);
  const draw = () => {
    const kits = data.profiles.filter((p) => !p.system && (showArchived || !p.archived));
    const archivedCount = data.profiles.filter((p) => !p.system && p.archived).length;
    const rows = kits.map((k) => {
      const using = data.formats.filter((f) => f.profileId === k.id && !f.archived);
      return `<a class="kit-row${k.archived ? ' archived' : ''}" href="${kitHref(k.id, 'brand')}">
        ${channelAvatar({ name: k.name, color: kitColor(k) }, 'mid')}
        <span class="kit-row-t"><b>${esc(k.name)}${k.archived ? ' <span class="badge">Archived</span>' : ''}</b><span class="sty-meta">${esc([using.length ? `used by ${plural(using.length, 'style')}` : 'not used by a style yet', k.description].filter(Boolean).join(' · '))}</span></span>
        <span class="kit-row-s">${k.brand ? 'Brand approved' : 'No brand yet'}</span>
      </a>`;
    }).join('');
    body.replaceChildren(h(`<div class="sty-page">
      <p class="sty-intro">A brand kit is a reusable look and identity: brand, research, assets, people &amp; places and memories. Every style that uses a kit shares it; a style without one uses ${TERMS.noBrand}.</p>
      <div class="kit-list">${rows || `<div class="sty-first"><b>No brand kits yet</b><span class="sty-meta">Make one for each look you use, like “Faceless AI”.</span></div>`}</div>
      ${archivedCount ? `<label class="learn-check sty-archived"><input type="checkbox" data-archived${showArchived ? ' checked' : ''}> Show archived (${archivedCount})</label>` : ''}
    </div>`));
    const toggle = body.querySelector('[data-archived]');
    if (toggle) toggle.onchange = () => { showArchived = toggle.checked; draw(); };
  };
  draw();
  return { teardown() {} };
}

// ---------- a brand kit (#/styles/kit/<profileId>/<tab>) ----------
const KIT_TAB_NAMES = { brand: 'Brand', people: 'People & places', memories: 'Memories', styles: 'Styles' };

// `_` → a real kit id: from the scope, chat or format in the query, else the remembered kit, else the first one.
async function resolveKit(query, profiles, formats, projects) {
  const open = realKits(profiles);
  const formatOwner = (formatId) => formats.find((f) => f.id === formatId)?.profileId || null;
  const scope = query.get('scope') || '';
  if (scope.startsWith('profile:')) return scope.slice('profile:'.length);
  if (scope.startsWith('format:')) return formatOwner(scope.slice('format:'.length));
  if (scope.startsWith('project:')) return projects.find((p) => p.id === scope.slice('project:'.length))?.profileId || null;
  if (query.get('chat')) {
    const binding = await api(`/api/memory?chat=${encodeURIComponent(query.get('chat'))}`).catch(() => null);
    if (binding?.scope?.startsWith('profile:')) return binding.scope.slice('profile:'.length);
    return null;
  }
  const last = rememberedChannel();
  if (last && open.some((p) => p.id === last)) return last;
  return open[0]?.id || null;
}

// ctx: { id, tab, query, makeChat, startVideo, counts, projects, formatInfo, onChannelsChange, onFormatsChange }.
export async function renderKit(main, ctx) {
  const { tab, query, makeChat, startVideo, counts = {}, projects = [], formatInfo = {}, onChannelsChange, onFormatsChange } = ctx;
  const data = await api('/api/profiles');
  let id = ctx.id;
  if (id === '_') {
    const resolved = await resolveKit(query, data.profiles, data.formats, projects);
    if (!resolved || data.profiles.find((p) => p.id === resolved)?.system) {
      location.replace(tab === 'memories' ? '#/styles/memories' : '#/styles/kits');
      return null;
    }
    id = resolved;
    const kept = new URLSearchParams(query);
    kept.delete('scope'); // a scope only picked the kit; the tab shows the kit's whole level
    history.replaceState(null, '', kitHref(id, tab, Object.fromEntries(kept)));
  }
  const p = data.profiles.find((x) => x.id === id);
  if (!p || p.system) {
    if (p?.system) { location.replace('#/styles'); return null; } // No brand is not a kit
    document.title = 'Brand kit not found · Video Octopus';
    main.replaceChildren(h(`<div class="home-wrap"><div class="empty"><b>This brand kit doesn’t exist</b><span class="sub">It may have been removed from this studio.</span><a class="btn" href="#/styles/kits">${TERMS.kits}</a></div></div>`));
    return null;
  }
  rememberChannel(p.id);
  document.title = `${p.name} · ${KIT_TAB_NAMES[tab]} · Video Octopus`;
  const using = data.formats.filter((f) => f.profileId === p.id && !f.archived);
  const summary = (counts.channels || []).find((c) => c.id === p.id);
  const pending = summary?.pendingMemories || 0;
  const tabs = [
    ['brand', 'Brand', p.brand ? 'Approved' : 'Not set'],
    ['people', 'People &amp; places', ''],
    ['memories', 'Memories', pending ? `<span class="pill accent" title="${plural(pending, 'memory')} to review">${pending}</span>` : ''],
    ['styles', 'Styles', String(using.length)],
  ];
  main.replaceChildren(h(`<div class="hub kitp">
    <div class="hub-top">
      <div class="page-head">
        ${channelAvatar({ name: p.name, color: kitColor(p) }, 'big')}
        <div class="ph-title">
          <p class="eyebrow"><a href="#/styles">${TERMS.myStyles}</a> · <a href="#/styles/kits">${TERMS.kits}</a></p>
          <h1>${esc(p.name)}</h1>
          <p class="ph-desc">${esc(p.description || (using.length ? `Used by ${list(using.map((f) => f.name))}` : 'Not used by a style yet'))}</p>
        </div>
        <div class="ph-actions">
          <span data-theme-slot></span>
          <button type="button" class="btn primary" data-new-video${p.archived ? ' disabled title="Restore the kit to make new videos"' : ''}>New video</button>
          <button type="button" class="btn icon-btn" data-kit-menu aria-haspopup="menu" aria-expanded="false" aria-label="Options for ${esc(p.name)}">${DOTS}</button>
        </div>
      </div>
      ${p.archived ? '<div class="notice hub-archived"><span>This brand kit is archived. It is hidden from My styles. Nothing was deleted.</span><button type="button" class="btn small" data-restore>Restore</button></div>' : ''}
      <nav class="hub-tabs scroll-row" aria-label="${esc(p.name)} sections">
        ${tabs.map(([key, label, extra]) => `<a class="hub-tab${key === tab ? ' on' : ''}" data-tab="${key}" href="${kitHref(p.id, key)}"${key === tab ? ' aria-current="page"' : ''}>${label}${extra ? ` <span class="tab-status">${extra}</span>` : ''}</a>`).join('')}
      </nav>
    </div>
    <div class="hub-body" id="hubBody"></div>
  </div>`));
  main.querySelector('[data-theme-slot]')?.replaceWith(themeSwitch());
  const reload = () => onChannelsChange?.();
  main.querySelector('[data-new-video]').onclick = () => startVideo({ profileId: p.id });
  main.querySelector('[data-kit-menu]').onclick = (e) => showMenu(e.currentTarget, [
    { label: 'Rename or describe', run: () => renameKitDialog(p, { onDone: reload }) },
    { label: 'New style with this kit', run: () => newStyleDialog({ profiles: data.profiles, kitId: p.id }) },
    '-',
    p.archived
      ? { label: 'Restore kit', run: () => archiveKit(p, false, { onDone: reload }).catch((err) => toast(err.message)) }
      : { label: 'Archive kit', danger: true, run: () => archiveKit(p, true, { onDone: reload }).catch((err) => toast(err.message)) },
  ]);
  const restore = main.querySelector('[data-restore]');
  if (restore) restore.onclick = () => archiveKit(p, false, { onDone: reload }).catch((err) => toast(err.message));

  const body = $('#hubBody', main);
  const box = h('<div class="hub-pad stp-pad"></div>');
  body.append(box);
  let part = null;
  if (tab === 'brand') {
    // A brand approved, saved or restored here: the tab status and the avatar follow, without redrawing the tab.
    const onBrandChange = async (fresh) => {
      if (!main.isConnected) return;
      const status = main.querySelector('.hub-tab[data-tab="brand"] .tab-status');
      if (status) status.textContent = fresh.brand ? 'Approved' : 'Not set';
      await onFormatsChange?.();
      if (!main.isConnected) return;
      main.querySelector('.hub-top .page-head > .ch-av')?.replaceWith(h(channelAvatar({ name: p.name, color: kitColor(fresh) }, 'big')));
    };
    part = profileSettings({ makeChat, profileId: p.id, rows: true, onBrandChange });
    box.append(part);
  } else if (tab === 'people') {
    box.append(h(`<div class="stp-kit-head"><p>People &amp; places of the <b>${esc(p.name)}</b> kit · shared by ${plural(using.length, 'style')}</p></div>`));
    const host = h('<div class="rs-panel"></div>');
    box.append(host);
    mountResources(host, { profileId: p.id, only: 'profile' });
    part = host;
  } else if (tab === 'memories') {
    box.append(h(`<div class="stp-kit-head"><p>Shared by every style using the <b>${esc(p.name)}</b> kit.</p></div>`));
    const host = h('<div></div>');
    box.append(host);
    part = await renderMemories(host, { profileId: p.id, profileName: p.name });
  } else {
    const styles = await loadStyles(formatInfo, projects);
    const studied = studiedFormats(styles);
    const entries = styleEntries(styles, { profileId: p.id, archived: true }).map((e) => ({ ...e, studied: studied.has(e.id) }));
    box.append(h(`<div class="stc-grid">${entries.map((e) => styleCard(e)).join('')}${p.archived ? '' : newCard(!entries.length)}</div>`));
    wireCovers(box);
    box.querySelector('[data-new-style]')?.addEventListener('click', () => newStyleDialog({ profiles: data.profiles, kitId: p.id }));
  }
  return { name: p.name, teardown: () => part?.teardown?.() };
}

// My styles (design V2 §5, board "V2 My styles"): the style hub (#/style/<id>/<tab>) with its Formats, Brand and
// Memories tabs, and the My styles page (#/styles), with Instructions and Memories for everything at
// #/styles/instructions and #/styles/memories. A style is a learning profile (a "channel" before V2); code, API and
// tables keep the profile names.
import { $, esc, h, api, toast } from './ui.js';
import { styleHref as channelHref } from './nav.js';
import { TERMS } from './terms.js';
import { channelAvatar } from './shell.js';
import {
  renderLearning, channelMenuItems, newChannelDialog, newFormatDialog, archiveChannel, showMenu,
  rememberedChannel, rememberChannel, videoSetups,
} from './learning.js';
import { profileSettings, instructionSettings } from './profiles.js';
import { renderMemories } from './memory.js';
import { themeSwitch } from './appearance.js';
import { icon } from './icons.js';

const DOTS = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>';
const TAB_NAMES = { formats: 'Formats', brand: 'Brand', memories: 'Memories' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// `_` → a real style id: from the format, session, chat or scope in the query, else the remembered channel, else
// the first one that isn't archived. null when there is no channel at all.
async function resolveChannel(tab, query, profiles, formats, projects) {
  const open = profiles.filter((p) => !p.archived);
  const formatOwner = (formatId) => formats.find((f) => f.id === formatId)?.profileId || null;
  if (tab === 'formats') {
    if (query.get('format')) {
      const owner = formatOwner(query.get('format'));
      if (owner) return owner;
    }
    if (query.get('session')) {
      const data = await api('/api/learning').catch(() => null);
      const session = data?.sessions.find((s) => s.id === query.get('session'));
      const owner = session && formatOwner(session.formatId);
      if (owner) return owner;
    }
  }
  if (tab === 'memories') {
    const scope = query.get('scope') || '';
    if (scope.startsWith('profile:')) return scope.slice('profile:'.length);
    if (scope.startsWith('format:')) return formatOwner(scope.slice('format:'.length));
    if (scope.startsWith('project:')) return projects.find((p) => p.id === scope.slice('project:'.length))?.profileId || null;
    if (query.get('chat')) {
      const binding = await api(`/api/memory?chat=${encodeURIComponent(query.get('chat'))}`).catch(() => null);
      if (binding?.scope?.startsWith('profile:')) return binding.scope.slice('profile:'.length);
      return null;
    }
  }
  const last = rememberedChannel();
  if (last && open.some((p) => p.id === last)) return last;
  return open[0]?.id || null;
}

// The hub. ctx: { id, tab, query, makeChat, startVideo, counts, projects, onChannelsChange, onFormatsChange }.
export async function renderChannel(main, ctx) {
  const { tab, query, makeChat, startVideo, counts = {}, projects = [], onChannelsChange, onFormatsChange } = ctx;
  let { id } = ctx;
  const data = await api('/api/profiles');

  if (id === '_') {
    const resolved = await resolveChannel(tab, query, data.profiles, data.formats, projects);
    if (!resolved) {
      // No style to show: My styles (its Memories for everything, for a memory link without a style).
      location.replace(tab === 'memories' ? '#/styles/memories' : '#/styles');
      return null;
    }
    id = resolved;
    const kept = new URLSearchParams(query);
    kept.delete('scope'); // a scope only picked the style; the tab shows the style's whole level
    history.replaceState(null, '', channelHref(id, tab, Object.fromEntries(kept)));
  }

  const p = data.profiles.find((x) => x.id === id);
  if (!p) {
    document.title = 'Style not found · Video Octopus';
    main.replaceChildren(h(`<div class="home-wrap"><div class="empty"><b>This style doesn’t exist</b><span class="sub">It may have been removed from this studio.</span><a class="btn" href="#/styles">My styles</a></div></div>`));
    return null;
  }
  rememberChannel(p.id);
  document.title = `${p.name} · ${TAB_NAMES[tab]} · Video Octopus`;

  const summary = (counts.channels || []).find((c) => c.id === p.id);
  const formats = data.formats.filter((f) => f.profileId === p.id && !f.archived).length;
  const videos = projects.filter((x) => x.profileId === p.id).length;
  const pending = summary?.pendingMemories || 0;
  const avatar = { name: p.name, color: summary?.color ?? (p.brand?.brand?.colors?.[0] || null) };
  const tabs = [
    ['formats', 'Formats', `<span class="seg-n">${formats}</span>`],
    ['brand', 'Brand', `<span class="tab-status">${p.brand ? 'Approved' : 'Not set'}</span>`],
    ['memories', 'Memories', pending ? `<span class="pill accent" title="${plural(pending, 'memory')} to review">${pending}</span>` : ''],
  ];
  main.replaceChildren(h(`<div class="hub${tab === 'formats' ? ' hub-formats' : ''}">
    <div class="hub-top">
      <div class="page-head">
        ${channelAvatar(avatar, 'big')}
        <div class="ph-title">
          <p class="eyebrow"><a href="#/styles">${TERMS.myStyles}</a> · <a href="#/?style=${encodeURIComponent(p.id)}">${plural(videos, 'video')}</a></p>
          <h1>${esc(p.name)}</h1>
          ${p.description ? `<p class="ph-desc">${esc(p.description)}</p>` : ''}
        </div>
        <div class="ph-actions">
          <span data-theme-slot></span>
          <button type="button" class="btn primary" data-hub="new"${p.archived ? ' disabled title="Restore the style to make new videos"' : ''}>New video</button>
          <button type="button" class="btn icon-btn" data-hub="menu" aria-haspopup="menu" aria-expanded="false" aria-label="Options for ${esc(p.name)}">${DOTS}</button>
        </div>
      </div>
      ${p.archived ? `<div class="notice hub-archived"><span>This style is archived. It is hidden from New video. Nothing was deleted.</span><button type="button" class="btn small" data-hub="restore">Restore</button></div>` : ''}
      <nav class="hub-tabs scroll-row" aria-label="${esc(p.name)} sections">
        ${tabs.map(([key, label, extra]) => `<a class="hub-tab${key === tab ? ' on' : ''}" data-tab="${key}" href="${channelHref(p.id, key)}"${key === tab ? ' aria-current="page"' : ''}>${label}${extra}</a>`).join('')}
      </nav>
    </div>
    <div class="hub-body" id="hubBody"></div>
  </div>`));

  main.querySelector('[data-theme-slot]')?.replaceWith(themeSwitch());
  const body = $('#hubBody', main);
  let part = null;
  const newFormat = () => {
    if (part?.newFormat) return part.newFormat();
    newFormatDialog({ profiles: data.profiles, profileId: p.id, onCreated: (f) => { location.hash = channelHref(p.id, 'formats', { format: f.id }); } });
  };
  main.querySelector('[data-hub="new"]').onclick = () => startVideo({ profileId: p.id });
  main.querySelector('[data-hub="menu"]').onclick = (e) => showMenu(e.currentTarget, channelMenuItems(p, { onChange: onChannelsChange, newFormat }));
  const restore = main.querySelector('[data-hub="restore"]');
  if (restore) restore.onclick = () => archiveChannel(p, false, { onDone: onChannelsChange }).catch((err) => toast(err.message));

  if (tab === 'formats') {
    part = await renderLearning(body, {
      makeChat,
      startVideo: (format) => startVideo({ format }),
      channelId: p.id,
      basePath: channelHref(p.id, 'formats'),
      onFormatsChange,
      onChannelChange: onChannelsChange,
    });
  } else if (tab === 'brand') {
    // A brand approved, saved or restored here: the tab's status, the hub avatar and the sidebar follow at once,
    // without redrawing the tab (its research session and chat stay open).
    const onBrandChange = async (fresh) => {
      if (!main.isConnected) return;
      const status = main.querySelector('.hub-tab[data-tab="brand"] .tab-status');
      if (status) status.textContent = fresh.brand ? 'Approved' : 'Not set';
      const counts = await onFormatsChange?.();
      if (!main.isConnected) return;
      const color = counts?.channels?.find((c) => c.id === p.id)?.color ?? (fresh.brand?.brand?.colors?.[0] || null);
      main.querySelector('.hub-top .page-head > .ch-av')?.replaceWith(h(channelAvatar({ name: p.name, color }, 'big')));
    };
    const node = profileSettings({ makeChat, profileId: p.id, onBrandChange });
    body.append(h('<div class="hub-pad"></div>'));
    body.firstElementChild.append(node);
    part = node;
  } else {
    const box = h('<div class="hub-pad"></div>');
    body.append(box);
    part = await renderMemories(box, { profileId: p.id, profileName: p.name });
  }
  return { teardown: () => part?.teardown?.() };
}

// My styles (#/styles). ctx: { tab: 'styles' | 'instructions' | 'memories', counts, onChannelsChange, startVideo,
// formatInfo (STATUS.formatInfo) }.
export async function renderStyles(main, { tab, counts = {}, onChannelsChange, formatInfo = {} }) {
  const sub = { instructions: 'Studio instructions', memories: 'Memories for everything' }[tab] || '';
  document.title = `${sub ? `${sub} · ` : ''}${TERMS.myStyles} · Video Octopus`;
  const [data, projects] = await Promise.all([api('/api/profiles'), api('/api/projects').catch(() => [])]);
  main.replaceChildren(h(`<div class="sty">
    <header class="sty-head">
      ${sub ? `<div class="sty-title"><p class="eyebrow"><a href="#/styles">${TERMS.myStyles}</a></p><h1>${esc(sub)}</h1></div>` : `<h1>${TERMS.myStyles}</h1>`}
      <span class="gap"></span>
      <span data-theme-slot></span>
      ${sub ? '' : `<button type="button" class="btn sty-quiet" data-new-format>New format</button><button type="button" class="btn primary" data-new-style>New style</button>`}
    </header>
    <div class="sty-body" id="styBody"></div>
  </div>`));
  main.querySelector('[data-theme-slot]')?.replaceWith(themeSwitch());
  const body = $('#styBody', main);

  if (tab === 'instructions') {
    const node = instructionSettings();
    body.append(h('<p class="sty-intro">Shared by every style: how your agent should work on every video. Brand identity belongs to each style’s Brand tab.</p>'), node);
    return { teardown: () => node.teardown?.() };
  }
  if (tab === 'memories') return renderMemories(body, { scope: 'global' });

  const created = (p) => { location.hash = channelHref(p.id, 'formats'); };
  main.querySelector('[data-new-style]').onclick = () => newChannelDialog({ onCreated: created });
  main.querySelector('[data-new-format]').onclick = () => newFormatDialog({
    profiles: data.profiles, onCreated: (f, profileId) => { location.hash = channelHref(profileId || f.profileId, 'formats', { format: f.id }); },
  });
  const summaries = new Map((counts.channels || []).map((c) => [c.id, c]));
  const versionNumber = (id) => data.versions?.find((v) => v.id === id)?.number;
  // What a format's tile says about its video setup, in a word or two ("Long · on camera · skill v2").
  const SETUP_WORDS = { tutorial: 'on camera', faceless: 'voiceover', short: 'vertical', explainer: 'product explainer' };
  const setupName = (type) => SETUP_WORDS[type] || videoSetups.find((x) => x.id === type)?.name || type;
  const tall = (type) => (formatInfo[type]?.aspect || (type === 'short' ? '9:16' : '16:9')) === '9:16';
  const formatTile = (p, f) => {
    const n = versionNumber(f.activeVersion);
    const meta = [tall(f.type) ? 'Short' : 'Long', setupName(f.type),
      f.targetSeconds ? `${Math.round(f.targetSeconds / 60) || 1} min` : '', f.activeVersion ? `skill v${n ?? ''}`.trim() : 'basic'].filter(Boolean);
    return `<a class="sty-tile${f.archived ? ' archived' : ''}" href="${channelHref(p.id, 'formats', { format: f.id })}">
      <span class="sty-prev"><span class="sty-frame ${tall(f.type) ? 'tall' : 'wide'}" aria-hidden="true"><i></i></span>${f.archived ? '<span class="pv-badge">Archived</span>' : ''}</span>
      <span class="sty-tile-t"><b>${esc(f.name)}</b><span class="sty-meta">${esc([...new Set(meta)].join(' · '))}</span></span>
    </a>`;
  };
  let showArchived = false;
  const draw = () => {
    const list = data.profiles.filter((p) => showArchived || !p.archived);
    const archivedCount = data.profiles.filter((p) => p.archived).length;
    const sections = list.map((p) => {
      const s = summaries.get(p.id);
      const color = s?.color ?? (p.brand?.brand?.colors?.[0] || null);
      const formats = data.formats.filter((f) => f.profileId === p.id && (showArchived || !f.archived));
      const videos = projects.filter((x) => x.profileId === p.id).length;
      const line = p.description || [plural(videos, 'video'), p.brand ? 'brand approved' : 'no brand yet'].join(' · ');
      return `<section class="sty-group${p.archived ? ' archived' : ''}" aria-labelledby="sty-${esc(p.id)}">
        <div class="sty-gh">
          <a href="${channelHref(p.id)}" tabindex="-1" aria-hidden="true">${channelAvatar({ name: p.name, color }, 'mid')}</a>
          <div class="sty-gt"><h2 id="sty-${esc(p.id)}"><a href="${channelHref(p.id)}">${esc(p.name)}</a>${p.archived ? ' <span class="badge">Archived</span>' : ''}</h2>
            <span class="sty-meta">${esc(line)}</span></div>
          <a class="sty-link" href="${channelHref(p.id, 'brand')}">${p.brand ? 'Brand, research &amp; assets' : 'Add a brand'}</a>
        </div>
        <div class="sty-tiles">
          ${formats.map((f) => formatTile(p, f)).join('')}
          ${p.archived ? '' : `<button type="button" class="sty-tile sty-add" data-add-format="${esc(p.id)}"><span class="sty-prev">${icon('plus', 18)}<b>Add a format</b></span></button>`}
        </div>
      </section>`;
    }).join('');
    const pendingGlobal = counts.waiting?.memories || 0;
    body.replaceChildren(h(`<div class="sty-page">
      <p class="sty-intro">A style is a folder for one way you make videos: its brand, research, assets and memories, plus the formats inside it. Call it whatever you like. A video can use a style, or none.</p>
      ${data.profiles.length ? '' : `<div class="sty-first"><b>Create your first style</b><span class="sty-meta">For example “Tutorials” or “Camping Instagram”. Add its formats next.</span><button type="button" class="btn primary" data-first>New style</button></div>`}
      ${sections}
      ${archivedCount ? `<label class="learn-check sty-archived"><input type="checkbox" data-archived${showArchived ? ' checked' : ''}> Show archived (${archivedCount})</label>` : ''}
      <section class="sty-shared" aria-labelledby="styShared">
        <h2 id="styShared">Shared by all styles</h2>
        <a class="sty-row" href="#/styles/instructions"><span><b>Studio instructions</b> <span class="sty-meta">· how your agent should work on every video</span></span><span class="sty-go">Edit</span></a>
        <a class="sty-row" href="#/styles/memories"><span><b>Memories for everything</b> <span class="sty-meta">· preferences for every style</span></span>${pendingGlobal ? `<span class="pill accent">${pendingGlobal} to review</span>` : '<span class="sty-go">Open</span>'}</a>
      </section>
    </div>`));
    body.querySelector('[data-first]')?.addEventListener('click', () => newChannelDialog({ onCreated: created }));
    for (const b of body.querySelectorAll('[data-add-format]')) {
      b.onclick = () => newFormatDialog({ profiles: data.profiles, profileId: b.dataset.addFormat,
        onCreated: (f) => { location.hash = channelHref(b.dataset.addFormat, 'formats', { format: f.id }); } });
    }
    const toggle = body.querySelector('[data-archived]');
    if (toggle) toggle.onchange = () => { showArchived = toggle.checked; draw(); };
  };
  draw();
  return { teardown() {} };
}

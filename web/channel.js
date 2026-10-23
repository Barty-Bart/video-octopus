// My style (Direction A, artboards 2 and 6): the channel hub (#/channel/<id>/<tab>) with its Formats, Brand and
// Memories tabs, and All channels (#/channels[/instructions|/memories]).
import { $, esc, h, api, toast } from './ui.js';
import { channelHref } from './nav.js';
import { channelAvatar } from './shell.js';
import {
  renderLearning, channelMenuItems, newChannelDialog, newFormatDialog, archiveChannel, showMenu,
  rememberedChannel, rememberChannel,
} from './learning.js';
import { profileSettings, instructionSettings } from './profiles.js';
import { renderMemories } from './memory.js';

const DOTS = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>';
const TAB_NAMES = { formats: 'Formats', brand: 'Brand', memories: 'Memories' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// `_` → a real channel id: from the format, session, chat or scope in the query, else the remembered channel, else
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
      // No channel to show: All channels (its Memories for a memory link without a channel).
      location.replace(tab === 'memories' ? '#/channels/memories' : '#/channels');
      return null;
    }
    id = resolved;
    const kept = new URLSearchParams(query);
    kept.delete('scope'); // a scope only picked the channel; the tab shows the channel's whole level
    history.replaceState(null, '', channelHref(id, tab, Object.fromEntries(kept)));
  }

  const p = data.profiles.find((x) => x.id === id);
  if (!p) {
    document.title = 'Channel not found · Video Octopus';
    main.replaceChildren(h(`<div class="home-wrap"><div class="empty"><b>This channel doesn’t exist</b><span class="sub">It may have been removed from this studio.</span><a class="btn" href="#/channels">All channels</a></div></div>`));
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
          <p class="eyebrow">Channel · <a href="#/?channel=${encodeURIComponent(p.id)}">${plural(videos, 'video')}</a></p>
          <h1>${esc(p.name)}</h1>
        </div>
        <div class="ph-actions">
          <button type="button" class="btn primary" data-hub="new"${p.archived ? ' disabled title="Restore the channel to make new videos"' : ''}>New video</button>
          <button type="button" class="btn icon-btn" data-hub="menu" aria-haspopup="menu" aria-expanded="false" aria-label="Options for ${esc(p.name)}">${DOTS}</button>
        </div>
      </div>
      ${p.archived ? `<div class="notice hub-archived"><span>This channel is archived. It is hidden from New video. Nothing was deleted.</span><button type="button" class="btn small" data-hub="restore">Restore</button></div>` : ''}
      <nav class="hub-tabs scroll-row" aria-label="${esc(p.name)} sections">
        ${tabs.map(([key, label, extra]) => `<a class="hub-tab${key === tab ? ' on' : ''}" data-tab="${key}" href="${channelHref(p.id, key)}"${key === tab ? ' aria-current="page"' : ''}>${label}${extra}</a>`).join('')}
      </nav>
    </div>
    <div class="hub-body" id="hubBody"></div>
  </div>`));

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

// All channels. ctx: { tab, counts, onChannelsChange }.
export async function renderChannels(main, { tab, onChannelsChange }) {
  document.title = `${tab === 'channels' ? 'All channels' : tab === 'instructions' ? 'Instructions' : 'Memories'} · My style · Video Octopus`;
  const tabs = [['channels', 'Channels', '#/channels'], ['instructions', 'Instructions', '#/channels/instructions'], ['memories', 'Memories', '#/channels/memories']];
  main.replaceChildren(h(`<div class="hub">
    <div class="hub-top">
      <div class="page-head">
        <div class="ph-title"><p class="eyebrow">My style</p><h1>All channels</h1></div>
        <div class="ph-actions"><button type="button" class="btn primary" data-new-channel>+ New channel</button></div>
      </div>
      <nav class="hub-tabs scroll-row" aria-label="All channels sections">
        ${tabs.map(([key, label, href]) => `<a class="hub-tab${key === tab ? ' on' : ''}" href="${href}"${key === tab ? ' aria-current="page"' : ''}>${label}</a>`).join('')}
      </nav>
    </div>
    <div class="hub-body"><div class="hub-pad" id="chBody"></div></div>
  </div>`));
  const body = $('#chBody', main);
  const created = (p) => { location.hash = channelHref(p.id, 'formats'); };
  main.querySelector('[data-new-channel]').onclick = () => newChannelDialog({ onCreated: created });

  if (tab === 'instructions') {
    const card = h(`<section class="vo-card instructions-card"><p class="sub">Shared by every channel. Brand identity belongs to each channel’s Brand tab.</p></section>`);
    const node = instructionSettings();
    card.append(node);
    body.append(card);
    return { teardown: () => node.teardown?.() };
  }
  if (tab === 'memories') return renderMemories(body, { scope: 'global' });

  const [data, projects] = await Promise.all([api('/api/profiles'), api('/api/projects').catch(() => [])]);
  let showArchived = false;
  const draw = () => {
    const list = data.profiles.filter((p) => showArchived || !p.archived);
    const archivedCount = data.profiles.filter((p) => p.archived).length;
    if (!data.profiles.length) {
      body.replaceChildren(h(`<div class="vo-card ch-first"><h2>Create a channel to begin</h2><p class="sub">A channel is a YouTube channel, brand or series. Each one has its own formats, brand and memories.</p><div><button type="button" class="btn primary" data-first>+ New channel</button></div></div>`));
      body.querySelector('[data-first]').onclick = () => newChannelDialog({ onCreated: created });
      return;
    }
    const cards = list.map((p) => {
      const formats = data.formats.filter((f) => f.profileId === p.id && !f.archived).length;
      const videos = projects.filter((x) => x.profileId === p.id).length;
      return `<a class="vo-card ch-card${p.archived ? ' archived' : ''}" href="${channelHref(p.id)}">
        ${channelAvatar({ name: p.name, color: p.brand?.brand?.colors?.[0] || null }, 'big')}
        <span class="ch-card-t"><b>${esc(p.name)}</b><span class="sub">${plural(formats, 'format')} · ${plural(videos, 'video')} · Brand ${p.brand ? 'approved' : 'not set'}</span></span>
        ${p.archived ? '<span class="badge">Archived</span>' : ''}
      </a>`;
    }).join('');
    body.replaceChildren(h(`<div class="ch-list">
      <div class="ch-tools"><span class="sub">${plural(list.length, 'channel')}</span>${archivedCount ? `<label class="learn-check"><input type="checkbox" data-archived${showArchived ? ' checked' : ''}> Show archived (${archivedCount})</label>` : ''}</div>
      <div class="ch-grid">${cards}</div>
    </div>`));
    const toggle = body.querySelector('[data-archived]');
    if (toggle) toggle.onchange = () => { showArchived = toggle.checked; draw(); };
  };
  draw();
  return { teardown() {} };
}

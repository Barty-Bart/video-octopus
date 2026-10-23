// The app shell (Direction A, artboard 1): the sidebar every non-project, non-Settings page shares.
// New video · Make (Projects, Recordings) · My style (All channels, one row per channel) · Assets (Library) ·
// Automation (Skills, Scheduled) · Settings · the agent card. At 980px and narrower it becomes a top bar with a Menu
// button that opens the same sidebar as a drawer.
import { $, esc, h } from './ui.js';
import { channelHref } from './nav.js';

const svg = (body) => `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
export const SHELL_ICON = {
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  projects: svg('<rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/>'),
  recordings: svg('<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2.3" class="fill"/>'),
  channels: svg('<rect x="2" y="2.5" width="12" height="3.5" rx="1"/><rect x="2" y="7.25" width="12" height="3.5" rx="1"/><path d="M4 13.5h8"/>'),
  library: svg('<path d="M2 4.5h4.2l1.4 1.5H14v6.5a1 1 0 01-1 1H3a1 1 0 01-1-1z"/>'),
  skills: svg('<path d="M8 2l1.6 3.7L13.5 6l-3 2.6.9 3.9L8 10.5 4.6 12.5l.9-3.9-3-2.6 3.9-.3z"/>'),
  scheduled: svg('<circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.5v3l2 1.5M6 1.5h4"/>'),
  menu: svg('<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>'),
  close: svg('<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>'),
};

// Text on a channel colour: white or near-black, whichever reads better (WCAG contrast). The theme's --text can't be
// used here: it turns light in the dark looks, while the brand colour stays the same.
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
export function avatarInk(hex) {
  const l = luminance(hex);
  const onWhite = 1.05 / (l + 0.05), onDark = (l + 0.05) / (luminance('#141416') + 0.05);
  return onWhite >= onDark ? '#ffffff' : '#141416';
}
// An 18px (or larger) rounded square with the channel's initial: its approved brand colour, else a quiet token.
export function channelAvatar(channel, size = '') {
  const initial = esc((channel?.name || '?').trim().slice(0, 1).toUpperCase() || '?');
  const color = /^#[0-9a-f]{6}$/i.test(channel?.color || '') ? channel.color : null;
  const style = color ? ` style="background:${color};color:${avatarInk(color)}"` : '';
  return `<span class="ch-av${size ? ` ${size}` : ''}${color ? ' branded' : ''}" aria-hidden="true"${style}>${initial}</span>`;
}

const PAGE_NAMES = { projects: 'Projects', recordings: 'Recordings', library: 'Library', skills: 'Skills', scheduled: 'Scheduled', channels: 'All channels' };

// active: { page, channelId }. counts: /api/app/counts (with `channels`). settingsLink: homeNav(counts) markup.
export function sidebarMarkup({ active, counts = {}, projects = [], takes = [], settingsLink = '', agentCard = '' }) {
  const channels = counts.channels || [];
  const fresh = takes.filter((t) => !t.used).length;
  const item = (key, href, label, icon, extra = '') => {
    const on = active.page === key;
    return `<a class="nav-i${on ? ' on' : ''}" href="${href}"${on ? ' aria-current="page"' : ''}>${icon}<span class="ni-t">${esc(label)}</span>${extra}</a>`;
  };
  const count = (n, title = '') => (n ? `<span class="n"${title ? ` title="${esc(title)}"` : ''}>${n}</span>` : '');
  const group = (id, label, body, tools = '') => `<div class="nav-g" role="group" aria-labelledby="ng-${id}">
      <div class="nav-gh"><span class="nav-gl" id="ng-${id}">${label}</span>${tools}</div>${body}</div>`;
  const channelRow = (c) => {
    const on = active.page === 'channel' && active.channelId === c.id;
    const pending = c.pendingMemories ? `<span class="nav-dot" title="${c.pendingMemories} memor${c.pendingMemories === 1 ? 'y' : 'ies'} to review"><span class="vh">${c.pendingMemories} to review</span></span>` : '';
    return `<a class="nav-i ch-row${on ? ' on' : ''}" href="${channelHref(c.id)}"${on ? ' aria-current="page"' : ''}>${channelAvatar(c)}<span class="ni-t">${esc(c.name)}</span>${pending}<span class="n" title="${c.formats} format${c.formats === 1 ? '' : 's'}">${c.formats}</span></a>`;
  };
  const recordingsExtra = fresh
    ? `<span class="pill accent" title="${fresh} take${fresh === 1 ? '' : 's'} not in a project yet">${fresh} new</span>`
    : count(takes.length);
  return `<nav class="side-nav shell-nav" id="shellNav" aria-label="Video Octopus">
      <div class="shell-nav-top">
        <a class="brand" href="#/"><span class="logo" aria-hidden="true"><i></i></span>Video Octopus</a>
        <button type="button" class="btn icon-btn shell-close" data-shell-close aria-label="Close menu">${SHELL_ICON.close}</button>
      </div>
      <button type="button" class="btn primary wide shell-new" data-shell-new>${SHELL_ICON.plus}<span>New video</span></button>
      ${group('make', 'Make', item('projects', '#/', 'Projects', SHELL_ICON.projects, count(projects.length)) + item('recordings', '#/recordings', 'Recordings', SHELL_ICON.recordings, recordingsExtra))}
      ${group('style', 'My style', item('channels', '#/channels', 'All channels', SHELL_ICON.channels) + `<div data-channel-rows>${channels.map(channelRow).join('')}</div>`,
        `<button type="button" class="nav-add" data-shell-add aria-label="Add a channel" title="Add a channel">${SHELL_ICON.plus}</button>`)}
      ${group('assets', 'Assets', item('library', '#/library', 'Library', SHELL_ICON.library, count(counts.inbox, counts.inbox ? `${counts.inbox} waiting in the inbox` : '')))}
      ${group('auto', 'Automation', item('skills', '#/skills', 'Skills', SHELL_ICON.skills, counts.skillUpdates > 0 ? `<span class="nav-dot" title="${counts.skillUpdates} core update${counts.skillUpdates === 1 ? '' : 's'} to review"><span class="vh">Updates to review</span></span>` : '')
        + item('scheduled', '#/scheduled', 'Scheduled', SHELL_ICON.scheduled, count(counts.schedules)))}
      <span class="gap"></span>
      ${settingsLink}
      ${agentCard}
    </nav>`;
}

// The narrow top bar (≤ 980px): logo, the page's name and the Menu button.
export function topBarMarkup(pageName) {
  return `<header class="shell-top">
      <a class="brand" href="#/" aria-label="Video Octopus, all projects"><span class="logo" aria-hidden="true"><i></i></span></a>
      <span class="shell-page">${esc(pageName)}</span>
      <button type="button" class="btn shell-menu" data-shell-menu aria-expanded="false" aria-controls="shellNav">${SHELL_ICON.menu}<span>Menu</span></button>
    </header>
    <div class="shell-scrim" data-shell-scrim hidden></div>`;
}
export const pageName = (active, channelName) => (active.page === 'channel' ? channelName || 'Channel' : PAGE_NAMES[active.page] || 'Projects');

// The drawer: Menu opens it over a scrim, focus moves in; Esc, the scrim, Close or following a link closes it and
// focus returns to Menu. Returns { teardown }.
export function wireShell(el, { onNewVideo, onAddChannel }) {
  const nav = $('#shellNav', el), menu = $('[data-shell-menu]', el), scrim = $('[data-shell-scrim]', el);
  const isOpen = () => el.classList.contains('drawer-open');
  const open = () => {
    el.classList.add('drawer-open');
    scrim.hidden = false;
    menu.setAttribute('aria-expanded', 'true');
    (nav.querySelector('[aria-current="page"]') || nav.querySelector('a,button'))?.focus();
  };
  const close = (restore = true) => {
    if (!isOpen()) return;
    el.classList.remove('drawer-open');
    scrim.hidden = true;
    menu.setAttribute('aria-expanded', 'false');
    if (restore) menu.focus();
  };
  const key = (e) => { if (e.key === 'Escape' && isOpen()) { e.preventDefault(); close(); } };
  menu.onclick = () => (isOpen() ? close() : open());
  scrim.onclick = () => close();
  $('[data-shell-close]', el).onclick = () => close();
  nav.addEventListener('click', (e) => { if (e.target.closest('a[href]')) close(false); });
  $('[data-shell-new]', el).onclick = () => { close(false); onNewVideo(); };
  $('[data-shell-add]', el).onclick = () => { close(false); onAddChannel(); };
  document.addEventListener('keydown', key);
  return { teardown: () => document.removeEventListener('keydown', key) };
}

// Redraws the channel rows (after a format is made or archived) without touching the rest of the page.
export function updateChannelRows(el, counts, active) {
  const box = $('[data-channel-rows]', el);
  if (!box) return;
  const fresh = h(sidebarMarkup({ active, counts }));
  box.replaceWith($('[data-channel-rows]', fresh));
}

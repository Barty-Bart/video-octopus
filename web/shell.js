// The app shell (design V2 §2): the rail every non-project page shares, Settings included.
// Top to bottom: logo · New video · Projects · Recordings · ─ · My styles · ─ · Tools: Library, Skills, Scheduled ·
// Ask Claude (⌘J) · Settings · the collapse toggle. Two widths: icons only (68px) or icons and names (232px),
// settings appearance.sidebar, mirrored in localStorage so the early script in index.html sets <html data-rail>
// before the first paint. At 980px and narrower it becomes a top bar with a Menu button that opens the rail, with
// names, as a drawer over a scrim.
import { $, esc } from './ui.js';
import { icon } from './icons.js';
import { TERMS } from './terms.js';
import { currentAppearance, onAppearance, saveAppearance } from './appearance.js';

const RAIL_ICON = 18;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
export const ASK_KEYS = isMac ? '⌘J' : 'Ctrl J';

// Text on a channel colour: white or near-black, whichever reads better (WCAG contrast). The theme's --text can't be
// used here: it turns light in the dark theme, while the brand colour stays the same.
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

const PAGE_NAMES = {
  projects: 'Projects', recordings: 'Recordings', library: 'Library', skills: 'Skills', scheduled: 'Scheduled',
  styles: TERMS.myStyles, settings: 'Settings',
};

// The Ask Claude button's tooltip: the agent and, on a Claude plan, its usage (the old sidebar card's contents).
// agent: { ok, name, sub, usage: '5h 20% · 7d 41%' | '' }.
export function askTip(agent) {
  if (!agent) return `Ask Claude (${ASK_KEYS})`;
  const bits = [agent.name, agent.sub, agent.usage].filter(Boolean).join(' · ');
  return `Ask Claude (${ASK_KEYS})${bits ? ` — ${bits}` : ''}`;
}

// active: { page }. counts: /api/app/counts. takes: /api/takes. agent: see askTip. forceIcons: Settings keeps the rail
// as icons whatever the preference (and hides the toggle, since the preference is a setting on that page).
export function sidebarMarkup({ active, counts = {}, takes = [], agent = null, forceIcons = false }) {
  const freshTakes = takes.filter((t) => !t.used).length;
  const dot = (title, kind = '') => `<span class="nav-dot${kind ? ` ${kind}` : ''}" title="${esc(title)}"><span class="vh">${esc(title)}</span></span>`;
  const item = (key, href, label, name, extra = '') => {
    const on = active.page === key;
    return `<a class="nav-i${on ? ' on' : ''}" href="${href}" data-tip="${esc(label)}"${on ? ' aria-current="page"' : ''}>`
      + `${icon(name, RAIL_ICON)}<span class="ni-t">${esc(label)}</span>${extra}</a>`;
  };
  const recordingsDot = freshTakes
    ? dot(`${freshTakes} new take${freshTakes === 1 ? '' : 's'} not in a project yet`) : '';
  const libraryDot = counts.inbox ? dot(`${counts.inbox} waiting in the inbox`) : '';
  const skillsDot = counts.skillUpdates > 0
    ? dot(`${counts.skillUpdates} core update${counts.skillUpdates === 1 ? '' : 's'} to review`) : '';
  const settingsDot = counts.update ? dot('A new version of Video Octopus is ready (Settings › General › Updates)') : '';
  const askWarn = agent && !agent.ok ? dot(`${agent.name || 'The agent'}: ${agent.sub || 'needs attention'}`, 'warn') : '';
  const stylesOn = active.page === 'styles' || active.page === 'style';
  const expanded = !forceIcons && currentAppearance().sidebar !== 'icons';
  return `<nav class="side-nav shell-nav${forceIcons ? ' force-icons' : ''}" id="shellNav" aria-label="Video Octopus">
      <div class="shell-nav-top">
        <a class="brand" href="#/" aria-label="Video Octopus, all projects"><span class="logo" aria-hidden="true"><i></i></span><span class="ni-t brand-t">Video Octopus</span></a>
        <button type="button" class="btn icon-btn shell-close" data-shell-close aria-label="Close menu">${icon('close')}</button>
      </div>
      <button type="button" class="nav-i shell-new" data-shell-new data-tip="New video">${icon('plus', RAIL_ICON)}<span class="ni-t">New video</span></button>
      ${item('projects', '#/', 'Projects', 'projects')}
      ${item('recordings', '#/recordings', 'Recordings', 'recordings', recordingsDot)}
      <hr class="nav-sep">
      <a class="nav-i${stylesOn ? ' on' : ''}" href="#/styles" data-tip="${esc(TERMS.myStyles)}"${stylesOn ? ' aria-current="page"' : ''}>${icon('layers', RAIL_ICON)}<span class="ni-t">${esc(TERMS.myStyles)}</span></a>
      <hr class="nav-sep">
      <div class="nav-gl" aria-hidden="true">Tools</div>
      ${item('library', '#/library', 'Library', 'library', libraryDot)}
      ${item('skills', '#/skills', 'Skills', 'skills', skillsDot)}
      ${item('scheduled', '#/scheduled', 'Scheduled', 'scheduled')}
      <span class="gap"></span>
      <button type="button" class="nav-i ask" data-open-assistant data-tip="${esc(askTip(agent))}" data-tip-always>${icon('claude', RAIL_ICON)}<span class="ni-t">Ask Claude</span><kbd class="ni-k">${ASK_KEYS}</kbd>${askWarn}</button>
      ${item('settings', '#/settings', 'Settings', 'settings', settingsDot)}
      <button type="button" class="nav-i shell-toggle" data-shell-toggle aria-expanded="${expanded}" aria-label="${expanded ? 'Collapse sidebar' : 'Expand sidebar'}" data-tip="Expand sidebar">${icon('sidebar', RAIL_ICON)}<span class="ni-t">Collapse</span></button>
    </nav>`;
}

// The narrow top bar (≤ 980px): logo, the page's name and the Menu button.
export function topBarMarkup(pageName) {
  return `<header class="shell-top">
      <a class="brand" href="#/" aria-label="Video Octopus, all projects"><span class="logo" aria-hidden="true"><i></i></span></a>
      <span class="shell-page">${esc(pageName)}</span>
      <button type="button" class="btn shell-menu" data-shell-menu aria-expanded="false" aria-controls="shellNav">${icon('menu')}<span>Menu</span></button>
    </header>
    <div class="shell-scrim" data-shell-scrim hidden></div>`;
}
export const pageName = (active, styleName) => (active.page === 'style' ? styleName || TERMS.channel : PAGE_NAMES[active.page] || 'Projects');

// The rail's tooltips: with icons only, every item names itself on hover and keyboard focus; Ask Claude always shows
// its agent and usage. One floating label on <body>, so the rail's own scrolling never clips it.
let tipEl = null;
function showTip(target) {
  const nav = target.closest('.shell-nav');
  const iconsOnly = nav?.classList.contains('force-icons') || document.documentElement.dataset.rail === 'icons';
  if (!target.hasAttribute('data-tip-always') && !iconsOnly) return hideTip();
  if (innerWidth <= 980) return hideTip(); // the drawer always shows names
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'rail-tip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.id = 'railTip';
    document.body.append(tipEl);
  }
  tipEl.textContent = target.dataset.tip;
  tipEl.hidden = false;
  const r = target.getBoundingClientRect();
  tipEl.style.left = `${Math.round(r.right + 10)}px`;
  tipEl.style.top = `${Math.round(r.top + r.height / 2)}px`;
}
function hideTip() { if (tipEl) tipEl.hidden = true; }

// The drawer and the rail's controls: Menu opens the drawer over a scrim, focus moves in; Esc, the scrim, Close or
// following a link closes it and focus returns to Menu. The foot toggle switches icons ⇄ icons and names and saves it.
// Returns { teardown }.
export function wireShell(el, { onNewVideo }) {
  const nav = $('#shellNav', el), menu = $('[data-shell-menu]', el), scrim = $('[data-shell-scrim]', el);
  const toggle = $('[data-shell-toggle]', el);
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
  nav.addEventListener('click', (e) => {
    hideTip();
    if (e.target.closest('a[href]') || e.target.closest('[data-open-assistant]')) close(false);
  });
  $('[data-shell-new]', el).onclick = () => { close(false); onNewVideo(); };
  const paintToggle = () => {
    const expanded = currentAppearance().sidebar !== 'icons';
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', expanded ? 'Collapse sidebar' : 'Expand sidebar');
  };
  toggle.onclick = () => {
    hideTip();
    saveAppearance({ sidebar: currentAppearance().sidebar === 'icons' ? 'labels' : 'icons' });
  };
  const offAppearance = onAppearance(paintToggle);
  const over = (e) => { const t = e.target.closest?.('[data-tip]'); if (t) showTip(t); };
  const out = (e) => { if (!e.relatedTarget || !nav.contains(e.relatedTarget)) hideTip(); };
  nav.addEventListener('pointerover', over);
  nav.addEventListener('focusin', over);
  nav.addEventListener('pointerleave', hideTip);
  nav.addEventListener('focusout', out);
  nav.addEventListener('scroll', hideTip, { passive: true });
  document.addEventListener('keydown', key);
  return {
    teardown: () => {
      document.removeEventListener('keydown', key);
      offAppearance();
      hideTip();
    },
  };
}

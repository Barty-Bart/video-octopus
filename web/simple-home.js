// Simple mode's shell pages (V1 spec §2, board "V1 Projects"): Projects with + New video ▾ top right (a dropdown under
// the button, right-aligned, never a centred dialog: YouTube video, Reel or Short, Audio only, then Start), a plain
// grid of projects ("YouTube · Rough cut · 2 h ago"), no filters. The Resources page is web/resources-page.js.
// Advanced keeps web/projects-home.js. The page draws from what app.js already loaded.
import { $, esc, h, api, ago, toast } from './ui.js';
import { icon } from './icons.js';
import { SHAPES, SHAPE_KEYS, shapeOfType, simpleStageOf, ADVANCED_NOTE } from './simple.js';
import { thumbUrl, wireThumb } from './projects-home.js';
import { profileCards } from './simple-profiles.js';

const pic = (p) => `<img alt="" decoding="async" loading="lazy" src="${thumbUrl(p)}"><span class="pv-ph" aria-hidden="true">${icon('recordings', 22)}</span>`;

// The little picture on each New video choice: a 16:9 frame, a 9:16 frame or a waveform.
const GLYPH = {
  youtube: '<span class="nv-frame wide"></span>',
  reel: '<span class="nv-frame tall"></span>',
  audio: `<span class="nv-wave">${[10, 20, 30, 16, 26, 12, 18].map((n) => `<i style="height:${n}px"></i>`).join('')}</span>`,
};

// + New video ▾ and its menu. onStart(shape) makes the video (app.js newVideo({ shape, record: true })).
// Returns { el, open(), close() }. The last choice is preselected (settings lastSimpleVideo, /api/status editor.lastShape).
export function newVideoButton({ lastShape = 'youtube', onStart }) {
  let pick = SHAPES[lastShape] ? lastShape : 'youtube';
  const el = h(`<div class="nv">
    <button type="button" class="btn primary nv-btn" aria-haspopup="true" aria-expanded="false" aria-controls="nvMenu">${icon('plus', 14)}New video${icon('chevron', 14)}</button>
    <div class="nv-pop" id="nvMenu" role="group" aria-label="New video" hidden>
      <b class="nv-h">New video</b>
      <div class="nv-picks" role="radiogroup" aria-label="What are you making?">
        ${SHAPE_KEYS.map((k) => `<button type="button" role="radio" class="nv-pick nv-${k}" data-shape="${k}" aria-checked="false">
          <span class="nv-pic" aria-hidden="true">${GLYPH[k]}</span><span class="nv-t"><b>${esc(SHAPES[k].name)}</b><span>${esc(SHAPES[k].sub)}</span></span></button>`).join('')}
      </div>
      <button type="button" class="btn primary nv-start">Start</button>
      <span class="nv-foot">You can change the shape later from the top bar.</span>
    </div>
  </div>`);
  const btn = $('.nv-btn', el), pop = $('.nv-pop', el);
  const paint = () => {
    for (const b of pop.querySelectorAll('.nv-pick')) {
      const on = b.dataset.shape === pick;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  };
  const outside = (e) => { if (!el.contains(e.target)) close(); };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(true); } };
  function open() {
    if (!pop.hidden) return;
    paint();
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    el.addEventListener('keydown', key);
    pop.querySelector('[aria-checked="true"]')?.focus();
  }
  function close(focus = false) {
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    el.removeEventListener('keydown', key);
    if (focus) btn.focus();
  }
  btn.onclick = () => (pop.hidden ? open() : close());
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('.nv-pick');
    if (b) { pick = b.dataset.shape; paint(); }
  });
  // Arrow keys move between the three choices; Enter on one starts it.
  pop.addEventListener('keydown', (e) => {
    const list = [...pop.querySelectorAll('.nv-pick')], i = list.indexOf(document.activeElement);
    if (i < 0) return;
    if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(e.key)) {
      e.preventDefault();
      const next = list[(i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
      pick = next.dataset.shape; paint(); next.focus();
    }
    if (e.key === 'Enter') { e.preventDefault(); pick = list[i].dataset.shape; start(); }
  });
  let busy = false;
  async function start() {
    if (busy) return;
    busy = true;
    $('.nv-start', el).disabled = true;
    try { await onStart(pick); close(); } finally { busy = false; $('.nv-start', el).disabled = false; }
  }
  $('.nv-start', el).onclick = start;
  return { el, open, close, teardown: () => close() };
}

// Projects in Simple. ctx: { projects, notice (HTML: the agent's notice), note (a line to show once: the Advanced
// deep-link note), lastShape, startVideo(shape), openMenu (open the menu at once: #/?new) }. Returns { teardown, openMenu }.
export function renderSimpleProjects(main, ctx) {
  const { projects = [], notice = '', note = '', lastShape, startVideo, openMenu = false, recover } = ctx;
  main.replaceChildren(h(`<div class="pv pv-simple">
    <header class="pv-head"><h1>Projects</h1><span id="nvSlot"></span></header>
    ${note ? `<p class="pv-note" role="status">${esc(note)} <a href="#/settings/general/editor">Open Settings</a></p>` : ''}
    ${notice}
    <div class="take-banners" id="unsaved"></div>
    <section class="pf-sec" aria-labelledby="pfH"><h2 class="res-h" id="pfH">Profiles</h2><div id="pfHost"></div></section>
    <div class="pf-filter" id="pfFilter" role="group" aria-label="Show videos from"></div>
    <div id="grid" class="pv-grid"></div>
  </div>`));
  const menu = newVideoButton({ lastShape, onStart: startVideo });
  $('#nvSlot', main).replaceWith(menu.el);
  const grid = $('#grid', main);
  const tile = (p) => {
    const kind = p.type ? SHAPES[shapeOfType(p.type)].kind : '';
    const pf = p.profile && profiles.find((x) => x.slug === p.profile);
    const meta = [pf ? pf.name : kind, simpleStageOf(p), ago(p.updated)].filter(Boolean).join(' · ');
    const el = h(`<a class="pv-tile" href="#/p/${encodeURIComponent(p.id)}">
      <span class="pv-thumb">${pic(p)}${p.type === 'audio' ? `<span class="pv-audio" aria-hidden="true">${GLYPH.audio}</span>` : ''}</span>
      <span class="pv-tile-t"><b>${esc(p.name)}</b><span class="pv-meta">${esc(meta)}</span></span>
    </a>`);
    wireThumb($('.pv-thumb', el));
    return el;
  };
  const all = projects.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
  // Profiles (web/simple-profiles.js): one card each with its own way in; the chips under them show one profile's videos.
  let profiles = [], only = '';
  const paintGrid = () => {
    const list = only ? all.filter((p) => p.profile === only) : all;
    grid.className = list.length ? 'pv-grid' : 'pv-first-simple';
    if (list.length) grid.replaceChildren(...list.map(tile));
    else grid.replaceChildren(h(only
      ? `<div class="empty"><b>No videos from this profile yet</b><span class="sub">Start one from its card above.</span></div>`
      : `<div class="empty"><b>Make your first video</b><span class="sub">Start one from a profile above, or press + New video and record.</span></div>`));
    const f = $('#pfFilter', main);
    f.hidden = !profiles.length;
    f.innerHTML = profiles.length ? ['', ...profiles.map((p) => p.slug)].map((k) => {
      const name = k ? profiles.find((p) => p.slug === k).name : 'All videos';
      return `<button type="button" class="pf-chip" data-k="${esc(k)}" aria-pressed="${k === only}">${esc(name)}</button>`;
    }).join('') : '';
  };
  $('#pfFilter', main).addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) { only = b.dataset.k; paintGrid(); } });
  const loadProfiles = () => api('/api/simple-profiles').then((r) => {
    profiles = r.profiles || [];
    if (!$('#pfHost', main)) return;
    profileCards($('#pfHost', main), { profiles, open: (vid) => { location.hash = `#/p/${encodeURIComponent(vid)}`; }, changed: loadProfiles });
    paintGrid();
  }).catch(() => {});
  paintGrid();
  loadProfiles();
  // A take the page closed on before it was saved: finish it into its video (the recorder's recovery), as in Advanced.
  if (recover) api('/api/rec-unfinished').then(({ takes: open }) => {
    const box = $('#unsaved', main);
    for (const u of open || []) {
      if (!box?.isConnected) return;
      const b = h(`<div class="take-banner unsaved"><span class="tt"><b>Unsaved recording</b>
        <span class="sub">For ${esc(u.project)} · the page closed before it was saved</span></span>
        <button type="button" class="btn small">Finish it</button></div>`);
      $('button', b).onclick = () => recover(u);
      box.append(b);
    }
  }).catch(() => {});
  if (openMenu) setTimeout(() => menu.open(), 0);
  return { teardown: () => menu.teardown(), openMenu: () => menu.open() };
}

// The line a hidden page's deep link lands with (web/simple.js ADVANCED_NOTE), for app.js.
export { ADVANCED_NOTE };
// Quietly tell the creator when a Simple choice could not start (the server's sentence).
export const startFailed = (e) => toast(e.message);

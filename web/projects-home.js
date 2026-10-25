// Projects home (design V2 §4, board "V2 Projects"): the header (search, theme switch, Record), a Continue hero with
// the project's real frame, a quiet row of "Waiting for you" chips, then every project as a large 16:9 tile (or a
// list), filtered by style or "In progress". The page draws from what app.js already loaded; New video and Record go
// through ctx.newVideo (straight into an "Untitled video", web/app.js).
import { $, esc, h, api, ago } from './ui.js';
import { icon } from './icons.js';
import { themeSwitch } from './appearance.js';
import { styleHref, kitHref } from './nav.js';
import { channelAvatar } from './shell.js';
import { TERMS } from './terms.js';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
export const thumbUrl = (p) => `/api/projects/${encodeURIComponent(p.id)}/thumb?v=${Math.round(p.updated)}`;
const mmss = (s) => {
  const r = Math.round(s);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// A tile's picture fades in when it loads. Without one (no take yet) it stays the dark stage with a quiet glyph:
// never a letter tile. A tall picture (a 9:16 Short) shows whole, on a blurred copy of itself, not cropped to 16:9.
export function wireThumb(box) {
  const img = $('img', box);
  if (!img) return;
  img.onload = () => {
    if (img.naturalHeight > img.naturalWidth * 1.05) { box.classList.add('tall'); box.style.setProperty('--pic', `url("${img.currentSrc || img.src}")`); }
    box.classList.add('in');
  };
  img.onerror = () => { img.remove(); box.classList.add('none'); };
}
const stagePic = (p, lazy = true) => `<img alt="" decoding="async"${lazy ? ' loading="lazy"' : ''} src="${thumbUrl(p)}">`
  + `<span class="pv-ph" aria-hidden="true">${icon('recordings', 22)}</span>`;

// Where a project is: its style (a format, Flat 3) or No style, its stage, when it was edited.
const kitOf = (p) => (p.profileName && p.profileName !== TERMS.noBrand ? p.profileName : '');
const styleOf = (p) => p.formatName || kitOf(p) || TERMS.noStyle; // a video with a kit but no style shows the kit
const stageOf = (p) => (!p.type ? 'Earlier edit' : p.stage || (p.progress && !p.next ? 'Done' : 'Not started'));
const inProgress = (p) => p.app && p.type && Boolean(p.next);

let homeView = (() => { try { return localStorage.getItem('studio.home.view') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } })();
let homeFilter = (() => { try { return localStorage.getItem('studio.home.channel') || 'all'; } catch { return 'all'; } })();

// ctx: { projects, takes, counts, query, notice (HTML, the agent's notice), newVideo(opts), recover(u) }.
// Returns { teardown }.
export function renderProjects(main, ctx) {
  const { projects, takes = [], counts = {}, query = null, notice = '', newVideo, recover } = ctx;
  const styles = counts.channels || []; // brand kits (their colours and memories)
  // The pills: one per style (format) that has videos. #/?style=<id> filters by a style, or by a brand kit's id
  // (beta.14's style addresses were kits; such a filter gets its own pill).
  const used = new Map();
  for (const p of projects) if (p.formatId && !used.has(p.formatId)) used.set(p.formatId, p.formatName || 'Style');
  const fromAddress = query?.get('style') || query?.get('channel');
  if (fromAddress) homeFilter = fromAddress;
  const kitFilter = styles.find((c) => c.id === homeFilter && !used.has(c.id));
  if (!['all', 'progress'].includes(homeFilter) && !used.has(homeFilter) && !kitFilter) homeFilter = 'all';
  // Direction A's #/?channel=<id> is the same filter: the address says style now.
  if (query?.get('channel')) history.replaceState(null, '', homeFilter === 'all' ? '#/' : `#/?style=${encodeURIComponent(homeFilter)}`);
  const resume = projects.filter((p) => p.app).sort((a, b) => b.updated - a.updated)[0] || null;

  const filterButtons = [['all', 'All'], ...[...used].map(([id, name]) => [id, name]), ...(kitFilter ? [[kitFilter.id, kitFilter.name]] : []), ['progress', 'In progress']];
  main.replaceChildren(h(`<div class="pv">
    <header class="pv-head">
      <h1>Projects</h1>
      <label class="pv-search">${icon('search', 14)}<span class="vh">Search projects</span>
        <input id="q" type="search" placeholder="Search anything" autocomplete="off"><kbd aria-hidden="true">${isMac ? '⌘K' : 'Ctrl K'}</kbd></label>
      <span id="themeSlot"></span>
      <button type="button" class="btn pv-quiet" id="recBtn" title="Start a new video and record a take into it"><span class="rec-dot" aria-hidden="true"></span>Record</button>
    </header>
    ${notice}
    <div id="hero"></div>
    <div class="pv-wait" id="waiting" role="group" aria-label="Waiting for you" hidden></div>
    <div class="take-banners" id="unsaved"></div>
    <section class="pv-all" aria-labelledby="pvAll">
      <div class="pv-all-head">
        <h2 id="pvAll">All projects</h2>
        <div class="pv-pills" role="group" aria-label="Show">${filterButtons.map(([k, label]) => `<button type="button" class="pv-pill" data-f="${esc(k)}">${esc(label)}</button>`).join('')}</div>
        <span class="gap"></span><span class="pv-count" id="shown"></span>
        <div class="seg view-seg" role="group" aria-label="Show projects as">
          <button type="button" data-v="grid" aria-label="Tiles" title="Tiles">${icon('projects', 14)}</button>
          <button type="button" data-v="list" aria-label="List" title="List">${icon('menu', 14)}</button>
        </div>
      </div>
      <div id="grid"></div>
    </section>
  </div>`));
  $('#themeSlot', main).replaceWith(themeSwitch());
  $('#recBtn', main).onclick = () => newVideo({ record: true });

  // ---- Continue: the project you were on, on its real frame ----
  const hero = $('#hero', main);
  if (resume) {
    // Every step that must be done is done: the whole bar is done (an optional step left doesn't count).
    const stageCount = resume.stageCount || 0, at = resume.stageIndex || (resume.progress && !resume.next ? stageCount + 1 : 0);
    const bar = stageCount ? Array.from({ length: stageCount }, (_, i) => `<i class="${i + 1 < at ? 'd' : i + 1 === at ? 'n' : ''}"></i>`).join('') : '';
    const where = resume.stage ? `Step ${at} of ${stageCount} · ${resume.stage}` : !resume.hasTake ? 'Not started' : stageOf(resume);
    const el = h(`<section class="pv-hero" aria-labelledby="heroName">
      <span class="pv-hero-pic">${stagePic(resume, false)}</span>
      <div class="pv-hero-body">
        <div class="pv-hero-text">
          <span class="pv-eyebrow">Continue · ${esc(styleOf(resume))}${resume.formatName && kitOf(resume) ? ` · ${esc(kitOf(resume))}` : ''} · edited ${esc(ago(resume.updated))}</span>
          <h2 id="heroName"><a href="#/p/${encodeURIComponent(resume.id)}">${esc(resume.name)}</a></h2>
          <div class="pv-steps">${bar ? `<span class="pv-bar" aria-hidden="true">${bar}</span>` : ''}<span>${esc(where)}</span>
            ${resume.waiting ? `<span class="pv-hero-wait">${plural(resume.waiting, 'change')} waiting</span>` : ''}</div>
        </div>
        <div class="pv-hero-acts">
          ${resume.next ? `<a class="btn pv-next" href="#/p/${encodeURIComponent(resume.id)}">${esc(resume.next)}</a>` : ''}
          <a class="btn pv-open" href="#/p/${encodeURIComponent(resume.id)}">Open</a>
        </div>
      </div>
    </section>`);
    wireThumb($('.pv-hero-pic', el));
    hero.replaceWith(el);
  } else {
    hero.replaceWith(h(`<section class="pv-hero pv-first" aria-labelledby="heroName">
      <span class="pv-hero-pic none"><span class="pv-ph" aria-hidden="true">${icon('recordings', 28)}</span></span>
      <div class="pv-hero-body"><div class="pv-hero-text">
        <span class="pv-eyebrow">Welcome</span>
        <h2 id="heroName">Start your first video</h2>
        <div class="pv-steps"><span>New video opens it straight away. Record, drop footage, or start with an idea.</span></div>
      </div><div class="pv-hero-acts"><button type="button" class="btn pv-next" data-new>New video</button></div></div>
    </section>`));
    $('[data-new]', main).onclick = () => newVideo();
  }

  // ---- Waiting for you: one quiet row of up to three chips, only when something waits ----
  const chips = [];
  const fresh = takes.filter((t) => !t.used);
  if (fresh.length) chips.push(`<a class="pv-chip" href="#/recordings">${icon('recordings', 14)}${plural(fresh.length, 'new take')} not in a video yet</a>`);
  const drafts = counts.waiting?.drafts;
  if (drafts?.count) chips.push(`<a class="pv-chip" href="${drafts.formatId ? styleHref(drafts.formatId, 'skill') : '#/styles'}">${icon('layers', 14)}${plural(drafts.count, 'style draft')} to review</a>`);
  const memories = (counts.waiting?.memories || 0) + styles.reduce((n, c) => n + (c.pendingMemories || 0), 0);
  if (memories) {
    const one = styles.find((c) => c.pendingMemories);
    const href = !counts.waiting?.memories && one ? kitHref(one.id, 'memories') : '#/styles/memories';
    chips.push(`<a class="pv-chip" href="${href}">${icon('skills', 14)}${plural(memories, 'memory')} to review</a>`);
  }
  if (chips.length) {
    const row = $('#waiting', main);
    row.innerHTML = `<span class="pv-wait-l">Waiting for you</span>${chips.slice(0, 3).join('')}`;
    row.hidden = false;
  }
  // A take the page closed on before it was saved: finish it into its video (the recorder's recovery).
  api('/api/rec-unfinished').then(({ takes: open }) => {
    const box = $('#unsaved', main);
    for (const u of open || []) {
      if (!box) return;
      const b = h(`<div class="take-banner unsaved"><span class="tt"><b>Unsaved take · ${esc(new Date(u.started).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}</b>
        <span class="sub">For ${esc(u.project)} · about ${mmss(u.seconds || 0)} · the page closed before it was saved</span></span>
        <button type="button" class="btn small" title="Make the take files from what was recorded and add the take to its video">Finish it</button></div>`);
      $('button', b).onclick = () => recover(u);
      box.append(b);
    }
  }).catch(() => {});

  // ---- All projects ----
  const grid = $('#grid', main), q = $('#q', main);
  const durations = new Map(); // project id -> "4:12" (the locked cut, else the take), filled in as tiles show
  const wantLength = (p, box) => {
    if (!p.hasTake) return;
    const paint = (text) => { const d = $('.pv-dur', box); if (d && text) { d.textContent = text; d.hidden = false; } };
    if (durations.has(p.id)) return paint(durations.get(p.id));
    durations.set(p.id, '');
    api(`/api/projects/${encodeURIComponent(p.id)}/summary`).then((m) => {
      const text = m.length ? mmss(m.length) : '';
      durations.set(p.id, text);
      if (box.isConnected) paint(text);
    }).catch(() => {});
  };
  const tile = (p) => {
    const meta = [styleOf(p), stageOf(p), ago(p.updated)].join(' · ');
    const el = h(`<a class="pv-tile" href="#/p/${encodeURIComponent(p.id)}">
      <span class="pv-thumb">${stagePic(p)}${p.exported ? '<span class="pv-badge">Exported</span>' : ''}<span class="pv-dur" hidden></span></span>
      <span class="pv-tile-t"><b>${esc(p.name)}</b><span class="pv-meta">${esc(meta)}</span></span>
    </a>`);
    wireThumb($('.pv-thumb', el));
    wantLength(p, el);
    return el;
  };
  const row = (p) => {
    const el = h(`<a class="pv-row" href="#/p/${encodeURIComponent(p.id)}">
      <span class="pv-thumb">${stagePic(p)}</span>
      <span class="pv-row-name"><b>${esc(p.name)}</b><span class="pv-meta">${esc(p.type ? STATUS_TYPES[p.type] || '' : '')}</span></span>
      <span class="pv-row-style">${p.profileId ? channelAvatar({ name: p.profileName, color: styles.find((c) => c.id === p.profileId)?.color }) : ''}${esc(styleOf(p))}</span>
      <span class="pv-row-stage${p.next ? ' next' : ''}">${esc(p.next ? `Next: ${p.next}` : stageOf(p))}${p.waiting ? ` · ${plural(p.waiting, 'change')} waiting` : ''}</span>
      <span class="pv-meta">${esc(ago(p.updated))}</span>
    </a>`);
    wireThumb($('.pv-thumb', el));
    return el;
  };
  const newTile = () => {
    const b = h(`<button type="button" class="pv-tile pv-new"><span class="pv-thumb">${icon('plus', 20)}<b>New video</b></span>
      <span class="pv-tile-t"><span class="pv-meta">Opens straight away. Pick a style any time.</span></span></button>`);
    b.onclick = () => newVideo();
    return b;
  };
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const shows = (p) => (homeFilter === 'all' || (homeFilter === 'progress' ? inProgress(p) : p.formatId === homeFilter || p.profileId === homeFilter))
      && (!term || p.name.toLowerCase().includes(term) || p.id.includes(term) || [p.profileName, p.formatName].some((x) => (x || '').toLowerCase().includes(term)));
    const list = projects.filter(shows);
    for (const b of main.querySelectorAll('.pv-pill')) b.setAttribute('aria-pressed', String(b.dataset.f === homeFilter));
    for (const b of main.querySelectorAll('.view-seg button')) {
      b.classList.toggle('on', b.dataset.v === homeView);
      b.setAttribute('aria-pressed', String(b.dataset.v === homeView));
    }
    $('#shown', main).textContent = plural(list.length, 'project');
    grid.className = homeView === 'list' ? 'pv-list' : 'pv-grid';
    if (!list.length && projects.length) {
      grid.replaceChildren(h('<div class="empty"><b>Nothing matches</b><span class="sub">Try another word or filter.</span></div>'));
      return;
    }
    if (homeView === 'list') grid.replaceChildren(...list.map(row));
    else grid.replaceChildren(...list.map(tile), newTile());
  };
  const pick = (f) => {
    homeFilter = f;
    try { localStorage.setItem('studio.home.channel', f); } catch {}
    const styleFilter = !['all', 'progress'].includes(f);
    history.replaceState(null, '', styleFilter ? `#/?style=${encodeURIComponent(f)}` : '#/');
    draw();
  };
  for (const b of main.querySelectorAll('.pv-pill')) b.onclick = () => pick(b.dataset.f);
  for (const b of main.querySelectorAll('.view-seg button')) {
    b.onclick = () => {
      homeView = b.dataset.v;
      try { localStorage.setItem('studio.home.view', homeView); } catch {}
      draw();
    };
  }
  q.oninput = draw;
  // ⌘K (Ctrl K): the search. (A full command menu is a later item.)
  const keys = (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); q.focus(); q.select(); }
  };
  document.addEventListener('keydown', keys);
  draw();
  return { teardown: () => document.removeEventListener('keydown', keys) };
}

// The video setups' names (STATUS.formats), for the list view's second line.
let STATUS_TYPES = {};
export const setTypeNames = (names) => { STATUS_TYPES = names || {}; };

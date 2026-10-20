// Video Octopus web app: home (projects + recorder takes) and the project screen
// (Claude chat · canvas / Cut Editor / renders · steps and skills).

// One address for the app: the browser keeps camera and mic permissions and the page's saved settings per address,
// and localhost and 127.0.0.1 are two.
if (location.hostname === 'localhost') location.replace(location.href.replace('//localhost', '//127.0.0.1'));

import { PRESETS, NIGHT, SHAPES, BG_KINDS, NO_CROP, MIN_KEEP, compose, withPreset, normalize, normCrop, animatedBg, borderLabel, effectiveLook, shotAt, transitionsOf, lookKeys,
  zoomAt, zoomedCrop, slideOffsets, zoominAt, cropRegion, ZOOM_SPEEDS } from './layout.js';
import { $, esc, h, api, toast, ago, clock, tilde, fileManager, setSystem, engineName, cutWord, confirmBox } from './ui.js';
import { makeTimeline } from './timeline.js';
import { makeUndo, tokens, lookKey as appearanceKey } from './tlcore.js';
import { makeScenes, cutMap } from './scenes.js';
import { makeCompare, previousOf, versionName } from './compare.js';
import { appPage, homeNav } from './settings.js';
import { makeRouter } from './nav.js';
import { renderDashboard } from './dashboard.js';
import { renderSchedules } from './schedules.js';
import { paintNight, painterFor, frameTime, edgeHTML, wireEdge, renderEdge, drawGhost, drawGuides, makeBackgroundSection } from './look.js';
import { makePostKit } from './postkit.js';
import { makeSound } from './sound.js';
import { renderLibrary, libraryButtons, ICON as LIB_ICON } from './library.js';
import { makeBlocks } from './blocks.js';
import { makeExportKinds } from './exportkinds.js';
import { makeExportBuilt, renderGroups } from './exportbuilt.js';
import { makeCutPanel, editorThere } from './cutpanel.js';
import { makeShots, SHOT_ICON } from './shotsui.js';
import { patchOf, applyPatch, reconcile, frameLooks, touches, rowKeys, hiddenOf, mmss, trName } from './shotlook.js';
import { withoutKeys, shotsWithoutProposals, zoomsWithoutProposals, proposalsOf, proposalWhat, proposalWords } from './shots.js';
import { makeZooms } from './zoomsui.js';
import { makeRail } from './rail.js';
import * as rec from './recorder.js';
import { HOTKEY } from './recorder.js';
import { applyLook, lookProject, onLook, cutLookParams } from './appearance.js';
import { addSkillsDialog } from './brand.js';
import { stageExtras } from './stagefx.js';
import { exportLooks, sceneKey, shotsSummary } from './exportshots.js';

const app = $('#app');

const gb = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const CODEC = { h264: 'H.264', hevc: 'HEVC (H.265)', prores: 'ProRes', vp9: 'VP9', av1: 'AV1', mpeg4: 'MPEG-4' }; // the Renders tab's Size line
const takeLabel = (id) => {
  const m = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)/.exec(id);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : id;
};

// ---------- status bar ----------
let STATUS = null;
async function loadStatus(refresh = false) {
  STATUS = await api('/api/status' + (refresh ? '?refresh' : ''));
  setSystem(STATUS); // the ~ in paths and the file manager's name (web/ui.js)
  applyLook(STATUS.appearance); // Settings → Appearance (web/appearance.js)
  window.STUDIO_ENGINE = STATUS.engine; // the other pages' chats say which agent is answering
  window.STUDIO_AGENT = { codex: 'Codex', pi: 'pi' }[STATUS.engine] || 'Claude';
  const c = STATUS.claude, chip = $('#claudeChip'), ms = STATUS.modelSource;
  chip.className = 'chip';
  if (!c.installed) { chip.textContent = 'Claude Code not installed'; chip.classList.add('bad'); }
  // Claude Code on another model (Settings → Agent & model → Model source): no Claude sign-in needed, no plan limits.
  else if (ms) { chip.textContent = `Claude Code ${c.version} · ${ms.label}${ms.model ? ` · ${ms.model}` : ''}`; chip.classList.add(ms.model ? 'ok' : 'bad'); }
  if (ms) { const u = $('#usage'); if (u) u.hidden = true; } // the plan's meter means nothing while another model runs
  else if (!c.signedIn) { chip.textContent = 'Claude Code: not signed in'; chip.classList.add('bad'); }
  else { chip.textContent = `Claude Code ${c.version}${c.plan ? ' · ' + c.plan : ''}`; chip.classList.add('ok'); }
  // The plan's meter from the last reading (a reload or a restart doesn't wait for the next reply).
  if (!ms && STATUS.usage) showUsage(STATUS.usage);
  return STATUS;
}
function showUsage(ev) {
  if (ev.fiveHour == null && ev.sevenDay == null) return;
  $('#usage').hidden = false;
  const set = (el, v) => { el.style.width = `${Math.round((v || 0) * 100)}%`; el.style.background = v > 0.85 ? 'var(--bad)' : v > 0.6 ? 'var(--warn)' : 'var(--ok)'; };
  set($('#u5'), ev.fiveHour); set($('#u7'), ev.sevenDay);
  $('#usage').title = `Claude plan usage (from Claude Code): 5-hour window ${Math.round((ev.fiveHour || 0) * 100)}%, 7-day ${Math.round((ev.sevenDay || 0) * 100)}%`;
}

// The app is one window: its panels scroll, the page itself never does (above ~980 px wide, where the panels fill the
// window; narrower, they stack and the page scrolls). If anything still scrolls the page (a focus or a scrollIntoView
// reaching past a panel's edge), it goes straight back.
addEventListener('scroll', () => { if ((scrollX || scrollY) && innerWidth > 980) scrollTo(0, 0); }, { passive: true });

// ---------- router ----------
// One page at a time (web/nav.js): a page left while it's still loading is torn down once it has loaded, and `nav`
// ({ signal, alive }) tells a page it has been left.
const router = makeRouter(async (nav) => {
  // Frosted takes the open project's picture (the newest project's on the other pages).
  const pm = /^#\/p\/(.+)$/.exec(location.hash);
  lookProject(pm ? decodeURIComponent(pm[1]) : null);
  // Settings, Setup (opens by itself the first time) and the Video Octopus assistant live in settings.js / setup.js.
  const page = await appPage(location.hash, { app, makeChat, loadStatus, nav });
  if (page) return page;
  const m = /^#\/p\/(.+)$/.exec(location.hash);
  if (m) return openProject(decodeURIComponent(m[1]));
  return home(location.hash === '#/dashboard' ? 'dashboard' : location.hash === '#/scheduled' ? 'scheduled' : location.hash === '#/recordings' ? 'recordings' : location.hash === '#/skills' ? 'skills' : location.hash.startsWith('#/library') ? 'library' : 'projects', nav);
});
window.addEventListener('hashchange', router);

// ---------- home: a sidebar (projects, recordings, skills, Claude Code), the project you were on, all projects ----------
const HOME_ICON = {
  projects: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/></svg>',
  dashboard: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 13.5h11"/><rect x="3" y="8" width="2.4" height="4" rx=".6"/><rect x="6.8" y="4.5" width="2.4" height="7.5" rx=".6"/><rect x="10.6" y="6.5" width="2.4" height="5.5" rx=".6"/></svg>',
  scheduled: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.5v3l2 1.5M6 1.5h4"/></svg>',
  recordings: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2.3" class="fill"/></svg>',
  skills: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2l1.6 3.7L13.5 6l-3 2.6.9 3.9L8 10.5 4.6 12.5l.9-3.9-3-2.6 3.9-.3z"/></svg>',
  search: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="6" cy="6" r="4.2"/><path d="M9.2 9.2l3 3"/></svg>',
  take: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="1.5" y="3" width="11" height="8" rx="1.5"/><circle cx="13.5" cy="12.5" r="3" class="hole"/></svg>',
  close: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8"/></svg>',
};
const takeWhat = (t) => t.files.map((f) => (/_screen\./.test(f) ? 'screen' : /_webcam\./.test(f) ? 'camera' : isSound(f) ? 'mic only' : 'video')).join(' + ').replace(/^./, (c) => c.toUpperCase());
const thumbUrl = (p) => `/api/projects/${encodeURIComponent(p.id)}/thumb?v=${Math.round(p.updated)}`;
// A picture fades in when it loads; with no picture the box stays a quiet tile with the project's initial.
function wireThumb(box) {
  const img = $('img', box);
  if (!img) return;
  img.onload = () => box.classList.add('in');
  img.onerror = () => { img.remove(); box.classList.add('none'); };
}
let homeFilter = 'all';
let pendingRecord = null; // a project made with "Record a new take now" opens its record panel

async function home(view = 'projects', route = null) { // route: { signal, alive } from the router (web/nav.js)
  $('#crumbs').innerHTML = '';
  clearBar();
  document.body.classList.add('in-home');
  document.title = view === 'projects' ? 'Video Octopus' : `${{ dashboard: 'Dashboard', scheduled: 'Scheduled', recordings: 'Recordings', skills: 'Skills', library: 'Library' }[view]} · Video Octopus`;
  await loadStatus();
  if (!STATUS.studioOk) return setupScreen();
  const [projects, takes, skills, counts] = await Promise.all([api('/api/projects'), api('/api/takes'), view === 'skills' ? api('/api/skills') : null, api('/api/app/counts').catch(() => ({}))]);
  const claude = STATUS.claude;
  const claudeNote = !claude.installed
    ? `<div class="notice">Claude Code isn't on this computer yet. Install it in a terminal with <code>${esc(claude.install)}</code>, run <code>claude</code> once to sign in, then reload.</div>`
    : !claude.signedIn && !STATUS.modelSource ? `<div class="notice">Claude Code is installed but not signed in. Open Terminal, run <code>claude</code> and sign in with your Claude account, then reload. Video Octopus uses that sign-in; it never asks for your password.</div>` : '';
  const u = STATUS.usage;
  const use = (label, v) => `<div class="cc-use"><span>${label}</span><i><b style="width:${Math.round((v || 0) * 100)}%"></b></i><span>${Math.round((v || 0) * 100)}%</span></div>`;
  const claudeCard = `<div class="cc">
      <div class="cc-top"><span class="dot ${claude.installed && claude.signedIn ? 'ok' : 'bad'}"></span><b>Claude Code${claude.version ? ` ${esc(claude.version)}` : ''}</b></div>
      <div class="sub">${!claude.installed ? 'Not installed' : STATUS.modelSource ? `${esc(STATUS.modelSource.label)}${STATUS.modelSource.model ? ` · ${esc(STATUS.modelSource.model)}` : ': pick a model'} · not your Claude plan` : !claude.signedIn ? 'Not signed in' : `Signed in${claude.plan ? ` · ${esc(claude.plan)}` : ''}`}</div>
      ${u && (u.fiveHour != null || u.sevenDay != null) ? `<div class="cc-uses" title="Your plan's usage, as Claude Code last reported it">${use('5h', u.fiveHour)}${use('7d', u.sevenDay)}</div>` : ''}
    </div>`;
  const nav = (k, label, n, wait) => `<a class="nav-i${view === k ? ' on' : ''}" href="${k === 'projects' ? '#/' : `#/${k}`}"${view === k ? ' aria-current="page"' : ''}>${HOME_ICON[k] || LIB_ICON[k]}<span>${label}</span>${n != null ? `<span class="n${wait ? ' wait' : ''}"${wait ? ` title="${esc(wait)}"` : ''}>${n}</span>` : ''}</a>`;
  const el = h(`<div class="home">
    <nav class="side-nav" aria-label="Video Octopus">
      <a class="brand" href="#/"><span class="logo" aria-hidden="true"><i></i></span>Video Octopus</a>
      ${nav('projects', 'Projects', projects.length)}${nav('dashboard', 'Dashboard')}${nav('scheduled', 'Scheduled', counts.schedules || null)}${nav('recordings', 'Recordings', takes.length)}${nav('library', 'Library', counts.inbox || null, counts.inbox ? `${counts.inbox} waiting in the inbox` : '')}${nav('skills', 'Skills')}${homeNav(counts)}
      <span class="gap"></span>${claudeCard}
    </nav>
    <div class="home-main" id="homeMain"></div>
    ${view === 'library' ? '<aside class="home-rec lib-side" aria-label="Library assistant" id="libSide"></aside>' : ''}
  </div>`);
  app.replaceChildren(el);
  const main = $('#homeMain', el);
  if (view === 'projects') renderProjects(main, projects, takes, claudeNote);
  if (view === 'dashboard') renderDashboard(main, { recordingsDir: tilde(STATUS.recordingsDir || '') });
  const sched = view === 'scheduled' ? await renderSchedules(main, route).catch((e) => { main.replaceChildren(h(`<div class="home-wrap"><div class="notice">${esc(e.message)}</div></div>`)); return null; }) : null;
  if (view === 'recordings') renderRecordings(main, takes);
  if (view === 'skills') renderSkills(main, skills || []);
  const lib = view === 'library' ? renderLibrary(main, $('#libSide', el)) : null;
  return { teardown: () => { lib?.teardown(); sched?.teardown(); document.body.classList.remove('in-home'); } };
}

// Projects (layout H1, 17 Oct 2026): the page uses the whole width. One band to carry on (the last project, its
// steps, what's next) next to what else is waiting for you; a new take shows only while it isn't in a project yet
// (every recording lives under Recordings); then all projects as a grid or a list.
const VIEW_ICON = {
  grid: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1"/><rect x="8" y="1.5" width="4.5" height="4.5" rx="1"/><rect x="1.5" y="8" width="4.5" height="4.5" rx="1"/><rect x="8" y="8" width="4.5" height="4.5" rx="1"/></svg>',
  list: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1.5 3h11M1.5 7h11M1.5 11h11"/></svg>',
};
let homeView = (() => { try { return localStorage.getItem('studio.home.view') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } })();
const pills = (pr) => (pr || []).map((x) => `<i class="${x === 1 ? 'd' : x === 2 ? 'n' : ''}"></i>`).join('');
const nextText = (p) => (p.next ? p.next : p.type ? 'All steps done' : 'Pick a type');

function renderProjects(main, projects, takes, claudeNote) {
  const resume = projects.filter((p) => p.app && p.type).sort((a, b) => b.updated - a.updated)[0] || null;
  main.replaceChildren(h(`<div class="home-wrap wide">
    ${claudeNote}
    <div class="home-head">
      <div class="hh-title"><h1>Projects</h1><div class="sub mono">${esc(tilde(STATUS.studio))}/${esc(STATUS.projectsDir)}</div></div>
      <label class="search wide">${HOME_ICON.search}<span class="vh">Search projects</span><input id="q" type="search" placeholder="Search projects" autocomplete="off"></label>
      <button class="btn rec" id="recBtn" title="Make a project and record a take into it"><span class="rec-dot"></span>Record</button>
      <button class="btn primary" id="newBtn">+ New project</button>
    </div>
    <div id="band"></div>
    <div class="take-banners" id="takeBanner"></div>
    <div class="list-head"><b>All projects</b>
      <div class="seg" id="filter" role="group" aria-label="Filter by type">
        <button data-f="all">All</button>${Object.entries(STATUS.formats).map(([k, v]) => `<button data-f="${k}">${esc(v.replace(/ \(.*\)$/, ''))}</button>`).join('')}<button data-f="old">Earlier edits</button></div>
      <span class="gap"></span><span class="sub" id="shown"></span>
      <div class="seg view-seg" role="group" aria-label="Show projects as"><button data-v="grid" aria-label="Grid" title="Grid">${VIEW_ICON.grid}</button><button data-v="list" aria-label="List" title="List">${VIEW_ICON.list}</button></div></div>
    <div id="grid"></div>
  </div>`));
  $('#newBtn', main).onclick = () => newProjectDialog(null, takes);
  $('#recBtn', main).onclick = () => newProjectDialog('record', takes);

  // The band: carry on with the last project, and what else needs you.
  const band = $('#band', main);
  if (resume) {
    const pr = resume.progress || [], names = resume.steps || [];
    const waiting = projects.filter((p) => p.app && p.type && p !== resume && (p.waiting || p.next))
      .sort((a, b) => (b.waiting > 0) - (a.waiting > 0) || b.updated - a.updated).slice(0, 4);
    const el = h(`<section class="band">
      <a class="band-res" href="#/p/${encodeURIComponent(resume.id)}">
        <span class="thumb"><img alt="" decoding="async" src="${thumbUrl(resume)}"><span class="ini" aria-hidden="true">${esc(resume.name.slice(0, 1))}</span></span>
        <span class="r-body">
          <span class="sub">Continue where you left off · edited ${ago(resume.updated)}</span>
          <span class="r-name">${esc(resume.name)}</span>
          <span class="r-meta"><span class="badge">${esc(STATUS.formats[resume.type] || resume.type)}</span><span class="r-len sub" id="resumeLen"></span></span>
          <span class="r-steps" style="--n:${pr.length || 1}" aria-label="${pr.filter((x) => x === 1).length} of ${pr.length} steps done">${pr.map((x, i) => `<span class="${x === 1 ? 'd' : x === 2 ? 'n' : ''}"><i></i><small>${esc(names[i] || '')}</small></span>`).join('')}</span>
          <span class="gap"></span>
          <span class="r-acts"><span class="r-go">${resume.next ? `Next: ${esc(resume.next)}` : 'All steps done'}<span>Open</span></span>${resume.waiting ? `<span class="r-wait">${resume.waiting} change${resume.waiting > 1 ? 's' : ''} waiting for Claude</span>` : ''}</span>
        </span></a>
      <div class="band-wait"><b class="bw-h">Waiting for you</b>
        ${waiting.length ? waiting.map((p) => `<a class="bw-row" href="#/p/${encodeURIComponent(p.id)}"><span class="thumb"><img alt="" loading="lazy" decoding="async" src="${thumbUrl(p)}"><span class="ini" aria-hidden="true">${esc(p.name.slice(0, 1))}</span></span>
          <span class="bw-t"><b>${esc(p.name)}</b><span class="sub">${p.waiting ? `${p.waiting} change${p.waiting > 1 ? 's' : ''} waiting to send` : `edited ${ago(p.updated)}`}</span></span>
          <span class="bw-go">${esc(p.waiting ? 'Save changes' : p.next)} →</span></a>`).join('') : '<p class="sub">Nothing else waiting. Every other project is done or hasn’t started.</p>'}
      </div></section>`);
    el.querySelectorAll('.thumb').forEach(wireThumb);
    band.append(el);
    // How long the video is (the locked cut, else the take) and how many scenes it has.
    api(`/api/projects/${encodeURIComponent(resume.id)}/summary`).then((m) => {
      const bits = [m.length ? `${Math.floor(Math.round(m.length) / 60)}:${String(Math.round(m.length) % 60).padStart(2, '0')}${m.cut ? '' : ' (whole take)'}` : '', m.scenes ? `${m.scenes} scene${m.scenes > 1 ? 's' : ''}` : ''].filter(Boolean);
      const box = $('#resumeLen', el);
      if (box && bits.length) { box.textContent = bits.join(' · '); box.title = m.cut ? 'Length of the locked cut' : 'Length of the take (no locked cut yet)'; }
    }).catch(() => {});
  } else {
    band.append(h(`<section class="band band-first"><div><b>Start your first video</b><span class="sub">Record a take, or start from one you've already recorded.</span></div><span class="gap"></span><button class="btn primary" data-a="new">+ New project</button></section>`));
    $('[data-a=new]', band).onclick = () => newProjectDialog(null, takes);
  }

  // A take that isn't in any project yet (newest first), and built-in recorder takes left unsaved: offer them here.
  const tb = $('#takeBanner', main);
  const fresh = takes.find((t) => !t.used);
  if (fresh) {
    const b = h(`<div class="take-banner"><span class="tb-ic" aria-hidden="true">${HOME_ICON.take}</span>
      <span class="tt"><b>New take · ${esc(takeLabel(fresh.id))}</b><span class="sub">${esc(takeWhat(fresh))} · ${gb(fresh.bytes)} · not in a project yet</span></span>
      <button class="btn dark small" data-a="use">Start a project with it</button><a class="btn ghost small" href="#/recordings">All ${takes.length} recording${takes.length === 1 ? '' : 's'} →</a></div>`);
    $('[data-a=use]', b).onclick = () => newProjectDialog(fresh.id);
    tb.append(b);
  }
  api('/api/rec-unfinished').then(({ takes: open }) => {
    for (const u of open || []) {
      const b = h(`<div class="take-banner unsaved"><span class="tb-ic" aria-hidden="true">${HOME_ICON.take}</span>
        <span class="tt"><b>Unsaved take · ${esc(new Date(u.started).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}</b><span class="sub">For ${esc(u.project)} · about ${clock(u.seconds).replace(/\.\d$/, '')} · ${gb(u.bytes)} · the page closed before it was saved</span></span>
        <button class="btn dark small" title="Make the take files from what was recorded and add the take to its project">Finish it</button></div>`);
      $('button', b).onclick = async () => {
        try { await rec.recover(u.project, u.take); location.hash = `#/p/${encodeURIComponent(u.project)}`; } catch (e) { toast(e.message); }
      };
      tb.prepend(b);
    }
  }).catch(() => {});

  const grid = $('#grid', main), q = $('#q', main);
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const kind = (p) => homeFilter === 'all' || (homeFilter === 'old' ? !p.type : p.type === homeFilter);
    const list = projects.filter((p) => p !== resume || term).filter(kind)
      .filter((p) => !term || p.name.toLowerCase().includes(term) || p.id.includes(term));
    // The count is every project the filter shows, the one in "Continue where you left off" too (it isn't repeated in
    // the grid), so it matches the sidebar's Projects number.
    const shown = list.length + (resume && !term && kind(resume) ? 1 : 0);
    main.querySelectorAll('#filter button').forEach((b) => { b.classList.toggle('on', b.dataset.f === homeFilter); b.setAttribute('aria-pressed', String(b.dataset.f === homeFilter)); });
    main.querySelectorAll('.view-seg button').forEach((b) => { b.classList.toggle('on', b.dataset.v === homeView); b.setAttribute('aria-pressed', String(b.dataset.v === homeView)); });
    grid.className = homeView === 'list' ? 'plist' : 'grid';
    $('#shown', main).textContent = `${shown} project${shown === 1 ? '' : 's'}`;
    if (!projects.length) return grid.replaceChildren(h(`<div class="empty"><b>No projects yet</b><span class="sub">Start one with New project or Record.</span></div>`));
    if (!list.length) return grid.replaceChildren(h(`<div class="empty"><b>Nothing matches</b><span class="sub">Try another word or filter.</span></div>`));
    const type = (p) => (p.type ? esc(STATUS.formats[p.type] || p.type) : 'Earlier edit');
    if (homeView === 'list') {
      grid.replaceChildren(h(`<div class="pl-head"><span></span><span>Project</span><span>Type</span><span>Steps</span><span>Next</span><span>Edited</span></div>`), ...list.map((p) => {
        const row = h(`<a class="pl-row" href="#/p/${encodeURIComponent(p.id)}">
          <span class="thumb"><img alt="" loading="lazy" decoding="async" src="${thumbUrl(p)}"><span class="ini" aria-hidden="true">${esc(p.name.slice(0, 1))}</span></span>
          <b class="pl-name">${esc(p.name)}</b><span class="badge">${type(p)}</span>
          <span class="pl-steps">${p.progress ? `<span class="pills">${pills(p.progress)}</span><span class="sub">${p.progress.filter((x) => x === 1).length} of ${p.progress.length}</span>` : '<span class="sub">–</span>'}</span>
          <span class="${p.next ? 'next' : 'sub'}">${esc(nextText(p))}${p.waiting ? ` <span class="pl-wait">${p.waiting} waiting</span>` : ''}</span>
          <span class="sub">${ago(p.updated)}</span></a>`);
        wireThumb($('.thumb', row));
        return row;
      }));
      return;
    }
    grid.replaceChildren(...list.map((p) => {
      const card = h(`<a class="card" href="#/p/${encodeURIComponent(p.id)}">
        <span class="thumb"><img alt="" loading="lazy" decoding="async" src="${thumbUrl(p)}"><span class="ini" aria-hidden="true">${esc(p.name.slice(0, 1))}</span>${p.progress ? `<span class="pills on-thumb" aria-hidden="true">${pills(p.progress)}</span>` : ''}</span>
        <span class="name">${esc(p.name)}</span>
        <span class="meta"><span>${type(p)}</span><span aria-hidden="true">·</span>
          <span class="${p.next ? 'next' : ''}">${esc(nextText(p))}</span>
          <span class="ago">${ago(p.updated)}</span></span></a>`);
      wireThumb($('.thumb', card));
      return card;
    }));
  };
  main.querySelectorAll('#filter button').forEach((b) => (b.onclick = () => { homeFilter = b.dataset.f; draw(); }));
  main.querySelectorAll('.view-seg button').forEach((b) => (b.onclick = () => { homeView = b.dataset.v; try { localStorage.setItem('studio.home.view', homeView); } catch {} draw(); }));
  q.oninput = draw;
  draw();
}

function takeRow(t, label = 'Use') {
  const row = h(`<div class="take-row"><span class="ti" aria-hidden="true">${HOME_ICON.take}</span>
    <span class="tt"><b>${esc(takeLabel(t.id))}</b><span class="sub">${esc(takeWhat(t))} · ${gb(t.bytes)}</span></span>
    <button class="btn small" title="Start a new project from this take">${label}</button></div>`);
  $('button', row).onclick = () => newProjectDialog(t.id);
  return row;
}

function renderRecordings(main, takes) {
  main.replaceChildren(h(`<div class="home-wrap">
    <div class="home-head"><div class="hh-title"><h1>Recordings</h1><div class="sub mono">${esc(tilde(STATUS.recordingsDir))}</div></div>
      <button class="btn rec" id="rec2"><span class="rec-dot"></span>Record a new take</button></div>
    <p class="sub lead">Every take you've recorded, newest first. Start a project from one and Video Octopus copies it in.</p>
    <div class="take-list wide" id="all"></div></div>`));
  $('#rec2', main).onclick = () => newProjectDialog('record', takes);
  const all = $('#all', main);
  if (!takes.length) all.append(h(`<div class="empty"><b>No recordings yet</b><span class="sub">Press Record a new take to make one.</span></div>`));
  for (const t of takes) all.append(takeRow(t, 'New project'));
}

function renderSkills(main, skills) {
  main.replaceChildren(h(`<div class="home-wrap">
    <div class="home-head"><div class="hh-title"><h1>Skills</h1><div class="sub mono">${esc(tilde(STATUS.studio))}/.claude/skills</div></div><span class="gap"></span><button type="button" class="btn small dark" id="addSk">Add skills from GitHub</button></div>
    <p class="sub lead">The skills Claude uses in your projects. The steps run them for you; any of them can also be run from the ⋯ at the end of a project's step rail, or by asking Claude.</p>
    <div class="skill-grid" id="sk"></div></div>`));
  const box = $('#sk', main);
  if (!skills.length) box.append(h(`<div class="empty"><b>No skills found</b><span class="sub">Skills live in your studio's .claude/skills folder.</span></div>`));
  for (const s of skills) box.append(h(`<div class="skill-card"><b>/${esc(s.name)}</b><span class="sub">${esc(s.description || '')}</span></div>`));
  // Motion-graphics skills (or any) from a public GitHub repo, never over one that's here (web/brand.js).
  $('#addSk', main).onclick = () => addSkillsDialog({ onDone: async () => renderSkills(main, await api('/api/skills')) });
}

function setupScreen() {
  const el = h(`<div class="setup"><h3 style="margin-top:0">Where is your studio?</h3>
    <div class="sub">The studio is the folder that holds your projects, style notes and skills. Video Octopus never changes anything outside it.</div>
    <label>Your studio folder</label><input class="field" id="studio" placeholder="~/AI Video Video Octopus" value="${esc(STATUS.studio || '')}">
    <label>Projects folder inside it</label><input class="field" id="pdir" value="${esc(STATUS.projectsDir || 'projects')}">
    <div style="margin-top:18px;text-align:right"><button class="btn primary" id="save">Open studio</button></div></div>`);
  app.replaceChildren(el);
  $('#save', el).onclick = async () => {
    try { await api('/api/settings', { studio: $('#studio', el).value.trim(), projectsDir: $('#pdir', el).value.trim() || 'projects' }); router(); }
    catch (e) { toast(e.message); }
  };
  return { teardown: () => document.body.classList.remove('in-home') };
}

// New project: a name, the type (which picks the steps and the frame shape) and where the recording comes
// from: record a new take now, an earlier take, or later. pick = 'record', a take id, or null.
async function newProjectDialog(pick, takes) {
  const [list, projects] = await Promise.all([takes || api('/api/takes'), api('/api/projects').catch(() => [])]);
  const canRecord = true; // the recorder is in Video Octopus itself (its panel says when this browser can't record)
  const modal = $('#modal');
  const types = Object.entries(STATUS.formats);
  const info = STATUS.formatInfo || {};
  let type = types[0]?.[0] || 'tutorial', style = null, upload = null; // upload: the file picked with "Import a file…"
  // The folder the project gets: the server's slug of the name, -2, -3… when it's taken.
  const ids = new Set(projects.map((p) => p.id));
  const slug = (n) => String(n).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'project';
  const folderOf = (n) => { const b = slug(n); let f = b; for (let i = 2; ids.has(f); i++) f = `${b}-${i}`; return f; };
  // The newest takes, plus the newest one no project uses yet (the default) and the one picked; More takes… opens
  // the rest in the same list, each with when, how long, how big and which project uses it.
  const free = list.find((t) => !t.used);
  const shown = list.slice(0, 4);
  if (free && !shown.includes(free)) shown.push(free);
  if (pick && pick !== 'record' && !shown.some((t) => t.id === pick)) { const t = list.find((x) => x.id === pick); if (t) shown.unshift(t); }
  const rest = list.filter((t) => !shown.includes(t));
  let take = pick === 'record' ? (canRecord ? 'record' : free?.id || list[0]?.id || '') : pick || free?.id || (canRecord ? 'record' : list[0]?.id || '');
  const opt = (value, title, sub, extra = '') => `<label class="np-t"><input type="radio" name="ptake" value="${esc(value)}"${value === take ? ' checked' : ''}><span class="np-tt"><b>${esc(title)}</b><small>${esc(sub)}</small></span>${extra}</label>`;
  const mmss = (x) => { const r = Math.round(x); return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`; };
  const takeSub = (t) => [takeWhat(t), t.duration ? mmss(t.duration) : null, gb(t.bytes),
    t.projects?.length ? `in ${t.projects.map((n) => `“${n}”`).join(', ')}` : t.used ? 'in a project' : 'not in a project yet'].filter(Boolean).join(' · ');
  const d = h(`<div class="dialog np" role="dialog" aria-modal="true" aria-labelledby="npTitle">
    <div class="np-head"><div><h3 id="npTitle">New project</h3><div class="sub">A folder in your studio. The type picks the steps and the frame shape.</div></div>
      <button class="btn ghost small np-x" id="cancelX" aria-label="Close">${HOME_ICON.close}</button></div>
    <label class="fl" for="pname">What's the video about?</label>
    <input class="field big" id="pname" placeholder="e.g. Cut Editor walkthrough" autocomplete="off" aria-describedby="npErr">
    <div class="np-err" id="npErr" role="alert" hidden>Give the video a name first. It becomes the project's folder.</div>
    <div class="sub np-folder" id="npFolder"></div>
    <div class="fl" id="typeLabel">Type</div>
    <div class="types" role="radiogroup" aria-labelledby="typeLabel">${types.map(([k, v]) => `<button type="button" class="type" role="radio" data-k="${k}"><span class="ty-shape ${info[k]?.aspect === '9:16' ? 'tall' : 'wide'}${info[k]?.camera === false ? ' nocam' : ''}" aria-hidden="true"></span><b>${esc(v)}</b><small>${esc(info[k]?.hint || '')}</small>
      ${info[k]?.blocks?.length ? `<span class="ty-blocks" aria-label="Starts with: ${esc(info[k].blocks.map((b) => b.label).join(', '))}">${info[k].blocks.map((b) => `<i class="t-${esc(b.type)}${b.optional ? ' opt' : ''}">${esc(b.label)}</i>`).join('')}</span>` : ''}
      ${info[k]?.steps?.length ? `<small class="ty-n">${info[k].steps.length} steps</small>` : ''}</button>`).join('')}</div>
    <div class="np-style" id="styleRow" hidden><div class="fl" id="styleLabel">Style</div><div class="seg wide" role="radiogroup" aria-labelledby="styleLabel" id="styles"></div></div>
    <div class="fl" id="takeLabel">Recording</div>
    <div class="np-takes" role="radiogroup" aria-labelledby="takeLabel">
      ${canRecord ? opt('record', 'Record a new take now', 'Opens the record setup when the project is made', '<span class="rec-dot" aria-hidden="true"></span>') : ''}
      ${shown.map((t) => opt(t.id, takeLabel(t.id), takeSub(t))).join('')}
      ${rest.length ? `<button type="button" class="np-t np-more" id="npMore" aria-expanded="false" aria-controls="npAll"><span class="np-tt"><b>More takes…</b><small>${rest.length} more, oldest ${esc(takeLabel(rest.at(-1).id))}</small></span><span aria-hidden="true">›</span></button>
        <div class="np-all" id="npAll" role="group" aria-label="All takes" hidden>${rest.map((t) => opt(t.id, takeLabel(t.id), takeSub(t))).join('')}</div>` : ''}
      ${opt('file', 'Import a file…', 'Any video or sound file from this computer (or drop one here)', '<input type="file" id="npFileIn" hidden accept="video/*,audio/*,.mov,.mp4,.m4v,.mkv,.webm,.wav,.m4a,.mp3,.aif,.aiff,.flac">')}
      ${opt('', 'Add one later', 'Record or pick a take from inside the project')}
    </div>
    <div class="actions"><span class="np-chain" id="npChain"></span><button class="btn ghost" id="cancel">Cancel</button><button class="btn primary" id="create">Create</button></div></div>`);
  modal.replaceChildren(d); modal.hidden = false;
  const sync = () => {
    d.querySelectorAll('.type').forEach((x) => { x.classList.toggle('on', x.dataset.k === type); x.setAttribute('aria-checked', String(x.dataset.k === type)); });
    // Shorts are one format with styles inside (talking head, long-form teaser, plus the studio's own from .studio/formats.json).
    const styles = info[type]?.styles || [];
    $('#styleRow', d).hidden = !styles.length;
    if (!styles.some((x) => x.id === style)) style = styles[0]?.id || null;
    $('#styles', d).innerHTML = styles.map((x) => `<button type="button" role="radio" data-s="${esc(x.id)}" title="${esc(x.hint)}" class="${x.id === style ? 'on' : ''}" aria-checked="${x.id === style}">${esc(x.label)}</button>`).join('');
    d.querySelectorAll('#styles [data-s]').forEach((b) => (b.onclick = () => { style = b.dataset.s; sync(); }));
    $('#create', d).textContent = take === 'record' ? 'Create and record' : take === 'file' ? 'Create and import' : 'Create';
    // The type's steps, as a chain under the choices.
    const chain = stepChain(info[type]?.steps);
    $('#npChain', d).textContent = chain;
    $('#npChain', d).title = (info[type]?.steps || []).map((s) => s.name || s.label).join(' → ');
  };
  const folder = () => {
    const n = $('#pname', d).value.trim();
    $('#npFolder', d).innerHTML = `Folder: <span class="mono">${esc(STATUS.projectsDir)}/${n ? esc(folderOf(n)) : '…'}</span>`;
  };
  // Create with no name: say so under the box, outline it and give it a small shake (the dialog may be scrolled).
  const nameMissing = (on) => {
    const f = $('#pname', d);
    f.classList.toggle('invalid', on);
    f.toggleAttribute('aria-invalid', on);
    $('#npErr', d).hidden = !on;
    if (!on) return;
    f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake');
    f.scrollIntoView({ block: 'center', behavior: 'smooth' });
    f.focus();
  };
  $('#pname', d).addEventListener('input', () => { folder(); if ($('#pname', d).value.trim()) nameMissing(false); });
  folder();
  d.querySelectorAll('.type').forEach((b) => (b.onclick = () => { type = b.dataset.k; sync(); }));
  // Import a file…: pick (or drop) a video or sound file; it's copied into the project as its take after Create.
  const fileIn = $('#npFileIn', d), fileOpt = fileIn.closest('label');
  const setFile = (f) => {
    if (!f) return;
    if (!/\.(mov|mp4|m4v|mkv|webm|wav|m4a|mp3|aif|aiff|caf|flac)$/i.test(f.name)) { toast('Pick a video (.mov, .mp4…) or a sound file (.wav, .m4a, .mp3…).'); return; }
    upload = f; take = 'file';
    $('input[value=file]', d).checked = true;
    $('small', fileOpt).textContent = `${f.name} · ${gb(f.size)} · click to pick another`;
    if (!$('#pname', d).value.trim()) { $('#pname', d).value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim(); folder(); }
    sync();
  };
  fileIn.onchange = () => setFile(fileIn.files[0]);
  fileOpt.addEventListener('click', (e) => { if (take === 'file' && e.target !== fileIn) { e.preventDefault(); fileIn.click(); } });
  d.querySelectorAll('input[name=ptake]').forEach((r) => (r.onchange = () => { take = r.value; if (take === 'file' && !upload) fileIn.click(); sync(); }));
  $('#npMore', d)?.addEventListener('click', (e) => {
    const all = $('#npAll', d), b = e.currentTarget;
    all.hidden = false; b.hidden = true; b.setAttribute('aria-expanded', 'true');
    (all.querySelector('input:checked') || all.querySelector('input'))?.focus();
  });
  d.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); d.classList.add('drop'); } });
  d.addEventListener('dragleave', (e) => { if (!d.contains(e.relatedTarget)) d.classList.remove('drop'); });
  d.addEventListener('drop', (e) => { e.preventDefault(); d.classList.remove('drop'); setFile(e.dataTransfer.files[0]); });
  sync();
  const close = () => { modal.hidden = true; document.removeEventListener('keydown', esc_); };
  const esc_ = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc_);
  $('#cancel', d).onclick = close;
  $('#cancelX', d).onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  const create = async () => {
    const name = $('#pname', d).value.trim();
    if (!name) return nameMissing(true);
    if (take === 'file' && !upload) return fileIn.click();
    $('#create', d).disabled = true;
    try {
      const { id } = await api('/api/projects', { name, type, style, take: take && take !== 'record' && take !== 'file' ? take : undefined });
      if (take === 'record') pendingRecord = id;
      if (take === 'file') {
        // The file streams into the project's source/ and becomes its take (server: importUpload).
        $('#create', d).textContent = `Copying ${upload.name}…`;
        try {
          const r = await fetch(`/api/projects/${encodeURIComponent(id)}/take-upload?name=${encodeURIComponent(upload.name)}`, { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/octet-stream' }, body: upload });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `copying failed (${r.status})`);
          toast(`${upload.name} is the take. Making a playback copy…`);
        } catch (err) { toast(`The project is made, but the file didn't come in: ${err.message}`); }
      }
      close(); location.hash = `#/p/${encodeURIComponent(id)}`;
    } catch (e) { toast(e.message); $('#create', d).disabled = false; }
  };
  $('#create', d).onclick = create;
  $('#pname', d).onkeydown = (e) => { if (e.key === 'Enter') create(); };
  setTimeout(() => $('#pname', d).focus(), 30);
}

// ---------- project ----------
// Layout A: the steps are a rail in the top bar with the
// next one lit, Claude on the left, the picture with its timeline in the middle, and an inspector on the
// right that follows what is selected on the canvas.
const ICON = {
  check: '<svg class="ic-check" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6.5"/><path d="M4.2 7.2l1.8 1.8 3.8-4"/></svg>',
  todo: '<svg class="ic-todo" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6"/></svg>',
  play: '<svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true"><path d="M1 1l7 4-7 4z"/></svg>',
  claude: '<svg class="ic-claude" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2"/></svg>',
  send: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 12V2M3 6l4-4 4 4"/></svg>',
  export: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2v7M4 6l3 3 3-3M2.5 11.5h9"/></svg>',
  folder: '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h4l1.5 1.5h5.5v7.5h-11z"/></svg>',
  more: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
};
// The project's tabs, with what each one is in plain words (the tooltip and the screen reader's description).
const TABS = [
  ['canvas', 'Canvas', 'Your video: layout, camera, screen and the timeline'],
  ['scenes', 'Scenes', 'Claude’s scene-by-scene plan and the scenes it builds; review them and leave notes'],
  ['cut', 'Cut', 'The cut, word by word; fix it by hand'],
  ['renders', 'Renders', 'Finished videos'],
  ['post', 'Post', 'Title, description and captions for each platform'],
];
// The steps as a chain for the New project dialog, in their plain names: "Record → Clean up → … → Add zooms".
const stepChain = (steps = []) => {
  const names = steps.map((s) => s.name || s.label);
  return (names.length > 6 ? [...names.slice(0, 4), '…', names.at(-1)] : names).join(' → ');
};

function clearBar() {
  $('.bar').classList.remove('tight');
  $('#crumbs').style.maxWidth = '';
  $('#rail').replaceChildren();
  $('#barActions').replaceChildren();
  document.body.classList.remove('in-project');
}

async function openProject(id) {
  await loadStatus();
  let P = await api(`/api/projects/${encodeURIComponent(id)}`);
  document.title = `${P.name} · Video Octopus`;
  document.body.classList.add('in-project');
  $('#crumbs').innerHTML = `<span>/</span><b title="${esc(P.name)}">${esc(P.name)}</b>${P.type ? `<span class="badge ${P.type}">${esc(STATUS.formats[P.type])}</span>` : ''}`;
  const modes = [['manual', 'Ask before changes'], ['acceptEdits', 'File edits OK'], ['auto', 'Auto (safe steps)'], ['bypassPermissions', 'Full access']];
  $('#barActions').replaceChildren(
    h(`<button class="btn rec" id="recBtn" title="Record a take (${HOTKEY} also starts and stops it)"><span class="rec-dot"></span><span id="recText">Record</span><kbd>${HOTKEY}</kbd></button>`),
    h(`<button class="btn dark" id="exportBtn" title="Render the canvas as an MP4 into renders/">${ICON.export}Export</button>`),
  );
  const el = h(`<div class="project">
    <section class="col chat" aria-label="Claude">
      <div class="chat-rail"><button class="chat-open" id="chatOpen" aria-label="Open Claude (⌘J)" title="Open Claude (⌘J)">${ICON.claude}<i class="chat-dot" hidden></i></button><span class="chat-rail-l">Claude · ⌘J</span></div>
      <div class="chat-head">${ICON.claude}<span class="title">${esc(window.STUDIO_AGENT || 'Claude')}</span><span id="sessionInfo"></span>
        <label class="mode" title="How much Claude may do without asking"><span class="vh">Permission mode</span><select id="mode">${modes.map(([k, v]) => `<option value="${k}"${STATUS.permissionMode === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <button class="btn ghost small chat-fold" id="chatFold" aria-label="Fold Claude away (⌘J)" title="Fold Claude away (⌘J)">«</button></div>
      <div class="msgs" id="msgs"><div class="empty-chat" id="emptyChat"><b>Chat with Claude about this video.</b><br>The step that’s next waits just above the message box.</div></div>
      <div class="working" id="working" hidden><span class="spin"></span><span id="workText">Working…</span></div>
      <div class="dock" id="dock" role="group" aria-label="The next step"></div>
      <div class="composer"><label class="vh" for="input">Message Claude</label><textarea id="input" rows="1" placeholder="Ask Claude for a change…"></textarea>
        <button class="send" id="sendBtn" aria-label="Send"><span class="l-send">${ICON.send}</span><i class="stop-sq l-stop" aria-hidden="true"></i></button></div>
    </section>
    <section class="col center" aria-label="Picture">
      <div class="tabs">
        <div class="seg tabseg" role="tablist" aria-label="View">${TABS.map(([k, n, about]) => `<button class="tab${k === 'canvas' ? ' on' : ''}" role="tab" data-tab="${k}" title="${esc(about)}" aria-description="${esc(about)}">${n}${['scenes', 'renders'].includes(k) ? ` <span class="count" id="${k}Count"></span>` : ''}<span class="vh tab-new-t"></span></button>`).join('')}</div>
        <span class="gap"></span><div id="tabTools"></div>
        <button class="btn ghost small icon-l" id="reveal" title="Show the project folder in ${fileManager()}">${ICON.folder}${fileManager(true)}</button></div>
      <div class="tab-body"><div class="jobs" id="jobs"></div>
        <div class="pane" data-pane="canvas"></div>
        <div class="pane" data-pane="scenes" hidden></div>
        <div class="pane" data-pane="cut" hidden></div>
        <div class="pane" data-pane="renders" hidden></div>
        <div class="pane post-pane" data-pane="post" hidden></div></div>
    </section>
    <aside class="col inspector" aria-label="Inspector"><div id="insCanvas" class="ins"></div><div id="insKit" class="ins" hidden></div><div id="insScenes" class="ins" hidden></div><div id="insOther" class="ins" hidden></div></aside></div>`);
  app.replaceChildren(el);

  // tabs
  let tab = 'canvas';
  // A tab that got something new while you were on another one glows (and shows its count or a dot) until you open
  // it: the first scenes, a new render, the cut after Clean up, the post kit written, or the tab a finished step's
  // "Show me" points at (the strip's green done moment, web/rail.js).
  const markTab = (t, why = 'new') => {
    const b = $(`[data-tab=${t}]`, el);
    if (!b || t === tab) return;
    b.classList.add('new', 'glow');
    $('.tab-new-t', b).textContent = `, ${why}`;
  };
  const unmarkTab = (t) => { const b = $(`[data-tab=${t}]`, el); if (!b) return; b.classList.remove('new', 'glow'); $('.tab-new-t', b).textContent = ''; };
  // What each tab had when it was last open, kept by the server (project state tabSeen), so a tab's glow survives a
  // reload until you open it: the scenes' count, the newest render or export, the cut being ready, the post kit's time.
  let seenNews = null;
  const NEWS = { scenes: 'new scenes', renders: 'new render', cut: 'the cut is ready', post: 'new post kit' };
  const newest = (list) => (list || []).reduce((m, x) => Math.max(m, Math.round(x.at || 0)), 0);
  const tabNow = () => ({ scenes: P.scenes?.count || 0, renders: Math.max(newest(P.renders), newest(P.layerExports), newest(P.textExports)), cut: P.cut?.ready ? 1 : 0, post: Math.round(P.kit?.post?.at || 0) });
  const saveTabSeen = () => api(`/api/projects/${encodeURIComponent(id)}/rail`, { op: 'tabs', seen: seenNews }).catch(() => {});
  function tabNews() {
    const now = tabNow();
    let save = false;
    if (!seenNews) { seenNews = P.tabSeen ? { ...now, ...P.tabSeen } : { ...now }; save = !P.tabSeen; }
    for (const k of Object.keys(NEWS)) {
      if (!(now[k] > (seenNews[k] ?? 0))) { if (now[k] < (seenNews[k] ?? 0)) { seenNews[k] = now[k]; save = true; } continue; }
      if (k === tab) { seenNews[k] = now[k]; save = true; } else markTab(k, NEWS[k]);
    }
    if (save) saveTabSeen();
  }
  const sawTab = (t) => { if (!seenNews || !(t in NEWS)) return; const v = tabNow()[t]; if (seenNews[t] !== v) { seenNews[t] = v; saveTabSeen(); } };
  const setTab = (t) => {
    tab = t;
    unmarkTab(t);
    sawTab(t);
    try { sessionStorage.setItem(`studio.tab.${id}`, t); } catch {} // a reload comes back to this tab
    el.querySelectorAll('.tab').forEach((b) => { b.classList.toggle('on', b.dataset.tab === t); b.setAttribute('aria-selected', String(b.dataset.tab === t)); });
    el.querySelectorAll('.pane[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== t));
    $('#tabTools', el).hidden = t !== 'canvas';
    $('#insCanvas', el).hidden = t !== 'canvas';
    $('#insKit', el).hidden = t !== 'canvas';
    $('#insScenes', el).hidden = t !== 'scenes';
    $('#insOther', el).hidden = t === 'canvas' || t === 'scenes';
    if (t === 'cut') renderCut();
    if (t === 'renders') renderRenders();
    renderJobs();
    if (t === 'post') post.show();
    renderOtherInspector();
    if (t === 'canvas') canvas.resume(); else canvas.pause();
    if (t === 'scenes') scenes.show(); else scenes.hide();
    applyFold();
  };
  // Claude folds to a rail: by itself on Scenes (where the list, picture and panel need the room), and ⌘J
  // toggles it; the choice is remembered for Scenes and for the other tabs separately.
  const foldKey = () => `studio.chat.fold.${tab === 'scenes' ? 'scenes' : 'other'}`;
  const isFolded = () => { let v = null; try { v = localStorage.getItem(foldKey()); } catch {} return v == null ? tab === 'scenes' : v === '1'; };
  function applyFold() {
    const f = isFolded();
    el.classList.toggle('folded', f);
    if (!f) $('.chat-dot', el).hidden = true;
  }
  function setFold(f) { try { localStorage.setItem(foldKey(), f ? '1' : '0'); } catch {} applyFold(); if (!f) setTimeout(() => $('#input', el)?.focus(), 50); }
  $('#chatFold', el).onclick = () => setFold(true);
  $('#chatOpen', el).onclick = () => setFold(false);
  const foldKeys = (e) => { if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J')) { e.preventDefault(); setFold(!isFolded()); } };
  document.addEventListener('keydown', foldKeys);
  el.querySelectorAll('.tab').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  $('#reveal', el).onclick = () => api(`/api/projects/${encodeURIComponent(id)}/reveal`, {});
  $('#mode', el).onchange = async (e) => { await api('/api/settings', { permissionMode: e.target.value }); toast('Applies from your next message.'); };

  // One undo stack for this project's timeline edits (blocks, sound cues, scene keys and timing): ⌘Z / ⇧⌘Z.
  const history = makeUndo({ toast });
  // Blocks (M3b, web/blocks.js): the strip and band over the timeline, @mentions in the chat, Prepare on the rail.
  const blocks = makeBlocks({ id, getP: () => P, openRecord: (o) => recorder.open(o), openCut: (o) => { setTab('cut'); if (o?.list) cutPanel.openList(); }, history,
    runStep: (sid) => { const s = P.pipeline?.steps.find((x) => x.id === sid); if (s) runStep(s); },
    note: (t) => chat.note(t), seek: (t) => canvas.seek(t), time: () => canvas.time() });
  // Shots: the Shots lane, "/" in the words and the Cut tab, the transition popover.
  const shots = makeShots({ id, getP: () => P, history, blocksView: () => blocks.view() });
  // Zooms: the Zooms lane, Z + a box on the picture, the zoom inspector.
  const zooms = makeZooms({ id, getP: () => P, history });
  // Claude's proposals in the chat ("Claude proposed 3 shots and 6 zooms · Show me · Keep all · No thanks to all"):
  // what of a block's proposals still waits, and its buttons (web/shots.js keep / reject ops through the lanes).
  // (An id the page hasn't seen yet, in neither file, counts as waiting: the project view is a moment behind the turn.)
  const proposals = {
    waiting(ev) {
      const now = proposalsOf(P.shots, P.zooms), all = { shots: (P.shots?.shots || []).map((x) => x.id), zooms: (P.zooms?.items || []).map((x) => x.id) };
      const still = (k, x) => now[k].includes(x) || !all[k].includes(x);
      return { shots: (ev.shots || []).filter((x) => still('shots', x)), zooms: (ev.zooms || []).filter((x) => still('zooms', x)) };
    },
    async show(ev) {
      await refresh();
      const w = proposals.waiting(ev);
      setTab('canvas');
      if (w.shots.length) canvas.showProposal('shot', w.shots[0]);
      else if (w.zooms.length) canvas.showProposal('zoom', w.zooms[0]);
    },
    async keep(ev) { await refresh(); const w = proposals.waiting(ev); if (w.shots.length) await shots.keep(w.shots); if (w.zooms.length) await zooms.keep(w.zooms); softRefresh(); },
    async reject(ev) { await refresh(); const w = proposals.waiting(ev); if (w.shots.length) await shots.reject(w.shots); if (w.zooms.length) await zooms.reject(w.zooms); softRefresh(); },
    fresh: () => softRefresh(),
  };
  // chat
  // Quick replies under Claude's answer: watch the scene it mentions, or undo. (The next step is the dock's, just under
  // them, so it isn't repeated here.) Undo shows only when the reply changed files Video Octopus can put back itself, and says
  // which (server/turns.mjs: the window's files as they were before the reply).
  const chips = (said, { undo } = {}) => {
    const out = [];
    const m = /\bscene (\d{1,3})\b/i.exec(said || '');
    if (m) out.push({ label: `Watch scene ${m[1]}`, run: async () => {
      const sv = await api(`/api/projects/${encodeURIComponent(id)}/scenes`).catch(() => null);
      const sc = sv?.scenes?.[Number(m[1]) - 1];
      setTab('scenes'); if (sc) scenes.selectScene(sc.id);
    } });
    if (undo?.files?.length) {
      const names = undo.files.map((f) => f.split('/').pop());
      const label = names.length === 1 ? `Undo the change to ${names[0]}` : names.length === 2 ? `Undo changes to ${names.join(', ')}` : `Undo changes to ${names.length} files`;
      out.push({ label, run: async () => { try { await api(`/api/projects/${encodeURIComponent(id)}/undo-turn`, { offer: undo.id }); softRefresh(); } catch (e) { toast(e.message); } } });
    }
    return out;
  };
  // A finished step's one-line marker in the log is drawn by the rail (it has Show me); `rail` exists by the first event.
  const chat = makeChat(el, id, blocks, { chips, doneMarker: (ev) => rail.marker(ev), proposals });
  let sound = null; // the kit's Sound section (web/sound.js): cues on the timeline, heard while playing
  const canvas = makeCanvas($('[data-pane=canvas]', el), { inspector: $('#insCanvas', el), tools: $('#tabTools', el) }, id, () => P,
    { openScene: (sid) => { setTab('scenes'); scenes.selectScene(sid); }, openCut: (t) => openCutAt(t), blocks, history, shots, zooms,
      sfx: () => sound?.timeline() || [], pickSfx: (cid) => sound?.pick(cid), moveSfx: (cid, t) => sound?.move(cid, t),
      cues: { move: (l) => sound?.cues.move(l), remove: (ids) => sound?.cues.remove(ids), duplicate: (ids) => sound?.cues.duplicate(ids) }, muteSfx: (on) => sound?.setMute(on) });
  sound = makeSound({ host: $('#insKit', el), id, getP: () => P, media: () => canvas.media(), history });
  const post = makePostKit({ pane: $('[data-pane=post]', el), id, getP: () => P, empty: (run) => rail.empty('post', '', { run }) });
  // Scenes: the production sheet scene by scene, notes, pins and direct edits (web/scenes.js).
  let doneNotes = -1;
  const scenes = makeScenes({
    pane: $('[data-pane=scenes]', el), inspector: $('#insScenes', el), id, getP: () => P, history,
    onCount: (c) => {
      $('#scenesCount', el).textContent = c ? c.count : '';
      // Claude finished notes while you were elsewhere: a dot on the tab.
      if (c && doneNotes >= 0 && c.done > doneNotes && tab !== 'scenes') markTab('scenes', 'Claude finished notes');
      if (c) doneNotes = c.done;
    },
    onScenes: (d) => canvas.setScenes(d), openCut: (t) => openCutAt(t),
    empty: (why) => rail.empty('scenes', /^No production sheet yet/.test(why || '') ? '' : why),
  });
  const recorder = makeRecordButton(document, id, () => P);
  // The Cut tab's inspector (web/cutpanel.js): selection, "In this cut", the Keep / Cut list, Save and lock the cut.
  // Its Lock button runs the rail's Lock step (runStep, the same call as pressing it on the rail).
  const cutPanel = makeCutPanel({ id, getP: () => P, runLock: (s) => runStep(s), shots });
  // The step rail (web/rail.js): five stage chips in the bar, the next step docked on the message box, Show me, the
  // tabs' empty states and the first-time help, all from the steps' own words.
  const rail = makeRail({ root: el, id, getP: () => P, hooks: {
    runStep: (s) => runStep(s), setTab: (t) => setTab(t), glowTab: (t, why) => markTab(t, why), applyNotes: () => scenes.apply(), openCutList: () => { setTab('cut'); cutPanel.openList(); },
    learn: () => runStep({ id: 'learn', kind: 'claude' }), status: () => STATUS, composer: (name) => chat.setStep(name),
    readReply: (ts) => { setFold(false); requestAnimationFrame(() => chat.reveal(ts)); },
    newestRender: () => { if (!P.renders.length) return null; renderSel = P.renders[0].file; renderRenders(true); return $('[data-pane=renders] .rd-main', el); },
  } });
  rail.dock($('#dock', el));
  $('#exportBtn').onclick = () => setTab('renders');
  // No ffmpeg, no export: the button says where to get it (Setup's Tools card installs it after an OK).
  if (STATUS?.ffmpeg === false) Object.assign($('#exportBtn'), { disabled: true, title: 'Exporting needs ffmpeg: Setup → Tools installs it' });
  // Export kinds next to the MP4 (web/exportkinds.js): Layers and Timeline file, and their cards on the Renders tab.
  const exKinds = makeExportKinds({ id, getP: () => P, canvas, job: () => jobs.get('export'), rerender: () => renderOtherInspector(), useCut: () => exUseCut });
  const exBuilt = makeExportBuilt(id); // built blocks (the Intro Claude rendered) in Export → Video (web/exportbuilt.js)

  // steps
  async function refresh() {
    P = await api(`/api/projects/${encodeURIComponent(id)}`);
    tabNews();
    renderSteps();
    renderJobs();
    shots.update();
    zooms.update();
    canvas.update();
    chat.paintProposals();
    scenes.update();
    sound.update();
    post.update(tab === 'post');
    blocks.update();
    if (tab === 'cut') renderCut();
    if (tab === 'renders') renderRenders();
    renderOtherInspector();
  }
  let refreshTimer;
  const softRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 400); };

  // The bar: the five stages (web/rail.js), the ? for the first-time help, and ⋯ (Learn from this project, the single
  // steps Clean up runs in one go, and every other skill). A project without a format asks for one first.
  function renderSteps() {
    const host = $('#rail');
    $('#rendersCount', el).textContent = P.renders.length || '';
    if (!P.type) {
      host.replaceChildren(h(`<div class="rail-pick"><span>What kind of video is this?</span>${Object.entries(STATUS.formats).map(([k, v]) => `<button class="btn small" data-k="${k}">${esc(v)}</button>`).join('')}</div>`));
      host.querySelectorAll('[data-k]').forEach((b) => (b.onclick = async () => { await api(`/api/projects/${encodeURIComponent(id)}/type`, { type: b.dataset.k }); refresh(); }));
      rail.update();
      return;
    }
    const pl = P.pipeline;
    let more = host.querySelector('.rail-more');
    const moreSig = JSON.stringify((pl.more || []).map((m) => [m.id, m.done]));
    if (!more || (!more.open && more.dataset.sig !== moreSig)) {
      more = h(`<details class="rail-more"><summary aria-label="More: learn from this project, other skills">${ICON.more}</summary>
      <div class="menu"><button class="mi learn" title="${esc(pl.learn.ask)}"><b>${esc(pl.learn.label)}</b><small>Save reusable pieces and lessons into your library</small></button>
        ${pl.more?.length ? `<div class="menu-h">${esc(pl.steps.find((x) => x.id === 'prepare')?.name || 'Clean up')}, one step at a time</div>${pl.more.map((m) => `<button class="mi step" data-step="${esc(m.id)}" title="${esc(m.what)}"><b>${m.done ? '✓ ' : ''}${esc(m.name)}</b><small>/${esc(m.skill || '')}${m.done ? ' · done' : ''}</small></button>`).join('')}` : ''}
        <div class="menu-h">Skills</div><div class="skill-list">Loading…</div></div></details>`);
      more.dataset.sig = moreSig;
      $('.learn', more).onclick = () => { more.open = false; runStep({ id: 'learn', kind: 'claude' }); };
      more.querySelectorAll('[data-step]').forEach((x) => (x.onclick = () => { more.open = false; runStep({ id: x.dataset.step, kind: 'claude' }); }));
      more.addEventListener('toggle', async () => {
        if (!more.open) return;
        rail.closePop();
        const skills = await api(`/api/skills?type=${encodeURIComponent(P.type)}`);
        const list = $('.skill-list', more);
        list.replaceChildren(...skills.map((sk) => {
          const b = h(`<button class="mi skill" title="${esc(sk.description)}"><b>/${esc(sk.name)}</b><small>${esc(sk.description)}</small></button>`);
          b.onclick = () => { more.open = false; chat.sendSkill(sk.name); };
          return b;
        }));
        if (!skills.length) list.textContent = 'No skills found in this studio.';
      });
      host.querySelector('.rail-more')?.replaceWith(more);
    }
    if (!host.querySelector('.stages')) rail.bar(host, more);
    rail.update();
  }
  const railRO = new ResizeObserver(() => rail.fit());
  railRO.observe($('#rail'));
  document.addEventListener('click', closeMenus);
  function closeMenus(e) { const m = $('#rail .rail-more'); if (m?.open && !m.contains(e.target)) m.open = false; }

  // The inspector for the Cut and Renders tabs (the canvas fills its own).
  function renderOtherInspector() {
    const box = $('#insOther', el);
    if (tab === 'cut') cutPanel.render(box);
    else if (tab === 'renders') renderExportPanel(box);
    else if (tab === 'post') post.inspector(box);
  }

  // ---------- Export panel (inspector of the Renders tab) ----------
  let exUseCut = true;
  const nextRender = (preset) => {
    const base = `${id}_${preset}`, re = new RegExp(`^renders/${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_v(\\d+)\\.mp4$`);
    let n = 1;
    for (const r of P.renders) { const m = re.exec(r.file); if (m) n = Math.max(n, Number(m[1]) + 1); }
    return `${base}_v${n}.mp4`;
  };
  function renderExportPanel(box) {
    if (exKinds.panel(box)) return; // Layers · Timeline file (web/exportkinds.js)
    const x = P.export, ready = canvas.ready(), sc = ready ? canvas.scene() : null, ly = canvas.layout();
    const job = jobs.get('export') || (x.running ? { label: x.running.label, progress: x.running.progress, cancel: true } : null);
    const aspect = ly?.aspect || '16:9';
    const useCut = exUseCut && Boolean(x.cut);
    const layersWithSound = (ly?.layers || []).filter((l) => l.audio).length;
    const sound = (x.audio === 'cam' ? 'Camera mic' : x.audio === 'screen' ? 'Screen recording sound' : x.audio === 'audio' ? 'Mic (audio-only take)' : 'No sound') + (layersWithSound ? ` + ${layersWithSound} layer${layersWithSound > 1 ? 's' : ''}` : '')
      + ((n) => (n > 0 ? ` + ${n} sound cue${n > 1 ? 's' : ''} under the voice` : ''))((P.kit?.cues || 0) - exBuilt.cuesOut(x.built));
    // The camera's card look and the background (web/look.js), when they show in this layout.
    const camCard = sc?.layers.find((l) => l.role === 'cam' && l.card);
    const edgeText = (f) => (f.border === 'none' ? 'no border' : `${f.border.startsWith('#') ? borderLabel(f.border) : borderLabel(f.border).toLowerCase()} border`);
    const camLook = camCard && ly ? [sc.preset === 'pip' ? SHAPES[ly.cam.shape] : null, edgeText(ly.cam), ly.cam.shadow ? 'shadow' : 'no shadow'].filter(Boolean).join(' · ') : '';
    // The screen's crop and zoom, and its card edge in PiP with an inset (in Boxed it matches the camera card).
    const scrLy = sc?.layers.find((l) => l.role === 'screen');
    const sf = ly?.screen, sd = x.dims?.screen;
    const cropText = sf && sd && Object.values(sf.crop).some((v) => v > 0) ? `cropped to ${Math.round((1 - sf.crop.l - sf.crop.r) * sd[0])} × ${Math.round((1 - sf.crop.t - sf.crop.b) * sd[1])}` : '';
    const scrLook = scrLy && sf ? [cropText, sf.zoom > 1.005 ? `${sf.zoom.toFixed(2)}× zoom` : '', sc.preset === 'pip' && scrLy.card ? edgeText(sf) : ''].filter(Boolean).join(' · ') : '';
    const bgLook = sc?.bgVisible ? `${sc.bg.name || BG_KINDS[sc.bg.kind]}${['stars', 'led', 'code'].includes(sc.bg.kind) ? ' · drawn frame by frame first' : sc.bg.kind === 'video' ? ' · looped' : ''}` : '';
    // Shots with their own look (work/shots.json): the export renders each stretch in its shot's look (web/exportshots.js).
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const sh = ly && x.duration ? shotsSummary({ base: normalize(ly, P.type), shots: P.shots, zooms: P.zooms, segs: useCut ? x.cut.segments : [[0, Math.floor(x.duration * 30) / 30]], cut: useCut ? x.cut.segments : null, duration: x.duration }) : null;
    const TRW = { fade: 'crossfade', slide: 'slide', zoom: 'zoom transition' };
    const shotsLook = sh ? [sh.changes ? plural(sh.shots, 'shot') : '', sh.changes ? plural(sh.looks, 'look') : '', Object.entries(sh.kinds || {}).map(([k, n]) => plural(n, TRW[k] || 'transition')).join(', '), sh.zooms ? plural(sh.zooms, 'zoom') : ''].filter(Boolean).join(' · ') : '';
    const waitingProps = proposalsOf(P.shots, P.zooms), waitN = waitingProps.shots.length + waitingProps.zooms.length;
    const frame = (a, w, hh, cls) => `<button type="button" class="exf${a === aspect ? ' on' : ''}" role="radio" aria-checked="${a === aspect}" data-a="${a}"${ready ? '' : ' disabled'}><span class="exs ${cls}" aria-hidden="true"></span><span><b>${a}</b><small>${w} × ${hh}</small></span></button>`;
    box.replaceChildren(h(`<div class="ins-body ex">
      <div class="ins-head"><b>Export</b><span class="sub">renders on this computer</span></div>
      <section><h3 id="exFrameL">Frame</h3><div class="ex-frames" role="radiogroup" aria-labelledby="exFrameL">${frame('16:9', 1920, 1080, 'wide')}${frame('9:16', 1080, 1920, 'tall')}</div></section>
      <section><h3>Length</h3>
        ${x.cut ? `<label class="ex-opt"><input type="radio" name="exlen" value="cut"${useCut ? ' checked' : ''}><span><b>${esc(cutWord(x.cut))}</b><small>${esc(x.cut.file)} · ${x.cut.count} part${x.cut.count > 1 ? 's' : ''} · ${clock(x.cut.duration)}</small></span></label>` : ''}
        <label class="ex-opt"><input type="radio" name="exlen" value="whole"${useCut ? '' : ' checked'}><span><b>Whole take</b><small>${x.duration ? clock(x.duration) : 'no recording yet'}</small></span></label>
        ${x.cut ? '' : '<p class="sub">No locked cut yet: the Cut tab’s Save or the join check writes one.</p>'}</section>
      <section><h3>What goes in</h3><dl class="facts">
        <dt>Layout</dt><dd class="plain">${sc ? esc(PRESETS[sc.preset] || 'Background only (audio-only take)') : '–'}</dd>
        ${camLook ? `<dt>Camera</dt><dd class="plain">${esc(camLook)}</dd>` : ''}
        ${scrLook ? `<dt>Screen</dt><dd class="plain">${esc(scrLook)}</dd>` : ''}
        ${bgLook ? `<dt>Background</dt><dd class="plain">${esc(bgLook)}</dd>` : ''}
        ${shotsLook || waitN ? `<dt>Shots</dt><dd class="plain">${esc(shotsLook || 'The video’s look')}<div class="sub">${shotsLook ? 'Each stretch renders in its shot’s look, with its zooms. ' : ''}${waitN ? `Claude’s ${proposalWords(waitingProps)} ${waitN === 1 ? 'is' : 'are'} left out until you keep ${waitN === 1 ? 'it' : 'them'} (Keep it on the Shots and Zooms lanes).` : 'Proposals you haven’t kept are left out.'}</div></dd>` : ''}
        ${exBuilt.html(x.built)}
        <dt>Sound</dt><dd class="plain">${esc(sound)}</dd>
        ${blocks.exportNote()}
        <dt>File</dt><dd>renders/${sc ? esc(nextRender(sc.preset)) : '…'}</dd></dl></section>
      ${exKinds.captionsHTML(aspect)}
      ${job ? `<section><div class="ex-job" role="status"><div class="ex-job-top"><span class="dot" aria-hidden="true"></span><b>${esc(job.label)}</b>${job.cancel ? '<button class="btn small" id="exStop">Stop</button>' : ''}</div>
        <i><b style="width:${Math.round((job.progress || 0) * 100)}%"></b></i><span class="sub">${Math.round((job.progress || 0) * 100)}%</span></div></section>` : ''}
      <section class="ex-go">
        <button class="btn dark wide big" id="exGo"${ready && !job && STATUS?.ffmpeg !== false ? '' : ' disabled'}>${ICON.export}${job ? 'Exporting…' : P.renders.length ? 'Export a new version' : 'Export'}</button>
        ${STATUS?.ffmpeg === false ? '<p class="sub">Exporting needs ffmpeg: <a href="#/setup">Setup → Tools</a> installs it.</p>' : ready ? '' : '<p class="sub">Add a recording first, and wait until its playback copies are ready.</p>'}
        <button class="btn wide" id="exLearn" title="${esc(P.pipeline?.learn?.ask || '')}">Learn from this project</button>
        <p class="sub ta-c">Saves reusable pieces and lessons into your library.</p></section>
    </div>`));
    exKinds.picker(box);
    exKinds.wireCaptions(box);
    exBuilt.wire(box, x.built, () => renderExportPanel(box));
    box.querySelectorAll('.exf').forEach((b) => (b.onclick = () => { canvas.setAspect(b.dataset.a); renderExportPanel(box); }));
    box.querySelectorAll('input[name=exlen]').forEach((r) => (r.onchange = () => { exUseCut = r.value === 'cut'; }));
    $('#exStop', box) && ($('#exStop', box).onclick = () => api(`/api/projects/${encodeURIComponent(id)}/export-stop`, {}));
    $('#exLearn', box).hidden = !P.type;
    $('#exLearn', box).onclick = () => runStep({ id: 'learn', kind: 'claude' });
    $('#exGo', box).onclick = async () => {
      if (!canvas.ready()) return toast('Add a recording first, and wait until its playback copies are ready.');
      $('#exGo', box).disabled = true;
      try { await api(`/api/projects/${encodeURIComponent(id)}/export`, { layout: canvas.layout(), useCut: exUseCut && Boolean(P.export.cut), pngs: { ...canvas.exportLayers(), looks: canvas.lookPngs(canvas.layout()) }, captions: exKinds.captions(), built: exBuilt.choice(P.export.built) }); }
      catch (e) { toast(e.message); $('#exGo', box).disabled = false; }
    };
  }

  async function runStep(s) {
    rail.dismissDone(); // Run puts the strip's green "done" away
    if (s.kind === 'app' && s.action === 'import') { setTab('canvas'); canvas.showImport(); return; }
    if (s.kind === 'app' && s.action === 'open-cut') { setTab('cut'); return; }
    if (s.kind === 'app' && s.action === 'open-scenes') { setTab('scenes'); return; }
    if (s.id === 'post-kit') { setTab('post'); return; } // the Post tab writes the kit (work/post.json and post.md)
    try { await api(`/api/projects/${encodeURIComponent(id)}/step`, { step: s.id }); }
    catch (e) { toast(e.message); }
  }

  // Cut tab: the Cut Editor (web/cut-editor/, built in: server/cuteditor.mjs gives it the project's files), in a frame
  // on this same address. Settings → Editing picks the trim options (A always; B highlight first, C the fine-trim
  // pop-up), passed as ?trim=hl,lens.
  let cutUrl = null, cutTrim = null, cutBarAt = 0;
  const trimParam = () => [P.editing?.trimHighlight && 'hl', P.editing?.trimLens && 'lens'].filter(Boolean).join(',');
  async function renderCut() {
    const pane = $('[data-pane=cut]', el);
    if (cutUrl && cutTrim !== trimParam()) cutUrl = null; // the trim options changed: reopen the editor with them
    if (!P.cut.ready) {
      cutUrl = null;
      // Before Clean up: which step fills this tab and the way there (web/rail.js); a project without a format, the reason.
      pane.replaceChildren(rail.empty('cut', P.cut.why) || h(`<div class="blank"><h3>The Cut Editor isn't ready yet</h3><div>${esc(P.cut.why)}</div></div>`));
      return;
    }
    if (cutUrl && pane.querySelector('iframe')) { if (Date.now() - cutBarAt > 2500) refreshCutBar(); return; }
    pane.replaceChildren(h(`<div class="blank"><span class="spin" style="display:inline-block"></span><div style="margin-top:10px">Opening the Cut Editor…</div></div>`));
    const r = await api(`/api/projects/${encodeURIComponent(id)}/cut`, {});
    if (!r.ok) { pane.replaceChildren(h(`<div class="blank"><h3>Couldn't open the Cut Editor</h3><div>${esc(r.why)}</div></div>`)); return; }
    cutUrl = r.url; cutTrim = trimParam();
    // &autosave=1: the Cut Editor saves about a second after each change (its own window keeps Save / ⌘S only).
    // &theme=studio: Video Octopus's light look and Geist, and the line to the Cut inspector;
    // &look= and #look=: Settings → Appearance's look and its colours and fonts (web/appearance.js), followed live after.
    const frame = h(`<iframe class="cut studio" src="${esc(cutUrl)}&amp;autosave=1&amp;trim=${encodeURIComponent(cutTrim)}&amp;theme=studio${esc(cutLookParams())}" allow="autoplay"></iframe>`);
    // The files it opened and "Open in its own window" are in the inspector (web/cutpanel.js).
    pane.replaceChildren(h('<div class="cut-bar" id="cutBar" role="status" hidden></div>'), frame);
    cutPanel.attach(frame, cutUrl);
    refreshCutBar();
  }

  // The cut changed: every save in the Cut Editor tells us (the cut as it opened and as it is now), and it waits in
  // the change package as one item until "Save changes → Claude" sends it with everything else. Claude then
  // re-aligns whatever sits on the old timeline (scene times, graphics, keyframes, B-roll) and re-renders.
  const notesApi = (b) => api(`/api/projects/${encodeURIComponent(id)}/notes`, b);
  async function refreshCutBar() { cutBarAt = Date.now(); try { paintCutBar((await notesApi({ op: 'list' })).notes); } catch {} }
  function paintCutBar(notes = []) {
    const bar = $('#cutBar', el);
    if (!bar) return;
    const c = notes.filter((n) => n.kind === 'change' && n.field === 'cut').sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    const open = notes.filter((n) => n.status === 'open').length;
    if (!c || c.status === 'resolved') { bar.hidden = true; return; }
    bar.hidden = false;
    bar.className = `cut-bar ${c.status}`;
    if (c.status === 'open') bar.innerHTML = `<span class="cb-ic" aria-hidden="true">✂</span><div class="cb-t"><b>The cut changed</b><span class="sub">${esc(c.text.replace(/^The cut changed: /, ''))} · Claude re-aligns the scenes, graphics, keyframes and B-roll after these points</span></div>
      <button class="btn accent" id="cbSend" title="Sends everything waiting (${open} item${open > 1 ? 's' : ''}) to Claude, who confirms and re-aligns the timings">${ICON.claude}Save changes → Claude${open > 1 ? ` · ${open}` : ''}</button>`;
    else if (c.status === 'sent') bar.innerHTML = `<span class="spin" aria-hidden="true"></span><div class="cb-t"><b>Sent to Claude</b><span class="sub">Re-aligning the timings after the cut change. Follow along in the chat.</span></div>`;
    else bar.innerHTML = `<span class="cb-ic ok" aria-hidden="true">✓</span><div class="cb-t"><b>${c.status === 'question' ? 'Claude has a question' : 'Claude re-aligned the timings'}</b><span class="sub">${esc(c.reply || '')}</span></div>${c.status === 'done' ? '<button class="btn small" id="cbOk">Looks good</button>' : ''}`;
    $('#cbSend', bar)?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try { const r = await api(`/api/projects/${encodeURIComponent(id)}/apply-notes`, {}); toast(`Sent to Claude: ${[r.notes && `${r.notes} note${r.notes > 1 ? 's' : ''}`, r.changes && `${r.changes} change${r.changes > 1 ? 's' : ''}`, r.moves && `${r.moves} move${r.moves > 1 ? 's' : ''}`].filter(Boolean).join(', ')}.`); softRefresh(); }
      catch (err) { toast(err.message); }
      refreshCutBar();
    });
    $('#cbOk', bar)?.addEventListener('click', async () => { try { paintCutBar((await notesApi({ op: 'update', id: c.id, status: 'resolved' })).notes); } catch (err) { toast(err.message); } });
  }
  async function onCutMessage(e) {
    // Only the Cut tab's frame (other frames on this address, like a scene in Scenes, never speak for the cut).
    const f = $('[data-pane=cut] iframe', el);
    if (!f || e.source !== f.contentWindow || e.origin !== location.origin) return;
    if (cutPanel.onMessage(e.data)) return; // the selection and the cut as they change, for the inspector
    if (e.data?.type !== 'studio:cut-saved') return;
    // The server compares the cut with the one the scenes and renders are on (work/cut_scenes.json), and counts the
    // edit (the cut as the editor opened it, and now) as the creator's decision on the parts it touches.
    const edit = Array.isArray(e.data.base) && Array.isArray(e.data.segments) ? { base: e.data.base, segments: e.data.segments } : {};
    try { paintCutBar((await api(`/api/projects/${encodeURIComponent(id)}/cut-sync`, edit)).notes); softRefresh(); }
    catch (err) { toast(err.message); }
  }
  addEventListener('message', onCutMessage);
  // Scenes points at a cut: open the Cut tab there (the Cut Editor centres on it, and opens the fine trim when it's on).
  function openCutAt(t) {
    setTab('cut');
    const go = (n = 0) => { const f = $('[data-pane=cut] iframe', el); if (f?.contentWindow && editorThere(f)) f.contentWindow.postMessage({ type: 'studio:cut-goto', t }, location.origin); else if (n < 40) setTimeout(() => go(n + 1), 250); };
    setTimeout(go, 400);
  }

  // ---------- Renders tab: the chosen render big (player, waveform, details), the other versions below ----------
  let renderSel = null, rendersSig = '', waveStop = null, rdCmp = null;
  let rendersFinal; // the render marked Final (project.json finalRender), as last drawn
  const mediaUrl = (f) => `/api/projects/${encodeURIComponent(id)}/media?f=${encodeURIComponent(f)}`;
  const mb = (b) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format((b || 0) / 1e6);
  const madeAt = (ms) => new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms);
  function renderRenders(force = false) {
    const pane = $('[data-pane=renders]', el);
    if (P.finalRender !== rendersFinal) { rendersFinal = P.finalRender; force = true; } // marked Final here or by Claude
    const sel = P.renders.find((r) => r.file === renderSel) || P.renders[0];
    const sig = JSON.stringify([P.renders.map((r) => [r.file, r.at, r.bytes]), sel?.file, (P.layerExports || []).map((x) => [x.folder, x.at]), (P.textExports || []).map((x) => [x.file, x.at])]);
    if (!force && sig === rendersSig && pane.firstChild) return;
    rendersSig = sig;
    waveStop?.(); waveStop = null; rdCmp?.destroy(); rdCmp = null;
    if (!sel) {
      pane.replaceChildren(rail.empty('renders', 'Videos in this project’s renders/ folder show up here; Export renders the canvas with the panel on the right.') || h(`<div class="blank"><h3>No renders yet</h3><div>Export the canvas with the panel on the right, or ask Claude to render an edit. Videos in this project's renders/ folder show up here.</div></div>`));
      const lx = exKinds.cards();
      if (lx) { const wrap = h('<div class="rd"></div>'); wrap.append(lx); pane.append(wrap); }
      return;
    }
    // Renders are grouped by what they are (a Build step's videos, Video exports; web/exportbuilt.js): "latest" is per group.
    const newestOf = (g) => P.renders.find((r) => (r.group || '') === (g || ''));
    const newest = sel === newestOf(sel.group);
    const others = P.renders.filter((r) => r !== sel);
    const prev = previousOf(P.renders, sel.file); // "Compare with vN": the version before, in step, under a before/after line
    const name = (r) => r.file.replace(/^renders\//, '');
    // Final (marked on this tab), and an earlier render that is the same file again (same size and length).
    const isFinal = sel.file === P.finalRender;
    const twin = sel.duration ? P.renders.find((r) => r !== sel && r.bytes === sel.bytes && r.duration && Math.abs(r.duration - sel.duration) < 0.05) : null;
    const base = (r) => name(r).replace(/_v\d+\.\w+$/, ''), vOf = (r) => /_v(\d+)\.\w+$/.exec(name(r))?.[1];
    const twinName = twin ? (vOf(twin) && base(twin) === base(sel) ? `v${vOf(twin)}` : name(twin)) : '';
    const view = h(`<div class="rd">
      <div class="rd-main">
        <div class="rd-play">
          <div class="rd-v"><video controls preload="metadata" playsinline src="${mediaUrl(sel.file)}#t=0.1"></video></div>
          <div class="rd-wave" title="Click to jump"><canvas aria-label="Waveform of ${esc(name(sel))}: click to jump"></canvas></div>
        </div>
        <div class="rd-info">
          <div class="rd-tags"><span class="badge${newest || isFinal ? ' latest' : ''}">${sel.what ? `${esc(sel.what)} · ` : ''}${isFinal ? `Final · ${newest ? 'latest' : 'earlier version'}` : newest ? 'Latest' : 'Earlier version'}</span><button class="btn ghost small" id="rdFinal" aria-pressed="${isFinal}" title="${isFinal ? 'Take the Final mark off this render' : 'Mark this render as the final version (Home and Claude see it)'}">${isFinal ? 'Unmark final' : 'Mark as final'}</button></div>
          <div class="rd-name">${esc(name(sel))}</div>
          <dl class="facts rd-facts">
            ${sel.duration ? `<dt>Length</dt><dd class="plain">${clock(sel.duration)}</dd>` : ''}
            <dt>Size</dt><dd class="plain">${mb(sel.bytes)} MB${sel.w ? ` · ${sel.w} × ${sel.h}` : ''}${sel.codec ? ` · ${esc(CODEC[sel.codec] || sel.codec.toUpperCase())}` : ''}</dd>
            ${sel.duration ? `<dt>Sound</dt><dd class="plain">${sel.audio ? 'Yes' : 'No sound'}</dd>` : ''}
            <dt>Made</dt><dd class="plain">${esc(madeAt(sel.at))}${Date.now() - sel.at < 86400000 ? ` · ${ago(sel.at)}` : ''}</dd>
            ${twin ? `<dt>Same as</dt><dd class="plain" title="${esc(name(twin))} has the same size and length">${esc(twinName)}</dd>` : ''}
            <dt>Folder</dt><dd title="${esc(tilde(P.path))}/renders">${esc(STATUS.projectsDir)}/${esc(id)}/renders/</dd></dl>
          <span class="gap"></span>
          <div class="rd-actions">
            <button class="btn dark" id="rdPlay">Play</button>
            ${prev ? `<button class="btn" id="rdCmp" aria-pressed="false" title="Play ${esc(versionName(prev.file))} in step with this one, under a before/after line you drag">Compare with ${esc(versionName(prev.file))}</button>` : ''}
            <button class="btn" id="rdReveal">Show in ${fileManager()}</button>
            ${P.scenes?.count ? '<button class="btn" id="rdScenes">Review in scenes</button>' : ''}
          </div>
          <div class="rd-actions rd-lib"></div>
        </div>
      </div>
      ${renderGroups(others.length ? P.renders : [], sel).map((g) => `<div class="rd-head"><b>${g.own ? `${newest ? 'Earlier' : 'Other'} ${esc(g.group.toLowerCase())}` : esc(g.group)}</b><span class="sub">newest first · click one to watch it</span></div>
      <div class="rd-grid">${g.list.map((r) => `<button class="rcard" data-f="${esc(r.file)}">
          <span class="rthumb"><video muted preload="metadata" playsinline src="${mediaUrl(r.file)}#t=1" tabindex="-1"></video>${r.duration ? `<span class="dur">${clock(r.duration).replace(/\.\d$/, '')}</span>` : ''}${r === newestOf(r.group) ? '<span class="tag">Latest</span>' : ''}</span>
          <span class="rname">${esc(name(r))}</span><span class="sub">${mb(r.bytes)} MB · ${ago(r.at)}</span></button>`).join('')}</div>`).join('')}
    </div>`);
    const lx = exKinds.cards();
    if (lx) view.append(lx);
    pane.replaceChildren(view);
    const video = $('.rd-play video', view);
    $('#rdPlay', view).onclick = () => { video.paused ? video.play() : video.pause(); };
    video.addEventListener('play', () => ($('#rdPlay', view).textContent = 'Pause'));
    video.addEventListener('pause', () => ($('#rdPlay', view).textContent = 'Play'));
    $('#rdReveal', view).onclick = () => api(`/api/projects/${encodeURIComponent(id)}/reveal`, { file: sel.file });
    $('#rdCmp', view)?.addEventListener('click', (e) => {
      rdCmp ||= makeCompare($('.rd-v', view), { main: () => video, keep: 44 });
      const on = !rdCmp.mode();
      rdCmp.set(on ? 'split' : null, `${mediaUrl(prev.file)}&v=${Math.round(prev.at)}`, [versionName(prev.file), versionName(sel.file)]);
      e.currentTarget.classList.toggle('on', on); e.currentTarget.setAttribute('aria-pressed', String(on));
      e.currentTarget.textContent = on ? `Comparing with ${versionName(prev.file)}` : `Compare with ${versionName(prev.file)}`;
    });
    if ($('#rdScenes', view)) $('#rdScenes', view).onclick = () => setTab('scenes');
    libraryButtons($('.rd-lib', view), id, sel.file, () => video); // Save to library: the video, or the frame it's on (web/library.js)
    view.querySelectorAll('.rcard').forEach((b) => (b.onclick = () => { renderSel = b.dataset.f; renderRenders(); $('[data-pane=renders]', el).scrollTop = 0; }));
    waveStop = miniWave($('.rd-wave canvas', view), video, `/api/projects/${encodeURIComponent(id)}/peaks?f=${encodeURIComponent(sel.file)}`);
    // Mark as final / unmark; the final one carries a tag in the grid too.
    $('#rdFinal', view).onclick = async () => {
      try { P.finalRender = (await api(`/api/projects/${encodeURIComponent(id)}/final`, { file: isFinal ? null : sel.file })).finalRender; renderRenders(true); toast(P.finalRender ? `${name(sel)} is marked final.` : 'Final mark taken off.'); }
      catch (e) { toast(e.message); }
    };
    if (P.finalRender) view.querySelector(`.rcard[data-f="${CSS.escape(P.finalRender)}"] .rthumb`)?.append(h('<span class="tag final">Final</span>'));
  }

  // live events
  const jobs = new Map();
  // A built-in recorder take whose page closed mid-take: offer to finish it (the parts are kept until then).
  const recoverCards = () => (P.recUnfinished || []).filter((u) => u.take !== rec.session().take && !jobs.has(`rec-${u.take}`)).map((u) => {
    const at = new Date(u.started).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const row = h(`<div class="job rec-recover"><div class="job-top"><span><b>Unsaved take from ${esc(at)}</b> · about ${clock(u.seconds).replace(/\.\d$/, '')} recorded before the page closed.</span>
      <button class="btn small dark" data-a="finish">Finish the unsaved take</button><button class="btn ghost small" data-a="later" title="Hide it; the recorded parts stay in your recordings folder">Not now</button></div></div>`);
    $('[data-a=finish]', row).onclick = async (e) => {
      e.target.disabled = true;
      try { await rec.recover(id, u.take); P.recUnfinished = P.recUnfinished.filter((x) => x.take !== u.take); renderJobs(); } catch (err) { toast(err.message); e.target.disabled = false; }
    };
    $('[data-a=later]', row).onclick = async () => {
      try { await api(`/api/projects/${encodeURIComponent(id)}/rec-dismiss`, { take: u.take }); } catch {}
      P.recUnfinished = P.recUnfinished.filter((x) => x.take !== u.take); renderJobs();
    };
    return row;
  });
  const renderJobs = () => {
    $('#jobs', el).replaceChildren(...recoverCards(), ...[...jobs.values()].filter((j) => !(j.id === 'export' && tab === 'renders')).map((j) => {
      const row = h(`<div class="job"><div class="job-top"><span>${esc(j.label)}</span>${j.cancel ? '<button class="btn ghost small" title="Stop this export">Stop</button>' : ''}</div><i><b style="width:${Math.round(j.progress * 100)}%"></b></i></div>`);
      const stop = $('button', row);
      if (stop) stop.onclick = () => api(`/api/projects/${encodeURIComponent(id)}/export-stop`, {});
      return row;
    }));
  };
  const es = new EventSource(`/api/projects/${encodeURIComponent(id)}/events`);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.t === 'files') return softRefresh();
    if (ev.t === 'busy') softRefresh(); // the rail shows Prepare running / done
    if (ev.t === 'usage') return showUsage(ev);
    if (ev.t === 'take') {
      if (ev.error) return toast(ev.error);
      toast(takeMessage(ev));
      setTab('canvas');
      return softRefresh();
    }
    if (ev.t === 'job') {
      if (ev.done) {
        jobs.delete(ev.id);
        if (!ev.ok) toast(ev.label);
        else if (ev.folder || ev.kind === 'audio') exKinds.finished(ev, () => { setTab('renders'); renderRenders(true); });
        else if (ev.file) {
          renderSel = ev.file;
          markTab('renders', 'new render');
          if (ev.receipt && !ev.replay) printReceipt($('.tab-body', el), ev.receipt, {
            watch: () => { renderSel = ev.receipt.file; setTab('renders'); renderRenders(true); $('.rd-play video', el)?.play().catch(() => {}); },
            reveal: () => api(`/api/projects/${encodeURIComponent(id)}/reveal`, { file: ev.receipt.file }),
          });
          else toast(`${ev.label}. It's in the Renders tab.`);
        }
      } else jobs.set(ev.id, ev);
      renderJobs();
      if (tab === 'renders' && ev.id === 'export') renderOtherInspector();
      return;
    }
    // Folded away: a dot on the rail for news, and Claude unfolds by itself when it needs an answer.
    if (el.classList.contains('folded') && !ev.replay) {
      if (ev.t === 'permission' || ev.t === 'question') setFold(false);
      else if (['text', 'note', 'error', 'result'].includes(ev.t)) $('.chat-dot', el).hidden = false;
    }
    chat.handle(ev);
  };

  tabNews();
  renderSteps();
  canvas.update();
  scenes.update();
  sound.update();
  blocks.update();
  const lastTab = (() => { try { return sessionStorage.getItem(`studio.tab.${id}`); } catch { return null; } })();
  setTab(pendingRecord !== id && TABS.some(([k]) => k === lastTab) ? lastTab : 'canvas');
  if (pendingRecord === id) { pendingRecord = null; setTimeout(() => $('#recBtn')?.click(), 250); }
  else setTimeout(() => rail.maybeHelp(), 300); // once, on the first project page after this shipped (settings help.stepsIntro)
  return { teardown: () => { es.close(); chat.destroy(); railRO.disconnect(); rail.destroy(); waveStop?.(); rdCmp?.destroy(); canvas.destroy(); scenes.destroy(); sound.destroy(); post.destroy(); recorder.destroy(); blocks.destroy(); document.removeEventListener('click', closeMenus); document.removeEventListener('keydown', foldKeys); removeEventListener('message', onCutMessage); cutPanel.destroy(); clearBar(); } };
}

// ---------- export receipt: prints out of a slot when an export finishes ----------
function printReceipt(host, r, { watch, reveal }) {
  host.querySelector('.receipt-slot')?.remove();
  const presetName = { screen: 'Screen', camera: 'Camera', pip: 'Picture-in-picture', split: 'Split', boxed: 'Boxed' }[r.preset] || r.preset;
  const size = r.aspect === '9:16' ? '1080 × 1920' : '1920 × 1080';
  const mb = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format((r.bytes || 0) / 1e6);
  const when = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(r.at || Date.now());
  const name = r.file.replace(/^renders\//, '');
  const slot = h(`<div class="receipt-slot"><div class="receipt" role="status" aria-label="Export finished: ${esc(name)}">
    <div class="r-head"><b>Export finished</b><span>${esc(when)}</span></div>
    <div class="r-file">${esc(name)}</div>
    <dl class="r-rows">
      <dt>Layout</dt><dd>${esc(presetName)} · ${esc(r.aspect)} · ${esc(size)}</dd>
      <dt>Length</dt><dd>${clock(r.duration)} · ${r.cut ? 'locked cut' : 'whole take'}</dd>
      <dt>File</dt><dd>${mb} MB · took ${r.seconds || '<1'} s</dd>
    </dl>
    <div class="r-actions"><button class="btn small dark" data-a="watch">Watch it</button><button class="btn small" data-a="reveal">Show in ${fileManager()}</button><button class="btn ghost small r-x" data-a="close">Close</button></div>
  </div></div>`);
  const close = () => { slot.classList.add('out'); setTimeout(() => slot.remove(), 320); };
  slot.querySelector('[data-a=watch]').onclick = () => { watch(); close(); };
  slot.querySelector('[data-a=reveal]').onclick = () => reveal();
  slot.querySelector('[data-a=close]').onclick = close;
  let timer = setTimeout(close, 15000);
  slot.onpointerenter = () => clearTimeout(timer);
  slot.onpointerleave = () => { timer = setTimeout(close, 6000); };
  host.append(slot);
}

// ---------- a small waveform under a render: its sound, what has played, click to jump ----------
// Peaks come from the server (/peaks, read once with ffmpeg and cached). Returns a stop function.
function miniWave(cv, video, peaksUrl) {
  let peaks = null, raf = 0, alive = true, col = null;
  api(peaksUrl).then((p) => { if (alive) { peaks = p?.data?.length ? p : null; draw(); } }).catch(() => {});
  // The look's colours (Settings → Appearance), read again when the look changes (here or in another tab).
  const colors = () => { const t = tokens(); col = { wave: t('--tl-wave', '#8e8d88'), played: t('--text', '#1a1a1c'), head: t('--playhead', '#c2410c'), line: t('--line', '#e6e5e1') }; };
  colors();
  const offLook = onLook(() => { colors(); draw(); });
  function draw() {
    const w = cv.clientWidth, hh = cv.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!w || !hh) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);
    const dur = video.duration || (peaks ? peaks.data.length / peaks.rate : 0);
    const at = dur ? Math.min(1, video.currentTime / dur) : 0;
    if (!peaks) { g.fillStyle = col.line; g.fillRect(0, hh / 2, w, 1); }
    else {
      const n = peaks.data.length, step = 3;
      for (let x = 0; x < w; x += step) {
        const a = Math.floor((x / w) * n), b = Math.max(a + 1, Math.floor(((x + step) / w) * n));
        let m = 0;
        for (let i = a; i < b && i < n; i++) if (peaks.data[i] > m) m = peaks.data[i];
        const bh = Math.max(1.5, Math.min(1, Math.sqrt(m / 100) * 1.1) * (hh - 4));
        g.fillStyle = x / w < at ? col.played : col.wave;
        g.fillRect(x, (hh - bh) / 2, 2, bh);
      }
    }
    if (dur) { g.fillStyle = col.head; g.fillRect(Math.round(at * w) - 1, 0, 2, hh); }
  }
  const loop = () => { cancelAnimationFrame(raf); draw(); if (!video.paused && alive) raf = requestAnimationFrame(loop); };
  video.addEventListener('play', loop);
  ['seeked', 'loadedmetadata', 'pause', 'timeupdate'].forEach((e) => video.addEventListener(e, () => { if (video.paused) draw(); }));
  cv.addEventListener('pointerdown', (e) => { const b = cv.getBoundingClientRect(); if (video.duration) video.currentTime = Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)) * video.duration; });
  const ro = new ResizeObserver(draw);
  ro.observe(cv);
  return () => { alive = false; cancelAnimationFrame(raf); ro.disconnect(); offLook(); };
}

// ---------- chat panel ----------
// ext (blocks, M3b): attachComposer(textarea) adds @mentions; beforeSend(text) → text with references, or null when
// it was handled in the app ("@Sponsor read record new"); renderUser(text) → html with mention chips.
// Claude Code's model sources (server/claude-source.mjs), for the session list.
const SOURCE_NAMES = { ollama: 'Ollama', lmstudio: 'LM Studio', provider: 'another provider' };
function makeChat(root, id, ext = {}, opts = {}) {
  const msgs = $('#msgs', root), input = $('#input', root), sendBtn = $('#sendBtn', root);
  // Quick replies: a few one-tap answers after Claude finishes a turn, from opts.chips(last
  // reply) → [{label, text} to send, or {label, run()}]. They go away as soon as anything new happens in the chat.
  let chipRow = null, lastText = '', undoOffer = null, turnOver = false;
  const clearChips = () => { chipRow?.remove(); chipRow = null; };
  const showChips = () => {
    clearChips();
    const list = (opts.chips?.(lastText, { undo: undoOffer }) || []).slice(0, 4);
    if (!list.length) return;
    chipRow = h(`<div class="qr-row" role="group" aria-label="Quick replies"></div>`);
    for (const c of list) {
      const b = h(`<button type="button" class="qr">${esc(c.label)}</button>`);
      b.onclick = () => { clearChips(); if (c.run) c.run(); else send(c.text || c.label); };
      chipRow.append(b);
    }
    // Over the message box; in a project, over the dock (the next step stays nearest the input).
    (root.querySelector('.dock') || input.closest('.composer'))?.before(chipRow);
  };
  ext.attachComposer?.(input);
  const tools = new Map();
  const cards = new Map();
  let busy = false;
  // Following new messages: while the list is at its bottom it stays there, also when its height changes under it (the
  // working line, the quick replies, the composer's step line, the chat unfolding) or a message grows (a card answered,
  // a tool's output). Scrolled up, nothing moves: a "↓ New message" pill says something came and takes you down.
  let pinned = true, unseen = 0, unseenAsk = false;
  const nearBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 24;
  const toBottom = () => { msgs.scrollTop = msgs.scrollHeight; };
  const pillRow = h('<div class="new-pill-row"><button type="button" class="new-pill" hidden></button></div>');
  msgs.after(pillRow);
  const pill = $('.new-pill', pillRow);
  const paintPill = () => {
    pill.hidden = !unseen;
    pill.classList.toggle('ask', unseenAsk);
    pill.textContent = unseenAsk ? '↓ Claude is asking you' : unseen > 1 ? `↓ ${unseen} new messages` : '↓ New message';
  };
  const caughtUp = () => { if (unseen || unseenAsk) { unseen = 0; unseenAsk = false; paintPill(); } };
  msgs.addEventListener('scroll', () => { pinned = nearBottom(); if (pinned) caughtUp(); }, { passive: true });
  pill.onclick = () => { pinned = true; caughtUp(); toBottom(); };
  const follow = new ResizeObserver(() => { if (pinned) toBottom(); });
  follow.observe(msgs);
  // (A batch of changes, e.g. a replayed log, is one callback: one scroll, not one per message.)
  const grown = new MutationObserver(() => { if (pinned) toBottom(); });
  grown.observe(msgs, { childList: true, subtree: true, characterData: true });
  const COUNTS = new Set(['text', 'permission', 'question', 'error', 'note', 'marker', 'proposals']); // what the pill counts as a message
  const add = (node, ev) => {
    $('#emptyChat', root)?.remove();
    msgs.append(node);
    if (ev?.t === 'user' && !ev.replay) { pinned = true; caughtUp(); } // you just sent it (or ran a step): go to it
    if (!pinned && ev && !ev.replay && COUNTS.has(ev.t)) { unseen++; if (ev.t === 'permission' || ev.t === 'question') unseenAsk = true; paintPill(); }
    return node;
  };
  // Claude's reply sent at ts, in view (the dock's "Read" on a step that didn't finish): its top near the list's top.
  function reveal(ts) {
    const all = [...msgs.querySelectorAll('.msg-ai')];
    const n = (ts && all.find((x) => x.dataset.ts === String(ts))) || all.at(-1);
    if (!n) return false;
    msgs.scrollTop = Math.max(0, n.offsetTop - 12);
    pinned = nearBottom();
    if (pinned) caughtUp();
    n.classList.remove('flash'); void n.offsetWidth; n.classList.add('flash');
    return true;
  }

  // Sessions and context, in every chat (a project's and the Video Octopus assistant's): this session and earlier ones to
  // continue, a new session, how full the context is, and Compact (Claude keeps a summary and frees room).
  const sessUrl = `/api/projects/${encodeURIComponent(id)}/chat-sessions`;
  const sess = h(`<div class="chat-sess-wrap">
    <div class="chat-sess">
      <button type="button" class="btn ghost small sess-pick" aria-haspopup="menu" aria-expanded="false" title="This session, and earlier ones you can continue"><span class="sp-t">This session</span><span aria-hidden="true">▾</span></button>
      <button type="button" class="btn ghost small" data-a="new" title="Start a fresh session; this one stays in the list">+ New session</button>
      <span class="gap"></span>
      <span class="ctx" title="How full this chat's context is"><i><b></b></i><span class="ctx-n">–</span></span>
      <button type="button" class="btn ghost small" data-a="compact" title="Claude keeps a summary of the chat so far and frees room">Compact</button>
    </div>
    <div class="ctx-warn" hidden><b>This chat is getting long.</b> Compact keeps a summary and frees room; a new session starts fresh${id === '_studio' ? '' : ' with the project’s files and notes'}.</div>
  </div>`);
  $('.chat-head', root)?.after(sess);
  const kfmt = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n || 0));
  const showContext = (c) => {
    const f = c ? Math.min(1, (c.tokens || 0) / (c.window || 200000)) : 0;
    $('.ctx b', sess).style.width = `${Math.round(f * 100)}%`;
    $('.ctx', sess).classList.toggle('warn', f >= 0.8);
    $('.ctx-n', sess).textContent = c ? `${Math.round(f * 100)}% · ${kfmt(c.tokens)} of ${kfmt(c.window)}` : '–';
    $('.ctx-warn', sess).hidden = f < 0.8;
  };
  const setTitle = (t) => { $('.sp-t', sess).textContent = t || 'This session'; };
  const sessApi = (op, extra = {}) => api(sessUrl, { op, ...extra });
  sessApi('list').then((r) => { if (r.current?.messages) setTitle(r.current.title); if (r.current?.context) showContext(r.current.context); }).catch(() => {});
  $('[data-a=new]', sess).onclick = async () => { try { await sessApi('new'); } catch (e) { toast(e.message); } };
  $('[data-a=compact]', sess).onclick = async () => { try { await api(`/api/projects/${encodeURIComponent(id)}/chat-compact`, {}); } catch (e) { toast(e.message); } };
  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; $('.sess-pick', sess).setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (menu && !menu.contains(e.target) && !e.target.closest('.sess-pick')) closeMenu(); };
  $('.sess-pick', sess).onclick = async () => {
    if (menu) return closeMenu();
    let r;
    try { r = await sessApi('list'); } catch (e) { return toast(e.message); }
    const when = (ms) => (ms ? ago(ms) : '');
    menu = h(`<div class="sess-menu" role="menu">
      <div class="sm-row now"><span class="sm-t"><b>${esc(r.current.messages ? r.current.title : 'This session (empty)')}</b><span class="sub">now${r.current.messages ? ` · ${r.current.messages} message${r.current.messages > 1 ? 's' : ''}` : ''}</span></span></div>
      ${r.earlier.length ? `<div class="sm-h">Earlier sessions</div>${r.earlier.map((x) => `<div class="sm-row"><span class="sm-t"><b>${esc(x.title)}</b><span class="sub">${esc(when(x.last))} · ${x.messages} message${x.messages > 1 ? 's' : ''}${(x.engine || 'claude') !== (STATUS?.engine || 'claude') ? ` · ${esc(engineName(x.engine))}` : ''}${x.source && x.source !== 'plan' ? ` · ${esc(SOURCE_NAMES[x.source] || x.source)}` : ''}</span></span><button type="button" class="btn small" data-log="${esc(x.log)}"${r.busy ? ' disabled' : ''}>Continue</button></div>`).join('')}` : '<p class="sub sm-empty">No earlier sessions yet. + New session puts this one here.</p>'}
    </div>`);
    menu.querySelectorAll('[data-log]').forEach((b) => (b.onclick = async () => { closeMenu(); try { await sessApi('open', { log: b.dataset.log }); } catch (e) { toast(e.message); } }));
    sess.append(menu);
    $('.sess-pick', sess).setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
  };

  const setBusy = (b) => {
    busy = b;
    sess.querySelectorAll('[data-a]').forEach((x) => (x.disabled = b));
    if (!b) $('#workText', root).textContent = 'Working…';
    if (!b) stepName = null; // a step's run ends with its turn; the dock names the next one when it starts
    paintComposer();
  };

  // While a step runs (the dock says which: setStep, from web/rail.js) the composer says "Claude is working on <step> ·
  // Stop", typing stays allowed, and what you send waits and goes once the step finishes ("Sends when <step>
  // finishes"). Stop stops the turn as the send button's stop does, and puts what was waiting back in the box.
  // Other turns work as before: the send button is the stop.
  let stepName = null, held = [], stopping = false, basePh = null, stateSig = '';
  const comp = input.closest('.composer');
  const cmpState = h('<div class="cmp-state" hidden></div>');
  comp?.prepend(cmpState);
  const stepMode = () => busy && Boolean(stepName);
  const CLOCK = '<svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7 4.2V7l2 1.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  function paintComposer() {
    const sm = stepMode();
    $('#working', root).hidden = !busy || sm;
    sendBtn.classList.toggle('is-stop', busy && !sm);
    sendBtn.classList.toggle('primary', !busy || sm);
    sendBtn.setAttribute('aria-label', !busy ? 'Send' : sm ? `Send when ${stepName} finishes` : 'Stop Claude');
    if (basePh === null) basePh = input.placeholder;
    input.placeholder = sm ? 'Type now; it sends after this step' : basePh;
    const sig = JSON.stringify([sm && stepName, held.map((x) => x.raw)]);
    if (sig === stateSig) return;
    stateSig = sig;
    const on = sm || held.length > 0;
    comp?.classList.toggle('has-state', on);
    cmpState.hidden = !on;
    const focusC = cmpState.contains(document.activeElement) ? document.activeElement.dataset.c : null;
    const preview = held.map((x) => x.raw).join(' ').replace(/\s+/g, ' ').trim();
    const step = esc(stepName || 'this step');
    cmpState.innerHTML = !on ? '' : `${sm ? `<div class="cmp-st"><span class="spin" aria-hidden="true"></span><span class="cmp-t">Claude is working on <b>${step}</b></span><span class="cmp-dot" aria-hidden="true">·</span><button type="button" class="cmp-stop" data-c="stop" title="Stop Claude (what you typed stays)">Stop</button></div>` : ''}
      ${held.length ? `<div class="cmp-q" role="status"><span class="cmp-qi">${CLOCK}</span><span class="cmp-qt">${held.length > 1 ? `${held.length} messages send` : 'Sends'} when ${step} finishes: <q>${esc(preview.slice(0, 90))}${preview.length > 90 ? '…' : ''}</q></span><button type="button" class="cmp-x" data-c="unhold" title="Take it back into the box to change it">Edit</button></div>` : ''}`;
    if (focusC) cmpState.querySelector(`[data-c="${focusC}"]`)?.focus({ preventScroll: true });
  }
  cmpState.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-c]');
    if (b?.dataset.c === 'unhold') { unhold(); input.focus(); }
    if (b?.dataset.c === 'stop') {
      stopping = true;
      try { await api(`/api/projects/${encodeURIComponent(id)}/stop`, {}); } catch (err) { stopping = false; toast(err.message); }
    }
  });
  // What was waiting, back in the box (before anything typed since).
  function unhold() {
    if (!held.length) return;
    input.value = [...held.map((x) => x.raw), input.value.trim() ? input.value : ''].filter(Boolean).join('\n\n');
    held = [];
    autosize();
    input.dispatchEvent(new Event('input'));
    paintComposer();
  }
  // The step finished (or stopped): what waited goes now as one message, or back in the box after Stop.
  function flushHeld() {
    if (stopping) { stopping = false; unhold(); return; }
    if (!held.length) return;
    const text = held.map((x) => x.out).join('\n\n');
    held = [];
    paintComposer();
    send(text);
  }

  async function send(text) {
    if (!text.trim()) return;
    try { await api(`/api/projects/${encodeURIComponent(id)}/chat`, { text }); } catch (e) { toast(e.message); }
  }
  sendBtn.onclick = async () => {
    if (busy && !stepMode()) { await api(`/api/projects/${encodeURIComponent(id)}/stop`, {}); return; }
    const t = input.value;
    if (!t.trim()) return;
    input.value = ''; autosize();
    const out = ext.beforeSend ? await ext.beforeSend(t) : t;
    if (!out) return;
    if (stepMode()) { held.push({ raw: t, out }); paintComposer(); return; }
    send(out);
  };
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy || stepMode()) sendBtn.onclick(); } };
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; };
  input.oninput = autosize;

  // The proposals blocks: what each one's proposals are now (some kept or turned down since, on the lanes or here).
  const propBlocks = new Set();
  function paintProposal(n) {
    if (!n.isConnected) { propBlocks.delete(n); return; }
    const ev = n.__ev, all = { shots: ev.shots || [], zooms: ev.zooms || [] }, w = opts.proposals.waiting(ev);
    const left = w.shots.length + w.zooms.length, total = all.shots.length + all.zooms.length;
    n.classList.toggle('decided', !left);
    n.querySelector('.pb-t').innerHTML = `<b>Claude proposed ${esc(proposalWords(all))}</b>${!left ? ' · <span class="sub">all decided</span>' : left < total ? ` · <span class="sub">${left} still waiting</span>` : ' · <span class="sub">dashed on the timeline until you keep them</span>'}`;
    n.querySelectorAll('[data-p]').forEach((b) => { b.disabled = !left; b.hidden = !left && b.dataset.p !== 'show'; });
  }
  function answer(cardId, payload, card) {
    api(`/api/projects/${encodeURIComponent(id)}/answer`, { id: cardId, ...payload })
      .catch((e) => { toast(e.message); closeCard(card, 'No longer waiting'); });
  }
  function closeCard(card, label) {
    if (!card || card.classList.contains('closed')) return;
    card.classList.add('closed');
    card.querySelectorAll('.row').forEach((r) => r.remove());
    card.append(h(`<div class="sub" style="margin-top:6px">${esc(label)}</div>`));
  }

  // The local model server under this chat isn't answering (server/engines.mjs localDown): a banner over the message box,
  // with a switch to Claude Code that asks first. Nothing switches by itself.
  let banner = null;
  function localDown(ev) {
    banner?.remove();
    banner = h(`<div class="chat-banner" role="status"><span>${esc(ev.text)}</span><button type="button" class="btn small">Switch to Claude Code</button><button type="button" class="btn ghost small" aria-label="Dismiss">✕</button></div>`);
    const [sw, x] = banner.querySelectorAll('button');
    x.onclick = () => { banner.remove(); banner = null; };
    sw.onclick = async () => {
      if (!(await confirmBox({ title: 'Switch the chats to Claude Code?', text: `Video Octopus's chats run on Claude Code with your Claude account instead of ${ev.name}. You can switch back in Settings → Agent & model.`, ok: 'Switch' }))) return;
      try { await api('/api/app/scan/connect', { agent: 'claude', confirmed: true }); banner?.remove(); banner = null; toast('Chats run on Claude Code now.'); } catch (e) { toast(e.message); }
    };
    (root.querySelector('.dock') || input.closest('.composer'))?.before(banner);
  }
  function handle(ev) {
    switch (ev.t) {
      case 'local-down': localDown(ev); break;
      case 'busy': setBusy(ev.busy); if (!ev.busy) flushHeld(); break;
      case 'status': $('#workText', root).textContent = ev.text; break;
      case 'session': $('#sessionInfo', root).textContent = ev.model ? `· ${ev.model.replace(/^claude-/, '')}` : ''; break;
      case 'context': showContext(ev); break;
      case 'reset': {
        // A new session, or an earlier one continued: redraw from what the server sends next.
        tools.clear(); cards.clear(); closeMenu(); clearChips(); setTitle(''); showContext(null);
        pinned = true; caughtUp(); undoOffer = null;
        msgs.replaceChildren(h(`<div class="empty-chat" id="emptyChat">New session.<br><span class="sub">${id === '_studio' ? 'Same Claude, a fresh conversation.' : 'The project’s files, notes and WORKLOG are its memory.'}</span></div>`));
        break;
      }
      case 'user': {
        clearChips(); undoOffer = null; turnOver = false;
        // Video Octopus's own message (a step's brief, the change package…): one line, "▶ Clean up · started 14:32", with what
        // Video Octopus asked folded under it (an older log's are folded the same way by the server, server/claude.mjs forReplay).
        if (ev.brief?.name) {
          add(briefLine(ev.brief.name, ev.ts, ev.text), ev);
          if ($('.sp-t', sess).textContent === 'This session') setTitle(ev.brief.name);
          break;
        }
        add(h(`<div class="msg-user${ev.text.startsWith('/') ? ' cmd' : ''}">${ext.renderUser?.(ev.text) || esc(ev.text)}</div>`), ev);
        if ($('.sp-t', sess).textContent === 'This session' && !ev.text.startsWith('/')) setTitle(ev.text.replace(/\s+/g, ' ').slice(0, 60));
        break;
      }
      case 'text': { lastText = ev.text; const n = add(h(`<div class="msg-ai">${md(ev.text)}</div>`), ev); n.dataset.ts = ev.ts || ''; break; }
      case 'undo-offer': undoOffer = ev; if (turnOver && !busy) showChips(); break;
      case 'proposals': {
        // Claude's turn left proposed shots or zooms: "Claude proposed 3 shots and 6 zooms · Show me · Keep all · No
        // thanks to all". It follows what's still waiting (paintProposals, on every project refresh).
        if (!opts.proposals) break;
        const n = add(h(`<div class="prop-block" role="group" aria-label="Claude’s proposals"><span class="pb-t"></span><span class="pb-btns">
          <button type="button" class="btn small" data-p="show">Show me</button><button type="button" class="btn small primary" data-p="keep">Keep all</button><button type="button" class="btn small ghost" data-p="reject">No thanks to all</button></span></div>`), ev);
        n.__ev = ev;
        n.querySelectorAll('[data-p]').forEach((b) => (b.onclick = async () => {
          n.querySelectorAll('[data-p]').forEach((x) => (x.disabled = true));
          try { await opts.proposals[b.dataset.p](ev); } finally { paintProposal(n); }
        }));
        propBlocks.add(n);
        paintProposal(n);
        if (!ev.replay) opts.proposals.fresh?.();
        break;
      }
      case 'marker': {
        // A step that finished, in one line with Show me (the rail draws it): "✓ Split into sections · 1 section added".
        if (ev.done) { add(opts.doneMarker?.(ev) || h(`<div class="marker done"><span class="mk-t"><b>✓ ${esc(ev.text || '')}</b>${ev.line ? ` · ${esc(ev.line)}` : ''}</span></div>`), ev); break; }
        // Where a step's work started, in an older log whose brief didn't follow it ("Edit intro · started 14:32").
        add(briefLine(ev.text, ev.ts, ''), ev);
        break;
      }
      case 'tool': {
        const n = add(h(`<div class="tool"><b>${esc(ev.name)}</b> ${esc(ev.summary)}</div>`), ev);
        n.dataset.ts = ev.ts || '';
        tools.set(ev.id, n);
        n.onclick = (e) => { if (e.target.tagName !== 'PRE') n.querySelector('pre')?.toggleAttribute('hidden'); };
        break;
      }
      case 'tool_result': {
        const n = tools.get(ev.id);
        // How long the tool took, when it was a second or more.
        const took = n && ev.ts && n.dataset.ts ? (ev.ts - Number(n.dataset.ts)) / 1000 : 0;
        if (n && took >= 1 && !n.querySelector('.tool-t')) n.querySelector('b').after(h(`<span class="tool-t">${took < 60 ? `${took.toFixed(took < 10 ? 1 : 0)} s` : `${Math.round(took / 60)} min`}</span>`));
        if (n && ev.text) { n.append(h(`<pre hidden>${esc(ev.text)}</pre>`)); if (ev.error) n.classList.add('err'); }
        break;
      }
      case 'permission': {
        const card = add(h(`<div class="ask"><div class="q">${esc(window.STUDIO_AGENT || 'Claude')} wants to use ${esc(ev.tool)}</div>
          ${ev.reason ? `<div class="ask-why">${esc(ev.reason)}</div>` : ''}<div>${esc(ev.description || ev.summary)}</div>${ev.detail ? `<pre>${esc(ev.detail)}</pre>` : ''}
          <div class="row"><button class="btn primary small" data-a="1">Allow</button>${ev.always ? `<button class="btn small" data-a="always" title="Don't ask again for ${esc(ev.always)} until this session ends">Always for ${esc(ev.always)}</button>` : ''}<button class="btn small" data-a="0">Deny</button></div></div>`), ev);
        cards.set(ev.id, card);
        if (ev.expired) closeCard(card, 'Not answered');
        else card.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => answer(ev.id, { allow: b.dataset.a !== '0', always: b.dataset.a === 'always' }, card)));
        break;
      }
      case 'question': {
        const card = add(h(`<div class="ask"></div>`), ev);
        cards.set(ev.id, card);
        const answers = {};
        const submit = () => answer(ev.id, { answers }, card);
        ev.questions.forEach((q, qi) => {
          card.append(h(`<div class="q"${qi ? ' style="margin-top:10px"' : ''}>${esc(q.question)}</div>`));
          const row = h(`<div class="row"></div>`);
          q.options.forEach((o) => {
            const b = h(`<button class="btn small opt">${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ''}</button>`);
            b.onclick = () => {
              if (q.multiSelect) { b.classList.toggle('primary'); answers[q.question] = [...row.querySelectorAll('.primary')].map((x) => x.firstChild.textContent).join(', '); return; }
              answers[q.question] = o.label;
              row.querySelectorAll('button').forEach((x) => x.classList.toggle('primary', x === b));
              if (Object.keys(answers).length === ev.questions.length) submit();
            };
            row.append(b);
          });
          card.append(row);
        });
        if (ev.questions.some((q) => q.multiSelect)) { const r = h(`<div class="row"><button class="btn primary small">Send answers</button></div>`); r.firstChild.onclick = submit; card.append(r); }
        if (ev.expired) closeCard(card, 'Not answered');
        break;
      }
      case 'permission_done': closeCard(cards.get(ev.id), ev.outcome === 'always' ? `Allowed · and ${ev.always || 'this'} from now on, this session` : { allowed: 'Allowed', denied: 'Denied', answered: 'Answered', withdrawn: 'No longer needed' }[ev.outcome] || ev.outcome); break;
      case 'result': add(h(`<div class="divider">${ev.ok ? 'done' : 'stopped'}${ev.seconds ? ` · ${ev.seconds} s` : ''}</div>`), ev); turnOver = true; if (!ev.replay && ev.ok) showChips(); break;
      case 'error': add(h(`<div class="error">${esc(ev.text)}</div>`), ev); break;
      case 'note': add(h(`<div class="note">${esc(ev.text)}</div>`), ev); break;
    }
    // Whatever this event changed around the list (the working line, the quick replies, the composer's step line)
    // has changed its height by now: stay at the bottom in the same moment, not a frame later.
    if (pinned && !ev.replay) toBottom();
  }

  return { handle, sendSkill: (name) => send(`/${name} for this project`), note: (text) => handle({ t: 'note', text }), reveal,
    paintProposals: () => { for (const n of [...propBlocks]) paintProposal(n); },
    setStep: (name) => { if (name === stepName) return; stepName = name; paintComposer(); },
    destroy: () => { follow.disconnect(); grown.disconnect(); } };
}

// A message Video Octopus wrote for Claude, as one line: "▶ Clean up · started 14:32", and "What Video Octopus asked Claude" to
// unfold the whole brief (none for an older log's start marker that no brief followed).
function briefLine(name, ts, text) {
  const at = new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const n = h(`<div class="msg-step"><div class="ms-top"><span class="ms-ic" aria-hidden="true">▶</span><b>${esc(name || 'A step')}</b><span class="ms-at"> · started ${esc(at)}</span></div></div>`);
  if (text) n.append(h(`<details class="ms-brief"><summary>What Video Octopus asked Claude</summary><div class="ms-text">${esc(text)}</div></details>`));
  return n;
}

// Small, safe markdown: paragraphs, lists, headings, code, bold, italics, links.
function md(src) {
  const blocks = [];
  src = src.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => { blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Each line is a bullet, a numbered item, a heading or text; runs of the same kind become one block.
  const kind = (l) => (/^\s*[-*] /.test(l) ? 'ul' : /^\s*\d+[.)] /.test(l) ? 'ol' : /^#{1,4} /.test(l) ? 'h' : /^\u0000\d+\u0000$/.test(l.trim()) ? 'code' : 'p');
  const strip = (l) => l.replace(/^\s*([-*]|\d+[.)]) /, '');
  const out = [];
  for (const para of src.split(/\n{2,}/)) {
    let run = null;
    const flush = () => {
      if (!run) return;
      if (run.k === 'ul' || run.k === 'ol') out.push(`<${run.k}>${run.lines.map((l) => `<li>${inline(strip(l))}</li>`).join('')}</${run.k}>`);
      else if (run.k === 'p') out.push(`<p>${run.lines.map(inline).join('<br>')}</p>`);
      run = null;
    };
    for (const line of para.split('\n')) {
      const k = kind(line);
      if (k === 'h') { flush(); out.push(`<h4>${inline(line.replace(/^#+ /, ''))}</h4>`); continue; }
      if (k === 'code') { flush(); out.push(line.trim()); continue; }
      if (run && run.k === k) run.lines.push(line); else { flush(); run = { k, lines: [line] }; }
    }
    flush();
  }
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

// ---------- canvas: screen + webcam in a layout, drawn the way the export renders it ----------
// Geometry comes from layout.js, which the server's export uses too. The still parts (Night Desk
// background, card shadows and borders, rounded masks) are drawn once per layout into offscreen
// canvases, and the export sends those same bitmaps to ffmpeg as PNGs.
const LAYOUT_TILES = [
  { key: 'screen', label: 'Screen', change: { preset: 'screen' }, needs: ['screen'] },
  { key: 'camera', label: 'Camera', change: { preset: 'camera' }, needs: ['cam'] },
  { key: 'pip', label: 'PiP', change: null, needs: ['screen', 'cam'] }, // keeps (or picks) a corner
  { key: 'split', label: 'Split', change: { preset: 'split' }, needs: ['screen', 'cam'] },
  { key: 'boxed', label: 'Boxed', change: { preset: 'boxed' }, needs: ['screen', 'cam'] },
];
const CORNERS = [['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right']];
const cornerIcon = (k) => `<svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true"><rect x=".5" y=".5" width="15" height="11" rx="2" class="cf"/><rect x="${k[1] === 'l' ? 2 : 9}" y="${k[0] === 't' ? 2 : 6}" width="5" height="4" rx="1" class="cb"/></svg>`;

const mkCanvas = (w, hh) => { const c = document.createElement('canvas'); c.width = w; c.height = hh; return c; };
const PIN_ICON = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 11s4-3.6 4-6.5A4 4 0 0 0 2 4.5C2 7.4 6 11 6 11z"/></svg>';
// The transport's small buttons: previous / next scene, volume.
const TP_ICON = {
  prev: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect class="f" x="2.2" y="2" width="1.8" height="10" rx=".6"/><path class="f" d="M12 2.2v9.6L5.2 7z"/></svg>',
  next: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect class="f" x="10" y="2" width="1.8" height="10" rx=".6"/><path class="f" d="M2 2.2v9.6L8.8 7z"/></svg>',
  vol: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path class="f" d="M2 6h3l4-3v10l-4-3H2z"/><path class="w" d="M11.3 5.4a3.6 3.6 0 0 1 0 5.2"/></svg>',
  muted: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path class="f" d="M2 6h3l4-3v10l-4-3H2z"/><path class="w" d="M11 6.2l3.4 3.6M14.4 6.2L11 9.8"/></svg>',
  eye: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path class="w" d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle class="f" cx="8" cy="8" r="2"/></svg>',
  eyeOff: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path class="w" d="M2 2l12 12M6.3 4c.5-.3 1.1-.5 1.7-.5 4.1 0 6.5 4.5 6.5 4.5s-.6 1.2-1.8 2.4M10 12c-.6.3-1.3.5-2 .5-4.1 0-6.5-4.5-6.5-4.5s.7-1.3 2-2.6"/></svg>',
};

// Card shadow (CSS: 0 1.6u 3.6u -1u) and the card colour under a video.
function drawUnder(g, ly, u) {
  if (!ly.shadow) return false;
  const { x, y, w, h: hh } = ly.box;
  g.save();
  g.shadowColor = NIGHT.shadow; g.shadowBlur = 3.6 * u; g.shadowOffsetY = 1.6 * u;
  g.fillStyle = NIGHT.card; g.beginPath(); g.roundRect(x + u, y + u, w - 2 * u, hh - 2 * u, Math.max(0, ly.radius - u)); g.fill();
  g.restore();
  g.fillStyle = NIGHT.card; g.beginPath(); g.roundRect(x, y, w, hh, ly.radius); g.fill();
  return true;
}
// The card's border (subtle line, white or accent), on top of the video.
function drawOver(g, ly) {
  if (!ly.border) return false;
  const b = ly.border, { x, y, w, h: hh } = ly.box;
  g.strokeStyle = ly.borderColor || NIGHT.line; g.lineWidth = b;
  g.beginPath(); g.roundRect(x + b / 2, y + b / 2, w - b, hh - b, Math.max(0, ly.radius - b / 2)); g.stroke();
  return true;
}

// bg = the background painter (web/look.js): a still one is painted into the base; an animated one is drawn
// every frame under it, so the base only holds the first card's shadow.
function buildStills(scene, bg) {
  const { W, H, u, layers } = scene;
  const base = mkCanvas(W, H), g = base.getContext('2d');
  if (!bg?.animated) (bg?.paint || paintNight)(g, W, H, 0);
  if (layers[0]) drawUnder(g, layers[0], u);
  // mid i = layer i's border + layer i+1's shadow, both between video i and video i+1.
  const mids = layers.map((ly, i) => {
    const c = mkCanvas(W, H), cg = c.getContext('2d');
    let drew = drawOver(cg, ly);
    if (layers[i + 1]) drew = drawUnder(cg, layers[i + 1], u) || drew;
    return drew ? c : null;
  });
  const masks = layers.map((ly) => {
    const c = mkCanvas(ly.box.w, ly.box.h), cg = c.getContext('2d');
    cg.fillStyle = '#fff'; cg.beginPath(); cg.roundRect(0, 0, ly.box.w, ly.box.h, ly.radius); cg.fill();
    return c;
  });
  return { base, mids, masks, tmp: layers.map((ly) => mkCanvas(ly.box.w, ly.box.h)) };
}

// For the layers export (web/exportkinds.js): the background alone (none when it's animated: the export draws it), and
// each card's shadow (under) and border (over) as their own transparent PNGs, so every card's file carries its own edge.
function splitStills(scene, bg) {
  const { W, H, u, layers } = scene;
  const png = (draw) => { const c = mkCanvas(W, H); return draw(c.getContext('2d')) === false ? null : c.toDataURL('image/png'); };
  const out = animatedBg(scene.bg) ? { bgAnimated: true } : { bgOnly: png((g) => { (bg?.paint || paintNight)(g, W, H, 0); }) };
  layers.forEach((ly, i) => {
    const under = png((g) => drawUnder(g, ly, u)), over = png((g) => drawOver(g, ly));
    if (under) out[`under${i}`] = under;
    if (over) out[`over${i}`] = over;
  });
  return out;
}

// A small picture of a layout for its button.
function layoutThumb(scene) {
  const rects = scene.layers.map((ly) => `<rect x="${ly.box.x}" y="${ly.box.y}" width="${ly.box.w}" height="${ly.box.h}" rx="${ly.radius * 1.5}" class="${ly.role}"/>`).join('');
  return `<svg viewBox="0 0 ${scene.W} ${scene.H}" aria-hidden="true"><rect width="${scene.W}" height="${scene.H}" class="bg"/>${rects}</svg>`;
}

function makeCanvas(pane, { inspector, tools }, id, getP, hooks = {}) {
  let videos = new Map(), master = null, mediaSig = '', raf = 0, paused = false;
  // The production sheet's scenes and the review notes, drawn on the timeline (mapped through the locked cut).
  let sceneData = null, pickedScene = null, noteMode = false, pop = null;
  const cmap = () => cutMap(getP().export.cut?.segments);
  let layout = null, scene = null, stills = null, drag = null, hover = null, wrap = null, stage = null, ins = null, tl = null;
  let selected = 'cam', reframe = false, markColor = '', markLook = '', lastCorner = 'br';
  // Crop mode: the selected picture shown whole (cropView, fixed while it lasts) with handles on what the crop keeps.
  let cropping = false, cropView = null;
  let bgP = null, bgKey = '', bgSec = null; // the background painter and the inspector's Background section (web/look.js)
  let aoWave = null, aoPeaks = null; // a mic-only take: the note's waveform canvas and the take's peaks
  // The transport's volume and the picture size (Fit, 50 %, 100 % of the export's pixels), kept on this computer.
  let volume = 1, muteAll = false, picZoom = 'fit', stageRO = null, chipKey = '';
  let stageFx = null; // Control room's title-safe guide and level meters (web/stagefx.js)
  try { const v = JSON.parse(localStorage.getItem('studio.canvas.volume') || 'null'); if (v) { volume = Math.min(1, Math.max(0, Number(v.volume ?? 1))); muteAll = Boolean(v.muted); } } catch {}
  try { const z = localStorage.getItem('studio.canvas.zoom'); if (z === '0.5' || z === '1') picZoom = Number(z); } catch {}
  let saved = []; // layouts saved with "+ Save layout" (the studio's .studio/layouts.json), shown as tiles in every project
  const media = (f) => `/api/projects/${encodeURIComponent(id)}/media?f=${encodeURIComponent(f)}`;
  const dims = () => getP().export.dims || {};

  // ---- shots ----
  // base: the video's own look (project.json "layout"). layout: what the canvas and the inspector edit: the base itself
  // in "Whole video" (one shot, or the switch), the shot under the playhead in "This shot" (its effective look). A
  // change in a shot goes into `pend` (that shot's partial look) and is saved with the routes' look / clear ops; the
  // frame shape, the background and the list of layers stay the base's. The picture draws the look of the moment
  // (frameLooks), so it switches at a break while playing or scrubbing, and crossfades where a shot comes in with one.
  const shots = hooks.shots || null, zoomsC = hooks.zooms || null;
  // Proposals (N1): the picture plays the kept shots and zooms only, like the export. peekShot: a proposed shot the
  // creator is looking at (picked on the lane, Show me, Preview on the picture's tag); a selected proposed zoom shows too.
  let peekShot = null, viewMemo = { key: '', list: [] }, zviewMemo = { key: '', list: [] }, propKey = '';
  const vLook = new Map();
  // Z: drawing a zoom's box on the picture ({ edit: zoom id or null, target }); zdrag: the box being dragged.
  let zoomDraw = null, zdrag = null, pendingShow = null;
  const shownCrops = new Map(); // the crop each card shows right now (zooms in), for a box drawn on it
  let base = null, scopePref = null, lastScope = null, editId = null, pend = null, editBase = null, dirty = false, baseDirty = false, saving = Promise.resolve();
  let vscene = null, layoutKey = '', lookVer = 0, lastPointer = null, shotUIKey = '', fadeCv = null, trMemo = { key: '', list: [] };
  const ssCache = new Map(), keyOf = new WeakMap();
  const shotList = () => shots?.list() || [{ id: 's1', start: 0 }];
  // Whole video until the creator picks a shot or splits one themselves: shots that only come from section edges
  // (Split into sections) don't switch the inspector to "This shot".
  const scopeNow = () => (shots && shotList().length >= 2 ? scopePref || 'all' : 'all');
  // The shots and zooms the picture plays: the kept ones (web/shots.js shotsWithoutProposals: what the export renders)
  // and the proposal being looked at.
  function viewShots() {
    const k = `${shots?.version() ?? 0}|${peekShot || ''}|${shotList().length}`;
    if (viewMemo.key !== k) viewMemo = { key: k, list: shots ? shotsWithoutProposals({ shots: shotList() }, peekShot ? [peekShot] : null).shots : shotList() };
    return viewMemo.list;
  }
  const zoomDoc = () => zoomsC?.doc() || getP().zooms || { items: [] };
  function viewZooms() {
    const d = zoomDoc(), peek = zoomsC?.selected() || null, k = `${zoomsC?.version() ?? 0}|${peek || ''}`;
    if (zviewMemo.key !== k || zviewMemo.doc !== d) zviewMemo = { key: k, doc: d, list: zoomsWithoutProposals(d, peek ? [peek] : null).items };
    return zviewMemo.list;
  }
  // The shot being edited shows as the canvas edits it, unless it's a proposal the picture leaves out.
  const editShown = () => { if (scopeNow() !== 'shot' || !editId) return false; const v = viewShots().find((x) => x.id === editId); return Boolean(v) && v === shotList().find((x) => x.id === editId); };
  function lookFor(s) {
    if (!s?.look) return base;
    const k = `${lookVer}|${JSON.stringify(s.look)}`;
    let m = vLook.get(k);
    if (!m) { if (vLook.size > 40) vLook.clear(); m = effectiveLook(base, s.look); vLook.set(k, m); }
    return m;
  }
  const editIndex = () => shotAt(master?.currentTime || 0, shotList())?.index || 0;
  const cutSegs = () => getP().export.cut?.segments || null;

  function update() {
    const P = getP();
    const fresh = normalize(P.layout, P.type);
    const key = JSON.stringify([P.canvas, P.proxies, P.export.dims, fresh.layers.map((x) => x.file)]);
    if (key !== mediaSig) { mediaSig = key; build(P); return; }
    // The video's look changed outside the canvas (another tab, auto-frame, Claude, Apply to all shots).
    if (base && !drag && !baseDirty && JSON.stringify(fresh) !== JSON.stringify(base)) {
      base = fresh; lookVer++;
      if (scopeNow() === 'all') applyLayout(base); else if (!dirty) deriveEdit(true);
    }
    if (wrap) { refreshCutToggle(); loadTimeline(); bgSec?.refresh()?.then(() => ensureBg()); renderShotUI(); }
  }

  // The canvas fills the inspector and the frame-shape switch in the tab bar; with no take they say why.
  function emptyInspector(text) {
    tools.replaceChildren();
    inspector.replaceChildren(h(`<div class="ins-body"><div class="ins-head"><b>Canvas</b></div><section><p class="sub">${esc(text)}</p></section></div>`));
  }

  function build(P) {
    teardownMedia();
    const c = P.canvas;
    if (!c.screen && !c.cam && !c.audio) { showImport(); return; }
    const audioOnly = Boolean(c.audio && !c.screen && !c.cam);
    const src = (f) => (f && P.proxies[f] ? media(P.proxies[f]) : null);
    if ((c.screen && !src(c.screen)) || (c.cam && !src(c.cam))) {
      const files = [c.screen, c.cam].filter(Boolean);
      pane.replaceChildren(h(`<div class="blank"><h3>Getting your recording ready</h3><div>Making playback copies of ${esc(files.join(', '))}. This takes a moment for long takes.</div>
        <div style="margin-top:12px"><button class="btn small" id="mk">Make them now</button></div></div>`));
      $('#mk', pane).onclick = () => api(`/api/projects/${encodeURIComponent(id)}/proxies`, {});
      emptyInspector('The layout controls show up when the playback copies are ready.');
      return;
    }
    wrap = h(`<div class="pane canvas-pane">
      <div class="canvas-wrap"><canvas id="stage"></canvas>${audioOnly ? audioOnlyNoteHTML() : ''}
        <div class="edit-chip" id="editChip" hidden>${SHOT_ICON.pencil}<b id="editChipT"></b><span>changes apply to this shot</span></div>
        <div class="prop-tag" id="propTag" role="group" aria-label="Claude’s proposal here" hidden><span class="pt-t"></span><button type="button" class="pt-b" data-p="preview">Preview</button><button type="button" class="pt-b keep" data-p="keep">Keep it</button><button type="button" class="pt-b" data-p="reject">No thanks</button></div></div>
      <div class="transport">
        <button class="tp-skip" id="prevScene" aria-label="Back to the previous scene">${TP_ICON.prev}</button>
        <button class="play" id="play" aria-label="Play"><i></i></button>
        <button class="tp-skip" id="nextScene" aria-label="Next scene">${TP_ICON.next}</button>
        <span class="time" id="time">0:00.0</span>
        <button class="tp-chip" id="sceneChip" hidden></button>
        <span class="gap"></span>
        <button class="btn small" id="noteMode" hidden title="Click a spot in the picture to leave a note there, at this moment">${PIN_ICON}Note</button>
        <label class="toggle" id="cutWrap" hidden title="Skip the parts the locked cut removes, like the export does"><input type="checkbox" role="switch" id="cutPlay"><span class="sw" aria-hidden="true"></span>Play the locked cut</label>
        <div class="tp-vol"><button class="tp-skip" id="volBtn" aria-label="Mute">${TP_ICON.vol}</button><input type="range" id="vol" min="0" max="1" step="0.05" aria-label="Volume"></div>
      </div>
      <div class="blocks-strip" id="blockStrip"></div>
      <div class="timeline" id="timeline"></div></div>`);
    pane.replaceChildren(wrap);
    tools.replaceChildren(h(`<div class="tools-row"><div class="seg" id="aspect" role="group" aria-label="Frame shape"><button data-a="16:9">16:9</button><button data-a="9:16">9:16</button></div>
      ${zoomsC ? '<button type="button" class="btn small" id="zoomTool" aria-pressed="false" title="Zoom into an area (Z): drag a box on the screen or the camera; the zoom starts at the playhead">Zoom into an area <kbd>Z</kbd></button>' : ''}
      <details class="pic-zoom"><summary class="btn small" id="picZoom" title="How big the picture shows: fit the space, or 50% / 100% of the export's pixels">Fit</summary>
        <div class="menu" role="menu">${[['fit', 'Fit'], ['0.5', '50%'], ['1', '100%']].map(([k, l]) => `<button class="mi" role="menuitemradio" data-z="${k}">${l}</button>`).join('')}</div></details></div>`));
    ins = h(`<div class="ins-body">
      <section class="zoom-sec" id="zoomSec" hidden><div class="sh-t"><b id="zmTitle">Zoom</b><small id="zmSub"></small></div>
        <div class="zm-prop" id="zmProp" hidden><span>Proposed by Claude</span><button type="button" class="btn small primary" id="zmKeep">Keep it</button><button type="button" class="btn small" id="zmNo">No thanks</button></div>
        <div class="row"><span>Target</span><div class="seg" id="zmTarget" role="group" aria-label="What it zooms into"><button type="button" data-v="screen">Screen</button><button type="button" data-v="camera">Camera</button></div></div>
        <div class="row zm-area"><span>Area</span><small id="zmAreaT"></small><button type="button" class="btn small" id="zmArea" title="Drag the area again on the picture">Edit on the picture</button></div>
        <label class="slider" id="zmAmountRow" hidden><span>Closer</span><input type="range" id="zmAmount" min="1.02" max="2" step="0.01" aria-label="How much closer"><span class="val" id="zmAmountVal"></span></label>
        <div class="zm-times"><label><span>Starts</span><input class="field num" type="number" id="zmA" min="0" step="0.1" aria-label="Starts at (seconds of the video)"></label>
          <label><span>Ends</span><input class="field num" type="number" id="zmD" min="0" step="0.1" aria-label="Ends at (seconds of the video)"></label>
          <label><span>Ease in</span><input class="field num" type="number" id="zmIn" min="0.1" max="2" step="0.05" aria-label="Ease in, seconds"></label>
          <label><span>Ease out</span><input class="field num" type="number" id="zmOut" min="0.1" max="2" step="0.05" aria-label="Ease out, seconds"></label></div>
        <div class="row"><span>Speed</span><div class="seg" id="zmSpeed" role="group" aria-label="How it moves">${Object.entries(ZOOM_SPEEDS).map(([k, v]) => `<button type="button" data-v="${k}" title="${{ smooth: 'Ease in and out', even: 'The same speed all the way', snap: 'A fast cut-in, about 0.1 s' }[k]}">${v}</button>`).join('')}</div></div>
        <button type="button" class="btn small danger" id="zmDel">Delete zoom</button></section>
      <section class="shot-sec" id="shotSec" hidden><div class="sh-t"><b id="shTitle">Whole video</b><small id="shSub"></small></div>
        <div class="seg wide sh-scope" id="shScope" role="radiogroup" aria-label="Where your changes go"><button type="button" role="radio" data-s="shot">This shot</button><button type="button" role="radio" data-s="all">Whole video</button></div>
        <p class="sub sh-hint" id="shHint" hidden></p></section>
      <div class="ins-head"><span class="sel-dot" id="selDot"></span><b id="fbName">Camera</b><span class="sub" id="selHint"></span></div>
      <section><h3>Layout<span class="ov" data-ov="layout"></span></h3><div class="tiles" id="presets"></div>
        <form class="ly-save" id="lySave" hidden><div class="ly-save-row"><input class="field" maxlength="40" placeholder="Name it, e.g. Boxed on stars" aria-label="Name of the layout"><button class="btn dark small" type="submit">Save</button><button class="btn ghost small" type="button" data-a="x">Cancel</button></div>
          <p class="sub">Keeps the layout, camera framing, background, border and shadow. It shows as a tile in every project.</p></form>
        <p class="sub" id="audioNote" hidden>This take is audio only: there's no picture to lay out. The export shows the background below with its sound; pick one there.</p>
        <div class="row" id="cornerRow"><span>Corner</span><div class="seg" id="corner" role="group" aria-label="Corner">${CORNERS.map(([k, n]) => `<button data-c="${k}" aria-label="${n}" title="${n}">${cornerIcon(k)}</button>`).join('')}</div></div>
        <label class="slider" id="padRow" title="Inset the screen as a card, with the background around it"><span>Inset</span><input type="range" id="pad" min="0" max="10" step="0.5"><span class="val" id="padVal">0%</span></label></section>
      <section id="frameSec"><h3 id="frameH">Crop &amp; zoom<span class="ov" data-ov="frame"></span></h3>
        <div class="seg wide" id="shape" role="group" aria-label="Shape of the box"><button data-s="square">Square</button><button data-s="rounded">Rounded</button><button data-s="circle">Circle</button><button data-s="frame">Whole</button></div>
        <label class="slider" id="zoomRow" title="How close the picture is (also: scroll over it)"><span>Zoom</span><input type="range" id="zoom" min="1" max="4" step="0.01"><span class="val" id="zoomVal">1.0×</span></label>
        <div class="frame-btns" id="frameBtns"><button class="btn" id="crop" aria-pressed="false" title="Trim the edges of the picture: drag them on the canvas (Enter or Esc when done)">Crop</button>
          <button class="btn" id="reframe" aria-pressed="false" title="Drag inside the box to move the picture, scroll to zoom (or double-click the box)">Reframe</button>
          <button class="btn" id="autoframe" title="Find your face and frame head and shoulders">Auto-frame</button></div>
        <p class="sub frame-tip" id="cropTip" hidden>Drag an edge or a corner on the picture; drag inside to move the crop. The faint part is cut off. <b>Enter</b>, <b>Esc</b> or <b>Done</b> to finish.</p>
        <p class="sub frame-tip" id="reframeTip" hidden>Drag to centre yourself on the cross (arrow keys nudge, scroll zooms). The faint picture is the whole camera.</p>
        <div class="crop-edges" id="cropEdges" role="group" aria-labelledby="cropEdgesL">
          <span class="ce-h" id="cropEdgesL">Crop <small id="cropUnit">px of the recording</small></span>
          ${[['t', 'Top'], ['r', 'Right'], ['b', 'Bottom'], ['l', 'Left']].map(([k, n]) => `<label class="ce" title="${n}: how much is cut off this edge"><span>${n}</span><input class="field num" type="number" min="0" step="1" inputmode="numeric" data-e="${k}" aria-label="Crop ${n.toLowerCase()}, in pixels of the recording"></label>`).join('')}
          <button class="btn ghost small" id="cropReset" title="No crop: the whole picture again">Reset</button></div>
        <label class="slider" id="insetRow" title="Inset the screen as a card, with the background around it (also: drag a corner of the screen)"><span>Inset</span><input type="range" id="pad2" min="0" max="10" step="0.5" aria-label="Screen inset"><span class="val" id="pad2Val">0%</span></label>
        <div class="two" id="layerBtns"><button class="btn" id="layerAudio" title="Mix this layer's sound into the export">Sound: off</button>
          <button class="btn danger" id="layerRemove" title="Take this layer off the canvas (the file stays in source/)">Remove layer</button></div></section>
      <section id="edgeSec"><h3>Border<span class="ov" data-ov="edge"></span></h3>${edgeHTML()}</section>
      <section id="placeSec"><h3>Placement<span class="ov" data-ov="place"></span></h3>
        <div class="row" id="sideRow"><span>Side</span><div class="seg" id="side" role="group" aria-label="Which side the camera takes"><button data-v="left">Left</button><button data-v="right">Right</button></div></div>
        <div class="row" id="mirrorRow"><span>Mirror</span><div class="seg" id="mirror" role="group" aria-label="Mirror the camera"><button data-v="auto">Auto</button><button data-v="on">On</button><button data-v="off">Off</button></div></div>
        <p class="sub" id="mirrorNote">Auto mirrors you when you sit on the left, so you look into the screen.</p></section>
      <section id="bgSec"></section>
      <section><h3>Layers</h3><div class="layers" id="layerList"></div>
        <div class="add-take"><button class="btn ghost wide" id="addLayer" aria-haspopup="menu" title="Put another take on top of this one, in its own box">+ Add a take as a layer</button></div></section>
      <p class="sub hint">Click the camera or the screen to edit it. Drag the camera to move it, a corner handle to resize; scroll over a picture to zoom, Crop trims its edges. Space plays.</p>
      <div class="shot-foot" id="shotFoot" hidden>
        <div class="sf-in" id="sfIn"><span class="sf-l">Into this shot</span><b id="sfTr">Cut</b><button type="button" class="btn small" id="sfTrBtn" aria-haspopup="dialog">Change</button></div>
        <div class="sf-btns"><button type="button" class="btn small" id="sfPrev">Same as previous</button><button type="button" class="btn small" id="sfAll">Apply to all shots</button><button type="button" class="btn small sf-back" id="sfBack">Back to the video’s look</button></div></div></div>`);
    inspector.replaceChildren(ins);
    stage = $('#stage', wrap);
    wireZoomSec();
    const zt = tools.querySelector('#zoomTool');
    if (zt) zt.onclick = () => (zoomDraw ? endZoomDraw() : startZoomDraw());
    $('#propTag', wrap).addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (b) propAct(b.dataset.p); });
    base = normalize(P.layout, P.type); layout = base; editId = null; pend = null; dirty = false; baseDirty = false; lastScope = null;
    ssCache.clear(); vLook.clear();
    // One hidden <video> per file: the canvas take's screen and camera, plus each extra layer (a mic-only take: <audio>).
    const files = [c.cam, c.screen, c.audio, ...layout.layers.map((x) => x.file)].filter((f, i, a) => f && a.indexOf(f) === i && P.proxies[f]);
    for (const f of files) {
      const v = h(isSound(f) ? `<audio class="hidden-media" preload="auto" muted></audio>` : `<video class="hidden-media" preload="auto" playsinline muted></video>`);
      v.src = media(P.proxies[f]); document.body.append(v); videos.set(f, v);
    }
    master = videos.get(c.cam) || videos.get(c.screen) || videos.get(c.audio);
    stageFx = stageExtras($('.canvas-wrap', wrap), stage, () => [...videos.values()]);
    aoWave = audioOnly ? $('.ao-wave', wrap) : null;
    const play = $('#play', wrap), time = $('#time', wrap);
    play.onclick = () => toggle();
    const playing = (on) => { play.classList.toggle('on', on); play.setAttribute('aria-label', on ? 'Pause' : 'Play'); };
    master.addEventListener('play', () => playing(true));
    master.addEventListener('pause', () => playing(false));
    // Previous / next scene, the scene chip (opens it in Scenes), volume.
    $('#prevScene', wrap).onclick = () => jumpScene(-1);
    $('#nextScene', wrap).onclick = () => jumpScene(1);
    $('#sceneChip', wrap).onclick = () => { const sc = sceneNow(); if (sc) hooks.openScene?.(sc.id); };
    const vol = $('#vol', wrap);
    vol.oninput = () => { volume = Number(vol.value); muteAll = volume === 0; saveVol(); };
    $('#volBtn', wrap).onclick = () => { muteAll = !muteAll; if (!muteAll && volume === 0) volume = 0.8; saveVol(); };
    renderVol();
    // Picture size: Fit, or 50 % / 100 % of the export's pixels (the picture scrolls when it's bigger than the space).
    tools.querySelectorAll('.pic-zoom [data-z]').forEach((b) => (b.onclick = () => {
      picZoom = b.dataset.z === 'fit' ? 'fit' : Number(b.dataset.z);
      try { localStorage.setItem('studio.canvas.zoom', String(picZoom)); } catch {}
      b.closest('details').open = false;
      applyZoom();
    }));
    stageRO = new ResizeObserver(() => zoomLabel());
    stageRO.observe(stage);
    api('/api/layouts').then((r) => { saved = r.layouts || []; if (ins) renderBar(); }).catch(() => {});
    tools.querySelectorAll('#aspect button').forEach((b) => (b.onclick = () => setAspect(b.dataset.a)));
    // Shots: the scope switch, the footer (Into this shot, Same as previous, Apply to all shots, Back to the video's look).
    ins.querySelectorAll('#shScope button').forEach((b) => (b.onclick = () => setScope(b.dataset.s)));
    $('#sfTrBtn', ins).onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); if (editId) shots?.openPop(editId, { x: r.left + 20, y: r.bottom }, { focus: e.detail === 0 }); };
    $('#sfPrev', ins).onclick = () => editId && shots?.samePrev(editId);
    $('#sfAll', ins).onclick = () => editId && shots?.applyAllLook(editId);
    $('#sfBack', ins).onclick = () => editId && shots?.backToVideo(editId);
    ins.addEventListener('click', (e) => {
      const r = e.target.closest('.ov-r');
      if (r) { resetKeys(r.dataset.keys.split(',')); return; }
      const a = e.target.closest('.ov-a');
      if (a) shots?.clearKeys(a.dataset.ids.split(','), a.dataset.keys.split(','));
    });
    ins.querySelectorAll('#corner button').forEach((b) => (b.onclick = () => { lastCorner = b.dataset.c; setLayout(withPreset(layout, { corner: b.dataset.c }, dims())); }));
    ins.querySelectorAll('#side button').forEach((b) => (b.onclick = () => setLayout(withPreset(layout, { side: b.dataset.v }, dims()))));
    ins.querySelectorAll('#mirror button').forEach((b) => (b.onclick = () => { layout.mirror = { auto: 'auto', on: true, off: false }[b.dataset.v]; setLayout(layout); }));
    ins.querySelectorAll('#shape button').forEach((b) => (b.onclick = () => { const f = frameOf(selected); if (f) { f.shape = b.dataset.s; setLayout(layout); } }));
    const zoom = $('#zoom', ins);
    zoom.oninput = () => { const f = frameOf(selected); if (f) { f.zoom = Number(zoom.value); setLayout(layout, false); } };
    zoom.onchange = () => saveLayout();
    $('#reframe', ins).onclick = () => { if (cropping) endCrop(); reframe = !reframe; renderFrameBar(); };
    $('#crop', ins).onclick = () => (cropping ? endCrop() : startCrop());
    $('#autoframe', ins).onclick = autoFrame;
    // Crop numbers: pixels of the recording, cut off each edge (the layout keeps fractions of the picture).
    // They apply as you type; leaving the field only saves.
    ins.querySelectorAll('#cropEdges input').forEach((inp) => {
      inp.oninput = () => {
        const f = frameOf(selected), d = srcDims(selected);
        if (!f || !d || inp.value === '') return;
        const k = edgeKey(inp.dataset.e), size = k === 't' || k === 'b' ? d[1] : d[0];
        f.crop = normCrop({ ...f.crop, [k]: Math.max(0, Number(inp.value) || 0) / size });
        setLayout(layout, false);
      };
      inp.onchange = () => { saveLayout(); renderFrameBar(); };
      inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
    });
    $('#cropReset', ins).onclick = () => { const f = frameOf(selected); if (f) { f.crop = { ...NO_CROP }; setLayout(layout); } };
    const pad2 = $('#pad2', ins);
    pad2.oninput = () => { layout.pad = Number(pad2.value); setLayout(layout, false); };
    pad2.onchange = () => saveLayout();
    $('#layerAudio', ins).onclick = () => { const x = layerOf(selected); if (x) { x.audio = !x.audio; setLayout(layout); } };
    $('#layerRemove', ins).onclick = () => { layout.layers = layout.layers.filter((x) => `layer:${x.id}` !== selected); selected = 'cam'; setLayout(layout); };
    $('#addLayer', ins).onclick = (e) => { e.stopPropagation(); takeMenu(); };
    wireEdge(ins, { frame: () => edgeOf(selected), change: (save) => setLayout(layout, save) });
    const pad = $('#pad', ins);
    pad.oninput = () => { layout.pad = Number(pad.value); setLayout(layout, false); };
    pad.onchange = () => saveLayout();
    bgSec = makeBackgroundSection($('#bgSec', ins), { id, get: () => layout, set: (bg) => { layout.bg = bg; setLayout(layout); }, api, toast, esc, h });
    const lySave = $('#lySave', ins), lyName = $('input', lySave);
    lySave.onsubmit = async (e) => {
      e.preventDefault();
      if (!lyName.value.trim()) return lyName.focus();
      try {
        const r = await api('/api/layouts', { op: 'save', name: lyName.value.trim(), layout, project: id });
        saved = r.layouts || []; lySave.hidden = true; renderBar();
        toast(`Saved “${r.saved.name}”. It's a layout tile in every project now.`);
      } catch (err) { toast(err.message); }
    };
    $('[data-a=x]', lySave).onclick = () => { lySave.hidden = true; };
    lyName.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); lySave.hidden = true; } };
    stage.addEventListener('pointerdown', down);
    stage.addEventListener('pointerdown', () => { lastPointer = 'canvas'; }, true);
    for (const el of [$('#timeline', wrap), $('#blockStrip', wrap)]) el.addEventListener('pointerdown', () => { lastPointer = 'timeline'; }, true);
    shots?.bind({
      time: () => master?.currentTime || 0, seek: (t) => seek(t), playing: () => Boolean(master && !master.paused), duration: () => master?.duration || 0,
      base: () => base, scope: () => scopeNow(), editIndex: () => editIndex(),
      // A shot clicked (or tabbed to) on the lane: edit that one (the playhead moves into it, the loop picks it up). A
      // proposed shot picked there shows in the picture, with its tag; another shot picked puts the picture back.
      pick: (i) => {
        if (shotList().length >= 2 && scopePref !== 'shot') { flushShot(); scopePref = 'shot'; }
        if (i == null) return;
        const s = shotList()[i], nextPeek = s?.status === 'proposed' ? s.id : null;
        if (nextPeek !== peekShot) { peekShot = nextPeek; viewMemo.key = ''; trMemo.key = ''; propKey = ''; }
        zoomsC?.deselect();
      },
      flush: () => flushShot(),
      changed: ({ layout: nb, fromCanvas } = {}) => {
        if (nb) { base = normalize(nb, getP().type); baseDirty = false; }
        lookVer++;
        if (fromCanvas && dirty) return renderShotUI();
        deriveEdit(true);
      },
    });
    zoomsC?.bind({
      time: () => master?.currentTime || 0, seek: (t) => seek(t), duration: () => master?.duration || 0,
      picked: (zid) => { if (zid) { selected = null; reframe = false; renderFrameBar(); } renderZoomSec(); propKey = ''; },
      changed: () => { renderZoomSec(); propKey = ''; },
    });
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointerleave', () => { if (!drag) hover = null; });
    stage.addEventListener('dblclick', dbl);
    stage.addEventListener('wheel', wheel, { passive: false });
    tl = makeTimeline($('#timeline', wrap), {
      ...timelineHooks(),
      duration: () => master?.duration || 0,
      time: () => master?.currentTime || 0,
      playing: () => Boolean(master && !master.paused),
      seek: (t) => seek(t),
      cut: () => getP().export.cut,
      // While "Play the locked cut" is on, the ruler and the playhead's flag read the cut's time, like the readout.
      clock: () => (cutOn && getP().export.cut ? cmap() : null),
      clips: clipList,
      selected: () => selected,
      select: (ref) => { if (ref && itemOf(ref)) { selected = ref; reframe = false; renderFrameBar(); } },
      scenes: () => (sceneData ? sceneData.scenes.map((x) => ({ id: x.id, n: x.n, start: cmap().toSource(x.start), end: cmap().toSource(x.end), title: x.title, on: x.id === pickedScene })) : []),
      notes: () => (sceneData ? sceneData.notes.filter((n) => n.t != null).map((n) => ({ id: n.id, t: cmap().toSource(n.t), n: sceneData.notes.filter((x) => x.scene === n.scene).indexOf(n) + 1, tone: n.status })) : []),
      pickScene: (sid) => { pickedScene = sid; },
      openNote: (nid) => { const n = sceneData?.notes.find((x) => x.id === nid); if (n) hooks.openScene?.(n.scene); },
      openScene: (sid) => hooks.openScene?.(sid),
      sig: () => (sceneData ? [pickedScene, sceneData.notes.map((n) => n.id + n.status).join(), getP().export.cut?.file].join('/') : '') + joinSig() + zoomSig() + (cutOn ? '|cut' : ''),
      // The scene graphics (what each scene shows, from the production sheet) and the join check's flags.
      graphics: () => (sceneData ? sceneData.scenes.filter((x) => x.visual).map((x) => ({ id: x.id, sid: x.id, n: x.n, start: cmap().toSource(x.start), end: cmap().toSource(x.end), label: shownOf(x), text: x.visual, on: x.id === pickedScene })) : []),
      joins: () => getP().joins || [],
      // The zooms (work/zooms.json v2, on the take's own seconds; server/shots.mjs reads a v1 plan into it): the Zooms lane
      // you edit (web/zoomsui.js), and Z to draw one on the picture.
      zooms: () => (getP().zooms?.items || []).map((z) => ({ a: z.a, b: z.b, c: z.c, d: z.d, amount: z.box ? null : z.amount, why: z.why || z.name || '' })),
      zoomsUI: zoomsC, zoomKey: () => startZoomDraw(),
      openJoin: (j) => hooks.openCut?.(cmap().toCut(j.t)),
      sfx: hooks.sfx, pickSfx: hooks.pickSfx, moveSfx: hooks.moveSfx,
      band: hooks.blocks?.band,
      shots,
    });
    hooks.blocks?.mount($('#blockStrip', wrap));
    $('#noteMode', wrap).onclick = () => setNoteMode(!noteMode);
    $('#noteMode', wrap).hidden = !sceneData;
    lookVer++;
    applyLayout(base);
    applyZoom();
    refreshCutToggle();
    loadTimeline();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (paused) return;
      followCut();
      syncVideos();
      followShot();
      if (pendingShow && master.readyState >= 1) { const ps = pendingShow; pendingShow = null; showProposal(ps.kind, ps.pid); }
      draw();
      if (aoWave) drawSoundWave(aoWave, aoPeaks, master.currentTime, master.duration);
      if (master.duration) paintTime();
      renderSceneNav();
      tl.draw();
    };
    loop();
  }

  const joinSig = () => (getP().joins || []).map((j) => `${j.k}${j.status[0]}${j.t}`).join();
  let zoomKey = null, zoomStr = ''; // the zooms' redraw key, worked out once per project refresh
  const zoomSig = () => { const z = getP().zooms || null; if (z !== zoomKey) { zoomKey = z; zoomStr = `|z${JSON.stringify(z || [])}`; } return zoomStr; };
  // What a scene shows, short: the first clause of the sheet's "visual" ("XP desktop: Explorer opens…" → "XP desktop").
  const shownOf = (x) => { const v = String(x.visual).split(/[:.;(]/)[0].trim(); return v.length > 48 ? `${v.slice(0, 46).trim()}…` : v || x.title; };
  // The timeline core's side (web/tlcore.js): transport for J/K/L, undo, hover ↔ picture, hidden lanes, keys left to the canvas.
  let tlHover = null;
  function timelineHooks() {
    return {
      project: id, undo: hooks.history, toast,
      play: () => master?.play().catch(() => {}), pause: () => master?.pause(), media: () => master,
      hover: (ref) => { tlHover = ref; },
      cues: hooks.cues, muteSfx: hooks.muteSfx,
      keyGuard: (e) => (reframe && /^Arrow/.test(e.key)) || (cropping && /^(Enter|Escape)$/.test(e.key)) || ((e.key === 'Delete' || e.key === 'Backspace') && canvasDelete()),
      help: [['Double-click a note', 'Open it in Scenes'], ['Click a camera or layer row', 'Select it on the canvas']],
    };
  }
  // A lane hidden on the timeline (its eye) leaves that video out of the preview; the export is unchanged.
  const laneHidden = (ly) => Boolean(tl?.track.flags(`clip:${ly.role === 'layer' ? ly.file : getP().canvas[ly.role === 'cam' ? 'cam' : 'screen']}`).hide);

  // Rows for the timeline's clip tracks: the canvas take's camera and screen, then each extra layer.
  function clipList() {
    const c = getP().canvas, rows = [];
    if (c.cam) rows.push({ label: 'Camera', file: c.cam, ref: itemOf('cam') ? 'cam' : null });
    if (c.screen) rows.push({ label: 'Screen', file: c.screen, ref: itemOf('screen') ? 'screen' : null });
    if (c.audio) rows.push({ label: 'Mic', file: c.audio, ref: null, kind: 'audio' });
    layout.layers.forEach((x, i) => rows.push({ label: `Layer ${i + 1}`, file: x.file, ref: `layer:${x.id}`, kind: x.kind }));
    return rows.map((r) => ({ ...r, duration: videos.get(r.file)?.duration || 0 }));
  }

  let tlKey = '';
  async function loadTimeline() {
    try {
      const d = await api(`/api/projects/${encodeURIComponent(id)}/timeline`);
      aoPeaks = d.peaks;
      const key = `${d.master}|${d.wordsFile}|${d.words.length}|${d.peaks?.data.length || 0}`;
      if (key !== tlKey && tl) { tlKey = key; tl.setData(d); }
    } catch {}
  }

  const camFile = () => getP().canvas.cam;
  const videoOf = (ly) => videos.get(ly.role === 'layer' ? ly.file : getP().canvas[ly.role === 'cam' ? 'cam' : 'screen']);
  const layerOf = (ref) => layout.layers.find((x) => `layer:${x.id}` === ref) || null;
  // The framing (zoom, focus, crop, edge) of the camera, the screen or a layer.
  const frameOf = (ref) => (ref === 'cam' ? layout.cam : ref === 'screen' ? layout.screen : layerOf(ref));
  // Whose edge the Border section edits: in Boxed the screen card wears the camera card's edge.
  const edgeOf = (ref) => (ref === 'screen' && scene?.preset === 'boxed' ? layout.cam : frameOf(ref));
  // Left and Right in the crop numbers are what you see: on a mirrored picture they are the recording's right and left.
  const edgeKey = (k) => (itemOf(selected)?.mirror && (k === 'l' || k === 'r') ? (k === 'l' ? 'r' : 'l') : k);
  // The picture's own size in pixels (the recording, not the playback copy).
  const srcDims = (ref) => { const d = dims(); if (ref === 'cam' || ref === 'screen') return d[ref] || null; const x = layerOf(ref); return x ? d.files?.[x.file] || null : null; };
  const posOf = (ref) => (ref === 'cam' ? layout.webcam : layerOf(ref));
  const itemOf = (ref) => scene?.layers.find((ly) => ly.ref === ref) || null;

  // Everything follows the master clock; sound comes from the camera (or the screen) plus layers with sound on.
  function syncVideos() {
    const t = master.currentTime, playing = !master.paused;
    if (bgP?.sync) bgP.sync(bgTime(), playing);
    for (const [f, v] of videos) {
      const layer = layout.layers.find((x) => x.file === f);
      v.muted = muteAll || (v === master ? false : !(layer && layer.audio));
      if (Math.abs(v.volume - volume) > 0.001) v.volume = volume;
      if (v === master) continue;
      if (v.playbackRate !== master.playbackRate) v.playbackRate = master.playbackRate;
      const target = v.duration ? Math.min(t, v.duration - 0.04) : t;
      if (Math.abs(v.currentTime - target) > 0.15) v.currentTime = target;
      if (playing && v.paused && target < (v.duration || Infinity) - 0.05) v.play().catch(() => {});
      if (!playing && !v.paused) v.pause();
    }
  }

  // The layout's background painter; a still one is part of the base bitmap, so it's rebuilt when it loads.
  const fileUrl = (f) => `/api/projects/${encodeURIComponent(id)}/files/${f.split('/').map(encodeURIComponent).join('/')}`;
  function ensureBg() {
    const want = layout.bg, key = JSON.stringify([want, want.file ? bgSec?.version(want.file) : '']);
    if (key === bgKey) return;
    bgKey = key;
    painterFor(want, { url: fileUrl, version: want.file ? bgSec?.version(want.file) : '' }).then((p) => {
      if (bgKey !== key || !scene) return p.dispose?.();
      bgP?.dispose?.(); bgP = p;
      stills = buildStills(scene, bgP);
      ssCache.clear();
    }).catch((e) => { if (bgKey === key) { toast(`Background: ${e.message}`); bgP?.dispose?.(); bgP = null; if (scene) stills = buildStills(scene, null); } });
  }
  // The background's moment: the export timeline, i.e. the locked cut's time while the cut plays.
  const bgTime = () => frameTime(cutOn && getP().export.cut ? cmap().toCut(master.currentTime) : master.currentTime);

  // Every change on the canvas and in the inspector ends here. In "This shot" it becomes part of the shot's look
  // (what can't differ per shot goes to the video's look); in "Whole video" it is the video's look.
  function setLayout(l, save = true) {
    if (scopeNow() === 'shot' && editId && editBase) {
      const p = patchOf(editBase, l);
      if (p.whole) {
        const off = new Set((base.layers || []).filter((x) => x.hidden).map((x) => x.id));
        base = { ...base, ...(p.whole.aspect ? { aspect: p.whole.aspect } : {}), ...(p.whole.bg ? { bg: structuredClone(p.whole.bg) } : {}),
          ...(p.whole.layers ? { layers: p.whole.layers.map((x) => ({ ...structuredClone(x), ...(off.has(x.id) ? { hidden: true } : {}) })) } : {}) };
        baseDirty = true;
      }
      if (p.look) { pend = applyPatch(pend, p.look, base); dirty = true; }
      l = effectiveLook(base, pend);
    } else base = l;
    lookVer++;
    applyLayout(l);
    if (scopeNow() === 'shot' && editId) editBase = structuredClone(layout);
    if (save) saveLayout();
  }
  function applyLayout(l) {
    layout = l;
    layoutKey = JSON.stringify(layout);
    scene = compose(layout, dims());
    if (bgP && bgP.kind !== layout.bg.kind) { bgP.dispose?.(); bgP = null; ssCache.clear(); } // another kind: Night Desk until it loads
    stills = buildStills(scene, bgP);
    ensureBg();
    if (stage.width !== scene.W || stage.height !== scene.H) { stage.width = scene.W; stage.height = scene.H; applyZoom(); }
    stage.classList.toggle('tall', scene.H > scene.W);
    if (selected && !itemOf(selected)) { selected = itemOf('cam') ? 'cam' : null; reframe = false; cropping = false; cropView = null; }
    renderBar();
    renderFrameBar();
  }
  // The frame shape is the whole video's, whichever scope is on.
  function setAspect(a) {
    if (!base || base.aspect === a) return;
    if (scopeNow() !== 'shot') { setLayout(withPreset(layout, { aspect: a }, dims())); return; }
    flushShot();
    base = withPreset(base, { aspect: a }, dims()); baseDirty = true; lookVer++;
    flushShot();
    deriveEdit(true);
  }

  // ---- shots: which look the canvas edits, saving it, the picture of the moment ----
  // Re-read the look the canvas edits: the base ("Whole video"), or the shot under the playhead with its saved changes.
  // force: also when it's the same shot (its look changed on the server); unsaved changes in that shot are kept.
  function deriveEdit(force = false) {
    if (!stage || !base) return;
    const sc = scopeNow();
    lastScope = sc;
    if (sc === 'all') {
      const was = editId !== null || layout !== base;
      editId = null; pend = null; dirty = false; editBase = null;
      if (was || force) { lookVer++; applyLayout(base); }
    } else {
      const s = shotList()[editIndex()];
      if (s.id === editId && (!force || dirty)) { renderShotUI(); return; }
      editId = s.id; pend = s.look ? structuredClone(s.look) : null; dirty = false;
      const next = effectiveLook(base, pend);
      lookVer++;
      if (force || layout === base || JSON.stringify(next) !== layoutKey) applyLayout(next);
      editBase = structuredClone(layout);
    }
    renderShotUI();
  }
  // Every frame: the playhead went into another shot (playing, scrubbing, a click on the lane), or the scope changed.
  function followShot() {
    if (!shots || drag || cropping) return;
    const sc = scopeNow(), want = sc === 'shot' ? shotList()[editIndex()]?.id : null;
    if (sc === lastScope && want === editId) return;
    if (dirty || baseDirty) flushShot();
    deriveEdit(true);
  }
  function setScope(s) {
    if (shotList().length < 2 || scopeNow() === s) return;
    flushShot();
    scopePref = s;
    deriveEdit(true);
  }
  // Save what changed: the video's look (POST /layout) and the shot's look (the shots routes, one undo step).
  function flushShot() {
    const job = { base: baseDirty ? structuredClone(base) : null, id: editId, want: pend, dirty };
    baseDirty = false; dirty = false;
    if (!job.base && !job.dirty) return saving;
    saving = saving.then(async () => {
      if (job.base) await api(`/api/projects/${encodeURIComponent(id)}/layout`, { layout: job.base }).catch(() => {});
      if (!job.dirty || !job.id || !shots) return;
      const L = shotList(), i = L.findIndex((s) => s.id === job.id);
      if (i < 0) return;
      const { set, clear } = reconcile(L[i].look || null, job.want);
      const ops = [...(set ? [{ op: 'look', id: job.id, look: set }] : []), ...(clear.length ? [{ op: 'clear', id: job.id, keys: clear }] : [])];
      if (ops.length) await shots.chain(ops, { label: `Shot ${i + 1}: ${lookWords([...lookKeys(set || {}), ...clear])}`, quiet: true, fromCanvas: true });
    }).catch(() => {});
    return saving;
  }
  // What an undo step says it changed ("Shot 3: camera zoom, what shows").
  const lookWords = (keys) => [...new Set(keys.map((k) => ({ preset: 'layout', side: 'side', mirror: 'mirror', pad: 'inset', hidden: 'what shows' }[k]
    || (k.startsWith('webcam') ? 'camera box' : `${k.startsWith('cam') ? 'camera' : 'screen'} ${({ zoom: 'zoom', focus: 'framing', crop: 'crop', shape: 'shape', border: 'border', borderW: 'border', shadow: 'shadow' })[k.split('.')[1]] || ''}`.trim()))))].join(', ') || 'look';
  // ↺ on an inspector row: those properties back to the video's look, in this shot.
  function resetKeys(keys) {
    if (!editId || !keys.length) return;
    pend = withoutKeys(pend, keys); dirty = true; lookVer++;
    applyLayout(effectiveLook(base, pend)); editBase = structuredClone(layout);
    flushShot();
  }
  // ↺ on a layer row: shown or hidden as the video has it, in this shot.
  function resetHidden(ref) {
    if (!editId) return;
    const was = hiddenOf(base).includes(ref), cur = pend?.hidden ? [...pend.hidden] : hiddenOf(base);
    pend = applyPatch(pend, { hidden: (was ? [...new Set([...cur, ref])] : cur.filter((x) => x !== ref)).sort() }, base); dirty = true; lookVer++;
    applyLayout(effectiveLook(base, pend)); editBase = structuredClone(layout);
    flushShot();
  }
  // The picture for a look (the canvas's own when it is the edited one).
  function trsNow() {
    const k = `${shots?.version() ?? 0}|${peekShot || ''}|${getP().export.cut?.file || ''}|${cutSegs()?.length || 0}|${master?.duration || 0}`;
    if (trMemo.key !== k) trMemo = { key: k, list: transitionsOf(viewShots(), { cut: cutSegs(), duration: master?.duration || Infinity }) };
    return trMemo.list;
  }
  function ssFor(look) {
    if (look === layout) return { scene, stills };
    let k = keyOf.get(look);
    if (!k) { k = JSON.stringify(look); keyOf.set(look, k); }
    if (k === layoutKey) return { scene, stills };
    let e = ssCache.get(k);
    if (!e) {
      const sc = compose(look, dims());
      e = { scene: sc, stills: buildStills(sc, bgP) };
      ssCache.set(k, e);
      if (ssCache.size > 4) ssCache.delete(ssCache.keys().next().value); // full-frame bitmaps: keep a few
    }
    return e;
  }
  // The video's own look as a picture (the export's layers are always the base's; shots are the export's own work).
  function baseSS() {
    if (layout === base || JSON.stringify(base) === layoutKey) return { scene, stills };
    const sc = compose(base, dims());
    return { scene: sc, stills: buildStills(sc, bgP) };
  }
  // What to draw at take second t: one look, or two inside a transition (web/shotlook.js frameLooks), from the shots
  // the picture plays (viewShots: kept ones, and the proposal being looked at).
  function frameNow(t) {
    const L = viewShots(), shown = editShown();
    if (L.length < 2) return { index: 0, look: shown ? layout : lookFor(L[0]), tr: null };
    return frameLooks(t, { list: L, base, cut: cutSegs(), duration: master?.duration || Infinity, edit: shown ? { id: editId, look: layout } : null, lookOf: (i) => lookFor(L[i]), trs: trsNow() });
  }

  // The inspector's shot parts and the "Editing Shot 3 of 7" chip on the picture.
  function renderShotUI() {
    if (!ins || !wrap || !shots) return;
    const L = shotList(), n = L.length, sc = scopeNow(), i = sc === 'shot' ? Math.max(0, L.findIndex((s) => s.id === editId)) : editIndex(), s = L[i];
    const span = `${mmss(s.start)}–${mmss(shots.endOf(i))}`, sec = shots.sectionAt(s.start), own = Boolean(pend);
    const key = JSON.stringify([n, sc, i, s.id, s.name, span, sec, s.in, own, s.look ? 1 : 0, scopePref]);
    renderMarks();
    if (key === shotUIKey) return;
    shotUIKey = key;
    const shotSec = $('#shotSec', ins);
    shotSec.hidden = false;
    $('#shTitle', ins).textContent = sc === 'shot' ? `Shot ${i + 1}${s.name ? ` · ${s.name}` : ''}` : 'Whole video';
    $('#shSub', ins).textContent = sc === 'shot' ? `${span}${sec ? ` · in ${sec}` : ''}` : n > 1 ? `${n} shots · a shot’s own changes stay` : 'One shot so far';
    ins.querySelectorAll('#shScope button').forEach((b) => { const on = b.dataset.s === sc; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); b.disabled = n < 2; });
    const hint = $('#shHint', ins);
    hint.hidden = n >= 2;
    hint.textContent = 'Changes go to the whole video. Press S on the timeline, or type / before a word, to start a new shot: then each shot can have its own look.';
    const foot = $('#shotFoot', ins);
    foot.hidden = sc !== 'shot';
    $('#sfIn', ins).hidden = i === 0;
    $('#sfTr', ins).textContent = trName(s.in);
    $('#sfPrev', ins).disabled = i === 0;
    $('#sfAll', ins).disabled = !s.look && !own;
    $('#sfBack', ins).disabled = !s.look && !own;
    const chip = $('#editChip', wrap);
    chip.hidden = sc !== 'shot';
    $('#editChipT', wrap).textContent = `Editing Shot ${i + 1} of ${n}${s.name ? ` · ${s.name}` : ''} · ${span}`;
    $('.canvas-wrap', wrap).classList.toggle('shot-on', sc === 'shot');
    renderLayers();
  }
  // "changed in this shot ↺" on the rows this shot changes; in Whole video, "Shot 3 changes this · Apply to it too".
  const RESET_ICON = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6a3.5 3.5 0 1 0 1-2.5M2.5 1.8v2h2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  function renderMarks() {
    if (!ins || !shots) return;
    const sc = scopeNow(), L = shotList();
    for (const el of ins.querySelectorAll('.ov[data-ov]')) {
      const ks = rowKeys(el.dataset.ov, selected, scene?.preset);
      let html = '';
      if (ks.length && sc === 'shot' && editId) {
        const ch = touches(pend, ks);
        if (ch.length) html = `<span class="ov-dot">changed in this shot</span><button type="button" class="ov-r" data-keys="${esc(ch.join(','))}" aria-label="Back to the video’s look for this" title="Back to the video’s look for this">${RESET_ICON}</button>`;
      } else if (ks.length && sc === 'all' && L.length > 1) {
        const who = L.map((x, k) => (touches(x.look, ks).length ? k : -1)).filter((k) => k >= 0);
        if (who.length) {
          const names = who.length === 1 ? `Shot ${who[0] + 1} changes this` : `Shots ${who.slice(0, -1).map((k) => k + 1).join(', ')} and ${who.at(-1) + 1} change this`;
          html = `<span class="ov-note">${names}</span><button type="button" class="ov-a" data-ids="${esc(who.map((k) => L[k].id).join(','))}" data-keys="${esc(ks.join(','))}" title="Take ${who.length === 1 ? 'its' : 'their'} own value away, so the video’s look applies there too">${who.length === 1 ? 'Apply to it too' : 'Apply to them too'}</button>`;
        }
      }
      if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
      el.hidden = !html;
      el.classList.toggle('wide', html.includes('ov-note'));
    }
  }
  // Delete with the camera or the screen picked on the canvas: hidden in this shot (Whole video: in the whole video).
  const canvasDelete = () => lastPointer === 'canvas' && (selected === 'cam' || selected === 'screen') && Boolean(itemOf(selected)) && !cropping;
  async function hideSelected() {
    const ref = selected, what = ref === 'cam' ? 'Camera' : 'Screen';
    const inShot = scopeNow() === 'shot', i = editIndex();
    if (!toggleHidden(ref)) return;
    if (!shots) return;
    if (inShot) {
      await flushShot();
      shots.actionToast(`${what} hidden in Shot ${i + 1}`, [['Undo', () => hooks.history?.undo()], [`Hide in all shots`, () => shots.hideEverywhere(ref)]]);
    } else shots.actionToast(`${what} hidden in the whole video`, [['Show it again', () => { if (isHidden(ref)) toggleHidden(ref); }]]);
  }

  function activeKey() {
    if (scene.preset !== 'pip') return scene.preset;
    // A hidden camera keeps its corner (the PiP box it would be in).
    const w = layout.webcam, b = itemOf('cam')?.box || (layout.hidden.includes('cam') && dims().cam ? { x: w.x * scene.W, y: w.y * scene.H, w: w.w * scene.W, h: w.w * scene.W } : null);
    if (!b) return 'screen';
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    return `pip-${cy < scene.H / 2 ? 't' : 'b'}${cx < scene.W / 2 ? 'l' : 'r'}`;
  }

  const pressed = (box, sel, on) => box.querySelectorAll(sel).forEach((b) => { const v = on(b); b.classList.toggle('on', v); b.setAttribute('aria-pressed', String(v)); });

  function renderBar() {
    pressed(tools, '#aspect button', (b) => b.dataset.a === layout.aspect);
    const d = dims(), have = { screen: Boolean(d.screen), cam: Boolean(d.cam) };
    const active = activeKey();
    if (active.startsWith('pip-')) lastCorner = active.slice(4);
    const box = $('#presets', ins);
    // The tiles are only replaced when they look different: replacing them under a press (a field's change on blur
    // redraws the inspector) would lose that click.
    const tiles = [...LAYOUT_TILES.map((o) => {
      const ok = o.needs.every((n) => have[n]);
      const change = o.change || { corner: lastCorner };
      const sc = compose({ ...withPreset(layout, change, d), layers: [] }, d);
      const name = o.key === 'pip' ? 'Picture-in-picture: the camera in a small box' : o.key === 'boxed' ? 'Boxed: screen card and a tall camera card' : PRESETS[o.key];
      const on = o.key === 'pip' ? active.startsWith('pip') : o.key === active;
      const b = h(`<button class="pz${on ? ' on' : ''}" aria-pressed="${on}" title="${esc(name)}"${ok ? '' : ' disabled'}>${layoutThumb(sc)}<span>${esc(o.label)}</span></button>`);
      b.onclick = () => setLayout(withPreset(layout, change, d));
      return b;
    }), ...saved.map((x) => savedTile(x, d)), h(`<button class="pz pz-add" title="Save this layout (layout, camera framing, background, border and shadow) under a name. It shows here in every project."><span class="pz-plus" aria-hidden="true">+</span><span>Save layout</span></button>`)];
    const tileSig = tiles.map((t) => t.outerHTML).join('');
    if (box.dataset.sig !== tileSig) {
      box.dataset.sig = tileSig;
      box.replaceChildren(...tiles);
      $('.pz-add', box).onclick = () => { const f = $('#lySave', ins); f.hidden = !f.hidden; if (!f.hidden) { $('input', f).value = ''; $('input', f).focus(); } };
    }
    $('#cornerRow', ins).hidden = !active.startsWith('pip-');
    pressed(ins, '#corner button', (b) => active === `pip-${b.dataset.c}`);
    const hasCam = Boolean(itemOf('cam'));
    $('#sideRow', ins).hidden = !['split', 'boxed'].includes(scene.preset);
    pressed(ins, '#side button', (b) => b.dataset.v === layout.side);
    $('#mirrorRow', ins).hidden = $('#mirrorNote', ins).hidden = !hasCam;
    const mv = layout.mirror === 'auto' ? 'auto' : layout.mirror ? 'on' : 'off';
    pressed(ins, '#mirror button', (b) => b.dataset.v === mv);
    $('#placeSec', ins).hidden = $('#sideRow', ins).hidden && !hasCam;
    $('#padRow', ins).hidden = scene.preset !== 'pip' || selected === 'screen';
    for (const [k, v] of [['#pad', '#padVal'], ['#pad2', '#pad2Val']]) {
      const el = $(k, ins);
      if (document.activeElement !== el) el.value = layout.pad || 0;
      $(v, ins).textContent = `${layout.pad || 0}%`;
    }
    $('#bgSec', ins).hidden = !scene.bgVisible;
    bgSec?.render();
    // A mic-only take: no layouts to pick, just the background (the note says so).
    const soundOnly = scene.preset === 'audio';
    box.hidden = soundOnly;
    $('#audioNote', ins).hidden = !soundOnly;
    $('.hint', ins).hidden = soundOnly;
    renderLayers();
  }

  // A saved layout's tile: its look on this project (its frame shape and layers stay); × or right-click removes it.
  const lookKey = (l) => JSON.stringify([l.preset, l.side, l.mirror, l.pad, l.cam, l.bg, l.preset === 'pip' ? l.webcam : null]);
  function savedTile(x, d) {
    const look = normalize({ ...layout, ...x.layout, aspect: layout.aspect, layers: layout.layers, hidden: layout.hidden }, getP().type);
    const on = lookKey(look) === lookKey(layout);
    const el = h(`<div class="pz-wrap"><button class="pz${on ? ' on' : ''}" aria-pressed="${on}" title="${esc(x.name)}: a layout you saved (every project has it)">${layoutThumb(compose({ ...look, layers: [] }, d))}<span>${esc(x.name)}</span></button>
      <button class="pz-x" aria-label="Remove the saved layout ${esc(x.name)}" title="Remove “${esc(x.name)}” from every project">×</button></div>`);
    $('.pz', el).onclick = async () => {
      if (scopeNow() === 'shot') { setLayout(normalize({ ...look, bg: layout.bg }, getP().type)); return; }
      try {
        const r = await api('/api/layouts', { op: 'apply', id: x.id, project: id });
        setLayout(normalize(r.layout, getP().type));
        if (r.layout.bg?.file) bgSec?.refresh()?.then(() => ensureBg());
        if (r.note) toast(r.note);
      } catch (err) { toast(err.message); }
    };
    const remove = async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!confirm(`Remove the saved layout “${x.name}”? It goes from the layouts of every project; projects that use it keep their look.`)) return;
      try { saved = (await api('/api/layouts', { op: 'remove', id: x.id })).layouts || []; renderBar(); } catch (err) { toast(err.message); }
    };
    $('.pz-x', el).onclick = remove;
    $('.pz', el).oncontextmenu = remove;
    return el;
  }

  // The Crop & zoom controls work on the selected camera, screen or layer: shape (a box you move), zoom, crop, reframe,
  // auto-frame (a camera), the screen's inset (PiP), a layer's sound and remove. The Border section edits the selected
  // card's edge (in Boxed the screen's is the camera's, so the two cards match).
  function renderFrameBar() {
    const it = selected && itemOf(selected), f = selected && frameOf(selected);
    const on = Boolean(it && f);
    // Another pick (on the canvas, the layer list or the timeline) finishes a crop.
    if (cropping && (!on || cropView?.ref !== selected)) { cropping = false; cropView = null; saveLayout(); }
    $('#frameSec', ins).hidden = !on;
    $('#selDot', ins).hidden = !on;
    const layer = on ? layerOf(selected) : null;
    const isScreen = selected === 'screen' || layer?.kind === 'screen';
    $('#fbName', ins).textContent = !on ? 'Canvas' : layer ? `Layer: ${layer.kind === 'cam' ? 'camera' : 'screen'}` : selected === 'screen' ? 'Screen' : 'Camera';
    $('#selHint', ins).textContent = !on ? 'click the camera or the screen to edit it' : layer ? `take ${takeLabel(layer.file.slice(0, 19))}` : 'selected on the canvas';
    renderLayers();
    renderMarks();
    if (!on) { renderEdge(ins, null); return; }
    const isCam = selected === 'cam' || layer?.kind === 'cam';
    $('#shape', ins).hidden = !it.movable;
    pressed(ins, '#shape button', (b) => b.dataset.s === f.shape);
    const zoom = $('#zoom', ins);
    if (document.activeElement !== zoom) zoom.value = f.zoom;
    $('#zoomVal', ins).textContent = `${f.zoom.toFixed(2)}×`;
    $('#zoomRow', ins).title = `How close the ${isScreen ? 'screen' : 'camera'} is (also: scroll over it)`;
    for (const [k, v] of [['#reframe', reframe], ['#crop', cropping]]) { const b = $(k, ins); b.classList.toggle('on', v); b.setAttribute('aria-pressed', String(v)); }
    $('#crop', ins).textContent = cropping ? 'Done' : 'Crop';
    $('#autoframe', ins).hidden = !isCam;
    $('#frameBtns', ins).classList.toggle('three', isCam);
    $('#layerBtns', ins).hidden = !layer;
    if (layer) $('#layerAudio', ins).textContent = `Sound: ${layer.audio ? 'on' : 'off'}`;
    $('#reframeTip', ins).hidden = !reframe;
    $('#reframeTip', ins).textContent = `Drag to ${isCam ? 'centre yourself on the cross' : 'move the picture in its box'} (arrow keys nudge, scroll zooms). The faint picture is the whole ${isScreen ? 'screen' : 'camera'}${Object.values(f.crop || NO_CROP).some((v) => v > 0) ? ' the crop leaves' : ''}.`;
    $('#cropTip', ins).hidden = !cropping;
    // The crop in pixels of the recording.
    const d = srcDims(selected), c = f.crop || NO_CROP;
    $('#cropUnit', ins).textContent = d ? `px of the ${d[0]} × ${d[1]} recording` : '';
    ins.querySelectorAll('#cropEdges input').forEach((inp) => {
      const k = edgeKey(inp.dataset.e), size = d ? (k === 't' || k === 'b' ? d[1] : d[0]) : 0;
      inp.disabled = !d;
      inp.max = String(Math.round(size * (1 - MIN_KEEP)));
      if (document.activeElement !== inp) inp.value = d ? String(Math.round(c[k] * size)) : '';
    });
    $('#cropReset', ins).disabled = !Object.values(c).some((v) => v > 0);
    // The screen's size in PiP: its inset (the layout gives every other box its place). It moves here from Layout.
    const insetHere = selected === 'screen' && scene.preset === 'pip';
    $('#insetRow', ins).hidden = !insetHere;
    $('#padRow', ins).hidden = scene.preset !== 'pip' || insetHere;
    renderEdge(ins, edgeOf(selected), it, scene.preset, getP().brandColors || []);
  }

  // What is on the canvas, top to bottom; the camera and layers can be picked here too.
  // Each row has an eye: a hidden layer is out of the picture and every export (layout.hidden, a layer's hidden).
  // With scene renders, a "Scene graphics" row says where the graphics are (Claude's renders, reviewed in Scenes).
  function renderLayers() {
    const box = $('#layerList', ins);
    if (!box) return;
    const rows = clipList().reverse().map((r) => ({ ...r, lref: r.label === 'Camera' ? 'cam' : r.label === 'Screen' ? 'screen' : r.ref }));
    // Which layers this layout has at all (a Camera layout has no screen), hidden ones included.
    const all = new Set(compose({ ...layout, hidden: [], layers: layout.layers.map((x) => ({ ...x, hidden: false })) }, dims()).layers.map((ly) => ly.ref));
    const gfx = sceneData?.renders?.length ? sceneData : null;
    // In a shot: a picture shown or hidden differently from the video says so, with ↺.
    const baseOff = new Set(hiddenOf(base)), shotOv = (ref) => scopeNow() === 'shot' && pend?.hidden && ref && (pend.hidden.includes(ref) !== baseOff.has(ref));
    const sig = JSON.stringify([rows.map((r) => [r.ref, r.label, isHidden(r.lref), all.has(r.lref), shotOv(r.lref)]), selected, layout.layers.map((x) => x.audio), gfx ? [gfx.sceneFile, gfx.scenes.length, gfx.renders.length, gfx.builtEnd, gfx.renders[0]?.file] : 0]);
    // How many scenes a render has built (an intro render reaches the intro's scenes), and the newest one.
    const nBuilt = gfx ? gfx.scenes.filter((s) => (gfx.builtEnd ?? Infinity) > s.start + 0.1).length : 0;
    const gfxName = gfx?.renders[0]?.file.replace(/^renders\//, '') || '', gfxFile = gfxName.startsWith(`${id}_`) ? gfxName.slice(id.length + 1) : gfxName;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.replaceChildren(...rows.map((r) => {
      const layer = r.ref && layerOf(r.ref);
      const kind = layer ? layer.kind : r.kind === 'audio' ? 'audio' : r.label === 'Screen' ? 'screen' : 'cam';
      const off = isHidden(r.lref), inIt = Boolean(r.lref && all.has(r.lref));
      const ov = shotOv(r.lref);
      const sub = ov ? (off ? 'hidden in this shot' : 'shown in this shot') : !inIt && r.kind !== 'audio' ? 'not in this layout' : off ? 'hidden, in the export too'
        : layer ? `take ${takeLabel(layer.file.slice(0, 19))} · sound ${layer.audio ? 'on' : 'off'}` : r.kind === 'audio' ? 'canvas take · sound only' : r.label === 'Camera' ? 'canvas take · sound' : 'canvas take';
      const row = h(`<div class="layer${r.ref && r.ref === selected ? ' on' : ''}${off ? ' off' : ''}"><button class="ly-pick"${r.ref && !off ? '' : ' disabled'}><span class="lk ${kind}" aria-hidden="true"></span><span class="ln"><b>${esc(r.label)}</b><small>${esc(sub)}</small></span></button>
        ${ov ? `<button class="ly-ov" aria-label="${esc(r.label)}: as the whole video has it" title="As the whole video has it">${RESET_ICON}</button>` : ''}${inIt ? `<button class="ly-eye" aria-pressed="${!off}" aria-label="${off ? 'Show' : 'Hide'} ${esc(r.label)}${scopeNow() === 'shot' ? ' in this shot' : ''}" title="${off ? 'Show it again' : scopeNow() === 'shot' ? 'Hide it in this shot' : 'Hide it in the picture and the export'}">${off ? TP_ICON.eyeOff : TP_ICON.eye}</button>` : ''}</div>`);
      if (ov) row.classList.add('shot-ov');
      $('.ly-ov', row)?.addEventListener('click', () => resetHidden(r.lref));
      if (r.ref && !off) $('.ly-pick', row).onclick = () => { selected = r.ref; reframe = false; renderFrameBar(); };
      $('.ly-eye', row)?.addEventListener('click', () => toggleHidden(r.lref));
      return row;
    }), ...(gfx ? [h(`<div class="layer ly-gfx"><span class="lk gfx" aria-hidden="true"></span><span class="ln"><b>Scene graphics</b><small>${esc([gfx.sceneFile, nBuilt < gfx.scenes.length ? `${nBuilt} of ${gfx.scenes.length} scenes built` : `${gfx.scenes.length} scene${gfx.scenes.length > 1 ? 's' : ''}`, gfxFile ? `in ${gfxFile}` : 'in the renders'].filter(Boolean).join(' · '))}</small></span>
        <button class="btn ghost small" data-a="scenes" title="The scene graphics are drawn into Claude's render, not on this canvas; Export → Video puts the render in for the scenes it reaches. Review and change them in Scenes">Scenes →</button></div>`)] : []));
    $('[data-a=scenes]', box)?.addEventListener('click', () => hooks.openScene?.(sceneNow()?.id || sceneData.scenes[0]?.id));
  }
  const isHidden = (ref) => (ref === 'cam' || ref === 'screen' ? layout.hidden.includes(ref) : Boolean(ref && layerOf(ref)?.hidden));
  function toggleHidden(ref) {
    const off = isHidden(ref);
    if (!off && itemOf(ref) && scene.layers.length <= 1) { toast('Keep at least one layer showing: show another one first.'); return false; }
    if (ref === 'cam' || ref === 'screen') layout.hidden = off ? layout.hidden.filter((x) => x !== ref) : [...layout.hidden, ref];
    else { const x = layerOf(ref); if (!x) return false; if (off) delete x.hidden; else x.hidden = true; }
    setLayout(layout);
    return !off;
  }
  // "+ Add a take as a layer": recent takes from the recordings folder (or record a new one); it goes on top in its own box.
  async function takeMenu() {
    const host = $('.add-take', ins);
    const open = $('.take-menu', host);
    if (open) { open.remove(); return; }
    const menu = h(`<div class="take-menu menu" role="menu"><div class="menu-h">Add a take as a layer</div><div class="tm-list"><p class="sub">Loading…</p></div>
      <button class="mi" role="menuitem" data-a="rec"><b>Record a new take…</b><small>Opens Record; the take comes in as a layer</small></button></div>`);
    host.append(menu);
    $('[data-a=rec]', menu).onclick = () => { menu.remove(); document.getElementById('recBtn')?.click(); };
    let takes = [];
    try { takes = await api('/api/takes'); } catch (e) { toast(e.message); }
    const P = getP();
    const onCanvas = (t) => (P.roles?.take || []).some((f) => f.startsWith(t.id)), asLayer = (t) => layout.layers.some((x) => x.file.startsWith(t.id));
    $('.tm-list', menu).replaceChildren(...(takes.length ? takes.slice(0, 8).map((t) => {
      const why = onCanvas(t) ? 'on the canvas already' : asLayer(t) ? 'a layer already' : t.files.every(isSound) ? 'sound only: no picture to put in a box' : '';
      const b = h(`<button class="mi" role="menuitem"${why ? ' disabled' : ''}><b>${esc(takeLabel(t.id))}</b><small>${esc(why || `${takeWhat(t)} · ${gb(t.bytes)}`)}</small></button>`);
      b.onclick = async () => {
        menu.remove();
        try { await api(`/api/projects/${encodeURIComponent(id)}/import`, { take: t.id, target: 'layer' }); } catch (e) { toast(e.message); }
      };
      return b;
    }) : [h('<p class="sub">No recordings yet.</p>')]));
  }

  async function autoFrame() {
    const btn = $('#autoframe', ins);
    btn.disabled = true; btn.textContent = 'Framing…';
    try {
      const layer = layerOf(selected), was = structuredClone(base), inShot = scopeNow() === 'shot' && editId;
      const r = await api(`/api/projects/${encodeURIComponent(id)}/autoframe`, layer ? { layer: layer.id } : {});
      if (!r.found) toast('No face found in this camera take.');
      else if (inShot && !layer) {
        // The server framed the video's camera: that goes back, and the framing it found becomes this shot's.
        const nb = normalize(r.layout, getP().type);
        await api(`/api/projects/${encodeURIComponent(id)}/layout`, { layout: was }).catch(() => {});
        layout.cam = { ...layout.cam, zoom: nb.cam.zoom, focus: nb.cam.focus };
        setLayout(layout);
      } else if (inShot) { base = normalize(r.layout, getP().type); lookVer++; deriveEdit(true); }
      else setLayout(normalize(r.layout, getP().type), false);
    } catch (e) { toast(e.message); }
    btn.disabled = false; btn.textContent = 'Auto-frame';
  }

  // The readout is on the clock of what plays: the cut's time while "Play the locked cut" is on (the same as the Cut
  // tab, Scenes and the export), else the take's; the other one is in its tooltip.
  let timeSig = '';
  function paintTime() {
    const time = $('#time', wrap), cut = getP().export.cut, t = master.currentTime;
    const onCut = cutOn && cut, m = onCut ? cmap() : null;
    const html = onCut ? `<b>${clock(m.toCut(t))}</b> / ${clock(m.length)}` : `<b>${clock(t)}</b> / ${clock(master.duration)}`;
    if (html === timeSig) return;
    timeSig = html;
    time.innerHTML = html;
    const word = cutName(cut);
    time.title = onCut ? `On the ${word} (take ${clock(t)})` : cut ? `On the whole take (the ${word} is at ${clock(cmap().toCut(t))})` : 'On the take';
  }

  // "Play the cut": jump over the parts the locked cut removes.
  let cutOn = false;
  const cutName = (cut) => (cut?.state === 'changed' ? 'edited cut' : cut?.state === 'rough' ? 'rough cut' : 'locked cut');
  function refreshCutToggle() {
    const cut = getP().export.cut;
    const w = $('#cutWrap', wrap);
    if (!w) return;
    w.hidden = !cut;
    // "locked" only while the Lock holds; before it the rough cut (Clean up's, with any edits); edited after it, the edited cut.
    const word = cutName(cut);
    if (w.lastChild?.nodeType === 3 && w.lastChild.textContent !== `Play the ${word}`) { w.lastChild.textContent = `Play the ${word}`; w.title = `Skip the parts the ${word} removes, like the export does`; }
    $('#cutPlay', w).onchange = (e) => { cutOn = e.target.checked; };
    if (!cut) cutOn = false;
  }
  function followCut() {
    const cut = getP().export.cut;
    if (!cutOn || !cut || !master || master.paused) return;
    const t = master.currentTime;
    if (cut.segments.some(([a, b]) => t >= a && t < b)) return;
    const next = cut.segments.find(([a]) => a > t);
    if (next) seek(next[0]);
    else { master.pause(); seek(cut.segments[0][0]); }
  }

  function toggle() {
    if (!master) return;
    if (master.paused) {
      const cut = getP().export.cut;
      if (cutOn && cut && !cut.segments.some(([a, b]) => master.currentTime >= a && master.currentTime < b)) seek((cut.segments.find(([a]) => a > master.currentTime) || cut.segments[0])[0]);
      master.play();
    } else master.pause();
  }
  function seek(t) { for (const v of videos.values()) v.currentTime = Math.min(t, v.duration ? v.duration - 0.04 : t); }

  // ---- transport: scenes, volume, picture size ----
  // The scene under the playhead (scene times are on the locked cut; the canvas plays the take).
  function sceneNow() {
    const list = sceneData?.scenes || [];
    if (!list.length || !master) return null;
    const tc = cmap().toCut(master.currentTime) + 0.01; // a jump lands on a scene's first frame: count it as that scene
    return list.find((x) => tc >= x.start && tc < x.end) || (tc >= list.at(-1).end ? list.at(-1) : null);
  }
  // Back: to the start of this scene, or the one before when you're at its start already. Next: the next scene's start.
  function jumpScene(dir) {
    const list = (sceneData?.scenes || []).map((x) => cmap().toSource(x.start));
    if (!list.length || !master) return;
    const t = master.currentTime;
    const to = dir < 0 ? list.filter((a) => a < t - 0.6).at(-1) ?? list[0] : list.find((a) => a > t + 0.05);
    if (to == null) { toast('This is the last scene.'); return; }
    seek(to);
  }
  function renderSceneNav() {
    const chip = wrap && $('#sceneChip', wrap);
    if (!chip) return;
    const has = Boolean(sceneData?.scenes?.length), sc = has ? sceneNow() : null;
    const sec = sc && sceneData.sections?.length > 1 ? sceneData.sections.find((x) => x.scenes.includes(sc.id)) : null;
    const key = `${has}|${sc ? `${sc.id}|${sc.n}|${sc.title}|${sec?.label || ''}` : ''}`;
    if (key === chipKey) return;
    chipKey = key;
    const why = has ? '' : ` (no scenes yet: ${getP().pipeline?.steps.find((x) => x.id === 'plan')?.name || 'Plan the scenes'} makes them)`;
    for (const [sel, what] of [['#prevScene', 'Back to the previous scene'], ['#nextScene', 'Next scene']]) { const b = $(sel, wrap); b.disabled = !has; b.title = what + why; }
    chip.hidden = !sc;
    if (sc) { chip.textContent = `${sec ? `${sec.label} · ` : ''}Scene ${sc.n} · ${sc.title}`; chip.title = `Scene ${sc.n}: ${sc.title}${sec ? ` (${sec.label})` : ''}. Click to open it in Scenes.`; }
  }
  function saveVol() { try { localStorage.setItem('studio.canvas.volume', JSON.stringify({ volume, muted: muteAll })); } catch {} renderVol(); }
  function renderVol() {
    const b = wrap && $('#volBtn', wrap), r = wrap && $('#vol', wrap);
    if (!b) return;
    b.innerHTML = muteAll ? TP_ICON.muted : TP_ICON.vol;
    b.setAttribute('aria-label', muteAll ? 'Sound off: click to hear it' : 'Mute');
    b.title = muteAll ? 'Sound off (this preview only): click to hear it' : 'Mute the preview';
    b.classList.toggle('on', muteAll);
    if (document.activeElement !== r) r.value = String(muteAll ? 0 : volume);
  }
  function applyZoom() {
    if (!stage || !scene || !wrap) return;
    const z = picZoom === 'fit' ? null : picZoom;
    $('.canvas-wrap', wrap).classList.toggle('zoomed', Boolean(z));
    stage.style.width = z ? `${Math.round(scene.W * z)}px` : '';
    stage.style.height = z ? `${Math.round(scene.H * z)}px` : '';
    zoomLabel();
  }
  function zoomLabel() {
    const b = tools.querySelector('#picZoom');
    if (!b || !stage || !scene) return;
    b.textContent = picZoom === 'fit' ? `Fit · ${Math.round((stage.clientWidth / scene.W) * 100)}%` : `${Math.round(picZoom * 100)}%`;
    tools.querySelectorAll('.pic-zoom [data-z]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.z === String(picZoom))));
  }
  // Menus in the tab bar and the inspector close on a click elsewhere.
  function closeMenus(e) {
    const z = tools.querySelector('.pic-zoom');
    if (z?.open && !z.contains(e.target)) z.open = false;
    const m = ins && $('.take-menu', ins);
    if (m && !m.contains(e.target)) m.remove();
  }
  document.addEventListener('click', closeMenus);

  // The crop a card shows at take second t: its look's crop, moved by a kept zoom (web/layout.js zoomAt, zoomedCrop:
  // the same crop the export cuts that frame with). Not while it's being reframed.
  function cropAt(ly, look, t, edit) {
    if (t == null || !look || (ly.role !== 'cam' && ly.role !== 'screen') || (edit && reframe && ly.ref === selected)) return ly.crop;
    const z = zoomAt(t, ly.role === 'cam' ? 'camera' : 'screen', viewZooms(), { shots: viewShots(), cut: cutSegs() });
    return z ? zoomedCrop(look, ly, z, dims()) : ly.crop;
  }
  // One look's picture: its still parts and each video in its box (the edited look also shows Reframe and Crop).
  function paintScene(g, { scene: sc, stills: st }, look = null, t = null) {
    const edit = sc === scene;
    g.drawImage(st.base, 0, 0);
    sc.layers.forEach((ly, i) => {
      const v = videoOf(ly);
      if (edit && reframe && ly.ref === selected) drawGhost(g, ly, v, sc.u);
      // In crop mode the picture being cropped is drawn whole on top (drawCrop), not in its box.
      if (v?.videoWidth && !laneHidden(ly) && !(edit && cropping && ly.ref === selected)) {
        const { x, y, w, h: hh } = ly.box, c = cropAt(ly, look, t, edit);
        if (sc === vscene) shownCrops.set(ly.ref, c);
        const src = [c.x * v.videoWidth, c.y * v.videoHeight, c.w * v.videoWidth, c.h * v.videoHeight];
        const tmp = st.tmp[i], tg = tmp.getContext('2d');
        tg.globalCompositeOperation = 'source-over';
        tg.save();
        if (ly.mirror) { tg.translate(w, 0); tg.scale(-1, 1); }
        tg.drawImage(v, ...src, 0, 0, w, hh);
        tg.restore();
        if (ly.radius) { tg.globalCompositeOperation = 'destination-in'; tg.drawImage(st.masks[i], 0, 0); tg.globalCompositeOperation = 'source-over'; }
        g.drawImage(tmp, x, y);
      }
      if (st.mids[i]) g.drawImage(st.mids[i], 0, 0);
    });
  }
  function draw() {
    const g = stage.getContext('2d'), t = master.currentTime;
    // The look of this moment (frameLooks): the shot under the playhead, or two shots inside a transition.
    const fv = frameNow(t), cur = ssFor(fv.look);
    vscene = cur.scene;
    if (bgP?.animated) bgP.paint(g, scene.W, scene.H, bgTime());
    const tr = fv.tr && fv.tr.p > 0 && fv.tr.p < 1 ? fv.tr : null;
    if (tr) drawTransition(g, tr, t);
    else paintScene(g, cur, fv.look, t);
    paintPropTag(t);
    drawPins(g);
    if (zoomDraw) drawZoomBox(g);
    // Editing marks (preview only): the selection box with its name ("Camera · drag to move") and corner handles
    // (a box that moves resizes from any corner), hover outlines; dashed while reframing. Selection blue.
    if (markLook !== appearanceKey()) { markLook = appearanceKey(); markColor = ''; } // Settings → Appearance
    const mark = markColor ||= tokens()('--sel', '#2563eb');
    const px = scene.W / Math.max(1, stage.clientWidth); // export pixels per screen pixel: marks keep their screen size
    if (cropping && cropView) { drawCrop(g, mark, px); return; }
    for (const ref of new Set([selected, hover, tlHover].filter(Boolean))) {
      const it = vItemOf(ref);
      if (!it || !(ref === selected || it.movable || ref === hover || ref === tlHover || drag)) continue;
      const r = it.box, k = (ref === selected ? 1 : 0.75) * px, sel = ref === selected;
      g.save();
      g.strokeStyle = mark; g.lineWidth = k * 2;
      if (reframe && sel) g.setLineDash([6 * px, 4 * px]);
      g.beginPath();
      if (it.radius >= r.w / 2 - 1) g.arc(r.x + r.w / 2, r.y + r.h / 2, r.w / 2 + k, 0, Math.PI * 2);
      else g.roundRect(r.x - k, r.y - k, r.w + 2 * k, r.h + 2 * k, (it.radius || 0) + k);
      g.stroke();
      g.restore();
      if (reframe && sel) drawGuides(g, it, scene.u, mark);
      if (!sel) continue;
      if ((it.movable || insetable(it)) && !reframe) {
        const hs = 9 * px;
        for (const [cx, cy] of corners(r)) {
          g.fillStyle = '#fff'; g.strokeStyle = mark; g.lineWidth = 2 * px;
          g.beginPath(); g.roundRect(cx - hs / 2, cy - hs / 2, hs, hs, 2 * px); g.fill(); g.stroke();
        }
      }
      if (master.paused) selLabel(g, it, mark, px); // the tag steps aside while the picture plays
    }
  }
  // A transition, the way ffmpeg's xfade makes it in the export (web/layout.js): each shot's whole picture (its
  // background too) drawn apart, then crossfaded (p), slid (slideOffsets) or pushed into and faded (zoominAt).
  function drawTransition(g, tr, t) {
    const W = scene.W, H = scene.H;
    if (!fadeCv || fadeCv[0].width !== W || fadeCv[0].height !== H) fadeCv = [mkCanvas(W, H), mkCanvas(W, H)];
    const [A, B] = fadeCv;
    for (const [cv, look] of [[A, tr.from], [B, tr.to]]) {
      const og = cv.getContext('2d');
      og.clearRect(0, 0, W, H);
      if (bgP?.animated) bgP.paint(og, W, H, bgTime());
      paintScene(og, ssFor(look), look, t);
    }
    if (tr.type === 'slide') {
      const o = slideOffsets(tr.dir, tr.p, W, H);
      g.clearRect(0, 0, W, H);
      g.drawImage(A, o.from[0], o.from[1]); g.drawImage(B, o.to[0], o.to[1]);
    } else if (tr.type === 'zoom') {
      const { zf, mix } = zoominAt(tr.p), sw = Math.max(1, W * zf), sh = Math.max(1, H * zf);
      g.drawImage(A, (W - sw) / 2, (H - sh) / 2, sw, sh, 0, 0, W, H);
      if (mix < 1) { g.save(); g.globalAlpha = 1 - mix; g.drawImage(B, 0, 0); g.restore(); }
    } else {
      g.drawImage(A, 0, 0);
      g.save(); g.globalAlpha = tr.p; g.drawImage(B, 0, 0); g.restore();
    }
  }

  // ---- Claude's proposals on the picture: a tag while the playhead is in one ("Proposed by Claude · Preview · Keep it ·
  // No thanks"); Preview shows it (only then: the picture plays what the export renders) ----
  // The one the tag is about: the proposal being shown (a picked zoom, then a peeked shot), else a proposed zoom or shot
  // under the playhead.
  function propHere(t) {
    const zs = zoomsC?.list() || [], sel = zoomsC?.selected(), L = shotList();
    const zone = (x) => x && { kind: 'zoom', id: x.id, item: x, n: zs.indexOf(x), on: x.id === sel };
    const sone = (x) => x && { kind: 'shot', id: x.id, item: x, n: L.indexOf(x), on: x.id === peekShot };
    const inShot = (x) => t >= x.start - 0.05 && t < (shots?.endOf(L.indexOf(x)) ?? Infinity) + 0.05;
    return zone(zs.find((x) => x.id === sel && x.status === 'proposed' && t >= x.a - 0.05 && t <= x.d + 0.05))
      || sone(peekShot && L.find((x) => x.id === peekShot && x.status === 'proposed' && inShot(x)))
      || zone(zs.find((x) => x.status === 'proposed' && t >= x.a && t < x.d))
      || sone(((h) => (h?.shot.status === 'proposed' ? h.shot : null))(shotAt(t, L)));
  }
  function paintPropTag(t) {
    const tag = wrap && $('#propTag', wrap);
    if (!tag) return;
    const ph = shots || zoomsC ? propHere(t) : null;
    const k = ph ? `${ph.kind}|${ph.id}|${ph.on}|${shots?.version()}|${zoomsC?.version()}` : '';
    if (k === propKey) return;
    propKey = k;
    tag.hidden = !ph;
    if (!ph) return;
    tag.dataset.kind = ph.kind; tag.dataset.id = ph.id;
    tag.classList.toggle('on', ph.on);
    $('.pt-t', tag).textContent = `${ph.on ? 'Showing Claude’s proposal' : 'Claude proposed'} · ${ph.kind === 'shot' ? `Shot ${ph.n + 1}` : `Zoom ${ph.n + 1}`}: ${proposalWhat(ph.kind, ph.item)}`;
    const pv = $('[data-p=preview]', tag);
    pv.textContent = ph.on ? 'Hide' : 'Preview';
    pv.title = ph.on ? 'Back to what the export renders' : 'See it in the picture (the export leaves it out until you keep it)';
  }
  async function propAct(a) {
    const tag = $('#propTag', wrap), kind = tag.dataset.kind, pid = tag.dataset.id;
    if (a === 'preview') {
      if (kind === 'shot') { peekShot = peekShot === pid ? null : pid; viewMemo.key = ''; trMemo.key = ''; }
      else zoomsC?.select(zoomsC.selected() === pid ? null : pid);
      propKey = '';
      return;
    }
    const ctl = kind === 'shot' ? shots : zoomsC;
    await (a === 'keep' ? ctl?.keep([pid]) : ctl?.reject([pid]));
    if (kind === 'shot' && peekShot === pid) peekShot = null;
    propKey = '';
  }
  // Show me (the chat's proposals block): the playhead into it and the picture showing it.
  function showProposal(kind, pid) {
    if (kind === 'shot') {
      const L = shotList(), i = L.findIndex((x) => x.id === pid);
      if (i < 0) return;
      peekShot = pid; viewMemo.key = ''; trMemo.key = '';
      seek(Math.min(shots.endOf(i) - 0.05, L[i].start + 0.3));
      tl?.show(L[i].start, shots.endOf(i));
    } else {
      const z = zoomsC?.list().find((x) => x.id === pid);
      if (!z) return;
      zoomsC.select(pid);
      seek(z.b + Math.min(0.3, (z.c - z.b) / 2));
      tl?.show(z.a, z.d);
    }
    propKey = '';
  }

  // ---- Z: zoom into an area. Press Z (or the toolbar's Zoom into an area), drag a box on the screen
  // or the camera: a zoom from the playhead, 3 s long, into that box (the server gives it the card's shape). From the
  // zoom inspector's "Edit on the picture", the box replaces that zoom's area. ----
  function startZoomDraw(edit = null) {
    if (!zoomsC || !vscene?.layers.some((ly) => ly.role === 'cam' || ly.role === 'screen')) { toast('There is no screen or camera in the picture to zoom into.'); return; }
    if (cropping) endCrop();
    reframe = false;
    const z = edit ? zoomsC.list().find((x) => x.id === edit) : null;
    zoomDraw = { edit: z ? z.id : null, target: z ? z.target : null };
    zdrag = null;
    stage.style.cursor = 'crosshair';
    renderZoomTool();
  }
  function endZoomDraw() { zoomDraw = null; zdrag = null; if (stage) stage.style.cursor = ''; renderZoomTool(); }
  function renderZoomTool() {
    const b = tools?.querySelector('#zoomTool');
    if (b) { b.classList.toggle('on', Boolean(zoomDraw)); b.setAttribute('aria-pressed', String(Boolean(zoomDraw))); }
  }
  const zoomCard = (p) => [...(vscene || scene).layers].reverse().find((ly) => (ly.role === 'cam' || ly.role === 'screen')
    && (!zoomDraw?.target || ly.role === (zoomDraw.target === 'camera' ? 'cam' : 'screen')) && inBox(p, ly.box)) || null;
  function zoomDown(e, p) {
    const ly = zoomCard(p);
    if (!ly) { toast(zoomDraw.target ? `Start the box on the ${zoomDraw.target}.` : 'Start the box on the screen or the camera.'); return; }
    stage.setPointerCapture(e.pointerId);
    zdrag = { ly, a: p, b: p };
  }
  function zoomMove(p) {
    if (!zdrag) return;
    // The box keeps the card's shape, inside the card.
    const { ly, a } = zdrag, bAR = ly.box.w / ly.box.h;
    const sx = p.x >= a.x ? 1 : -1, sy = p.y >= a.y ? 1 : -1;
    let w = Math.max(Math.abs(p.x - a.x), Math.abs(p.y - a.y) * bAR);
    const roomX = sx > 0 ? ly.box.x + ly.box.w - a.x : a.x - ly.box.x, roomY = sy > 0 ? ly.box.y + ly.box.h - a.y : a.y - ly.box.y;
    w = Math.min(w, roomX, roomY * bAR);
    zdrag.b = { x: a.x + sx * w, y: a.y + sy * (w / bAR) };
  }
  async function zoomUp() {
    const d = zdrag;
    zdrag = null;
    if (!d) return;
    const r = { x: Math.min(d.a.x, d.b.x), y: Math.min(d.a.y, d.b.y), w: Math.abs(d.b.x - d.a.x), h: Math.abs(d.b.y - d.a.y) };
    if (r.w < 0.04 * d.ly.box.w) { toast('Drag a bigger box: the area to zoom into.'); return; }
    // The box on the frame → the part of the picture it shows (the crop it has now, zooms in) → fractions of what the
    // card's crop leaves (zooms.json box).
    const ly = d.ly, c = shownCrops.get(ly.ref) || ly.crop, reg = ly.region || cropRegion(null);
    const fx = (px) => { let u = (px - ly.box.x) / ly.box.w; if (ly.mirror) u = 1 - u; return c.x + Math.min(1, Math.max(0, u)) * c.w; };
    const fy = (py) => c.y + Math.min(1, Math.max(0, (py - ly.box.y) / ly.box.h)) * c.h;
    const x0 = Math.min(fx(r.x), fx(r.x + r.w)), x1 = Math.max(fx(r.x), fx(r.x + r.w)), y0 = fy(r.y), y1 = fy(r.y + r.h);
    const k4 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4;
    const box = { x: k4((x0 - reg.x) / reg.w), y: k4((y0 - reg.y) / reg.h), w: k4((x1 - x0) / reg.w), h: k4((y1 - y0) / reg.h) };
    const target = ly.role === 'cam' ? 'camera' : 'screen', edit = zoomDraw?.edit;
    endZoomDraw();
    const res = edit ? await zoomsC.set(edit, { target, box, amount: null }, { quiet: false, label: 'Zoom area' }) : await zoomsC.add({ target, t: Math.round(master.currentTime * 1000) / 1000, box });
    if (res?.id) zoomsC.select(res.id);
  }
  function drawZoomBox(g) {
    const px = scene.W / Math.max(1, stage.clientWidth), mark = markColor || tokens()('--sel', '#2563eb');
    g.save();
    if (zdrag) {
      const { a, b } = zdrag, r = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath(); g.rect(0, 0, scene.W, scene.H); g.rect(r.x, r.y, r.w, r.h); g.fill('evenodd');
      g.strokeStyle = mark; g.lineWidth = 2 * px; g.setLineDash([6 * px, 4 * px]); g.strokeRect(r.x, r.y, r.w, r.h);
    }
    // what to do, in a tag like the selection's
    const text = zdrag ? `Zoom into this part of the ${zdrag.ly.role === 'cam' ? 'camera' : 'screen'}` : zoomDraw.edit ? 'Drag the new area for this zoom · Esc stops' : 'Drag a box on the screen or the camera to zoom into it · Esc stops';
    const fs = 12 * px, ph = 22 * px, pad = 8 * px;
    g.font = `500 ${fs}px ${getComputedStyle(document.documentElement).getPropertyValue('--font')}`;
    const w = g.measureText(text).width + 2 * pad, x = zdrag ? Math.max(2 * px, Math.min(scene.W - w - 2 * px, Math.min(zdrag.a.x, zdrag.b.x))) : (scene.W - w) / 2;
    const y = zdrag ? Math.max(2 * px, Math.min(zdrag.a.y, zdrag.b.y) - ph - 6 * px) : scene.H - ph - 18 * px;
    g.fillStyle = mark; g.beginPath(); g.roundRect(x, y, w, ph, 6 * px); g.fill();
    g.fillStyle = tokens()('--sel-ink', '#fff'); g.textBaseline = 'middle'; g.fillText(text, x + pad, y + ph / 2 + 0.5 * px);
    g.restore();
  }

  // ---- the zoom inspector: the zoom picked on the Zooms lane ----
  function renderZoomSec() {
    if (!ins) return;
    const sec = $('#zoomSec', ins), zid = zoomsC?.selected(), L = zoomsC?.list() || [], z = zid ? L.find((x) => x.id === zid) : null;
    if (!sec) return;
    sec.hidden = !z;
    if (!z) return;
    const ct = (v) => clock(cmap().toCut(v));
    $('#zmTitle', ins).textContent = `Zoom ${L.indexOf(z) + 1}${z.name ? ` · ${z.name}` : ''}`;
    $('#zmSub', ins).textContent = `${ct(z.a)}–${ct(z.d)} · ${z.status === 'proposed' ? 'Claude’s proposal: not in the export until you keep it' : z.by === 'claude' ? 'by Claude' : 'yours'}`;
    $('#zmProp', ins).hidden = z.status !== 'proposed';
    sec.querySelectorAll('#zmTarget button').forEach((b) => { const on = b.dataset.v === z.target; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.disabled = !dims()[b.dataset.v === 'camera' ? 'cam' : 'screen']; });
    sec.querySelectorAll('#zmSpeed button').forEach((b) => { const on = b.dataset.v === (z.speed || 'smooth'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    $('#zmAreaT', ins).textContent = z.box ? `${Math.round(z.box.w * 100)}% of the ${z.target === 'camera' ? 'camera' : 'screen'}` : `${(z.amount || 1.1).toFixed(2)}× closer`;
    $('#zmAmountRow', ins).hidden = Boolean(z.box);
    const am = $('#zmAmount', ins);
    if (document.activeElement !== am) am.value = z.amount || 1.1;
    $('#zmAmountVal', ins).textContent = `${Number(am.value).toFixed(2)}×`;
    for (const [k, v] of [['zmA', cmap().toCut(z.a)], ['zmD', cmap().toCut(z.d)], ['zmIn', z.speed === 'snap' ? 0.1 : z.b - z.a], ['zmOut', z.speed === 'snap' ? 0.1 : z.d - z.c]]) {
      const el = $(`#${k}`, ins);
      if (document.activeElement !== el) el.value = (Math.round(v * 100) / 100).toFixed(k === 'zmA' || k === 'zmD' ? 1 : 2);
    }
    $('#zmIn', ins).disabled = $('#zmOut', ins).disabled = z.speed === 'snap';
  }
  function wireZoomSec() {
    const sec = $('#zoomSec', ins), zid = () => zoomsC?.selected();
    if (!sec || !zoomsC) return;
    const set = (patch) => { const id = zid(); if (id) zoomsC.set(id, patch); };
    sec.querySelectorAll('#zmTarget button').forEach((b) => (b.onclick = () => set({ target: b.dataset.v })));
    sec.querySelectorAll('#zmSpeed button').forEach((b) => (b.onclick = () => set({ speed: b.dataset.v })));
    $('#zmArea', ins).onclick = () => { const id = zid(); if (id) startZoomDraw(id); };
    const am = $('#zmAmount', ins);
    am.oninput = () => { $('#zmAmountVal', ins).textContent = `${Number(am.value).toFixed(2)}×`; };
    am.onchange = () => set({ amount: Number(am.value) });
    for (const k of ['zmIn', 'zmOut']) $(`#${k}`, ins).onchange = (e) => { const v = Number(e.target.value); if (Number.isFinite(v)) set(k === 'zmIn' ? { in: v } : { out: v }); };
    for (const k of ['zmA', 'zmD']) $(`#${k}`, ins).onchange = (e) => {
      const v = Number(e.target.value), id = zid();
      if (!Number.isFinite(v) || !id) return;
      zoomsC.trim(id, k === 'zmA' ? { a: Math.round(cmap().toSource(v) * 1000) / 1000 } : { d: Math.round(cmap().toSource(v) * 1000) / 1000 });
    };
    for (const el of sec.querySelectorAll('input')) el.onkeydown = (e) => { if (e.key === 'Enter') el.blur(); };
    $('#zmKeep', ins).onclick = () => { const id = zid(); if (id) zoomsC.keep([id]); };
    $('#zmNo', ins).onclick = () => { const id = zid(); if (id) zoomsC.reject([id]); };
    $('#zmDel', ins).onclick = () => zoomsC.removeSel();
  }

  // The selection's name and what a drag does, in a small tag above its top-left corner (inside when there's no room).
  function selLabel(g, it, mark, px, say = null) {
    const layer = layerOf(it.ref), name = it.ref === 'cam' ? 'Camera' : layer ? `Layer ${layout.layers.indexOf(layer) + 1} · ${layer.kind === 'cam' ? 'camera' : 'screen'}` : 'Screen';
    const what = say ?? (reframe ? 'drag the picture to reframe' : it.movable ? 'drag to move' : pannable(it) ? 'drag to reframe' : insetable(it) ? 'drag a corner to inset' : '');
    const text = what ? `${name} · ${what}` : name;
    const fs = 11 * px, ph = 20 * px, pad = 7 * px, r = cropping && cropView ? cropKept() : it.box;
    g.save();
    g.font = `500 ${fs}px ${getComputedStyle(document.documentElement).getPropertyValue('--font')}`;
    const w = g.measureText(text).width + 2 * pad;
    let x = r.x - 2 * px, y = r.y - ph - 6 * px;
    if (y < 2 * px) { x = r.x + 6 * px; y = r.y + 6 * px; }
    x = Math.max(2 * px, Math.min(scene.W - w - 2 * px, x));
    g.fillStyle = mark; g.beginPath(); g.roundRect(x, y, w, ph, 5 * px); g.fill();
    g.fillStyle = tokens()('--sel-ink', '#fff'); // ink on the look's selection colour
    g.textBaseline = 'middle'; g.fillText(text, x + pad, y + ph / 2 + 0.5 * px);
    g.restore();
  }
  const corners = (r) => [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];

  // Pointer: a PiP box or layer moves (corner resizes); a cropped camera pans its picture (so does any
  // box while Reframe is on); the wheel zooms the camera under the pointer. Clicks select.
  const pt = (e) => { const b = stage.getBoundingClientRect(); return { x: ((e.clientX - b.left) / b.width) * scene.W, y: ((e.clientY - b.top) / b.height) * scene.H }; };
  const inBox = (p, r, pad = 0) => p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
  const grip = () => scene.u * 3;
  // Which corner handle is under the pointer: 'tl' | 'tr' | 'bl' | 'br' (the opposite corner stays put when it resizes).
  const cornerAt = (p, r) => {
    const g = Math.max(scene.u * 1.4, 12 * (scene.W / Math.max(1, stage.clientWidth)));
    const i = corners(r).findIndex(([cx, cy]) => Math.abs(p.x - cx) <= g && Math.abs(p.y - cy) <= g);
    return i < 0 ? null : ['tl', 'tr', 'bl', 'br'][i];
  };
  // Topmost camera, screen or layer under the pointer (in the picture as it shows now).
  const vItemOf = (ref) => (vscene || scene)?.layers.find((ly) => ly.ref === ref) || null;
  const hit = (p) => [...(vscene || scene).layers].reverse().find((ly) => ly.framed && inBox(p, ly.box, ly.movable || insetable(ly) ? grip() / 3 : 0)) || null;
  const regionOf = (it) => it.region || { x: 0, y: 0, w: 1, h: 1 };
  // There's somewhere to pan to: the box shows less than the crop leaves (zoomed in, or filled by a wider picture).
  const pannable = (it) => { const r = regionOf(it); return it.framed && (it.crop.w < r.w - 0.001 || it.crop.h < r.h - 0.001); };
  // The screen in PiP: its corners set the inset (the layout gives its box no other size or place).
  const insetable = (it) => it?.role === 'screen' && scene.preset === 'pip';
  // A focus kept where the crop window can actually be (inside what the crop leaves).
  const clampFocus = (it, x, y) => {
    const r = regionOf(it);
    return { x: Math.min(r.x + r.w - it.crop.w / 2, Math.max(r.x + it.crop.w / 2, x)), y: Math.min(r.y + r.h - it.crop.h / 2, Math.max(r.y + it.crop.h / 2, y)) };
  };

  function down(e) {
    const p = pt(e);
    if (zoomDraw) { zoomDown(e, p); return; }
    if (noteMode) { notePopover(e, p); return; }
    if (cropping && cropView) { cropDown(e, p); return; }
    const pinHit = pinAt(p);
    if (pinHit) { hooks.openScene?.(pinHit.scene); return; }
    const it = hit(p);
    // A click on empty canvas drops the selection (and Reframe), so the picture shows without edit marks.
    if (!it) { reframe = false; selected = null; renderFrameBar(); return; }
    if (selected !== it.ref) { selected = it.ref; reframe = false; renderFrameBar(); }
    stage.setPointerCapture(e.pointerId);
    const c = !reframe && (it.movable || insetable(it)) ? cornerAt(p, it.box) : null;
    if (it.movable && !reframe) {
      drag = { mode: c ? 'size' : 'move', corner: c, start: p, r: { ...it.box }, ref: it.ref };
    } else if (c && insetable(it)) {
      drag = { mode: 'inset', corner: c, start: p, ref: it.ref };
    } else if (pannable(it)) {
      drag = { mode: 'pan', start: p, ref: it.ref, cx: it.crop.x + it.crop.w / 2, cy: it.crop.y + it.crop.h / 2, it };
    }
  }
  function move(e) {
    const p = pt(e);
    if (zoomDraw) { stage.style.cursor = 'crosshair'; zoomMove(p); return; }
    if (noteMode) { stage.style.cursor = 'crosshair'; return; }
    if (cropping && cropView) { cropMove(p); return; }
    if (!drag && pinAt(p)) { stage.style.cursor = 'pointer'; return; }
    if (!drag) {
      const it = hit(p);
      hover = it?.ref || null;
      const sizes = it && (it.movable || insetable(it)) && !(reframe && it.ref === selected);
      const c = sizes ? cornerAt(p, it.box) : null;
      stage.style.cursor = !it ? 'default' : c ? (c === 'tl' || c === 'br' ? 'nwse-resize' : 'nesw-resize') : it.movable && !(reframe && it.ref === selected) ? 'grab' : pannable(it) ? 'move' : 'default';
      return;
    }
    const { W, H } = scene;
    if (drag.mode === 'pan') {
      const { it } = drag, f = frameOf(drag.ref), k = it.mirror ? 1 : -1;
      f.focus = clampFocus(it, drag.cx + k * ((p.x - drag.start.x) / it.box.w) * it.crop.w, drag.cy - ((p.y - drag.start.y) / it.box.h) * it.crop.h);
    } else if (drag.mode === 'inset') {
      // The corner follows the pointer along the side where the screen touches its inset area.
      const it = itemOf('screen');
      if (!it) return;
      const padPx = (layout.pad || 0) * scene.u, areaAR = (W - 2 * padPx) / Math.max(1, H - 2 * padPx);
      const byX = it.box.w / it.box.h >= areaAR;
      const dist = byX ? Math.min(p.x, W - p.x) : Math.min(p.y, H - p.y);
      layout.pad = Math.round(Math.min(10, Math.max(0, dist / scene.u)) * 2) / 2;
    } else {
      const pos = posOf(drag.ref);
      if (drag.mode === 'move') {
        pos.x = Math.min(1 - drag.r.w / W, Math.max(0, (drag.r.x + p.x - drag.start.x) / W));
        pos.y = Math.min(1 - drag.r.h / H, Math.max(0, (drag.r.y + p.y - drag.start.y) / H));
      } else {
        // Resize from a corner: the box keeps its shape and the opposite corner stays where it is.
        const c = drag.corner || 'br', ar = drag.r.w / drag.r.h;
        const dx = (p.x - drag.start.x) * (c[1] === 'l' ? -1 : 1), dy = (p.y - drag.start.y) * (c[0] === 't' ? -1 : 1) * ar;
        const w = Math.min(0.95 * W, Math.max(0.06 * W, drag.r.w + (Math.abs(dx) > Math.abs(dy) ? dx : dy)));
        pos.w = w / W;
        if (c[1] === 'l') pos.x = Math.max(0, (drag.r.x + drag.r.w - w) / W);
        if (c[0] === 't') pos.y = Math.max(0, (drag.r.y + drag.r.h - w / ar) / H);
      }
    }
    setLayout(layout, false);
  }
  function up() { if (zoomDraw) { zoomUp(); return; } if (drag) { drag = null; saveLayout(); renderBar(); } }
  function dbl(e) {
    if (cropping) return;
    const it = hit(pt(e));
    if (it?.movable) { selected = it.ref; reframe = !reframe; renderFrameBar(); } else toggle();
  }
  let wheelSave = 0;
  function wheel(e) {
    if (cropping) return;
    const it = hit(pt(e));
    // The screen fills most of the picture, so the wheel only zooms it once it's selected (the picture can scroll).
    if (!it || (!it.movable && it.ref !== selected)) return;
    e.preventDefault();
    const f = frameOf(it.ref);
    if (selected !== it.ref) { selected = it.ref; reframe = false; renderFrameBar(); }
    f.zoom = Math.min(4, Math.max(1, f.zoom * Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.0025)));
    setLayout(layout, false);
    clearTimeout(wheelSave); wheelSave = setTimeout(saveLayout, 400);
  }

  // ---- Crop mode: the selected picture whole and fixed in place (cropView), the part the crop cuts off faint, handles
  // on every edge and corner of what it keeps; dragging inside moves the crop. The layout itself changes as you drag
  // (the box takes the shape of what's left) and shows when the crop is done: Enter, Esc, Done or a click outside.
  // The screen is cropped where it sits (its box with no crop: the whole recording fits it); a camera or layer is
  // cropped in the middle of the frame, since its box shows only part of it.
  function startCrop() {
    const it = itemOf(selected), f = frameOf(selected), d = srcDims(selected);
    if (!it || !f || !d) return;
    reframe = false;
    const ar = d[0] / d[1], { W, H, u } = scene;
    const m = 2.5 * u, frame = { x: m, y: m, w: W - 2 * m, h: H - 2 * m };
    let area = frame;
    if (selected === 'screen') {
      const whole = compose({ ...layout, screen: { ...layout.screen, crop: { ...NO_CROP }, zoom: 1 } }, dims()).layers.find((x) => x.ref === 'screen')?.box;
      if (whole) {
        const x0 = Math.max(whole.x, frame.x), y0 = Math.max(whole.y, frame.y);
        area = { x: x0, y: y0, w: Math.min(whole.x + whole.w, frame.x + frame.w) - x0, h: Math.min(whole.y + whole.h, frame.y + frame.h) - y0 };
      }
    }
    const w = Math.min(area.w, area.h * ar), h = w / ar;
    cropView = { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h, mirror: Boolean(it.mirror), ref: selected };
    cropping = true;
    master?.pause();
    renderFrameBar();
  }
  function endCrop() {
    if (!cropping) return;
    cropping = false; cropView = null; drag = null;
    stage.style.cursor = 'default';
    setLayout(layout); // saves
  }
  // The crop in what you see: the left/right edges swap on a mirrored picture.
  const visCrop = (c) => (cropView.mirror ? { t: c.t, b: c.b, l: c.r, r: c.l } : { ...c });
  const srcCrop = (v) => (cropView.mirror ? { t: v.t, b: v.b, l: v.r, r: v.l } : { ...v });
  function cropKept() {
    const v = visCrop(frameOf(cropView.ref)?.crop || NO_CROP), V = cropView;
    return { x: V.x + v.l * V.w, y: V.y + v.t * V.h, w: V.w * (1 - v.l - v.r), h: V.h * (1 - v.t - v.b) };
  }
  // Which handle is under the pointer: two letters for a corner ('tl'…), one for an edge, 'in' inside, null outside.
  function cropHandle(p) {
    const k = cropKept(), g = Math.max(scene.u * 1.2, 12 * (scene.W / Math.max(1, stage.clientWidth)));
    const nearX = (x) => Math.abs(p.x - x) <= g, nearY = (y) => Math.abs(p.y - y) <= g;
    const inX = p.x >= k.x - g && p.x <= k.x + k.w + g, inY = p.y >= k.y - g && p.y <= k.y + k.h + g;
    const v = nearY(k.y) ? 't' : nearY(k.y + k.h) ? 'b' : '', hz = nearX(k.x) ? 'l' : nearX(k.x + k.w) ? 'r' : '';
    if (v && hz) return v + hz;
    if (v && inX) return v;
    if (hz && inY) return hz;
    return inBox(p, k) ? 'in' : null;
  }
  const CROP_CURSOR = { t: 'ns-resize', b: 'ns-resize', l: 'ew-resize', r: 'ew-resize', tl: 'nwse-resize', br: 'nwse-resize', tr: 'nesw-resize', bl: 'nesw-resize', in: 'move' };
  function cropDown(e, p) {
    const hnd = cropHandle(p);
    // A click away from the picture being cropped finishes, like Done.
    if (!hnd) { if (!inBox(p, cropView, scene.u)) endCrop(); return; }
    stage.setPointerCapture(e.pointerId);
    drag = { mode: 'crop', hnd, start: p, v: visCrop(frameOf(cropView.ref).crop) };
  }
  function cropMove(p) {
    if (drag?.mode !== 'crop') { stage.style.cursor = CROP_CURSOR[cropHandle(p)] || 'default'; return; }
    const V = cropView, s0 = drag.v, keep = MIN_KEEP, cl = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
    const fx = (p.x - V.x) / V.w, fy = (p.y - V.y) / V.h;
    const v = { ...s0 };
    if (drag.hnd === 'in') {
      const dx = (p.x - drag.start.x) / V.w, dy = (p.y - drag.start.y) / V.h;
      const mx = cl(dx, -s0.l, s0.r), my = cl(dy, -s0.t, s0.b);
      Object.assign(v, { l: s0.l + mx, r: s0.r - mx, t: s0.t + my, b: s0.b - my });
    } else {
      if (drag.hnd.includes('t')) v.t = cl(fy, 0, 1 - keep - s0.b);
      if (drag.hnd.includes('b')) v.b = cl(1 - fy, 0, 1 - keep - s0.t);
      if (drag.hnd.includes('l')) v.l = cl(fx, 0, 1 - keep - s0.r);
      if (drag.hnd.includes('r')) v.r = cl(1 - fx, 0, 1 - keep - s0.l);
    }
    frameOf(V.ref).crop = normCrop(srcCrop(v));
    setLayout(layout, false);
  }
  function drawCrop(g, mark, px) {
    const V = cropView, it = itemOf(V.ref), v = it && videoOf(it), k = cropKept();
    g.save();
    g.fillStyle = 'rgba(10,10,12,0.55)'; g.fillRect(0, 0, scene.W, scene.H); // everything else steps back
    const pic = (alpha) => {
      if (!v?.videoWidth) return;
      g.save(); g.globalAlpha = alpha;
      if (V.mirror) { g.translate(V.x + V.w, V.y); g.scale(-1, 1); g.drawImage(v, 0, 0, V.w, V.h); } else g.drawImage(v, V.x, V.y, V.w, V.h);
      g.restore();
    };
    pic(0.32); // the part the crop cuts off, faint
    g.save(); g.beginPath(); g.rect(k.x, k.y, k.w, k.h); g.clip(); pic(1); g.restore();
    g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = px; g.setLineDash([5 * px, 4 * px]);
    g.strokeRect(V.x, V.y, V.w, V.h); g.setLineDash([]);
    // Thirds inside what's kept, its outline and the eight handles.
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = px;
    g.beginPath();
    for (const f of [1 / 3, 2 / 3]) { g.moveTo(k.x + k.w * f, k.y); g.lineTo(k.x + k.w * f, k.y + k.h); g.moveTo(k.x, k.y + k.h * f); g.lineTo(k.x + k.w, k.y + k.h * f); }
    g.stroke();
    g.strokeStyle = mark; g.lineWidth = 2 * px; g.strokeRect(k.x, k.y, k.w, k.h);
    const hs = 10 * px, bar = 22 * px;
    g.fillStyle = '#fff'; g.strokeStyle = mark; g.lineWidth = 2 * px;
    for (const [cx, cy] of corners(k)) { g.beginPath(); g.roundRect(cx - hs / 2, cy - hs / 2, hs, hs, 2 * px); g.fill(); g.stroke(); }
    for (const [cx, cy, w, h] of [[k.x + k.w / 2, k.y, bar, hs * 0.6], [k.x + k.w / 2, k.y + k.h, bar, hs * 0.6], [k.x, k.y + k.h / 2, hs * 0.6, bar], [k.x + k.w, k.y + k.h / 2, hs * 0.6, bar]]) {
      g.beginPath(); g.roundRect(cx - w / 2, cy - h / 2, w, h, 2 * px); g.fill(); g.stroke();
    }
    g.restore();
    if (it) selLabel(g, it, mark, px, 'crop · drag the edges · Enter when done');
  }
  // In a shot, saving is the shot's look (and the video's when the frame shape, background or layers changed).
  const saveLayout = () => (scopeNow() === 'shot' && editId ? flushShot() : api(`/api/projects/${encodeURIComponent(id)}/layout`, { layout: base }).catch(() => {}));

  // The PNG layers for the export: the same bitmaps the canvas draws with (masks as white on black).
  // pngsFor does the same for another layout or other videos: pngs.blocks has a set for every block with its own
  // file or layout (M3b), so the export can render each part of the video in the same canvas look.
  const exportLayers = () => { const b = baseSS(); return { ...pngsOf(b.scene, b.stills), blocks: hooks.blocks?.exportPngs(pngsFor, base) || {} }; };
  const pngsFor = (l, d) => { const sc = compose(l, d); return pngsOf(sc, buildStills(sc, bgP)); };
  const layerPngs = () => { const b = baseSS(); return { ...pngsOf(b.scene, b.stills), ...splitStills(b.scene, bgP),
    blocks: hooks.blocks?.exportPngs((l, d) => { const sc = compose(l, d), st = buildStills(sc, bgP); return { ...pngsOf(sc, st), ...splitStills(sc, bgP) }; }, base) || {} }; };
  function pngsOf(scene, stills) {
    const pngs = { base: stills.base.toDataURL('image/png') };
    scene.layers.forEach((ly, i) => {
      const m = mkCanvas(ly.box.w, ly.box.h), g = m.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, m.width, m.height); g.drawImage(stills.masks[i], 0, 0);
      pngs[`mask${i}`] = m.toDataURL('image/png');
      if (stills.mids[i]) pngs[`mid${i}`] = stills.mids[i].toDataURL('image/png');
    });
    return pngs;
  }
  // Shots (web/exportshots.js): one set per look the kept shots give the take, keyed by what the PNGs depend on
  // (sceneKey: shots that only reframe share one), so the export renders each shot in its look. base = the video's own
  // layout (canvas.layout()); split: also each card's shadow and border on their own (the Layers export). No shot with
  // a look of its own: {} (the export runs as it always did).
  function lookPngs(base, split = false) {
    const out = {}, d = dims(), looks = exportLooks(normalize(base, getP().type), getP().shots);
    if (looks.length < 2) return out;
    for (const l of looks) {
      const sc = compose(l, d), k = sceneKey(sc);
      if (!out[k]) { const st = buildStills(sc, bgP); out[k] = split ? { ...pngsOf(sc, st), ...splitStills(sc, bgP) } : pngsOf(sc, st); }
    }
    return out;
  }

  async function showImport() {
    teardownMedia(); mediaSig = '';
    const takes = await api('/api/takes');
    const box = h(`<div class="blank"><h3>Add your recording</h3><div>Press <b>Record</b> to pick your screen, camera and mic and record a take (it lands here when you stop), or pick an earlier take. Video Octopus copies it into this project.</div>
      <div style="margin-top:12px"><button class="btn small rec" id="recHere"><span class="rec-dot"></span>Record a take</button></div><div class="takes-list"></div></div>`);
    $('#recHere', box).onclick = () => document.getElementById('recBtn')?.click();
    emptyInspector('Add a recording to set its layout.');
    const list = $('.takes-list', box);
    if (!takes.length) list.append(h(`<div class="sub">No recordings found in your recorder folder yet.</div>`));
    for (const t of takes.slice(0, 6)) {
      const row = h(`<div class="take"><div class="t"><div>${esc(takeLabel(t.id))}</div><div class="sub">${t.files.length} file${t.files.length > 1 ? 's' : ''} · ${gb(t.bytes)}</div></div><button class="btn small primary">Use this take</button></div>`);
      $('button', row).onclick = async (e) => {
        e.target.disabled = true;
        try { await api(`/api/projects/${encodeURIComponent(id)}/import`, { take: t.id }); toast('Imported. Preparing playback…'); }
        catch (err) { toast(err.message); e.target.disabled = false; }
      };
      list.append(row);
    }
    pane.replaceChildren(box);
  }

  function teardownMedia() {
    cancelAnimationFrame(raf);
    stageFx?.destroy(); stageFx = null;
    for (const v of videos.values()) { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); }
    videos = new Map();
    master = null; aoWave = null; aoPeaks = null;
    tl?.destroy(); tl = null; tlKey = '';
    stageRO?.disconnect(); stageRO = null; chipKey = '';
    bgP?.dispose?.(); bgP = null; bgKey = ''; bgSec = null;
    wrap = stage = scene = stills = ins = null;
  }

  document.addEventListener('keydown', onKey);
  function onKey(e) {
    if (/TEXTAREA|INPUT|SELECT/.test(document.activeElement.tagName) || paused || !master || !$('#modal').hidden) return;
    // Crop mode: Enter or Esc finishes (keeping the crop). preventDefault keeps Enter from also pressing a focused button.
    if (cropping && (e.key === 'Enter' || e.key === 'Escape')) { e.preventDefault(); endCrop(); return; }
    // Z: zoom into an area (drag a box on the picture); Esc stops.
    if (zoomDraw && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endZoomDraw(); return; }
    if ((e.key === 'z' || e.key === 'Z') && !e.metaKey && !e.ctrlKey && !e.altKey && zoomsC) { e.preventDefault(); if (zoomDraw) endZoomDraw(); else startZoomDraw(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey && canvasDelete()) { e.preventDefault(); hideSelected(); return; }
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    if (e.key === 'Escape' && reframe) { reframe = false; renderFrameBar(); }
    // Reframe: arrow keys move the picture inside the box (Shift: bigger steps).
    if (reframe && /^Arrow/.test(e.key)) {
      const it = itemOf(selected), f = frameOf(selected);
      if (!it || !f) return;
      e.preventDefault();
      const k = e.shiftKey ? 0.02 : 0.004, dx = { ArrowLeft: -1, ArrowRight: 1 }[e.key] || 0, dy = { ArrowUp: -1, ArrowDown: 1 }[e.key] || 0;
      f.focus = clampFocus(it, f.focus.x + (it.mirror ? 1 : -1) * dx * k, f.focus.y - dy * k);
      setLayout(layout, false);
      clearTimeout(wheelSave); wheelSave = setTimeout(saveLayout, 400);
    }
    if (e.key === 'Escape' && noteMode) setNoteMode(false);
  }

  // ---- notes pinned on the canvas: numbered pins near their moment; Note mode adds one where you click ----
  function pinsNow() {
    if (!sceneData || !master) return [];
    const t = master.currentTime, M = cmap();
    return sceneData.notes.filter((n) => n.pos && n.t != null && n.status !== 'resolved' && Math.abs(M.toSource(n.t) - t) < 1.2);
  }
  function pinAt(p) {
    const r = scene.u * 2;
    return pinsNow().find((n) => Math.hypot(n.pos.x * scene.W - p.x, n.pos.y * scene.H - p.y) < r) || null;
  }
  function drawPins(g) {
    const list = pinsNow();
    if (!list.length) return;
    const cs = getComputedStyle(document.documentElement), tok = tokens(), r = scene.u * 1.5;
    for (const n of list) {
      const x = n.pos.x * scene.W, y = n.pos.y * scene.H;
      g.save();
      g.fillStyle = n.status === 'open' ? tok('--accent', '#c2410c') : n.status === 'sent' ? tok('--warn', '#d97706') : '#1a1a1c';
      g.strokeStyle = '#fff'; g.lineWidth = scene.u * 0.25;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = '#fff'; g.font = `600 ${Math.round(r * 1.1)}px ${cs.getPropertyValue('--font')}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(sceneData.notes.filter((x) => x.scene === n.scene).indexOf(n) + 1), x, y + r * 0.05);
      g.restore();
    }
  }
  function setNoteMode(on) {
    noteMode = on;
    const b = wrap && $('#noteMode', wrap);
    if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
    if (stage) stage.style.cursor = on ? 'crosshair' : 'default';
    if (!on) closePop();
  }
  const closePop = () => { pop?.remove(); pop = null; };
  function notePopover(e, p) {
    closePop();
    master?.pause();
    const t = master.currentTime, tc = cmap().toCut(t);
    const sc = sceneData.scenes.find((x) => tc >= x.start && tc < x.end) || sceneData.scenes.at(-1);
    const host = $('.canvas-wrap', wrap), hb = host.getBoundingClientRect();
    pop = h(`<div class="pin-pop" role="dialog" aria-label="New note">
      <div class="sub">Note at ${clock(tc)}${sc ? ` · scene ${sc.n} · ${esc(sc.title)}` : ''}</div>
      <textarea rows="3" placeholder="What should change here?"></textarea>
      <div class="pp-row"><button class="btn ghost small" data-a="x">Cancel</button><button class="btn dark small" data-a="add">Add note</button></div></div>`);
    pop.style.left = `${Math.min(hb.width - 280, Math.max(8, e.clientX - hb.left + 12))}px`;
    pop.style.top = `${Math.min(hb.height - 150, Math.max(8, e.clientY - hb.top + 12))}px`;
    host.append(pop);
    const ta = $('textarea', pop);
    const add = async () => {
      const text = ta.value.trim();
      if (!text) return ta.focus();
      try {
        await api(`/api/projects/${encodeURIComponent(id)}/notes`, { op: 'add', text, t: tc, scene: sc?.id, on: 'canvas', pos: { x: p.x / scene.W, y: p.y / scene.H } });
        toast(`Note added to scene ${sc?.n ?? ''}. Send it to Claude from the Scenes tab or the rail.`);
        setNoteMode(false);
      } catch (err) { toast(err.message); }
    };
    $('[data-a=add]', pop).onclick = add;
    $('[data-a=x]', pop).onclick = () => setNoteMode(false);
    ta.onkeydown = (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); add(); } if (ev.key === 'Escape') setNoteMode(false); };
    setTimeout(() => ta.focus(), 0);
  }

  return {
    setAspect: (a) => { if (base) setAspect(a); },
    setScenes: (d) => { sceneData = d; const b = wrap && $('#noteMode', wrap); if (b) b.hidden = !d; if (!d) setNoteMode(false); chipKey = ''; if (ins) renderLayers(); },
    update, showImport, exportLayers, pngsFor, layerPngs, lookPngs,
    seek: (t) => { if (master) seek(t); }, time: () => master?.currentTime || 0,
    ready: () => Boolean(scene && stills && (scene.layers.length || (scene.preset === 'audio' && master))),
    hasTake: () => Boolean(getP().canvas.screen || getP().canvas.cam || getP().canvas.audio),
    // The video's own look (the export and the other export kinds send it; shots are on top of it).
    layout: () => base, scene: () => baseSS().scene, media: () => master,
    scope: () => scopeNow(), editing: () => (scopeNow() === 'shot' ? editId : null),
    // Claude's proposals: Show me (the chat), and what the picture plays (kept shots and zooms, plus the one looked at).
    // (before the take's videos are ready, Show me waits for them)
    showProposal: (kind, pid) => { if (master?.readyState >= 1) showProposal(kind, pid); else pendingShow = { kind, pid }; }, peeking: () => ({ shot: peekShot, zoom: zoomsC?.selected() || null }),
    zoomDrawing: () => Boolean(zoomDraw), startZoomDraw: () => startZoomDraw(),
    pause: () => { paused = true; master?.pause(); },
    resume: () => { paused = false; },
    destroy: () => { teardownMedia(); document.removeEventListener('keydown', onKey); document.removeEventListener('click', closeMenus); },
  };
}

// ---------- Record: a setup panel (devices, live preview, where the take goes), a countdown, then the take is
// recorded right here in the browser (web/recorder.js) and Video Octopus saves it into this project.
function makeRecordButton(root, id, getP) {
  const btn = $('#recBtn', root), text = $('#recText', root);
  let timer = 0;
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  // The recorder's session (it outlives this page: a take keeps recording while you open another project).
  function render() {
    clearInterval(timer);
    btn.classList.remove('live');
    btn.disabled = false;
    const S = rec.session(), here = !S.project || S.project === id;
    if (S.phase === 'starting') { text.textContent = 'Starting…'; btn.disabled = true; return; }
    if (S.phase === 'recording') {
      btn.classList.add('live');
      const tick = () => { text.textContent = `Stop ${mmss(Math.max(0, (Date.now() - S.startedAt) / 1000))}`; };
      tick(); timer = setInterval(tick, 500);
      btn.title = here ? `Stop recording (or press ${HOTKEY}). The take lands in this project.` : `Recording for another project. Stop it here or with ${HOTKEY}.`;
      return;
    }
    if (S.phase === 'stopping') { text.textContent = 'Finishing…'; btn.disabled = true; btn.title = 'Sending the last seconds to Video Octopus.'; return; }
    if (S.phase === 'saving') { text.textContent = `Saving take… ${Math.round((S.progress || 0) * 100)}%`; btn.disabled = true; btn.title = here ? 'Video Octopus is making the take files; it lands in this project.' : 'Saving a take for another project.'; return; }
    text.textContent = 'Record';
    btn.title = `Pick your screen, camera and mic and record a take, right here in the browser. Stop here or with ${HOTKEY}; the take lands in this project.`;
  }
  const unsub = rec.onSession(render);
  // ⌥⌘R (Ctrl+Alt+R on Windows) while Video Octopus has focus: open the panel, start from it, or stop.
  const onKey = (e) => {
    if (!rec.isHotkey(e)) return;
    e.preventDefault();
    const S = rec.session();
    if (S.phase === 'recording') rec.stop();
    else if (rec.panelIsOpen()) rec.startFromPanel();
    else if (S.phase === 'idle' && !btn.disabled) open();
  };
  document.addEventListener('keydown', onKey);
  btn.onclick = () => open();
  // opts.target 'block:<id>' (+ label): Record setup aimed at a block; the take becomes that block's file.
  async function open(opts = {}) {
    const S = rec.session();
    if (S.phase === 'recording') return rec.stop();
    if (S.phase !== 'idle') return;
    btn.disabled = true; text.textContent = 'Opening…';
    const P = getP();
    try { await rec.recordPanel({ id, P, choices: P.recorder, opts, settingsLink: '#/settings/recorder' }); }
    finally { render(); }
  }
  render();
  return { open, destroy: () => { clearInterval(timer); unsub(); document.removeEventListener('keydown', onKey); rec.closePanel(); } };
}

// ---------- Takes without a screen: camera only and mic only ----------
// A sound-only file: a mic-only take (<stamp>_audio.wav) or a dropped voiceover. It plays as it is (no playback copy).
function isSound(f) { return /\.(wav|m4a|mp3|aif|aiff|caf|flac)$/i.test(f || ''); }

// A mic-only take on the canvas: a note over the picture (not part of the export) with the take's waveform.
function audioOnlyNoteHTML() {
  return `<div class="ao-note" role="note"><span class="ao-ic" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 18 18"><rect x="6.5" y="2" width="5" height="9" rx="2.5"/><path d="M4 8.5a5 5 0 0 0 10 0M9 13.5V16"/></svg></span>
    <span class="ao-tx"><b>This take is audio only</b><small>A mic-only recording. The export shows this background with its sound.</small></span>
    <canvas class="ao-wave" aria-hidden="true"></canvas></div>`;
}
// Bars of the take's peaks (0–100 per 1/50 s, scaled to the loudest), the played part bright.
function drawSoundWave(cv, peaks, t, dur) {
  const d = devicePixelRatio || 1, w = Math.round(cv.clientWidth * d), hh = Math.round(cv.clientHeight * d);
  if (!w || !hh) return;
  if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; }
  const g = cv.getContext('2d'), data = peaks?.data || [], n = Math.max(1, Math.floor(w / (4 * d))), at = dur ? t / dur : 0;
  const top = (peaks && (peaks.top ??= data.reduce((m, v) => (v > m ? v : m), 1))) || 1; // long takes: no spread
  g.clearRect(0, 0, w, hh);
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i / n) * data.length), b = Math.max(a + 1, Math.floor(((i + 1) / n) * data.length));
    let m = 0;
    for (let k = a; k < b && k < data.length; k++) m = Math.max(m, data[k]);
    const bh = Math.max(2 * d, (m / top) * hh);
    g.fillStyle = (i + 0.5) / n <= at ? '#fff' : 'rgba(255, 255, 255, 0.32)';
    g.fillRect((i * w) / n, (hh - bh) / 2, Math.max(1, w / n - d), bh);
  }
}

// The toast when a take arrives, saying what kind of take it is.
function takeMessage(ev) {
  const files = ev.files || [], secs = ev.duration ? ` (${ev.duration.toFixed(1)} s)` : '';
  const micOnly = files.length > 0 && files.every(isSound);
  const camOnly = !micOnly && files.length > 0 && !files.some((f) => /_screen\./i.test(f)) && files.some((f) => /_webcam\./i.test(f));
  if (ev.block) return micOnly ? `Mic-only take added to the ${ev.blockLabel || 'new'} block${secs}: its sound plays over the background.`
    : `Take added to the ${ev.blockLabel || 'new'} block${secs}. Making a playback copy…`;
  if (micOnly) return `Mic-only take added${secs}. It plays over the layout's background; Clean up transcribes it.`;
  if (camOnly) return `Camera take added${ev.layer ? ' as a new layer' : ''}${secs}. Making a playback copy and framing the camera…`;
  return `Take added${ev.layer ? ' as a new layer' : ''}${secs}. Making playback copies and framing the camera…`;
}

// The look before anything else (the Settings page doesn't load the status itself).
api('/api/status').then((st) => { setSystem(st); applyLook(st.appearance); }).catch(() => {});
router();

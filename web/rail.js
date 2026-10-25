// Step rail v2, variant A, with the next step docked on the
// message box, and the stage bar as the editor's navigation (ADDENDUM-stage-bar.md, 24 Oct 2026).
// Every word comes from the steps themselves (core/pipelines.json: stage, name, what, where, show; the done line
// from the server), so the stages in the bar, a stage's list of steps, the dock strip and its sheet, the chat's done
// markers, the empty states and the first-time help all say the same thing.
// - Bar: Package · Record · Cut · Plan · Build · Polish · Publish (web/stages.js: Publish is the UI-only last stage, the
//   Renders and Post pane). Each stage is a tab: clicking it opens its workspace (hooks.goStage). The selected stage is
//   where you are (bold, underlined); a NEXT badge sits on the stage of the next step, RUNNING with a spinner on the stage
//   whose step Claude is working on; the two can differ. One segment per step (green done, accent next, dashed
//   optional), a tick when every step is done or skipped (Publish: once the video is exported or a render is marked final), and a dot for something new
//   there (hooks.marks). The ▾ beside a stage opens its steps (what each does, where it shows, Run / Skip / Undo skip /
//   Show me) without changing the pane; Alt+↓ or a long press on the stage opens it too. fit() folds the bar as it
//   narrows: segments, the project name, the ▾ buttons, then (and always at 760 px and below) one button with the
//   current stage that lists them all.
// - Dock: a slim strip on the top edge of the message box, "Next · <step> · ⓘ · ▶ Run"; ⓘ opens it upwards into the
//   step's words ("Step 3 of 9 · Cut", what it does, "You'll see it: …" with Show me where, the stage's checklist).
//   While a step runs it says so ("Clean up · Rough cut, 2 of 3") and the composer says "Claude is working on <step>".
// - Done: when a step goes from not done to done while the page is open, or since the page last looked (the server
//   keeps what it last saw), the strip turns green for about 4 s with the step's line and Show me, and the chat keeps a
//   one-line marker of it (the server writes it into the chat log).
// - Show me: opens the stage that owns the step, scrolls, and outlines the thing in the selection colour with
//   "New · from <step>".
// - Empty states for Scenes, Renders, Cut, Post (the Sections band draws its own, web/blocks.js), and the first-time
//   help (once, saved in settings as help.stepsIntro; the ? next to the stages opens it again).
import { $, h, esc, api, toast } from './ui.js';
import { stagesOf, stageSlug, STAGE_PANE, PANE_WORDS } from './stages.js';
import { pending, onAttention, stateOf, describe, openItems } from './attention.js';

const ICON = {
  tick: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2l2.4 2.4 4.6-5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true"><path d="M1 1l7 4-7 4z" fill="currentColor"/></svg>',
  eye: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1.5 7s2-4 5.5-4 5.5 4 5.5 4-2 4-5.5 4-5.5-4-5.5-4z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="7" cy="7" r="1.8" fill="currentColor"/></svg>',
  help: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6.3 6.3a1.8 1.8 0 1 1 2.5 1.6c-.5.3-.8.6-.8 1.2v.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.4" r=".8" fill="currentColor"/></svg>',
  caret: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 3.8L5 6.3l2.5-2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  x: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  stop: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" rx="1.2" fill="currentColor"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.2v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".9" fill="currentColor"/></svg>',
};
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
// Where Show me goes, in words, by its target.
const SHOW_WHERE = { sections: 'on the timeline', zooms: 'on the timeline', picture: 'on the canvas', cut: 'in Cut', lock: 'in Cut', scenes: 'in Scenes', newest: 'in Publish', post: 'in Publish' };
const showLabel = (show) => `Show me ${SHOW_WHERE[show?.target] || { packaging: 'in Packaging', canvas: 'on the canvas', cut: 'in Cut', scenes: 'in Scenes', renders: 'in Publish', post: 'in Publish' }[show?.tab] || 'where'}`;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// hooks: runStep(step, from) (from: 'dock' | 'empty' | 'menu' | 'help', where Run was pressed), setTab(tab, stage?) (a pane by its old tab name; stage: the stage to select when it opens that
// pane), goStage(name) (open a stage's workspace), stage() (the selected stage), marks() ({ <stage>: why } for the "new"
// dots), glowTab(tab, why, stage?), applyNotes() (Save changes → Claude), openCutList() (what Clean up left for you),
// newestRender() (selects it on the Renders tab), learn(), status() → /api/status (help), composer(<the running step's
// name> | null) → the message box says so and holds what you send until it finishes.
export function makeRail({ root, id, getP, hooks }) {
  let barHost = null, pop = null, popFor = null, overlay = null;
  let prevDone = null, barSig = '', helpOpen = false;
  const url = `/api/projects/${encodeURIComponent(id)}`;
  const pl = () => getP().pipeline;
  // (also the single steps of the ⋯ menu: Transcribe runs on its own for already-edited footage, B9)
  const stepOf = (sid) => pl()?.steps.find((s) => s.id === sid) || pl()?.more?.find((s) => s.id === sid) || null;
  const indexOf = (sid) => (pl()?.steps.findIndex((s) => s.id === sid) ?? -1) + 1;

  // ---------- what's happening now ----------
  // The step Claude is working on: Clean up (with its sub-steps, server/blocks.mjs prepareState) or the step whose
  // brief went to the chat while the chat is still busy (index.mjs stepRuns).
  function running() {
    const P = getP();
    if (P.prepare?.running) return stepOf('prepare');
    return P.busy && P.running ? stepOf(P.running) : null;
  }
  // "Clean up · Rough cut, 2 of 3"
  function runText(s) {
    const subs = s?.subs || [];
    if (!subs.length) return s?.name || '';
    const cur = subs.findIndex((x) => !x.done);
    return cur < 0 ? `${s.name} · finishing` : `${s.name} · ${subs[cur].label}, ${cur + 1} of ${subs.length}`;
  }
  const current = () => stepOf(pl()?.current);
  // An optional step right before the next one that isn't done or skipped: offered as "<step> first".
  function before(cur) {
    const steps = pl()?.steps || [], i = steps.indexOf(cur);
    for (let k = i - 1; k >= 0 && steps[k].optional; k--) if (!steps[k].done && !steps[k].skipped) return steps[k];
    return null;
  }
  const needs = () => { const P = getP(); return stepOf('prepare')?.done && P.prepare?.needs > 0 ? P.prepare.needs : 0; };
  const sendNotes = (s) => s?.action === 'open-scenes' && getP().scenes?.open > 0;
  // from: where Run was pressed ('dock', 'empty', 'menu', 'help'); the step's stage then opens as it starts (B11).
  function run(s, from) {
    if (!s) return;
    dismissDone();
    if (sendNotes(s)) return hooks.applyNotes();
    hooks.runStep(s, from);
  }
  async function railOp(body) {
    try { getP().pipeline = await api(`${url}/rail`, body); } catch (e) { toast(e.message); return; }
    render();
  }
  const skip = (s, on = true) => railOp({ op: on ? 'skip' : 'unskip', step: s.id });

  // ---------- the bar: the stages are the navigation (ADDENDUM-stage-bar.md) ----------
  // Each stage is a tab (it opens that stage's pane: web/stages.js STAGE_PANE) and a ▾ beside it (its steps). The
  // selected stage is where you are (bold, underlined); the NEXT badge, or RUNNING with a spinner while Claude works on
  // a step, is how far the video is. They are styled apart and can sit on different stages.
  const stageList = () => stagesOf(pl());
  const stepsOf = (st) => (st.steps || []).map(stepOf).filter(Boolean);
  function stageInfo(st, cur, rs) {
    const ss = stepsOf(st);
    const nDone = ss.filter((s) => s.done).length;
    // Publish has no steps: its tick is the finished video, an export (Export → Video) or a render marked final. A Build
    // step's render isn't one: it's ready to review, not published.
    const tick = st.name === 'Publish' ? published() : ss.length > 0 && ss.every((s) => s.done || s.skipped);
    const badge = rs ? (rs.stage === st.name ? 'run' : '') : cur?.stage === st.name ? 'next' : '';
    const optional = ss.length > 0 && ss.every((s) => s.optional);
    const skipped = optional && ss.some((s) => s.skipped) && ss.every((s) => s.skipped || s.done);
    return { st, ss, nDone, tick, badge, optional, skipped };
  }
  const badgeHtml = (badge, extra = '') => (badge === 'run'
    ? `<span class="stg-badge run" aria-hidden="true"><span class="spin"></span>Running${extra}</span>`
    : badge === 'next' ? `<span class="stg-badge" aria-hidden="true">Next${extra}</span>` : '');
  function dotOf(s, cur, runningStep) {
    const c = s.done ? 'done' : s === runningStep ? 'run' : s.skipped ? 'skip' : s === cur ? 'next' : 'todo';
    return `<i class="d ${c}${s.optional ? ' opt' : ''}" title="${esc(`${s.name}${s.optional ? ' (optional)' : ''}: ${s.done ? 'done' : s.skipped ? 'skipped' : s === cur ? 'next' : 'to do'}`)}"></i>`;
  }
  // What a screen reader hears for a stage: "Record, next step: Record, 0 of 1 step done".
  function stageLabel(i, cur, rs, extra) {
    const { st, ss, nDone, tick, badge, optional, skipped } = i;
    const parts = [st.name];
    if (badge === 'run') parts.push(`running: ${runText(rs)}`);
    if (badge === 'next') parts.push(`next step: ${cur.name}`);
    if (ss.length) parts.push(`${nDone} of ${ss.length} step${ss.length > 1 ? 's' : ''} done`);
    else if (st.name === 'Publish') parts.push(tick ? 'exported' : getP().renders?.length ? 'not exported yet' : 'nothing rendered yet');
    else if (pl()) parts.push('no steps in this format');
    if (optional) parts.push(skipped ? 'optional, skipped' : 'optional');
    if (tick && st.name !== 'Publish') parts.push('done');
    return [...parts, ...extra].join(', ');
  }
  const published = () => { const P = getP(); return Boolean(P.finalRender) || (P.renders || []).some((r) => r.kind === 'export'); };
  const selected = () => hooks.stage?.() || null;
  let menu = null, longPress = 0, longFired = false;
  function renderBar() {
    if (!barHost?.isConnected) return;
    const P = getP(), p = P.pipeline;
    const cur = p ? current() : null, rs = p ? running() : null, sc = P.scenes?.count ? P.scenes : null, nd = p ? needs() : 0;
    const sel = selected(), marks = hooks.marks?.() || {};
    const list = stageList().map((st) => stageInfo(st, cur, rs));
    const sig = JSON.stringify([p && p.steps.map((s) => [s.id, s.done, s.skipped, s.name]), p?.current, rs?.id, rs && runText(rs), sc && [sc.approved, sc.count, sc.of], nd, popFor, sel, marks, Boolean(P.renders?.length), published(), Boolean(menu)]);
    if (sig === barSig && barHost.querySelector('.stages')) return fit();
    barSig = sig;
    const fo = document.activeElement;
    const focused = barHost.contains(fo) && fo?.dataset?.stage ? { cls: fo.classList.contains('stg-more') ? 'stg-more' : 'stg', stage: fo.dataset.stage } : fo?.classList?.contains('stg-col') ? { cls: 'stg-col' } : null;
    const anySel = list.some((i) => i.st.name === sel);
    const tabs = list.map((i, k) => {
      const { st, ss } = i, name = st.name, on = name === sel || (!anySel && k === 0), slug = stageSlug(name), mark = marks[name];
      const pill = name === 'Polish' && sc ? `<span class="stg-pill" title="${sc.approved} of ${sc.of ?? sc.count} scenes approved in Scenes"><span class="pl-f">${sc.approved} of ${sc.of ?? sc.count} approved</span><span class="pl-s">${sc.approved}/${sc.of ?? sc.count}</span></span>` : '';
      const warn = name === 'Cut' && nd ? `<span class="stg-warn" title="${nd} thing${nd > 1 ? 's' : ''} Clean up left for you to hear, in Cut">${nd}</span>` : '';
      const extra = [];
      if (pill) extra.push(`${sc.approved} of ${sc.of ?? sc.count} scenes approved`);
      if (warn) extra.push(`${nd} need${nd > 1 ? '' : 's'} you`);
      if (mark) extra.push(mark);
      const words = PANE_WORDS[STAGE_PANE[name]];
      const tip = `${name}: opens ${words.name}${i.optional ? (i.skipped ? ' · optional, skipped' : ' · optional') : ''}`;
      const cls = ['stg', on && 'on', i.tick && 'done', i.optional && 'opt', i.skipped && 'skipped', !ss.length && !st.ui && p && 'none', mark && 'new glow'].filter(Boolean).join(' ');
      const more = ss.length ? `<button type="button" class="stg-more" data-stage="${esc(name)}" aria-label="${esc(`${name} steps`)}" aria-haspopup="dialog" aria-expanded="${popFor === name}" title="${esc(`${name}: its steps`)}">${ICON.caret}</button>` : '';
      return `${k ? '<i class="stg-sep" aria-hidden="true"></i>' : ''}<div class="stg-w${on ? ' on' : ''}" role="none" data-w="${esc(name)}">
        <button type="button" role="tab" id="stg-${esc(slug)}" class="${cls}" data-stage="${esc(name)}" data-tab="${STAGE_PANE[name]}" aria-selected="${on}" aria-controls="wsBody" tabindex="${on ? 0 : -1}" aria-label="${esc(stageLabel(i, cur, rs, extra))}" title="${esc(tip)}">
          <span class="st-n">${i.tick ? ICON.tick : ''}<span class="st-t">${esc(name)}</span>${warn}${pill}${badgeHtml(i.badge)}${mark ? '<i class="stg-dot" aria-hidden="true"></i>' : ''}</span>
          ${ss.length ? `<span class="dots" aria-hidden="true">${ss.map((s) => dotOf(s, cur, rs)).join('')}</span>` : ''}</button>${more}</div>`;
    }).join('');
    // The narrow bar (fit level 4, and always at 760 px and below): one button, the stage you're on, with the progress
    // badge (on another stage, the badge names it), opening a list of every stage.
    const si = list.find((i) => i.st.name === sel) || list[0], bi = list.find((i) => i.badge);
    const colBadge = bi ? badgeHtml(bi.badge, bi === si ? '' : ` · ${esc(bi.st.name)}`) : '';
    const colLabel = `Stage: ${si.st.name}${bi ? (bi.badge === 'run' ? `. Running: ${runText(rs)} in ${bi.st.name}` : `. Next step: ${cur.name} in ${bi.st.name}`) : ''}. Every stage`;
    const group = h(`<div class="stages" role="tablist" aria-label="Stages${p ? `: ${esc(p.format)}, ${p.steps.filter((s) => s.done).length} of ${p.steps.length} steps done` : ''}">${tabs}</div>`);
    const col = h(`<button type="button" class="stg-col${si.tick ? ' done' : ''}" aria-haspopup="dialog" aria-expanded="${Boolean(menu)}" aria-label="${esc(colLabel)}">${si.tick ? ICON.tick : ''}<span class="st-t">${esc(si.st.name)}</span>${colBadge}${Object.keys(marks).length ? '<i class="stg-dot" aria-hidden="true"></i>' : ''}${ICON.caret}</button>`);
    const help = h(`<button type="button" class="rail-help" aria-label="How the steps work" title="How the steps work">${ICON.help}</button>`);
    help.onclick = () => openHelp(true);
    const more = barHost.querySelector('.rail-more');
    barHost.replaceChildren(group, col, help, ...(more ? [more] : []));
    const tabEls = [...group.querySelectorAll('.stg')];
    tabEls.forEach((b) => {
      const name = b.dataset.stage;
      b.onclick = (e) => {
        e.stopPropagation();
        if (longFired) { longFired = false; return; }
        hooks.goStage?.(name);
      };
      b.onkeydown = (e) => {
        if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); return openPop(name); }
        const i = tabEls.indexOf(b);
        const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabEls.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        const t = tabEls[(to + tabEls.length) % tabEls.length];
        tabEls.forEach((x) => (x.tabIndex = x === t ? 0 : -1));
        t.focus();
      };
      // A long press opens the stage's steps (the way there when the ▾ buttons are hidden).
      b.onpointerdown = (e) => {
        if (e.button !== 0 || !stepsOf(stageList().find((x) => x.name === name) || {}).length) return;
        clearTimeout(longPress);
        longFired = false;
        longPress = setTimeout(() => { longFired = true; openPop(name); }, 550);
      };
      b.onpointerup = b.onpointerleave = b.onpointercancel = () => clearTimeout(longPress);
    });
    group.querySelectorAll('.stg-more').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); togglePop(b.dataset.stage, anchorOf(b.dataset.stage)); }));
    col.onclick = (e) => { e.stopPropagation(); menu ? closeMenu(true) : openMenu(); };
    if (focused?.cls === 'stg-col') col.focus();
    else if (focused) group.querySelector(`.${focused.cls}[data-stage="${CSS.escape(focused.stage)}"]`)?.focus();
    fit();
    if (pop && popFor) placePop(anchorOf(popFor));
    if (menu) { fillMenu(); placeMenu(); }
  }
  function bar(host, more) {
    barHost = host;
    barSig = '';
    host.setAttribute('aria-label', 'Stages');
    host.replaceChildren(...(more ? [more] : []));
    renderBar();
  }
  // Where a stage's list hangs: under the stage, or under the narrow bar's one button when the stages are folded away.
  function anchorOf(name) {
    const w = barHost?.querySelector(`.stg-w[data-w="${CSS.escape(name || '')}"]`);
    if (w && w.getBoundingClientRect().width > 0) return w;
    return barHost?.querySelector('.stg-col') || null;
  }
  // Fit the bar, in order until it fits: 1 the segments go, 2 the project name gives room, 3 the ▾ buttons go (a long
  // press or Alt+↓ on a stage still opens its steps), 4 the stages fold into one button. At 760 px and below it is 4.
  function fit() {
    const g = barHost?.querySelector('.stages'), crumbs = $('#crumbs'), barEl = $('.bar');
    if (!g || !crumbs || !barEl) return;
    // The least the name area gives: the style picker keeps its width (style.css caps it), the name about 90 px.
    const floor = () => Math.max(160, (crumbs.querySelector('.sp')?.offsetWidth || 0) + 100);
    const over = () => barHost.scrollWidth > barHost.clientWidth + 1 || g.scrollWidth > g.clientWidth + 1;
    // The CSS breakpoint, not innerWidth: on a phone an overflowing page widens innerWidth (867 px at 375), so the
    // bar never folded and kept the page wide.
    const narrow = matchMedia('(max-width: 760px)').matches;
    const place = () => {
      crumbs.style.maxWidth = '';
      for (const t of [0, 1, 2, 3, 4]) {
        if (narrow && t < 4) continue;
        // Tight first: the style picker narrows with it, so the name's share is measured at its tight width.
        barEl.classList.toggle('tight', t >= 2);
        if (t === 2) {
          const short = Math.max(barHost.scrollWidth - barHost.clientWidth, g.scrollWidth - g.clientWidth);
          crumbs.style.maxWidth = `${Math.max(floor(), crumbs.offsetWidth - short - 8)}px`;
        }
        barHost.dataset.fit = String(t);
        g.dataset.fit = String(t);
        if (t === 4 || !over()) break;
      }
    };
    // Claude's state badge (web/app.js, B10) gives its room first: when the bar had to tighten or the style picker is
    // squeezed below its own width, the badge folds to its dot (the words stay in its tooltip and its name).
    const badge = document.getElementById('waitBadge'), right = barEl.querySelector('.bar-right');
    const squeezed = () => {
      const b = crumbs.querySelector('.sp-btn'), m = b?.querySelector('.sp-main');
      if (!b?.offsetWidth || !m) return false;
      const cap = parseFloat(getComputedStyle(b).maxWidth), natural = b.offsetWidth - m.clientWidth + m.scrollWidth;
      return b.offsetWidth + 1 < Math.min(Number.isFinite(cap) ? cap : Infinity, natural);
    };
    badge?.classList.remove('dot');
    place();
    if (badge && !badge.hidden && (narrow ? (right && right.scrollWidth > right.clientWidth + 1) || badge.offsetTop > (right?.offsetTop ?? 0) + 4 : Number(barHost.dataset.fit) >= 2 || squeezed())) {
      badge.classList.add('dot');
      place();
    }
    // The name gave more than the stages needed: hand the rest back.
    if (barHost.dataset.fit === '2' || barHost.dataset.fit === '3') {
      const used = [...barHost.children].reduce((sum, c) => sum + (c === g ? g.scrollWidth : c.offsetWidth), 0) + 4 * (barHost.children.length - 1);
      const slack = barHost.clientWidth - used - 8;
      if (slack > 0 && crumbs.style.maxWidth) crumbs.style.maxWidth = `${crumbs.offsetWidth + slack}px`;
      if (over()) crumbs.style.maxWidth = `${Math.max(floor(), crumbs.offsetWidth - slack)}px`;
    }
    if (barHost.dataset.fit !== '4' && menu) closeMenu();
  }

  // ---------- the narrow bar's list of every stage ----------
  function openMenu() {
    closePop();
    menu = h('<div class="stg-menu" role="dialog" aria-label="Stages" tabindex="-1"></div>');
    document.body.append(menu);
    barHost.querySelector('.stg-col')?.setAttribute('aria-expanded', 'true');
    fillMenu();
    placeMenu();
    (menu.querySelector('.sm-go.on') || menu).focus({ preventScroll: true });
    document.addEventListener('pointerdown', menuOutside, true);
    document.addEventListener('keydown', menuKeys, true);
  }
  function fillMenu() {
    if (!menu) return;
    const cur = pl() ? current() : null, rs = pl() ? running() : null, sel = selected(), marks = hooks.marks?.() || {};
    const had = menu.contains(document.activeElement) ? document.activeElement.dataset.go || document.activeElement.dataset.steps : null;
    menu.innerHTML = `<ul class="sm-list">${stageList().map((st) => {
      const i = stageInfo(st, cur, rs), on = st.name === sel;
      const count = i.ss.length ? `${i.nDone} of ${i.ss.length}` : st.name === 'Publish' ? (i.tick ? 'exported' : '') : '';
      return `<li><button type="button" class="sm-go${on ? ' on' : ''}" data-go="${esc(st.name)}" aria-current="${on ? 'true' : 'false'}" aria-label="${esc(stageLabel(i, cur, rs, marks[st.name] ? [marks[st.name]] : []))}">
          <span class="sm-ic" aria-hidden="true">${i.tick ? ICON.tick : ''}</span><b>${esc(st.name)}</b>${badgeHtml(i.badge)}${marks[st.name] ? '<i class="stg-dot" aria-hidden="true"></i>' : ''}<span class="gap"></span><small aria-hidden="true">${esc(count)}</small></button>
        ${i.ss.length ? `<button type="button" class="nc-link sm-steps" data-steps="${esc(st.name)}" aria-label="${esc(`${st.name} steps`)}">Steps</button>` : ''}</li>`;
    }).join('')}</ul>`;
    menu.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => { closeMenu(); hooks.goStage?.(b.dataset.go); barHost?.querySelector('.stg-col')?.focus({ preventScroll: true }); }));
    menu.querySelectorAll('[data-steps]').forEach((b) => (b.onclick = () => { const name = b.dataset.steps; closeMenu(); openPop(name); }));
    if (had) menu.querySelector(`[data-go="${CSS.escape(had)}"], [data-steps="${CSS.escape(had)}"]`)?.focus({ preventScroll: true });
  }
  function placeMenu() {
    const b = barHost?.querySelector('.stg-col');
    if (!menu || !b) return;
    const r = b.getBoundingClientRect(), w = Math.min(320, innerWidth - 24);
    menu.style.width = `${w}px`;
    menu.style.left = `${Math.max(12, Math.min(innerWidth - w - 12, r.left))}px`;
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.maxHeight = `${innerHeight - r.bottom - 18}px`;
  }
  function closeMenu(refocus = false) {
    if (!menu) return;
    menu.remove();
    menu = null;
    document.removeEventListener('pointerdown', menuOutside, true);
    document.removeEventListener('keydown', menuKeys, true);
    const b = barHost?.querySelector('.stg-col');
    b?.setAttribute('aria-expanded', 'false');
    if (refocus) b?.focus();
  }
  const menuOutside = (e) => { if (menu && !menu.contains(e.target) && !e.target.closest?.('.stg-col')) closeMenu(); };
  const menuKeys = (e) => {
    if (!menu) return;
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); return closeMenu(true); }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = [...menu.querySelectorAll('.sm-go')], i = all.indexOf(document.activeElement), n = all.length, down = e.key === 'ArrowDown';
    all[i < 0 ? (down ? 0 : n - 1) : (i + (down ? 1 : n - 1)) % n]?.focus();
    e.preventDefault();
  };

  // ---------- a stage's steps (the popover under its ▾; opening it never changes the pane) ----------
  const moreBtn = (name) => barHost?.querySelector(`.stg-more[data-stage="${CSS.escape(name || '')}"]`) || null;
  function openPop(name) { if (popFor !== name) togglePop(name, anchorOf(name)); }
  function togglePop(name, chip) {
    if (popFor === name) return closePop(true);
    closePop();
    closeMenu();
    if (!chip) return;
    popFor = name;
    moreBtn(name)?.setAttribute('aria-expanded', 'true');
    pop = h(`<div class="stg-pop" role="dialog" aria-label="${esc(name)}: its steps" tabindex="-1"></div>`);
    document.body.append(pop);
    fillPop();
    placePop(chip);
    pop.focus({ preventScroll: true }); // the list itself: Tab goes to its buttons, Escape closes
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', popKeys, true);
  }
  let popSig = '';
  function fillPop() {
    if (!pop) return;
    const p = pl(), st = p?.stages.find((x) => x.name === popFor);
    if (!st) return closePop();
    const ss = st.steps.map(stepOf).filter(Boolean), cur = current(), rs = running();
    // Only when something in it changed, keeping the focused button (a refresh mid-Tab doesn't lose your place).
    const sig = JSON.stringify([popFor, ss.map((s) => [s.id, s.done, s.skipped, s.line, s.name]), cur?.id, rs && runText(rs), getP().scenes?.open]);
    if (sig === popSig && pop.firstChild) return;
    popSig = sig;
    const had = pop.contains(document.activeElement) && document.activeElement !== pop ? { a: document.activeElement.dataset.a, s: document.activeElement.dataset.s } : null;
    pop.innerHTML = `<div class="sp-head"><b>${esc(st.name)}</b><span>${ss.length ? `${ss.filter((s) => s.done).length} of ${ss.length} done` : ''}</span><span class="gap"></span>
      <button type="button" class="sp-x" data-a="close" aria-label="Close">${ICON.x}</button></div>
      ${ss.length ? '' : `<p class="sp-none">This format has no ${esc(st.name.toLowerCase())} step.</p>`}
      <ul class="sp-list">${ss.map((s) => {
        const state = s === rs ? 'running' : s.done ? 'done' : s.skipped ? 'skipped' : s === cur ? 'next' : 'todo';
        const acts = [];
        if (state === 'next') acts.push(`<button type="button" class="sl-run" data-a="run" data-s="${esc(s.id)}">${ICON.play}${sendNotes(s) ? `Save changes → Claude · ${getP().scenes.open}` : s.kind === 'app' ? 'Open' : 'Run'}</button>`);
        if (state === 'todo') acts.push(`<button type="button" class="btn small" data-a="run" data-s="${esc(s.id)}">${s.kind === 'app' ? 'Open' : 'Run'}</button>`);
        if ((state === 'next' || state === 'todo') && s.optional) acts.push(`<button type="button" class="btn ghost small" data-a="skip" data-s="${esc(s.id)}">Skip</button>`);
        if (state === 'skipped') acts.push(`<button type="button" class="btn small" data-a="unskip" data-s="${esc(s.id)}">Undo skip</button>`);
        // Done by import (B9, already-edited footage): "Done · already edited", and the way back.
        if (state === 'done' && s.byImport) acts.push(`<button type="button" class="btn small" data-a="unimport" data-s="${esc(s.id)}">Clean it up anyway</button>`);
        else if (state === 'done' && s.show) acts.push(`<button type="button" class="btn ghost small" data-a="show" data-s="${esc(s.id)}">${ICON.eye}Show me</button>`);
        if (state === 'done' && !s.byImport) acts.push(`<button type="button" class="btn ghost small" data-a="again" data-s="${esc(s.id)}">${s.kind === 'app' || s.id === 'post-kit' ? 'Open' : 'Run again'}</button>`);
        const status = state === 'running' ? `<small class="sl-state run"><span class="spin" aria-hidden="true"></span>${esc(runText(s))}</small>`
          : state === 'done' ? `<small class="sl-state ok">${ICON.tick}${esc(s.line || 'Done')}</small>`
          : state === 'skipped' ? '<small class="sl-state">Skipped</small>' : '';
        return `<li class="${state}"><span class="sl-ic" aria-hidden="true">${state === 'done' ? ICON.tick : state === 'running' ? '<span class="spin"></span>' : '<i></i>'}</span>
          <span class="sl-tx"><b>${esc(s.name)}${s.optional ? ' <em>optional</em>' : ''}</b><span>${esc(s.what)}</span>${s.where ? `<small>${ICON.eye}${esc(s.where)}</small>` : ''}${status}</span>
          ${acts.length ? `<span class="sl-acts">${acts.join('')}</span>` : ''}</li>`;
      }).join('')}</ul>`;
    pop.querySelector('[data-a=close]').onclick = () => closePop(true);
    pop.querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => {
      const s = stepOf(b.dataset.s), a = b.dataset.a;
      if (!s) return;
      if (a === 'skip' || a === 'unskip') return skip(s, a === 'skip');
      if (a === 'unimport') { if (confirm('Clean it up anyway?\n\nClean up and Lock the cut become steps to do again: Claude transcribes, cuts the pauses and checks the joins as for a recording.')) railOp({ op: 'unimport', step: s.id }); return; }
      closePop();
      if (a === 'show') return show(s.show, s.name, true, s.stage);
      if (a === 'again' && s.kind !== 'app' && s.id !== 'post-kit' && !confirm(`Run “${s.name}” again?`)) return;
      // Run from a stage's list: the step's stage opens as it starts (B11: runStep; Show me does the same). Save changes
      // → Claude opens it here.
      if (sendNotes(s)) hooks.goStage?.(s.stage);
      run(s, 'menu');
    }));
    if (had) (pop.querySelector(`[data-a="${had.a}"]${had.s ? `[data-s="${CSS.escape(had.s)}"]` : ''}`) || pop).focus({ preventScroll: true });
  }
  function placePop(chip) {
    if (!pop || !chip) return;
    const r = chip.getBoundingClientRect(), w = Math.min(420, innerWidth - 24);
    pop.style.width = `${w}px`;
    pop.style.left = `${Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2))}px`;
    pop.style.top = `${r.bottom + 8}px`;
    pop.style.maxHeight = `${innerHeight - r.bottom - 24}px`;
  }
  function closePop(refocus = false) {
    if (!pop) return;
    const name = popFor;
    pop.remove(); pop = null; popFor = null; popSig = '';
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', popKeys, true);
    const more = moreBtn(name);
    more?.setAttribute('aria-expanded', 'false');
    if (!refocus) return;
    // Back to the ▾ it came from, else (▾ hidden) the stage itself, else the narrow bar's button.
    const visible = (x) => x && x.getBoundingClientRect().width > 0;
    const tab = barHost?.querySelector(`.stg[data-stage="${CSS.escape(name)}"]`);
    (visible(more) ? more : visible(tab) ? tab : barHost?.querySelector('.stg-col'))?.focus();
  }
  const outside = (e) => { if (pop && !pop.contains(e.target) && !e.target.closest?.('.stg-more')) closePop(); };
  const popKeys = (e) => { if (e.key === 'Escape' && pop) { e.stopPropagation(); e.preventDefault(); closePop(true); } };

  // ---------- the dock: the next step on the top edge of the message box (variation 2, "At the message box") ----------
  // One slim strip, part of the composer and always in the same place: "Next · <step> · ⓘ · ▶ Run", with Skip on an
  // optional step, "<step> first" for an optional step right before the next one, the amber "N need you" Clean up left
  // and Review's "Save changes → Claude · N". ⓘ opens it upwards into a small sheet over the bottom of the chat ("Step 3
  // of 9 · Cut", what it does, "You'll see it: …" with Show me where, the stage's steps as a checklist). While a step runs
  // the strip says which and how far ("Clean up · Rough cut, 2 of 3"); after one it turns green for about 4 s ("✓ <step>
  // · <done line> · Show me"), then shows the next step. The chat keeps a one-line marker of it: the server writes it to
  // the chat log when the page reports the step done (/rail seen), and marker() draws it. The labels shorten as the
  // column narrows (fitDock), so the strip never wraps. hooks.composer(<running step's name> | null) tells the composer.
  // The notes from the last Save changes → Claude that its turn left open (server: packageRun.left), unless × put
  // them away for that Save.
  function notesLeft(P) {
    const r = P.packageRun;
    if (!r?.left?.count || store.get(`vo.notesSeen.${id}`) === String(r.at)) return null;
    return { count: r.left.count, text: r.left.text };
  }
  let dockHost = null, dockSig = '', dockRO = null, sheetOpen = false, green = null, greenTimer = 0, hovering = false, ticker = 0, lastRun = null;
  const GREEN_MS = 4000;
  // A label in three lengths; the strip shows the one its fit level allows (data-fit 0 full, 1 short, 2 and up shortest).
  const lbl = (full, short = full, tiny = short) => `<span class="l0">${esc(full)}</span><span class="l1">${esc(short)}</span><span class="l2">${esc(tiny)}</span>`;
  // A Build step's progress per scene (B5b, server/build-progress.mjs; null when Claude marks no scene, and the strip
  // then shows how long it has run, as before): "scene 3 of 10" while one builds, "10 of 10 built" at the end.
  const buildText = (b) => {
    if (!b?.marked || !b.total) return '';
    if (b.current) return `scene ${b.current.k} of ${b.total}`;
    return b.built >= b.total ? `${b.built} of ${b.total} built, rendering` : `${b.built} of ${b.total} built`;
  };
  const buildProg = (b) => b.total <= 14
    ? `<span class="dk-prog${b.total > 8 ? ' many' : ''}" aria-hidden="true">${b.order.map((sid) => `<i class="${{ built: 'd', building: 'r' }[b.states[sid]] || ''}"></i>`).join('')}</span>`
    : `<span class="dk-prog bar" aria-hidden="true"><i class="d" style="flex:${b.built}"></i><i class="r" style="flex:${b.current ? 1 : 0}"></i><i style="flex:${Math.max(0, b.total - b.built - (b.current ? 1 : 0))}"></i></span>`;
  const runWord = (s) => (s.kind === 'app' ? (s.action === 'import' ? 'Start' : 'Open') : 'Run');
  const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  const elapsed = () => { const at = getP().runningAt; return at ? mmss(Math.max(0, (Date.now() - at) / 1000)) : ''; };
  function dock(host) {
    dockHost = host;
    dockSig = '';
    host.addEventListener('pointerenter', () => { hovering = true; if (green) clearTimeout(greenTimer); });
    host.addEventListener('pointerleave', () => { hovering = false; if (green) { clearTimeout(greenTimer); greenTimer = setTimeout(endGreen, 1500); } });
    host.addEventListener('focusin', () => { if (green && !hovering) { clearTimeout(greenTimer); greenTimer = setTimeout(endGreen, GREEN_MS); } });
    host.addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b && host.contains(b)) dockAct(b.dataset.a); });
    host.replaceChildren(h('<div class="vh dk-live" aria-live="polite"></div>'));
    dockRO?.disconnect();
    dockRO = new ResizeObserver(() => fitDock());
    dockRO.observe(host);
    renderDock();
  }
  const say = (text) => { const l = dockHost?.querySelector('.dk-live'); if (l) { l.textContent = ''; setTimeout(() => { l.textContent = text; }, 60); } };
  const needsText = (nd) => `${stepOf('prepare')?.name || 'Clean up'} left ${nd} thing${nd > 1 ? 's' : ''} for you to hear`;
  const needsBtn = (nd) => `<button type="button" class="dk-needs" data-a="needs" title="${esc(`${needsText(nd)}: open the list`)}" aria-label="${esc(`${nd} need${nd > 1 ? '' : 's'} you. ${needsText(nd)}: open the list`)}"><span class="rs-warn" aria-hidden="true">!</span>${lbl(`${nd} need${nd > 1 ? '' : 's'} you`, String(nd))}</button>`;
  const infoBtn = (name) => `<button type="button" class="dk-info${sheetOpen ? ' on' : ''}" data-a="info" aria-expanded="${sheetOpen}" aria-controls="dkSheet" aria-label="${esc(`What’s this? ${name}`)}" title="What it does and where you’ll see it">${ICON.info}</button>`;
  const needsRow = (nd) => `<div class="dks-needs"><span class="rs-warn" aria-hidden="true">!</span><span>${esc(needsText(nd))}.</span><button type="button" class="nc-link" data-a="needs">Open the list</button></div>`;

  function renderDock() {
    if (!dockHost?.isConnected) return;
    const P = getP(), p = P.pipeline, rs = p ? running() : null;
    hooks.composer?.(rs?.name || null);
    if (rs?.id !== lastRun) { if (rs) say(`Claude is working on ${rs.name}.`); lastRun = rs?.id || null; }
    if (!p) { dockHost.querySelector('.dk-strip')?.remove(); dockSig = ''; if (sheetOpen) closeSheet(); return; }
    const cur = current(), nd = needs();
    // A take recording into this video while Record is the next step: the strip is the take's ("Recording 0:42 ·
    // Stop"), never another Start (hooks.recording: web/app.js, from web/recorder.js's session).
    const rec = !green && !rs && cur?.action === 'import' ? hooks.recording?.() || null : null;
    const mode = green ? 'done' : rs ? 'run' : rec ? 'rec' : cur ? 'next' : 'all';
    if (mode === 'done' && sheetOpen) { sheetOpen = false; unlistenSheet(); }
    const notes = cur && sendNotes(cur) ? P.scenes.open : 0;
    // Every step done but changes still waiting in the package (the same count Home shows): the strip says so.
    const waiting = mode === 'all' ? P.scenes?.open || 0 : 0;
    const uf = mode === 'next' || mode === 'all' ? P.unfinished || null : null;
    paintUnfinished(uf, cur);
    // A step that didn't finish is one of Claude's open items (B10): the badge and the rail count it too.
    openItems(id, 'unfinished', uf ? { count: 1, text: `${uf.name} didn’t finish`, read: () => hooks.readReply?.(uf.ts || null) } : null);
    // So is what came of Save changes → Claude (B6): notes Claude left open or didn't mark done, until they are dealt
    // with in Scenes or put away with × (remembered for that Save).
    const nl = notesLeft(P);
    openItems(id, 'notes', nl ? { count: nl.count, text: nl.text, read: () => hooks.openNotes?.() } : null);
    paintState(rs);
    const sig = JSON.stringify([mode, cur?.id, rs && runText(rs), rs && buildText(P.build), nd, green, notes, waiting, sheetOpen, p.steps.map((s) => [s.id, s.done, s.skipped]), Boolean(P.runningAt), rec && [rec.mode, rec.mode === 'saving' ? rec.progress : 0]]);
    clearInterval(ticker); ticker = 0;
    if (mode === 'run' && !rs.subs?.length && !buildText(P.build) && P.runningAt) ticker = setInterval(() => { const t = dockHost?.querySelector('.dk-time'); if (t) t.textContent = elapsed(); }, 1000);
    if (mode === 'rec' && rec.ms != null) ticker = setInterval(() => { const t = dockHost?.querySelector('.dk-time'), r = hooks.recording?.(); if (t && r?.ms != null) t.textContent = mmss(r.ms / 1000); }, 500);
    if (sig === dockSig) return fitDock();
    dockSig = sig;
    const focusA = dockHost.contains(document.activeElement) ? document.activeElement.dataset?.a : null;
    let html;
    if (mode === 'done') {
      html = `<div class="dk-strip ok"><span class="dk-ok" aria-hidden="true">${ICON.tick}</span>
        <span class="dk-name"><span class="vh">Done: </span><b>${esc(green.name)}</b><span class="dk-sub"> · ${esc(green.line || 'done')}</span></span>
        ${green.show ? `<button type="button" class="dk-show" data-a="show" aria-label="${esc(`${showLabel(green.show)}: ${green.name}`)}">${ICON.eye}Show me</button>` : ''}</div>`;
    } else if (mode === 'rec') {
      const live = rec.mode === 'live' || rec.mode === 'paused';
      const word = { live: 'Recording', paused: 'Paused', starting: 'Starting the take…', saving: 'Saving the take…' }[rec.mode] || 'Recording';
      const sub = live ? `<span class="dk-sub"> · <span class="dk-time">${mmss((rec.ms || 0) / 1000)}</span></span>` : rec.mode === 'saving' && rec.progress ? `<span class="dk-sub"> · ${Math.round(rec.progress * 100)}%</span>` : '';
      html = `<div class="dk-strip rec ${esc(rec.mode)}"><span class="dk-pill rec" aria-hidden="true"><i class="rec-dot"></i></span>
        <span class="dk-name"><span class="vh">Record: </span><b>${esc(word)}</b>${sub}</span>
        ${live ? `<button type="button" class="dk-run dk-stop" data-a="rec-stop" aria-label="Stop the take">${ICON.stop}${lbl('Stop')}</button>` : ''}</div>`;
    } else if (mode === 'run') {
      const subs = rs.subs || [], k = subs.findIndex((x) => !x.done), bt = buildText(P.build);
      // Build with per-scene progress (B5b): "Build the intro · scene 3 of 10", one segment per scene.
      const sub = subs.length ? (k < 0 ? 'finishing' : `${subs[k].label}, ${k + 1} of ${subs.length}`) : bt || '';
      const prog = subs.length ? `<span class="dk-prog" aria-hidden="true">${subs.map((x, i) => `<i class="${x.done ? 'd' : i === k ? 'r' : ''}"></i>`).join('')}</span>`
        : bt ? buildProg(P.build)
        : P.runningAt ? `<span class="dk-time" aria-hidden="true" title="How long it has been running">${elapsed()}</span>` : '';
      html = `<div class="dk-strip run${sheetOpen ? ' open' : ''}"><span class="dk-pill run"><span class="spin" aria-hidden="true"></span><span class="dk-pt">Running</span></span>
        <span class="dk-name"><span class="vh">Running: </span><b>${esc(rs.name)}</b>${sub ? `<span class="dk-sub"> · ${esc(sub)}</span>` : ''}</span>
        ${prog}${infoBtn(rs.name)}${sheetOpen ? sheet(rs) : ''}</div>`;
    } else if (mode === 'next') {
      const pre = !cur.optional ? before(cur) : null;
      const go = notes ? lbl(`Save changes → Claude · ${notes}`, `Save → Claude · ${notes}`, `Save · ${notes}`) : lbl(runWord(cur));
      const sec = cur.optional ? `<button type="button" class="dk-sec" data-a="skip" aria-label="${esc(`Skip ${cur.name}`)}">Skip</button>`
        : pre ? `<button type="button" class="dk-sec" data-a="pre" title="${esc(`${pre.name} first`)}" aria-label="${esc(`${pre.name} first`)}">${lbl(`${pre.name} first`, pre.name, `${pre.name.split(/\s+/)[0]} first`)}</button>` : '';
      html = `<div class="dk-strip next${sheetOpen ? ' open' : ''}"><span class="dk-pill" aria-hidden="true">Next</span>
        <span class="dk-name"><span class="vh">Next step: </span><b>${esc(cur.name)}</b>${cur.optional ? '<span class="vh"> (optional)</span>' : ''}</span>
        ${nd ? needsBtn(nd) : ''}${infoBtn(cur.name)}${sheetOpen ? sheet(cur) : ''}${sec}
        <button type="button" class="dk-run${notes ? '' : ' verb'}" data-a="run" aria-label="${esc(notes ? `Save changes and send ${notes} to Claude` : `${runWord(cur)}: ${cur.name}`)}">${ICON.play}${go}</button></div>`;
    } else {
      html = `<div class="dk-strip all${sheetOpen ? ' open' : ''}"><span class="dk-pill ok" aria-hidden="true">Done</span>
        <span class="dk-name"><b>${lbl('Every step is done', 'All steps done', 'All done')}</b>${waiting ? `<span class="dk-sub"> · ${waiting} change${waiting > 1 ? 's' : ''} waiting for Claude</span>` : ''}</span>
        ${nd ? needsBtn(nd) : ''}${infoBtn('Every step is done')}${sheetOpen ? sheetAll(nd) : ''}
        ${waiting ? `<button type="button" class="dk-run" data-a="send" aria-label="${esc(`Save changes and send ${waiting} to Claude`)}">${ICON.play}${lbl(`Save changes → Claude · ${waiting}`, `Save → Claude · ${waiting}`, `Save · ${waiting}`)}</button>`
    : `<button type="button" class="dk-run" data-a="renders">${lbl('Open Renders', 'Renders')}</button>`}</div>`;
    }
    const node = h(html), old = dockHost.querySelector('.dk-strip'), unf = dockHost.querySelector('.dk-unf');
    if (old) old.replaceWith(node); else if (unf) unf.after(node); else dockHost.prepend(node);
    fitDock();
    if (focusA) node.querySelector(`[data-a="${focusA}"]`)?.focus({ preventScroll: true });
  }
  // A step whose turn ended without its result (server/turns.mjs): one amber line over the strip, which is back on
  // Next, "Didn't finish: <Claude's one-line reason> · Read". Read scrolls the chat to Claude's reply; × puts it away.
  // It goes by itself when the step is done or another step starts.
  let ufKey = '';
  function paintUnfinished(u, cur) {
    const old = dockHost.querySelector('.dk-unf');
    const key = u ? JSON.stringify([u.step, u.at, u.reason, cur?.id]) : '';
    if (key === ufKey && (Boolean(old) === Boolean(u))) return;
    ufKey = key;
    if (!u) { old?.remove(); return; }
    const head = u.step === cur?.id ? 'Didn’t finish' : `${u.name} didn’t finish`;
    const node = h(`<div class="dk-unf" role="status"><span class="rs-warn" aria-hidden="true">!</span>
      <span class="dku-t" title="${esc(`${head}: ${u.reason}`)}"><b>${esc(head)}:</b> ${esc(u.reason || 'Claude stopped before it was done.')}</span>
      <span class="dku-dot" aria-hidden="true">·</span><button type="button" class="dku-read" data-a="read" aria-label="${esc(`Read Claude’s reply about ${u.name}`)}">Read</button>
      <button type="button" class="dku-x" data-a="unf-ok" aria-label="Put this away" title="Put this away">${ICON.x}</button></div>`);
    if (old) old.replaceWith(node); else dockHost.prepend(node); // over the strip
    say(`${u.name} didn’t finish: ${u.reason}`);
  }

  // Claude's state on the dock (B10, web/attention.js), one line over the strip, in the top bar's words: "Waiting for
  // you · <what> · Review", "Claude stopped · Send again", "Finished · Claude asked you something · Read", or "Claude is
  // working" for a plain chat message (a step's run is the strip's own Running). The dock's "Didn't finish" line stays
  // as it is (it is an open item too).
  let stSig = '';
  function paintState(rs = running()) {
    if (!dockHost?.isConnected) return;
    const st = stateOf([id, `${id}.packaging`]), old = dockHost.querySelector('.dk-st');
    const items = st.state === 'open' ? st.items.filter((x) => x.key !== 'unfinished') : [];
    const show = st.state === 'waiting' || (st.state === 'stopped' && st.chat === id) || (st.state === 'working' && st.chat === id && !rs) || items.length > 0;
    const d = describe(st);
    const sig = show ? JSON.stringify([st.state, st.chat, st.count, st.text, items.map((x) => x.text)]) : '';
    if (sig === stSig && Boolean(old) === show) return;
    stSig = sig;
    if (!show) { old?.remove(); return; }
    const what = st.state === 'open' ? items.map((x) => x.text).join(' · ') : st.state === 'working' ? st.text || 'on your message' : st.text;
    const btn = { waiting: '<button type="button" class="dku-read" data-a="st-go">Review</button>', stopped: '<button type="button" class="dku-read" data-a="st-retry">Send again</button>',
      open: `<button type="button" class="dku-read" data-a="st-go">Read</button><button type="button" class="dku-x" data-a="st-ok" aria-label="Put this away" title="Put this away">${ICON.x}</button>` }[st.state] || '';
    const node = h(`<div class="dk-st ${st.state}" role="status"><i class="st-mark" data-state="${st.state}" aria-hidden="true">${st.state === 'working' ? '<span class="spin"></span>' : ''}</i>
      <span class="dku-t" title="${esc(d.label)}"><b>${esc(d.line)}</b>${what ? ` · ${esc(what)}` : ''}</span>${btn}</div>`);
    const at = dockHost.querySelector('.dk-unf') || dockHost.querySelector('.dk-strip');
    if (old) old.replaceWith(node); else if (at) at.before(node); else dockHost.prepend(node);
  }
  function stateAct(a) {
    const st = stateOf([id, `${id}.packaging`]);
    if (a === 'st-retry') return st.retry?.();
    if (a === 'st-ok') {
      const at = getP().packageRun?.at;
      if (at && st.items?.some((x) => x.key === 'notes')) store.set(`vo.notesSeen.${id}`, String(at));
      openItems(id, 'notes', null);
      return openItems(id, 'questions', null);
    }
    if (st.chat !== id && st.chat) hooks.setTab('packaging');
    return st.focus?.();
  }

  // ⓘ's sheet: the words of the step the strip is about, and its stage's steps.
  function sheet(s) {
    const p = pl(), stage = p.stages.find((x) => x.name === s.stage), ss = (stage?.steps || []).map(stepOf).filter(Boolean);
    const cur = current(), rs = running(), nd = needs();
    const subs = rs === s && s.subs?.length ? `<div class="dks-subs" aria-hidden="true">${s.subs.map((x, k) => `<span class="${x.done ? 'd' : k === s.subs.findIndex((y) => !y.done) ? 'n' : ''}"><i></i>${esc(x.label)}</span>`).join('')}</div>` : '';
    const list = ss.map((x) => {
      const c = x.done ? 'done' : x === rs ? 'run' : x.skipped ? 'skipped' : x === cur ? 'next' : 'todo';
      const ic = c === 'done' ? ICON.tick : c === 'run' ? '<span class="spin" aria-hidden="true"></span>' : '<i aria-hidden="true"></i>';
      return `<li class="${c}">${ic}<span>${esc(x.name)}${x.optional ? ' <em>optional</em>' : ''}${c === 'skipped' ? ' <em>skipped</em>' : ''}</span><span class="vh">${{ done: ', done', next: ', next', run: ', running' }[c] || ''}</span></li>`;
    }).join('');
    const where = s.where ? `<div class="dks-where">${ICON.eye}<span><b>You’ll see it:</b> ${esc(s.where)}</span>${s.show ? '<button type="button" class="nc-link" data-a="where">Show me where</button>' : ''}</div>` : '';
    return `<div class="dk-sheet" id="dkSheet" role="region" aria-labelledby="dkSheetT" tabindex="-1">
      <div class="dks-top"><span class="dks-eye">Step ${indexOf(s.id)} of ${p.steps.length} · ${esc(s.stage)}</span><button type="button" class="dks-x" data-a="close" aria-label="Close">${ICON.x}</button></div>
      <h3 id="dkSheetT">${esc(s.name)}${s.optional ? ' <em class="nc-opt">optional</em>' : ''}</h3>
      <p>${esc(s.what)}</p>${subs}${where}${nd ? needsRow(nd) : ''}
      <div class="dks-stage"><div class="dks-h"><span>${esc(s.stage)}: ${ss.length} step${ss.length > 1 ? 's' : ''}</span><button type="button" class="nc-link" data-a="help">How the steps work</button></div>
        <ul class="dks-steps" aria-label="${esc(`${s.stage} steps`)}">${list}</ul></div></div>`;
  }
  function sheetAll(nd) {
    const p = pl();
    return `<div class="dk-sheet" id="dkSheet" role="region" aria-labelledby="dkSheetT" tabindex="-1">
      <div class="dks-top"><span class="dks-eye">All ${p.steps.length} steps · ${esc(p.format)}</span><button type="button" class="dks-x" data-a="close" aria-label="Close">${ICON.x}</button></div>
      <h3 id="dkSheetT">Every step is done</h3>
      <p>Export a new version from Renders whenever you like, or ask Claude for more changes below.</p>${nd ? needsRow(nd) : ''}
      <div class="dks-h"><button type="button" class="nc-link" data-a="learn">Learn from this project</button><button type="button" class="nc-link" data-a="help">How the steps work</button></div></div>`;
  }
  function dockAct(a) {
    const cur = current(), s = running() || cur;
    if (!['info', 'close', 'show'].includes(a)) closeSheet();
    switch (a) {
      case 'run': return run(cur, 'dock');
      case 'rec-stop': return hooks.stopRecording?.();
      case 'skip': return cur && skip(cur);
      case 'pre': return run(cur && before(cur), 'dock');
      case 'needs': return hooks.openCutList();
      case 'info': return sheetOpen ? closeSheet(true) : openSheet();
      case 'close': return closeSheet(true);
      case 'where': return s && show(s.show, s.name, false, s.stage);
      case 'show': return green && show(green.show, green.name, true, stepOf(green.id)?.stage);
      case 'renders': return hooks.setTab('renders');
      case 'send': return hooks.applyNotes();
      case 'learn': return hooks.learn();
      case 'help': return openHelp(true);
      case 'read': return hooks.readReply?.(getP().unfinished?.ts || null);
      case 'unf-ok': getP().unfinished = null; renderDock(); return railOp({ op: 'unfinished-ok' });
      case 'st-go': case 'st-retry': case 'st-ok': return stateAct(a);
    }
  }
  function openSheet() {
    sheetOpen = true;
    renderDock();
    dockHost?.querySelector('.dk-sheet')?.focus({ preventScroll: true });
    document.addEventListener('pointerdown', sheetOutside, true);
    document.addEventListener('keydown', sheetKeys);
  }
  function unlistenSheet() { document.removeEventListener('pointerdown', sheetOutside, true); document.removeEventListener('keydown', sheetKeys); }
  function closeSheet(refocus = false) {
    if (!sheetOpen) return;
    sheetOpen = false;
    unlistenSheet();
    renderDock();
    if (refocus) dockHost?.querySelector('[data-a=info]')?.focus({ preventScroll: true });
  }
  const sheetOutside = (e) => { if (dockHost && !dockHost.contains(e.target)) closeSheet(); };
  // Esc closes it from anywhere (the @ menu and the stage list handle their own Esc first).
  const sheetKeys = (e) => { if (e.key !== 'Escape' || e.defaultPrevented || !sheetOpen || !$('#modal')?.hidden) return; e.preventDefault(); closeSheet(Boolean(dockHost?.contains(document.activeElement))); };
  // Fit the strip: the labels shorten (1, 2), then the "Next" pill and the progress go (3), then the amber chip keeps
  // only its "!" and a plain Run only its ▶ (4; both keep their words for screen readers); only then does the step's
  // name get an ellipsis.
  function fitDock() {
    const s = dockHost?.querySelector('.dk-strip');
    if (!s || !s.offsetWidth) return;
    // Measured with the name at its full width (and the sheet out of the way): does the last item end inside the strip?
    s.classList.add('measure');
    const cs = getComputedStyle(s);
    const over = () => {
      const kids = [...s.children].filter((c) => c.offsetWidth && getComputedStyle(c).position !== 'absolute');
      return kids.length > 0 && kids.at(-1).getBoundingClientRect().right > s.getBoundingClientRect().right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) + 0.01;
    };
    for (const t of [0, 1, 2, 3, 4]) { s.dataset.fit = String(t); if (!over()) break; }
    s.classList.remove('measure');
  }
  // Green for about 4 s, longer while the pointer is on it.
  function showGreen(d) {
    green = d;
    clearTimeout(greenTimer);
    greenTimer = setTimeout(endGreen, GREEN_MS);
    // The tab its Show me points at glows until you open it (unless you're on it).
    if (d.show?.tab) hooks.glowTab?.(d.show.tab, `new from ${d.name}`, stepOf(d.id)?.stage);
    const c = current();
    say(`${d.name} is done${d.line ? `: ${d.line}` : ''}.${c ? ` Next: ${c.name}.` : ''}`);
  }
  function endGreen() {
    if (hovering) return;
    green = null;
    renderDock();
  }
  function dismissDone() {
    if (!green) return;
    green = null;
    clearTimeout(greenTimer);
    renderDock();
  }
  // The chat log's one-line marker of a finished step (server: /rail seen writes it; app.js's chat draws it here).
  function marker(ev) {
    const n = h(`<div class="marker done"><span class="mk-ic" aria-hidden="true">${ICON.tick}</span><span class="mk-t"><span class="vh">Done: </span><b>${esc(ev.text || '')}</b>${ev.line ? ` · ${esc(ev.line)}` : ''}${ev.show ? ` · <button type="button" class="nc-link mk-show">${esc(showLabel(ev.show))}</button>` : ''}</span></div>`);
    n.querySelector('.mk-show')?.addEventListener('click', () => show(ev.show, ev.text || '', true, stepOf(ev.step)?.stage));
    return n;
  }

  // ---------- after every refresh: what finished, then draw ----------
  function update() {
    const p = pl();
    if (!p) { renderBar(); renderDock(); return; }
    const now = p.steps.filter((s) => s.done).map((s) => s.id);
    // While Claude's turn runs, a step whose files just appeared isn't done for the creator yet: Claude may still be
    // checking it, writing the log or fixing what it found. Its green moment, the chat's ✓ line and "seen" wait for the
    // turn to end, so the strip goes Running → Done → Next (never Done → Running · finishing → Next).
    if (getP().busy) {
      prevDone = prevDone === null ? new Set(Array.isArray(p.seen) ? now.filter((x) => p.seen.includes(x)) : now) : new Set([...prevDone].filter((x) => now.includes(x)));
      if (green && !stepOf(green.id)?.done) { green = null; clearTimeout(greenTimer); }
      render();
      return;
    }
    let fresh = null;
    if (prevDone === null) {
      // First look on this page: a step that finished since the page last saw this project (the server says).
      if (p.finished) fresh = { ...p.finished };
    } else {
      const f = p.steps.filter((s) => s.done && !prevDone.has(s.id)).at(-1);
      if (f) fresh = { id: f.id, name: f.name, line: f.line || '', show: f.show };
    }
    if (fresh) showGreen(fresh);
    if (green && !stepOf(green.id)?.done) { green = null; clearTimeout(greenTimer); }
    prevDone = new Set(now);
    // Tell the server what this page has seen, so a reload doesn't turn the strip green for the same step again; the
    // server writes the chat log's done marker for each step that finished since it last heard.
    const seen = Array.isArray(p.seen) ? p.seen : null;
    if (!seen || seen.length !== now.length || now.some((x) => !seen.includes(x))) {
      p.seen = now;
      api(`${url}/rail`, { op: 'seen', done: now }).catch(() => {});
    }
    render();
  }
  function render() { renderBar(); renderDock(); fillPop(); fillMenu(); paintEmpties(); }

  // ---------- Show me ----------
  // The thing a step makes, on its tab: an element, or a lane of the canvas timeline (labels + lanes on one row).
  function target(t) {
    const pane = (k) => root.querySelector(`[data-pane=${k}]`);
    const lane = (k) => {
      const lh = pane('canvas')?.querySelector(`.tk-lh[data-k="${k}"]`), body = lh?.closest('.tk-body');
      return lh && body ? { scroll: lh, rect: () => { const a = lh.getBoundingClientRect(), b = body.getBoundingClientRect(); return { left: b.left, top: a.top, width: b.width, height: a.height }; } } : null;
    };
    const el = (x) => (x ? { scroll: x, rect: () => x.getBoundingClientRect() } : null);
    switch (t) {
      case 'picture': return el(pane('canvas')?.querySelector('.canvas-wrap') || pane('canvas'));
      case 'sections': return lane('band') || el(pane('canvas')?.querySelector('#blockStrip')) || el(pane('canvas')?.querySelector('.timeline'));
      case 'zooms': return lane('zooms') || el(pane('canvas')?.querySelector('.timeline'));
      case 'lock': return el(document.querySelector('#insOther .cp-lock')) || el(pane('cut'));
      case 'cut': return el(pane('cut')?.querySelector('iframe') || pane('cut')?.querySelector('.rail-empty') || pane('cut'));
      case 'scenes': return el(pane('scenes')?.querySelector('.s2-list') || pane('scenes')?.querySelector('.rail-empty') || pane('scenes'));
      case 'newest': return el(hooks.newestRender() || pane('renders'));
      case 'post': return el(pane('post')?.querySelector('.pk-cards') || pane('post'));
      default: return null;
    }
  }
  // stage: the stage that owns the step; Show me opens it (the pane its show.tab names), then outlines the thing there.
  function show(sh, name, isNew, stage = null) {
    if (!sh) return;
    closePop();
    hooks.setTab(sh.tab, stage);
    // Wait for the tab to draw (the canvas timeline lays its lanes out on its next frame).
    let tries = 0;
    const go = () => {
      const t = target(sh.target);
      const r = t?.rect();
      if ((!t || !r || r.width < 2 || r.height < 2) && tries++ < 20) return setTimeout(go, 80);
      if (!t) return toast(`Nothing to show yet: ${name} puts it ${SHOW_WHERE[sh.target] || 'here'}.`);
      // Into view with room around it (a lane of the timeline sits mid-screen, not on the edge).
      const box = t.rect(), seen = box.top >= 60 && box.top + box.height <= innerHeight - 8;
      if (!seen) t.scroll.scrollIntoView({ block: box.height < innerHeight * 0.6 ? 'center' : 'start', inline: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
      outline(t, isNew ? `New · from ${name}` : `${name} puts it here`);
    };
    requestAnimationFrame(() => requestAnimationFrame(go));
  }
  function outline(t, tag) {
    overlay?.stop();
    const o = h(`<div class="showme" aria-hidden="true"><span class="showme-tag">${esc(tag)}</span></div>`);
    document.body.append(o);
    let raf = 0, alive = true;
    const place = () => {
      if (!alive) return;
      const r = t.rect();
      // The thing went out of view (another stage opened, its pane hidden): the outline and its tag go with it, never
      // left over the top corner of the app.
      if (!r || (!r.width && !r.height)) { stop(); return; }
      Object.assign(o.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
      o.classList.toggle('tag-in', r.top < 40); // no room above it: the tag sits inside the outline
      raf = requestAnimationFrame(place);
    };
    const stop = () => { alive = false; cancelAnimationFrame(raf); o.remove(); if (overlay?.o === o) overlay = null; };
    const timer = setTimeout(() => { o.classList.add('out'); setTimeout(stop, reduced() ? 0 : 400); }, 4000);
    overlay = { o, stop: () => { clearTimeout(timer); stop(); } };
    place();
  }

  // ---------- empty states ----------
  // kind: scenes | renders | cut | post. why: the tab's own reason (shown small). opts.run: what the button does when
  // the step it names is the one that fills this tab (Post: write the kit right here).
  const FILL = {
    scenes: (ss) => ss.find((s) => s.show?.tab === 'scenes' && s.stage === 'Plan') || ss.find((s) => s.show?.tab === 'scenes'),
    renders: (ss) => ss.find((s) => s.show?.tab === 'renders'),
    cut: (ss) => ss.find((s) => s.show?.tab === 'cut' && !s.optional),
    post: (ss) => ss.find((s) => s.show?.tab === 'post') || ss.find((s) => s.show?.tab === 'renders'),
  };
  function empty(kind, why = '', opts = {}) {
    const p = pl();
    if (!p) return null;
    const fill = FILL[kind]?.(p.steps);
    const cur = current(), postStep = kind === 'post' && fill?.show?.tab === 'post', built = p.steps.some((s) => s.stage === 'Build' && s.done);
    const b = (s) => `<b>${esc(s?.name || '')}</b>`;
    const text = {
      scenes: fill ? `Scenes appear after ${b(fill)}. ${esc(fill.what)} Then you review them here.` : 'Scenes appear once Claude writes the scene plan (work/production.json).',
      renders: `Your video appears here after ${fill ? b(fill) : 'Claude builds it'}, or when you press Export.`,
      cut: fill ? `Before ${b(fill)} there is nothing to cut yet. ${esc(fill.what)} After it, the cuts Claude made are marked here and you can change them.` : 'Your cut shows here once the recording is transcribed.',
      // Worded from where the project is: a Build step done means the video is built.
      post: postStep ? `${built ? 'The video is built: ' : 'After the video is built, '}${b(fill)} fills this tab. ${esc(fill.what)}`
        : built ? `The video is built${fill?.done ? ` (${b(fill)} is done)` : ''}. Write the title, description and pinned comment with Claude here.`
        : `The title, description and pinned comment come after the video is built${fill ? ` (${b(fill)})` : ''}. Write them with Claude here.`,
    }[kind];
    const title = { scenes: 'No scenes yet', renders: 'Nothing rendered yet', cut: 'No cut yet', post: 'Nothing to post yet' }[kind];
    // The way there: the steps that must be done, from after Record up to the one that fills this tab.
    let path = [];
    if (fill) {
      const upto = p.steps.indexOf(fill);
      path = p.steps.slice(0, upto + 1).filter((s) => (!s.optional || s === fill) && s.stage !== 'Record');
      const doneLead = path.findIndex((s) => !s.done);
      if (path.length > 5 && doneLead > 1) path = [{ more: doneLead - 1 }, ...path.slice(doneLead - 1)];
    }
    const node = h(`<div class="rail-empty ${kind}">
      <div class="em-art ${kind}" aria-hidden="true"><i></i><i></i><i></i></div>
      <h3>${title}</h3>
      <p>${text}</p>
      ${why ? `<p class="sub em-why">${esc(why)}</p>` : ''}
      ${path.length ? '<div class="em-path" aria-label="The way there"></div>' : ''}
      <div class="em-acts"></div></div>`);
    node.__em = { fill, path, run: opts.run };
    paintEmpty(node);
    empties.add(node);
    return node;
  }
  // The way there and the button follow what Claude is doing (every render, and when a request starts or stops
  // waiting): while the step is running, the empty state says so ("Clean up is running · waiting for you in the chat")
  // instead of offering to start it again.
  const empties = new Set();
  const waitingHere = () => pending([id, `${id}.packaging`]);
  function paintEmpties() {
    for (const n of empties) { if (!n.isConnected) { if (n.__shown) empties.delete(n); continue; } n.__shown = true; paintEmpty(n); }
  }
  function paintEmpty(node) {
    const { fill, path, run: runOwn } = node.__em;
    if (!pl()) return;
    const cur = current(), rs = running(), asks = rs ? waitingHere() : [];
    const sig = JSON.stringify([path.map((s) => s.more || [s.id, stepOf(s.id)?.done]), cur?.id, rs?.id, asks.length]);
    if (node.__sig === sig) return;
    node.__sig = sig;
    // Each chip keeps its arrow, so a wrapped row never starts with one.
    const chips = path.map((s, k) => {
      const arrow = k < path.length - 1 ? '<i class="ep-ar" aria-hidden="true">→</i>' : '';
      if (s.more) return `<span class="ep-w"><span class="ep done">${ICON.tick}${s.more} done</span>${arrow}</span>`;
      const st = stepOf(s.id) || s;
      const c = st.done ? 'done' : rs && st.id === rs.id ? 'run' : st.id === cur?.id ? 'next' : 'todo';
      return `<span class="ep-w"><span class="ep ${c}">${c === 'done' ? ICON.tick : c === 'run' ? '<span class="spin" aria-hidden="true"></span>' : '<i aria-hidden="true"></i>'}${esc(st.name)}<span class="vh">${{ done: ' (done)', next: ' (next)', run: ' (running)' }[c] || ''}</span></span>${arrow}</span>`;
    }).join('');
    const pathBox = node.querySelector('.em-path');
    if (pathBox) pathBox.innerHTML = chips;
    const own = cur && fill && cur.id === fill.id && runOwn;
    const acts = node.querySelector('.em-acts');
    acts.innerHTML = rs
      ? `<p class="em-run" role="status"><span class="spin" aria-hidden="true"></span><span><b>${esc(rs.name)}</b> is running${asks.length ? ' · waiting for you in the chat' : ''}</span></p>${asks.length ? '<button type="button" class="nc-run" data-a="em-answer">Answer in the chat</button>' : ''}`
      : cur ? `<button type="button" class="nc-run" data-a="em-run">${ICON.play}${esc(own ? cur.name : `Next: ${cur.name}`)}</button>` : '';
    acts.append(h('<button type="button" class="nc-link" data-a="em-help">How the steps work</button>'));
    $('[data-a=em-run]', acts)?.addEventListener('click', () => (own ? (dismissDone(), runOwn()) : run(cur, 'empty')));
    $('[data-a=em-answer]', acts)?.addEventListener('click', () => waitingHere()[0]?.focus?.());
    $('[data-a=em-help]', acts).onclick = () => openHelp(true);
  }
  const unlistenWait = onAttention(() => { paintEmpties(); paintState(); });

  // ---------- first-time help ----------
  function maybeHelp() {
    const st = hooks.status();
    if (!pl() || helpOpen || st?.help?.stepsIntro === 'dismissed') return;
    openHelp(false);
  }
  function openHelp(again) {
    const p = pl();
    if (!p) return;
    closePop();
    const modal = $('#modal');
    if (!modal) return;
    helpOpen = true;
    const cur = current();
    const cards = p.stages.map((st, k) => {
      const ss = st.steps.map(stepOf).filter(Boolean), c = st.current ? 'next' : st.done ? 'done' : 'todo';
      return `<div class="ft-card ${c}"><span class="ft-n" aria-hidden="true">${c === 'done' ? ICON.tick : k + 1}</span><b>${esc(st.name)}</b><i>${esc(st.title)}</i><p>${esc(st.what)}</p>
        <ul class="ft-steps" aria-label="${esc(st.name)} steps">${ss.map((s) => `<li class="${s.done ? 'done' : s === cur ? 'next' : ''}">${esc(s.name)}${s.optional ? ' <em>optional</em>' : ''}</li>`).join('')}</ul>
        <span class="vh">${c === 'done' ? 'Done.' : c === 'next' ? 'Next.' : ''}</span></div>`;
    }).join('');
    const d = h(`<div class="dialog rail-first" role="dialog" aria-modal="true" aria-labelledby="rfT" aria-describedby="rfD">
      <div class="ft-head"><h2 id="rfT">How a video gets made here</h2><p id="rfD">The stages, left to right (Package is optional: do it now, later or never). Click a stage at the top to open its workspace, any time, even while Claude works; its ▾ lists its steps. The stage with the step that’s next says NEXT, and the step waits just above the message box: press Run and Claude does the work in the chat on the left, then tells you what changed and where.</p></div>
      <div class="ft-row">${cards}</div>
      <div class="ft-acts"><span class="ft-note">${again ? 'The' : 'This shows once. The'} <span class="ft-q">${ICON.help}</span> next to the stages brings ${again ? 'this back any time' : 'it back'}.</span><span class="gap"></span>
        <button type="button" class="btn ft-skip" data-a="ok">Got it</button>${cur ? `<button type="button" class="nc-run" data-a="start">${ICON.play}Start: ${esc(cur.name)}</button>` : ''}</div></div>`);
    modal.replaceChildren(d); modal.hidden = false;
    const back = document.activeElement;
    const close = (start) => {
      if (modal.hidden || !helpOpen) return;
      helpOpen = false;
      modal.hidden = true; modal.replaceChildren(); modal.onclick = null;
      document.removeEventListener('keydown', onKey, true);
      saveSeen();
      if (start && cur) run(cur, 'help'); else back?.focus?.({ preventScroll: true });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
      if (e.key === 'Tab') { // keep focus inside the dialog
        const f = [...d.querySelectorAll('button')], i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f.at(-1).focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    modal.onclick = (e) => { if (e.target === modal) close(false); };
    $('[data-a=ok]', d).onclick = () => close(false);
    $('[data-a=start]', d)?.addEventListener('click', () => close(true));
    $('[data-a=ok]', d).focus(); // not Start: a stray Enter must not send a step to Claude
  }
  async function saveSeen() {
    const st = hooks.status();
    if (st?.help?.stepsIntro === 'dismissed') return;
    if (st) st.help = { ...(st.help || {}), stepsIntro: 'dismissed' };
    try { await api('/api/app/settings', { section: 'help', values: { stepsIntro: 'dismissed' } }); } catch (e) { toast(e.message); }
  }

  const onResize = () => { fit(); if (pop && popFor) placePop(anchorOf(popFor)); if (menu) placeMenu(); };
  addEventListener('resize', onResize);
  return {
    bar, dock, update, render, fit, show, empty, marker, maybeHelp, openHelp, dismissDone, closePop,
    destroy: () => {
      closePop(); closeMenu(); clearTimeout(longPress); overlay?.stop(); removeEventListener('resize', onResize); unlistenSheet(); dockRO?.disconnect(); clearTimeout(greenTimer); clearInterval(ticker); unlistenWait(); empties.clear();
      if (helpOpen) { const m = $('#modal'); m.hidden = true; m.replaceChildren(); helpOpen = false; }
    },
  };
}

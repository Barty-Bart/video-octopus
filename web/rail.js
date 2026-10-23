// Step rail v2, variant A, with the next step docked on the
// message box.
// Every word comes from the steps themselves (core/pipelines.json: stage, name, what, where, show; the done line
// from the server), so the five stage chips in the bar, a stage's list of steps, the dock strip and its sheet, the
// chat's done markers, the empty states and the first-time help all say the same thing.
// - Bar: Record · Cut · Plan · Build · Polish. The stage of the step that's next is lit and says "Next: <step>" (the
//   line drops below ~1280 px, then the segments), one segment per step (green done, accent next, dashed optional).
//   A chip opens its stage's steps: what each does, where it shows, Run / Skip / Undo skip / Show me.
// - Dock: a slim strip on the top edge of the message box, "Next · <step> · ⓘ · ▶ Run"; ⓘ opens it upwards into the
//   step's words ("Step 3 of 9 · Cut", what it does, "You'll see it: …" with Show me where, the stage's checklist).
//   While a step runs it says so ("Clean up · Rough cut, 2 of 3") and the composer says "Claude is working on <step>".
// - Done: when a step goes from not done to done while the page is open, or since the page last looked (the server
//   keeps what it last saw), the strip turns green for about 4 s with the step's line and Show me, and the chat keeps a
//   one-line marker of it (the server writes it into the chat log).
// - Show me: switches the tab, scrolls, and outlines the thing in the selection colour with "New · from <step>".
// - Empty states for Scenes, Renders, Cut, Post (the Sections band draws its own, web/blocks.js), and the first-time
//   help (once, saved in settings as help.stepsIntro; the ? next to the stages opens it again).
import { $, h, esc, api, toast } from './ui.js';

const ICON = {
  tick: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2l2.4 2.4 4.6-5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true"><path d="M1 1l7 4-7 4z" fill="currentColor"/></svg>',
  eye: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1.5 7s2-4 5.5-4 5.5 4 5.5 4-2 4-5.5 4-5.5-4-5.5-4z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="7" cy="7" r="1.8" fill="currentColor"/></svg>',
  help: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6.3 6.3a1.8 1.8 0 1 1 2.5 1.6c-.5.3-.8.6-.8 1.2v.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.4" r=".8" fill="currentColor"/></svg>',
  x: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.2v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".9" fill="currentColor"/></svg>',
};
// Where Show me goes, in words, by its target.
const SHOW_WHERE = { sections: 'on the timeline', zooms: 'on the timeline', picture: 'on the canvas', cut: 'in the Cut tab', lock: 'in the Cut tab', scenes: 'in Scenes', newest: 'in Renders', post: 'in the Post tab' };
const showLabel = (show) => `Show me ${SHOW_WHERE[show?.target] || { packaging: 'in Packaging', canvas: 'on the canvas', cut: 'in the Cut tab', scenes: 'in Scenes', renders: 'in Renders', post: 'in the Post tab' }[show?.tab] || 'where'}`;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// hooks: runStep(step), setTab(tab), applyNotes() (Save changes → Claude), openCutList() (what Clean up left for you),
// newestRender() (selects it on the Renders tab), learn(), status() → /api/status (help), composer(<the running step's
// name> | null) → the message box says so and holds what you send until it finishes.
export function makeRail({ root, id, getP, hooks }) {
  let barHost = null, pop = null, popFor = null, overlay = null;
  let prevDone = null, barSig = '', helpOpen = false;
  const url = `/api/projects/${encodeURIComponent(id)}`;
  const pl = () => getP().pipeline;
  const stepOf = (sid) => pl()?.steps.find((s) => s.id === sid) || null;
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
  function run(s) {
    if (!s) return;
    dismissDone();
    if (sendNotes(s)) return hooks.applyNotes();
    hooks.runStep(s);
  }
  async function railOp(body) {
    try { getP().pipeline = await api(`${url}/rail`, body); } catch (e) { toast(e.message); return; }
    render();
  }
  const skip = (s, on = true) => railOp({ op: on ? 'skip' : 'unskip', step: s.id });

  // ---------- the bar: five stage chips ----------
  function stageState(st) {
    if (st.current) return 'cur';
    return st.done ? 'done' : 'todo';
  }
  function dotOf(s, cur, runningStep) {
    const c = s.done ? 'done' : s === runningStep ? 'run' : s.skipped ? 'skip' : s === cur ? 'next' : 'todo';
    return `<i class="d ${c}${s.optional ? ' opt' : ''}" title="${esc(`${s.name}${s.optional ? ' (optional)' : ''}: ${s.done ? 'done' : s.skipped ? 'skipped' : s === cur ? 'next' : 'to do'}`)}"></i>`;
  }
  function renderBar() {
    if (!barHost?.isConnected) return;
    const P = getP(), p = P.pipeline;
    if (!p) return;
    const cur = current(), rs = running(), sc = P.scenes?.count ? P.scenes : null, nd = needs();
    const sig = JSON.stringify([p.steps.map((s) => [s.id, s.done, s.skipped, s.name]), p.current, rs?.id, rs && runText(rs), sc && [sc.approved, sc.count, sc.of], nd, popFor]);
    if (sig === barSig && barHost.querySelector('.stages')) return fit();
    barSig = sig;
    const focused = document.activeElement?.closest?.('.stg')?.dataset.stage;
    const chips = p.stages.map((st, k) => {
      const ss = st.steps.map(stepOf).filter(Boolean), state = stageState(st);
      const nDone = ss.filter((s) => s.done).length;
      const isCur = state === 'cur' && cur;
      const xline = isCur ? (rs && rs.stage === st.name ? (rs.subs ? `${rs.name} · ${Math.min(rs.subs.length, rs.subs.filter((x) => x.done).length + 1)} of ${rs.subs.length}` : `Running: ${rs.name}`) : `Next: ${cur.name}`) : '';
      const pill = st.name === 'Polish' && sc ? `<span class="stg-pill" title="${sc.approved} of ${sc.of ?? sc.count} scenes approved in Scenes"><span class="pl-f">${sc.approved} of ${sc.of ?? sc.count} approved</span><span class="pl-s">${sc.approved}/${sc.of ?? sc.count}</span></span>` : '';
      const warn = st.name === 'Cut' && nd ? `<span class="stg-warn" title="${nd} thing${nd > 1 ? 's' : ''} Clean up left for you to hear, in the Cut tab">${nd}</span>` : '';
      const label = `${st.name}: ${ss.length ? `${nDone} of ${ss.length} step${ss.length > 1 ? 's' : ''} done` : 'no steps in this format'}${isCur ? `. ${xline}` : ''}${pill ? `. ${sc.approved} of ${sc.of ?? sc.count} scenes approved` : ''}${warn ? `. ${nd} need${nd > 1 ? '' : 's'} you` : ''}`;
      return `${k ? '<i class="stg-sep" aria-hidden="true"></i>' : ''}<button type="button" class="stg ${state}${ss.length ? '' : ' none'}" data-stage="${esc(st.name)}" aria-haspopup="dialog" aria-expanded="${popFor === st.name}" aria-label="${esc(label)}">
        <span class="st-n">${state === 'done' ? ICON.tick : ''}<span class="st-t">${esc(st.name)}</span>${warn}${pill}</span>
        ${isCur ? `<span class="st-x">${rs && rs.stage === st.name ? '<span class="spin" aria-hidden="true"></span>' : ''}${esc(xline)}</span>` : ''}
        <span class="dots" aria-hidden="true">${ss.map((s) => dotOf(s, cur, rs)).join('')}</span></button>`;
    }).join('');
    const group = h(`<div class="stages" role="group" aria-label="${esc(`${p.format}: ${p.steps.filter((s) => s.done).length} of ${p.steps.length} steps done`)}">${chips}</div>`);
    const help = h(`<button type="button" class="rail-help" aria-label="How the steps work" title="How the steps work">${ICON.help}</button>`);
    help.onclick = () => openHelp(true);
    const more = barHost.querySelector('.rail-more');
    barHost.replaceChildren(group, help, ...(more ? [more] : []));
    group.querySelectorAll('.stg').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); togglePop(b.dataset.stage, b); };
      b.onkeydown = (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const all = [...group.querySelectorAll('.stg')], i = all.indexOf(b);
        all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length].focus();
        e.preventDefault();
      };
    });
    if (focused) group.querySelector(`.stg[data-stage="${CSS.escape(focused)}"]`)?.focus();
    fit();
    if (pop && popFor) placePop(group.querySelector(`.stg[data-stage="${CSS.escape(popFor)}"]`));
  }
  function bar(host, more) {
    barHost = host;
    barSig = '';
    host.replaceChildren(...(more ? [more] : []));
    renderBar();
  }
  // Fit the bar: the "Next:" line goes first (always below ~1280 px), then the project name gives room, then the
  // segments, then the chips tighten.
  function fit() {
    const g = barHost?.querySelector('.stages'), crumbs = $('#crumbs'), barEl = $('.bar');
    if (!g || !crumbs || !barEl) return;
    crumbs.style.maxWidth = '';
    const over = () => barHost.scrollWidth > barHost.clientWidth + 1 || g.scrollWidth > g.clientWidth + 1;
    for (const t of [0, 1, 2, 3, 4]) {
      if (t === 0 && innerWidth < 1280) continue;
      if (t === 2) crumbs.style.maxWidth = `${Math.max(160, crumbs.offsetWidth - (barHost.scrollWidth - barHost.clientWidth) - 8)}px`;
      g.dataset.fit = String(t);
      barEl.classList.toggle('tight', t >= 2);
      if (!over()) break;
    }
  }

  // ---------- a stage's steps (the popover under a chip) ----------
  function togglePop(name, chip) {
    if (popFor === name) return closePop(true);
    closePop();
    popFor = name;
    chip.setAttribute('aria-expanded', 'true');
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
        if (state === 'done' && s.show) acts.push(`<button type="button" class="btn ghost small" data-a="show" data-s="${esc(s.id)}">${ICON.eye}Show me</button>`);
        if (state === 'done') acts.push(`<button type="button" class="btn ghost small" data-a="again" data-s="${esc(s.id)}">${s.kind === 'app' || s.id === 'post-kit' ? 'Open' : 'Run again'}</button>`);
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
      closePop();
      if (a === 'show') return show(s.show, s.name, true);
      if (a === 'again' && s.kind !== 'app' && s.id !== 'post-kit' && !confirm(`Run “${s.name}” again?`)) return;
      run(s);
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
    const chip = barHost?.querySelector(`.stg[data-stage="${CSS.escape(name)}"]`);
    chip?.setAttribute('aria-expanded', 'false');
    if (refocus) chip?.focus();
  }
  const outside = (e) => { if (pop && !pop.contains(e.target) && !e.target.closest?.('.stg')) closePop(); };
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
  let dockHost = null, dockSig = '', dockRO = null, sheetOpen = false, green = null, greenTimer = 0, hovering = false, ticker = 0, lastRun = null;
  const GREEN_MS = 4000;
  // A label in three lengths; the strip shows the one its fit level allows (data-fit 0 full, 1 short, 2 and up shortest).
  const lbl = (full, short = full, tiny = short) => `<span class="l0">${esc(full)}</span><span class="l1">${esc(short)}</span><span class="l2">${esc(tiny)}</span>`;
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
    const cur = current(), nd = needs(), mode = green ? 'done' : rs ? 'run' : cur ? 'next' : 'all';
    if (mode === 'done' && sheetOpen) { sheetOpen = false; unlistenSheet(); }
    const notes = cur && sendNotes(cur) ? P.scenes.open : 0;
    // Every step done but changes still waiting in the package (the same count Home shows): the strip says so.
    const waiting = mode === 'all' ? P.scenes?.open || 0 : 0;
    const uf = mode === 'next' || mode === 'all' ? P.unfinished || null : null;
    paintUnfinished(uf, cur);
    const sig = JSON.stringify([mode, cur?.id, rs && runText(rs), nd, green, notes, waiting, sheetOpen, p.steps.map((s) => [s.id, s.done, s.skipped]), Boolean(P.runningAt)]);
    clearInterval(ticker); ticker = 0;
    if (mode === 'run' && !rs.subs?.length && P.runningAt) ticker = setInterval(() => { const t = dockHost?.querySelector('.dk-time'); if (t) t.textContent = elapsed(); }, 1000);
    if (sig === dockSig) return fitDock();
    dockSig = sig;
    const focusA = dockHost.contains(document.activeElement) ? document.activeElement.dataset?.a : null;
    let html;
    if (mode === 'done') {
      html = `<div class="dk-strip ok"><span class="dk-ok" aria-hidden="true">${ICON.tick}</span>
        <span class="dk-name"><span class="vh">Done: </span><b>${esc(green.name)}</b><span class="dk-sub"> · ${esc(green.line || 'done')}</span></span>
        ${green.show ? `<button type="button" class="dk-show" data-a="show" aria-label="${esc(`${showLabel(green.show)}: ${green.name}`)}">${ICON.eye}Show me</button>` : ''}</div>`;
    } else if (mode === 'run') {
      const subs = rs.subs || [], k = subs.findIndex((x) => !x.done);
      const sub = subs.length ? (k < 0 ? 'finishing' : `${subs[k].label}, ${k + 1} of ${subs.length}`) : '';
      const prog = subs.length ? `<span class="dk-prog" aria-hidden="true">${subs.map((x, i) => `<i class="${x.done ? 'd' : i === k ? 'r' : ''}"></i>`).join('')}</span>`
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
      case 'run': return run(cur);
      case 'skip': return cur && skip(cur);
      case 'pre': return run(cur && before(cur));
      case 'needs': return hooks.openCutList();
      case 'info': return sheetOpen ? closeSheet(true) : openSheet();
      case 'close': return closeSheet(true);
      case 'where': return s && show(s.show, s.name, false);
      case 'show': return green && show(green.show, green.name, true);
      case 'renders': return hooks.setTab('renders');
      case 'send': return hooks.applyNotes();
      case 'learn': return hooks.learn();
      case 'help': return openHelp(true);
      case 'read': return hooks.readReply?.(getP().unfinished?.ts || null);
      case 'unf-ok': getP().unfinished = null; renderDock(); return railOp({ op: 'unfinished-ok' });
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
    if (d.show?.tab) hooks.glowTab?.(d.show.tab, `new from ${d.name}`);
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
    n.querySelector('.mk-show')?.addEventListener('click', () => show(ev.show, ev.text || '', true));
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
  function render() { renderBar(); renderDock(); fillPop(); }

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
  function show(sh, name, isNew) {
    if (!sh) return;
    closePop();
    hooks.setTab(sh.tab);
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
      Object.assign(o.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
      o.classList.toggle('tag-in', r.top < 40); // no room above it: the tag sits inside the outline
      raf = requestAnimationFrame(place);
    };
    place();
    const stop = () => { alive = false; cancelAnimationFrame(raf); o.remove(); if (overlay?.o === o) overlay = null; };
    const timer = setTimeout(() => { o.classList.add('out'); setTimeout(stop, reduced() ? 0 : 400); }, 4000);
    overlay = { o, stop: () => { clearTimeout(timer); stop(); } };
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
    // Each chip keeps its arrow, so a wrapped row never starts with one.
    const chips = path.map((s, k) => {
      const arrow = k < path.length - 1 ? '<i class="ep-ar" aria-hidden="true">→</i>' : '';
      if (s.more) return `<span class="ep-w"><span class="ep done">${ICON.tick}${s.more} done</span>${arrow}</span>`;
      const c = s.done ? 'done' : s === cur ? 'next' : 'todo';
      return `<span class="ep-w"><span class="ep ${c}">${c === 'done' ? ICON.tick : '<i aria-hidden="true"></i>'}${esc(s.name)}<span class="vh">${c === 'done' ? ' (done)' : c === 'next' ? ' (next)' : ''}</span></span>${arrow}</span>`;
    }).join('');
    const own = cur && cur === fill && opts.run;
    const node = h(`<div class="rail-empty ${kind}">
      <div class="em-art ${kind}" aria-hidden="true"><i></i><i></i><i></i></div>
      <h3>${title}</h3>
      <p>${text}</p>
      ${why ? `<p class="sub em-why">${esc(why)}</p>` : ''}
      ${chips ? `<div class="em-path" aria-label="The way there">${chips}</div>` : ''}
      <div class="em-acts">${cur ? `<button type="button" class="nc-run" data-a="em-run">${ICON.play}${esc(own ? cur.name : `Next: ${cur.name}`)}</button>` : ''}<button type="button" class="nc-link" data-a="em-help">How the steps work</button></div></div>`);
    $('[data-a=em-run]', node)?.addEventListener('click', () => (own ? (dismissDone(), opts.run()) : run(cur)));
    $('[data-a=em-help]', node).onclick = () => openHelp(true);
    return node;
  }

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
      <div class="ft-head"><h2 id="rfT">How a video gets made here</h2><p id="rfD">The stages, left to right (Package is optional: do it now, later or never). The step that’s next is lit at the top and waits just above the message box: press Run and Claude does the work in the chat on the left, then tells you what changed and where.</p></div>
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
      if (start && cur) run(cur); else back?.focus?.({ preventScroll: true });
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

  const onResize = () => { fit(); if (pop && popFor) placePop(barHost?.querySelector(`.stg[data-stage="${CSS.escape(popFor)}"]`)); };
  addEventListener('resize', onResize);
  return {
    bar, dock, update, render, fit, show, empty, marker, maybeHelp, openHelp, dismissDone, closePop,
    destroy: () => {
      closePop(); overlay?.stop(); removeEventListener('resize', onResize); unlistenSheet(); dockRO?.disconnect(); clearTimeout(greenTimer); clearInterval(ticker);
      if (helpOpen) { const m = $('#modal'); m.hidden = true; m.replaceChildren(); helpOpen = false; }
    },
  };
}

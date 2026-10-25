// The Cut tab's inspector: what is
// selected in the Cut Editor (the words, how long, Cut it / Bring back, Play, and why Claude cut it), what is in this
// cut (raw → cut, cuts by kind, what still needs your ear, flagged joins), the Keep / Cut list of what Prepare left for
// your ear, and "Save and lock the cut" (the rail's Lock step).
// The Cut Editor (web/cut-editor/, on this same address) is framed with ?theme=studio: it posts its selection and cut
// here (studio:cut-state), and every button here posts it back an edit to make (studio:cut-do), so its undo, autosave
// and the change package work as for any edit made in the page. Which asks are decided is kept by the server in
// work/cut_review.json (server/cutreview.mjs).
// Shots: the editor shows a "/" where each shot starts (studio:shots); "/" typed with a word
// selected, a "/" picked, deleted or dragged come back as studio:shot-* and go to the shots controller; the selection
// section has a "/ New shot here" button.
import { $, esc, h, api, toast, clock, plural, cutWord } from './ui.js';
import { onAppearance, cutLook } from './appearance.js';

const KINDS = [['Pause', 'Pauses'], ['Filler', 'Fillers'], ['Retake', 'Retakes'], ['Stutter', 'Stutters']];
const kindGroup = (k) => (k === 'Sound' ? 'Filler' : k);
const len = (R) => R.reduce((s, [a, b]) => s + (b - a), 0);
function overlap(R, segs) {
  let k = 0;
  for (const [a, b] of R) for (const [p, q] of segs) { if (q <= a) continue; if (p >= b) break; k += Math.min(b, q) - Math.max(a, p); }
  return k;
}
// take seconds → seconds in the cut
function toCut(t, segs) {
  let d = 0;
  for (const [a, b] of segs) { if (t < a) return d; if (t < b) return d + t - a; d += b - a; }
  return d;
}
// Claude's notes on its cuts name moments in take seconds ("keeps the later take at 105.8s"): on the cut's clock here,
// like every time the creator reads (a duration, "pause 2.3s", stays as it is).
const atCut = (text, segs) => String(text || '').replace(/\bat (\d+(?:\.\d+)?) ?s\b/g, (m, n) => (segs?.length ? `at ${clock(toCut(Number(n), segs))}` : m));

// The Cut Editor's page is in the frame: until it loads, the frame holds a blank page, and a message would go to that.
export function editorThere(frame) {
  try { return /\/cut-editor\/$/.test(frame.contentWindow.location.pathname); } catch { return false; }
}

export function makeCutPanel({ id, getP, runLock, shots = null }) {
  const url = `/api/projects/${encodeURIComponent(id)}/cut-review`;
  let box = null, root = null, frame = null, editorUrl = null;
  let rv = null, live = null, view = 'main', filter = 'check', cur = null, loadAt = 0, loadTimer = null, flushDone = null, lastHTML = '';
  let ready = false; // the editor said studio:cut-ready
  let pending = null; // a Keep or Cut pressed while the editor was still opening: made as soon as it says it's ready

  // ---- talking to the Cut Editor ----
  function post(m) {
    if (!frame?.contentWindow || !frame.isConnected || !editorThere(frame)) return false;
    try { frame.contentWindow.postMessage(m, location.origin); return true; } catch { return false; }
  }
  // An edit for the editor to make; false (with a note) while it isn't there to make it.
  function ask(m) {
    if (ready && post(m)) return true;
    toast('The Cut Editor is still opening.');
    return false;
  }
  // Settings → Appearance's look, for the editor to follow (it opened in the look its address carried).
  // Only once the editor is there (studio:cut-ready sends it then): before, the frame still holds a blank page.
  const sendLook = () => ready && post({ type: 'studio:look', look: cutLook() });
  const offLook = onAppearance(sendLook);
  // A locked cut is read-only (B3): the editor shows "Cut locked · Unlock to edit" and makes no edits; this panel hides
  // the flagged joins and offers Unlock. Locked = the Lock step is done (an edit by Claude since, or Unlock, undoes it).
  const lockStep = () => getP().pipeline?.steps.find((x) => x.id === 'lock') || null;
  const isLocked = () => Boolean(lockStep()?.done) && !unlocking;
  let unlocking = false, sentLock = null;
  const sendLock = () => { if (!ready) return; const on = isLocked(); if (on !== sentLock && post({ type: 'studio:lock', locked: on })) sentLock = on; };
  async function unlock() {
    if (!isLocked()) return;
    if (!confirm('Unlock the cut to edit it?\n\nLock the cut becomes the next step again: lock it after your changes, and Claude checks every join.')) return;
    unlocking = true; sendLock(); lastHTML = ''; paint();
    try { rv = await api(url, { op: 'unlock' }); toast('Unlocked: edit the cut, then lock it again.'); }
    catch (e) { unlocking = false; toast(e.message); }
    sendLock(); lastHTML = ''; paint();
  }
  const sendReview = () => rv && post({ type: 'studio:cut-review', items: rv.items.filter((it) => it.group === 'ask').map((it) => ({ a: it.a, b: it.b, join: it.kind === 'Join', done: Boolean(it.decision) })) });
  function onMessage(m) {
    if (!m || typeof m.type !== 'string') return false;
    if (m.type === 'studio:cut-ready') {
      ready = true; sentLock = null; sendReview(); sendLook(); sendLock(); shots?.sendCut();
      const p = pending, it = p && rv?.items.find((x) => x.key === p.key); pending = null;
      if (it) decide(it, p.d);
      return true;
    }
    if (typeof m.type === 'string' && m.type.startsWith('studio:shot-')) {
      // where the "/" is on this page (the frame's place plus its place in the frame), for the transition popover
      const fr = frame?.getBoundingClientRect(), r = m.rect;
      const at = fr && r && [r.x, r.y, r.h].every(Number.isFinite) ? { x: fr.left + r.x, y: fr.top + r.y + r.h } : null;
      shots?.fromCut(m, at);
      return true;
    }
    if (m.type === 'studio:cut-state') { live = m; followUndo(); paint(); return true; }
    if (m.type === 'studio:cut-unlock') { unlock(); return true; }
    if (m.type === 'studio:cut-flushed') { flushDone?.(m.ok); flushDone = null; return true; }
    return false;
  }
  // Save whatever the page hasn't saved yet (it autosaves a second after each change). true / false, or null: no answer.
  function flush() {
    if (!ready || !post({ type: 'studio:cut-do', op: 'save' })) return Promise.resolve(true); // not open yet: nothing unsaved
    return new Promise((done) => { const t = setTimeout(() => { flushDone = null; done(null); }, 6000); flushDone = (ok) => { clearTimeout(t); done(ok); }; });
  }

  // ---- the data ----
  async function load() {
    loadAt = Date.now();
    try { rv = await api(url); sendReview(); paint(); } catch {}
  }
  const segs = () => live?.segments || rv?.segments || [];
  // Cut: a good part of what Claude's cut removes is gone (a cut pause keeps a little of itself, and the rough cut
  // lands on frames). Kept: the part itself is there (a retake counts as kept with its own cut pause still out).
  // Measured on the part itself, without the pauses Claude cut inside it (it.keep).
  const stateOf = (it) => {
    const S = segs(), K = it.keep.length ? it.keep : it.cut, L = len(K);
    if (!L) return null;
    const gone = L - overlap(K, S);
    if (gone >= Math.max(0.03, 0.3 * Math.min(it.saved || L, L))) return 'cut';
    return gone <= 0.1 * L ? 'kept' : 'mixed';
  };
  const lists = () => {
    const items = rv?.items || [];
    return { check: items.filter((it) => it.group === 'ask' && !it.decision), done: items.filter((it) => it.decision), auto: items.filter((it) => it.group === 'auto' && !it.decision) };
  };

  // ---- drawing ----
  function render(el) {
    box = el;
    if (!root || !box.contains(root)) { root = h('<div class="ins-body cutp"></div>'); box.replaceChildren(root); lastHTML = ''; }
    paint();
    // Each project refresh (a file changed) may have changed the review: reload, but not more than every second.
    clearTimeout(loadTimer);
    loadTimer = setTimeout(load, Date.now() - loadAt > 1000 ? 0 : 1000);
  }
  // Only when something changed (the page sends its state several times a second while you drag), keeping the scroll.
  function setHTML(html) {
    if (html === lastHTML) return false;
    const sc = box.closest('.inspector'), top = sc?.scrollTop || 0;
    root.innerHTML = html; lastHTML = html;
    if (sc) sc.scrollTop = top;
    return true;
  }
  function paint() {
    if (!root || !root.isConnected) return;
    const P = getP();
    // The pipeline says the lock no longer holds (the Unlock went through, or Claude changed the cut): back to editing.
    if (unlocking && !lockStep()?.done) unlocking = false;
    sendLock();
    if (!P.cut?.ready) { setHTML(`<div class="ins-head"><b>Cut</b></div><section><p class="sub">${esc(P.cut?.why || 'The Cut Editor isn’t ready yet.')}</p></section>`); return; }
    if (view === 'list') return paintList();
    if (setHTML(`<div class="ins-head"><b>Cut</b>${editorUrl ? `<a class="btn ghost small cp-own" href="${esc(editorUrl)}" target="_blank" rel="noopener" title="The Cut Editor in its own browser window (its own look, saves on Save / ⌘S)">Own window ↗</a>` : ''}</div>
      ${selectionHTML()}${countsHTML()}${lockHTML()}
      <section class="cp-files"><details><summary>Files</summary><dl class="facts"><dt>Opened</dt><dd>${esc(rv?.file || P.cut.edl)}</dd><dt>Words</dt><dd>${esc(P.cut.words)}</dd><dt>Cut</dt><dd>${esc(P.cut.edl)}</dd><dt>Save writes</dt><dd>${esc(P.cut.out)}</dd>${P.cut.joins ? `<dt>Joins</dt><dd>${esc(P.cut.joins)}</dd>` : ''}${P.export?.cut ? `<dt>${esc(cutWord(P.export.cut))}</dt><dd>${esc(P.export.cut.file)} · ${plural(P.export.cut.count, 'part')} · ${clock(P.export.cut.duration)}</dd>` : ''}</dl>
        <p class="sub">Delete words to cut them, or drag on the waveform for an exact range. <b>N</b> jumps to the next flagged join. Each change saves itself to ${esc(P.cut.out)} about a second later (⌘Z undoes it).</p></details></section>`)) wireMain();
  }

  function selectionHTML() {
    const s = live?.sel;
    if (!s) return `<section class="cp-sel"><h3>Selection</h3><p class="sub">Nothing selected. Click a word, drag across words, or drag on the waveform.</p></section>`;
    const range = s.state === 'cut' ? `Cut · take ${clock(s.a)} – ${clock(s.b)}` : `${clock(s.ea)} – ${clock(s.eb)}${s.state === 'mixed' ? ' · partly cut' : ''}`;
    const cutB = '<button class="btn dark" data-a="cut-sel">Cut it <kbd>⌫</kbd></button>', backB = `<button class="btn${s.state === 'cut' ? ' dark' : ''}" data-a="restore-sel">Bring back <kbd>R</kbd></button>`;
    const acts = isLocked() ? '' : s.state === 'kept' ? cutB : s.state === 'cut' ? backB : cutB + backB;
    const why = whyHTML(s);
    // A new shot before the first selected word (the "/" in the transcript does the same).
    const shotB = shots && s.words && !isLocked() ? `<button class="btn cp-shot" data-a="shot-here" title="A new shot starts at this word (or type / in the transcript)"><kbd>/</kbd>New shot here</button>` : '';
    return `<section class="cp-sel"><h3>Selection</h3>
      <div class="cp-big">${s.words ? plural(s.words, 'word') : 'No words'} · ${s.len.toFixed(1)} s</div>
      <div class="cp-range">${esc(range)}</div>
      ${s.text ? `<p class="cp-words" title="${esc(s.text)}">“${esc(s.text)}”</p>` : ''}
      <div class="cp-acts${s.state === 'mixed' ? ' three' : ''}">${acts}<button class="btn" data-a="play-sel">Play</button></div>
      ${shotB}${why}</section>`;
  }
  // Why Claude cut (or asked about) what is selected, from work/cuts.json and the join check.
  function whyHTML(s) {
    if (!rv) return '';
    const sl = s.b - s.a, out = [];
    for (const c of rv.cuts) {
      const o = Math.min(s.b, c.b) - Math.max(s.a, c.a);
      if (o <= 0 || o < 0.5 * Math.min(sl, c.b - c.a)) continue;
      const it = rv.items.find((x) => x.key === `c${c.id}`);
      const head = c.action === 'cut' ? `Claude cut this · ${c.kind.toLowerCase()}` : `Claude asked about this · ${c.kind.toLowerCase()}`;
      const said = it?.decision ? ` You chose ${it.decision === 'keep' ? 'Keep' : 'Cut'}.` : '';
      out.push(`<b>${esc(head)}</b>${esc(c.note ? `: ${atCut(c.note, segs())}` : c.text ? `: ${c.text}` : '')}${esc(said)}`);
      if (out.length >= 2) break;
    }
    for (const j of rv.joins) if ((j.in >= s.a - 0.2 && j.in <= s.b + 0.2) || (j.out >= s.a - 0.2 && j.out <= s.b + 0.2)) { out.push(`<b>Join ${esc(j.status)}</b>: ${esc(j.why)}`); break; }
    return out.length ? `<div class="cp-why">${out.map((x) => `<p>${x}</p>`).join('')}</div>` : '';
  }

  function countsHTML() {
    const S = segs(), dur = live?.duration || rv?.duration || 0, cutLen = live?.length ?? len(S);
    const by = Object.fromEntries(KINDS.map(([k]) => [k, 0]));
    let mine = 0;
    if (rv) {
      for (const it of rv.items) if (it.key[0] === 'c' && stateOf(it) === 'cut') { const g = kindGroup(it.kind); if (g in by) by[g]++; }
      // Cut regions that none of Claude's cuts covers: cut by hand.
      const claude = rv.cuts.map((c) => [c.a, c.b]).sort((x, y) => x[0] - y[0]), gaps = [];
      let last = 0;
      for (const [a, b] of S) { if (a - last > 0.05) gaps.push([last, a]); last = b; }
      if (dur - last > 0.05) gaps.push([last, dur]);
      mine = gaps.filter(([a, b]) => overlap([[a, b]], claude) < 0.5 * (b - a)).length;
    }
    // A join Clean up's fix already resolved (edl_fixed.json has it) isn't one to check (server/cutreview.mjs joinFixed).
    const L = lists(), all = rv?.joins || [], joins = all.filter((j) => !j.fixed), fixed = all.length - joins.length, clipped = joins.filter((j) => j.status === 'likely clipped').length;
    return `<section class="cp-in"><h3>In this cut</h3>
      <div class="cp-len"><span>${dur ? clock(dur) : '–'} raw</span><span aria-hidden="true">→</span><b>${clock(cutLen)}</b><span>cut</span></div>
      ${dur ? `<p class="sub cp-saved">${(dur - cutLen).toFixed(1)} s shorter</p>` : ''}
      <div class="cp-tiles">${KINDS.map(([k, label]) => `<div class="cp-tile"><span>${label}</span><b>${by[k]}</b></div>`).join('')}</div>
      <ul class="cp-legend">
        ${mine ? `<li><i class="sw hatch" aria-hidden="true"></i><span>Cut by you</span><b>${mine}</b></li>` : ''}
        <li><button class="cp-row-btn" data-a="list"${rv?.items?.some((it) => it.group === 'ask') ? '' : ' disabled'}><i class="sw ear" aria-hidden="true"></i><span>Still to listen to</span><b>${L.check.length}</b>${rv?.items?.some((it) => it.group === 'ask') ? '<span class="cp-go" aria-hidden="true">›</span>' : ''}</button></li>
        ${isLocked() ? '' : `<li><i class="sw tri" aria-hidden="true"></i><span>Joins to check${clipped ? ` <small>${clipped} likely clipped</small>` : ''}${fixed ? ` <small>${fixed} fixed by Clean up</small>` : ''}</span><b>${joins.length}</b></li>`}
      </ul></section>`;
  }

  function lockHTML() {
    const p = getP().pipeline, s = p?.steps.find((x) => x.id === 'lock');
    if (!s) return '';
    const left = lists().check.length;
    // One next step (B2): the dock's. Lock is the accent button only while it is the dock's step; before it (Split into
    // sections still to do) the panel says the dock's step comes first, and it never names a step after the lock.
    const cur = p.steps.find((x) => x.id === p.current) || null, mine = cur?.id === s.id;
    const first = !mine && !s.done && cur && p.steps.indexOf(cur) < p.steps.indexOf(s) ? cur : null;
    // Locked (B3): read-only, Unlock to edit. Unlocked: edit, then lock again (the Lock step is next again).
    if (isLocked()) return `<section class="cp-lock-s"><div class="cp-lock locked">
      <b>Cut locked</b>
      <p class="sub">${s.byImport ? 'Your own edit is the cut. ' : ''}The scene plan and the build use this cut, so it’s read-only. Unlock it to change it, then lock it again: Claude checks every join.</p>
      <button class="btn wide" data-a="unlock">Unlock to edit</button></div></section>`;
    // changed: locked, then edited (server/studio.mjs: the Lock step waits to run again). unlocked: Unlock to edit.
    return `<section class="cp-lock-s"><div class="cp-lock">
      <b>${s.changed ? 'Changed after the lock' : s.unlocked || unlocking ? 'Unlocked' : 'Happy with it?'}</b>
      <p class="sub">${s.changed ? 'The cut changed after it was locked, and its new joins aren’t checked yet. Lock it again: Claude renders it and checks every join.' : s.unlocked || unlocking ? 'Edit the cut, then lock it again: Claude renders it and checks every join.' : 'Claude renders this cut and checks every join again. When nothing sounds clipped, the cut is locked.'}</p>
      ${first ? `<p class="sub cp-first">First: <b>${esc(first.name)}</b>, the next step in the dock. Lock the cut after it.</p>` : ''}
      ${left ? `<p class="cp-left">${plural(left, 'part')} still to listen to. Anything you skip stays as it is now.</p>` : ''}
      <button class="btn${mine ? ' accent' : ''} wide" data-a="lock">${s.done || s.changed || s.unlocked ? 'Save and lock the cut again' : 'Save and lock the cut'}</button></div></section>`;
  }

  function wireMain() {
    root.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => act(b.dataset.a, b)));
  }
  async function act(a, b) {
    if (a === 'list') return openList();
    if (a === 'lock') return lock(b);
    if (a === 'unlock') return unlock();
    if (a === 'shot-here') { if (live?.sel) shots?.addAt(Number.isFinite(live.sel.w0) ? live.sel.w0 : live.sel.a); return; }
    ask({ type: 'studio:cut-do', op: a });
  }
  async function lock(b) {
    const s = getP().pipeline?.steps.find((x) => x.id === 'lock');
    if (!s) return;
    if (s.done && !confirm(`Run “${s.label}” again?`)) return; // (changed after the lock: it isn't done, so no question)
    b.disabled = true; b.textContent = 'Saving the cut…';
    const ok = await flush();
    const repaint = () => { lastHTML = ''; paint(); }; // the button was changed by hand: draw it again
    if (ok === false) { toast('The cut isn’t saved (Claude changed it since the Cut Editor opened). Reload the Cut tab, then lock.'); repaint(); return; }
    runLock(s); // the rail's Lock step: the same call as pressing it there
    setTimeout(repaint, 600);
  }

  // ---- the Keep / Cut list (board "Editor C") ----
  function openList() { view = 'list'; filter = 'check'; cur = null; if (root?.isConnected) paint(); }
  function paintList() {
    const L = lists(), rows = L[filter], P = getP();
    if (!rows.some((it) => it.key === cur)) cur = rows[0]?.key || null;
    const S = segs();
    const tab = (k, label, n) => `<button type="button" class="${filter === k ? 'on' : ''}" aria-pressed="${filter === k}" data-f="${k}">${label} · ${n}</button>`;
    if (!setHTML(`<div class="ins-head"><button class="btn ghost small cp-back" aria-label="Back to the Cut inspector" title="Back">‹</button><b>Needs your ear</b><span class="sub">${plural(L.check.length, 'to check', 'to check')}</span></div>
      <section class="cp-list-top"><p class="sub">${esc(rv?.summary ? `${rv.summary}. ` : '')}Press play, then keep or cut. Anything you skip stays as it is now.</p>
        <div class="seg wide cp-filter" role="group" aria-label="Show">${tab('check', 'To check', L.check.length)}${tab('done', 'Decided', L.done.length)}${tab('auto', 'Auto-cut', L.auto.length)}</div>
        <div class="cp-keys"><kbd>K</kbd> keep · <kbd>X</kbd> cut · <kbd>Space</kbd> play · <kbd>↑</kbd><kbd>↓</kbd> move</div></section>
      <div class="cp-rows" role="list">${rows.length ? rows.map((it) => rowHTML(it, S)).join('') : `<p class="sub cp-empty">${filter === 'check' ? 'Nothing left to check.' : filter === 'done' ? 'Nothing decided yet.' : 'No other cuts.'}</p>`}</div>
      ${filter === 'check' && L.check.length ? '<section class="cp-list-foot"><button class="btn wide" data-a="rest">Leave the rest as they are</button></section>' : ''}`)) return;
    $('.cp-back', root).onclick = () => { view = 'main'; paint(); };
    root.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { filter = b.dataset.f; cur = null; paint(); }));
    root.querySelector('[data-a=rest]')?.addEventListener('click', leaveRest);
    root.querySelectorAll('.cp-row').forEach((r) => {
      const it = rv.items.find((x) => x.key === r.dataset.k);
      r.onclick = (e) => { if (e.target.closest('button')) return; cur = it.key; mark(); };
      $('.cp-play', r).onclick = () => { cur = it.key; mark(); play(it); };
      $('.cp-text', r).onclick = () => { cur = it.key; mark(); ask({ type: 'studio:cut-do', op: 'select', a: it.a, b: it.b }); };
      r.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => { cur = it.key; decide(it, b.dataset.d); }));
    });
    if (!P.cut?.ready || isLocked()) root.querySelectorAll('.cp-dec button').forEach((b) => { b.disabled = true; if (isLocked()) b.title = 'The cut is locked: Unlock to edit'; });
    if (!P.cut?.ready) root.querySelectorAll('.cp-row button').forEach((b) => (b.disabled = true));
  }
  function rowHTML(it, S) {
    const st = stateOf(it), d = it.decision, on = (x) => (d ? (st === 'kept' ? 'keep' : st === 'cut' ? 'cut' : d) === x : false);
    const t = toCut(it.kind === 'Join' ? it.b : it.a, S);
    const now = [st === 'kept' ? 'in the cut' : st === 'cut' ? 'cut now' : st === 'mixed' ? 'partly cut' : '',
      it.decision && it.by === 'edit' ? 'you edited it' : it.decision && it.by === 'lock' ? 'left as it was when the cut was locked' : ''].filter(Boolean).join(' · ');
    const text = it.ask && it.text && !/^\[/.test(it.text) ? `“${it.text}”` : it.ask || it.text;
    const note = atCut(it.ask && it.text && !/^\[/.test(it.text) ? it.note || it.ask : it.note, S);
    return `<div class="cp-row${it.key === cur ? ' cur' : ''}" role="listitem" data-k="${esc(it.key)}">
      <div class="cp-r1"><button type="button" class="cp-play" aria-label="Play this part, with 2 s either side" title="Play with 2 s either side (Space)"><svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true"><path d="M3.5 1.8l9 5.2-9 5.2z"/></svg></button>
        <span class="cp-t" title="${esc(`${clock(t)} in the cut · take ${clock(it.a)}–${clock(it.b)}`)}">${clock(t)}</span><span class="cp-kind k-${esc(it.kind.toLowerCase())}">${esc(it.kind)}</span>
        <span class="gap"></span><div class="cp-dec" role="group" aria-label="Decision"><button type="button" data-d="keep" aria-pressed="${on('keep')}" title="Keep it (K)">Keep</button><button type="button" data-d="cut" aria-pressed="${on('cut')}" title="Cut it (X)">Cut</button></div></div>
      <button type="button" class="cp-text" title="Show it in the transcript">${esc(text)}</button>
      ${note || now ? `<div class="cp-note">${now ? `<span class="cp-now">${now}</span>${note ? ' · ' : ''}` : ''}${esc(note || '')}</div>` : ''}</div>`;
  }
  // The current row without a full repaint (so a click doesn't jump the list).
  function mark() { root?.querySelectorAll('.cp-row').forEach((r) => r.classList.toggle('cur', r.dataset.k === cur)); }
  function play(it) {
    ask({ type: 'studio:cut-do', op: 'play', a: it.a, b: it.b, pad: 2, raw: it.play === 'raw' });
  }
  // A list decision is one edit in the editor. Its undo there (⌘Z, Undo) takes the decision back too, and its redo puts
  // it back: each decision keeps the cut just before its edit and just after it, and the editor's state says which.
  const track = new Map(); // key -> { d, before, after, at, undone }
  const segSig = (S) => JSON.stringify((S || []).map(([a, b]) => [Math.round(a * 1000), Math.round(b * 1000)]));
  function followUndo() {
    if (!track.size || !live?.segments) return;
    const now = segSig(live.segments);
    for (const [key, r] of track) {
      if (!r.after) { if (now !== r.before) r.after = now; else if (Date.now() - r.at > 2500) track.delete(key); continue; } // no edit came: nothing to follow
      if (!r.undone && now === r.before) { r.undone = true; setDecision(key, null); }
      else if (r.undone && now === r.after) { r.undone = false; setDecision(key, r.d); }
    }
  }
  async function setDecision(key, d) {
    const it = rv?.items.find((x) => x.key === key);
    if (it) { it.decision = d; it.by = d ? 'list' : null; }
    sendReview(); paint();
    try { rv = await api(url, { decisions: { [key]: d } }); sendReview(); paint(); } catch (e) { toast(e.message); }
  }
  async function decide(it, d) {
    if (isLocked()) { toast('The cut is locked · Unlock to edit'); return; }
    const undo = it.decision === d && stateOf(it) === (d === 'keep' ? 'kept' : 'cut'); // pressing the lit one again: back to To check
    if (!undo && !ready) { pending = { key: it.key, d }; toast(frame?.isConnected ? 'The Cut Editor is still opening: this goes in as soon as it\'s ready.' : 'The Cut Editor is still opening.'); return; }
    const before = live?.segments ? segSig(live.segments) : null;
    // safe: a part Prepare named (false starts, an unfinished ending): its edges go where a word delete puts them.
    if (!undo && (it.keep.length || it.cut.length) && !ask({ type: 'studio:cut-do', op: d, ranges: d === 'keep' ? it.keep : it.cut, safe: Boolean(it.safe) })) return;
    track.delete(it.key);
    if (!undo && before) track.set(it.key, { d, before, after: null, at: Date.now(), undone: false });
    const rows = lists()[filter], i = rows.findIndex((x) => x.key === it.key);
    it.decision = undo ? null : d; it.by = undo ? null : 'list';
    if (filter === 'check' && !undo) cur = (rows[i + 1] || rows[i - 1])?.key || null;
    sendReview(); paint();
    try { rv = await api(url, { decisions: { [it.key]: undo ? null : d } }); sendReview(); paint(); } catch (e) { toast(e.message); }
  }
  async function leaveRest() {
    const patch = {};
    for (const it of lists().check) { const st = stateOf(it); patch[it.key] = st === 'cut' ? 'cut' : 'keep'; it.decision = patch[it.key]; it.by = 'list'; }
    paint();
    try { rv = await api(url, { decisions: patch }); sendReview(); paint(); } catch (e) { toast(e.message); }
  }
  function onKey(e) {
    if (view !== 'list' || !root?.isConnected || root.closest('[hidden]') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || !$('#modal')?.hidden) return;
    const rows = lists()[filter], i = rows.findIndex((x) => x.key === cur), it = rows[i];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (n) { cur = n.key; mark(); root.querySelector(`.cp-row[data-k="${CSS.escape(n.key)}"]`)?.scrollIntoView({ block: 'nearest' }); }
      return;
    }
    if (!it) return;
    if (e.key === 'k' || e.key === 'K') { e.preventDefault(); decide(it, 'keep'); }
    else if (e.key === 'x' || e.key === 'X') { e.preventDefault(); decide(it, 'cut'); }
    else if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); play(it); }
  }
  // Space on a focused button would also press it when the key comes up.
  const onKeyUp = (e) => { if (view === 'list' && root?.isConnected && !root.closest('[hidden]') && (e.key === ' ' || e.code === 'Space') && e.target.closest?.('.cutp')) e.preventDefault(); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onKeyUp);

  return {
    render, onMessage, openList, flush,
    attach(f, u) { frame = f; editorUrl = u || null; live = null; ready = false; pending = null; sentLock = null; lastHTML = ''; track.clear(); paint(); shots?.setCutPost((m) => ready && post(m)); },
    destroy() { offLook(); document.removeEventListener('keydown', onKey); document.removeEventListener('keyup', onKeyUp); clearTimeout(loadTimer); },
  };
}

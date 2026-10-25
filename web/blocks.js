// Blocks (M3b): the project as an ordered row of blocks (work/blocks.json), in three places:
// - the strip above the timeline: the video in playing order, one tile per block, "+" between them, drag to reorder,
//   a menu per block, files dropped from the file manager become blocks;
// - the section band, a lane inside the timeline (web/timeline.js calls band.draw/down/move/up): take blocks on the
//   take's own seconds, boundaries you drag (snapping to word starts and pauses), file blocks as flags where they play;
// - @mentions in the chat composer: a menu of blocks, takes and files, scenes and library items; the message carries
//   the exact references, and "@Sponsor read record new" opens Record setup for that block.
// Before Split into sections the band says so (its empty state). The maths is in blockseq.js (shared with the server).
import { $, h, esc, api, toast, clock } from './ui.js';
import { blockLayout, TYPE_LABEL } from './blockseq.js';
import { PRESETS } from './layout.js';
import { tokens } from './tlcore.js';

const two = (t) => { t = Math.max(0, Math.round(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const secs = (t) => (t >= 90 ? two(t) : `${Math.round(t)} s`);
const INSERT_TYPES = [['sponsor', 'Sponsor read'], ['broll', 'B-roll'], ['custom', 'Chapter card'], ['custom', 'Custom']];
const REF_HEAD = '\n\n— Video Octopus references —\n';
const ICON = {
  dots: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
  file: '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.5h4l2.5 2.5v6.5h-6.5z"/></svg>',
  rec: '<span class="rec-dot" aria-hidden="true"></span>',
};

export function makeBlocks({ id, getP, openRecord, openCut, runStep, note, seek, time, history }) {
  const url = (a) => `/api/projects/${encodeURIComponent(id)}${a}`;
  let view = null, strip = null, pop = null, sel = null, loadN = 0, sigN = 0, dragId = null;
  let band = null; // drag state inside the band
  const cs = () => getComputedStyle(document.documentElement);
  const col = (type, ink) => tokens()(`--bk-${type}${ink ? '-ink' : ''}`, ink ? '#3f3f46' : '#ecebe7');
  const items = () => view?.items || [];
  const byId = (bid) => items().find((x) => x.id === bid);

  async function update() {
    if (!getP().type) return;
    const n = ++loadN;
    try { const v = await api(url('/blocks')); if (n === loadN) { view = v; sigN++; render(); } } catch {}
  }
  async function op(body, quiet) {
    try {
      const r = await api(url('/blocks'), body);
      view = r.view; sigN++; render();
      if (r.note && !quiet) toast(r.note);
      remember(body, r);
      return r;
    } catch (e) { toast(e.message); return null; }
  }

  // The step that marks the sections (its plain name and words, core/pipelines.json).
  const sectionsStep = () => getP().pipeline?.steps.find((s) => s.brief === 'sections' || s.id === 'sections') || null;
  // One next step (B2): the dock's. The band offers Split into sections only while it is the dock's step and isn't
  // running; before that (Clean up still to do) and after, it names no step of its own.
  const sectionsRunning = () => { const P = getP(), sec = sectionsStep(); return Boolean(sec && P.busy && P.running === sec.id); };
  const sectionsNow = () => { const sec = sectionsStep(); return sec && getP().pipeline?.current === sec.id && !sectionsRunning() ? sec : null; };

  // ---------- the strip ----------
  function mount(host) { strip = host; render(); }
  function render() {
    if (!strip || !strip.isConnected) return;
    if (!view) { strip.replaceChildren(); return; }
    const P = getP(), list = items();
    const total = view.total || 1;
    const fmt = P.pipeline?.format || '';
    const canMark = Boolean(view.wordsFile);
    const sec = sectionsNow();
    const head = h(`<div class="bk-head"><b>Blocks</b>
      <span class="bk-meta">${esc(fmt)}${view.exists ? ` · ${list.length} block${list.length === 1 ? '' : 's'} · ${two(view.total)}` : ''}${view.exists && !view.marked ? ' · no sections yet' : ''}</span>
      <span class="gap"></span>
      ${!view.marked && canMark && sec ? `<button class="btn ghost small" data-a="mark" title="${esc(sec.what || 'Claude reads the transcript and proposes where each block starts and ends')}">${esc(sec.name)}</button>` : ''}
      <button class="btn small" data-a="add" title="Add a block: record one, use a file, take one from the library, or ask Claude">+ Add block</button></div>`);
    const row = h(`<div class="bk-row" role="list" aria-label="Blocks in playing order"></div>`);
    const plus = (i, before, after) => {
      const b = h(`<button class="bk-plus" data-gap="${i}" aria-label="Add a block ${after ? `after ${esc(after.label)}` : 'at the start'}" title="Add a block here">+</button>`);
      b.onclick = (e) => insertMenu(b, { before: before?.id || null, after: after || null });
      return b;
    };
    row.append(plus(0, list[0], null));
    list.forEach((it, i) => {
      const own = it.kind !== 'take';
      const grow = Math.max(it.dur || 0, total * 0.07);
      const el = h(`<div class="bk t-${it.type}${own ? ' own' : ''}${it.kind === 'pending' ? ' pending' : ''}${sel === it.id ? ' on' : ''}" role="listitem" draggable="true" data-id="${esc(it.id)}"
          style="flex:${grow.toFixed(2)} 1 0px" title="${esc(tileTitle(it))}">
        <span class="bk-n">${it.order}</span>
        <span class="bk-body"><b>${esc(it.label)}</b>
          <small>${it.kind === 'pending' ? (it.source.pending === 'record' ? 'to record' : it.source.pending === 'claude' ? 'Claude makes it' : 'no file yet') : `${two(it.start)} · ${secs(it.dur)}`}${own && it.kind === 'file' ? ` · ${ICON.file} own file` : ''}</small>
          ${it.ruleText ? `<span class="bk-rule${it.override ? ' off' : ''}" title="${it.override ? 'Moved by hand: the rule no longer applies' : 'Placement rule'}">${esc(it.ruleText)}</span>` : ''}
          ${it.scenes ? `<small class="bk-sc">${it.scenes.count} scene${it.scenes.count > 1 ? 's' : ''}${it.scenes.notes ? ` · ${it.scenes.notes} note${it.scenes.notes > 1 ? 's' : ''}` : ''}</small>` : ''}</span>
        <button class="bk-dots" aria-label="Menu for ${esc(it.label)}">${ICON.dots}</button></div>`);
      el.onclick = (e) => { if (e.target.closest('.bk-dots')) return; pick(it); };
      el.ondblclick = () => rename(it);
      $('.bk-dots', el).onclick = (e) => { e.stopPropagation(); blockMenu($('.bk-dots', el), it); };
      el.addEventListener('dragstart', (e) => { dragId = it.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-block', it.id); el.classList.add('dragging'); });
      el.addEventListener('dragend', () => { dragId = null; el.classList.remove('dragging'); row.querySelectorAll('.bk-plus.drop').forEach((x) => x.classList.remove('drop')); });
      row.append(el, plus(i + 1, list[i + 1], it));
    });
    // Drop on a gap: move a block there, or add a dropped video file there.
    const gapAt = (e) => {
      const ps = [...row.querySelectorAll('.bk-plus')];
      return ps.map((p) => ({ p, d: Math.abs(p.getBoundingClientRect().left + 10 - e.clientX) })).sort((a, b) => a.d - b.d)[0]?.p;
    };
    row.addEventListener('dragover', (e) => {
      const files = e.dataTransfer.types.includes('Files');
      if (!dragId && !files) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = files ? 'copy' : 'move';
      const g = gapAt(e);
      row.querySelectorAll('.bk-plus').forEach((x) => x.classList.toggle('drop', x === g));
    });
    row.addEventListener('dragleave', (e) => { if (!row.contains(e.relatedTarget)) row.querySelectorAll('.bk-plus.drop').forEach((x) => x.classList.remove('drop')); });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const g = gapAt(e);
      row.querySelectorAll('.bk-plus.drop').forEach((x) => x.classList.remove('drop'));
      if (!g) return;
      const i = Number(g.dataset.gap), before = list[i] || null;
      const file = [...(e.dataTransfer.files || [])][0];
      if (file) return insertMenu(g, { before: before?.id || null, after: list[i - 1] || null, file });
      const bid = e.dataTransfer.getData('text/x-block') || dragId;
      if (!bid || bid === before?.id || list[i - 1]?.id === bid) return;
      op({ op: 'move', id: bid, before: before?.id || null });
    });
    const notes = list.filter((x) => x.note && x.kind !== 'take').slice(-2);
    const foot = notes.length ? h(`<div class="bk-notes">${notes.map((x) => `<span><b>${esc(x.label)}</b> ${esc(x.note)}</span>`).join('')}</div>`) : null;
    strip.replaceChildren(head, row, ...(foot ? [foot] : []));
    const mark = $('[data-a=mark]', head);
    if (mark) mark.onclick = () => runStep?.(sec.id);
    $('[data-a=add]', head).onclick = (e) => insertMenu(e.currentTarget, { before: null, after: list[list.length - 1] || null, end: true });
    // A video dropped anywhere on the strip (not on a gap) goes to the end, by its rule.
    strip.ondragover = (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); };
    strip.ondrop = (e) => {
      if (e.defaultPrevented) return;
      const file = [...(e.dataTransfer.files || [])][0];
      if (file) { e.preventDefault(); insertMenu($('[data-a=add]', head), { before: null, after: list[list.length - 1] || null, end: true, file }); }
    };
  }
  const tileTitle = (it) => [
    `${it.label} (${TYPE_LABEL[it.type] || it.type})`,
    it.kind === 'take' ? `Take ${clock(it.source.take[0])}–${clock(it.source.take[1])}` : it.kind === 'file' ? `Own file: ${it.source.file}` : 'No file yet',
    `In the video: ${clock(it.start)}–${clock(it.end)}`,
    it.reason || '', it.note || '', 'Click to select, drag to move, double-click to rename.',
  ].filter(Boolean).join('\n');

  function pick(it) {
    sel = it.id; sigN++; render();
    if (it.kind === 'take') seek?.(it.source.take[0] + 0.01);
    else if (it.kind === 'file') preview(it);
    else blockMenu(strip.querySelector(`.bk[data-id="${CSS.escape(it.id)}"] .bk-dots`), it);
  }

  // ---------- popovers ----------
  function closePop() { pop?.remove(); pop = null; document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escKey, true); }
  const outside = (e) => { if (pop && !pop.contains(e.target)) closePop(); };
  const escKey = (e) => { if (e.key === 'Escape' && pop) { e.stopPropagation(); closePop(); } };
  function openPop(anchor, node, { wide = false } = {}) {
    closePop();
    pop = node;
    pop.classList.add('bk-pop');
    if (wide) pop.classList.add('wide');
    document.body.append(pop);
    const a = (anchor?.isConnected ? anchor : strip).getBoundingClientRect(), r = pop.getBoundingClientRect();
    const left = Math.max(8, Math.min(innerWidth - r.width - 8, a.left + a.width / 2 - r.width / 2));
    const top = a.top - r.height - 8 > 8 ? a.top - r.height - 8 : Math.min(innerHeight - r.height - 8, a.bottom + 8);
    Object.assign(pop.style, { left: `${left}px`, top: `${top}px` });
    setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escKey, true); }, 0);
    return pop;
  }

  // The "+" menu: what kind of block, where it goes, and where it comes from.
  function insertMenu(anchor, at) {
    const tpl = view?.template || [];
    let type = 'sponsor', label = 'Sponsor read';
    const ruleFor = (t) => tpl.find((x) => x.type === t)?.rule || (t === 'sponsor' ? 'first 30%' : null);
    let where = at.end || !at.after ? (ruleFor(type) ? 'rule' : 'end') : 'here';
    const node = h(`<div class="bk-menu" role="dialog" aria-label="Add a block">
      <div class="bm-h">Add a block${at.file ? `: <span class="mono">${esc(at.file.name)}</span>` : ''}</div>
      <div class="bm-sec"><span>Type</span><div class="seg wide" data-k="type">${INSERT_TYPES.map(([t, l]) => `<button data-t="${t}" data-l="${esc(l)}">${esc(l)}</button>`).join('')}</div></div>
      <label class="bm-sec"><span>Name</span><input class="field" data-k="label" value="${esc(label)}" maxlength="60"></label>
      <div class="bm-sec"><span>Where</span><div class="bm-where" data-k="where"></div></div>
      <div class="bm-sec bm-src"><span>${at.file ? 'Add it' : 'Source'}</span>
        ${at.file ? `<button class="btn dark" data-s="drop">Add ${esc(at.file.name.length > 28 ? at.file.name.slice(0, 26) + '…' : at.file.name)}</button>` : `
        <div class="bm-srcs">
          <button class="bm-s" data-s="record">${ICON.rec}<b>Record new</b><small>Opens Record setup; the take becomes this block</small></button>
          <button class="bm-s" data-s="file"><b>Use a file</b><small>A video or sound file on this computer, or another take</small></button>
          <button class="bm-s" data-s="library"><b>From library</b><small>A saved sponsor read, intro, B-roll…</small></button>
          <button class="bm-s" data-s="claude"><b>Ask Claude</b><small>Claude makes it (a chapter card, B-roll…)</small></button>
        </div>`}
        <div class="bm-ask" hidden><textarea class="field" rows="2" placeholder="What should Claude make? e.g. a chapter card “Step 2: install”"></textarea><button class="btn dark small" data-s="claude-go">Ask Claude</button></div></div>
    </div>`);
    const drawWhere = () => {
      const r = ruleFor(type);
      const opts = [
        r ? ['rule', `${esc(r === 'first 30%' ? 'In the first 30%' : r)}, at a pause`, 'Video Octopus picks the spot and keeps it there when the cut changes'] : null,
        !at.end && (at.after || at.before) ? ['here', at.after ? `Here, after ${esc(at.after.label)}` : 'At the start', 'Exactly here'] : null,
        ['playhead', `At the playhead (${clock(time?.() || 0)})`, 'The nearest pause'],
        ['end', 'At the end', ''],
      ].filter(Boolean);
      if (!opts.some((o) => o[0] === where)) where = opts[0][0];
      $('[data-k=where]', node).innerHTML = opts.map(([k, l, s]) => `<label class="radio"><input type="radio" name="bkw" value="${k}"${k === where ? ' checked' : ''}> ${l}${s ? ` <span class="sub">${s}</span>` : ''}</label>`).join('');
      node.querySelectorAll('input[name=bkw]').forEach((x) => (x.onchange = () => { where = x.value; }));
    };
    const syncType = () => node.querySelectorAll('[data-k=type] button').forEach((b) => { const on = b.dataset.t === type && b.dataset.l === label0; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    let label0 = label;
    node.querySelectorAll('[data-k=type] button').forEach((b) => (b.onclick = () => {
      type = b.dataset.t; label0 = b.dataset.l;
      const inp = $('[data-k=label]', node);
      if (!inp.dataset.touched) inp.value = label0;
      syncType(); drawWhere();
    }));
    $('[data-k=label]', node).oninput = (e) => { e.target.dataset.touched = '1'; };
    syncType(); drawWhere();
    const placement = () => where === 'rule' ? { rule: ruleFor(type) } : where === 'here' ? { rule: null, where: { before: at.before } } : where === 'playhead' ? { rule: null, where: { at: time?.() || 0 } } : { rule: null, where: { before: null } };
    const make = async (source, extra = {}) => {
      const lab = $('[data-k=label]', node).value.trim() || label0;
      closePop();
      return op({ op: 'insert', type, label: lab, source, ...placement(), ...extra });
    };
    node.querySelectorAll('[data-s]').forEach((b) => (b.onclick = async () => {
      const s = b.dataset.s;
      if (s === 'claude') { $('.bm-ask', node).hidden = false; $('.bm-ask textarea', node).focus(); return; }
      if (s === 'drop') { const r = await make({ pending: 'file' }); if (r?.id) await uploadInto(r.id, at.file); return; }
      if (s === 'claude-go') {
        const ask = $('.bm-ask textarea', node).value.trim();
        if (!ask) return $('.bm-ask textarea', node).focus();
        const r = await make({ pending: 'claude' }, { ask });
        if (r?.id) { try { await api(url('/block-ask'), { id: r.id }); toast('Sent to Claude. The block fills in when the file is ready.'); } catch (e) { toast(e.message); } }
        return;
      }
      const r = await make({ pending: s === 'record' ? 'record' : 'file' });
      if (!r?.id) return;
      const it = byId(r.id);
      if (s === 'record') recordInto(it);
      else if (s === 'file') chooseFile(it, true);
      else if (s === 'library') chooseLibrary(it, true);
    }));
    openPop(anchor, node, { wide: true });
  }

  function recordInto(it) {
    if (!it) return;
    openRecord?.({ target: `block:${it.id}`, label: it.label });
  }

  // Use a file: drop or pick one from this computer (uploaded into source/), or another take.
  async function chooseFile(it, fresh) {
    let src = { files: [], takes: [] };
    try { src = await api(url('/block-sources')); } catch {}
    const node = h(`<div class="bk-menu" role="dialog" aria-label="Use a file for ${esc(it.label)}">
      <div class="bm-h">A file for <b>${esc(it.label)}</b></div>
      <label class="bk-drop"><input type="file" accept="video/*,audio/*,.mov,.mp4,.m4v,.mkv,.webm,.wav,.m4a,.mp3,.aif,.aiff,.flac" hidden><b>Drop a video or a sound file here</b><span class="sub">or click to choose one on this computer. It's copied into the project's source/ folder. A sound file (a voiceover) plays over the background.</span></label>
      ${src.files.length ? `<div class="bm-l">In this project</div>${src.files.map((f) => `<button class="mi" data-f="${esc(f.file)}"><b>${esc(f.name)}</b><small>${f.duration ? secs(f.duration) : ''}</small></button>`).join('')}` : ''}
      ${src.takes.length ? `<div class="bm-l">Recordings</div>${src.takes.slice(0, 6).map((t) => `<button class="mi" data-t="${esc(t.id)}"><b>${esc(t.id.replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1'))}</b><small>${esc(t.files.map((f) => (/_screen\./.test(f) ? 'screen' : /_webcam\./.test(f) ? 'camera' : /\.(wav|m4a|mp3|aif|aiff|caf|flac)$/i.test(f) ? 'mic only' : 'video')).join(' + '))}</small></button>`).join('')}` : ''}
      <div class="bm-foot"><button class="btn ghost small" data-a="x">${fresh ? 'Cancel' : 'Close'}</button></div></div>`);
    let used = false;
    const done = () => { used = true; closePop(); };
    const input = $('input[type=file]', node), drop = $('.bk-drop', node);
    input.onchange = async () => { const f = input.files[0]; if (f) { done(); await uploadInto(it.id, f); } };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = async (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) { done(); await uploadInto(it.id, f); } };
    node.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { done(); op({ op: 'attach', id: it.id, file: b.dataset.f }); }));
    node.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { done(); op({ op: 'use-take', id: it.id, take: b.dataset.t }); }));
    $('[data-a=x]', node).onclick = () => closePop();
    openPop(strip.querySelector(`.bk[data-id="${CSS.escape(it.id)}"]`) || strip, node);
    // Cancelled before anything was picked: a block added just for this goes away again.
    const watch = setInterval(() => { if (pop !== node) { clearInterval(watch); if (fresh && !used) op({ op: 'delete', id: it.id }, true); } }, 300);
  }
  async function chooseLibrary(it, fresh) {
    let src = { library: [] };
    try { src = await api(url('/block-sources')); } catch {}
    const node = h(`<div class="bk-menu" role="dialog" aria-label="From the library">
      <div class="bm-h">From the library</div>
      ${src.library.length ? src.library.map((x) => `<button class="mi" data-p="${esc(x.path)}"><b>${esc(x.name)}</b><small class="mono">${esc(x.path)}</small></button>`).join('')
        : `<p class="sub">No videos in your studio's <span class="mono">${esc(src.libraryDir || 'library')}/</span> folder yet. Save a sponsor read or an intro there and it shows up here.</p>`}
      <div class="bm-foot"><button class="btn ghost small" data-a="x">Cancel</button></div></div>`);
    let used = false;
    node.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => { used = true; closePop(); op({ op: 'use-library', id: it.id, path: b.dataset.p }); }));
    $('[data-a=x]', node).onclick = () => closePop();
    openPop(strip.querySelector(`.bk[data-id="${CSS.escape(it.id)}"]`) || strip, node);
    const watch = setInterval(() => { if (pop !== node) { clearInterval(watch); if (fresh && !used) op({ op: 'delete', id: it.id }, true); } }, 300);
  }
  async function uploadInto(bid, file) {
    toast(`Copying ${file.name} into the project…`);
    try {
      const r = await fetch(url(`/upload?name=${encodeURIComponent(file.name)}`), { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/octet-stream' }, body: file });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Upload failed (${r.status})`);
      await op({ op: 'attach', id: bid, file: j.file });
      toast(`${file.name} is now the ${byId(bid)?.label || 'block'}'s file.`);
    } catch (e) { toast(e.message); }
  }

  function preview(it) {
    const f = it.file;
    const src = f?.proxy ? url(`/media?f=${encodeURIComponent(f.proxy)}`) : null;
    const node = h(`<div class="bk-menu bk-prev" role="dialog" aria-label="${esc(it.label)}">
      <div class="bm-h">${esc(it.label)} <span class="sub">${esc(f?.name || '')}${f?.duration ? ` · ${secs(f.duration)}` : ''}</span></div>
      ${src && f.audioOnly ? `<audio controls preload="metadata" src="${src}"></audio><p class="sub">Sound only: it plays over the background in the export.</p>`
        : src ? `<video controls playsinline preload="metadata" src="${src}"></video>` : `<p class="sub">${f?.missing ? 'The file is missing.' : 'Getting a playback copy ready…'}</p>`}
      <p class="sub">Plays ${two(it.start)}–${two(it.end)} in the video${it.ruleText ? ` · ${esc(it.ruleText)}${it.override ? ' (moved by hand)' : ''}` : ''}.${it.note ? ` ${esc(it.note)}` : ''}</p>
      <div class="bm-foot"><button class="btn small" data-a="menu">More…</button><span class="gap"></span><button class="btn ghost small" data-a="x">Close</button></div></div>`);
    $('[data-a=x]', node).onclick = () => closePop();
    $('[data-a=menu]', node).onclick = () => blockMenu(strip.querySelector(`.bk[data-id="${CSS.escape(it.id)}"] .bk-dots`), it);
    openPop(strip.querySelector(`.bk[data-id="${CSS.escape(it.id)}"]`) || strip, node, { wide: true });
  }

  // The block menu: rename, layout, rule, record again / replace file, move, duplicate, delete.
  function blockMenu(anchor, it) {
    const i = items().indexOf(it), list = items();
    const lay = it.layout || '';
    const node = h(`<div class="bk-menu" role="menu" aria-label="${esc(it.label)}">
      <div class="bm-h">${esc(it.label)} <span class="sub">${esc(TYPE_LABEL[it.type] || it.type)} · ${it.kind === 'take' ? 'part of the take' : it.kind === 'file' ? 'own file' : 'no file yet'}</span></div>
      <button class="mi" data-a="rename"><b>Rename</b></button>
      <div class="bm-sec"><span>Layout for this block</span><div class="seg wide bm-lay">${[['', 'Canvas'], ...Object.entries(PRESETS).map(([k, v]) => [k, v.replace(/ \(.*\)$/, '').replace('Picture-in-picture', 'PiP')])].map(([k, v]) => `<button data-l="${k}" class="${k === lay ? 'on' : ''}" aria-pressed="${k === lay}">${esc(v)}</button>`).join('')}</div></div>
      ${it.rule ? `<button class="mi" data-a="${it.override ? 'rule-back' : 'rule-clear'}"><b>${it.override ? `Back to “${esc(it.ruleText)}”` : `Stop “${esc(it.ruleText)}”`}</b><small>${it.override ? 'Video Octopus places it by its rule again' : 'Keep it where it is'}</small></button>` : it.kind !== 'take' ? '<button class="mi" data-a="rule-30"><b>Keep it in the first 30%</b><small>At a pause; follows the cut</small></button>' : ''}
      ${it.kind !== 'take' ? `<button class="mi" data-a="record"><b>${it.kind === 'file' ? 'Record again' : 'Record it'}</b><small>Opens Record setup for this block</small></button>
        <button class="mi" data-a="file"><b>${it.kind === 'file' ? 'Replace file' : 'Use a file'}</b></button>
        <button class="mi" data-a="library"><b>From library</b></button>` : ''}
      ${it.kind === 'file' ? '<button class="mi" data-a="preview"><b>Preview</b></button>' : ''}
      <div class="bm-row"><button class="btn small" data-a="earlier"${i <= 0 ? ' disabled' : ''}>Earlier</button><button class="btn small" data-a="later"${i >= list.length - 1 ? ' disabled' : ''}>Later</button><button class="btn small" data-a="end"${i >= list.length - 1 ? ' disabled' : ''}>To the end</button></div>
      <button class="mi" data-a="dup"><b>Duplicate</b><small>${it.kind === 'take' ? 'This part of the take plays twice' : 'The same file again, right after'}</small></button>
      <button class="mi danger" data-a="del"><b>Delete</b><small>${it.kind === 'take' ? 'This part of the take is left out of the export' : 'The file stays in source/'}</small></button></div>`);
    node.querySelectorAll('.bm-lay button').forEach((b) => (b.onclick = () => { closePop(); op({ op: 'update', id: it.id, layout: b.dataset.l || null }); }));
    const act = {
      rename: () => rename(it),
      'rule-back': () => op({ op: 'rule-back', id: it.id }),
      'rule-clear': () => op({ op: 'update', id: it.id, rule: null }),
      'rule-30': () => op({ op: 'update', id: it.id, rule: 'first 30%' }),
      record: () => recordInto(it),
      file: () => chooseFile(it, false),
      library: () => chooseLibrary(it, false),
      preview: () => preview(it),
      earlier: () => op({ op: 'move', id: it.id, before: list[i - 1].id }),
      later: () => op({ op: 'move', id: it.id, before: list[i + 2]?.id || null }),
      end: () => op({ op: 'move', id: it.id, before: null }),
      dup: () => op({ op: 'duplicate', id: it.id }),
      del: () => { if (it.kind !== 'take' || confirm(`Leave “${it.label}” out of the video?`)) op({ op: 'delete', id: it.id }); },
    };
    node.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => { const f = act[b.dataset.a]; closePop(); f?.(); }));
    openPop(anchor, node);
  }
  function rename(it) {
    const name = prompt('Name this block', it.label);
    if (name && name.trim() && name.trim() !== it.label) op({ op: 'update', id: it.id, label: name.trim() });
  }

  // ---------- the section band (a lane in the timeline) ----------
  const flagX = (it, v) => v.xOf(it.at ?? 0);
  function bandHit(p, r, v) {
    const list = items();
    // Flags of file blocks first (they sit on top), then take block edges, then take blocks.
    let k = 0;
    const flags = [];
    for (const it of list) if (it.kind !== 'take') {
      const x = flagX(it, v), same = flags.filter((f) => Math.abs(f.x - x) < 2).length;
      flags.push({ it, x, tag: { x: tagX(x, tagW(it), same, v), y: r.y + 3 + same * 4, w: tagW(it), h: 15 } });
      k++;
    }
    for (const f of flags.slice().reverse()) {
      // The flag's label, or its line in the top half: the bottom half of the lane is for the boundary under it.
      if ((Math.abs(p.x - f.x) < 5 && p.y < r.y + r.h / 2) || (p.x >= f.tag.x && p.x <= f.tag.x + f.tag.w && p.y >= f.tag.y && p.y <= f.tag.y + f.tag.h)) return { kind: 'flag', it: f.it };
    }
    if (!view?.marked && getP().pipeline) return null; // no sections yet: nothing to drag but the flags
    for (const it of list) if (it.kind === 'take') {
      const a = v.xOf(it.source.take[0]), b = v.xOf(it.source.take[1]);
      if (Math.abs(p.x - b) < 5 && b - a > 10) return { kind: 'edge', it, edge: 'end', x: b };
      if (Math.abs(p.x - a) < 5 && b - a > 10 && it.source.take[0] > 0.05) return { kind: 'edge', it, edge: 'start', x: a };
    }
    for (const it of list) if (it.kind === 'take' && p.x >= v.xOf(it.source.take[0]) && p.x < v.xOf(it.source.take[1])) return { kind: 'block', it };
    return null;
  }
  let measure = null;
  const tagW = (it) => {
    measure ||= document.createElement('canvas').getContext('2d');
    measure.font = `600 10px ${cs().getPropertyValue('--font')}`;
    return Math.ceil(measure.measureText(tagText(it)).width) + 12;
  };
  // A flag's label sits right of its line, or left of it near the end of the timeline.
  const tagX = (x, w, same, v) => (x + 3 + w + same * 4 > v.W - 2 ? x - 3 - w - same * 4 : x + 3 + same * 4);
  const tagText = (it) => `${it.label}${it.kind === 'file' ? ` · ${secs(it.dur)}` : ' · no file yet'}`;
  // Snap a take second to word starts and pauses within 8 px (boundaries), or to pauses and gaps (flags).
  function snap(t, v, list) {
    let best = null;
    for (const s of list) { const d = Math.abs(v.xOf(s) - v.xOf(t)); if (d <= 8 && (!best || d < best.d)) best = { s, d }; }
    return best ? best.s : t;
  }
  const flagSnaps = () => [...(view?.pauses || []), ...items().filter((x) => x.kind === 'take').flatMap((x) => x.source.take)];

  const bandApi = {
    label: 'Blocks', height: 34,
    on: () => Boolean(view && getP().type && (view.items.length || view.take?.file)),
    sig: () => `${sigN}|${band ? `${band.kind}:${band.t?.toFixed(3)}` : ''}|${sel}|${getP().pipeline?.current || ''}|${sectionsRunning()}`,
    draw(g, r, v) {
      const font = cs().getPropertyValue('--font');
      g.save();
      g.beginPath(); g.rect(0, r.y, v.W, r.h); g.clip();
      const list = items();
      // No sections yet (before Split into sections): a dashed band instead of the one "Whole take" block. It names the
      // step that fills it only while that step is the dock's Next (or running): one next step (B2). Blocks with their
      // own file still show as flags.
      const none = !view.marked && getP().pipeline;
      if (none) {
        const sec = sectionsNow(), run = sectionsRunning() ? sectionsStep() : null;
        g.strokeStyle = v.col.line2; g.lineWidth = 1.5; g.setLineDash([5, 4]);
        g.beginPath(); g.roundRect(1.5, r.y + 3.5, Math.max(4, v.W - 3), r.h - 7, 7); g.stroke(); g.setLineDash([]);
        g.textBaseline = 'middle';
        const y = r.y + r.h / 2, parts = sec ? [['No sections yet. ', 500, v.col.muted], [sec.name, 600, v.col.text], [' adds them here.', 500, v.col.muted]]
          : run ? [['No sections yet. ', 500, v.col.muted], [run.name, 600, v.col.text], [' is adding them.', 500, v.col.muted]]
          : [['No sections yet.', 500, v.col.muted]];
        let x = 12;
        for (const [t, wgt, c] of parts) { g.font = `${wgt} 12px ${font}`; g.fillStyle = c; g.fillText(t, x, y); x += g.measureText(t).width; }
      }
      // Take blocks on their own seconds.
      for (const it of list) {
        if (it.kind !== 'take' || none) continue;
        let [s, e] = it.source.take;
        if (band?.kind === 'edge') {
          if (band.it.id === it.id) { if (band.edge === 'end') e = band.t; else s = band.t; }
          else if (band.edge === 'end' && Math.abs(s - band.it.source.take[1]) < 0.02) s = band.t;
          else if (band.edge === 'start' && Math.abs(e - band.it.source.take[0]) < 0.02) e = band.t;
        }
        if (e < v.v0 || s > v.v1) continue;
        const x = Math.max(-4, v.xOf(s)) + 1, x2 = Math.min(v.W + 4, v.xOf(e)) - 1;
        g.fillStyle = col(it.type); g.beginPath(); g.roundRect(x, r.y + 4, Math.max(2, x2 - x), r.h - 8, 5); g.fill();
        if (it.id === sel) { g.strokeStyle = v.col.sel; g.lineWidth = 1.5; g.stroke(); }
        if (x2 - x > 26) {
          g.save(); g.beginPath(); g.rect(x + 4, r.y, x2 - x - 8, r.h); g.clip();
          g.fillStyle = col(it.type, true); g.font = `600 11px ${font}`; g.textBaseline = 'middle';
          g.fillText(`${it.order}  ${it.label}`, x + 8, r.y + r.h / 2);
          g.restore();
        }
      }
      // Boundaries: a firm line where two take blocks meet.
      g.fillStyle = v.col.a(v.col.text, 0.28);
      for (const it of list) if (!none && it.kind === 'take' && it.source.take[1] < (view.take?.duration || Infinity) - 0.05) {
        const t = band?.kind === 'edge' && band.it.id === it.id && band.edge === 'end' ? band.t : it.source.take[1];
        g.fillRect(Math.round(v.xOf(t)) - 1, r.y + 3, 2, r.h - 6);
      }
      // File blocks: a flag where they play.
      const placed = [];
      for (const it of list) {
        if (it.kind === 'take') continue;
        const t = band?.kind === 'flag' && band.it.id === it.id ? band.t : it.at ?? 0;
        const x = v.xOf(t), same = placed.filter((px) => Math.abs(px - x) < 2).length;
        placed.push(x);
        if (x < -40 || x > v.W + 40) continue;
        const ink = col(it.type, true);
        g.fillStyle = ink;
        if (it.kind === 'pending') { for (let y = r.y + 2; y < r.y + r.h - 2; y += 5) g.fillRect(Math.round(x) - 1, y, 2, 3); }
        else g.fillRect(Math.min(v.W - 3, Math.round(x) - 1.5), r.y + 2, 3, r.h - 4);
        const tw = tagW(it), tx = tagX(x, tw, same, v), ty = r.y + 3 + same * 4;
        g.fillStyle = v.col.panelSolid; g.strokeStyle = ink; g.lineWidth = it.id === sel ? 2 : 1;
        g.beginPath(); g.roundRect(tx, ty, tw, 15, 4); g.fill(); g.stroke();
        g.fillStyle = ink; g.font = `600 10px ${font}`; g.textBaseline = 'middle';
        g.fillText(tagText(it), tx + 6, ty + 8);
      }
      if (band && band.kind !== 'block' && !v.snap) {
        const x = Math.round(v.xOf(band.t));
        g.fillStyle = v.col.sel; g.fillRect(x - 1, r.y, 2, r.h);
        g.font = `600 10px ${font}`; g.textBaseline = 'middle';
        const lab = clock(band.t), w = g.measureText(lab).width + 10;
        g.fillStyle = v.col.sel; g.beginPath(); g.roundRect(Math.min(v.W - w - 2, x + 4), r.y + r.h - 16, w, 13, 3); g.fill();
        g.fillStyle = v.col.selInk; g.fillText(lab, Math.min(v.W - w - 2, x + 4) + 5, r.y + r.h - 9);
      }
      g.restore();
    },
    down(p, r, v) {
      const hit = bandHit(p, r, v);
      if (!hit) return false;
      if (hit.kind === 'block') { sel = hit.it.id; sigN++; render(); return false; } // the timeline seeks too
      sel = hit.it.id;
      band = { ...hit, t: hit.kind === 'flag' ? hit.it.at ?? 0 : hit.it.source.take[hit.edge === 'end' ? 1 : 0], moved: false, x0: p.x };
      render();
      return true;
    },
    move(p, r, v, e) {
      if (!band) return;
      if (Math.abs(p.x - band.x0) > 3) band.moved = true;
      const t = Math.max(0, Math.min(view.take?.duration || v.dur || 0, v.tOf(p.x)));
      if (v.snap) band.t = v.snap(t, e, coreSnaps(band));
      else band.t = band.kind === 'edge' ? snap(t, v, view.snaps || []) : snap(t, v, flagSnaps());
    },
    async up() {
      const b = band;
      band = null;
      if (!b) return;
      if (!b.moved) { if (b.kind === 'flag') pick(b.it); sigN++; return; }
      if (b.kind === 'edge') await op({ op: 'edge', id: b.it.id, edge: b.edge, t: b.t });
      else if (b.kind === 'flag') {
        const end = b.t >= (view.take?.duration || 0) - 0.3;
        const r = await op(end ? { op: 'move', id: b.it.id, before: null } : { op: 'move', id: b.it.id, at: b.t }, true);
        if (r) toast(`${b.it.label} moved${end ? ' to the end' : ` to ${clock(b.t)}`}${b.it.rule ? `; “${b.it.ruleText}” no longer applies (block menu: Back to rule)` : ''}.`);
      }
    },
    hover(p, r, v) {
      if (band) return { cursor: band.kind === 'edge' ? 'ew-resize' : 'grabbing' };
      const hit = bandHit(p, r, v);
      if (!hit) return { cursor: '', title: '' };
      const it = hit.it;
      const title = hit.kind === 'edge' ? `Drag to move this boundary (snaps to word starts and pauses)${it.reason ? `\n${it.reason}` : ''}`
        : hit.kind === 'flag' ? `${it.label}: ${it.kind === 'file' ? it.source.file : 'no file yet'}\nPlays at ${clock(it.start)} in the video.${it.note ? `\n${it.note}` : ''}\nDrag along the take to move it; drop at the far right for the end.`
        : `${it.order}. ${it.label} · take ${clock(it.source.take[0])}–${clock(it.source.take[1])}${it.reason ? `\n${it.reason}` : ''}`;
      return { cursor: hit.kind === 'edge' ? 'ew-resize' : hit.kind === 'flag' ? 'grab' : 'pointer', title };
    },
  };

  // ---------- export ----------
  // The picture layers for every block that is its own picture: file blocks. (A take block's look is its shots':
  // web/app.js sends a set per shot look, and the export renders the take shot by shot.)
  function exportPngs(pngsFor, layout) {
    const out = {};
    for (const it of items()) if (it.kind === 'file' && it.file && !it.file.missing) out[it.id] = pngsFor(blockLayout(layout, it), it.file.dims);
    return out;
  }
  function exportNote() {
    if (!view?.exists || !view.parts) return '';
    const list = items().filter((x) => x.kind !== 'pending');
    const waiting = items().filter((x) => x.kind === 'pending');
    return `<dt>Blocks</dt><dd>${list.map((x) => `${esc(x.label)}${x.kind === 'file' ? ' <span class="sub">(own file)</span>' : ''}`).join(' · ')}
      <div class="sub">In this order, ${two(view.total)}${waiting.length ? `. Left out, no file yet: ${waiting.map((x) => esc(x.label)).join(', ')}` : ''}.</div></dd>`;
  }

  // ---------- @mentions in the chat composer ----------
  let mention = null; // { ta, mirror, menu, list, open, q, start, idx, refs: [] }
  function attachComposer(ta) {
    const wrap = h(`<div class="mn-wrap"><div class="mn-mirror" aria-hidden="true"></div></div>`);
    ta.replaceWith(wrap);
    wrap.append(ta);
    ta.placeholder = `Ask ${window.STUDIO_AGENT || 'Claude'}… type @ for a block or file`;
    const mirror = $('.mn-mirror', wrap);
    const menu = h(`<div class="mn-menu" role="listbox" aria-label="Point at…" hidden></div>`);
    wrap.closest('.composer').before(menu);
    mention = { ta, mirror, menu, list: null, q: null, start: 0, idx: 0, refs: [] };
    const paint = () => {
      let html = esc(ta.value);
      for (const m of [...mention.refs].sort((a, b) => b.label.length - a.label.length)) {
        const tok = esc(`@${m.label}`);
        html = html.split(tok).join(`<mark class="mn-chip k-${esc(m.kind || '')}">${tok}</mark>`);
      }
      mirror.innerHTML = html + '​';
      mirror.scrollTop = ta.scrollTop;
    };
    mention.paint = paint;
    ta.addEventListener('input', () => { mention.refs = mention.refs.filter((m) => ta.value.includes(`@${m.label}`)); paint(); lookup(); });
    ta.addEventListener('scroll', () => { mirror.scrollTop = ta.scrollTop; });
    ta.addEventListener('click', lookup);
    ta.addEventListener('blur', () => setTimeout(() => closeMenu(), 150));
    // Before the composer's own Enter-to-send: arrows, Enter and Tab work the menu while it's open.
    ta.addEventListener('keydown', (e) => {
      if (mention.menu.hidden) return;
      const opts = [...mention.menu.querySelectorAll('.mn-i')];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); mention.idx = (mention.idx + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % Math.max(1, opts.length); hi(); }
      else if ((e.key === 'Enter' || e.key === 'Tab') && opts.length) { e.preventDefault(); e.stopImmediatePropagation(); opts[mention.idx]?.click(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeMenu(); }
    }, true);
    paint();
  }
  const closeMenu = () => { if (mention) { mention.menu.hidden = true; mention.q = null; } };
  const hi = () => mention.menu.querySelectorAll('.mn-i').forEach((x, i) => { x.classList.toggle('on', i === mention.idx); x.setAttribute('aria-selected', String(i === mention.idx)); if (i === mention.idx) x.scrollIntoView({ block: 'nearest' }); });
  async function lookup() {
    const { ta } = mention;
    const before = ta.value.slice(0, ta.selectionStart);
    const m = /(^|\s)@([^@\n]{0,32})$/.exec(before);
    if (!m || /\s\s/.test(m[2]) || mention.refs.some((r) => m[2].startsWith(r.label)) || (/\s$/.test(m[2]) && !matchesAny(m[2]))) return closeMenu();
    mention.start = before.length - m[2].length - 1;
    const fresh = mention.q === null;
    mention.q = m[2];
    if (fresh || !mention.list) { try { mention.list = (await api(url('/mentions'))).groups; } catch { return closeMenu(); } }
    drawMenu();
  }
  const norm = (s) => String(s).toLowerCase();
  const matchesAny = (q) => (mention.list || []).some((g) => g.items.some((x) => norm(x.label).startsWith(norm(q).trim())));
  function drawMenu() {
    const q = norm(mention.q || '').trim();
    const groups = (mention.list || []).map((g) => {
      const seen = {};
      const items_ = g.items.map((x) => { const n = (seen[x.label] = (seen[x.label] || 0) + 1); return n > 1 ? { ...x, label: `${x.label} ${n}` } : x; })
        .filter((x) => !q || norm(x.label).includes(q) || norm(x.sub).includes(q)).slice(0, g.key === 'files' ? 6 : 8);
      return { ...g, items: items_ };
    });
    const any = groups.some((g) => g.items.length);
    if (!any) return closeMenu();
    mention.idx = Math.min(mention.idx, groups.reduce((t, g) => t + g.items.length, 0) - 1);
    mention.menu.replaceChildren(...groups.flatMap((g) => !g.items.length ? (g.key === 'library' && !q && g.empty ? [h(`<div class="mn-g">${esc(g.label)}</div>`), h(`<div class="mn-empty">${esc(g.empty)}</div>`)] : [])
      : [h(`<div class="mn-g">${esc(g.label)}</div>`), ...g.items.map((x) => {
        const b = h(`<button class="mn-i" role="option" type="button"><span class="mn-dot k-${esc(x.kind)}${x.isNew ? ' new' : ''}" aria-hidden="true"></span><b>${esc(x.label)}</b><small>${esc(x.sub || '')}</small></button>`);
        b.onmousedown = (e) => e.preventDefault();
        b.onclick = () => choose(x);
        return b;
      })]));
    mention.menu.hidden = false;
    // Just above the composer, whatever its height.
    const col = mention.menu.offsetParent, comp = mention.ta.closest('.composer');
    if (col && comp) mention.menu.style.bottom = `${col.getBoundingClientRect().bottom - comp.getBoundingClientRect().top + 6}px`;
    hi();
  }
  function choose(x) {
    const { ta } = mention;
    const end = ta.selectionStart;
    const ins = `@${x.label} `;
    ta.value = ta.value.slice(0, mention.start) + ins + ta.value.slice(end);
    const caret = mention.start + ins.length;
    ta.setSelectionRange(caret, caret);
    if (!mention.refs.some((m) => m.label === x.label)) mention.refs.push(x);
    closeMenu();
    ta.dispatchEvent(new Event('input'));
    ta.focus();
  }

  // On send: "@Block record new / use a file / from library" run here; otherwise the message goes to Claude with
  // the references resolved. Returns the text to send, or null when it was handled here.
  async function beforeSend(text) {
    if (!mention) return text;
    const used = mention.refs.filter((m) => text.includes(`@${m.label}`));
    mention.refs = [];
    mention.paint?.();
    if (!used.length) return text;
    const blk = used.filter((m) => /^(block|new):/.test(m.ref));
    if (blk.length === 1 && used.length === 1) {
      const rest = text.replace(`@${blk[0].label}`, '').replace(/[:,.!]/g, ' ').trim().toLowerCase().replace(/\s+/g, ' ');
      const cmd = /^(please )?(re-?record|record)( it| this| one)?( new| again| now| a new one)?$/.test(rest) || /^record (a )?new( take| one)?$/.test(rest) ? 'record'
        : /^(use|pick|add|choose|replace)( it with)?( a| the)? (file|video)$/.test(rest) || rest === 'use a file' ? 'file'
        : /^(from )?(the )?library$/.test(rest) ? 'library' : null;
      if (cmd) {
        const it = await ensureBlock(blk[0]);
        if (!it) return null;
        note?.(`${cmd === 'record' ? 'Opening Record setup for' : cmd === 'file' ? 'Pick a file for' : 'Pick a library item for'} the ${it.label} block${it.ruleText ? ` (${it.ruleText.toLowerCase()})` : ''}.`);
        if (cmd === 'record') recordInto(it); else if (cmd === 'file') chooseFile(it, blk[0].ref.startsWith('new:')); else chooseLibrary(it, blk[0].ref.startsWith('new:'));
        return null;
      }
    }
    return `${text}${REF_HEAD}${used.map((m) => `@${m.label}: ${m.resolve}`).join('\n')}`;
  }
  async function ensureBlock(m) {
    if (m.ref.startsWith('block:')) { await update(); return byId(m.ref.slice(6)) || null; }
    const type = m.ref.slice(4);
    const r = await op({ op: 'insert', type, label: m.blockLabel || m.label, source: { pending: 'record' }, ...(m.rule ? { rule: m.rule } : { where: { before: null } }) });
    return r?.id ? byId(r.id) : null;
  }
  // A sent message in the chat: mentions as chips, the references folded away.
  function renderUser(text) {
    const i = text.indexOf(REF_HEAD);
    if (i < 0) return null;
    const main = text.slice(0, i), refs = text.slice(i + REF_HEAD.length).split('\n').filter(Boolean);
    let html = esc(main);
    const labels = refs.map((l) => /^@(.+?): /.exec(l)?.[1]).filter(Boolean).sort((a, b) => b.length - a.length);
    for (const l of labels) html = html.split(esc(`@${l}`)).join(`<span class="mn-chip sent">${esc(`@${l}`)}</span>`);
    return `${html}<details class="mn-refs"><summary>${refs.length} reference${refs.length > 1 ? 's' : ''} for Claude</summary>${refs.map((l) => `<div>${esc(l)}</div>`).join('')}</details>`;
  }

  // ---------- the timeline's side (web/tlcore.js): undo for every block edit, select / split / delete / duplicate ----------
  const OP_LABEL = { insert: 'Add a block', update: 'Change a block', 'rule-back': 'Block back to its rule', move: 'Move a block', edge: 'Move a block boundary',
    duplicate: 'Duplicate a block', delete: 'Delete a block', attach: 'Give a block its file', split: 'Split a block', join: 'Join two blocks' };
  function remember(body, r) {
    if (!history || !r.before || !r.after || body.op === 'restore') return;
    const restore = (doc) => async () => { const x = await api(url('/blocks'), { op: 'restore', doc }); view = x.view; sigN++; render(); };
    history.push({ label: OP_LABEL[body.op] || 'Block edit', undo: restore(r.before), redo: restore(r.after) });
  }
  // What a dragged boundary or flag sticks to besides the timeline's own snaps: pauses, and the other blocks' edges.
  function coreSnaps(b) {
    const out = (view?.pauses || []).map((t) => ({ t, label: 'a pause' }));
    for (const it of items()) if (it.kind === 'take' && it.id !== b?.it?.id) out.push({ t: it.source.take[0], label: `${it.label} start` }, { t: it.source.take[1], label: `${it.label} end` });
    return out;
  }
  Object.assign(bandApi, {
    selected: () => (byId(sel) ? sel : null),
    selRange: () => { const it = byId(sel); return it ? (it.kind === 'take' ? it.source.take : [it.at ?? 0, (it.at ?? 0) + 0.5]) : null; },
    select(bid) { if (sel !== bid) { sel = bid; sigN++; render(); } },
    // Snap points for other drags on the timeline: where take blocks meet.
    snaps: () => items().filter((x) => x.kind === 'take').flatMap((x) => [{ t: x.source.take[0], label: `${x.label} start` }, { t: x.source.take[1], label: `${x.label} end` }]),
    async split(t) {
      const it = items().find((x) => x.kind === 'take' && t > x.source.take[0] && t < x.source.take[1]);
      if (!it) { toast('There is no block of the main take under the playhead to split.'); return null; }
      const r = await op({ op: 'split', id: it.id, t });
      if (r?.id) { sel = r.id; sigN++; render(); }
      return r;
    },
    // Delete: a file block leaves the row; a take block joins the block next to it (the take keeps playing).
    async removeSel() { const it = byId(sel); if (!it) return null; sel = null; return op({ op: it.kind === 'take' ? 'join' : 'delete', id: it.id }); },
    async duplicateSel() { const it = byId(sel); if (!it) return null; const r = await op({ op: 'duplicate', id: it.id }); if (r?.id) { sel = r.id; sigN++; render(); } return r; },
  });

  return {
    update, mount, band: bandApi, exportPngs, exportNote, attachComposer, beforeSend, renderUser,
    view: () => view,
    destroy: () => { closePop(); mention?.menu.remove(); strip = null; },
  };
}

// The editor's Media section: what a video uses and what can be done with it (server/media.mjs has the rules).
// It is the first section of the Canvas inspector, and the Media menu in the canvas toolbar has the same actions:
//   - Current recording: the canvas take, with Record again and Delete recording.
//   - On the canvas: the layers top to bottom (app.js renderLayers draws these rows: they follow the canvas's
//     selection, shots and hidden pictures). Extra layers have a handle: drag it, or ↑/↓ on it, to reorder; the eye
//     shows or hides; ⋯ has Sound, Take off the canvas and Remove from the video.
//   - Also in this video: older takes and imported files in source/: Use as the recording, Add as a layer, Remove.
//   - Recently removed: what went to the studio's trash, with Put back (the toast's Undo does the same).
// Nothing is ever deleted: Remove and Delete recording move the files to the trash, and the server refuses them while
// Claude or an export uses the files, or once a transcript, cut, scene plan or render was made from the recording.
import { $, esc, h, api, toast, confirmBox, ago } from './ui.js';
import { icon } from './icons.js';

const STAMP = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)/;
// A take's name: the recorder's stamp as a date and time; an imported file by its own name.
export function itemName(key) {
  const m = STAMP.exec(key || '');
  if (!m) return key;
  return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
const ROLE = { screen: 'Screen', camera: 'Camera', sound: 'Sound', video: 'Video' };
const mmss = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');
const size = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
// "Screen + camera · 1:23 · 340 MB"
export function itemWhat(item) {
  const roles = [...new Set(item.files.map((f) => f.role))].sort((a, b) => Object.keys(ROLE).indexOf(a) - Object.keys(ROLE).indexOf(b));
  const kinds = roles.map((r, i) => (i ? ROLE[r].toLowerCase() : ROLE[r])).join(' + ');
  return [kinds, mmss(item.duration), size(item.bytes)].filter(Boolean).join(' · ');
}
const how = (item) => (item.recorded ? 'Recorded' : 'Imported');

// The toast with buttons ("Recording deleted · Undo"), like the shots' (web/shotsui.js).
let toastT = 0;
function actionToast(text, acts) {
  const t = $('#toast');
  if (!t) return;
  t.replaceChildren(h(`<span>${esc(text)}</span>`), ...acts.map(([name, fn]) => {
    const b = h(`<button type="button" class="toast-a">${esc(name)}</button>`);
    b.onclick = () => { t.hidden = true; fn(); };
    return b;
  }));
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { if (t.querySelector('.toast-a')) t.hidden = true; }, 9000);
}

// The actions, shared by the section and the toolbar menu. ctx: { id, refresh(), note(text|null), openRecord(target),
// layerCount() }.
export function makeMediaActions(ctx) {
  const base = `/api/projects/${encodeURIComponent(ctx.id)}`;
  let busy = false;
  // A route that may ask first (409 { ok: false, confirm }): the question in a dialog, then again with confirm.
  async function run(path, b, { title, ok }) {
    if (busy) return null;
    busy = true;
    ctx.note(null);
    try {
      let r = await api(base + path, b);
      if (r.ok === false && r.confirm) {
        if (!(await confirmBox({ title, text: r.confirm, ok }))) return null;
        r = await api(base + path, { ...b, confirm: true });
      }
      return r.ok ? r : null;
    } catch (e) {
      ctx.note(e.message);
      return null;
    } finally {
      busy = false;
      ctx.refresh();
    }
  }
  async function restore(trash, name) {
    ctx.note(null);
    try {
      await api(`${base}/media-restore`, { trash });
      toast(`${name} is back.`);
    } catch (e) { ctx.note(e.message); }
    ctx.refresh();
  }
  return {
    restore,
    async use(item) {
      const r = await run('/media-use', { item: item.id }, { title: 'Use this take as the recording?', ok: 'Use this take' });
      if (r) toast(`${itemName(item.id)} is the recording now${r.was ? `; ${itemName(r.was)} is under Also in this video` : ''}.`);
    },
    async addLayer(item) {
      const r = await run('/media-layer', { item: item.id }, { title: 'Add as a layer?', ok: 'Add' });
      if (r) toast(`${itemName(item.id)} is on top as a layer. Drag its handle in Media to reorder.`);
    },
    async remove(item, { recording = false } = {}) {
      const name = recording ? 'Recording' : itemName(item.id);
      const r = await run('/media-remove', { item: item.id }, { title: recording ? 'Delete this recording?' : 'Remove from this video?', ok: recording ? 'Delete recording' : 'Remove' });
      if (!r) return;
      const after = r.canvas ? (r.activeTake ? ` The recording is ${itemName(r.activeTake)} again.` : ' The video has no recording now.') : '';
      actionToast(`${name} ${recording ? 'deleted' : 'removed'}: moved to the studio’s trash.${after}`, [['Undo', () => restore(r.trash, recording ? 'The recording' : name)]]);
    },
    recordAgain: () => ctx.openRecord('replace'),
    recordLayer: () => ctx.openRecord('layer'),
    // A video file from this computer, on top as a layer (POST /take-upload?target=layer).
    importLayer() {
      const input = h('<input type="file" class="vh" accept="video/*,.mov,.mp4,.m4v,.mkv,.webm">');
      document.body.append(input);
      input.onchange = async () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return;
        if (!/\.(mov|mp4|m4v|mkv|webm)$/i.test(file.name)) { ctx.note('Pick a video file (.mov, .mp4, .m4v, .mkv, .webm) for a layer.'); return; }
        toast(`Copying ${file.name}…`);
        try {
          const r = await fetch(`${base}/take-upload?target=layer&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/octet-stream' }, body: file });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `copying failed (${r.status})`);
          toast(`${file.name} is on top as a layer. Making a playback copy…`);
        } catch (e) { ctx.note(`The file didn’t come in: ${e.message}`); }
        ctx.refresh();
      };
      input.click();
    },
    // A take from the recordings folder (POST /import { target: 'layer' }).
    async fromRecordings(take) {
      ctx.note(null);
      try { await api(`${base}/import`, { take, target: 'layer' }); toast(`${itemName(take)} is on top as a layer.`); }
      catch (e) { ctx.note(e.message); }
      ctx.refresh();
    },
  };
}

// A small menu under a button: items [{ label, sub, run, disabled, danger }] or { head }. Esc, a click outside, a scroll
// or a pick closes it; ↑/↓ move between items. It sits on the page (fixed), so a list that clips its rows can't cut it;
// on a phone it is a sheet along the bottom (media.css).
export function popMenu(anchor, items, { label = 'Actions', align = 'right' } = {}) {
  document.querySelectorAll('.md-menu').forEach((m) => m.remove());
  const menu = h(`<div class="menu md-menu md-${align}" role="menu" aria-label="${esc(label)}"></div>`);
  for (const it of items) {
    if (it.head) { menu.append(h(`<div class="menu-h">${esc(it.head)}</div>`)); continue; }
    const b = h(`<button type="button" class="mi${it.danger ? ' md-danger' : ''}" role="menuitem"${it.disabled ? ' disabled' : ''}><b>${esc(it.label)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</button>`);
    b.onclick = (e) => { e.stopPropagation(); close(); it.run?.(); };
    menu.append(b);
  }
  const close = () => {
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    document.removeEventListener('scroll', onScroll, true);
    removeEventListener('resize', close);
  };
  const onScroll = (e) => { if (!menu.contains(e.target)) close(); };
  const outside = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };
  const key = (e) => {
    const list = [...menu.querySelectorAll('.mi:not(:disabled)')];
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); anchor.focus(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = list.indexOf(document.activeElement);
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
    }
  };
  document.body.append(menu);
  place(menu, anchor, align);
  anchor.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  document.addEventListener('scroll', onScroll, true);
  addEventListener('resize', close);
  menu.querySelector('.mi:not(:disabled)')?.focus();
  return { close, el: menu };
}

// Under the button (above it when there's no room below), inside the window with a 16px margin.
function place(menu, anchor, align) {
  if (innerWidth <= 600) return; // the sheet along the bottom
  const r = anchor.getBoundingClientRect(), m = menu.getBoundingClientRect(), pad = 16;
  const left = align === 'left' ? r.left : r.right - m.width;
  const below = r.bottom + 4, above = r.top - 4 - m.height;
  menu.style.left = `${Math.max(pad, Math.min(innerWidth - pad - m.width, left))}px`;
  menu.style.top = `${below + m.height <= innerHeight - pad || above < pad ? Math.max(pad, Math.min(below, innerHeight - pad - m.height)) : above}px`;
}

// "+ Add a layer": record one, import a file, or a take from the recordings folder.
export async function addLayerMenu(anchor, actions, { layerCount = 0, canLayer = true } = {}) {
  const full = layerCount >= 8;
  const why = !canLayer ? 'Record or import the recording first' : full ? 'A video has at most 8 layers' : '';
  const items = [
    { label: 'Record a new take as a layer…', sub: why || 'Opens Record; the take comes in on top', run: actions.recordLayer, disabled: Boolean(why) },
    { label: 'Import a video file…', sub: why || 'From this computer, on top in its own box', run: actions.importLayer, disabled: Boolean(why) },
  ];
  let takes = [];
  try { takes = await api('/api/takes'); } catch {}
  const usable = takes.filter((t) => !t.files.every((f) => /\.(wav|m4a|mp3|aif|aiff|caf|flac)$/i.test(f))).slice(0, 6);
  if (usable.length && !why) {
    items.push({ head: 'From your recordings' });
    for (const t of usable) items.push({ label: itemName(t.id), sub: t.used ? 'in a video already' : `${t.files.length} file${t.files.length > 1 ? 's' : ''}`, run: () => actions.fromRecordings(t.id) });
  }
  return popMenu(anchor, items, { label: 'Add a layer', align: 'left' });
}

// The current recording: one card with its name, what it is, and Record again / Delete recording.
export function currentCard(data, actions) {
  const item = data?.items.find((x) => x.canvas);
  if (!item) {
    return h(`<div class="md-current md-none"><div class="md-ct"><b>No recording yet</b><small>Record a take or drop a file to start.</small></div>
      <div class="md-btns"><button type="button" class="btn small rec" data-a="rec"><span class="rec-dot"></span>Record</button></div></div>`);
  }
  const work = data.work || [];
  const card = h(`<div class="md-current"><div class="md-ct"><span class="md-kicker">Current recording</span><b>${esc(itemName(item.id))}</b>
      <small>${esc(`${how(item)} · ${itemWhat(item)}`)}</small>${work.length ? `<small class="md-work">Has ${esc(work.join(', '))}</small>` : ''}</div>
    <div class="md-btns"><button type="button" class="btn small" data-a="rec" title="Record a new take that replaces this one (this one stays under Also in this video)"><span class="rec-dot"></span>Record again</button>
      <button type="button" class="btn small md-del" data-a="del" title="${esc(work.length ? `It already has ${work.join(', ')}: put another take on the canvas first` : 'Move this recording’s files to the studio’s trash (Undo brings it back)')}">${icon('trash', 14)}Delete recording</button></div></div>`);
  $('[data-a=rec]', card).onclick = () => actions.recordAgain();
  $('[data-a=del]', card).onclick = () => actions.remove(item, { recording: true });
  return card;
}

// Older takes and imported files that aren't on the canvas: Use as the recording, and ⋯ (Add as a layer, Remove).
export function otherRows(data, actions, { layerCount = 0 } = {}) {
  const items = (data?.items || []).filter((x) => !x.canvas && !x.layers.length);
  if (!items.length) return [];
  return items.map((item) => {
    const block = item.blocks.length ? `the ${item.blocks.map((b) => b.label).join(', ')} block’s file` : '';
    const row = h(`<div class="layer md-row" role="listitem"><span class="lk ${item.picture ? (item.files.some((f) => f.role === 'camera') ? 'cam' : 'screen') : 'audio'}" aria-hidden="true"></span>
      <span class="ln"><b>${esc(itemName(item.id))}</b><small>${esc([how(item), itemWhat(item), block].filter(Boolean).join(' · '))}</small></span>
      ${item.take && !item.blocks.length ? '<button type="button" class="btn small" data-a="use" title="Put this take back on the canvas as the recording">Use</button>' : ''}
      <span class="md-anchor"><button type="button" class="ly-eye md-more" aria-haspopup="menu" aria-expanded="false" aria-label="More for ${esc(itemName(item.id))}">${icon('more')}</button></span></div>`);
    $('[data-a=use]', row)?.addEventListener('click', () => actions.use(item));
    $('.md-more', row).onclick = (e) => {
      e.stopPropagation();
      popMenu(e.currentTarget, [
        { label: 'Use as the recording', sub: item.take ? 'It replaces the current recording on the canvas' : 'A sound file can’t be the recording', run: () => actions.use(item), disabled: !item.take || item.blocks.length > 0 },
        { label: 'Add as a layer', sub: !item.picture ? 'Sound only: no picture to put in a box' : layerCount >= 8 ? 'A video has at most 8 layers' : 'On top, in its own box', run: () => actions.addLayer(item), disabled: !item.picture || layerCount >= 8 },
        { label: 'Remove from this video…', sub: 'Its files go to the studio’s trash (Undo brings them back)', run: () => actions.remove(item), danger: true },
      ], { label: `${itemName(item.id)} actions` });
    };
    return row;
  });
}

// What went to the trash from this video, with Put back.
export function removedRows(data, actions) {
  return (data?.removed || []).slice(0, 3).map((r) => {
    const row = h(`<div class="md-gone"><span>${esc(r.wasCanvas ? 'Recording' : 'Removed')} <b>${esc(itemName(r.item))}</b> · ${esc(ago(r.at))}</span><button type="button" class="btn ghost small" data-a="back">Put back</button></div>`);
    $('[data-a=back]', row).onclick = () => actions.restore(r.trash, itemName(r.item));
    return row;
  });
}

// Drag a layer row's handle, or ↑/↓ on it, to reorder. Rows carry data-layer (the layer id) and are shown top to bottom.
// onMove(id, step): step +1 is one place up (drawn over one more), −1 one down; onDrop(id, targetId, above) for a drag.
// Call it again after the rows are redrawn: the list's own listeners are added once and use the newest callbacks.
export function wireReorder(list, { onMove, onDrop }) {
  list._reorder = { onMove, onDrop };
  list.querySelectorAll('[data-layer]').forEach((row) => {
    const grip = $('.md-grip', row);
    if (!grip) return;
    grip.addEventListener('pointerdown', () => { row.draggable = true; });
    row.addEventListener('dragstart', (e) => {
      list._dragId = row.dataset.layer;
      row.classList.add('md-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', list._dragId); } catch {}
    });
    row.addEventListener('dragend', () => {
      row.draggable = false;
      list._dragId = null;
      clearMarks(list, true);
    });
    grip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      list._reorder.onMove(row.dataset.layer, e.key === 'ArrowUp' ? 1 : -1);
    });
  });
  if (list.dataset.reorder) return;
  list.dataset.reorder = '1';
  const target = (e) => {
    const row = e.target.closest?.('[data-layer]');
    if (!row || row.dataset.layer === list._dragId) return null;
    const r = row.getBoundingClientRect();
    return { row, above: e.clientY < r.top + r.height / 2 };
  };
  list.addEventListener('dragover', (e) => {
    if (!list._dragId) return;
    e.preventDefault();
    clearMarks(list, false);
    const t = target(e);
    if (t) t.row.classList.add(t.above ? 'md-over-top' : 'md-over-bottom');
  });
  list.addEventListener('drop', (e) => {
    if (!list._dragId) return;
    e.preventDefault();
    const id = list._dragId, t = target(e);
    clearMarks(list, true);
    if (t) list._reorder.onDrop(id, t.row.dataset.layer, t.above);
  });
}
function clearMarks(list, dragging) {
  const sel = dragging ? '.md-dragging, .md-over-top, .md-over-bottom' : '.md-over-top, .md-over-bottom';
  list.querySelectorAll(sel).forEach((x) => x.classList.remove('md-dragging', 'md-over-top', 'md-over-bottom'));
}

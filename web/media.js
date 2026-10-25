// The editor's Media section: what a video uses and what can be done with it (server/media.mjs has the rules).
// It is the first section of the Canvas inspector, and the Media menu in the canvas toolbar has the same actions:
//   - Current recording: the canvas take, with Record again and Delete recording.
//   - On the canvas: the layers top to bottom (app.js renderLayers draws these rows: they follow the canvas's
//     selection, shots and hidden pictures). Extra layers have a handle: drag it, or ↑/↓ on it, to reorder; the eye
//     shows or hides; ⋯ has Sound, Take off the canvas and Remove from the video.
//   - Also in this video: older takes and imported files in source/: Use as the recording, Add as a layer, Remove.
//   - Recently removed: what went to the studio's trash, with Put back (the toast's Undo does the same).
// Delete recording asks one question with two answers (deleteChoice): Remove from this video (the files go to the
// studio's trash, the take stays in Recordings, Undo) or Delete recording (this video and Recordings, the files go to the
// computer's own Bin: the Trash or the Recycle Bin). "Don't ask again" remembers the answer (Settings › Storage › Trash
// changes it). Nothing is ever deleted outright, and the server refuses both while Claude or an export uses the files,
// while the take records or saves, or once a transcript, cut, scene plan or render was made from the recording.
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
export function actionToast(text, acts) {
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

// Delete recording's question. Resolves { choice: 'video' | 'bin', remember } or null (Cancel, Esc, a click outside).
// bin: where the computer's Bin is ('the Trash', 'the Recycle Bin'), or null when there is none (then it says the
// studio's trash). inRecordings: the take is in the Recordings folder too.
// video: the video's name when asked from Recordings (an imported file there, A17): the answers name it.
export function deleteChoice({ name, recording = true, inRecordings = true, bin = null, video = null }) {
  return new Promise((done) => {
    const where = bin ? `${bin} on this computer` : 'the studio’s trash (this computer has no Bin Video Octopus can use)';
    const m = h(`<div class="modal cf-modal"><div class="dialog cf dc" role="dialog" aria-modal="true" aria-labelledby="dcT" aria-describedby="dcD">
      <h3 id="dcT">${esc(recording ? 'Delete this recording?' : `Delete ${name}?`)}</h3>
      <p class="sub cf-text" id="dcD">${esc(recording ? name : 'Pick what happens to it.')}</p>
      <div class="dc-opts" role="group" aria-label="What to delete">
        <button type="button" class="dc-opt" data-c="video"><b>${esc(video ? `Remove from “${video}”` : 'Remove from this video')}</b><small>${esc(inRecordings ? `It stays in Recordings, so you can use it again. Undo brings it back ${video ? 'into the video' : 'here'}.` : 'Its files go to the studio’s trash. Undo brings it back here.')}</small></button>
        <button type="button" class="dc-opt dc-bin" data-c="bin"><b>Delete recording</b><small>${esc(`${inRecordings ? `Removes it from ${video ? `“${video}”` : 'this video'} and from Recordings` : 'Removes it from this video'}, and moves the files to ${where}.`)}</small></button>
      </div>
      <label class="dc-remember"><input type="checkbox" id="dcRemember"> Don’t ask again (Settings › Storage › Trash changes it)</label>
      <div class="actions"><button type="button" class="btn ghost" data-a="no">Cancel</button></div></div></div>`);
    const close = (v) => { document.removeEventListener('keydown', key); m.remove(); done(v); };
    const key = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', key);
    $('[data-a=no]', m).onclick = () => close(null);
    m.querySelectorAll('.dc-opt').forEach((b) => (b.onclick = () => close({ choice: b.dataset.c, remember: $('#dcRemember', m).checked })));
    m.onclick = (e) => { if (e.target === m) close(null); };
    document.body.append(m);
    $('[data-c=video]', m).focus();
  });
}

// The actions, shared by the section and the toolbar menu. ctx: { id, refresh(), note(text|null), openRecord(target),
// layerCount(), prefs(): { deleteRecording: 'ask' | 'video' | 'bin', bin }, remember(choice) }.
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
        if (!(await confirmBox({ title, text: r.confirm, ok, videos: r.videos }))) return null;
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
  // The Undo of a delete that went to the Bin: it comes back out of the Bin, then back into the video and Recordings.
  async function fromBin(token, name) {
    ctx.note(null);
    try { await api('/api/trash/from-bin', { token }); toast(`${name} is back.`); } catch (e) { ctx.note(e.message); }
    ctx.refresh();
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
    // Playback (server/playback.mjs): this video's own choice, or null to follow Settings › Storage › Playback.
    async playback(mode) {
      ctx.note(null);
      try {
        const r = await api(`${base}/playback`, { mode });
        toast(r.mode === 'optimise' ? 'Optimise for editing: 720p copies are made in the background. The originals play meanwhile, and the export uses them.' : 'Keep originals: the editor plays your original files.');
      } catch (e) { ctx.note(e.message); }
      ctx.refresh();
    },
    async deleteCopies() {
      ctx.note(null);
      try {
        const r = await api(`${base}/playback-copies-delete`, {});
        toast(r.files ? `Deleted ${r.files === 1 ? 'the 720p copy' : `${r.files} 720p copies`} (${size(r.bytes)}). The originals stay.` : 'There was nothing to delete.');
      } catch (e) { ctx.note(e.message); }
      ctx.refresh();
    },
    async use(item) {
      const r = await run('/media-use', { item: item.id }, { title: 'Use this take as the recording?', ok: 'Use this take' });
      if (r) toast(`${itemName(item.id)} is the recording now${r.was ? `; ${itemName(r.was)} is under Also in this video` : ''}.`);
    },
    async addLayer(item) {
      const r = await run('/media-layer', { item: item.id }, { title: 'Add as a layer?', ok: 'Add' });
      if (r) toast(`${itemName(item.id)} is on top as a layer. Drag its handle in Media to reorder.`);
    },
    // Remove from this video: the files go to the studio's trash; the take stays in Recordings.
    // An imported file (A17) moves to the recordings folder instead, so it stays in Recordings (r.parked).
    async remove(item, { recording = false, video = null } = {}) {
      const name = recording ? 'Recording' : item.name || itemName(item.id);
      const r = await run('/media-remove', { item: item.id }, { title: recording ? 'Remove this recording from the video?' : 'Remove from this video?', ok: 'Remove' });
      if (!r) return;
      const after = r.canvas ? (r.activeTake ? ` The recording is ${itemName(r.activeTake)} again.` : ' The video has no recording now.') : '';
      const from = video ? `“${video}”` : 'this video';
      const text = r.parked ? `${name} removed from ${from}. It’s in Recordings, so you can use it again.${after}`
        : `${name} removed from ${from}: moved to the studio’s trash${item.inRecordings ? ', and it’s still in Recordings' : ''}.${after}`;
      actionToast(text, [['Undo', () => restore(r.trash, recording ? 'The recording' : name)]]);
    },
    // Delete recording: the question (or the remembered answer), then Remove from this video or Delete to the Bin.
    // video: the video's name, when asked from Recordings (an imported file there, A17).
    async deleteRecording(item, { recording = true, video = null } = {}) {
      const prefs = ctx.prefs?.() || {};
      let choice = ['video', 'bin'].includes(prefs.deleteRecording) ? prefs.deleteRecording : null;
      if (!choice) {
        const a = await deleteChoice({ name: item.name || itemName(item.id), recording, inRecordings: item.inRecordings !== false, bin: prefs.bin || null, video });
        if (!a) return;
        choice = a.choice;
        if (a.remember) ctx.remember?.(choice);
      }
      if (choice === 'video') return this.remove(item, { recording, video });
      const r = await run('/media-delete', { item: item.id }, { title: 'This take is in other videos too', ok: 'Delete recording' });
      if (!r) return;
      const name = recording ? 'Recording' : item.name || itemName(item.id);
      const after = r.canvas ? (r.activeTake ? ` The recording is ${itemName(r.activeTake)} again.` : ' The video has no recording now.') : '';
      const from = video ? `“${video}”` : 'this video';
      const gone = r.recordings ? `from ${from} and Recordings` : `from ${from}`;
      if (r.bin) {
        const back = r.bin.putBack ? ` To get it back later, open ${r.bin.where} and use Put Back.` : '';
        actionToast(`${name} deleted ${gone}: moved to ${r.bin.where}.${after}${back}`, r.bin.undo ? [['Undo', () => fromBin(r.bin.undo, name)]] : []);
      } else {
        actionToast(`${name} deleted ${gone}. No Bin took it, so it’s in the studio’s trash (Settings › Storage › Trash).${after}`, [['Undo', () => restore(r.trash, recording ? 'The recording' : name)]]);
      }
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
          toast(`${file.name} is on top as a layer.`);
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
// live: while the first take records or saves (web/rec-live.js liveCard), what the card says instead of "No recording yet".
export function currentCard(data, actions, { live = null } = {}) {
  const item = data?.items.find((x) => x.canvas);
  if (!item && live) return h(`<div class="md-current md-none md-live"><div class="md-ct"><b><span class="rec-dot" aria-hidden="true"></span>${esc(live.title)}</b><small>${esc(live.sub)}</small></div></div>`);
  if (!item) {
    return h(`<div class="md-current md-none"><div class="md-ct"><b>No recording yet</b><small>Record a take or drop a file to start.</small></div>
      <div class="md-btns"><button type="button" class="btn small rec" data-a="rec"><span class="rec-dot"></span>Record</button></div></div>`);
  }
  const work = data.work || [];
  const card = h(`<div class="md-current"><div class="md-ct"><span class="md-kicker">Current recording</span><b>${esc(itemName(item.id))}</b>
      <small>${esc(`${how(item)} · ${itemWhat(item)}`)}</small>${work.length ? `<small class="md-work">Has ${esc(work.join(', '))}</small>` : ''}</div>
    <div class="md-btns"><button type="button" class="btn small" data-a="rec" title="Record a new take that replaces this one (this one stays under Also in this video)"><span class="rec-dot"></span>Record again</button>
      <button type="button" class="btn small md-del" data-a="del" title="${esc(work.length ? `It already has ${work.join(', ')}: put another take on the canvas first` : 'Remove it from this video, or delete it from this computer (it goes to the Bin)')}">${icon('trash', 14)}Delete recording</button></div></div>`);
  $('[data-a=rec]', card).onclick = () => actions.recordAgain();
  $('[data-a=del]', card).onclick = () => actions.deleteRecording(item, { recording: true });
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
        { label: 'Remove from this video…', sub: item.inRecordings ? 'Its files go to the studio’s trash; it stays in Recordings' : 'Its files go to the studio’s trash (Undo brings them back)', run: () => actions.remove(item), danger: true },
        { label: 'Delete recording…', sub: item.inRecordings ? 'From this video and Recordings, to the Bin' : 'This video’s copy, to the Bin', run: () => actions.deleteRecording(item, { recording: false }), danger: true },
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

// ---- Playback: Keep originals or Optimise for editing, for this video (Settings › Storage › Playback for all) ----
export const PLAYBACK_LABEL = { originals: 'Keep originals', optimise: 'Optimise for editing (720p copy)' };
export function playbackCard(pb, actions) {
  const ed = pb.copies?.editing || { files: 0, bytes: 0 };
  const slow = Object.entries(pb.files || {}).filter(([, x]) => x.slowSeek && x.using === 'original');
  const needed = Math.max(0, (pb.copies?.files || 0) - ed.files);
  const line = pb.mode === 'optimise'
    ? 'Plays 720p editing copies for smooth scrubbing (the originals until they are ready). Exports always use the originals.'
    : 'Plays your original files: no second copy is kept. Exports use them at full quality.';
  const card = h(`<div class="md-play"><div class="md-sub">Playback</div>
    <label class="md-play-row"><span class="vh">How this video plays while you edit</span><select class="field small" data-a="mode">
      <option value="">${esc(`As in Settings (${PLAYBACK_LABEL[pb.settings] || PLAYBACK_LABEL.originals})`)}</option>
      <option value="originals">${PLAYBACK_LABEL.originals}</option><option value="optimise">${PLAYBACK_LABEL.optimise}</option></select></label>
    ${slow.length ? `<small class="md-play-t md-play-slow">Seeking in ${esc(slow.map(([f]) => f).join(' and '))} is slow: ${slow.length === 1 ? 'it has' : 'they have'} a keyframe only every ${esc(String(Math.max(...slow.map(([, x]) => x.slowSeek))))} s. Optimise for editing makes a copy that scrubs smoothly.</small>` : ''}
    <small class="md-play-t">${esc(line)}${needed ? ` ${needed === 1 ? 'One file needs its copy' : `${needed} files need their copies`}: the browser can’t play ${needed === 1 ? 'it' : 'them'} as ${needed === 1 ? 'it is' : 'they are'}.` : ''}</small>
    ${ed.files ? `<div class="md-play-copies"><small>720p editing ${ed.files === 1 ? 'copy' : 'copies'}: ${esc(size(ed.bytes))}</small><button type="button" class="btn ghost small" data-a="delcopies" title="Delete for good: they are only for smooth editing and can be made again. Your originals stay.">Delete ${ed.files === 1 ? 'copy' : 'copies'}</button></div>` : ''}</div>`);
  const sel = $('[data-a=mode]', card);
  sel.value = pb.own || '';
  sel.onchange = () => actions.playback(sel.value || null);
  $('[data-a=delcopies]', card)?.addEventListener('click', () => actions.deleteCopies());
  return card;
}

// Settings › Storage › Trash: what's in the studio's trash (server/trash.mjs), how big it is, Put back for each item,
// and Empty trash. Deleted takes (the record panel and the Recordings page), media removed from a video (the editor's
// Media section) and takes dropped by Restart wait there. Nothing empties it by itself; emptying it is the only
// permanent delete in Video Octopus, so it always asks first, says how much goes and that it can't be undone, and the
// safe answer (Keep them) has the focus.
import { $, esc, h, api, toast, tilde, ago, plural } from './ui.js';
import { itemName } from './media.js';

const DAY = 86400000;
const OLD_DAYS = 30;
const SHOW = 12; // items listed before "Show all"
const size = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : b > 0 ? `${Math.max(1, Math.round(b / 1e3))} KB` : '0 KB');

// The permanent-delete question. Resolves true only on the delete button.
function confirmEmpty({ title, text, ok }) {
  return new Promise((done) => {
    const m = h(`<div class="modal cf-modal"><div class="dialog cf trash-cf" role="alertdialog" aria-modal="true" aria-labelledby="trashCfT" aria-describedby="trashCfD">
      <h3 id="trashCfT">${esc(title)}</h3><p class="sub cf-text" id="trashCfD">${esc(text)}</p>
      <p class="trash-warn"><b>This can’t be undone.</b> The files are deleted from this computer, not moved anywhere.</p>
      <div class="actions"><button type="button" class="btn ghost" data-a="no">Keep them</button><button type="button" class="btn trash-del" data-a="ok">${esc(ok)}</button></div></div></div>`);
    const close = (v) => { document.removeEventListener('keydown', key); m.remove(); done(v); };
    const key = (e) => { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', key);
    $('[data-a=no]', m).onclick = () => close(false);
    $('[data-a=ok]', m).onclick = () => close(true);
    m.onclick = (e) => { if (e.target === m) close(false); };
    document.body.append(m);
    $('[data-a=no]', m).focus();
  });
}

// ctx: the Settings page's { row, group } helpers. Returns the section's node (it loads its own data).
export function trashSection({ row, group }) {
  const box = h('<div class="trash-sec"><p class="sub">Loading…</p></div>');
  let all = false, busy = false;

  async function load() {
    let v;
    try { v = await api('/api/trash'); } catch (e) { box.replaceChildren(h(`<p class="notice">${esc(e.message)}</p>`)); return; }
    draw(v);
  }

  function draw(v) {
    const old = v.items.filter((x) => x.at < Date.now() - OLD_DAYS * DAY);
    const oldBytes = old.reduce((t, x) => t + x.bytes, 0);
    const summary = v.count ? `${plural(v.count, 'item')} · ${size(v.bytes)}` : 'Empty';
    const controls = h('<div class="trash-acts"></div>');
    if (old.length) {
      const b = h(`<button type="button" class="btn small">Delete ${plural(old.length, 'item')} older than ${OLD_DAYS} days…</button>`);
      b.onclick = () => empty({ olderThanDays: OLD_DAYS, count: old.length, bytes: oldBytes });
      controls.append(b);
    }
    const emptyBtn = h(`<button type="button" class="btn small trash-del"${v.count ? '' : ' disabled'}>Empty trash…</button>`);
    emptyBtn.onclick = () => empty({ count: v.count, bytes: v.bytes });
    controls.append(emptyBtn);
    const head = row('In the trash', `<span class="trash-sum" id="trashSum">${esc(summary)}</span> · in <span class="mono trash-where">${esc(tilde(v.where))}</span>`, controls);

    const list = h('<div class="trash-list" role="list" aria-label="Items in the trash"></div>');
    const shown = all ? v.items : v.items.slice(0, SHOW);
    for (const it of shown) {
      const r = h(`<div class="trash-item" role="listitem"><div class="trash-l"><b>${esc(itemName(it.name))}</b>
        <span class="sub">${esc(it.what)} · ${esc(ago(it.at))} · ${esc(size(it.bytes))}</span></div><div class="trash-c"></div></div>`);
      const c = $('.trash-c', r);
      if (it.restorable) {
        const b = h(`<button type="button" class="btn small" aria-label="${esc(`Put back ${itemName(it.name)}`)}">Put back</button>`);
        b.onclick = () => putBack(it, b);
        c.append(b);
      } else {
        c.append(h(`<span class="sub trash-why">${esc(it.why)}</span>`));
      }
      list.append(r);
    }
    if (!v.items.length) list.append(h('<p class="sub trash-none">Nothing in the trash. Deleted takes and media removed from a video show up here.</p>'));
    if (v.items.length > shown.length) {
      const more = h(`<button type="button" class="btn ghost small trash-more">Show all ${v.items.length}</button>`);
      more.onclick = () => { all = true; draw(v); };
      list.append(more);
    }
    const msg = h('<p class="trash-msg sub" role="status" aria-live="polite"></p>');
    box.replaceChildren(group('', head), list, msg);
  }

  const say = (text) => { const m = $('.trash-msg', box); if (m) m.textContent = text || ''; };

  async function putBack(it, btn) {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    say('');
    try {
      await api('/api/trash/restore', { trash: it.trash });
      toast(`${itemName(it.name)} is back${it.project ? ' in its video' : ' in Recordings'}.`);
      await load();
    } catch (e) {
      btn.disabled = false;
      say(e.message);
      toast(e.message);
    } finally { busy = false; }
  }

  async function empty({ olderThanDays = null, count, bytes }) {
    if (busy || !count) return;
    const what = `${plural(count, 'item')} (${size(bytes)})`;
    const yes = await confirmEmpty(olderThanDays
      ? { title: `Delete items older than ${olderThanDays} days?`, text: `This permanently deletes ${what} that went to the trash more than ${olderThanDays} days ago. Newer items stay.`, ok: `Delete ${plural(count, 'item')} permanently` }
      : { title: 'Empty the trash?', text: `This permanently deletes everything in the trash: ${what}. Nothing in your videos or Recordings changes.`, ok: `Delete ${plural(count, 'item')} permanently` });
    if (!yes) return;
    busy = true;
    try {
      const r = await api('/api/trash/empty', { confirm: true, ...(olderThanDays ? { olderThanDays } : {}) });
      toast(`Deleted ${plural(r.removed, 'item')} permanently (${size(r.bytes)} freed).`);
    } catch (e) { say(e.message); toast(e.message); }
    busy = false;
    await load();
  }

  load();
  return box;
}

// Simple mode's Media (V1 follow-ups, item 9: "some media section where the media is that you can just delete it"):
// a plain list under the step card, collapsed: the video's takes and dropped clips or sounds (Media's items, beta.18),
// the other files dropped in (pictures, notes; Claude's own pictures in source/ too) and the music under the video.
// Each row: a thumbnail or icon, the name, the length, and Delete with Undo. Deletes follow Media's own rules and
// routes (web/media.js makeMediaActions: a take asks Remove from this video / Delete recording to the Bin, or uses the
// remembered answer, beta.20 and beta.22); a dropped file goes to the studio's trash (/media-drop-remove, Undo with
// /media-restore); a music cue comes off the video (/sfx remove, Undo puts it back).
import { $, esc, h, api, toast } from './ui.js';
import { makeMediaActions, itemName, actionToast } from './media.js';

const mmss = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');
const kb = (b) => (b > 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

// The rows, from GET /media-items: [{ key, kind: take | clip | sound | picture | file | music, name, sub, thumb, … }].
// thumb: { video | img: a project file } or null (an icon).
export function mediaRows(data) {
  const rows = [];
  for (const it of data?.items || []) {
    const main = it.files.find((f) => f.role === 'camera') || it.files.find((f) => f.role === 'screen') || it.files.find((f) => f.role === 'video') || it.files[0];
    const kind = it.take ? 'take' : it.picture ? 'clip' : 'sound';
    rows.push({ key: `item:${it.id}`, kind, item: it, name: it.name || itemName(it.id),
      sub: [it.canvas ? 'Your recording' : kind === 'take' ? 'Another take' : kind === 'clip' ? 'Clip' : 'Sound', mmss(it.duration)].filter(Boolean).join(' · '),
      thumb: it.picture && main ? { video: `source/${main.file}` } : null });
  }
  for (const f of data?.dropped || []) rows.push({ key: `file:${f.file}`, kind: f.picture ? 'picture' : 'file', file: f.file, name: f.name, sub: [f.picture ? 'Picture' : 'File', kb(f.bytes)].join(' · '), thumb: f.picture ? { img: f.file } : null });
  for (const m of data?.music || []) rows.push({ key: `music:${m.id}`, kind: 'music', cue: m, name: m.label, sub: ['Music under the video', mmss(m.duration)].filter(Boolean).join(' · '), thumb: null });
  return rows;
}

const ICON = { sound: '♪', music: '♪', file: '¶', take: '●', clip: '▶', picture: '▣' };

// ctx: { id, getP, refresh, prefs(), remember(choice) } → { el, reload(), destroy() }
export function makeSimpleMedia(ctx) {
  const base = `/api/projects/${encodeURIComponent(ctx.id)}`;
  const el = h(`<details class="sx-media"><summary><b>Media</b> <span class="sub sx-media-n"></span></summary><ul class="sx-media-list" aria-label="This video’s media"></ul></details>`);
  const list = $('.sx-media-list', el);
  let data = null, alive = true, t = 0;
  const actions = makeMediaActions({ id: ctx.id, refresh: () => { ctx.refresh(); reload(); }, note: (text) => { if (text) toast(text); }, prefs: ctx.prefs, remember: ctx.remember,
    openRecord: () => toast('Record again from the step card.') });
  const fileUrl = (f) => `${base}/media?f=${encodeURIComponent(f)}`;
  function paint() {
    const rows = mediaRows(data);
    $('.sx-media-n', el).textContent = rows.length ? String(rows.length) : 'none yet';
    list.innerHTML = rows.length ? rows.map((r) => `<li class="sx-mi" data-key="${esc(r.key)}">
      <span class="sx-mi-pv" aria-hidden="true">${r.thumb?.img ? `<img src="${esc(fileUrl(r.thumb.img))}" alt="" loading="lazy">` : r.thumb?.video ? `<video src="${esc(fileUrl(r.thumb.video))}#t=0.5" muted playsinline preload="metadata"></video>` : `<i>${ICON[r.kind] || '·'}</i>`}</span>
      <span class="sx-mi-t"><b title="${esc(r.name)}">${esc(r.name)}</b><span class="sub">${esc(r.sub)}</span></span>
      <button type="button" class="btn small ghost sx-mi-del" data-del="${esc(r.key)}" aria-label="${esc(`Delete ${r.name}`)}">Delete</button></li>`).join('')
      : '<li class="sub sx-mi-none">Your takes, the files you drop in and the music show here.</li>';
  }
  async function reload() {
    clearTimeout(t);
    t = setTimeout(async () => {
      try { data = await api(`${base}/media-items`); } catch { data = null; }
      if (alive) paint();
    }, 150);
  }
  list.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    const r = mediaRows(data).find((x) => x.key === b.dataset.del);
    if (!r) return;
    b.disabled = true;
    try {
      if (r.item) await actions.deleteRecording(r.item, { recording: r.item.canvas });
      else if (r.file) {
        const x = await api(`${base}/media-drop-remove`, { file: r.file });
        actionToast(`${r.name} removed from this video: moved to the studio’s trash.`, [['Undo', () => actions.restore(x.trash, r.name)]]);
      } else if (r.cue) {
        await api(`${base}/sfx`, { op: 'remove', id: r.cue.id });
        const P = ctx.getP();
        if (P?.simpleTools?.music?.cue === r.cue.id) await api(`${base}/simple-tools`, { music: null }).catch(() => {});
        actionToast(`${r.name} is off the video.`, [['Undo', async () => {
          try { await api(`${base}/sfx`, { op: 'add', file: r.cue.file, from: 'project', t: r.cue.t, gain: r.cue.gain, label: `Music: ${r.name}` }); toast(`${r.name} is back.`); } catch (err) { toast(err.message); }
          ctx.refresh(); reload();
        }]]);
      }
    } catch (err) { toast(err.message); }
    ctx.refresh(); reload();
  });
  reload();
  return { el, reload, destroy() { alive = false; clearTimeout(t); el.remove(); } };
}

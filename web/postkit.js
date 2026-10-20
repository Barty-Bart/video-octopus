// The Post tab: the post kit as one card per platform (YouTube; Instagram and TikTok for Shorts; the
// comment WORD and its DM), each field with a copy button. "Write it" asks the project's Claude to fill
// work/post.json from the transcript and the project, fact-checked; edits here save as you type.
import { $, esc, h, api, toast, ago } from './ui.js';
import { styleSection } from './library.js';

const isShort = (t) => ['short', 'reel'].includes(t);
const MARK = {
  youtube: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="1" y="3.5" width="16" height="11" rx="3.2" fill="#ff0000"/><path d="M7.4 6.6v4.8L11.6 9z" fill="#fff"/></svg>',
  instagram: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><defs><linearGradient id="igG" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#feda75"/><stop offset=".45" stop-color="#d62976"/><stop offset="1" stop-color="#4f5bd5"/></linearGradient></defs><rect x="1.5" y="1.5" width="15" height="15" rx="4.2" fill="url(#igG)"/><circle cx="9" cy="9" r="3.3" fill="none" stroke="#fff" stroke-width="1.5"/><circle cx="13.1" cy="4.9" r=".9" fill="#fff"/></svg>',
  tiktok: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="1" y="1" width="16" height="16" rx="4" fill="#111"/><path d="M10.2 4h1.7c.2 1.3 1 2.1 2.2 2.2v1.7c-.9 0-1.6-.3-2.2-.7v3.6a3.1 3.1 0 1 1-3.1-3.1v1.7a1.4 1.4 0 1 0 1.4 1.4z" fill="#fff"/></svg>',
  dm: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="1" y="1" width="16" height="16" rx="4" fill="var(--accent)"/><path d="M4.5 6.2h9M4.5 9h6M5 13l1.6-1.6H13.5V4.6H4.5V13z" fill="none" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>',
};

const CARDS = [
  { key: 'youtube', title: 'YouTube', sub: (s) => (s ? 'Shorts: title, description, pinned comment' : 'Title, description, pinned comment'), fields: [
    { path: 'youtube.title', label: 'Title', max: 100, rows: 1 },
    { path: 'youtube.description', label: 'Description', max: 5000, rows: 6 },
    { path: 'youtube.comment', label: 'Pinned comment', max: 1000, rows: 3 },
  ] },
  { key: 'instagram', title: 'Instagram', short: true, sub: () => 'Reel caption with hashtags', fields: [{ path: 'instagram.caption', label: 'Caption', max: 2200, rows: 10, tags: true }] },
  { key: 'tiktok', title: 'TikTok', short: true, sub: () => 'Caption with hashtags', fields: [{ path: 'tiktok.caption', label: 'Caption', max: 4000, rows: 7, tags: true }] },
  { key: 'dm', title: 'Comment WORD → DM', sub: () => 'Viewers comment the WORD; the auto-reply tool sends the DM', fields: [
    { path: 'word', label: 'Comment WORD', rows: 1, word: true },
    { path: 'dm.reply', label: 'DM reply', max: 1000, rows: 4 },
  ] },
];
const get = (o, path) => path.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o) ?? '';

async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
  }
  btn.classList.add('done'); btn.textContent = 'Copied';
  clearTimeout(btn._t); btn._t = setTimeout(() => { btn.classList.remove('done'); btn.textContent = 'Copy'; }, 1400);
}

// empty(run): the empty state while nothing is written (web/rail.js: the step words, the way there, the next step).
export function makePostKit({ pane, id, getP, empty }) {
  let data = null, seenAt = -1, built = null, saveTimer = 0, pending = {}, savedAt = 0, asked = 0;
  const url = `/api/projects/${encodeURIComponent(id)}`;
  // Asked Claude and the kit hasn't changed since (for up to 10 minutes).
  const writing = () => Boolean(asked && Date.now() - asked < 600e3);

  async function load() {
    try { data = await api(`${url}/post`); } catch (e) { data = null; }
    if (asked && (data?.at || 0) > Math.max(seenAt, 0)) asked = 0;
    seenAt = data?.at || 0;
    render();
  }

  function status() {
    const P = getP();
    if (writing()) return '<span class="spin" style="display:inline-block;vertical-align:-2px"></span> Claude is writing it…';
    if (!data?.exists) return 'Not written yet';
    const edits = Object.keys(data.post.edited || {}).length;
    return `${savedAt && Date.now() - savedAt < 4000 ? 'Saved · ' : ''}Updated ${ago(data.at)}${edits ? ` · ${edits} field${edits > 1 ? 's' : ''} edited by you` : ''} · work/post.json`;
  }

  function render() {
    const P = getP();
    const short = isShort(P.type);
    const p = data?.post;
    const cards = CARDS.filter((c) => short || !c.short);
    const sig = JSON.stringify([short, Boolean(data?.exists), data?.exists ? null : P.pipeline?.current]);
    const writeLabel = data?.exists ? 'Rewrite with Claude' : 'Write it with Claude';
    if (built !== sig) {
      built = sig;
      pane.replaceChildren(h(`<div class="pk">
        <div class="pk-head"><div><h2>Post kit</h2><div class="sub" id="pkStatus"></div></div><span class="gap"></span>
          <button class="btn accent" id="pkWrite" title="Claude writes the kit from the transcript and the project, checks every link and claim, and keeps what you edited">${esc(writeLabel)}</button></div>
        ${data?.exists ? '' : `<div class="pk-empty"><b>Nothing written yet</b><span class="sub">Claude writes the ${short ? 'YouTube title and description, the Instagram and TikTok captions' : 'YouTube title, description and pinned comment'}, the comment WORD and the DM from this video's transcript. It checks every link and never makes one up.</span></div>`}
        <div class="pk-cards">${cards.map((c) => `<section class="pk-card" data-card="${c.key}">
          <div class="pk-ch">${MARK[c.key]}<div><b>${esc(c.title)}</b><span class="sub">${esc(c.sub(short))}</span></div></div>
          ${c.fields.map((f) => `<div class="pk-field${f.word ? ' word' : ''}" data-path="${f.path}">
            <div class="pk-lab"><label for="pk-${f.path}">${esc(f.label)}</label><span class="pk-count"></span><button class="btn ghost small pk-copy" aria-label="Copy ${esc(f.label)}">Copy</button></div>
            ${f.rows === 1 ? `<input class="field pk-in" id="pk-${f.path}" autocomplete="off" spellcheck="${f.word ? 'false' : 'true'}">` : `<textarea class="field pk-in" id="pk-${f.path}" rows="${f.rows}"></textarea>`}</div>`).join('')}
          ${c.key === 'dm' ? `<div class="pk-tool"><span class="sub">Sent by</span><div class="seg" role="radiogroup" aria-label="Auto-reply tool"><button role="radio" data-tool="LinkDM">LinkDM</button><button role="radio" data-tool="ManyChat">ManyChat</button></div></div>` : ''}
        </section>`).join('')}
        <section class="pk-card pk-checked" id="pkChecked" hidden></section></div></div>`));
      $('#pkWrite', pane).onclick = write;
      // Nothing written yet: the step rail's empty state (which step fills it and the way there) in place of the plain note.
      const er = !data?.exists && empty?.(write);
      if (er) $('.pk-empty', pane).replaceWith(er);
      pane.querySelectorAll('.pk-field').forEach((box) => {
        const inp = $('.pk-in', box), path = box.dataset.path;
        inp.oninput = () => { if (path === 'word') { const s = inp.selectionStart; inp.value = inp.value.toUpperCase().replace(/\s+/g, ''); inp.setSelectionRange(s, s); } count(box); queue(path, inp.value); };
        $('.pk-copy', box).onclick = (e) => { if (!inp.value.trim()) return toast('Nothing to copy yet.'); copyText(inp.value, e.currentTarget); };
      });
      pane.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => { queue('dm.tool', b.dataset.tool); data.post.dm.tool = b.dataset.tool; tools(); }));
    }
    $('#pkStatus', pane).innerHTML = status();
    $('#pkWrite', pane).textContent = writeLabel;
    const w2 = document.getElementById('pkWrite2');
    if (w2) { w2.textContent = writeLabel; w2.disabled = writing(); }
    $('#pkWrite', pane).disabled = writing();
    // Fill the fields, except the one being typed in (and edits not saved yet).
    pane.querySelectorAll('.pk-field').forEach((box) => {
      const inp = $('.pk-in', box), path = box.dataset.path;
      if (document.activeElement !== inp && !(path in pending)) inp.value = p ? get(p, path) : '';
      count(box);
    });
    tools();
    checked(p);
  }

  function tools() {
    const t = data?.post?.dm?.tool || 'LinkDM';
    pane.querySelectorAll('[data-tool]').forEach((b) => { b.classList.toggle('on', b.dataset.tool === t); b.setAttribute('aria-checked', String(b.dataset.tool === t)); });
  }

  function count(box) {
    const def = CARDS.flatMap((c) => c.fields).find((f) => f.path === box.dataset.path);
    const v = $('.pk-in', box).value;
    const tags = def.tags ? (v.match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length : 0;
    const over = def.max && v.length > def.max;
    $('.pk-count', box).textContent = def.word ? '' : `${def.tags ? `${tags} hashtag${tags === 1 ? '' : 's'} · ` : ''}${v.length}${def.max ? ` / ${def.max}` : ''}`;
    $('.pk-count', box).classList.toggle('over', Boolean(over));
  }

  // What Claude checked: links (with the date), facts, and what still needs the creator.
  function checked(p) {
    const box = $('#pkChecked', pane);
    if (!p || (!p.links.length && !p.facts.length && !p.notes.trim())) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<div class="pk-ch"><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8" fill="var(--ok)"/><path d="M5.3 9.2l2.4 2.4 5-5" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><div><b>Checked</b><span class="sub">Links and claims Claude verified</span></div></div>
      ${p.notes.trim() ? `<div class="notice pk-notes"><b>Still needs you:</b> ${esc(p.notes)}</div>` : ''}
      ${p.links.length ? `<h4>Links</h4><ul class="pk-links">${p.links.map((l) => `<li>${l.label ? `${esc(l.label)}: ` : ''}${/^https?:\/\//.test(l.url) ? `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url)}</a>` : esc(l.url)}${l.checked ? ` <span class="sub">checked ${esc(l.checked)}</span>` : ''}</li>`).join('')}</ul>` : ''}
      ${p.facts.length ? `<h4>Facts</h4><ul class="pk-facts">${p.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}`;
  }

  function queue(path, value) {
    pending[path] = value;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 500);
  }
  async function flush() {
    const patch = pending; pending = {};
    if (!Object.keys(patch).length) return;
    try { data = await api(`${url}/post`, { patch }); seenAt = data.at; savedAt = Date.now(); $('#pkStatus', pane).innerHTML = status(); if (!$('#pkChecked', pane).hidden || data.post.notes) checked(data.post); }
    catch (e) { toast(`Couldn’t save: ${e.message}`); Object.assign(pending, patch); }
  }

  async function write() {
    await flush();
    try { await api(`${url}/post-write`, {}); asked = Date.now(); toast('Claude is writing the post kit. Follow it in the chat.'); render(); }
    catch (e) { toast(e.message); }
  }

  // The post-tab inspector: Write it, the style (Shorts), files.
  async function inspector(box) {
    const P = getP();
    box.replaceChildren(h(`<div class="ins-body">
      <div class="ins-head"><b>Post kit</b><span class="sub">${esc(isShort(P.type) ? 'Short' : 'YouTube')}</span></div>
      <section><h3>Claude</h3><button class="btn accent wide" id="pkWrite2">${data?.exists ? 'Rewrite with Claude' : 'Write it with Claude'}</button>
        <p class="sub" style="margin-top:8px">From the transcript and the project, in your voice. Every link and claim is checked; nothing is made up. Fields you edit stay as you wrote them.</p></section>
      <div id="pkStyle"></div>
      <section><h3>Files</h3><dl class="facts"><dt>Kit</dt><dd>work/post.json</dd><dt>Page</dt><dd>post.md</dd></dl></section></div>`));
    $('#pkWrite2', box).onclick = write;
    await styleSection($('#pkStyle', box), { id, getP });
  }

  return {
    show: () => load(),
    // A project refresh: reload when Claude (or anyone) changed work/post.json.
    update: (visible) => {
      const at = getP().kit?.post?.at || 0;
      if (asked && at > seenAt) asked = 0;
      if (!visible) return;
      if (at !== seenAt) load(); else if (data) render();
    },
    inspector,
    destroy: () => { clearTimeout(saveTimer); flush(); },
  };
}

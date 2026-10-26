// Resources (V1 spec §4, board "V1 Resources"), Simple mode's second menu item: what Claude uses in every video.
//   Your look: colour swatches, font and a one-line voice, from the built-in brand ("My brand"). Edit changes them;
//   Get my look from my website runs the brand research (B12, web/brand-research.js) on that brand and shows its
//   proposal, which is saved only when the creator presses Use this look.
//   Files: one grid of everything uploaded (logo, fonts, photos of you, products, clips; web/resource-kinds.js), each
//   with a preview, its name and one line of use; Rename, Use as and Remove (to the studio's trash, with Undo).
// Server: /api/simple-resources (server/simple-resources.mjs); the research's own routes (/api/profile-research).
import { $, esc, h, api, toast } from './ui.js';
import { icon } from './icons.js';
import { actionToast } from './media.js';
import { KIT_PALETTE, avatarInk } from './kit-colors.js';
import { startResearch, researchActions } from './brand-research.js';
import { SIMPLE_KINDS, PICTURE_KINDS, ACCEPT, guessKind, lookColors, IMAGE_FILE, FONT_FILE, VIDEO_FILE } from './resource-kinds.js';

const LEAD = 'What Claude uses in every video: your look, your photos, your products.';
const fileUrl = (id) => `/api/simple-resources/${encodeURIComponent(id)}/file`;
const firstLine = (t, n) => String(t || '').split(/\n/)[0].trim().slice(0, n);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const dismissed = new Set(); // research proposals answered "Not now" while the page stays open
const fonts = new Map(); // resource id → its FontFace family, once loaded

// A font file's family for previews ("Aa" in the font itself). Never throws: a font the browser can't read shows plain.
function fontFamily(id) {
  if (fonts.has(id)) return fonts.get(id);
  const family = `vo-res-${id.replace(/[^a-z0-9]/gi, '').slice(0, 24)}`;
  fonts.set(id, family);
  try {
    const face = new FontFace(family, `url(${fileUrl(id)})`);
    face.load().then((f) => document.fonts.add(f)).catch(() => {});
  } catch {}
  return family;
}

// One file's preview: the picture, the clip's first frame, or "Aa" in the font.
function preview(f) {
  if (f.kind === 'font' || FONT_FILE.test(f.name)) return `<span class="res-aa" style="font-family:'${fontFamily(f.id)}', var(--font)">Aa</span>`;
  if (f.kind === 'clip' || VIDEO_FILE.test(f.name)) return `<video src="${fileUrl(f.id)}#t=0.1" muted playsinline preload="metadata" aria-hidden="true"></video><span class="res-play" aria-hidden="true"></span>`;
  if (IMAGE_FILE.test(f.name)) return `<img class="${f.kind === 'photo' ? 'cover' : 'fit'}" src="${fileUrl(f.id)}" alt="" loading="lazy" decoding="async">`;
  return `<span class="res-aa">·</span>`;
}

// The upload's one question, inline above the grid: what a picture is. Resolves 'photo' | 'product' | 'logo' | null.
function askKind(box, file) {
  return new Promise((done) => {
    const url = URL.createObjectURL(file);
    const card = h(`<div class="res-ask" role="group" aria-labelledby="resAskT">
      <span class="res-ask-pic"><img src="${url}" alt=""></span>
      <span class="res-ask-t"><b id="resAskT">Is this a photo of you?</b><span class="sub">${esc(file.name)}</span></span>
      <span class="res-ask-a">
        <button type="button" class="btn small primary" data-k="photo">Yes, it’s me</button>
        <button type="button" class="btn small" data-k="product">No, a product</button>
        <button type="button" class="btn small" data-k="logo">It’s my logo</button>
        <button type="button" class="btn small ghost" data-k="">Skip</button>
      </span></div>`);
    const end = (k) => { card.remove(); URL.revokeObjectURL(url); done(k || null); };
    card.addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) end(b.dataset.k); });
    card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); end(null); } });
    box.replaceChildren(card);
    $('[data-k=photo]', card).focus();
  });
}

// ctx: { makeChat } (app.js's chat, for the research session's messages and permission requests).
export function renderResources(main, ctx = {}) {
  let live = true, data = null, editing = false, researchOpen = false, events = null, chat = null, menu = null;
  main.replaceChildren(h(`<div class="pv pv-simple res">
    <header class="pv-head res-head">
      <span class="res-title"><h1>Resources</h1><span class="sub">${esc(LEAD)}</span></span>
      <label class="btn primary res-up">${icon('upload', 14)}Upload<input type="file" id="resFile" multiple accept="${ACCEPT}" hidden></label>
    </header>
    <section class="res-sec" aria-labelledby="resLookH"><h2 class="res-h" id="resLookH">Your look</h2><div id="resLook"><p class="sub">Loading…</p></div></section>
    <section class="res-sec" aria-labelledby="resFilesH"><h2 class="res-h" id="resFilesH">Files</h2><div id="resAsk"></div><div id="resFiles"></div></section>
  </div>`));
  const root = $('.res', main);

  const closeChat = () => { events?.close(); chat?.destroy?.(); events = null; chat = null; };
  const closeMenu = () => { menu?.remove(); menu = null; document.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (menu && !menu.contains(e.target) && !e.target.closest('.res-more')) closeMenu(); };

  async function load() {
    data = await api('/api/simple-resources');
    if (!live) return;
    paintLook();
    paintFiles();
  }

  // ---- Your look ----
  function paintLook() {
    const box = $('#resLook', root), look = data.look;
    const sw = look.colors.map((c) => `<i style="background:${esc(c)}" title="${esc(c)}"></i>`).join('');
    const fontFile = data.files.find((f) => f.kind === 'font');
    const face = fontFile ? `font-family:'${fontFamily(fontFile.id)}', var(--font)` : '';
    const name = firstLine(look.fonts, 60) || (fontFile ? fontFile.name.replace(/\.[a-z0-9]+$/i, '') : '');
    const r = data.research;
    box.replaceChildren(h(`<div class="res-look">
      <div class="res-look-row">
        <span class="res-sw" role="img" aria-label="${esc(`Colours: ${look.colors.join(', ') || 'none yet'}`)}">${sw || '<span class="res-sw-none sub">No colours yet</span>'}</span>
        <span class="res-font"><b${face ? ` style="${face}"` : ''}>${esc(name || 'No font yet')}</b><span class="sub">${esc(firstLine(look.voice, 120) || 'Voice not set yet')}</span></span>
        <span class="res-gap"></span>
        <button type="button" class="btn" data-a="research" aria-expanded="${researchOpen}">Get my look from my website</button>
        <button type="button" class="btn ghost" data-a="edit" aria-expanded="${editing}">Edit</button>
      </div>
      <div id="resEdit"></div>
      <div id="resResearch"></div>
    </div>`));
    $('[data-a=edit]', box).onclick = () => { editing = !editing; if (editing) researchOpen = false; paintLook(); };
    $('[data-a=research]', box).onclick = () => {
      researchOpen = !researchOpen;
      if (researchOpen) { editing = false; if (r?.status === 'review') dismissed.add(r.id); } // a new website instead
      paintLook();
    };
    if (editing) paintEdit($('#resEdit', box));
    // A research session still running or waiting for review shows by itself.
    const pending = r && (r.status === 'running' || (r.status === 'review' && !dismissed.has(r.id)));
    if (researchOpen || pending) paintResearch($('#resResearch', box));
    else closeChat();
  }

  function paintEdit(box) {
    const look = data.look;
    let lead = look.colors[0] || '', more = look.colors.slice(1);
    const form = h(`<form class="res-panel res-edit" aria-label="Edit your look">
      <fieldset class="res-f"><legend>Main colour</legend><span class="sub">Titles, cards and thumbnails lead with it.</span>
        <span class="kc-sw res-main" role="radiogroup" aria-label="Main colour"></span></fieldset>
      <fieldset class="res-f"><legend>More colours</legend><span class="res-more-c"></span></fieldset>
      <label class="res-f">Font<input name="fonts" maxlength="400" value="${esc(look.fonts)}" placeholder="Inter, or the name of the font file you uploaded"></label>
      <label class="res-f">Voice<input name="voice" maxlength="400" value="${esc(look.voice)}" placeholder="Friendly and plain, a bit dry"></label>
      <div class="res-acts"><button class="btn primary">Save look</button><button type="button" class="btn ghost" data-a="cancel">Cancel</button></div>
    </form>`);
    const paintColors = () => {
      const custom = lead && !KIT_PALETTE.some(([hex]) => hex === lead);
      $('.res-main', form).innerHTML = `${KIT_PALETTE.map(([hex, name]) => `<button type="button" role="radio" class="kc-dot" data-main="${hex}" style="--c:${hex}" aria-checked="${hex === lead}" aria-label="${name}" title="${name}"></button>`).join('')}
        <label class="kc-dot kc-custom${custom ? ' on' : ''}"${custom ? ` style="--c:${lead}"` : ''} title="Another colour"><input type="color" data-main-custom value="${lead || '#4f5bd5'}" aria-label="Another main colour"></label>`;
      $('.res-more-c', form).innerHTML = `${more.map((c, i) => `<span class="res-chip" style="--c:${c};--ink:${avatarInk(c)}"><i></i>${esc(c)}<button type="button" data-drop="${i}" aria-label="${esc(`Remove ${c}`)}">${icon('close', 12)}</button></span>`).join('')}
        ${more.length < 5 ? `<label class="btn small res-add-c">${icon('plus', 12)}Add colour<input type="color" data-add value="#111111" aria-label="Add a colour"></label>` : ''}`;
    };
    paintColors();
    form.addEventListener('click', (e) => {
      const m = e.target.closest('[data-main]'), d = e.target.closest('[data-drop]');
      if (m) { lead = m.dataset.main; paintColors(); }
      if (d) { more.splice(Number(d.dataset.drop), 1); paintColors(); }
    });
    form.addEventListener('change', (e) => {
      if (e.target.matches('[data-main-custom]')) { lead = e.target.value; paintColors(); }
      if (e.target.matches('[data-add]')) { more = lookColors('', [...more, e.target.value]).slice(0, 5); paintColors(); }
    });
    $('[data-a=cancel]', form).onclick = () => { editing = false; paintLook(); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const b = $('button.primary', form);
      b.disabled = true;
      try {
        await api('/api/simple-resources/look', { colors: lookColors(lead, more), fonts: form.elements.fonts.value, voice: form.elements.voice.value, expected: data.brandVersion });
        editing = false;
        toast('Look saved. Claude uses it in your videos.');
        await load();
      } catch (err) { toast(err.message); b.disabled = false; }
    };
    box.replaceChildren(form);
    form.elements.fonts.focus({ preventScroll: true });
  }

  // ---- Get my look from my website (the brand research, B12) ----
  async function paintResearch(box) {
    const r = data.research;
    const running = r?.status === 'running';
    const review = r && r.status === 'review' && !dismissed.has(r.id);
    if (!running && !review) {
      closeChat();
      const failed = r && ['failed', 'interrupted'].includes(r.status) && researchOpen;
      const form = h(`<form class="res-panel res-research" aria-label="Get my look from my website">
        <label class="res-f">Your website<input type="url" name="url" required placeholder="https://yoursite.com" value="${esc(failed ? r.url : '')}"></label>
        <span class="sub">Claude reads your site and suggests colours, fonts and a voice. Nothing changes until you say Use this look.</span>
        ${failed ? `<p class="res-err" role="alert">${esc(r.error || 'The last try stopped before it finished.')}</p>` : ''}
        <div class="res-acts"><button class="btn primary">Get my look</button><button type="button" class="btn ghost" data-a="cancel">Cancel</button></div>
      </form>`);
      $('[data-a=cancel]', form).onclick = () => { researchOpen = false; paintLook(); };
      form.onsubmit = async (e) => {
        e.preventDefault();
        const b = $('button.primary', form);
        b.disabled = true;
        try {
          const { profileId } = await api('/api/simple-resources/profile', {});
          await startResearch(api, profileId, { url: form.elements.url.value, direction: 'For Simple mode’s Resources page: the colours, fonts and voice this creator’s videos should use.' });
          researchOpen = true;
          await load();
        } catch (err) { toast(err.message); b.disabled = false; await load().catch(() => {}); }
      };
      box.replaceChildren(form);
      form.elements.url.focus({ preventScroll: true });
      return;
    }
    if (running) {
      const panel = h(`<div class="res-panel res-research" aria-live="polite">
        <div class="res-run"><span class="spin" aria-hidden="true"></span><b>Claude is reading ${esc(hostOf(r.url))}…</b><span class="res-gap"></span><button type="button" class="btn small ghost" data-a="stop">Stop</button></div>
        <div class="res-chat"></div>
      </div>`);
      box.replaceChildren(panel);
      $('[data-a=stop]', panel).onclick = async () => { try { await api(`/api/profile-research/${encodeURIComponent(r.id)}/stop`, {}); } catch (e) { toast(e.message); } await load(); };
      openChat($('.res-chat', panel), r.id);
      return;
    }
    // The proposal: shown, not saved, until Use this look.
    closeChat();
    let proposal;
    try { proposal = await api(`/api/profile-research/${encodeURIComponent(r.id)}/proposal`); } catch (e) {
      box.replaceChildren(h(`<div class="res-panel res-research"><p class="res-err" role="alert">${esc(e.message)}</p><div class="res-acts"><button type="button" class="btn" data-a="again">Try again</button></div></div>`));
      $('[data-a=again]', box).onclick = () => { dismissed.add(r.id); researchOpen = true; paintLook(); };
      return;
    }
    if (!live) return;
    const b = proposal.brand;
    const card = h(`<div class="res-panel res-proposal">
      <b>Claude found this look on ${esc(hostOf(r.url))}</b>
      <div class="res-look-row">
        <span class="res-sw" role="img" aria-label="${esc(`Colours: ${b.colors.join(', ') || 'none found'}`)}">${b.colors.map((c) => `<i style="background:${esc(c)}" title="${esc(c)}"></i>`).join('') || '<span class="sub">No colours found</span>'}</span>
        <span class="res-font"><b>${esc(firstLine(b.fonts, 80) || 'No font found')}</b><span class="sub">${esc(firstLine(b.voice, 160) || 'No voice found')}</span></span>
      </div>
      <details class="res-src"><summary>Where it came from</summary>${b.sources.map((s) => `<p><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a><br><span class="sub">${esc(s.note)}</span></p>`).join('')}</details>
      <div class="res-acts"><button type="button" class="btn primary" data-a="use">Use this look</button><button type="button" class="btn ghost" data-a="later">Not now</button></div>
    </div>`);
    // Not now: the proposal is put aside for good (its session marked cancelled; nothing was saved).
    $('[data-a=later]', card).onclick = async () => {
      dismissed.add(r.id);
      researchOpen = false;
      await api(`/api/profile-research/${encodeURIComponent(r.id)}/stop`, {}).catch(() => {});
      await load().catch(() => paintLook());
    };
    $('[data-a=use]', card).onclick = async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api(`/api/simple-resources/research/${encodeURIComponent(r.id)}/approve`, { revision: proposal.revision, token: proposal.token });
        researchOpen = false;
        toast('Your look is saved. Claude uses it in your videos.');
        await load();
      } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
    };
    box.replaceChildren(card);
  }

  // The research session's messages and permission requests (Claude asks before it opens a page), as in a kit's Brand tab.
  function openChat(host, id) {
    if (events && chat?.researchId === id && host.firstChild) return;
    closeChat();
    const el = h(`<section class="col chat learn-chat res-chat-box"><span id="sessionInfo" hidden></span><div class="msgs" id="msgs"><div class="empty-chat" id="emptyChat">Claude’s steps show here. Allow a page when it asks.</div></div><div class="working" id="working" hidden><span class="spin"></span><span id="workText">Working…</span></div><div class="composer"><textarea id="input" rows="1" aria-label="Message Claude about your look"></textarea><button class="send" id="sendBtn" aria-label="Send"><span class="l-send">↑</span><i class="stop-sq l-stop"></i></button></div></section>`);
    host.replaceChildren(el);
    chat = ctx.makeChat?.(el, `_brand_${id}`, {}, { base: `/api/profile-research/${encodeURIComponent(id)}` }) || null;
    if (chat) chat.researchId = id;
    events = new EventSource(`/api/profile-research/${encodeURIComponent(id)}/events`);
    events.onmessage = async (e) => {
      const ev = JSON.parse(e.data);
      chat?.handle?.(ev);
      if (ev.t === 'busy' && !ev.busy && !ev.replay) {
        const now = await api(`/api/profile-research/${encodeURIComponent(id)}`).catch(() => null);
        if (!live || !now || now.status === 'running') return;
        researchOpen = researchActions(now.status).resume && now.status !== 'cancelled';
        await load();
      }
    };
  }

  // ---- Files ----
  function paintFiles() {
    const box = $('#resFiles', root);
    closeMenu();
    if (!data.files.length) {
      box.replaceChildren(h(`<div class="res-empty"><b>Nothing here yet</b><span class="sub">Upload your logo, a font, photos of you, product shots or clips. Claude uses them in every video.</span>
        <label class="btn small">${icon('upload', 14)}Upload<input type="file" multiple accept="${ACCEPT}" hidden data-up></label></div>`));
      $('[data-up]', box).onchange = (e) => upload([...e.target.files]);
      return;
    }
    const grid = h('<ul class="res-grid" aria-label="Your files"></ul>');
    for (const f of data.files) {
      const label = f.kind ? SIMPLE_KINDS[f.kind].label : 'File';
      grid.append(h(`<li class="res-tile" data-id="${esc(f.id)}">
        <span class="res-pv${f.kind === 'clip' ? ' clip' : ''}">${preview(f)}</span>
        <span class="res-t"><b class="res-name" title="${esc(f.name)}">${esc(f.name)}</b><span class="sub">${esc(f.line)}</span></span>
        <button type="button" class="btn ghost small res-more" aria-haspopup="menu" aria-label="${esc(`${label}: ${f.name}. More`)}">${icon('more', 16)}</button>
      </li>`));
    }
    box.replaceChildren(grid);
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('.res-more');
      if (b) openMenu(b, data.files.find((x) => x.id === b.closest('.res-tile').dataset.id));
    });
  }

  function openMenu(btn, f) {
    const again = menu && menu.dataset.id === f.id;
    closeMenu();
    if (again) return;
    const picture = IMAGE_FILE.test(f.name);
    menu = h(`<div class="res-menu" role="menu" data-id="${esc(f.id)}" aria-label="${esc(f.name)}">
      <button type="button" role="menuitem" data-m="rename">Rename</button>
      ${picture ? `<span class="res-menu-h" aria-hidden="true">Use as</span>${PICTURE_KINDS.map((k) => `<button type="button" role="menuitemradio" aria-checked="${f.kind === k}" data-m="kind" data-k="${k}">${esc(SIMPLE_KINDS[k].label)}${f.kind === k ? icon('check', 14) : ''}</button>`).join('')}` : ''}
      <button type="button" role="menuitem" data-m="remove" class="res-menu-del">Remove</button>
    </div>`);
    btn.closest('.res-tile').append(menu);
    document.addEventListener('pointerdown', outside, true);
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('button')], i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); btn.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
    });
    menu.addEventListener('click', async (e) => {
      const m = e.target.closest('[data-m]');
      if (!m) return;
      closeMenu();
      if (m.dataset.m === 'rename') rename(f);
      if (m.dataset.m === 'kind' && m.dataset.k !== f.kind) change(f, { kind: m.dataset.k }, `${f.name} is now ${SIMPLE_KINDS[m.dataset.k].label.toLowerCase()}.`);
      if (m.dataset.m === 'remove') remove(f);
    });
    menu.querySelector('button').focus();
  }

  async function change(f, patch, said) {
    try { await api(`/api/simple-resources/${encodeURIComponent(f.id)}`, { ...patch, expected: f.revision }); if (said) toast(said); await load(); } catch (e) { toast(e.message); await load().catch(() => {}); }
  }

  // Rename in place: Enter saves, Escape puts the name back. The file keeps its extension.
  function rename(f) {
    const tile = root.querySelector(`.res-tile[data-id="${CSS.escape(f.id)}"]`);
    const name = $('.res-name', tile);
    if (!name) return;
    const stem = f.ext && f.name.toLowerCase().endsWith(f.ext) ? f.name.slice(0, -f.ext.length) : f.name;
    const input = h(`<input class="res-rename" maxlength="170" aria-label="${esc(`New name for ${f.name}`)}">`);
    input.value = stem;
    name.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v && v !== stem) change(f, { name: v });
      else input.replaceWith(name);
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
    input.onblur = () => finish(true);
  }

  async function remove(f) {
    try {
      const r = await api(`/api/simple-resources/${encodeURIComponent(f.id)}/remove`, { expected: f.revision });
      await load();
      actionToast(`${f.name} removed. It’s in the studio’s trash.`, [['Undo', () => undo(r.trash, f.name)]]);
    } catch (e) { toast(e.message); }
  }
  async function undo(trash, name) {
    try { await api('/api/simple-resources/restore', { trash }); toast(`${name} is back.`); await load(); } catch (e) { toast(e.message); }
  }

  // Upload: fonts, clips and logos are known by their name; any other picture asks one question.
  let uploading = false;
  async function upload(files) {
    if (uploading || !files.length) return;
    uploading = true;
    let added = 0;
    try {
      for (const file of files) {
        let kind = guessKind(file.name);
        if (kind === 'unsupported') { toast(`${file.name}: Resources take pictures, fonts and video clips.`); continue; }
        if (!kind) kind = await askKind($('#resAsk', root), file);
        if (!live) return;
        if (!kind) continue;
        const grid = $('.res-grid', root);
        const ph = h(`<li class="res-tile res-busy" aria-busy="true"><span class="res-pv"><span class="spin" aria-hidden="true"></span></span><span class="res-t"><b class="res-name">${esc(file.name)}</b><span class="sub">Uploading…</span></span></li>`);
        grid?.prepend(ph);
        try {
          const r = await fetch(`/api/simple-resources/upload?${new URLSearchParams({ name: file.name, kind })}`, { method: 'POST', headers: { 'X-Studio': '1' }, body: file });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `Could not add ${file.name}.`);
          added++;
          ph.remove();
          if (live) await load(); // each file shows as soon as it is in
        } catch (e) { toast(e.message); } finally { ph.remove(); }
      }
      if (added) toast(added === 1 ? 'Added. Claude can use it in your videos.' : `${added} files added. Claude can use them in your videos.`);
    } finally {
      uploading = false;
      $('#resAsk', root)?.replaceChildren();
      if (live) await load().catch((e) => toast(e.message));
    }
  }
  $('#resFile', root).onchange = (e) => { upload([...e.target.files]); e.target.value = ''; };
  // Files dropped anywhere on the page go up the same way.
  const over = (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); root.classList.add('res-drop'); } };
  const leave = (e) => { if (!root.contains(e.relatedTarget)) root.classList.remove('res-drop'); };
  const drop = (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); root.classList.remove('res-drop'); upload([...e.dataTransfer.files]); };
  root.addEventListener('dragover', over);
  root.addEventListener('dragleave', leave);
  root.addEventListener('drop', drop);

  load().catch((e) => { if (live) $('#resLook', root).replaceChildren(h(`<p class="res-err" role="alert">${esc(e.message)}</p>`)); });
  return { teardown() { live = false; closeChat(); closeMenu(); } };
}

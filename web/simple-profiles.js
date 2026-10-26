// Simple mode's profiles on the page (server/simple-profiles.mjs, web/profile-kinds.js):
// - profileCards(): the row on Projects, one card per profile with its own way in: a topic box and Start (Topic →
//   video), or a drop area for reference videos and Start batch (Batch of shorts), plus + New profile.
// - newProfile(): the small New profile dialog, a name and one of four kinds (PRESETS).
// - renderProfilesPage(): Resources, #/resources and #/profile/<slug>. One tab per profile; the open one shows its
//   look, its files, how Claude makes its videos and what Claude learned. The beta.24 shared Resources (the built-in
//   brand) shows as a Shared tab only while it holds something (web/resources-page.js, #/resources?shared).
import { $, esc, h, api, toast, confirmBox } from './ui.js';
import { icon } from './icons.js';
import { SHAPES, SHAPE_KEYS } from './simple.js';
import { WORKFLOWS, WORKFLOW_KEYS, SCRIPTS, SCRIPT_KEYS, PRESETS, PRESET_KEYS, profileLine } from './profile-kinds.js';

const base = (slug) => `/api/simple-profiles/${encodeURIComponent(slug)}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i;
const IMAGE = /\.(png|jpe?g|webp|gif|svg)$/i;
const FONT = /\.(ttf|otf|woff2?)$/i;
const AUDIO = /\.(mp3|wav|m4a|aac|aiff?|flac|ogg)$/i;
const agent = () => window.STUDIO_AGENT || 'Claude';

async function upload(url, file) {
  const r = await fetch(url, { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/octet-stream' }, body: file });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Upload failed (${r.status})`);
  return j;
}

// ---------- New profile: a name and what kind of videos ----------
// Resolves the new profile, or null when cancelled.
export async function newProfile() {
  let made = null;
  const body = h(`<div class="npf">
    <label class="npf-name"><span>Name</span><input class="field" maxlength="60" placeholder="Main channel, Instagram, Podcast…" aria-label="Profile name"></label>
    <div class="npf-kinds" role="radiogroup" aria-label="What kind of videos">
      ${PRESET_KEYS.map((k, i) => `<button type="button" role="radio" class="npf-kind" data-k="${k}" aria-checked="${i === 0}">
        <span class="npf-pic ${PRESETS[k].shape}" aria-hidden="true"></span><b>${esc(PRESETS[k].name)}</b><span class="sub">${esc(PRESETS[k].sub)}</span></button>`).join('')}
    </div>
  </div>`);
  let pick = PRESET_KEYS[0];
  body.addEventListener('click', (e) => {
    const b = e.target.closest('.npf-kind');
    if (!b) return;
    pick = b.dataset.k;
    for (const x of body.querySelectorAll('.npf-kind')) x.setAttribute('aria-checked', String(x === b));
  });
  setTimeout(() => $('input', body).focus(), 30);
  const ok = await confirmBox({
    title: 'New profile', text: 'One for each kind of video you make. It keeps its own look, files and what Claude learns.', ok: 'Make it', body,
    onOk: async () => {
      const name = $('input', body).value.trim();
      if (!name) { toast('Give it a name.'); $('input', body).focus(); return false; }
      try { made = await api('/api/simple-profiles', { name, preset: pick }); return true; } catch (e) { toast(e.message); return false; }
    },
  });
  return ok ? made : null;
}

// One profile's card on Projects. open(id): go to the new video.
function profileCard(p, open) {
  const batch = p.workflow === 'batch';
  const stats = [plural(p.videos, 'video'), plural(p.learnings, 'lesson'), plural(p.files, 'file')].join(' · ');
  const el = h(`<div class="pf-card" data-slug="${esc(p.slug)}">
    <span class="pf-top"><b class="pf-name">${esc(p.name)}</b><a class="pf-open" href="#/profile/${encodeURIComponent(p.slug)}">Look & files</a></span>
    <span class="sub pf-line">${esc(profileLine(p, SHAPES))}</span>
    ${batch ? `<label class="pf-drop" tabindex="0"><input type="file" multiple accept="video/*,image/*" hidden><span class="pf-drop-t">${icon('upload', 14)}Drop reference videos here</span><span class="pf-chips"></span></label>
      <input class="field pf-in" maxlength="300" placeholder="Notes for this batch (optional)" aria-label="Notes for this batch">`
    : `<input class="field pf-in" maxlength="300" placeholder="What’s the video about?" aria-label="Topic for ${esc(p.name)}">`}
    <span class="pf-act"><button type="button" class="btn primary small pf-go">${esc(WORKFLOWS[p.workflow].start)}</button><span class="sub pf-stats">${esc(stats)}</span></span>
  </div>`);
  const files = [];
  const chips = () => { const c = $('.pf-chips', el); if (c) c.textContent = files.map((f) => f.name).join(', '); };
  if (batch) {
    const drop = $('.pf-drop', el), input = $('input[type=file]', drop);
    const add = (list) => { for (const f of list) if (VIDEO.test(f.name) || IMAGE.test(f.name)) files.push(f); chips(); };
    input.onchange = () => { add(input.files); input.value = ''; };
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('on'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('on'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('on'); add(e.dataTransfer.files); });
  }
  const go = $('.pf-go', el), text = $('.pf-in', el);
  let busy = false;
  const start = async () => {
    if (busy) return;
    if (batch && !files.length && !text.value.trim()) { toast('Drop a few reference videos first, or write what the batch is about.'); return; }
    busy = true; go.disabled = true; go.textContent = 'Starting…';
    try {
      const r = await api(`${base(p.slug)}/start`, { topic: text.value });
      let warning = r.warning;
      if (batch) {
        for (const [i, f] of files.entries()) { go.textContent = `Copying ${i + 1} of ${files.length}…`; await upload(`/api/simple-profiles/ref?project=${encodeURIComponent(r.id)}&name=${encodeURIComponent(f.name)}`, f); }
        warning = (await api(`/api/simple-profiles/kickoff/${encodeURIComponent(r.id)}`, {})).warning;
      }
      files.length = 0; text.value = ''; chips();
      open(r.id);
      if (warning) toast(warning);
    } catch (err) { toast(err.message); }
    finally { busy = false; go.disabled = false; go.textContent = WORKFLOWS[p.workflow].start; }
  };
  go.onclick = start;
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); start(); } });
  return el;
}

// The profiles row on Projects. host: an element; ctx: { profiles, open(id), changed() }.
export function profileCards(host, { profiles, open, changed }) {
  const row = h('<div class="pf-row"></div>');
  const add = h(`<button type="button" class="pf-card pf-add">${icon('plus', 16)}<b>New profile</b><span class="sub">One for each kind of video you make: its own look, files and lessons.</span></button>`);
  add.onclick = async () => { const p = await newProfile(); if (p) { toast(`${p.name} is ready.`); changed(); } };
  row.append(...profiles.map((p) => profileCard(p, open)), add);
  host.replaceChildren(row);
}

// ---------- Resources: one tab per profile ----------
// ctx: { slug (the open profile, or null: the first), projects }.
export function renderProfilesPage(main, { slug = null, projects = [] } = {}) {
  let live = true, profiles = [], data = null, shared = false, lastRemoved = null, editingLook = false;
  main.replaceChildren(h(`<div class="pv pv-simple rp">
    <header class="pv-head res-head"><span class="res-title"><h1>Resources</h1><span class="sub">Each profile keeps its own look, files and what ${esc(agent())} learned.</span></span>
      <label class="btn primary res-up" hidden>${icon('upload', 14)}Upload<input type="file" id="rpFile" multiple hidden></label></header>
    <nav class="rp-tabs" aria-label="Profiles"></nav>
    <div class="rp-main"><p class="sub">Loading…</p></div>
  </div>`));
  const root = $('.rp', main), tabs = $('.rp-tabs', root), body = $('.rp-main', root), up = $('.res-up', root);

  const fileUrl = (name) => `${base(data.slug)}/file/${encodeURIComponent(name)}`;
  const preview = (f) => {
    if (IMAGE.test(f.name)) return `<img class="fit" src="${fileUrl(f.name)}" alt="" loading="lazy" decoding="async">`;
    if (VIDEO.test(f.name)) return `<video src="${fileUrl(f.name)}#t=0.1" muted playsinline preload="metadata" aria-hidden="true"></video><span class="res-play" aria-hidden="true"></span>`;
    if (FONT.test(f.name)) {
      const fam = `vo-pf-${(data.slug + f.name).replace(/[^a-z0-9]/gi, '').slice(0, 40)}`;
      try { new FontFace(fam, `url(${fileUrl(f.name)})`).load().then((x) => document.fonts.add(x)).catch(() => {}); } catch {}
      return `<span class="res-aa" style="font-family:'${fam}', var(--font)">Aa</span>`;
    }
    return `<span class="rp-ext">${esc((f.name.split('.').pop() || 'file').toUpperCase().slice(0, 5))}</span>`;
  };
  const kindOf = (f) => (IMAGE.test(f.name) ? 'Picture' : VIDEO.test(f.name) ? 'Video' : FONT.test(f.name) ? 'Font' : AUDIO.test(f.name) ? 'Sound' : 'File');
  const size = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

  function paintTabs() {
    const cur = data?.slug;
    tabs.innerHTML = `${profiles.map((p) => `<a class="rp-tab" href="#/profile/${encodeURIComponent(p.slug)}"${p.slug === cur ? ' aria-current="page"' : ''}>${esc(p.name)}</a>`).join('')}
      ${shared ? '<a class="rp-tab" href="#/resources?shared">Shared</a>' : ''}
      <button type="button" class="rp-tab rp-new">${icon('plus', 14)}New profile</button>`;
    $('.rp-new', tabs).onclick = async () => { const p = await newProfile(); if (p) location.hash = `#/profile/${encodeURIComponent(p.slug)}`; };
  }

  function paintEmpty() {
    up.hidden = true;
    body.replaceChildren(h(`<div class="res-empty rp-first"><b>Make your first profile</b>
      <span class="sub">A profile is one kind of video you make: your main channel, your shorts, a podcast. It keeps its own look and files, and ${esc(agent())} learns how you like it.</span>
      <button type="button" class="btn primary">${icon('plus', 14)}New profile</button></div>`));
    $('button', body).onclick = async () => { const p = await newProfile(); if (p) location.hash = `#/profile/${encodeURIComponent(p.slug)}`; };
  }

  function paint() {
    const p = data;
    up.hidden = false;
    const vids = projects.filter((v) => v.profile === p.slug);
    const sw = p.look.colors.map((c) => `<i style="background:${esc(c)}" title="${esc(c)}"></i>`).join('');
    body.replaceChildren(h(`<div class="rp-panel">
      <div class="rp-meta">
        <span class="sub">${esc(profileLine(p, SHAPES))} · ${esc(plural(vids.length, 'video'))}</span>
        <span class="res-gap"></span>
        <button type="button" class="btn ghost small" data-a="settings" aria-expanded="false">Settings</button>
      </div>
      <div class="rp-settings" hidden>
        <label class="pf-f"><span>Name</span><input class="field" data-set="name" maxlength="60" value="${esc(p.name)}"></label>
        <label class="pf-f"><span>Starts with</span><select class="field" data-set="workflow">${WORKFLOW_KEYS.map((k) => `<option value="${k}"${k === p.workflow ? ' selected' : ''}>${esc(WORKFLOWS[k].name)}</option>`).join('')}</select></label>
        <label class="pf-f"><span>Shape</span><select class="field" data-set="shape">${SHAPE_KEYS.map((k) => `<option value="${k}"${k === p.shape ? ' selected' : ''}>${esc(SHAPES[k].name)}</option>`).join('')}</select></label>
        ${p.workflow === 'batch' ? '' : `<label class="pf-f"><span>Script</span><select class="field" data-set="script">${SCRIPT_KEYS.map((k) => `<option value="${k}"${k === p.script ? ' selected' : ''}>${esc(SCRIPTS[k].name)}</option>`).join('')}</select></label>`}
        <button type="button" class="btn ghost small rp-del" data-a="delete">Remove profile</button>
      </div>

      <section class="res-sec" aria-labelledby="rpLookH"><h2 class="res-h" id="rpLookH">Look</h2>
        <div class="res-look-row">
          <span class="res-sw" role="img" aria-label="${esc(`Colours: ${p.look.colors.join(', ') || 'none yet'}`)}">${sw || '<span class="res-sw-none sub">No colours yet</span>'}</span>
          <span class="res-font"><b>${esc(p.look.font || 'No font yet')}</b><span class="sub">${esc(p.look.voice || 'Voice not set yet')}</span></span>
          <span class="res-gap"></span>
          <button type="button" class="btn ghost" data-a="look">${editingLook ? 'Close' : 'Edit'}</button>
        </div>
        <div class="rp-look-edit"></div>
      </section>

      <section class="res-sec" aria-labelledby="rpFilesH"><h2 class="res-h" id="rpFilesH">Files</h2>
        <div id="rpUndo"></div>
        ${p.fileList.length ? `<ul class="res-grid">${p.fileList.map((f) => `<li class="res-tile">
          <a class="res-pv${VIDEO.test(f.name) ? ' clip' : ''}" href="${fileUrl(f.name)}" target="_blank" rel="noopener">${preview(f)}</a>
          <span class="res-t"><b class="res-name" title="${esc(f.name)}">${esc(f.name)}</b><span class="sub">${esc(kindOf(f))} · ${esc(size(f.size))}</span></span>
          <button type="button" class="btn ghost small res-more" data-rm="${esc(f.name)}" aria-label="${esc(`Remove ${f.name}`)}" title="Remove">${icon('trash', 15)}</button>
        </li>`).join('')}</ul>`
        : `<label class="res-empty rp-drop" tabindex="0"><b>Drop files here</b><span class="sub">Logo, photos of you, fonts, music, example videos: anything ${esc(agent())} should use for ${esc(p.name)}.</span><input type="file" multiple hidden data-up></label>`}
      </section>

      <section class="res-sec rp-narrow" aria-labelledby="rpInsH"><h2 class="res-h" id="rpInsH">How ${esc(agent())} makes these videos</h2>
        <textarea class="field rp-ins" rows="5" placeholder="Who they’re for, the tone, how long, what a good one looks like, what to avoid. A few lines is plenty.">${esc(p.instructions)}</textarea>
        <span class="sub rp-saved" aria-live="polite"></span>
      </section>

      <section class="res-sec rp-narrow" aria-labelledby="rpLearnH"><h2 class="res-h" id="rpLearnH">What ${esc(agent())} learned <span class="sub">${esc(plural(p.lessons.length, 'lesson'))}</span></h2>
        ${p.lessons.length ? `<ul class="rp-lessons">${p.lessons.map((l) => `<li><span>${esc(l.text)}${l.from || l.stage ? `<span class="sub">${esc([l.stage, l.from].filter(Boolean).join(' · '))}</span>` : ''}</span>
          <button type="button" class="btn ghost small" data-lesson="${esc(l.text)}" aria-label="${esc(`Forget: ${l.text}`)}" title="Forget">${icon('close', 14)}</button></li>`).join('')}</ul>`
        : `<p class="sub">Nothing yet. When you correct ${esc(agent())} in a video, it saves the lesson here and uses it next time.</p>`}
        <form class="rp-add"><input class="field" maxlength="400" placeholder="Add a lesson yourself, e.g. “Hook in the first 3 seconds”" aria-label="Add a lesson"><button class="btn small">Add</button></form>
      </section>
    </div>`));

    const patch = async (b) => { try { data = await api(base(p.slug), b); return true; } catch (e) { toast(e.message); return false; } };
    const settingsBtn = $('[data-a=settings]', body), settings = $('.rp-settings', body);
    settingsBtn.onclick = () => { settings.hidden = !settings.hidden; settingsBtn.setAttribute('aria-expanded', String(!settings.hidden)); };
    for (const el of body.querySelectorAll('[data-set]')) el.onchange = async () => { if (await patch({ [el.dataset.set]: el.value })) { await loadList(); paintTabs(); paint(); $('.rp-settings', body).hidden = false; } };
    $('[data-a=delete]', body).onclick = async () => {
      if (!(await confirmBox({ title: `Remove ${p.name}?`, text: 'Its folder moves to profiles/.removed in your studio, nothing is deleted. Its videos stay in Projects.', ok: 'Remove' }))) return;
      try { await api(`${base(p.slug)}/delete`, {}); location.hash = '#/resources'; } catch (e) { toast(e.message); }
    };
    $('[data-a=look]', body).onclick = () => { editingLook = !editingLook; paint(); };
    if (editingLook) paintLookEdit($('.rp-look-edit', body));
    // Instructions save on their own, a moment after typing stops.
    const ins = $('.rp-ins', body), saved = $('.rp-saved', body);
    let t = null;
    ins.oninput = () => { saved.textContent = ''; clearTimeout(t); t = setTimeout(async () => { if (await api(base(p.slug), { instructions: ins.value }).catch((e) => toast(e.message))) saved.textContent = 'Saved'; }, 700); };
    const add = $('.rp-add', body);
    add.onsubmit = async (e) => {
      e.preventDefault();
      const v = $('input', add).value.trim();
      if (!v) return;
      try { data = await api(`${base(p.slug)}/lessons`, { add: v }); paint(); } catch (err) { toast(err.message); }
    };
    body.onclick = async (e) => {
      const forget = e.target.closest('[data-lesson]');
      if (forget) { try { data = await api(`${base(p.slug)}/lessons`, { remove: forget.dataset.lesson }); paint(); } catch (err) { toast(err.message); } }
      const rm = e.target.closest('[data-rm]');
      if (rm) { try { lastRemoved = (await api(`${base(p.slug)}/remove`, { name: rm.dataset.rm })).removed; await reload(); } catch (err) { toast(err.message); } }
      if (e.target.closest('[data-undo]') && lastRemoved) { try { await api(`${base(p.slug)}/restore`, { removed: lastRemoved }); lastRemoved = null; await reload(); } catch (err) { toast(err.message); } }
    };
    const pick = $('[data-up]', body);
    if (pick) pick.onchange = () => send([...pick.files]);
    if (lastRemoved) $('#rpUndo', body).replaceChildren(h(`<p class="sx-undo">${esc(lastRemoved.replace(/^\d+-/, ''))} removed · <button type="button" class="linkish" data-undo>Undo</button></p>`));
  }

  function paintLookEdit(box) {
    const look = { ...data.look, colors: [...data.look.colors] };
    const form = h(`<form class="res-panel rp-look-form" aria-label="Edit the look">
      <fieldset class="res-f"><legend>Colours <span class="sub">the first one leads: titles, cards, thumbnails</span></legend><span class="res-more-c rp-cols"></span></fieldset>
      <label class="res-f">Font<input name="font" maxlength="120" value="${esc(look.font)}" placeholder="Inter, or the name of a font file in Files"></label>
      <label class="res-f">Voice<input name="voice" maxlength="300" value="${esc(look.voice)}" placeholder="Friendly and plain, a bit dry"></label>
      <div class="res-acts"><button class="btn primary">Save look</button><button type="button" class="btn ghost" data-a="cancel">Cancel</button></div>
    </form>`);
    const cols = () => {
      $('.rp-cols', form).innerHTML = `${look.colors.map((c, i) => `<label class="rp-col" title="${esc(c)}"><input type="color" value="${esc(c)}" data-i="${i}" aria-label="${esc(`Colour ${i + 1}`)}"><button type="button" data-drop="${i}" aria-label="${esc(`Remove ${c}`)}">${icon('close', 12)}</button></label>`).join('')}
        ${look.colors.length < 6 ? `<label class="btn small res-add-c">${icon('plus', 12)}Add colour<input type="color" data-add value="#ea580c" aria-label="Add a colour"></label>` : ''}`;
    };
    cols();
    form.addEventListener('change', (e) => {
      if (e.target.dataset.add !== undefined) { look.colors.push(e.target.value); cols(); }
      else if (e.target.dataset.i !== undefined) look.colors[Number(e.target.dataset.i)] = e.target.value;
    });
    form.addEventListener('click', (e) => { const d = e.target.closest('[data-drop]'); if (d) { e.preventDefault(); e.stopPropagation(); look.colors.splice(Number(d.dataset.drop), 1); cols(); } });
    $('[data-a=cancel]', form).onclick = () => { editingLook = false; paint(); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      try { data = await api(base(data.slug), { look: { colors: look.colors, font: form.font.value, voice: form.voice.value } }); editingLook = false; toast('Look saved.'); paint(); }
      catch (err) { toast(err.message); }
    };
    box.replaceChildren(form);
  }

  async function send(list) {
    if (!data || !list.length) return;
    for (const f of list) { try { toast(`Adding ${f.name}…`); await upload(`${base(data.slug)}/upload?name=${encodeURIComponent(f.name)}`, f); } catch (e) { toast(e.message); } }
    await reload();
  }
  $('#rpFile', root).onchange = (e) => { send([...e.target.files]); e.target.value = ''; };
  // Drop anywhere on the page: into the open profile's files.
  root.addEventListener('dragover', (e) => { if (data) { e.preventDefault(); root.classList.add('res-drop'); } });
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) root.classList.remove('res-drop'); });
  root.addEventListener('drop', (e) => { e.preventDefault(); root.classList.remove('res-drop'); send([...e.dataTransfer.files]); });

  const loadList = async () => { profiles = (await api('/api/simple-profiles')).profiles || []; };
  async function reload() { data = await api(base(data.slug)); await loadList(); if (live) { paintTabs(); paint(); } }
  (async () => {
    try {
      await loadList();
      // The beta.24 shared Resources: a tab only while it holds a look or files.
      api('/api/simple-resources').then((r) => { shared = Boolean(r.files?.length || r.look?.colors?.length || r.look?.fonts); if (live) paintTabs(); }).catch(() => {});
      const want = slug || profiles[0]?.slug;
      if (!want) { paintTabs(); paintEmpty(); return; }
      data = await api(base(want));
      if (live) { paintTabs(); paint(); }
    } catch (e) { if (live) body.replaceChildren(h(`<div class="notice">${esc(e.message)}</div>`)); }
  })();
  return { teardown: () => { live = false; } };
}

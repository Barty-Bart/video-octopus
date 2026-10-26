// Simple mode's profiles on the page (server/simple-profiles.mjs, web/profile-kinds.js):
// - profileCards(): the row on Projects, one card per profile with its own way in: a topic box and Start (Topic →
//   video), or a drop area for reference videos and Start batch (Batch of shorts), plus + New profile.
// - renderProfilePage(): #/profile/<slug>, the profile's folder: its settings, Instructions, Learnings, Files and Skills.
import { $, esc, h, api, toast } from './ui.js';
import { icon } from './icons.js';
import { SHAPES, SHAPE_KEYS } from './simple.js';
import { WORKFLOWS, WORKFLOW_KEYS, SCRIPTS, SCRIPT_KEYS, profileLine } from './profile-kinds.js';

const base = (slug) => `/api/simple-profiles/${encodeURIComponent(slug)}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i;
const IMAGE = /\.(png|jpe?g|webp|gif|svg)$/i;

async function upload(url, file) {
  const r = await fetch(url, { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/octet-stream' }, body: file });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Upload failed (${r.status})`);
  return j;
}

// The New profile form: name, what it makes, the shape and (for topics) how much script. onMade(profile).
function newProfileForm(onMade, onCancel) {
  const el = h(`<form class="pf-card pf-new-form" aria-label="New profile">
    <b class="pf-name">New profile</b>
    <label class="pf-f"><span>Name</span><input class="field" name="name" maxlength="60" placeholder="Main channel, Instagram, Podcast…" required></label>
    <fieldset class="pf-f"><legend>How it starts</legend>${WORKFLOW_KEYS.map((k, i) => `<label class="pf-radio"><input type="radio" name="workflow" value="${k}"${i ? '' : ' checked'}><span><b>${esc(WORKFLOWS[k].name)}</b><span class="sub">${esc(WORKFLOWS[k].sub)}</span></span></label>`).join('')}</fieldset>
    <label class="pf-f"><span>Shape</span><select class="field" name="shape">${SHAPE_KEYS.map((k) => `<option value="${k}">${esc(SHAPES[k].name)}</option>`).join('')}</select></label>
    <label class="pf-f pf-script"><span>Script</span><select class="field" name="script">${SCRIPT_KEYS.map((k) => `<option value="${k}"${k === 'points' ? ' selected' : ''}>${esc(SCRIPTS[k].name)}: ${esc(SCRIPTS[k].sub)}</option>`).join('')}</select></label>
    <div class="sx-btns"><button type="submit" class="btn primary">Make it</button><button type="button" class="btn ghost" data-a="cancel">Cancel</button></div>
  </form>`);
  const sync = () => {
    const batch = el.workflow.value === 'batch';
    $('.pf-script', el).hidden = batch;
    if (batch && el.shape.value === 'youtube') el.shape.value = 'reel';
    if (!batch && el.shape.value === 'reel' && !el.dataset.touched) el.shape.value = 'youtube';
  };
  el.addEventListener('change', (e) => { if (e.target.name === 'shape') el.dataset.touched = '1'; sync(); });
  $('[data-a=cancel]', el).onclick = onCancel;
  el.onsubmit = async (e) => {
    e.preventDefault();
    try { onMade(await api('/api/simple-profiles', { name: el.name.value, workflow: el.workflow.value, shape: el.shape.value, script: el.script.value })); }
    catch (err) { toast(err.message); }
  };
  setTimeout(() => el.name.focus(), 0);
  return el;
}

// One profile's card. open(id): go to the new video.
function profileCard(p, open) {
  const batch = p.workflow === 'batch';
  const stats = [plural(p.videos, 'video'), plural(p.learnings, 'learning'), plural(p.files, 'file')].join(' · ');
  const el = h(`<div class="pf-card" data-slug="${esc(p.slug)}">
    <span class="pf-top"><b class="pf-name">${esc(p.name)}</b><a class="pf-open" href="#/profile/${encodeURIComponent(p.slug)}">Open</a></span>
    <span class="sub pf-line">${esc(profileLine(p, SHAPES))}</span>
    ${batch ? `<label class="pf-drop" tabindex="0"><input type="file" multiple accept="video/*,image/*" hidden><span class="pf-drop-t">${icon('upload', 14)}Drop reference videos here</span><span class="pf-chips"></span></label>
      <input class="field pf-in" maxlength="300" placeholder="Notes for this batch (optional)" aria-label="Notes for this batch">`
    : `<input class="field pf-in" maxlength="300" placeholder="What’s the video about?" aria-label="Topic for ${esc(p.name)}">`}
    <span class="pf-act"><button type="button" class="btn primary small pf-go">${esc(WORKFLOWS[p.workflow].start)}</button><span class="sub pf-stats">${esc(stats)}</span></span>
  </div>`);
  const files = [];
  const chips = () => { const c = $('.pf-chips', el); if (c) c.textContent = files.length ? files.map((f) => f.name).join(', ') : ''; };
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
  const add = h(`<button type="button" class="pf-card pf-add">${icon('plus', 16)}<b>New profile</b><span class="sub">One for each kind of video you make: its own files, script style and learnings.</span></button>`);
  add.onclick = () => add.replaceWith(newProfileForm((p) => { toast(`${p.name} is ready. Add its files and instructions any time.`); changed(); }, () => changed()));
  row.append(...profiles.map((p) => profileCard(p, open)), add);
  host.replaceChildren(row);
}

// ---------- the profile's page ----------
export function renderProfilePage(main, { slug, projects = [] }) {
  let live = true, data = null, lastRemoved = null;
  main.replaceChildren(h(`<div class="pv pv-simple pf-page"><p class="sub">Loading…</p></div>`));
  const root = $('.pf-page', main);

  function paint() {
    const p = data;
    const vids = projects.filter((v) => v.profile === slug);
    root.replaceChildren(h(`<div>
      <header class="pv-head"><span class="res-title"><a class="sub" href="#/">‹ Projects</a><h1>${esc(p.name)}</h1><span class="sub">${esc(profileLine(p, SHAPES))} · its folder: <code>${esc(p.path)}</code></span></span></header>
      <section class="res-sec pf-set" aria-label="Settings">
        <label class="pf-f"><span>Name</span><input class="field" id="pfName" maxlength="60" value="${esc(p.name)}"></label>
        <label class="pf-f"><span>How it starts</span><select class="field" id="pfWorkflow">${WORKFLOW_KEYS.map((k) => `<option value="${k}"${k === p.workflow ? ' selected' : ''}>${esc(WORKFLOWS[k].name)}</option>`).join('')}</select></label>
        <label class="pf-f"><span>Shape</span><select class="field" id="pfShape">${SHAPE_KEYS.map((k) => `<option value="${k}"${k === p.shape ? ' selected' : ''}>${esc(SHAPES[k].name)}</option>`).join('')}</select></label>
        <label class="pf-f"${p.workflow === 'batch' ? ' hidden' : ''}><span>Script</span><select class="field" id="pfScript">${SCRIPT_KEYS.map((k) => `<option value="${k}"${k === p.script ? ' selected' : ''}>${esc(SCRIPTS[k].name)}</option>`).join('')}</select></label>
      </section>
      <section class="res-sec" aria-labelledby="pfInsH"><h2 class="res-h" id="pfInsH">Instructions</h2>
        <p class="sub">How this profile’s videos are made: who they’re for, the tone, the length, what a good one looks like. ${esc(window.STUDIO_AGENT || 'Claude')} reads this before every step.</p>
        <textarea class="field pf-text" id="pfIns" rows="10">${esc(p.instructions)}</textarea>
        <div class="sx-btns"><button type="button" class="btn" data-save="instructions">Save instructions</button></div></section>
      <section class="res-sec" aria-labelledby="pfLearnH"><h2 class="res-h" id="pfLearnH">Learnings <span class="sub">${esc(plural(p.learnings, 'lesson'))}</span></h2>
        <p class="sub">Saved by ${esc(window.STUDIO_AGENT || 'Claude')} each time you correct it, and read before every new video. Edit or delete any line.</p>
        <textarea class="field pf-text" id="pfLearn" rows="10">${esc(p.learningsText)}</textarea>
        <div class="sx-btns"><button type="button" class="btn" data-save="learnings">Save learnings</button></div></section>
      <section class="res-sec" aria-labelledby="pfFilesH"><h2 class="res-h" id="pfFilesH">Files <span class="sub">only for this profile; the Resources page holds the ones every profile shares</span></h2>
        <label class="pf-drop pf-drop-big" tabindex="0"><input type="file" id="pfFile" multiple hidden><span class="pf-drop-t">${icon('upload', 14)}Drop files here, or click to pick: logos, photos, fonts, music, example videos</span></label>
        <div id="pfUndo"></div>
        <ul class="pf-files">${p.fileList.map((f) => `<li><a href="${base(slug)}/file/${encodeURIComponent(f.name)}" target="_blank" rel="noopener">${esc(f.name)}</a><span class="sub">${esc(size(f.size))}</span><button type="button" class="btn small ghost" data-rm="${esc(f.name)}">Remove</button></li>`).join('') || '<li class="sub">No files yet.</li>'}</ul></section>
      <section class="res-sec" aria-labelledby="pfSkillsH"><h2 class="res-h" id="pfSkillsH">Skills</h2>
        <p class="sub">Skills of this profile’s own go in its <code>skills/</code> folder, one folder each with its SKILL.md. ${p.skillList.length ? `Here now: ${esc(p.skillList.join(', '))}.` : 'None yet: the app’s own skills do the work.'}</p></section>
      <section class="res-sec" aria-labelledby="pfVidsH"><h2 class="res-h" id="pfVidsH">Videos</h2>
        <ul class="pf-files">${vids.map((v) => `<li><a href="#/p/${encodeURIComponent(v.id)}">${esc(v.name)}</a></li>`).join('') || '<li class="sub">No videos from this profile yet: start one from Projects.</li>'}</ul></section>
    </div>`));
    const patch = async (b, msg) => { try { data = await api(base(slug), b); if (msg) toast(msg); paint(); } catch (e) { toast(e.message); } };
    $('#pfName', root).onchange = (e) => patch({ name: e.target.value });
    $('#pfWorkflow', root).onchange = (e) => patch({ workflow: e.target.value });
    $('#pfShape', root).onchange = (e) => patch({ shape: e.target.value });
    $('#pfScript', root).onchange = (e) => patch({ script: e.target.value });
    root.querySelector('[data-save=instructions]').onclick = () => patch({ instructions: $('#pfIns', root).value }, 'Instructions saved.');
    root.querySelector('[data-save=learnings]').onclick = () => patch({ learnings: $('#pfLearn', root).value }, 'Learnings saved.');
    const drop = $('.pf-drop-big', root), input = $('#pfFile', root);
    const send = async (list) => {
      for (const f of list) { try { toast(`Adding ${f.name}…`); await upload(`${base(slug)}/upload?name=${encodeURIComponent(f.name)}`, f); } catch (e) { toast(e.message); } }
      await load();
    };
    input.onchange = () => { send([...input.files]); input.value = ''; };
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('on'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('on'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('on'); send([...e.dataTransfer.files]); });
    root.addEventListener('click', async (e) => {
      const rm = e.target.closest('[data-rm]');
      if (rm) {
        try { lastRemoved = (await api(`${base(slug)}/remove`, { name: rm.dataset.rm })).removed; await load(); } catch (err) { toast(err.message); }
      }
      if (e.target.closest('[data-undo]') && lastRemoved) {
        try { await api(`${base(slug)}/restore`, { removed: lastRemoved }); lastRemoved = null; await load(); } catch (err) { toast(err.message); }
      }
    });
    if (lastRemoved) $('#pfUndo', root).replaceChildren(h(`<p class="sx-undo">${esc(lastRemoved.replace(/^\d+-/, ''))} removed · <button type="button" class="linkish" data-undo>Undo</button></p>`));
  }
  const size = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
  async function load() {
    try { data = await api(base(slug)); if (live) paint(); }
    catch (e) { if (live) root.replaceChildren(h(`<div class="notice">${esc(e.message)} <a href="#/">Back to Projects</a></div>`)); }
  }
  load();
  return { teardown: () => { live = false; } };
}

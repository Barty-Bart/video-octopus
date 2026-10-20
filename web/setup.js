// First-time Setup (#/setup): a checklist with live status, where each failing row's Fix asks the Video Octopus
// assistant (which asks you before each step), then three short steps, each one skippable: About you (the answers go
// to the app's local/profile.json), Your brand (uploads into the studio's library/brand, the logo's colours, fonts) and
// Motion skills (the recommended GitHub repo into the studio's .claude/skills). The answers, colours and files become
// the studio's BRAND.md, and "Write my style" asks the assistant for a fuller STYLE.md (web/brand.js).
import { $, esc, h, api, toast } from './ui.js';
import { support, browserName } from './recorder.js';
import { aboutForm, saveAnswers, brandKit, skillsPicker, FROM_STUDIO, WRITE_STYLE } from './brand.js';

const MARK = {
  ok: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8.5" class="m-ok"/><path d="M5.4 9.3l2.3 2.3 4.9-5" class="m-tick"/></svg>',
  warn: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8.5" class="m-warn"/><path d="M9 5v5M9 12.6v.1" class="m-tick"/></svg>',
  fail: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8.5" class="m-fail"/><path d="M6.2 6.2l5.6 5.6M11.8 6.2l-5.6 5.6" class="m-tick"/></svg>',
};
const STATE_LABEL = { ok: 'Ready', warn: 'Needs a look', fail: 'Missing', checking: 'Checking…', fixing: 'Assistant working' };

// "Create my studio": a folder field (the suggested ~/Video Octopus filled in), a live note on that folder (a cloud-synced
// place, a folder that's already there) and the button. Creating copies Video Octopus's starter in without overwriting
// anything and makes it the studio. Used by Setup and by Settings → Folders.
export function studioCreator({ suggest, onCreated, button = 'Create my studio' } = {}) {
  const el = h(`<form class="su-create">
    <div class="su-pick"><input class="field mono" name="path" value="${esc(suggest?.shown || '~/Video Octopus')}" spellcheck="false" autocomplete="off" aria-label="Where your studio goes"><button class="btn small primary">${esc(button)}</button></div>
    <p class="su-warn" role="status" hidden></p>
    <p class="sub su-note" aria-live="polite"></p>
    <p class="sub">A new folder with everything Claude needs to edit with you: its instructions (CLAUDE.md), your notes on preferences and style, the skills for Clean up, Plan the scenes, Add zooms and object separation, a library, and folders for projects and recordings. It's yours: app updates never change it.</p>
  </form>`);
  const input = el.elements.path, warn = $('.su-warn', el), note = $('.su-note', el);
  const show = (info) => {
    warn.hidden = !info?.warning; warn.textContent = info?.warning || '';
    note.textContent = !info ? '' : info.relative ? 'Give the full path of the folder, like ~/Video Octopus.' : info.inApp ? 'That\'s inside the app\'s own folder. Pick a place outside it.'
      : info.exists && !info.isDir ? 'There is a file with that name. Pick another folder.'
      : info.studio ? 'That folder is a studio already: Video Octopus adds only what\'s missing and keeps every file in it.'
      : info.exists && !info.empty ? 'That folder is there already: Video Octopus adds the starter files next to what\'s in it and never overwrites a file.'
      : `Video Octopus makes ${info.shown}.`;
  };
  let t = null, seq = 0;
  const look = () => { const n = ++seq; api(`/api/app/setup/studio-path?path=${encodeURIComponent(input.value.trim())}`).then((i) => { if (n === seq) show(i); }).catch(() => {}); };
  input.oninput = () => { clearTimeout(t); t = setTimeout(look, 250); };
  show(suggest); if (!suggest) look();
  el.onsubmit = async (e) => {
    e.preventDefault();
    const b = $('button', el);
    b.disabled = true;
    try {
      const r = await api('/api/app/setup/create-studio', { path: input.value.trim() });
      toast(`Your studio is ready at ${r.shown}${r.kept.length ? ` (${r.kept.length} file${r.kept.length > 1 ? 's' : ''} already there kept as they were)` : ''}.`);
      await onCreated?.(r);
    } catch (err) { toast(err.message); }
    b.disabled = false;
  };
  return { el };
}

export async function setupPage(ctx, { back = '#/', assistantPanel }) {
  document.body.classList.add('in-home', 'in-app-page');
  document.title = 'Setup · Video Octopus';
  const [st, prof] = await Promise.all([api('/api/app/setup'), api('/api/app/profile').catch(() => ({}))]);
  const el = h(`<div class="app-page setup-page">
    <div class="set-main"><div class="set-wrap su-wrap">
      <div class="su-top"><a class="brand" href="#/"><span class="logo" aria-hidden="true"><i></i></span>Video Octopus</a><span class="gap"></span>
        ${st.done ? `<a class="btn small ghost" href="${esc(back)}">Back</a>` : ''}<a class="btn small ghost" href="#/settings">Settings</a></div>
      <div class="set-head"><h1>Set up Video Octopus</h1><span class="su-count" id="count"></span></div>
      <p class="sub lead">Video Octopus checks what it needs on this computer. Anything missing, the Video Octopus assistant on the right can fix: it tells you its plan and asks before each step.</p>
      <ol class="su-list" id="list"></ol>
      <div class="su-row-actions"><button type="button" class="btn small" id="again">Check again</button></div>

      <section class="set-group su-q ob-steps">
        <div class="ob-tabs" role="tablist" aria-label="Make the studio yours">
          <button type="button" role="tab" class="ob-tab" data-step="about"><i>1</i>About you</button>
          <button type="button" role="tab" class="ob-tab" data-step="brand"><i>2</i>Your brand</button>
          <button type="button" role="tab" class="ob-tab" data-step="skills"><i>3</i>Motion skills</button></div>
        <p class="sub">Three short steps so Claude edits like you. Skip any of them: Settings → Brand has them all, later.</p>
        <div class="ob-pane" role="tabpanel" data-pane="about">
          <div id="aboutBox"></div>
          <div class="su-q-actions"><button type="button" class="btn small ghost" id="fromStudio" title="The assistant reads your studio's notes and fills in what it finds">Fill in from my studio</button><span class="gap"></span>
            <span class="set-saved" id="saved" aria-live="polite"></span><button type="button" class="btn small ghost" data-skip="brand">Skip</button><button type="button" class="btn small dark" id="saveQ">Save and next</button></div></div>
        <div class="ob-pane" role="tabpanel" data-pane="brand" hidden>
          <p class="sub">Your logo, photos of you, product images, fonts, and videos or thumbnails whose look you like. They go into your studio's library, and your logo gives your brand colours.</p>
          <div id="kitBox"></div>
          <div class="su-q-actions"><span class="gap"></span><button type="button" class="btn small ghost" data-skip="skills">Skip</button><button type="button" class="btn small dark" data-next="skills">Next</button></div></div>
        <div class="ob-pane" role="tabpanel" data-pane="skills" hidden>
          <p class="sub"><b>Which motion graphics skills do you want?</b> Claude uses them to build your graphics, B-roll and explainers. You can add more from any GitHub repo later (Home → Skills).</p>
          <div id="skBox"></div>
          <div class="su-q-actions"><span class="gap"></span><button type="button" class="btn small ghost" data-next="mine">Skip</button><button type="button" class="btn small dark" data-next="mine">Done</button></div></div>
        <div class="ob-mine" id="mine"></div>
      </section>

      <div class="su-foot"><button type="button" class="btn ghost" id="skip">Skip for now</button><span class="gap"></span><button type="button" class="btn primary" id="finish">Finish setup</button></div>
    </div></div>
    <aside class="as-col" aria-label="Video Octopus assistant" id="asCol"></aside>
  </div>`);
  ctx.app.replaceChildren(el);

  // ---- the checklist ----
  const rows = new Map(); // id -> { li, state, check }
  const fixing = new Set();
  const list = $('#list', el);
  for (const c of st.checks) {
    const li = h(`<li class="su-item" data-id="${esc(c.id)}"></li>`);
    list.append(li);
    rows.set(c.id, { li, state: 'checking', check: { title: c.title } });
  }
  const count = () => {
    const all = [...rows.values()];
    const ready = all.filter((r) => r.state === 'ok').length;
    $('#count', el).textContent = `${ready} of ${all.length} ready`;
  };
  const drawRow = (id) => {
    const r = rows.get(id), c = r.check;
    const s = fixing.has(id) ? 'fixing' : r.state;
    const icon = s === 'checking' || s === 'fixing' ? '<span class="spin big" aria-hidden="true"></span>' : MARK[s];
    r.li.className = `su-item ${s}`;
    r.li.replaceChildren(h(`<div class="su-i">${icon}</div>`), h(`<div class="su-b"><b>${esc(c.title)}</b><span class="sub">${esc(s === 'fixing' ? 'The Video Octopus assistant is on it. Answer its questions on the right.' : c.detail || '')}</span>
      ${c.how && s !== 'ok' ? `<span class="su-how">${esc(c.how)}</span>` : ''}</div>`), h(`<div class="su-a"><span class="su-s">${STATE_LABEL[s]}</span></div>`));
    const a = $('.su-a', r.li);
    // The built-in recorder runs in this page: say so when this browser can't do all of it.
    if (id === 'recorder' && s !== 'checking') {
      const sp = support();
      const note = !sp.ok ? `${browserName()} can't record everything with the built-in recorder (missing: ${sp.missing.join(', ') || 'a video format'}). Open Video Octopus in Chrome or Edge to record.`
        : !sp.chromium ? `The built-in recorder is made for Chrome and Edge; in ${browserName()} some of it may not work (the screen picker, the formats). Chrome or Edge is the safe choice.` : '';
      if (note) $('.su-b', r.li).append(h(`<span class="su-how">${esc(note)}</span>`));
    }
    if (c.pick && s === 'fail') {
      // No studio folder yet: create one from the starter (at ~/Video Octopus unless changed), or use a folder that exists.
      const make = studioCreator({ suggest: c.create, onCreated: () => checkAll() });
      const f = h(`<form class="su-pick" hidden><input class="field mono" name="studio" placeholder="~/My studio" spellcheck="false" autocomplete="off" aria-label="Your studio folder"><input class="field mono small" name="pdir" value="projects" aria-label="Projects folder inside it"><button class="btn small dark">Use this folder</button></form>`);
      const other = h(`<button type="button" class="su-link">Use an existing folder instead</button>`);
      other.onclick = () => { const show = f.hidden; f.hidden = !show; make.el.hidden = show; other.textContent = show ? 'Create a new studio instead' : 'Use an existing folder instead'; if (show) f.elements.studio.focus(); };
      f.onsubmit = async (e) => {
        e.preventDefault();
        try { await api('/api/app/setup/studio', { studio: f.elements.studio.value.trim(), projectsDir: f.elements.pdir.value.trim() || 'projects' }); toast('Saved your studio folder.'); await checkAll(); }
        catch (err) { toast(err.message); }
      };
      $('.su-b', r.li).append(make.el, f, other);
    } else if (c.fix && (s === 'fail' || s === 'warn')) {
      const b = h(`<button type="button" class="btn small accent">Fix</button>`);
      b.onclick = () => fix(id);
      a.append(b);
    }
    // Object separation: the model is picked and downloaded right here (Download, progress, Stop); Fix is for the packages.
    if (id === 'objsep' && c.sam2 && s !== 'checking' && s !== 'fixing') drawSam2(r.li, c.sam2);
  };

  // ---- Object separation's row: the three SAM 2.1 models (the recommended one marked), the creator's pick, and the
  // picked model's download into the Hugging Face cache (progress, Stop, carry on) ----
  let samPoll = null, live = true;
  const samMb = (x, id) => x.models.find((m) => m.id === id)?.mb || '';
  const samBar = (d, x) => {
    const pct = d.total ? Math.min(100, (d.got / d.total) * 100) : 0;
    return { pct, text: `${(d.got / 1e6).toFixed(d.total && d.total < 20e6 ? 1 : 0)} of ${d.total ? `${Math.round(d.total / 1e6)} MB` : samMb(x, d.size)}` };
  };
  function drawSam2(li, x) {
    const d = x.download || { state: 'idle' }, b = $('.su-b', li), a = $('.su-a', li);
    const busy = d.state === 'downloading';
    const pick = h(`<div class="su-models" role="radiogroup" aria-label="SAM 2.1 model for object separation">
      <label class="su-model"><input type="radio" name="sam2m" value="auto"${x.choice === 'auto' ? ' checked' : ''}${busy ? ' disabled' : ''}><b>Auto</b><span class="sub">${esc(x.recommended)}, recommended for ${esc(x.why)}</span></label>
      ${x.models.map((m) => `<label class="su-model"><input type="radio" name="sam2m" value="${esc(m.id)}"${x.choice === m.id ? ' checked' : ''}${busy ? ' disabled' : ''}><b>${esc(m.id)}</b>
        <span class="sub">${esc(m.mb)} · ${esc(m.speed)}</span>${m.id === x.recommended ? '<span class="badge ob-rec">Recommended</span>' : ''}${m.have ? '<span class="badge">Downloaded</span>' : ''}</label>`).join('')}
    </div>`);
    pick.querySelectorAll('input').forEach((i) => (i.onchange = async () => {
      try { await api('/api/app/settings', { section: 'objsep', values: { model: i.value } }); await check('objsep'); }
      catch (e) { toast(e.message); }
    }));
    b.append(pick);
    if (x.slow) b.append(h(`<span class="su-how">No GPU it can use here: object separation runs on the CPU and takes seconds a frame, so tiny is the one to have.</span>`));
    if (busy) {
      const { pct, text } = samBar(d, x);
      $('.su-s', a).textContent = 'Downloading';
      b.append(h(`<span class="su-dl"><span class="su-bar" role="progressbar" aria-label="Downloading SAM 2.1 ${esc(d.size)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><i style="width:${pct.toFixed(1)}%"></i></span><span class="sub mono">${esc(text)}</span></span>`));
      const stop = h(`<button type="button" class="btn small ghost">Stop</button>`);
      stop.onclick = async () => { stop.disabled = true; try { await api('/api/app/setup/sam2/stop', {}); } catch (e) { toast(e.message); } };
      a.prepend(stop);
      watchSam2();
      return;
    }
    if (x.there) return;
    if (d.state === 'error' || d.state === 'stopped') b.append(h(`<span class="su-how">${esc(d.error || 'Stopped.')}</span>`));
    else b.append(h(`<span class="sub">Download gets SAM 2.1 ${esc(x.picked)} (${esc(samMb(x, x.picked))}) from Hugging Face into <span class="mono">${esc(x.cache)}</span>, once for every studio. The skill never downloads by itself.</span>`));
    const go = h(`<button type="button" class="btn small dark">${d.got > 0 && d.state !== 'done' && d.size === x.picked ? 'Carry on' : 'Download'}</button>`);
    go.title = `Download SAM 2.1 ${x.picked} (${samMb(x, x.picked)}) into the Hugging Face cache`;
    go.onclick = async () => {
      go.disabled = true;
      try {
        const r = rows.get('objsep'), dl = await api('/api/app/setup/sam2/download', { size: x.picked });
        r.check.sam2 = { ...r.check.sam2, download: dl };
        if (dl.state === 'done') check('objsep'); else drawRow('objsep');
      } catch (e) { toast(e.message); go.disabled = false; }
    };
    a.prepend(go);
  }
  // While it downloads: the bar follows the server every half second; done → the row is checked again.
  function watchSam2() {
    if (samPoll) return;
    const tick = async () => {
      let d = null;
      try { d = await api('/api/app/setup/sam2'); } catch {}
      const r = rows.get('objsep');
      if (!live || !r?.check?.sam2 || !d) { samPoll = null; return; }
      r.check.sam2 = { ...r.check.sam2, download: d };
      const bar = $('.su-dl', r.li);
      if (d.state === 'downloading') {
        if (bar) { const { pct, text } = samBar(d, r.check.sam2); $('i', bar).style.width = `${pct.toFixed(1)}%`; $('.su-bar', bar).setAttribute('aria-valuenow', String(Math.round(pct))); $('.sub', bar).textContent = text; }
        else drawRow('objsep');
        samPoll = setTimeout(tick, 500);
        return;
      }
      samPoll = null;
      if (d.state === 'done') { toast(`SAM 2.1 ${d.size} is downloaded.`); check('objsep'); } else drawRow('objsep');
    };
    samPoll = setTimeout(tick, 500);
  }
  async function check(id) {
    const r = rows.get(id);
    r.state = 'checking'; drawRow(id); count();
    try { r.check = await api(`/api/app/setup/check?id=${encodeURIComponent(id)}`); r.state = r.check.state; }
    catch (e) { r.check = { ...r.check, detail: e.message }; r.state = 'fail'; }
    drawRow(id); count();
  }
  const checkAll = async () => { await Promise.all([...rows.keys()].map(check)); drawSteps(rows.get('folders')?.state === 'ok'); };

  async function fix(id) {
    fixing.add(id); drawRow(id);
    try {
      const r = await api('/api/app/assistant/fix', { id });
      if (!r.sent) { fixing.delete(id); rows.get(id).check = r.check; rows.get(id).state = r.check.state; drawRow(id); count(); toast('That one is fine now.'); }
    } catch (e) { fixing.delete(id); drawRow(id); toast(e.message); }
  }
  $('#again', el).onclick = checkAll;

  // ---- the assistant on the right; when it finishes a reply, check again ----
  let fromStudio = false;
  const panel = assistantPanel({
    hint: 'Press Fix on a row and I take it from there, asking before each step.',
    onResult: async () => {
      const ids = fixing.size ? [...fixing] : [...rows.keys()];
      fixing.clear();
      await Promise.all(ids.map(check));
      // "Fill in from my studio": the assistant asks before it writes, so the answers land a reply or two later.
      if (fromStudio) { const p = await api('/api/app/profile').catch(() => ({})); if (p.who || p.make || p.tone || p.brand || p.creators || p.formats?.length) { fromStudio = false; fill(p, true); } }
    },
  });
  $('#asCol', el).append(panel.el);

  // ---- make the studio yours: About you → Your brand → Motion skills, then BRAND.md and "Write my style" ----
  const about = aboutForm(st.formats);
  $('#aboutBox', el).append(about.el);
  const fill = (p, onlyEmpty = false) => about.fill(p || {}, onlyEmpty);
  fill(prof || {});
  let kit = null, skills = null, studioThere = null;
  // The brand and skills steps need the studio: drawn once it's there, again when it's just been created.
  const drawSteps = (there) => {
    if (there === studioThere) return;
    studioThere = there;
    kit = brandKit({ onChange: drawMine });
    skills = skillsPicker({ onInstalled: () => drawMine() });
    $('#kitBox', el).replaceChildren(kit.el);
    $('#skBox', el).replaceChildren(skills.el);
    drawMine();
  };
  const show = (step) => {
    el.querySelectorAll('.ob-tab').forEach((t) => { const on = t.dataset.step === step; t.classList.toggle('on', on); t.setAttribute('aria-selected', String(on)); });
    el.querySelectorAll('.ob-pane').forEach((p) => { p.hidden = p.dataset.pane !== step; });
    // Done (or skipped to the end): the steps fold away; the tabs open any of them again.
    $('#mine', el).classList.toggle('done', step === 'mine');
    if (step === 'mine') $('#mine', el).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  el.querySelectorAll('.ob-tab').forEach((t) => (t.onclick = () => show(t.dataset.step)));
  el.querySelectorAll('[data-skip],[data-next]').forEach((b) => (b.onclick = () => show(b.dataset.skip || b.dataset.next)));
  show('about');

  // Under the steps: what the studio now has of its own (BRAND.md, STYLE.md) and "Write my style".
  async function drawMine() {
    const [v, rec] = await Promise.all([api('/api/app/brand').catch(() => null), api('/api/app/skills/recommended').catch(() => null)]);
    const box = $('#mine', el);
    if (!v?.studio) { box.replaceChildren(h(`<p class="sub">Your answers, colours and brand files become <b>BRAND.md</b> in your studio, which every chat reads.</p>`)); return; }
    const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
    const sk = rec?.skills?.filter((s) => s.installed).length || 0;
    const have = [about.any() && 'your answers', v.files.length && n(v.files.length, 'brand file'), v.look.colors.length && n(v.look.colors.length, 'colour'),
      sk && `${sk} of ${rec.skills.length} motion skills`].filter(Boolean);
    box.replaceChildren(h(`<div class="ob-minei"><div class="ob-mt"><b>${v.brandMd ? 'Your studio has its own brand notes' : 'Your brand notes'}</b>
      <span class="sub">${v.brandMd ? `<span class="mono">${esc(v.brandMd)}</span>, which every chat in your studio reads${have.length ? `: ${esc(have.join(', '))}` : ''}.` : 'BRAND.md is written into your studio when you save your answers or add a brand file.'}
      ${v.styleMd ? ` Style guide: <span class="mono">${esc(v.styleMd)}</span>.` : ' “Write my style” asks the Video Octopus assistant for a fuller style guide (STYLE.md).'}</span></div>
      <button type="button" class="btn small accent" id="writeStyle"${v.brandMd ? '' : ' disabled'} title="The Video Octopus assistant drafts a fuller style guide (STYLE.md) from BRAND.md, your brand files and the examples you like">${v.styleMd ? 'Update my style' : 'Write my style'}</button></div>`));
    $('#writeStyle', box).onclick = async () => {
      try { await panel.send(WRITE_STYLE); toast('The Video Octopus assistant is on it, on the right: it shows its plan and asks before writing STYLE.md.'); }
      catch (e) { toast(e.message); }
    };
  }

  const answers = () => about.values();
  const saveQ = async () => {
    try {
      await saveAnswers(answers());
      const s = $('#saved', el); s.textContent = 'Saved'; s.classList.add('on'); setTimeout(() => s.classList.remove('on'), 1600);
      drawMine();
      return true;
    } catch (e) { toast(e.message); return false; }
  };
  $('#saveQ', el).onclick = async () => { if (!about.any() || await saveQ()) show('brand'); };
  $('#fromStudio', el).onclick = async () => {
    fromStudio = true;
    try { await panel.send(FROM_STUDIO); } catch (e) { fromStudio = false; toast(e.message); }
  };

  // ---- finish / skip ----
  $('#finish', el).onclick = async () => {
    if (about.any()) await saveQ();
    const bad = [...rows.values()].filter((r) => r.state === 'fail').map((r) => r.check.title);
    if (bad.length && !confirm(`Still missing: ${bad.join(', ')}. Finish setup anyway? (You can run it again from Settings.)`)) return;
    await api('/api/app/setup', { done: true });
    location.hash = back && back !== '#/setup' ? back : '#/';
  };
  $('#skip', el).onclick = () => {
    try { sessionStorage.setItem('studio.setupSkipped', '1'); } catch {}
    location.hash = back && back !== '#/setup' ? back : '#/';
  };

  for (const id of rows.keys()) drawRow(id);
  count();
  checkAll();
  return { teardown: () => { live = false; clearTimeout(samPoll); panel.destroy(); document.body.classList.remove('in-home', 'in-app-page'); } };
}

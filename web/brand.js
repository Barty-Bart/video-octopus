// The smarter onboarding's pieces, shared by Setup (#/setup) and Settings → Brand: the "About you" questions, the
// brand kit (uploads into <library>/brand/ with thumbnails and remove, the logo's colours as swatches, the fonts),
// the motion-graphics skills picker (the recommended GitHub repo, or any public repo from the Skills page) and the
// asks for the Video Octopus assistant ("Write my style"). Server side: server/brand.mjs, server/skills-gh.mjs.
import { $, esc, h, api, toast } from './ui.js';
import { paletteFromFile } from './brand-colors.js';

const X = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';
const mb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const fileUrl = (f) => `/api/app/brand/file?f=${encodeURIComponent(f)}`;

// ---- "About you": who, what, formats, tone, creators, the brand in words ----
export function aboutForm(formats) {
  const el = h(`<div class="ob-about">
    <label class="fl" for="qWho">Who you are</label>
    <input class="field" id="qWho" placeholder="Your name or channel, and who your videos are for" autocomplete="off">
    <label class="fl" for="qMake">What do you make?</label>
    <textarea class="field area" id="qMake" rows="2" placeholder="e.g. AI tool tutorials on YouTube, plus shorts. Same kind of video each time?"></textarea>
    <div class="fl" id="qFmtL">Your formats</div>
    <div class="su-fmts" role="group" aria-labelledby="qFmtL" id="qFmt"></div>
    <label class="fl" for="qTone">Your tone</label>
    <input class="field" id="qTone" placeholder="e.g. calm and clear, a little funny, no hype" autocomplete="off">
    <label class="fl" for="qCreators">Creators whose editing you like</label>
    <textarea class="field area" id="qCreators" rows="2" placeholder="Two or three names or video links"></textarea>
    <label class="fl" for="qBrand">Your brand in words</label>
    <textarea class="field area" id="qBrand" rows="2" placeholder="Fonts and colours (or “pick for me”), one accent colour, light or dark"></textarea>
  </div>`);
  const fmtBox = $('#qFmt', el);
  const all = [...Object.values(formats || {}), 'Podcast clips', 'Client work'];
  const fill = (p = {}, onlyEmpty = false) => {
    for (const [sel, v] of [['#qWho', p.who], ['#qMake', p.make], ['#qTone', p.tone], ['#qCreators', p.creators], ['#qBrand', p.brand]]) {
      const f = $(sel, el);
      if (v && (!onlyEmpty || !f.value.trim())) f.value = v;
    }
    // Answers saved before the formats were renamed (M3b) still tick the right box.
    const OLD = { 'Long-form': formats?.tutorial, 'YouTube Short': formats?.short, 'Reel (Instagram / TikTok)': formats?.short };
    const before = [...fmtBox.querySelectorAll('input:checked')].map((i) => i.value);
    const picked = new Set(onlyEmpty && before.length ? before : (p.formats || []).map((x) => OLD[x] || x).filter(Boolean));
    const extra = [...picked].filter((x) => !all.includes(x));
    fmtBox.replaceChildren(...[...all, ...extra].map((f) => h(`<label class="chk"><input type="checkbox" value="${esc(f)}"${picked.has(f) ? ' checked' : ''}><span>${esc(f)}</span></label>`)));
  };
  fill({});
  const values = () => ({ who: $('#qWho', el).value, make: $('#qMake', el).value, tone: $('#qTone', el).value, creators: $('#qCreators', el).value,
    brand: $('#qBrand', el).value, formats: [...fmtBox.querySelectorAll('input:checked')].map((i) => i.value) });
  const any = () => { const v = values(); return Boolean(v.who || v.make || v.tone || v.creators || v.brand || v.formats.length); };
  return { el, fill, values, any };
}

// Save the answers, then BRAND.md (when there's a studio). Returns the brand view, or null.
export async function saveAnswers(values) {
  await api('/api/app/profile', values);
  const v = await api('/api/app/brand').catch(() => null);
  if (!v?.studio) return null;
  return (await api('/api/app/brand/write', {})).view;
}

// The assistant asks. Short, and the assistant asks before it writes anything.
export const FROM_STUDIO = 'For the Setup page: read my studio\'s own notes (its CLAUDE.md, BRAND.md and any style, brand or memory notes it points to) and answer the Setup questions from them: who I am, what I make, my formats, my tone, my brand (fonts, colours) and the creators whose editing I like. Only use what the notes say. Write the answers to Video Octopus\'s local/profile.json as {"who", "make", "formats": [...], "tone", "brand", "creators"} (ask me first; keep any answer that\'s already there unless the notes say otherwise), then list them for me in a few lines.';
export const WRITE_STYLE = 'Write my style guide: draft STYLE.md in my studio folder from BRAND.md, memory/style.md and memory/preferences.md, the files in the library\'s brand/ folder (logos, photos of me, product images, fonts) and the videos and thumbnails I like in brand/examples/ (for each video: a few frames and a contact sheet made with ffmpeg on this computer, into brand/examples/work/). Cover the look (each colour as hex and where it goes; fonts for titles, captions and small text; light or dark), titles and captions, cards and frames, layouts, motion (pace, transitions, and which of the studio\'s motion-graphics skills in .claude/skills to use for what), B-roll, sound, thumbnails, and short Do / Don\'t lines. Use only what the files and notes show and mark guesses "(guess)"; never copy other creators\' words. If STYLE.md is there already, show me what you\'d change instead of replacing it. Ask me before writing, then tell me in three lines what\'s in it.';

// ---- the brand kit: five folders of uploads, the logo's colours, the fonts ----
function upload(file, kind, onProgress) {
  return new Promise((done, fail) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/app/brand/upload?${new URLSearchParams({ kind, name: file.name })}`);
    x.setRequestHeader('X-Studio', '1');
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch {} x.status < 300 ? done(j) : fail(new Error(j.error || `Upload failed (${x.status})`)); };
    x.onerror = () => fail(new Error('Upload failed'));
    x.send(file);
  });
}

export function brandKit({ onChange } = {}) {
  const el = h(`<div class="ob-kit"><div class="ob-grid"></div>
    <div class="ob-colors"><div class="ob-ch"><b>Brand colours</b><span class="sub" data-r="cnote">Video Octopus picks them from your logo; change any of them.</span></div>
      <div class="ob-sws" data-r="sws"></div>
      <div class="ob-sugg" data-r="sugg" hidden></div></div>
    <div class="ob-fonts"><label class="fl" for="obFonts">Fonts for titles and captions</label>
      <input class="field" id="obFonts" placeholder="e.g. Inter for titles, Caveat for hand-drawn notes (or “pick for me”)" autocomplete="off"></div>
  </div>`);
  let V = null, colors = [], suggestion = null;
  const grid = $('.ob-grid', el), sws = $('[data-r=sws]', el), sugg = $('[data-r=sugg]', el), fonts = $('#obFonts', el);
  const parts = [grid, $('.ob-colors', el), $('.ob-fonts', el)];
  const busy = new Map(); // kind -> [{id, name, p}]
  let nextId = 0;

  const saveLook = async (values) => {
    try {
      await api('/api/app/settings', { section: 'look', values });
      const r = await api('/api/app/brand/write', {}).catch(() => null);
      if (r?.view) V = r.view;
      onChange?.(V);
      return true;
    } catch (e) { toast(e.message); return false; }
  };

  const drawColors = () => {
    sws.replaceChildren(...colors.map((c, i) => {
      const w = h(`<span class="ob-sw"><input type="color" value="${esc(c.length === 4 ? `#${[...c.slice(1)].map((x) => x + x).join('')}` : c.slice(0, 7))}" aria-label="Brand colour ${i + 1}"><code>${esc(c)}</code><button type="button" class="ob-x" aria-label="Remove ${esc(c)}">${X}</button></span>`);
      $('input', w).onchange = (e) => { colors[i] = e.target.value; saveLook({ colors }); drawColors(); };
      $('.ob-x', w).onclick = () => { colors.splice(i, 1); saveLook({ colors }); drawColors(); };
      return w;
    }));
    if (colors.length < 8) {
      const add = h(`<button type="button" class="btn small ghost">+ Colour</button>`);
      add.onclick = () => { colors.push(colors[0] || '#c2410c'); saveLook({ colors }); drawColors(); };
      sws.append(add);
    }
    const logos = (V?.files || []).filter((f) => f.kind === 'logos' && f.type === 'image');
    if (logos.length) {
      const pick = h(`<button type="button" class="btn small ghost">Pick from my logo</button>`);
      pick.onclick = async () => {
        pick.disabled = true;
        try { const blob = await (await fetch(fileUrl(logos.at(-1).file))).blob(); await suggest(blob); } catch (e) { toast(`Couldn't read the logo's colours: ${e.message}`); }
        pick.disabled = false;
      };
      sws.append(pick);
    }
    sugg.hidden = !suggestion?.length;
    if (suggestion?.length) {
      sugg.replaceChildren(h(`<span class="sub">From your logo:</span>`), ...suggestion.map((c) => h(`<span class="ob-chip" style="--c:${esc(c)}"><i></i><code>${esc(c)}</code></span>`)));
      const use = h(`<button type="button" class="btn small dark">${colors.length ? 'Use these instead' : 'Use these colours'}</button>`);
      use.onclick = async () => { colors = [...suggestion]; suggestion = null; if (await saveLook({ colors })) toast('Brand colours saved. Claude uses them for titles, cards and accents.'); drawColors(); };
      const no = h(`<button type="button" class="btn small ghost">Not these</button>`);
      no.onclick = () => { suggestion = null; drawColors(); };
      sugg.append(use, no);
    }
  };
  const suggest = async (blob) => {
    const got = await paletteFromFile(blob, { max: 5, min: 3 });
    if (!got.length) return toast('No colours found in that logo.');
    suggestion = got;
    // No colours yet: the logo's are the starting point, saved at once (every swatch stays editable).
    if (!colors.length) { colors = [...got]; suggestion = null; await saveLook({ colors }); toast('Brand colours picked from your logo. Change any of them.'); }
    drawColors();
  };

  const thumb = (f) => {
    const pic = f.type === 'image' ? `<img src="${esc(fileUrl(f.file))}" alt="" loading="lazy" draggable="false">`
      : f.type === 'video' ? `<video src="${esc(fileUrl(f.file))}#t=0.5" muted preload="metadata" playsinline></video>`
      : `<span class="ob-font" data-font="${esc(f.file)}">Aa</span>`;
    const t = h(`<figure class="ob-th ${f.type}" title="${esc(`${f.name} · ${mb(f.bytes)}`)}">${pic}<figcaption>${esc(f.name)}</figcaption>
      <button type="button" class="ob-x" aria-label="Remove ${esc(f.name)}">${X}</button></figure>`);
    $('.ob-x', t).onclick = async () => {
      if (!confirm(`Remove ${f.name} from your brand files? It's deleted from the studio's library.`)) return;
      try { V = (await api('/api/app/brand/remove', { file: f.file })).view; draw(); onChange?.(V); } catch (e) { toast(e.message); }
    };
    if (f.type === 'font') {
      const fam = `brand-${f.file.replace(/[^\w]/g, '-')}`;
      try { const face = new FontFace(fam, `url("${fileUrl(f.file)}")`); face.load().then((x) => { document.fonts.add(x); $('.ob-font', t).style.fontFamily = `"${fam}"`; }).catch(() => {}); } catch {}
    }
    return t;
  };

  const add = async (kind, list) => {
    const k = V.kinds.find((x) => x.key === kind);
    const files = [...list].filter((f) => {
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (!k.ext.includes(ext)) { toast(`${k.label} take ${k.ext.map((x) => `.${x}`).join(', ')} files: ${f.name} isn't one.`); return false; }
      if (f.size > k.max) { toast(`${f.name} is too big for ${k.label.toLowerCase()} (${mb(k.max)} at most).`); return false; }
      return true;
    });
    for (const f of files) {
      const row = { id: ++nextId, name: f.name, p: 0 };
      busy.set(kind, [...(busy.get(kind) || []), row]);
      draw();
      try {
        const r = await upload(f, kind, (p) => { row.p = p; const b = el.querySelector(`[data-busy="${row.id}"]`); if (b) b.textContent = `${Math.round(p * 100)}%`; });
        V = r.view;
        if (kind === 'logos' && /^image\//.test(f.type)) suggest(f).catch(() => {});
        onChange?.(V);
      } catch (e) { toast(`${f.name}: ${e.message}`); }
      busy.set(kind, (busy.get(kind) || []).filter((x) => x !== row));
      draw();
    }
  };

  const draw = () => {
    if (!V) return;
    if (!V.studio) {
      el.replaceChildren(h(`<div class="ob-none"><b>Create your studio first</b><span class="sub">Brand files go into its library (library/brand). Create it in Setup’s “Your studio and projects folders” row (or Settings → Folders), then come back here.</span></div>`));
      return;
    }
    grid.replaceChildren(...V.kinds.map((k) => {
      const mine = V.files.filter((f) => f.kind === k.key);
      const accept = k.ext.map((x) => `.${x}`).join(',');
      const card = h(`<div class="ob-card" data-kind="${esc(k.key)}">
        <div class="ob-ch"><b>${esc(k.label)}</b><span class="gap"></span><button type="button" class="btn small ghost" data-a="add">Add</button>
          <input type="file" multiple hidden accept="${esc(accept)}" aria-label="Add ${esc(k.label.toLowerCase())}"></div>
        <span class="sub">${esc(k.hint)} · ${esc(k.ext.join(', '))}</span>
        <div class="ob-thumbs"></div></div>`);
      const box = $('.ob-thumbs', card);
      box.append(...mine.map(thumb), ...(busy.get(k.key) || []).map((b) => h(`<figure class="ob-th busy"><span class="spin" aria-hidden="true"></span><span class="ob-pc" data-busy="${b.id}">${Math.round(b.p * 100)}%</span><figcaption>${esc(b.name)}</figcaption></figure>`)));
      if (!mine.length && !(busy.get(k.key) || []).length) box.append(h(`<span class="ob-drop sub">Drop files here</span>`));
      const input = $('input', card);
      $('[data-a=add]', card).onclick = () => input.click();
      input.onchange = () => { add(k.key, input.files); input.value = ''; };
      card.ondragover = (e) => { e.preventDefault(); card.classList.add('over'); };
      card.ondragleave = (e) => { if (!card.contains(e.relatedTarget)) card.classList.remove('over'); };
      card.ondrop = (e) => { e.preventDefault(); card.classList.remove('over'); add(k.key, e.dataTransfer.files); };
      return card;
    }));
    if (!el.contains(grid)) el.replaceChildren(...parts);
    drawColors();
  };

  let fontsWas = '';
  const commitFonts = () => { if (fonts.value !== fontsWas) { fontsWas = fonts.value; saveLook({ fonts: fonts.value.trim() }); } };
  fonts.onchange = commitFonts;
  fonts.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commitFonts(); } };

  const load = async () => {
    try { V = await api('/api/app/brand'); } catch (e) { el.replaceChildren(h(`<p class="sub">${esc(e.message)}</p>`)); return; }
    colors = [...(V.look?.colors || [])];
    fonts.value = fontsWas = V.look?.fonts || '';
    draw();
  };
  load();
  return { el, reload: load, view: () => V };
}

// ---- motion-graphics skills: a repo's skills with checkboxes, installed ones marked, never overwritten ----
export function skillsPicker({ repo = null, onInstalled, compact = false } = {}) {
  const el = h(`<div class="ob-skills${compact ? ' compact' : ''}"><p class="sub">Looking…</p></div>`);
  let R = null;
  const draw = () => {
    if (R.studio === false) {
      el.replaceChildren(h(`<div class="ob-none"><b>Create your studio first</b><span class="sub">Skills go into its .claude/skills folder. Create it in Setup’s “Your studio and projects folders” row (or Settings → Folders).</span></div>`));
      return;
    }
    const fresh = R.skills.filter((s) => !s.installed);
    el.replaceChildren(h(`<div class="ob-repo"><div class="ob-rt"><a href="${esc(R.url)}" target="_blank" rel="noopener" class="mono">${esc(R.repo)}</a>
        ${R.recommended ? '<span class="badge ob-rec">Recommended</span>' : ''}${R.license ? `<span class="badge">${esc(R.license)}</span>` : ''}</div>
        ${R.about ? `<span class="sub">${esc(R.about)}</span>` : ''}</div>`),
      h(`<div class="ob-sklist" role="group" aria-label="Skills in ${esc(R.repo)}">${R.skills.map((s) => `<label class="ob-sk${s.installed ? ' have' : ''}">
        <input type="checkbox" value="${esc(s.name)}"${s.installed ? ' disabled' : ' checked'}><span class="ob-skt"><b>${esc(s.name)}</b><small>${esc(s.description || '')}</small></span>
        ${s.installed ? '<span class="badge">In your studio</span>' : ''}</label>`).join('')}</div>`),
      h(`<div class="ob-skact"><span class="sub" data-r="msg">${R.skills.length ? `Video Octopus copies them into your studio's .claude/skills. A skill you already have is never replaced.` : 'No skills found in this repo (Video Octopus looks for folders with a SKILL.md).'}</span><span class="gap"></span>
        <button type="button" class="btn small dark" data-a="go"${fresh.length ? '' : ' disabled'}>${fresh.length ? `Install ${fresh.length === R.skills.length && fresh.length > 1 ? 'all ' : ''}${fresh.length} skill${fresh.length > 1 ? 's' : ''}` : 'All installed'}</button></div>`));
    const go = $('[data-a=go]', el), msg = $('[data-r=msg]', el);
    const count = () => { const n = el.querySelectorAll('.ob-sk input:checked:not(:disabled)').length; go.disabled = !n; go.textContent = n ? `Install ${n} skill${n > 1 ? 's' : ''}` : fresh.length ? 'Pick a skill' : 'All installed'; };
    el.querySelectorAll('.ob-sk input').forEach((i) => (i.onchange = count));
    go.onclick = async () => {
      const skills = [...el.querySelectorAll('.ob-sk input:checked:not(:disabled)')].map((i) => i.value);
      go.disabled = true; go.textContent = 'Installing…';
      msg.textContent = `Downloading ${R.repo} from GitHub…`;
      try {
        const r = await api('/api/app/skills/install', { repo: R.repo, skills });
        const said = [r.installed.length && `Installed ${r.installed.map((x) => x.name).join(', ')}.`,
          r.skipped.length && `Already in your studio, kept as it is: ${r.skipped.map((x) => x.name).join(', ')}.`,
          r.missing.length && `Not in the repo: ${r.missing.join(', ')}.`,
          r.refused && `${r.refused} link${r.refused > 1 ? 's or unsafe paths' : ' or unsafe path'} left out.`].filter(Boolean).join(' ');
        toast(said || 'Nothing to install.');
        await load();
        $('[data-r=msg]', el).textContent = said;
        onInstalled?.(r);
      } catch (e) { msg.textContent = e.message; toast(e.message); count(); }
    };
  };
  const load = async () => {
    try { R = await api(repo ? `/api/app/skills/repo?repo=${encodeURIComponent(repo)}` : '/api/app/skills/recommended'); }
    catch (e) { el.replaceChildren(h(`<p class="sub">${esc(e.message)}</p>`)); return; }
    if (repo) R.studio = true; // a repo view only loads with a studio there (the install says so otherwise)
    draw();
  };
  load();
  return { el, reload: load };
}

// The Skills page's "Add skills from GitHub": a repo field (the recommended one filled in), its skills, Install.
export function addSkillsDialog({ onDone } = {}) {
  const modal = $('#modal');
  const d = h(`<div class="dialog np ob-dlg" role="dialog" aria-modal="true" aria-labelledby="obT">
    <div class="np-head"><div><h3 id="obT">Add skills from GitHub</h3><div class="sub">Any public repo with skills in it (folders with a SKILL.md). Video Octopus copies the ones you pick into your studio and never replaces one you have.</div></div>
      <button class="btn ghost small np-x" data-a="x" aria-label="Close">${X}</button></div>
    <form class="ob-repoq"><input class="field mono" name="repo" value="Barty-Bart/motion-graphics" spellcheck="false" autocomplete="off" aria-label="GitHub repo, as owner/name or a github.com link"><button class="btn small">Look</button></form>
    <div class="ob-found"></div>
    <div class="actions"><button class="btn ghost" data-a="x">Close</button></div></div>`);
  modal.replaceChildren(d); modal.hidden = false;
  let changed = false;
  const close = () => { if (modal.hidden) return; modal.hidden = true; document.removeEventListener('keydown', onEsc); window.removeEventListener('hashchange', close); if (changed) onDone?.(); };
  const onEsc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onEsc);
  window.addEventListener('hashchange', close); // another page: the dialog goes with this one
  d.querySelectorAll('[data-a=x]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); close(); }));
  const found = $('.ob-found', d), form = $('form', d);
  const look = () => { found.replaceChildren(skillsPicker({ repo: form.elements.repo.value.trim(), onInstalled: () => { changed = true; } }).el); };
  form.onsubmit = (e) => { e.preventDefault(); look(); };
  look();
}

// ---- Settings → Brand: the same pieces, plus BRAND.md and STYLE.md ----
export function brandSettings({ formats, ask }) {
  const wrap = h(`<div class="ob-set"></div>`);
  const sec = (title, sub, ...nodes) => { const g = h(`<section class="set-group ob-g"><h2>${esc(title)}</h2>${sub ? `<p class="sub">${sub}</p>` : ''}</section>`); g.append(...nodes); return g; };
  const about = aboutForm(formats);
  const saved = h(`<span class="set-saved" aria-live="polite"></span>`);
  const save = h(`<button type="button" class="btn small dark">Save answers</button>`);
  const notes = h(`<div class="ob-notes"></div>`);
  const drawNotes = (v) => {
    notes.replaceChildren(
      h(`<div class="ob-note"><b>BRAND.md</b><span class="sub">${v?.brandMd ? `<span class="mono">${esc(v.brandMd)}</span> · written from your answers, colours, fonts and brand files; your own notes outside its marker lines stay.` : v?.studio ? 'Not written yet: save your answers or add a brand file.' : 'Comes with your studio.'}</span></div>`),
      h(`<div class="ob-note"><b>STYLE.md</b><span class="sub">${v?.styleMd ? `<span class="mono">${esc(v.styleMd)}</span>` : 'Not written yet: the Video Octopus assistant drafts a fuller style guide from BRAND.md, your brand files and the examples you like.'}</span></div>`));
    const row = h(`<div class="ob-noteact"><a class="btn small ghost" href="#/setup">Open the brand step in Setup</a><span class="gap"></span></div>`);
    if (v?.studio) {
      const write = h(`<button type="button" class="btn small">Update BRAND.md</button>`);
      write.onclick = async () => { try { const r = await api('/api/app/brand/write', {}); drawNotes(r.view); toast(`BRAND.md ${r.created ? 'written' : 'updated'}: ${r.shown}`); } catch (e) { toast(e.message); } };
      const style = h(`<button type="button" class="btn small accent">Write my style</button>`);
      style.onclick = async () => { try { await ask(WRITE_STYLE); toast('Asked the Video Octopus assistant: it shows its plan and asks before writing STYLE.md.'); } catch (e) { toast(e.message); } };
      row.append(write, style);
    }
    notes.append(row);
  };
  save.onclick = async () => {
    try { const v = await saveAnswers(about.values()); if (v) drawNotes(v); saved.textContent = 'Saved'; saved.classList.add('on'); setTimeout(() => saved.classList.remove('on'), 1600); }
    catch (e) { toast(e.message); }
  };
  const act = h(`<div class="su-q-actions"><span class="gap"></span></div>`);
  act.append(saved, save);
  const kit = brandKit({ onChange: (v) => drawNotes(v) });
  wrap.append(
    sec('About you', 'Your answers from Setup. They go into BRAND.md, which every chat in your studio reads.', about.el, act),
    sec('Brand files', 'Logos, photos of you, product images, fonts and examples you like, kept in your studio’s library (brand/).', kit.el),
    sec('Your style notes', '', notes),
    sec('Motion-graphics skills', 'Skills Claude uses to build your graphics. More from any GitHub repo: Home → Skills → Add skills from GitHub.', skillsPicker({ compact: true }).el));
  api('/api/app/profile').then((p) => about.fill(p || {})).catch(() => {});
  api('/api/app/brand').then(drawNotes).catch(() => drawNotes(null));
  return wrap;
}


// The Simple editor (V1 spec §5–6, one-editor §0.2): what a video looks like in Simple mode (web/mode.js isAdvanced()
// false). openProject (web/app.js) builds the editor as in beta.23 and, in Simple, mounts this over it: the same chat,
// canvas, recorder and exports, with a calmer layout. Nothing of Advanced is removed; the Advanced-only surfaces are
// hidden by simple.css under .project.simple (web/simple-flow.js SIMPLE_HIDDEN lists them).
//
// - Top bar: ‹ Projects · the name · the shape chip (as before) · a six-step progress line (not clickable) · Download
//   (primary once the final video, or for Audio only the cleaned audio, exists).
// - Left: Claude, wide (about 440 px): one step card at a time (web/simple-flow.js stepCard), Claude's replies in plain
//   sentences, the drop area ("Drop anything for Claude") and the composer "Tell Claude what to change…". The permission
//   banner (one, over the messages) and the B10 badge stay as they are.
// - Right: the Record page while there's no take; then the video with captions (the canvas), the clickable transcript
//   and the editable waveform (web/simple-wave.js), which stays on every step.
// - Tools (right edge): Captions · Music · Text · Effects, each a tiny panel with "or ask Claude".
import { $, esc, h, api, toast } from './ui.js';
import * as rec from './recorder.js';
import { stepCard, roughCutState, simpleStepNow, progressLine, downloadTarget, exportOptions, toolsOf, isAudio, mmss,
  CAPTION_LOOKS, INTENSITY, MUSIC_BEDS, BED_GAIN } from './simple-flow.js';
import { simpleSteps } from './simple.js';
import { cutoutNotesHTML } from './cutout.js';
import { dropKind, dropAsks, SIMPLE_KINDS, AUDIO_ACCEPT } from './resource-kinds.js';
import { makeCutModel, makeWave, makeTranscript, cutRange, restoreRange, isKept } from './simple-wave.js';
import { askKind } from './resources-page.js';
import { makeRecordPage, openTeleprompter, listTakes, deleteTake, restoreTake, useTake, sourcesFor } from './simple-record.js';

const TAKE_FILE = /\.(mov|mp4|m4v|mkv|webm|wav|m4a|mp3|aif|aiff|caf|flac)$/i;
const ICON = {
  captions: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="M6 10.5h3M11 10.5h3M6 13h5"/></svg>',
  music: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 15V5l8-1.5v10"/><circle cx="6" cy="15" r="2"/><circle cx="14" cy="13.5" r="2"/></svg>',
  text: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M10 5v11M7.5 16h5"/></svg>',
  effects: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"/><rect x="7" y="7" width="6" height="6" rx="1"/></svg>',
  drop: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10M6 9l4 4 4-4M4 16h12"/></svg>',
};
const ss = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch {} },
};

// ctx: { el, id, getP, refresh, chat, canvas, importTakeFile(file), exportVideo(opts), showCanvas(), status() }
export function mountSimpleEditor(ctx) {
  const { el, id, getP } = ctx;
  const base = `/api/projects/${encodeURIComponent(id)}`;
  const who = () => window.STUDIO_AGENT || 'Claude';
  const key = (k) => `studio.simple.${id}.${k}`;
  el.classList.add('simple');
  document.body.classList.add('simple-editor');
  ctx.showCanvas();

  // ---- state the card needs besides the project ----
  const st = {
    chain: ss.get(key('chain')) === '1', listened: ss.get(key('listened')) === '1', kept: ss.get(key('kept')) === '1',
    takes: [], deleted: null, deleteAsk: null, spot: null, thumbs: { state: 'none' }, job: null, exportError: null,
    posting: false, postDone: false, planChange: false, sceneCount: 0, recError: null, lastRun: null, audioQueue: [],
  };
  const setFlag = (k, v) => { st[k] = v; ss.set(key(k), v ? '1' : null); };

  // ---- top bar: the progress line and Download ----
  const prog = h('<nav class="sx-prog" aria-label="Progress"></nav>');
  $('#rail')?.after(prog);
  const dl = h('<a class="btn sx-dl" id="sxDownload" role="button" aria-disabled="true">Download</a>');
  $('#barActions')?.append(dl);
  dl.addEventListener('click', (e) => { if (dl.getAttribute('aria-disabled') === 'true') { e.preventDefault(); toast(isAudio(getP()) ? 'The audio download comes at the end: Claude leads you there.' : 'Download is ready once your video is built.'); } });

  // ---- left: the card, the drop area, the composer ----
  const chatCol = $('.col.chat', el);
  const cardHost = h('<div class="sx-lead" aria-live="polite"></div>');
  $('.chat-head', chatCol)?.after(cardHost);
  const drop = h(`<div class="sx-drop" tabindex="0" role="button" aria-label="Drop anything for Claude, or click to pick files">${ICON.drop}<b>Drop anything for Claude</b>
    <span class="sub">Clips, screenshots, product photos, a logo, notes. ${esc(who())} decides where they go and tells you.</span><span class="sx-drop-last" hidden></span>
    <input type="file" multiple hidden></div>`);
  $('.composer', chatCol)?.before(drop);
  const input = $('#input', chatCol);
  if (input) { input.dataset.advancedPlaceholder = input.placeholder; input.placeholder = 'Tell Claude what to change…'; }
  const empty = $('#emptyChat', chatCol);
  if (empty) empty.hidden = true;

  // ---- right: the Record page, or the video, transcript and waveform ----
  const center = $('.col.center', el);
  const main = h('<div class="sx-main"></div>');
  const below = h('<div class="sx-below"><div class="sx-side"></div></div>');
  center.append(main, below);
  const over = h('<div class="sx-over" hidden></div>'); // thumbnails over the video
  $('.tab-body', center).append(over);
  const side = $('.sx-side', below);
  const model = makeCutModel({ id, onChange: () => { transcript?.update(); wave?.update(); }, onUnlock: async () => { await api(`${base}/rail`, { op: 'unfinished-ok' }).catch(() => {}); ctx.refresh(); } });
  const player = {
    media: () => ctx.canvas.media(),
    time: () => ctx.canvas.time(),
    playing: () => { const m = ctx.canvas.media(); return Boolean(m && !m.paused); },
    play: () => { const b = $('[data-pane=canvas] #play', el); if (b && !player.playing()) b.click(); },
    pause: () => { const b = $('[data-pane=canvas] #play', el); if (b && player.playing()) b.click(); },
    seek: (t) => ctx.canvas.seek(t),
    duration: () => ctx.canvas.media()?.duration || getP().export?.duration || 0,
  };
  const transcript = makeTranscript({ host: side, model, player });
  const sceneList = h('<section class="sx-scenes" aria-label="Your scenes" hidden></section>');
  side.append(sceneList);
  let scenesDoc = null;
  const wave = makeWave({ host: below, model, player, peaksUrl: (f) => `${base}/peaks?f=${encodeURIComponent(f.includes('/') ? f : `source/${f}`)}`,
    fallbackFile: () => { const c = getP().canvas || {}; return c.cam || c.screen || c.audio || null; },
    blocks: () => sceneBlocks() });
  const recPage = makeRecordPage({ id, getP,
    onRecord: (sources, text) => record(sources, text), onAskScript: () => askScript(), onFile: (f) => takeFile(f) });
  main.append(recPage.el);

  // ---- tools ----
  const tools = h(`<aside class="sx-tools" aria-label="Tools">${['captions', 'music', 'text', 'effects'].map((k) => `<button type="button" class="sx-tool" data-tool="${k}" aria-expanded="false">${ICON[k]}<span>${k[0].toUpperCase() + k.slice(1)}</span></button>`).join('')}
    <div class="sx-panel" role="dialog" aria-modal="false" hidden></div></aside>`);
  el.append(tools);
  const panel = $('.sx-panel', tools);
  let toolOpen = null, sounds = null, mine = null;
  // The creator's own music: Resources' music files (web/resource-kinds.js), listed in the Music tool as beds.
  const loadMine = async () => { try { mine = ((await api('/api/simple-resources')).files || []).filter((f) => f.kind === 'music'); } catch { mine = []; } };

  // ================= the card =================
  function card() {
    const P = getP();
    const S = rec.session(), mine = S.project === id;
    const recording = ['starting', 'recording', 'stopping', 'saving'].includes(S.phase) && mine;
    const saving = ['stopping', 'saving'].includes(S.phase) && mine;
    return stepCard(P, { ...st, recording, saving, agent: who(), take: { duration: st.takes.find((t) => t.canvas)?.duration },
      exporting: st.job ? { progress: st.job.progress } : P.export?.running ? { progress: P.export.running.progress } : null });
  }
  function paintCard() {
    const P = getP(), c = card();
    const out = [];
    for (const s of c.say) out.push(`<p class="sx-say">${esc(s)}</p>`);
    const btns = c.buttons.map((b) => `<button type="button" class="btn ${b.kind === 'primary' ? 'primary' : ''}" data-a="${b.a}"${b.disabled ? ' disabled' : ''}>${esc(b.label)}</button>`).join('');
    let extra = '';
    if (c.extra === 'takes' && st.takes.length > 1) {
      extra += `<p class="sx-takes">Takes: ${st.takes.map((t) => `<button type="button" class="sx-take${t.canvas ? ' on' : ''}" data-take="${esc(t.id)}" aria-pressed="${t.canvas}" title="Take ${t.n}${t.duration ? ` · ${mmss(t.duration)}` : ''}">${t.n}</button>`).join(' · ')}</p>`;
    }
    if (st.deleted) extra += `<p class="sx-undo">${esc(st.deleted.label)} deleted · <button type="button" class="linkish" data-a="undo-delete">Undo</button></p>`;
    if (st.deleteAsk) extra += `<p class="sx-ask">${esc(st.deleteAsk)} <button type="button" class="btn small" data-a="delete-yes">Delete anyway</button> <button type="button" class="btn small ghost" data-a="delete-no">Keep it</button></p>`;
    if (st.recError && c.step === 'record') extra += `<p class="sx-err">${esc(st.recError)} <button type="button" class="btn small" data-a="record-again">Try again</button></p>`;
    if (c.step === 'scenes' && st.planChange) extra += `<div class="sx-change"><label class="vh" for="sxChange">What should change?</label><textarea id="sxChange" class="field" rows="3" placeholder="What should change in the plan?"></textarea>
      <div class="sx-btns"><button type="button" class="btn primary" data-a="change-send">Send to ${esc(who())}</button><button type="button" class="btn ghost" data-a="change-cancel">Cancel</button></div></div>`;
    if (c.extra === 'download') {
      const tgt = downloadTarget(P), post = P.kit?.post?.exists ? P.kit.post : null;
      extra += `<div class="sx-dlbox"><b>Download</b><span class="sub">${esc(c.lines[0] || '')}</span>${tgt.files.map((f, i) => `<a class="btn ${i ? '' : 'primary'}" href="${esc(fileUrl(f.file))}" download="${esc(f.file.split('/').pop())}" data-a="dl">${esc(i ? f.label : `Download ${tgt.kind}`)}</a>`).join('')}
        ${isAudio(P) && !tgt.files.some((f) => /MP3/.test(f.label)) ? '<button type="button" class="btn" data-a="mp3">Make an MP3 too</button>' : ''}
        ${st.mainThumb ? `<a class="btn" href="/api/packaging/${encodeURIComponent(id)}/item/${encodeURIComponent(st.mainThumb.id)}" download="${esc(`${P.name || id} ${isAudio(P) ? 'cover' : 'thumbnail'}.${st.mainThumb.ext || 'png'}`)}" data-a="dl">${isAudio(P) ? 'Download the cover' : 'Download the thumbnail'}</a>` : ''}</div>`;
      if (c.post === 'offer') extra += `<div class="sx-post"><span>Want a title and description for YouTube too?</span><div class="sx-btns"><button type="button" class="btn" data-a="post">Write them</button><button type="button" class="btn ghost" data-a="no-post">No thanks</button></div></div>`;
      if (post && st.postDone) extra += `<p class="sx-say">The title and description are written: ask ${esc(who())} to show them, or to change anything.</p>`;
      if (c.post === 'writing') extra += `<p class="sx-say">${esc(who())} is writing the title and description in the chat below.</p>`;
    }
    // Scenes built without their cutout (roto inside Build): "Scene 2: Built without the cutout · Set up".
    if (c.notes?.length) extra += `<div class="sx-notes">${cutoutNotesHTML(c.notes, esc)}</div>`;
    const lines = c.extra === 'download' ? [] : c.lines;
    const prog = c.progress != null ? `<div class="sx-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(c.progress * 100)}"><i style="width:${Math.round(c.progress * 100)}%"></i></div>` : '';
    const body = c.title || lines.length || btns || extra ? `<div class="sx-card${c.error ? ' err' : ''}${c.busy ? ' busy' : ''}" data-step="${c.step}">
      ${c.title ? `<p class="sx-title">${c.busy ? '<span class="spin" aria-hidden="true"></span>' : ''}${esc(c.title)}</p>` : ''}
      ${lines.map((l) => `<p class="sx-line">${esc(l)}</p>`).join('')}${prog}
      ${extra}${btns ? `<div class="sx-btns">${btns}</div>` : ''}${c.foot ? `<p class="sub sx-foot">${esc(c.foot)}</p>` : ''}</div>` : '';
    const html = out.join('') + body;
    if (cardHost.dataset.html !== html) { cardHost.dataset.html = html; cardHost.innerHTML = html; }
    return c;
  }
  const fileUrl = (f) => `${base}/media?f=${encodeURIComponent(f)}`;

  function paintTop(c) {
    const P = getP();
    const line = progressLine(P, c.step);
    const sig = JSON.stringify(line);
    if (prog.dataset.sig !== sig) {
      prog.dataset.sig = sig;
      prog.innerHTML = line.map((s, i) => `${i ? '<span class="sx-sp" aria-hidden="true"></span>' : ''}<span class="sx-st ${s.state}"${s.state === 'current' ? ' aria-current="step"' : ''}><i aria-hidden="true"></i>${esc(s.label)}${s.state === 'done' ? '<span class="vh"> (done)</span>' : s.state === 'skipped' ? '<span class="vh"> (skipped)</span>' : ''}</span>`).join('');
    }
    const tgt = downloadTarget(P);
    const f = tgt.files[0];
    dl.classList.toggle('primary', tgt.ready);
    dl.setAttribute('aria-disabled', String(!tgt.ready));
    if (f) { dl.href = fileUrl(f.file); dl.download = f.file.split('/').pop(); dl.title = `Download ${f.file.split('/').pop()}`; }
    else { dl.removeAttribute('href'); dl.removeAttribute('download'); dl.title = 'Ready once the final video exists'; }
  }

  // ================= the layout of the right side =================
  function paintMain(c) {
    const P = getP();
    const page = c.extra === 'record-page';
    el.classList.toggle('sx-recording-page', page);
    recPage.el.hidden = !page;
    main.hidden = !page;
    // the video's captions and the locked-cut playback
    const play = $('[data-pane=canvas] #cutPlay', el);
    if (play && !play.checked && P.export?.cut) { play.checked = true; play.dispatchEvent(new Event('change')); }
    const wrap = $('[data-pane=canvas] .canvas-wrap', el);
    if (wrap && !$('.sx-cap', wrap)) wrap.append(capEl);
    // scenes: the list in the transcript's place while the plan waits for approval
    const showScenes = c.step === 'scenes' && c.extra === 'scenes';
    sceneList.hidden = !showScenes;
    transcript.el.hidden = showScenes;
    if (showScenes || c.step === 'build') loadScenes();
    over.hidden = c.extra !== 'thumbs';
    if (c.extra === 'thumbs') paintThumbs();
  }

  // ---- captions on the video ----
  const capEl = h('<div class="sx-cap" aria-hidden="true"><span></span></div>');
  let capRaf = 0;
  const capLoop = () => {
    const P = getP(), t = toolsOf(P).captions;
    capEl.hidden = !t.on || !model.ready;
    capEl.dataset.look = t.look;
    if (!capEl.hidden) {
      const tt = player.time(), ws = model.words;
      const i = ws.findIndex((w) => tt >= w[0] - 0.05 && tt < w[1] + 0.35);
      let text = '';
      if (i >= 0) {
        const start = Math.floor(i / 7) * 7;
        text = ws.slice(start, start + 7).filter((w) => isKept(model.segs, (w[0] + w[1]) / 2)).map((w) => w[2]).join(' ');
      }
      const span = capEl.firstChild;
      if (span.textContent !== text) span.textContent = text;
      capEl.classList.toggle('empty', !text);
    }
    capRaf = requestAnimationFrame(capLoop);
  };
  capRaf = requestAnimationFrame(capLoop);

  // ---- scenes ----
  let scenesAt = 0;
  async function loadScenes(force = false) {
    if (!force && Date.now() - scenesAt < 3000) return;
    scenesAt = Date.now();
    try { scenesDoc = await api(`${base}/scenes`); } catch { scenesDoc = null; }
    const list = scenesDoc?.ready ? scenesDoc.scenes || [] : [];
    st.sceneCount = list.length;
    sceneList.innerHTML = `<h3 class="sx-h">Your scenes</h3>${list.length ? `<ol class="sx-sc">${list.map((s, i) => `<li><button type="button" data-seek="${Number(s.start) || 0}"><b>${i + 1}. ${esc(s.title || `Scene ${i + 1}`)}</b><span class="sub">${esc(String(s.visual || s.layout || '').slice(0, 120))}</span></button></li>`).join('')}</ol>` : '<p class="sub">The scenes show here once the plan is written.</p>'}`;
    wave.update();
    paintCard();
  }
  sceneList.addEventListener('click', (e) => { const b = e.target.closest('[data-seek]'); if (b) player.seek(cutToTake(model.segs, Number(b.dataset.seek))); });
  const cutToTake = (segs, t) => { let d = 0; for (const [a, b] of segs) { if (t <= d + (b - a)) return a + (t - d); d += b - a; } return segs.length ? segs.at(-1)[1] : t; };
  function sceneBlocks() {
    const list = scenesDoc?.ready ? scenesDoc.scenes || [] : [];
    if (!list.length || !model.ready) return [];
    const states = getP().build?.states || {};
    return list.map((s, i) => ({ a: cutToTake(model.segs, Number(s.start) || 0), b: cutToTake(model.segs, Number(s.end) || 0), label: `${i + 1} ${s.title || ''}`.trim(),
      state: states[String(s.id)] || (s.status === 'built' || s.status === 'approved' ? 'built' : '') }));
  }

  // ---- thumbnails (Packaging's six, Codex) ----
  let thumbPoll = 0;
  async function loadThumbs() {
    let v = null;
    try { v = await api(`/api/packaging/${encodeURIComponent(id)}`); } catch (e) { st.thumbs = { state: 'failed', error: e.message }; return; }
    const sheet = v.board?.sheets?.[0];
    if (!sheet) { if (st.thumbs.state === 'running' && v.busy) return; st.thumbs = v.busy ? { state: 'running' } : { state: 'none' }; return; }
    if (sheet.status === 'running' || (v.busy && sheet.status !== 'failed')) { st.thumbs = { ...st.thumbs, state: 'running' }; return; }
    if (sheet.status === 'failed') { st.thumbs = { state: 'failed', error: sheet.failure?.message || 'Codex couldn’t make the thumbnails.' }; return; }
    const items = (v.board.items || []).filter((x) => x.sheet === sheet.id && x.status !== 'rejected').slice(0, 6);
    st.thumbs = { state: items.length ? 'ready' : 'failed', items, picked: st.thumbs.picked && items.some((x) => x.id === st.thumbs.picked) ? st.thumbs.picked : null, error: items.length ? null : 'No thumbnails came back.' };
  }
  function pollThumbs() {
    clearTimeout(thumbPoll);
    const go = async () => { await loadThumbs(); update(); if (st.thumbs.state === 'running') thumbPoll = setTimeout(go, 2500); };
    thumbPoll = setTimeout(go, 1500);
  }
  function paintThumbs() {
    const items = st.thumbs.items || [];
    const sig = JSON.stringify([items.map((x) => x.id), st.thumbs.picked]);
    if (over.dataset.sig === sig) return;
    over.dataset.sig = sig;
    over.innerHTML = `<h3 class="sx-h">${isAudio(getP()) ? 'Covers' : 'Thumbnails'}</h3><div class="sx-thumbs" role="radiogroup" aria-label="Pick one">${items.map((x, i) => `<button type="button" role="radio" class="sx-thumb${x.id === st.thumbs.picked ? ' on' : ''}" aria-checked="${x.id === st.thumbs.picked}" data-thumb="${esc(x.id)}"><img alt="${esc(x.name || `Idea ${i + 1}`)}" src="/api/packaging/${encodeURIComponent(id)}/item/${encodeURIComponent(x.id)}"><span>${esc(x.name || `Idea ${i + 1}`)}</span></button>`).join('')}</div>`;
  }
  over.addEventListener('click', (e) => { const b = e.target.closest('[data-thumb]'); if (!b) return; st.thumbs.picked = b.dataset.thumb; update(); });

  // ================= actions =================
  async function run(stepId) {
    if (st.lastRun && st.lastRun.step === stepId && Date.now() - st.lastRun.at < 8000) return;
    st.lastRun = { step: stepId, at: Date.now() };
    try { await api(`${base}/step`, { step: stepId }); }
    catch (e) { st.lastRun = null; toast(e.message); }
    ctx.softRefresh();
  }
  async function record(sources, text) {
    st.recError = null; st.deleted = null;
    try {
      const ok = await rec.quickRecord({ id, P: getP(), sources });
      if (!ok) return;
    } catch (e) { st.recError = e.message; update(); }
  }
  // The teleprompter follows the take: up from the countdown's end until the take is saving.
  let lastText = '';
  const offRec = rec.onSession((S) => {
    if (S.project !== id) return;
    if (['starting', 'recording'].includes(S.phase) && !document.querySelector('.vt')) {
      openTeleprompter({ id, text: recPage.text() || lastText, sources: S.sources || recPage.sources() });
    }
    if (S.phase === 'idle' && S.landed) { setFlag('kept', false); setFlag('chain', false); setFlag('listened', false); loadTakesSoon(); }
    update();
  });
  // ⌥⌘R (Ctrl+Alt+R): in Simple it starts a take too, on the Record step (the Record page, or Record again after Stop),
  // with the sources and script on the page. While recording, app.js's handler stops it, as in Advanced. Later steps
  // don't start a take from the keyboard: a new take there would replace the one the cut was made from.
  const onRecKey = (e) => {
    if (!rec.isHotkey(e) || e.repeat) return;
    const S = rec.session();
    if (S.phase !== 'idle' || rec.panelIsOpen() || document.querySelector('.vt')) return;
    e.preventDefault();
    if (card().step !== 'record') return toast('Recording is the first step. To record again, tell Claude, or start a new video.');
    st.deleted = null;
    record(sourcesFor(id, getP()), recPage.text());
  };
  document.addEventListener('keydown', onRecKey);
  async function askScript() {
    try { await ctx.chat.send('Write a script for this video and save it as script.md in the project folder: plain paragraphs I can read aloud, no headings. Ask me what the video is about first if you need to.'); }
    catch (e) { toast(e.message); }
  }
  async function takeFile(file) {
    if (!TAKE_FILE.test(file.name)) return toast('Pick a video or a sound file to use as the take.');
    st.deleted = null;
    await ctx.importTakeFile(file);
    loadTakesSoon();
  }
  let takesT = 0;
  function loadTakesSoon() { clearTimeout(takesT); takesT = setTimeout(async () => { st.takes = await listTakes(id); update(); }, 400); }

  async function deleteNow(confirm = false) {
    const take = st.takes.find((t) => t.canvas);
    if (!take) return toast('There’s no take to delete.');
    try {
      const r = await deleteTake(id, take, { confirm });
      if (r.confirm) { st.deleteAsk = r.confirm; return update(); }
      st.deleteAsk = null;
      st.deleted = { ...r, label: `Take ${take.n}${take.duration ? ` (${mmss(take.duration)})` : ''}` };
      setFlag('kept', false);
      await ctx.refresh(); st.takes = await listTakes(id);
    } catch (e) { toast(e.message); }
    update();
  }
  async function spotDecide(keep) {
    const spot = st.spot;
    if (spot && model.ready) {
      const segs = keep ? (spot.keep || [[spot.a, spot.b]]).reduce((s, [a, b]) => restoreRange(s, a, b), model.segs) : (spot.cut || [[spot.a, spot.b]]).reduce((s, [a, b]) => cutRange(s, a, b), model.segs);
      await model.edit(segs);
      try { await api(`${base}/cut-review`, { decisions: { [spot.key]: keep ? 'keep' : 'cut' } }); } catch {}
    }
    setFlag('listened', true); setFlag('chain', true);
    st.spot = null;
    await ctx.refresh();
  }
  async function loadSpot() {
    if (st.spot) return;
    try {
      const r = await api(`${base}/cut-review`);
      const it = (r.items || []).find((x) => x.group === 'ask' && !x.decision);
      st.spot = it ? { key: it.key, a: it.a, b: it.b, keep: it.keep, cut: it.cut, what: it.ask || (it.text ? `“${String(it.text).slice(0, 60)}”` : `at ${mmss(it.a)}`) } : null;
      if (!it) setFlag('listened', true);
    } catch { st.spot = null; }
    update();
  }
  async function exportNow() {
    const P = getP();
    st.exportError = null;
    try {
      if (isAudio(P)) {
        st.audioQueue = ['transcript', 'mp3'];
        await api(`${base}/export-audio`, { format: 'wav', contents: 'mix' });
        st.job = { id: 'export', progress: 0 };
      } else {
        await ctx.exportVideo(exportOptions(P));
        st.job = { id: 'export', progress: 0 };
      }
    } catch (e) { st.exportError = e.message; st.job = null; }
    update();
  }
  // Audio only: after the WAV, the transcript and then the MP3 (each audio export is a job; the next waits for it).
  async function afterExport() {
    while (st.audioQueue.length) {
      const next = st.audioQueue.shift();
      if (next === 'transcript') { try { await api(`${base}/export-text`, { kind: 'transcript', format: 'txt', timecodes: 'none', headings: true, useCut: true }); } catch (e) { toast(e.message); } }
      if (next === 'mp3') { try { await api(`${base}/export-audio`, { format: 'mp3', contents: 'mix' }); st.job = { id: 'export', progress: 0 }; break; } catch (e) { toast(e.message); } }
    }
    await ctx.refresh();
  }

  cardHost.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a],[data-take]');
    if (!b) return;
    const a = b.dataset.a, P = getP();
    if (b.dataset.take) {
      const t = st.takes.find((x) => x.id === b.dataset.take);
      if (!t || t.canvas) return;
      try { await useTake(id, t); await ctx.refresh(); st.takes = await listTakes(id); } catch (err) { toast(err.message); }
      return update();
    }
    if (a === 'dl') return;
    if (['keep', 'again', 'delete', 'rough', 'plan', 'approve', 'build', 'make-thumbs', 'use-thumb', 'skip-thumb', 'export', 'post', 'retry'].includes(a)) b.disabled = true;
    if (a === 'keep') { setFlag('kept', true); setFlag('chain', true); st.deleted = null; await run('prepare'); }
    if (a === 'again' || a === 'record-again') { st.deleted = null; await record(sourcesFor(id, P), recPage.text()); }
    if (a === 'delete') await deleteNow(false);
    if (a === 'delete-yes') await deleteNow(true);
    if (a === 'delete-no') { st.deleteAsk = null; update(); }
    if (a === 'undo-delete' && st.deleted) {
      try { await restoreTake(id, st.deleted); st.deleted = null; await ctx.refresh(); st.takes = await listTakes(id); toast('The take is back.'); }
      catch (err) { toast(`Couldn't bring it back: ${err.message}`); }
      update();
    }
    if (a === 'rough') { setFlag('chain', true); const rc = roughCutState(P, st); if (rc.next) await run(rc.next); }
    if (a === 'listen' && st.spot) { player.seek(Math.max(0, st.spot.a - 1.5)); player.play(); }
    if (a === 'keep-spot') await spotDecide(true);
    if (a === 'cut-spot') await spotDecide(false);
    if (a === 'plan') { const s = P.pipeline.steps.find((x) => x.stage === 'Plan'); if (s) await run(s.id); }
    if (a === 'approve') {
      try { await api(`${base}/plan`, { op: 'approve' }); await ctx.refresh(); const bs = buildIds(getP()); const next = getP().pipeline.steps.find((x) => bs.includes(x.id) && !x.done); if (next) await run(next.id); }
      catch (err) { toast(err.message); }
    }
    if (a === 'change') { st.planChange = true; update(); setTimeout(() => $('#sxChange', cardHost)?.focus(), 30); }
    if (a === 'change-cancel') { st.planChange = false; update(); }
    if (a === 'change-send') {
      const text = $('#sxChange', cardHost)?.value.trim();
      if (!text) return toast('Say what should change first.');
      try { await api(`${base}/plan`, { op: 'changes', text }); st.planChange = false; toast(`Sent to ${who()}.`); } catch (err) { toast(err.message); }
      await ctx.refresh();
    }
    if (a === 'build') { const bs = buildIds(P); const next = P.pipeline.steps.find((x) => bs.includes(x.id) && !x.done); if (next) await run(next.id); }
    if (a === 'make-thumbs') {
      try {
        await api(`/api/packaging/${encodeURIComponent(id)}/title`, { title: P.name });
        await api(`/api/packaging/${encodeURIComponent(id)}/generate`, { brief: isAudio(P) ? `a square podcast cover for the episode "${P.name}"` : `the video "${P.name}"` });
        st.thumbs = { state: 'running' }; pollThumbs();
      } catch (err) { st.thumbs = { state: 'failed', error: err.message }; }
      update();
    }
    if (a === 'use-thumb' && st.thumbs.picked) {
      try { await api(`/api/packaging/${encodeURIComponent(id)}/items/${encodeURIComponent(st.thumbs.picked)}`, { main: true }); st.mainChecked = false; toast('That’s your thumbnail.'); } catch (err) { toast(err.message); }
      await ctx.refresh();
    }
    if (a === 'skip-thumb') {
      clearTimeout(thumbPoll);
      try { await api(`${base}/rail`, { op: 'skip', step: 'package' }); } catch (err) { toast(err.message); }
      await ctx.refresh();
    }
    if (a === 'export') await exportNow();
    if (a === 'mp3') { b.disabled = true; try { await api(`${base}/export-audio`, { format: 'mp3', contents: 'mix' }); st.job = { id: 'export', progress: 0 }; } catch (err) { toast(err.message); } update(); }
    if (a === 'post') { try { await api(`${base}/post-write`, {}); st.posting = true; } catch (err) { toast(err.message); } update(); }
    if (a === 'no-post') { st.postDone = true; update(); }
    if (a === 'retry') { try { await api(`${base}/chat`, { retry: true }); } catch (err) { toast(err.message); } ctx.softRefresh(); }
  });
  const buildIds = (P) => simpleSteps(P.pipeline?.steps || []).find((s) => s.id === 'build')?.run || [];

  // ---- the rough cut runs back to back ----
  function chainOn(P, c) {
    if (c.step !== 'rough-cut') { if (st.chain && roughCutState(P, st).phase === 'done') setFlag('chain', false); return; }
    const rc = roughCutState(P, st);
    if (rc.phase === 'listen') { if (!st.spot) loadSpot(); return; }
    if (rc.phase === 'done') { setFlag('chain', false); return; }
    if (st.chain && rc.phase === 'continue' && !P.busy && rc.next) run(rc.next);
  }

  // ---- drop anything for Claude ----
  async function handleFiles(list) {
    const files = [...list];
    if (!files.length) return;
    const P = getP();
    const noTake = !(P.canvas?.screen || P.canvas?.cam || P.canvas?.audio);
    for (const f of files) {
      // A recording dropped while there's no take yet (or on Record) is the take.
      if (TAKE_FILE.test(f.name) && (noTake || simpleStepNow(P, st) === 'record') && files.length === 1) { await takeFile(f); continue; }
      try {
        const r = await fetch(`${base}/drop?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/octet-stream' }, body: f });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        const last = $('.sx-drop-last', drop);
        last.hidden = false;
        // A picture that isn't a logo by its name asks first ("Is this a photo of you?"); fonts, clips and logos don't.
        const kind = dropKind(j.file), ask = kind && dropAsks(j.file);
        last.innerHTML = `${esc(j.file.split('/').pop())} is with the project.${kind ? ` <button type="button" class="linkish" data-res="${esc(j.file)}" data-kind="${ask ? '' : kind}">Also add to Resources</button>` : ''}`;
        await ctx.chat.send(`I dropped ${j.file} into this project. In one line, tell me what it is and where you'll use it in this video (a time and the words I say there, if it fits). Don't change anything yet.`).catch(() => {});
      } catch (e) { toast(`${f.name} didn’t come in: ${e.message}`); }
    }
  }
  const pick = $('input[type=file]', drop);
  // "Also add to Resources": the dropped file joins Resources too (one copy in the file store; the same bytes twice
  // stay one tile). Fonts, clips and logos (by name) go in as what they are; any other picture asks one question first,
  // "Is this a photo of you?", with the same one-tap answers as Resources' Upload (web/resources-page.js askKind).
  async function addToResources(b) {
    b.disabled = true;
    const last = $('.sx-drop-last', drop), name = b.dataset.res.split('/').pop();
    let kind = b.dataset.kind;
    if (!kind) {
      const box = h('<div class="sx-askkind"></div>');
      last.replaceChildren(box);
      kind = await askKind(box, { name, src: `${base}/media?f=${encodeURIComponent(b.dataset.res)}` });
      if (!kind) { last.textContent = `${name} is with the project.`; return; }
      last.textContent = `Adding ${name} to Resources…`;
    }
    try {
      const r = await api(`/api/simple-resources/upload?project=${encodeURIComponent(id)}&file=${encodeURIComponent(b.dataset.res)}&kind=${encodeURIComponent(kind)}`, {});
      const what = SIMPLE_KINDS[r.kind]?.label.toLowerCase() || 'a file';
      last.innerHTML = r.already ? `${esc(name)} is in Resources already. <a href="#/resources" class="linkish">Open Resources</a>`
        : `${esc(name)} is in Resources too, as ${r.kind === 'photo' ? 'a photo of you' : `your ${esc(what)}`}. <a href="#/resources" class="linkish">Open Resources</a>`;
    } catch (e) { b.disabled = false; if (!b.isConnected) last.textContent = `${name} is with the project.`; toast(`Couldn’t add it to Resources: ${e.message}`); }
  }
  drop.addEventListener('click', (e) => {
    const res = e.target.closest('[data-res]');
    if (res) { e.stopPropagation(); return addToResources(res); }
    if (!e.target.closest('a,button,.sx-askkind')) pick.click();
  });
  drop.addEventListener('keydown', (e) => { if (e.target === drop && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick.click(); } });
  pick.onchange = () => { handleFiles(pick.files); pick.value = ''; };
  const onDragOver = (e) => { if (![...(e.dataTransfer?.types || [])].includes('Files')) return; e.preventDefault(); document.body.classList.add('sx-dragging'); };
  const onDragLeave = (e) => { if (!e.relatedTarget) document.body.classList.remove('sx-dragging'); };
  const onDrop = (e) => {
    if (!e.dataTransfer?.files?.length) return;
    if (e.target.closest?.('textarea, input')) return; // the script box takes a dropped .txt itself
    e.preventDefault(); document.body.classList.remove('sx-dragging');
    handleFiles(e.dataTransfer.files);
  };
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);

  // ================= tools =================
  tools.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tool]')?.dataset.tool;
    if (!t) return;
    toolOpen = toolOpen === t ? null : t;
    paintTool();
  });
  const saveTools = async (patch) => {
    try { const r = await api(`${base}/simple-tools`, patch); getP().simpleTools = r.simpleTools; } catch (e) { toast(e.message); }
    paintTool();
  };
  const askLine = (text) => `<p class="sub sx-askc">or ask ${esc(who())}: <button type="button" class="linkish" data-ask="${esc(text)}">“${esc(text)}”</button></p>`;
  async function paintTool() {
    tools.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-expanded', String(b.dataset.tool === toolOpen)));
    panel.hidden = !toolOpen;
    if (!toolOpen) return;
    const P = getP(), t = toolsOf(P);
    if (toolOpen === 'captions') {
      panel.innerHTML = `<h3 class="sx-h">Captions</h3>
        <label class="sx-row"><span>Captions</span><input type="checkbox" role="switch" data-k="cap-on"${t.captions.on ? ' checked' : ''}></label>
        <div class="seg wide" role="radiogroup" aria-label="Caption look">${Object.entries(CAPTION_LOOKS).map(([k, v]) => `<button type="button" role="radio" data-look="${k}" class="${t.captions.look === k ? 'on' : ''}" aria-checked="${t.captions.look === k}">${v}</button>`).join('')}</div>
        <p class="sub">Burned into the downloaded video.</p>${askLine('Make the captions bigger')}`;
    } else if (toolOpen === 'music') {
      panel.innerHTML = '<h3 class="sx-h">Music</h3><p class="sub">Loading your sound library…</p>';
      if (!sounds) { try { sounds = (await api(`${base}/sound`)).sounds || []; } catch { sounds = []; } }
      if (!mine) await loadMine();
      if (toolOpen !== 'music') return;
      const cur = t.music, on = (f) => cur?.file === f;
      // The three beds made here (no library needed), the creator's own music from Resources, then the library's
      // approved sounds, if any.
      const opts = [...Object.entries(MUSIC_BEDS).map(([k, v]) => ({ bed: k, name: v, on: Boolean(cur && cur.bed === k) })),
        ...mine.map((x) => ({ res: x.id, name: x.name.replace(/\.[a-z0-9]+$/i, ''), on: Boolean(cur && cur.resource === x.id) })),
        ...sounds.slice(0, 9).map((x) => ({ file: x.file, name: x.name, on: on(x.file) && !cur?.bed && !cur?.resource }))];
      panel.innerHTML = `<h3 class="sx-h">Music</h3><div class="sx-list" role="radiogroup" aria-label="Music bed">
        <button type="button" role="radio" data-bed="" class="${cur ? '' : 'on'}" aria-checked="${!cur}">None</button>
        ${opts.map((o) => `<button type="button" role="radio" ${o.bed ? `data-gen="${o.bed}"` : o.res ? `data-mine="${esc(o.res)}"` : `data-bed="${esc(o.file)}"`} data-name="${esc(o.name)}" class="${o.on ? 'on' : ''}" aria-checked="${o.on}">${esc(o.name)}</button>`).join('')}</div>
        <p class="sub sx-own">or <label class="linkish" tabindex="0">add your own<input type="file" accept="${AUDIO_ACCEPT}" hidden data-k="own-music"></label> · a sound file, kept in Resources for every video</p>
        <label class="sx-row"><span>Volume</span><input type="range" min="-24" max="12" step="1" value="${cur?.gain ?? BED_GAIN}" data-k="gain" aria-label="Music volume"${cur ? '' : ' disabled'}></label>
        <p class="sub">Plays under your voice for the whole video. The three above are made on this computer, free to use.</p>${askLine('Add calm music under my voice')}`;
    } else if (toolOpen === 'text') {
      const at = model.ready ? mmss(cutTime(player.time())) : mmss(player.time());
      panel.innerHTML = `<h3 class="sx-h">Text</h3><label class="vh" for="sxTitle">Title text</label><input class="field" id="sxTitle" maxlength="80" placeholder="A title, e.g. “Three steps”">
        <button type="button" class="btn small primary" data-k="add-title">Add at ${at}</button>
        <p class="sub">${esc(who())} adds it to the scene there.</p>${askLine('Add a title at the start')}`;
    } else if (toolOpen === 'effects') {
      panel.innerHTML = `<h3 class="sx-h">Effects</h3>
        <label class="sx-row"><span>Zooms</span><input type="checkbox" role="switch" data-k="zooms"${t.effects.zooms ? ' checked' : ''}></label>
        <div class="seg wide" role="radiogroup" aria-label="Zoom intensity">${Object.entries(INTENSITY).map(([k, v]) => `<button type="button" role="radio" data-int="${k}" class="${Math.abs(t.effects.intensity - Number(k)) < 0.01 ? 'on' : ''}" aria-checked="${Math.abs(t.effects.intensity - Number(k)) < 0.01}"${t.effects.zooms ? '' : ' disabled'}>${v}</button>`).join('')}</div>
        ${askLine('Zoom in on what I click')}`;
    }
  }
  const cutTime = (t) => { let d = 0; for (const [a, b] of model.segs) { if (t < a) return d; if (t <= b) return d + t - a; d += b - a; } return d; };
  panel.addEventListener('change', async (e) => {
    const k = e.target.dataset.k, t = toolsOf(getP());
    if (k === 'cap-on') await saveTools({ captions: { ...t.captions, on: e.target.checked } });
    if (k === 'zooms') await saveTools({ effects: { ...t.effects, zooms: e.target.checked } });
    if (k === 'own-music' && e.target.files?.[0]) {
      // "or add your own": Resources' Upload with the kind set to music, right here; then it plays as this video's bed.
      const f = e.target.files[0];
      e.target.value = '';
      const say = $('.sx-own', panel);
      if (say) say.textContent = `Adding ${f.name}…`;
      try {
        const r = await fetch(`/api/simple-resources/upload?${new URLSearchParams({ name: f.name, kind: 'music' })}`, { method: 'POST', headers: { 'X-Studio': '1' }, body: f });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Could not add ${f.name}.`);
        await loadMine();
        toast(`${f.name} is in Resources, with your music.`);
        await paintTool();
        $(`[data-mine="${CSS.escape(j.id)}"]`, panel)?.click();
      } catch (err) { toast(err.message); paintTool(); }
      return;
    }
    if (k === 'gain' && t.music) {
      const gain = Number(e.target.value);
      try { await api(`${base}/sfx`, { op: 'update', id: t.music.cue, gain }); } catch {}
      await saveTools({ music: { ...t.music, gain } });
    }
  });
  panel.addEventListener('keydown', (e) => {
    const l = e.target.closest?.('label.linkish');
    if (l && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); l.querySelector('input[type=file]')?.click(); }
  });
  panel.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const t = toolsOf(getP());
    if (b.dataset.ask) { if (input) { input.value = b.dataset.ask; input.focus(); input.dispatchEvent(new Event('input')); } return; }
    if (b.dataset.look) await saveTools({ captions: { ...t.captions, look: b.dataset.look } });
    if (b.dataset.int) await saveTools({ effects: { ...t.effects, intensity: Number(b.dataset.int) } });
    if ('bed' in b.dataset || b.dataset.gen || b.dataset.mine) {
      if (b.classList.contains('on')) return;
      panel.querySelectorAll('[role=radio]').forEach((x) => { x.disabled = true; });
      const gain = t.music?.gain ?? BED_GAIN;
      try {
        // A made bed: ffmpeg synthesises it for this video's length first (a few seconds for a long take).
        let file = b.dataset.bed, from = 'library';
        if (b.dataset.gen) {
          b.textContent = `${b.dataset.name} · making it…`;
          file = (await api(`${base}/simple-music`, { bed: b.dataset.gen, seconds: Math.ceil(player.duration() || getP().export?.duration || 60) })).file;
          from = 'project';
        }
        // The creator's own music: its Resources file is copied under this video first (once per file).
        if (b.dataset.mine) { b.textContent = `${b.dataset.name} · adding it…`; file = (await api(`${base}/simple-music`, { resource: b.dataset.mine })).file; from = 'project'; }
        if (t.music?.cue) { try { await api(`${base}/sfx`, { op: 'remove', id: t.music.cue }); } catch {} }
        if (!file) return saveTools({ music: null });
        const at = model.ready && model.segs.length ? model.segs[0][0] : 0;
        const r = await api(`${base}/sfx`, { op: 'add', file, from, t: at, gain, label: `Music: ${b.dataset.name}` });
        await saveTools({ music: { cue: r.id, file, label: b.dataset.name, gain, ...(b.dataset.gen ? { bed: b.dataset.gen } : b.dataset.mine ? { resource: b.dataset.mine } : {}) } });
      } catch (err) { toast(err.message); paintTool(); }
    }
    if (b.dataset.k === 'add-title') {
      const text = $('#sxTitle', panel)?.value.trim();
      if (!text) return toast('Type the title first.');
      const at = mmss(model.ready ? cutTime(player.time()) : player.time());
      try { await ctx.chat.send(`Add the title "${text}" on screen at ${at} of the video.`); toast(`Asked ${who()} to add it at ${at}.`); toolOpen = null; paintTool(); } catch (err) { toast(err.message); }
    }
  });
  const onDocDown = (e) => { if (toolOpen && !tools.contains(e.target)) { toolOpen = null; paintTool(); } };
  document.addEventListener('pointerdown', onDocDown, true);

  // ================= update =================
  let cutSig = '';
  function update() {
    const P = getP();
    ctx.showCanvas(); // a Show me elsewhere never leaves Simple without its video
    // the cut: reload when its files or the take changed
    const sig = JSON.stringify([P.cut?.ready, P.export?.cut?.segments, P.export?.cut?.state, P.canvas]);
    if (sig !== cutSig) { cutSig = sig; model.load(); }
    // B3: the cut is read-only while the lock holds (follows the project, so Unlock to edit and a new lock both show)
    const cutState = P.export?.cut?.state || null;
    if (cutState !== st.cutState && !model.busy) { st.cutState = cutState; model.locked = cutState === 'locked'; transcript.update(); }
    const c = paintCard();
    paintTop(c);
    paintMain(c);
    wave.update();
    chainOn(P, c);
    // Download gives the chosen thumbnail (Packaging's main picture) next to the video.
    if (c.step === 'download' && !st.mainChecked) {
      st.mainChecked = true;
      api(`/api/packaging/${encodeURIComponent(id)}`).then((v) => { const m = (v.board?.items || []).find((x) => x.id === v.board?.main); st.mainThumb = m ? { id: m.id, ext: String(m.ext || 'png').replace(/^\./, '') } : null; update(); }).catch(() => {});
    }
    if (c.step === 'thumbnail' && st.thumbs.state === 'none' && !st.thumbsChecked) { st.thumbsChecked = true; loadThumbs().then(() => { if (st.thumbs.state === 'running') pollThumbs(); update(); }); }
    // Write them: done when the post kit lands, or when Claude's turn ends without it (the chat says why).
    if (st.posting && P.busy) st.postBusy = true;
    if (st.posting && (P.kit?.post?.at || (st.postBusy && !P.busy))) { st.posting = false; st.postBusy = false; st.postDone = true; }
  }
  function onEvent(ev) {
    if (ev.t === 'job' && !ev.quiet && (ev.id === 'export' || ev.kind === 'audio')) {
      if (ev.done) {
        st.job = null;
        if (!ev.ok && !ev.replay) st.exportError = ev.label || 'The export stopped.';
        else if (!ev.replay) afterExport();
      } else st.job = ev;
      update();
    }
    if (ev.t === 'files' || ev.t === 'busy') { recPage.reload(); if (getP().pipeline) loadScenes(); }
  }
  st.takes = [];
  listTakes(id).then((t) => { st.takes = t; update(); });
  update();

  return {
    update,
    onEvent,
    destroy() {
      offRec(); cancelAnimationFrame(capRaf); clearTimeout(thumbPoll); clearTimeout(takesT);
      document.removeEventListener('dragover', onDragOver); document.removeEventListener('dragleave', onDragLeave); document.removeEventListener('drop', onDrop);
      document.removeEventListener('pointerdown', onDocDown, true); document.removeEventListener('keydown', onRecKey);
      wave.destroy(); transcript.destroy(); recPage.destroy(); prog.remove(); dl.remove();
      document.body.classList.remove('simple-editor', 'sx-dragging');
    },
  };
}

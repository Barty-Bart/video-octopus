// Export kinds next to the MP4 in the Export panel (the Renders tab's inspector):
// Video · Audio · Transcript · Subtitles · Layers · Timeline file.
// Layers renders every layer as its own file (server/export-layers.mjs) with a README, timeline files and the
// motion data; Timeline file writes the FCPXML and Premiere XML straight from the sources. Their folders show as
// cards on the Renders tab. Audio (server/export-audio.mjs), Transcript and Subtitles (server/export-text.mjs) work on
// the final timeline too; their files show as cards on the Renders tab, and the Video panel can burn the captions in.
import { $, esc, h, api, toast, ago, clock, fileManager, cutWord } from './ui.js';

const KINDS = [['video', 'Video'], ['audio', 'Audio'], ['transcript', 'Transcript'], ['subtitles', 'Subtitles'], ['layers', 'Layers'], ['timeline', 'Timeline file']];
const TEXT_KINDS = new Set(['audio', 'transcript', 'subtitles']);
const ICON_AUDIO = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M2 9h1.5M5 6v6M8 3v12M11 5.5v7M14 7.5v3M16 9h0"/></svg>';
const ICON_TEXT = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 4h12M3 7.5h12M3 11h12M3 14.5h7"/></svg>';
const ICON_CC = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="2" y="3.5" width="14" height="11" rx="2"/><path d="M8 7.6a1.9 1.9 0 1 0 0 2.8M13 7.6a1.9 1.9 0 1 0 0 2.8"/></svg>';
const KIND_ICON = { audio: ICON_AUDIO, transcript: ICON_TEXT, subtitles: ICON_CC };
const remember = (key, defaults) => { try { return { ...defaults, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return { ...defaults }; } };
const keep = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} };
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const t = document.createElement('textarea');
  t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
  document.body.append(t); t.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  t.remove();
  return ok;
}
const ICON_STACK = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2 16 5.5 9 9 2 5.5z"/><path d="m2 9 7 3.5L16 9"/><path d="m2 12.5 7 3.5 7-3.5"/></svg>';
const ICON_TL = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="2" y="3" width="9" height="3" rx="1"/><rect x="5" y="7.5" width="11" height="3" rx="1"/><rect x="2" y="12" width="6" height="3" rx="1"/></svg>';
const size = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

export function makeExportKinds({ id, getP, canvas, job, rerender, useCut }) {
  let kind = 'video';
  try { kind = localStorage.getItem('studio.export.kind') || 'video'; } catch {}
  if (!KINDS.some(([k]) => k === kind)) kind = 'video';
  const opt = { graphics: true, separate: false, matte: true, small: false, timeline: true };
  let cut = null; // null = follow the Video panel's choice
  let info = null, loading = false, infoAt = 0;
  const base = `/api/projects/${encodeURIComponent(id)}`;

  // ---- Audio · Transcript · Subtitles: all on the final timeline (locked cut, blocks in order, sponsor-read files) ----
  const aud = remember('studio.export.audio', { format: 'wav', contents: 'mix', loudness: 0 });
  const trs = remember('studio.export.transcript', { format: 'txt', timecodes: 'none', headings: true });
  const sub = remember('studio.export.subtitles', { format: 'srt', maxChars: 42, maxLines: 2, maxDur: 6, minGap: 0.1, pauses: true });
  let burn = false; // the Video panel's "Burn captions into the video": off each time the page opens
  let audInfo = null, audAt = 0, audSig = '';
  const prevs = { transcript: { sig: '', data: null, loading: false, error: null }, subtitles: { sig: '', data: null, loading: false, error: null } };
  const lenOn = () => (cut ?? useCut()) && Boolean(getP().export.cut);

  async function loadAudio(force) {
    const sig = String(lenOn());
    if (!force && audInfo && sig === audSig && Date.now() - audAt < 4000) return;
    audSig = sig; audAt = Date.now();
    try { audInfo = await api(`${base}/export-audio?useCut=${lenOn() ? 1 : 0}`); } catch (e) { audInfo = { error: e.message }; }
    rerender();
  }
  const textQuery = () => {
    const o = kind === 'transcript' ? { kind, ...trs, headings: trs.headings ? 1 : 0 } : { kind, ...sub, pauses: sub.pauses ? 1 : 0 };
    return new URLSearchParams({ ...o, useCut: lenOn() ? 1 : 0 }).toString();
  };
  async function loadPreview(force) {
    const prev = prevs[kind], k = kind, sig = textQuery();
    if (!prev || (!force && (prev.sig === sig || prev.loading))) return;
    prev.sig = sig; prev.loading = true;
    try { prev.data = await api(`${base}/export-text?${sig}`); prev.error = null; } catch (e) { prev.error = e.message; prev.data = null; }
    prev.loading = false;
    if (kind !== k) return;
    if (prev.sig === textQuery()) rerender(); else loadPreview();
  }

  const radio = (name, value, cur, label, small) => `<label class="ex-opt"><input type="radio" name="${name}" value="${value}"${value === cur ? ' checked' : ''}><span><b>${label}</b>${small ? `<small>${small}</small>` : ''}</span></label>`;
  const seg = (key, cur, opts, label) => `<div class="seg wide xt-seg" role="radiogroup" aria-label="${label}">${opts.map(([v, l]) => `<button type="button" role="radio" aria-checked="${String(v) === String(cur)}" class="${String(v) === String(cur) ? 'on' : ''}" data-s="${key}" data-v="${v}">${l}</button>`).join('')}</div>`;
  const num = (key, v, min, max, step, label, unit) => `<label class="xt-num"><span>${label}</span><span class="xt-in"><input type="number" data-n="${key}" value="${v}" min="${min}" max="${max}" step="${step}" inputmode="decimal">${unit ? `<i>${unit}</i>` : ''}</span></label>`;
  const timelineFacts = (d) => {
    if (!d) return '';
    const parts = d.parts || [];
    return `<dt>Timeline</dt><dd class="plain">${clock(d.total ?? d.duration)}${parts.length > 1 ? ` · ${parts.length} parts in order: ${parts.map((p) => esc(p.name)).join(' · ')}` : d.cut ? ' · locked cut' : ' · whole take'}</dd>`;
  };

  function finalPanel(box) {
    const P = getP(), x = P.export, j = running();
    const busy = Boolean(j && !j.done);
    let body = '', go = '', can = Boolean(x.duration);
    if (kind === 'audio') {
      loadAudio(false);
      const a = audInfo && !audInfo.error ? audInfo : null;
      const fmtKey = { wav: 'wav', aac: 'aac', mp3: 'mp3' }[aud.format] || 'wav';
      const sounds = [x.audio === 'cam' ? 'camera mic' : x.audio === 'screen' ? 'screen sound' : null, a?.layers ? `${a.layers} layer${a.layers > 1 ? 's' : ''} with sound` : null].filter(Boolean).join(' + ') || 'no sound';
      const cues = a?.cues ?? P.kit?.cues ?? 0;
      body = `<section><h3>Format</h3>
          ${radio('xaf', 'wav', fmtKey, 'Lossless WAV', '24-bit · 48 kHz · stereo, for editing and mastering')}
          ${radio('xaf', 'aac', fmtKey, 'AAC (.m4a)', '256 kbps, the same encoder as the video; small')}
          ${radio('xaf', 'mp3', fmtKey, 'MP3', '320 kbps, plays everywhere (podcast hosts)')}</section>
        <section><h3>What goes in</h3>
          ${radio('xac', 'mix', aud.contents, 'Full mix', `${esc(sounds)}${cues ? ` + ${cues} sound cue${cues > 1 ? 's' : ''} under the voice` : ''}, exactly as the video mixes it`)}
          ${radio('xac', 'voice', aud.contents, 'Voice only', `${esc(sounds)}, cut like the video, no sound cues`)}</section>
        ${lengthHTML(x, lenOn())}
        <section><h3>Loudness</h3>${seg('loudness', aud.loudness, [[0, 'Off'], [-14, '−14 LUFS'], [-16, '−16 LUFS']], 'Loudness')}
          <p class="sub xt-note">${aud.loudness ? `${aud.loudness === -14 ? 'YouTube’s level.' : 'The podcast level.'} Measured over the whole mix, gained to ${aud.loudness === -14 ? '−14' : '−16'} LUFS, peaks limited to −1 dBFS.` : 'The mix’s own level, the same as the video. −14 LUFS for YouTube, −16 for podcasts.'}</p></section>
        <section><dl class="facts">${timelineFacts(a)}<dt>File</dt><dd>${esc(a?.next?.[`${aud.contents}.${fmtKey}`] || 'renders/…')}</dd></dl>
          ${audInfo?.error ? `<p class="sub lx-warn">${esc(audInfo.error)}</p>` : ''}</section>`;
      can = can && Boolean(a) && !a.error;
      go = `<button class="btn dark wide big" id="xtGo"${can && !busy ? '' : ' disabled'}>${ICON_AUDIO}${busy ? 'Exporting…' : 'Export audio'}</button>`;
    } else {
      loadPreview(false);
      const prev = prevs[kind], d = prev.data;
      const st = d?.stats || {};
      const missing = (d?.missing || []).map((m) => `<p class="sub lx-warn xt-miss">${esc(m.label)} (${esc(m.file.replace(/^source\//, ''))}) has no transcript yet, so it’s left out. <button class="btn small" data-tr="${esc(m.id)}">Transcribe it with Claude</button></p>`).join('');
      const src = d ? `<dt>Words</dt><dd class="plain">${st.words || 0} from ${d.files?.length ? d.files.map((f) => `<code>${esc(f)}</code>`).join(' + ') : 'no transcript'}</dd>` : '';
      if (kind === 'transcript') {
        body = `<section><h3>Format</h3>${seg('format', trs.format, [['txt', 'Plain text'], ['md', 'Markdown']], 'Format')}</section>
          <section><h3>Timecodes</h3>${seg('timecodes', trs.timecodes, [['none', 'None'], ['paragraph', 'Paragraphs'], ['sentence', 'Sentences']], 'Timecodes')}</section>
          <section class="xt-tight"><label class="ex-opt${d && !d.sections?.length ? ' lx-opt off' : ''}"><input type="checkbox" data-c="headings"${trs.headings && (!d || d.sections?.length) ? ' checked' : ''}${d && !d.sections?.length ? ' disabled' : ''}><span><b>Section headings</b><small>${d?.sections?.length ? d.sections.map((x) => esc(x.label)).join(' · ') : 'From the blocks, once the sections are marked'}</small></span></label></section>
          ${lengthHTML(x, lenOn())}`;
      } else {
        body = `<section><h3>Format</h3>${seg('format', sub.format, [['srt', 'SRT'], ['vtt', 'WebVTT']], 'Format')}</section>
          <section><h3>Lines</h3><div class="xt-grid">
            ${num('maxChars', sub.maxChars, 10, 80, 1, 'Characters per line', '')}
            <div class="xt-num"><span>Lines</span>${seg('maxLines', sub.maxLines, [[1, '1'], [2, '2']], 'Lines per cue')}</div>
            ${num('maxDur', sub.maxDur, 1, 20, 0.5, 'Longest cue', 's')}
            ${num('minGap', sub.minGap, 0, 1, 0.05, 'Gap between cues', 's')}</div>
            <label class="ex-opt"><input type="checkbox" data-c="pauses"${sub.pauses ? ' checked' : ''}><span><b>Split on pauses and sentence ends</b><small>A new cue after a pause over 0.6 s and after each sentence</small></span></label></section>
          ${lengthHTML(x, lenOn())}`;
      }
      const stats = kind === 'subtitles' && d ? `<dt>Cues</dt><dd class="plain">${st.cues || 0}${st.cues ? ` · longest line ${st.longestLine} of ${sub.maxChars} characters · ${st.lines} line${st.lines > 1 ? 's' : ''} at most` : ''}</dd>` : '';
      body += `<section><h3>Preview</h3>${prev.error ? `<p class="sub lx-warn">${esc(prev.error)}</p>` : `<pre class="xt-prev ${kind === 'subtitles' ? 'cues' : 'prose'}${d ? '' : ' loading'}" tabindex="0" aria-label="Preview">${d ? esc(d.text.slice(0, 6000)) || '(no words on this timeline)' : 'Reading the words…'}</pre>`}
          ${missing}<dl class="facts xt-facts">${timelineFacts(d)}${src}${stats}<dt>File</dt><dd>${esc(d?.next || 'renders/…')}</dd></dl>
          ${kind === 'subtitles' ? '<p class="sub">To burn them into the picture: Video → Captions (uses these settings).</p>' : ''}</section>`;
      can = Boolean(d?.text);
      go = `<div class="xt-go"><button class="btn dark big" id="xtGo"${can ? '' : ' disabled'}>${KIND_ICON[kind]}Save to renders/</button><button class="btn big" id="xtCopy"${can ? '' : ' disabled'}>Copy</button></div>`;
    }
    box.replaceChildren(h(`<div class="ins-body ex lx xt">
      <div class="ins-head"><b>Export</b><span class="sub">${kind === 'audio' ? 'renders on this computer' : 'on the final timeline'}</span></div>
      ${body}
      ${kind === 'audio' ? progressHTML(j) : ''}
      <section class="ex-go">${go}
        ${x.duration ? '' : '<p class="sub">Add a recording first.</p>'}</section></div>`));
    picker(box);
    const save = () => { keep('studio.export.audio', aud); keep('studio.export.transcript', trs); keep('studio.export.subtitles', sub); };
    const opts = kind === 'audio' ? aud : kind === 'transcript' ? trs : sub;
    box.querySelectorAll('input[name=exklen]').forEach((r) => (r.onchange = () => { cut = r.value === 'cut'; if (kind === 'audio') loadAudio(true); else loadPreview(true); rerender(); }));
    box.querySelectorAll('input[name=xaf]').forEach((r) => (r.onchange = () => { aud.format = r.value; save(); rerender(); }));
    box.querySelectorAll('input[name=xac]').forEach((r) => (r.onchange = () => { aud.contents = r.value; save(); rerender(); }));
    box.querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => {
      const v = b.dataset.v;
      opts[b.dataset.s] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
      save(); rerender();
    }));
    box.querySelectorAll('input[data-c]').forEach((c) => (c.onchange = () => { opts[c.dataset.c] = c.checked; save(); rerender(); }));
    box.querySelectorAll('input[data-n]').forEach((n) => (n.onchange = () => {
      const v = Number(n.value);
      if (!Number.isFinite(v)) return;
      opts[n.dataset.n] = Math.min(Number(n.max), Math.max(Number(n.min), v));
      save(); rerender();
    }));
    box.querySelectorAll('[data-tr]').forEach((b) => (b.onclick = async () => {
      const m = (prevs[kind].data?.missing || []).find((x) => x.id === b.dataset.tr);
      if (!m) return;
      b.disabled = true;
      const folder = m.want.replace(/\/words\.json$/, '');
      try {
        await api(`${base}/chat`, { text: `Transcribe the ${m.label} block's own file, ${m.file}, with the transcribe skill into ${folder}/ (words.json and the SRT), the same way as the take. Video Octopus's Transcript and Subtitles exports read it from ${m.want}.` });
        toast('Sent to Claude. The preview picks the words up when they land.');
      } catch (e) { toast(e.message); b.disabled = false; }
    }));
    $('#exStop', box) && ($('#exStop', box).onclick = () => api(`${base}/export-stop`, {}));
    $('#xtCopy', box) && ($('#xtCopy', box).onclick = async () => {
      const d = prevs[kind].data;
      toast((await copyText(d?.text || '')) ? `Copied the ${kind === 'transcript' ? 'transcript' : 'subtitles'} (${kind === 'transcript' ? `${d.stats.words} words` : `${d.stats.cues} cues`}).` : 'Couldn’t reach the clipboard.');
    });
    $('#xtGo', box).onclick = async () => {
      $('#xtGo', box).disabled = true;
      try {
        if (kind === 'audio') {
          await api(`${base}/export-audio`, { format: aud.format, contents: aud.contents, loudness: aud.loudness || null, useCut: lenOn(), layout: canvas.ready() ? canvas.layout() : undefined });
        } else {
          const r = await api(`${base}/export-text`, { kind, ...(kind === 'transcript' ? trs : sub), useCut: lenOn() });
          toast(`Saved ${r.file}. It's on the Renders tab.`);
          prevs[kind].sig = '';
        }
      } catch (e) { toast(e.message); $('#xtGo', box).disabled = false; }
    };
  }

  // The Video panel's captions option (app.js puts it under "What goes in" and sends captions() with the export).
  function captionsHTML(aspect) {
    return `<section class="xt-burn"><h3>Captions</h3><label class="ex-opt"><input type="checkbox" id="exBurn"${burn ? ' checked' : ''}><span><b>Burn captions into the video</b>
      <small>Geist, white with a soft shadow, ${aspect === '9:16' ? 'above the Shorts buttons and captions (safe zone)' : 'low in the frame, inside the safe area'}. Lines from the Subtitles settings: ${sub.maxChars} characters × ${sub.maxLines} line${sub.maxLines > 1 ? 's' : ''}${aspect === '9:16' ? ' (fewer when the line is too wide for the frame)' : ''}.</small></span></label></section>`;
  }
  function wireCaptions(box) { const c = $('#exBurn', box); if (c) c.onchange = () => { burn = c.checked; }; }
  const captions = () => (burn ? { ...sub } : null);

  async function load(force) {
    if (loading || (!force && info && Date.now() - infoAt < 4000)) return;
    loading = true;
    try { info = await api(`${base}/export-kinds`); infoAt = Date.now(); } catch (e) { info = { error: e.message }; }
    loading = false;
    rerender();
  }

  // The segmented picker, under the panel's heading (the Video panel calls this too).
  function picker(box) {
    const head = $('.ins-head', box);
    if (!head || $('.exk', box)) return;
    const seg = h(`<div class="seg wide exk" role="radiogroup" aria-label="What to export">${KINDS.map(([k, l]) => `<button type="button" role="radio" aria-checked="${k === kind}" class="${k === kind ? 'on' : ''}" data-k="${k}">${l}</button>`).join('')}</div>`);
    head.after(h('<section class="exk-wrap"></section>'));
    $('.exk-wrap', box).append(seg);
    seg.querySelectorAll('button').forEach((b) => (b.onclick = () => {
      kind = b.dataset.k;
      try { localStorage.setItem('studio.export.kind', kind); } catch {}
      if (kind !== 'video') load(true);
      rerender();
    }));
  }

  // The running export's job, whichever kind started it (the app's jobs map, replayed when the page opens mid-export).
  const running = () => job() || null;

  function progressHTML(j) {
    if (!j) return '';
    const rows = (j.layers || []).map((l) => `<li class="${l.state || ''}"><span class="lx-n">${esc(l.name)}</span><i><b style="width:${Math.round((l.progress || 0) * 100)}%"></b></i><span class="lx-p">${l.state === 'done' ? '✓' : `${Math.round((l.progress || 0) * 100)}%`}</span></li>`).join('');
    return `<section><div class="ex-job" role="status"><div class="ex-job-top"><span class="dot" aria-hidden="true"></span><b>${esc(j.label)}</b>${j.cancel ? '<button class="btn small" id="exStop">Stop</button>' : ''}</div>
      <i><b style="width:${Math.round((j.progress || 0) * 100)}%"></b></i><span class="sub">${Math.round((j.progress || 0) * 100)}%</span>
      ${rows ? `<ul class="lx-prog" aria-label="Progress per layer">${rows}</ul>` : ''}</div></section>`;
  }

  const lengthHTML = (x, on) => `<section><h3>Length</h3>
    ${x.cut ? `<label class="ex-opt"><input type="radio" name="exklen" value="cut"${on ? ' checked' : ''}><span><b>${esc(cutWord(x.cut))}</b><small>${esc(x.cut.file)} · ${x.cut.count} part${x.cut.count > 1 ? 's' : ''} · ${clock(x.cut.duration)}</small></span></label>` : ''}
    <label class="ex-opt"><input type="radio" name="exklen" value="whole"${on ? '' : ' checked'}><span><b>Whole take</b><small>${x.duration ? clock(x.duration) : 'no recording yet'}</small></span></label></section>`;
  const check = (key, label, small, { disabled = false } = {}) => `<label class="ex-opt lx-opt${disabled ? ' off' : ''}"><input type="checkbox" data-o="${key}"${opt[key] && !disabled ? ' checked' : ''}${disabled ? ' disabled' : ''}><span><b>${label}</b><small>${small}</small></span></label>`;

  // Returns true when it drew the panel (Audio, Transcript, Subtitles, Layers or Timeline file); false leaves the Video
  // panel to app.js.
  function panel(box) {
    if (kind === 'video') return false;
    if (TEXT_KINDS.has(kind)) { finalPanel(box); return true; }
    if (!info || info.error) load(false);
    const P = getP(), x = P.export, j = running();
    const on = (cut ?? useCut()) && Boolean(x.cut);
    const ready = canvas.ready(), sc = ready ? canvas.scene() : null;
    const i = info && !info.error ? info : null;
    const scene = i?.scene;
    const busy = Boolean(j && !j.done);
    let body = '';
    if (kind === 'layers') {
      const cards = sc ? sc.layers.map((l) => (l.role === 'screen' ? 'Screen' : l.role === 'cam' ? 'Camera' : `Layer ${l.file}`)) : [];
      const list = [
        sc?.bgVisible ? `Background${['stars', 'led', 'code'].includes(sc.bg.kind) ? ' (drawn frame by frame)' : ''}` : null,
        ...cards.map((c) => `${c}${sc.layers.some((l) => l.card) ? ' card' : ''}`),
        scene && opt.graphics ? (opt.separate ? `Graphics: every element of ${esc(scene.file)} on its own` : `Graphics: ${scene.layers.map((l) => (l == null ? 'the scene' : esc(l))).join(', ')}`) : null,
        i?.masks && opt.matte ? 'Presenter cut-out' : null,
        x.audio ? 'Voice (WAV)' : null,
        i?.cues ? `Sound cues (WAV, ${i.cues})` : null,
      ].filter(Boolean);
      body = `${lengthHTML(x, on)}
        <section><h3>Files</h3><ol class="lx-list">${list.map((l) => `<li>${l}</li>`).join('')}</ol>
          <p class="sub">Each a file from 0:00, all the same length, ${sc ? `${sc.W} × ${sc.H}` : ''} at 30 fps: stack them in this order. Transparent layers are ProRes 4444 with alpha.</p></section>
        <section><h3>Options</h3>
          ${check('graphics', 'Graphics layers', scene ? `${esc(scene.file)}${scene.layers.length > 1 ? `, ${scene.layers.length} layers` : ''}` : 'No scene HTML in this project', { disabled: !scene })}
          ${check('separate', 'Separate every graphic', scene?.kit ? 'Each title, card and window as its own file. Slower: the scene is drawn once more per element.' : 'Needs a scene drawn through the scene kit', { disabled: !scene?.kit || !opt.graphics })}
          ${check('matte', 'Presenter cut-out', i?.masks ? `From the matte in ${esc(i.masks.dir)}/ (${i.masks.count} frames)` : 'No matte (masks folder) for this camera', { disabled: !i?.masks })}
          ${check('small', 'Smaller files', 'H.264 for the layers with no transparency, instead of ProRes 422 HQ')}
          ${check('timeline', 'Timeline files', 'FCPXML for Final Cut Pro and Resolve, XML for Premiere Pro. Import untested.')}
        </section>
        <section><dl class="facts"><dt>Folder</dt><dd>${esc(i?.next.layers || 'renders/…')}/</dd>${P.blocks?.parts ? '' : ''}${typeof i?.blocks === 'number' ? `<dt>Blocks</dt><dd class="plain">${i.blocks} parts, in order</dd>` : ''}</dl>
          <p class="sub">ProRes is big: about 1–4 GB a minute per layer. Also writes motion.json (graphics elements, times, boxes) and a README.</p></section>`;
    } else {
      body = `${lengthHTML(x, on)}
        <section><h3>What you get</h3><ul class="lx-list plain">
          <li><b>FCPXML 1.10</b> · Final Cut Pro, DaVinci Resolve</li>
          <li><b>Final Cut Pro 7 XML</b> · Premiere Pro, DaVinci Resolve</li>
          ${scene ? '<li><b>motion.json</b> · the graphics elements, their times and boxes</li>' : ''}
          <li><b>README.txt</b></li></ul>
          <p class="sub">Straight from the sources, nothing rendered: the screen and camera recordings at full frame (the editor places them), the cut as separate clips with the gaps closed, blocks in order, sound cues at their times and levels, at the camera's own frame rate. For the layout, background and graphics as files, use Layers: it writes these timeline files too.</p>
          <p class="sub lx-warn">Import into Final Cut, Premiere and Resolve isn't tested yet. Both files follow Apple's formats and are checked with xmllint.</p></section>
        <section><dl class="facts"><dt>Folder</dt><dd>${esc(i?.next.timeline || 'renders/…')}/</dd></dl></section>`;
    }
    const can = kind === 'timeline' ? Boolean(x.duration) : ready;
    box.replaceChildren(h(`<div class="ins-body ex lx">
      <div class="ins-head"><b>Export</b><span class="sub">renders on this computer</span></div>
      ${body}
      ${progressHTML(j)}
      <section class="ex-go">
        <button class="btn dark wide big" id="lxGo"${can && !busy ? '' : ' disabled'}>${ICON_STACK}${busy ? 'Exporting…' : kind === 'layers' ? 'Export layers' : 'Write timeline file'}</button>
        ${can ? '' : '<p class="sub">Add a recording first, and wait until its playback copies are ready.</p>'}
      </section></div>`));
    picker(box);
    box.querySelectorAll('input[name=exklen]').forEach((r) => (r.onchange = () => { cut = r.value === 'cut'; }));
    box.querySelectorAll('input[data-o]').forEach((c) => (c.onchange = () => { opt[c.dataset.o] = c.checked; rerender(); }));
    $('#exStop', box) && ($('#exStop', box).onclick = () => api(`${base}/export-stop`, {}));
    $('#lxGo', box).onclick = async () => {
      $('#lxGo', box).disabled = true;
      const len = (cut ?? useCut()) && Boolean(getP().export.cut);
      try {
        if (kind === 'layers') {
          if (!canvas.ready()) throw new Error('Add a recording first, and wait until its playback copies are ready.');
          await api(`${base}/export-layers`, { layout: canvas.layout(), useCut: len, pngs: { ...canvas.layerPngs(), looks: canvas.lookPngs?.(canvas.layout(), true) || {} }, ...opt, graphics: opt.graphics && Boolean(scene), separate: opt.separate && opt.graphics && Boolean(scene?.kit), matte: opt.matte && Boolean(i?.masks) });
        } else await api(`${base}/export-timeline`, { layout: canvas.layout(), useCut: len });
      } catch (e) { toast(e.message); $('#lxGo', box).disabled = false; }
    };
    return true;
  }

  // Cards on the Renders tab: one per layers or timeline folder in renders/, and one per audio, transcript or
  // subtitle file.
  function cards() {
    const a = layerCards(), b = fileCards();
    if (!a || !b) return a || b;
    const wrap = h('<div class="lx-cards"></div>');
    wrap.append(a, b);
    return wrap;
  }
  let playing = null; // the audio card that's playing: { file, audio }
  function fileCards() {
    const list = getP().textExports || [];
    if (!list.length) return null;
    const media = (f) => `${base}/media?f=${encodeURIComponent(f)}`;
    const what = (x) => (x.kind === 'audio' ? `${x.contents === 'voice' ? 'Voice only' : 'Full mix'} · ${{ wav: 'WAV', m4a: 'AAC', mp3: 'MP3' }[x.ext]}${x.duration ? ` · ${clock(x.duration)}` : ''}`
      : x.kind === 'subtitles' ? `${x.ext.toUpperCase()} · ${x.count ?? '?'} cues` : `${x.ext === 'md' ? 'Markdown' : 'Plain text'} · ${x.count ?? '?'} words`);
    const el = h(`<div class="lx-cards">
      <div class="rd-head"><b>Audio, transcripts and subtitles</b><span class="sub">files in renders/, all on the final timeline</span></div>
      <div class="lx-grid">${list.map((x) => `<div class="lx-card xt-card">
        <span class="lx-ic ${x.kind}">${KIND_ICON[x.kind]}</span>
        <span class="lx-tx"><span class="lx-top"><b>${x.kind === 'audio' ? 'Audio' : x.kind === 'subtitles' ? 'Subtitles' : 'Transcript'} v${esc(/_v(\d+)\.\w+$/.exec(x.name)?.[1] || '?')}</b><span class="lx-dir" title="${esc(x.file)}">${esc(x.name.startsWith(`${id}_`) ? x.name.slice(id.length + 1) : x.name)}</span></span>
          <span class="sub">${what(x)} · ${x.bytes < 1e6 ? `${Math.max(1, Math.round(x.bytes / 1e3))} KB` : size(x.bytes)} · ${ago(x.at)}</span></span>
        <span class="xt-acts">${x.kind === 'audio' ? `<button class="btn small" data-play="${esc(x.file)}" aria-pressed="${playing?.file === x.file}">${playing?.file === x.file ? 'Pause' : 'Play'}</button>` : `<button class="btn small" data-copy="${esc(x.file)}">Copy</button>`}
          <button class="btn small" data-f="${esc(x.file)}" title="Show in ${fileManager()}" aria-label="Show ${esc(x.name)} in ${fileManager()}">${fileManager(true)}</button></span></div>`).join('')}</div></div>`);
    el.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => api(`${base}/reveal`, { file: b.dataset.f })));
    el.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async () => {
      try {
        const r = await fetch(media(b.dataset.copy), { cache: 'no-store' });
        toast((await copyText(await r.text())) ? `Copied ${b.dataset.copy.replace('renders/', '')}.` : 'Couldn’t reach the clipboard.');
      } catch (e) { toast(e.message); }
    }));
    el.querySelectorAll('[data-play]').forEach((b) => (b.onclick = () => {
      const f = b.dataset.play;
      if (playing?.file === f) { playing.audio.pause(); playing = null; b.textContent = 'Play'; b.setAttribute('aria-pressed', 'false'); return; }
      playing?.audio.pause();
      el.querySelectorAll('[data-play]').forEach((o) => { o.textContent = 'Play'; o.setAttribute('aria-pressed', 'false'); });
      const audio = new Audio(media(f));
      playing = { file: f, audio };
      audio.onended = () => { if (playing?.audio === audio) playing = null; b.textContent = 'Play'; b.setAttribute('aria-pressed', 'false'); };
      audio.play().catch((e) => toast(e.message));
      b.textContent = 'Pause'; b.setAttribute('aria-pressed', 'true');
    }));
    return el;
  }
  function layerCards() {
    const list = getP().layerExports || [];
    if (!list.length) return null;
    const el = h(`<div class="lx-cards">
      <div class="rd-head"><b>Layers and timeline files</b><span class="sub">folders in renders/ for other editors</span></div>
      <div class="lx-grid">${list.map((x) => `<div class="lx-card">
        <span class="lx-ic ${x.kind}">${x.kind === 'layers' ? ICON_STACK : ICON_TL}</span>
        <span class="lx-tx"><span class="lx-top"><b>${x.kind === 'layers' ? 'Layers' : 'Timeline file'} v${esc(/_v(\d+)$/.exec(x.name)?.[1] || '?')}</b><span class="lx-dir" title="${esc(x.folder)}">${esc(x.folder)}/</span></span>
          <span class="sub">${x.kind === 'layers' ? `${x.video} video layer${x.video === 1 ? '' : 's'}${x.audio ? ` + ${x.audio} sound${x.audio === 1 ? '' : 's'}` : ''}` : `${x.video} video + ${x.audio} sound track${x.audio === 1 ? '' : 's'}`}${x.duration ? ` · ${clock(x.duration)}` : ''}${x.fps ? ` · ${x.fps === '30000/1001' ? '29.97' : x.fps.replace('/1', '')} fps` : ''} · ${size(x.bytes)} · ${ago(x.at)}</span>
          ${x.timeline ? '<span class="sub">FCPXML + Premiere XML (import untested)</span>' : ''}</span>
        <button class="btn small" data-f="${esc(x.folder)}">Show in ${fileManager()}</button></div>`).join('')}</div></div>`);
    el.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => api(`${base}/reveal`, { file: `${b.dataset.f}/README.txt` })));
    return el;
  }

  function finished(ev, show) {
    toast(`${ev.label}${ev.kind === 'audio' && ev.loudness?.i != null ? ` (${String(ev.loudness.i.toFixed(1)).replace('-', '−')} LUFS)` : ''}. It's on the Renders tab.`);
    info = null; audInfo = null;
    show();
  }

  return { panel, picker, cards, finished, kind: () => kind, captionsHTML, wireCaptions, captions };
}

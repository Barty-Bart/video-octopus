import { environmentPicker } from './setup-environments.js';
import { TERMS } from './terms.js';
// First-time setup checks local tools, then offers skippable database-backed brand profiles.
import { $, esc, h, api, toast, confirmBox } from './ui.js';
import { support, browserName } from './recorder.js';
import { profileSettings } from './profiles.js';

const MARK = {
  ok: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8.5" class="m-ok"/><path d="M5.4 9.3l2.3 2.3 4.9-5" class="m-tick"/></svg>',
  warn: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8.5" class="m-warn"/><path d="M9 5v5M9 12.6v.1" class="m-tick"/></svg>',
  fail: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8.5" class="m-fail"/><path d="M6.2 6.2l5.6 5.6M11.8 6.2l-5.6 5.6" class="m-tick"/></svg>',
  skip: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8.5" class="m-skip"/><path d="M5.8 9h6.4" class="m-tick"/></svg>',
};
const STATE_LABEL = { ok: 'Ready', warn: 'Needs a look', fail: 'Missing', skip: 'Not needed', checking: 'Checking…', fixing: 'Assistant working' };
// The Agents card's three states, in the dot's words.
const AGENT = { ok: ['ok', 'Ready'], action: ['warn', 'Needs a look'], missing: ['skip', 'Not found'] };

// "Create my studio": a folder field (the suggested ~/Video Octopus filled in), a live note on that folder (a cloud-synced
// place, a folder that's already there) and the button. Creating copies Video Octopus's starter in without overwriting
// anything and makes it the studio. Used by Setup and by Settings → Folders.
export function studioCreator({ suggest, onCreated, button = 'Set up local storage' } = {}) {
  const el = h(`<form class="su-create">
    <div class="su-pick"><input class="field mono" name="path" value="${esc(suggest?.shown || '~/Video Octopus')}" spellcheck="false" autocomplete="off" aria-label="Where your studio goes"><button class="btn small primary">${esc(button)}</button></div>
    <p class="su-warn" role="status" hidden></p>
    <p class="sub su-note" aria-live="polite"></p>
    <p class="sub">SQLite stores your skills, versions and learning. Video Octopus manages media files alongside it. The suggested location is local application storage; you can choose another location. Existing studios can stay where they are.</p><p class="sub">Optional after setup: open <a href="#/styles">${TERMS.myStyles}</a> to study examples for a reusable video format, or start a project straight away.</p>
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
  // One screen: what's on this computer (agents, tools, and the machine's model picks on request), then a few optional
  // steps that make the studio yours. Nothing is connected, installed or downloaded until you click.
  const st = await api('/api/app/setup');
  const el = h(`<div class="app-page setup-page">
    <div class="set-main"><div class="set-wrap su-wrap">
      <div class="su-top"><a class="brand" href="#/"><span class="logo" aria-hidden="true"><i></i></span>Video Octopus</a><span class="gap"></span>
        ${st.done ? `<a class="btn small ghost" href="${esc(back)}">Back</a>` : ''}<a class="btn small ghost" href="#/settings">Settings</a></div>
      <div id="scanView">
      <div class="set-head"><h1>Let’s check your computer.</h1><span class="gap"></span><button type="button" class="btn small" id="again">Check my computer</button></div>
      <p class="sub lead">Check installed AI tools and their sign-in status, Python environments, video utilities and hardware. The check runs local tools in standard locations and your studio. Nothing is installed or selected automatically. You can skip this and return later.</p>

      <div id="scanResults" hidden><div id="environmentPicker"></div>
      <section class="su-card" aria-labelledby="suAgents"><div class="su-ch"><h2 id="suAgents">Agents</h2><span class="sub">pick one to run the chats</span></div>
        <ol class="su-list" id="agents"><li class="su-item checking"><div class="su-i"><span class="spin big" aria-hidden="true"></span></div><div class="su-b"><b>Looking for agents…</b></div></li></ol>
        <p class="sub su-byo">Using another provider (OpenRouter, a gateway)? <a href="#/settings/agent/claude">Settings → Agent &amp; model</a>.</p></section>
      <section class="su-card" aria-labelledby="suTools"><div class="su-ch"><h2 id="suTools">Tools</h2></div><ol class="su-list" id="tools"></ol></section>
      <section class="su-card" aria-labelledby="suMachine"><div class="su-ch"><h2 id="suMachine">Recommendations</h2><span class="sub">optional</span><span class="gap"></span>
        <button type="button" class="btn small" id="machineBtn">Check my machine</button></div>
        <p class="sub su-mnote" id="machineNote">The transcription model and the object-separation model that suit this computer, each with its own Download.</p>
        <ol class="su-list" id="machine" hidden></ol></section>
      </div><div class="su-foot"><button type="button" class="btn ghost" id="scanSkip">Skip for now</button><span class="gap"></span><button type="button" class="btn primary" id="scanNext">Continue</button></div>
      </div>

      <div id="youView" hidden>
      <div class="set-head"><h1>Make it yours.</h1></div>
      <p class="sub lead">Set up each brand separately, then learn its video formats. This step is optional.</p>
      <section class="set-group su-q ob-steps"></section>

      <div class="su-foot"><button type="button" class="su-link" id="youBack">← Back to the scan</button><span class="gap"></span><button type="button" class="btn ghost" id="skip">Skip for now</button><button type="button" class="btn primary" id="finish">Done</button></div>
      </div>
    </div></div>
    <aside class="as-col" aria-label="Video Octopus assistant" id="asCol"></aside>
  </div>`);
  ctx.app.replaceChildren(el);

  // ---- the checklist ----
  // Tools (ffmpeg first) run straight away; the machine's recommendations once "Check my machine" is pressed. The agent
  // check ("claude") is the Agents card's scan here.
  const rows = new Map(); // id -> { li, state, check, card }
  const fixing = new Set();
  let machineOn = false;
  for (const c of st.checks.filter((x) => x.card !== 'agents')) {
    const li = h(`<li class="su-item" data-id="${esc(c.id)}"></li>`);
    $(c.card === 'machine' ? '#machine' : '#tools', el).append(li);
    rows.set(c.id, { li, state: 'checking', check: { title: c.title }, card: c.card });
  }
  const count = () => {};
  const drawRow = (id) => {
    const r = rows.get(id), c = r.check;
    const s = fixing.has(id) ? 'fixing' : r.state;
    const icon = s === 'checking' || s === 'fixing' ? '<span class="spin big" aria-hidden="true"></span>' : MARK[s];
    r.li.className = `su-item ${s}${id === 'ffmpeg' ? ' su-rec' : ''}`;
    r.li.hidden = Boolean(c.hidden);
    // A model row says its own few words (drawModels); the check's longer line only for a failure or cloud transcription.
    const short = MODEL_ROWS[id] && c[MODEL_ROWS[id].key] && s !== 'fail' && !c[MODEL_ROWS[id].key].cloud;
    r.li.replaceChildren(h(`<div class="su-i">${icon}</div>`), h(`<div class="su-b"><b>${esc(c.title)}${id === 'ffmpeg' ? ' <span class="badge ob-rec">Recommended</span>' : ''}</b><span class="sub">${esc(s === 'fixing' ? 'The Video Octopus assistant is on it. Answer its questions on the right.' : short ? '' : c.detail || '')}</span>
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
      // Python's Install (and every Fix) goes to the Video Octopus assistant, which shows its plan and asks before each step.
      const b = h(`<button type="button" class="btn small accent">${c.install === true ? 'Set up libraries' : 'Fix'}</button>`);
      b.onclick = async () => {
        if (c.install === true && !(await confirmBox({ title: 'Set up Python libraries for Video Octopus?', text: 'The Video Octopus assistant on the right sets it up: it shows its plan and asks before each step.', ok: 'Ask the assistant' }))) return;
        fix(id);
      };
      a.append(b);
    }
    // ffmpeg: one command (Homebrew or winget) after an OK, with its progress here, or the manual install.
    // An outdated tool (ffmpeg, Node.js) still works: its row says why to update and links the download.
    if (c.manual && s === 'warn') {
      const site = c.manual.replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/\.html$/, '');
      $('.su-b', r.li).append(h(`<span class="sub">Download the update: <a href="${esc(c.manual)}" target="_blank" rel="noopener">${esc(site)}</a>.</span>`));
    }
    if (id === 'ffmpeg' && s === 'fail') {
      if (c.manual) $('.su-b', r.li).append(h(`<span class="sub">Or install it yourself: <a href="${esc(c.manual)}" target="_blank" rel="noopener">ffmpeg.org/download</a>.</span>`));
      if (c.install?.action) a.prepend(actionButton(id, { action: c.install.action, label: 'Install', title: 'Install ffmpeg?', text: `Video Octopus runs ${c.install.cmd} for you, then checks again.` }));
    }
    // The model rows (Whisper, object separation): the model is picked and downloaded right here (Download, progress,
    // Stop); Fix is for the packages.
    const mx = MODEL_ROWS[id] && c[MODEL_ROWS[id].key];
    if (mx && s !== 'checking' && s !== 'fixing') drawModels(id, r.li, mx);
  };

  // ---- the installs and downloads Setup runs itself (ffmpeg, a local model): an OK first, then the command's last
  // lines here while it runs, then the row is checked again ----
  function actionButton(rowId, { action, label, title, text, model = null, onDone }) {
    const b = h(`<button type="button" class="btn small dark">${esc(label)}</button>`);
    b.onclick = async () => {
      const m = typeof model === 'function' ? model() : model;
      if (model && !m) { toast('Type the model\'s name first.'); return; }
      if (!(await confirmBox({ title, text: typeof text === 'function' ? text(m) : text, ok: label }))) return;
      b.disabled = true;
      try { await api('/api/app/scan/action', { action, model: m, confirmed: true }); }
      catch (e) { toast(e.message); b.disabled = false; return; }
      const li = b.closest('.su-item'), out = h(`<span class="su-run sub mono" aria-live="polite">Starting…</span>`);
      $('.su-b', li)?.append(out);
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        const j = await api(`/api/app/scan/action?id=${encodeURIComponent(action)}`).catch(() => null);
        if (!j || !live) return;
        out.textContent = j.tail || j.cmd;
        if (j.state !== 'running') { toast(j.state === 'done' ? `Done: ${j.cmd}` : `${j.cmd} stopped: ${j.tail || 'see the details'}`); break; }
      }
      if (onDone) onDone(); else check(rowId);
    };
    return b;
  }

  // ---- Agents: Claude Code (recommended), Codex (the fallback), LM Studio, Ollama, pi. Connect asks first; a local
  // server is connected behind Claude Code or Codex with one of its models ----
  let scan = null;
  async function scanAgents() {
    const ol = $('#agents', el);
    try { scan = await api('/api/app/scan/agents'); }
    catch (e) { ol.replaceChildren(h(`<li class="su-item fail"><div class="su-i">${MARK.fail}</div><div class="su-b"><b>The scan didn't finish</b><span class="sub">${esc(e.message)}</span></div></li>`)); return; }
    ol.replaceChildren(...scan.agents.map(agentRow));
  }
  const isConnected = (a) => scan?.connected?.id === a.id;
  function agentRow(a) {
    const [s, label] = AGENT[a.state] || AGENT.missing, on = isConnected(a);
    const li = h(`<li class="su-item ${s}${a.recommended ? ' su-rec' : ''}${on ? ' su-on' : ''}" data-agent="${esc(a.id)}"><div class="su-i">${MARK[s]}</div>
      <div class="su-b"><b>${esc(a.name)}${a.recommended ? ' <span class="badge ob-rec">Recommended</span>' : ''}${a.fallback ? ' <span class="badge">Fallback</span>' : ''}</b><span class="sub">${esc(a.detail)}${on ? ` · connected${scan.connected.via ? ` behind ${scan.connected.via === 'codex' ? 'Codex' : 'Claude Code'}${scan.connected.model ? ` (${esc(scan.connected.model)})` : ''}` : ''}` : ''}</span></div>
      <div class="su-a"><span class="su-s">${on ? 'Connected' : label}</span></div></li>`);
    const b = $('.su-b', li), act = $('.su-a', li);
    const how = (text, extra = '') => { const p = h(`<span class="su-how">${esc(text)}${extra}</span>`); b.append(p); return p; };
    if (a.state === 'ok' && !on) {
      const c = h(`<button type="button" class="btn small ${a.recommended ? 'primary' : 'dark'}">Connect</button>`);
      c.onclick = () => connectAgent(a);
      act.prepend(c);
    } else if (a.state === 'action') {
      const tip = how(a.how);
      tip.hidden = !a.local; // a local server says what's wrong straight away; the others behind Fix
      if (!a.local) { const f = h(`<button type="button" class="btn small accent">Fix</button>`); f.onclick = () => { tip.hidden = !tip.hidden; }; act.prepend(f); }
      if (a.local && a.problem === 'off') {
        const retry = h(`<button type="button" class="btn small">Retry</button>`);
        retry.onclick = scanAgents;
        const cc = scan.agents.find((x) => x.id === 'claude');
        act.prepend(retry);
        if (cc?.state === 'ok') { const u = h(`<button type="button" class="su-link">Use Claude Code instead</button>`); u.onclick = () => connectAgent(cc); b.append(u); }
      }
      if (a.local && a.problem === 'nomodel' && a.cli) {
        const f = h(`<div class="su-pick"><input class="field mono" placeholder="${a.id === 'lmstudio' ? 'a model from lmstudio.ai/models' : 'a model from ollama.com/library'}" spellcheck="false" autocomplete="off" aria-label="The model to download"></div>`);
        const field = $('input', f);
        f.append(actionButton(null, { action: a.id === 'lmstudio' ? 'lms-get' : 'ollama-pull', label: 'Download', model: () => field.value.trim(),
          title: `Download a model into ${a.name}?`, text: (m) => `Video Octopus runs ${a.id === 'lmstudio' ? 'lms get' : 'ollama pull'} ${m} for you, then scans again.`, onDone: scanAgents }));
        b.append(f);
      }
      if (a.local && a.problem === 'old' && a.via?.length) { const c = h(`<button type="button" class="btn small dark">Connect with Codex</button>`); c.onclick = () => connectAgent(a); act.prepend(c); }
    } else if (a.state === 'missing') {
      const tip = how(a.how, a.install?.url ? ` <a href="${esc(a.install.url)}" target="_blank" rel="noopener">${esc(a.install.url.replace(/^https:\/\//, ''))}</a>` : '');
      tip.hidden = true;
      const i = h(`<button type="button" class="btn small ghost">How to install</button>`);
      i.onclick = () => { tip.hidden = !tip.hidden; };
      act.prepend(i);
    }
    return li;
  }
  // Connect, after a yes: "Use Claude Code for chats?"; a local server asks which model, and Claude Code or Codex.
  async function connectAgent(a) {
    let body = null;
    if (a.local) {
      body = h(`<div class="cf-pick"><label class="fl" for="cfModel">Model</label><select class="field sel" id="cfModel">${a.models.map((m) => `<option value="${esc(m.id)}">${esc(m.label || m.id)}</option>`).join('')}</select>
        ${a.via.length > 1 ? `<label class="fl" for="cfVia">Runs in</label><select class="field sel" id="cfVia">${a.via.map((v) => `<option value="${v}">${v === 'claude' ? 'Claude Code' : 'Codex'}</option>`).join('')}</select>` : ''}</div>`);
    }
    const via = () => (a.local ? $('#cfVia', body)?.value || a.via[0] : null);
    const ok = await confirmBox({ title: `Use ${a.name} for chats?`, ok: 'Use it', body,
      text: a.local ? `Video Octopus runs ${a.via.length > 1 ? 'Claude Code or Codex' : a.via[0] === 'codex' ? 'Codex' : 'Claude Code'} on a model in ${a.name}, on this computer. You can change it in Settings → Agent & model.`
        : `Every chat in Video Octopus runs on ${a.name}${a.id === 'claude' ? ' with your Claude account' : ''}. You can change it in Settings → Agent & model.` });
    if (!ok) return;
    try {
      await api('/api/app/scan/connect', { agent: a.id, via: via(), model: a.local ? $('#cfModel', body)?.value : undefined, confirmed: true });
      toast(`Chats run on ${a.name} now.`);
    } catch (e) { toast(e.message); }
    scanAgents();
  }

  // ---- the model rows: every model with where it comes from (Hugging Face: the repo, its maker, the size of what's
  // downloaded, the licence), the recommended one marked, the creator's pick, and the picked model's download into the
  // Hugging Face cache (progress, Stop, carry on) ----
  const MODEL_ROWS = {
    whisper: { key: 'whisper', family: 'whisper', section: 'transcribe', name: 'Whisper', note: 'Transcription never downloads a model by itself.' },
    objsep: { key: 'sam2', family: 'sam2', section: 'objsep', name: 'SAM 2.1', note: 'The skill never downloads by itself.' },
  };
  const polls = {};
  let live = true;
  const sizeOf = (x, id) => x.models.find((m) => m.id === id)?.source?.size || '';
  const bar = (d, x) => {
    const pct = d.total ? Math.min(100, (d.got / d.total) * 100) : 0;
    return { pct, text: `${(d.got / 1e6).toFixed(d.total && d.total < 20e6 ? 1 : 0)} of ${d.total ? `${Math.round(d.total / 1e6)} MB` : sizeOf(x, d.size)}` };
  };
  // "From Hugging Face · <repo> (<maker>) · <size> · licence: <licence>", the server's words, with the repo as a link.
  const srcLine = (src) => src?.repo ? esc(src.line || '').replace(esc(src.repo), `<a href="${esc(src.url)}" target="_blank" rel="noopener" class="mono">${esc(src.repo)}</a>`) : '';
  // The short view: the one model recommended for this computer, where it comes from, what's in use now, and its
  // Download. Every size, the build and Auto wait behind "Show all models" (folded until opened; it stays as left).
  const openAll = {};
  const eng = (e) => (e === 'mlx' ? 'MLX Whisper' : 'faster-whisper');
  function drawModels(id, li, x) {
    const R = MODEL_ROWS[id], d = x.download || { state: 'idle' }, b = $('.su-b', li), a = $('.su-a', li);
    const busy = d.state === 'downloading', title = (fam) => (fam === 'mlx' ? 'MLX Whisper' : R.name);
    const rec = x.rec || { id: x.recommended, family: x.family, have: x.models.find((m) => m.id === x.recommended)?.have };
    const recText = id === 'whisper' ? `${rec.id} on ${eng(rec.engine)}${rec.engine === 'mlx' ? ' (the Mac’s GPU)' : ''}` : `${rec.id} (${x.why})`;
    const now = x.there && (x.picked !== rec.id || (id === 'whisper' && x.engine !== rec.engine)) ? `Using ${x.picked}${id === 'whisper' ? ` on ${eng(x.engine)}` : ''} now.` : '';
    b.append(h(`<span class="su-recl">Recommended for this computer: <b>${esc(recText)}</b>${rec.have ? ' <span class="badge">Downloaded</span>' : ''}</span>`),
      h(`<span class="su-src">${srcLine(rec.source)}</span>`));
    if (now) b.append(h(`<span class="sub">${esc(now)}</span>`));
    if (x.slow) b.append(h(`<span class="su-how">No GPU it can use here: object separation runs on the CPU and takes seconds a frame, so tiny is the one to have.</span>`));
    const dlButton = (family, size, label) => {
      const go = h(`<button type="button" class="btn small dark">${esc(label)}</button>`);
      go.title = `Download ${title(family)} ${size} into the Hugging Face cache, once for every studio`;
      go.onclick = async () => {
        go.disabled = true;
        try {
          const r = rows.get(id), dl = await api(`/api/app/setup/${family}/download`, { size });
          r.check[R.key] = { ...r.check[R.key], download: { ...dl, family } };
          if (dl.state === 'done') check(id); else drawRow(id);
        } catch (e) { toast(e.message); go.disabled = false; }
      };
      return go;
    };
    if (busy) {
      const { pct, text } = bar(d, x);
      $('.su-s', a).textContent = 'Downloading';
      b.append(h(`<span class="su-dl"><span class="su-bar" role="progressbar" aria-label="Downloading ${esc(title(d.family))} ${esc(d.size)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><i style="width:${pct.toFixed(1)}%"></i></span><span class="sub mono">${esc(text)}</span></span>`));
      const stop = h(`<button type="button" class="btn small ghost">Stop</button>`);
      stop.onclick = async () => { stop.disabled = true; try { await api(`/api/app/setup/${d.family || R.family}/stop`, {}); } catch (e) { toast(e.message); } };
      a.prepend(stop);
      watch(id);
    } else {
      if (d.state === 'error' || d.state === 'stopped') b.append(h(`<span class="su-how">${esc(d.error || 'Stopped.')}</span>`));
      if (!rec.have && !x.cloud) a.prepend(dlButton(rec.family, rec.id, d.got > 0 && d.state !== 'done' && d.size === rec.id ? 'Carry on' : 'Download'));
    }
    // Everything else, folded: the build (Whisper), Auto and every size with its source, and a Download for a pick
    // that isn't the recommended one.
    const fold = h(`<details class="su-all"${openAll[id] ? ' open' : ''}><summary>Show all models</summary></details>`);
    fold.ontoggle = () => { openAll[id] = fold.open; };
    if (id === 'whisper') {
      const seg = h(`<div class="su-eng"><span class="sub">Runs on</span><div class="seg" role="radiogroup" aria-label="Whisper build"></div></div>`);
      for (const [k, label] of [['auto', 'Auto'], ['mlx', 'MLX Whisper'], ['faster-whisper', 'faster-whisper']]) {
        const btn = h(`<button type="button" role="radio" aria-checked="${k === x.engineChoice}" class="${k === x.engineChoice ? 'on' : ''}"${(k === 'mlx' && !x.mlxOk) || busy ? ' disabled' : ''}>${esc(label)}</button>`);
        btn.onclick = async () => { if (k === x.engineChoice) return; try { await api('/api/app/settings', { section: 'transcribe', values: { whisperEngine: k } }); await check(id); } catch (e) { toast(e.message); } };
        $('.seg', seg).append(btn);
      }
      fold.append(seg);
    }
    const pick = h(`<div class="su-models" role="radiogroup" aria-label="${esc(title(x.family))} model">
      <label class="su-model"><input type="radio" name="m-${esc(id)}" value="auto"${x.choice === 'auto' ? ' checked' : ''}${busy ? ' disabled' : ''}><b>Auto</b><span class="sub">${id === 'whisper' ? 'the best one downloaded' : 'the recommended one'}</span></label>
      ${x.models.map((m) => `<div class="su-mi"><label class="su-model"><input type="radio" name="m-${esc(id)}" value="${esc(m.id)}"${x.choice === m.id ? ' checked' : ''}${busy ? ' disabled' : ''}><b>${esc(m.id)}</b>
        ${m.speed ? `<span class="sub">${esc(m.speed)}</span>` : ''}${m.id === x.recommended && x.family === rec.family ? '<span class="badge ob-rec">Recommended</span>' : ''}${m.have ? '<span class="badge">Downloaded</span>' : ''}</label>
        <span class="su-src">${srcLine(m.source)}</span></div>`).join('')}
    </div>`);
    pick.querySelectorAll('input').forEach((i) => (i.onchange = async () => {
      try { await api('/api/app/settings', { section: R.section, values: { model: i.value } }); await check(id); }
      catch (e) { toast(e.message); }
    }));
    fold.append(pick);
    if (!busy && !x.there && !x.cloud && (x.picked !== rec.id || x.family !== rec.family)) {
      const row = h(`<div class="su-pickdl"><span class="sub">Your pick, ${esc(x.picked)}${id === 'whisper' ? ` on ${esc(eng(x.engine))}` : ''}, isn't downloaded yet.</span></div>`);
      row.append(dlButton(x.family, x.picked, 'Download it'));
      fold.append(row);
    }
    b.append(fold);
  }
  // While it downloads: the bar follows the server every half second; done → the row is checked again.
  function watch(id) {
    if (polls[id]) return;
    const R = MODEL_ROWS[id];
    const tick = async () => {
      let d = null;
      const fam = rows.get(id)?.check?.[R.key]?.download?.family || rows.get(id)?.check?.[R.key]?.family || R.family;
      try { d = { ...(await api(`/api/app/setup/${fam}`)), family: fam }; } catch {}
      const r = rows.get(id);
      if (!live || !r?.check?.[R.key] || !d) { polls[id] = null; return; }
      r.check[R.key] = { ...r.check[R.key], download: d };
      const el = $('.su-dl', r.li);
      if (d.state === 'downloading') {
        if (el) { const { pct, text } = bar(d, r.check[R.key]); $('i', el).style.width = `${pct.toFixed(1)}%`; $('.su-bar', el).setAttribute('aria-valuenow', String(Math.round(pct))); $('.sub', el).textContent = text; }
        else drawRow(id);
        polls[id] = setTimeout(tick, 500);
        return;
      }
      polls[id] = null;
      if (d.state === 'done') { toast(`${R.name} ${d.size} is downloaded.`); check(id); } else drawRow(id);
    };
    polls[id] = setTimeout(tick, 500);
  }
  async function check(id) {
    const r = rows.get(id);
    r.state = 'checking'; drawRow(id); count();
    try { r.check = await api(`/api/app/setup/check?id=${encodeURIComponent(id)}`); r.state = r.check.state; }
    catch (e) { r.check = { ...r.check, detail: e.message }; r.state = 'fail'; }
    drawRow(id); count();
  }
  // Each check shows as it finishes; the machine's only once asked for.
  const checkAll = async () => {
    await Promise.all([scanAgents(), ...[...rows.keys()].filter((id) => machineOn || rows.get(id).card !== 'machine').map(check)]);
    drawSteps(rows.get('folders')?.state === 'ok');
  };
  $('#machineBtn', el).onclick = () => {
    machineOn = true;
    $('#machine', el).hidden = false; $('#machineNote', el).hidden = true; $('#machineBtn', el).hidden = true;
    for (const [id, r] of rows) if (r.card === 'machine') check(id);
  };

  async function fix(id) {
    fixing.add(id); drawRow(id);
    try {
      const r = await api('/api/app/assistant/fix', { id });
      if (!r.sent) { fixing.delete(id); rows.get(id).check = r.check; rows.get(id).state = r.check.state; drawRow(id); count(); toast('That one is fine now.'); }
    } catch (e) { fixing.delete(id); drawRow(id); toast(e.message); }
  }
  let scanStarted = false;
  const picker = environmentPicker(() => Promise.all([check('python'), ...(machineOn ? [check('objsep'), check('whisper')] : [])]));
  $('#environmentPicker', el).append(picker.el);
  $('#again', el).onclick = async () => {
    if ($('#again', el).disabled) return;
    scanStarted = true;
    $('#scanResults', el).hidden = false;
    $('#again', el).disabled = true;
    try { await Promise.all([checkAll(), picker.scan()]); }
    finally { $('#again', el).disabled = false; $('#again', el).textContent = 'Scan again'; }
  };

  // ---- the assistant on the right; when it finishes a reply, check again ----
  const panel = assistantPanel({
    hint: 'Press Fix on a row and I take it from there, asking before each step.',
    onResult: async () => {
      if (!scanStarted) return;
      const ids = fixing.size ? [...fixing] : [...rows.keys()].filter((id) => machineOn || rows.get(id).card !== 'machine');
      fixing.clear();
      await Promise.all(ids.map(check));
      drawSteps(rows.get('folders')?.state === 'ok');
    },
  });
  $('#asCol', el).append(panel.el);

  // Profile onboarding uses the same database-backed, reviewable flow as Settings.
  let profilePanel=null, studioThere=null;
  const drawSteps=(there)=>{
    if(there===studioThere)return;studioThere=there;profilePanel?.teardown?.();
    const steps=el.querySelector('.ob-steps');
    steps.replaceChildren(h('<h2>Brand profiles</h2><p>Create a profile and enter your brand or research its website. Review the proposal before saving. You can skip this and return in Settings → Brand profiles.</p>'));
    if(there){profilePanel=profileSettings({makeChat:ctx.makeChat});steps.append(profilePanel);}
    else steps.append(h('<p>Create or choose your studio first, then add a brand profile here.</p>'));
  };

  // ---- two screens: the scan, then "Make it yours" (both skippable), then the app ----
  // Continue always works, with or without an agent connected: whatever's missing waits in Settings. Skip for now
  // goes on the same way without marking Setup done.
  const view = (which) => {
    $('#scanView', el).hidden = which !== 'scan'; $('#youView', el).hidden = which !== 'you';
    el.querySelector('.set-main')?.scrollTo?.({ top: 0 });
  };
  const leave = () => { location.hash = back && back !== '#/setup' ? back : '#/'; };
  $('#scanNext', el).onclick = async () => { try { await api('/api/app/setup', { done: true }); } catch (e) { toast(e.message); } view('you'); };
  $('#scanSkip', el).onclick = () => { try { sessionStorage.setItem('studio.setupSkipped', '1'); } catch {} view('you'); };
  $('#youBack', el).onclick = () => view('scan');
  $('#finish', el).onclick = leave;
  $('#skip', el).onclick = leave;

  for (const id of rows.keys()) drawRow(id);
  count();
  drawSteps(Boolean(st.studioReady));
  return { teardown: () => { live = false; picker.destroy(); Object.values(polls).forEach(clearTimeout); panel.destroy(); profilePanel?.teardown?.(); document.body.classList.remove('in-home', 'in-app-page'); } };
}

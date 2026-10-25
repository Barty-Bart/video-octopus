import { $, h, esc, api, confirmBox, toast } from './ui.js';
import { bestMatch, askAgentShown, enginesText, pythonSearchBrief } from './python-search.js';

export function environmentPicker(onSelected) {
  const el = h(`<section class="su-card su-environments" aria-labelledby="pythonEnvironments"><div class="su-ch"><h2 id="pythonEnvironments">Python environments</h2></div><p class="sub" data-hardware></p><p class="sub">Libraries belong to each Python environment. Finding packages is a first check; Verify checks that they can actually load, without loading models.</p><form class="su-pick"><label style="flex:1">Existing environment or project folder<input class="field mono" name="path" style="width:100%" placeholder="Full path to a project, .venv or Python executable" autocomplete="off"></label><button class="btn small" type="submit">Check this location</button></form><p class="sub">Check my computer also looks for .venv, venv and env folders up to two folders deep in common places (Movies, Documents, Downloads, Desktop, Developer, Projects, code and your studio's folder) and in apps' data (such as OpenToolkit's). It reads folder names only and never searches the whole disk. macOS may ask whether Video Octopus may see Documents, Desktop or Downloads; saying no just skips them.</p><p role="status" data-status></p><div class="notice small" data-best hidden></div><div class="notice small" data-ask hidden><span>Already have Python with Whisper or Parakeet somewhere else? Your assistant can search this whole computer for it, read-only: it installs, downloads and changes nothing, and you still choose with Use this.</span> <button type="button" class="btn small" data-ask-agent>Ask the assistant to look for it</button></div><ol class="su-list" data-environments></ol><p class="sub">Prefer a separate setup? Ask the assistant to create a dedicated studio environment. It must explain its plan and ask before installing anything.</p><button type="button" class="btn small" data-dedicated>Plan a dedicated environment</button></section>`);
  let busy = false, live = true, snapshot = null;
  const status = $('[data-status]', el), list = $('[data-environments]', el);
  const lock = value => { busy = value; el.querySelectorAll('button,input').forEach(x => x.disabled = value); };
  function render() {
    if (!live || !snapshot) return;
    const m = snapshot.machine;
    $('[data-hardware]', el).textContent = m ? `${m.chip} · ${m.ramGB || '?'} GB RAM. Hardware recommendation: ${m.whisper.engine === 'mlx' ? 'MLX Whisper' : 'faster-whisper'}, ${m.whisper.model}. Model downloads remain optional.` : '';
    const best = bestMatch(snapshot), bestBox = $('[data-best]', el), askBox = $('[data-ask]', el);
    bestBox.hidden = !best; askBox.hidden = !askAgentShown(snapshot);
    if (best) {
      bestBox.replaceChildren(h(`<span><b>Best match:</b> <span class="mono" style="overflow-wrap:anywhere">${esc(best.path)}</span> · Python ${esc(best.version || '?')} · ${esc(enginesText(best))}${best.source === 'Currently selected' ? ' · selected' : ''}</span>`));
      if (best.source !== 'Currently selected') { const use = h('<button type="button" class="btn small primary" data-best-use>Use this</button>'); use.onclick = () => useIt(best); use.disabled = busy; bestBox.append(' ', use); }
    }
    const ordered = best ? [best, ...snapshot.environments.filter(x => x !== best)] : snapshot.environments;
    list.replaceChildren(...ordered.map(item => {
      const recommended = snapshot.recommended === item.path;
      const row = h(`<li class="su-item"><div class="su-b" style="min-width:0"><b>Python ${esc(item.version || 'unknown')}${recommended ? ' · Best match' : ''}${item.source === 'Currently selected' ? ' · Selected' : ''}</b><span class="sub">${esc(item.source || '')}</span><span class="sub mono" style="overflow-wrap:anywhere">${esc(item.path)}</span><span class="sub">${esc(item.status)}</span><span class="sub">${esc(Object.entries(item.packages || {}).filter(([,v]) => v).map(([k,v]) => `${k} ${v}`).join(' · ') || 'No video libraries found here.')}</span><span class="sub">${item.editing ? 'Editing libraries found' : 'Editing needs NumPy'} · ${item.transcription ? `Transcription: ${esc(enginesText(item))}` : 'Transcription needs libraries'} · ${item.objectSeparation ? 'Object separation libraries found' : 'Object separation needs setup'}</span>${item.verification ? `<span class="sub">${esc(item.verification.error || `Import checks: ${Object.entries(item.verification.imports || {}).map(([k,v]) => `${k}: ${v ? 'OK' : (item.verification.errors?.[k] || 'unavailable')}`).join(', ')}. SAM 2 video API: ${item.verification.sam2 ? 'OK' : 'unavailable'}.`)}</span>` : ''}</div><div class="su-a"><button class="btn small" data-verify>Verify</button><button class="btn small${recommended ? ' primary' : ''}" data-use>Use this</button></div></li>`);
      $('[data-verify]', row).disabled = !item.supported;
      $('[data-use]', row).disabled = !item.supported || !item.transcription;
      $('[data-verify]', row).onclick = () => act('verify', item);
      $('[data-use]', row).onclick = () => useIt(item);
      return row;
    }));
    if (!snapshot.environments.length) list.append(h('<li class="su-item">No Python environments found. Choose an existing project above, or use the setup action below.</li>'));
  }
  async function useIt(item) {
    const owner = item.appOwned ? ' It belongs to another app, which may change it when that app updates.' : '';
    if (await confirmBox({ title: 'Use this Python environment?', text: `Video Octopus will use ${item.path} for local Python tasks after checking its imports. It has ${enginesText(item) || 'no transcription library'}; ${item.parakeet ? 'Parakeet becomes a choice in Settings → Transcription. ' : ''}your transcription settings stay the same.${owner} If another project owns this environment, keep it in place; future package changes can affect both. Nothing is installed.`, ok: 'Verify and use' })) act('select', item);
  }
  // After the assistant was asked to look: its reports (octopus python suggest) appear here with a fresh scan.
  let watch = null;
  async function watchSuggestions() {
    clearInterval(watch);
    const seen = JSON.stringify((await api('/api/app/setup/environments/suggestions').catch(() => ({}))).suggestions || []);
    const until = Date.now() + 20 * 60e3;
    watch = setInterval(async () => {
      if (!live || Date.now() > until) return clearInterval(watch);
      const now = JSON.stringify((await api('/api/app/setup/environments/suggestions').catch(() => ({}))).suggestions || []);
      if (now !== seen && !busy) { clearInterval(watch); toast('The assistant reported a Python environment. Checking it…'); scan(); }
    }, 5000);
  }
  $('[data-ask-agent]', el).onclick = async () => {
    if (!await confirmBox({ title: 'Ask the assistant to look for Python?', text: 'This sends a message to your selected AI agent. It searches this computer read-only (Spotlight, find, apps\' folders and the Hugging Face cache), installs and changes nothing, and reports what it finds here. You then choose with Use this.', ok: 'Ask the assistant' })) return;
    try {
      await api('/api/projects/_studio/chat', { text: pythonSearchBrief({ scope: snapshot?.scope }) });
      toast('Search requested in the assistant panel.');
      status.textContent = 'The assistant is looking. What it reports appears in this list.';
      watchSuggestions();
    } catch (e) { status.textContent = e.message; }
  };
  async function act(action, item) {
    if (busy) return;
    lock(true); status.textContent = 'Checking library imports… This can take up to a minute.';
    try {
      const r = await api(`/api/app/setup/environments/${action}`, { confirmed: true, path: item.path });
      const next = r.environment;
      if (r.selected) { snapshot.environments.forEach(x => { if (x.source === 'Currently selected') x.source = 'Previously selected'; }); next.source = 'Currently selected'; }
      snapshot.environments = snapshot.environments.map(x => x.path === item.path ? next : x);
      status.textContent = r.selected ? 'Environment selected. Future agent turns use this Python.' : 'Import checks finished. Models were not loaded.';
      if (r.selected) { toast('Python environment selected.'); await onSelected?.(); }
    } catch (e) { status.textContent = e.message; }
    finally { lock(false); render(); }
  }
  async function scan(path = '') {
    if (busy) return;
    lock(true); status.textContent = 'Looking for Python environments…';
    try {
      const result = await api('/api/app/setup/environments/scan', { confirmed: true, path });
      snapshot = result;
      status.textContent = `${result.environments.length} environment(s) found. ${result.truncated ? 'Showing the first 32 candidates; check a specific location to include it. ' : ''}Looked through ${result.scope}`;
    } catch (e) { status.textContent = e.message; }
    finally { lock(false); render(); }
  }
  $('[data-dedicated]', el).onclick = async () => {
    if (!await confirmBox({ title: 'Ask the assistant to plan setup?', text: 'This sends a message to your selected AI agent. It must ask before creating an environment or installing packages.', ok: 'Ask the assistant' })) return;
    try {
      await api('/api/projects/_studio/chat', { text: 'Help me plan a dedicated Python environment in this studio at .venv for Video Octopus. Reuse an installed supported Python. Explain the required libraries and disk space first. Do not modify another project environment. Ask before creating the environment, installing packages or downloading any model. After setup, help me scan and explicitly select the new environment.' });
      toast('Setup plan requested in the assistant panel.');
    } catch (e) { status.textContent = e.message; }
  };
  $('form', el).onsubmit = e => { e.preventDefault(); const path = $('input', el).value.trim(); if (path) scan(path); };
  return { el, scan, destroy: () => { live = false; clearInterval(watch); } };
}

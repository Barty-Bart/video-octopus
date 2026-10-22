import { $, h, esc, api, confirmBox, toast } from './ui.js';

export function environmentPicker(onSelected) {
  const el = h(`<section class="su-card su-environments" aria-labelledby="pythonEnvironments"><div class="su-ch"><h2 id="pythonEnvironments">Python environments</h2></div><p class="sub" data-hardware></p><p class="sub">Libraries belong to each Python environment. Finding packages is a first check; Verify checks that they can actually load, without loading models.</p><form class="su-pick"><label style="flex:1">Existing environment or project folder<input class="field mono" name="path" style="width:100%" placeholder="Full path to a project, .venv or Python executable" autocomplete="off"></label><button class="btn small" type="submit">Check this location</button></form><p class="sub">Only this folder and its .venv, venv or env are checked. Other project folders are not searched.</p><p role="status" data-status></p><ol class="su-list" data-environments></ol><p class="sub">Prefer a separate setup? Ask the assistant to create a dedicated studio environment. It must explain its plan and ask before installing anything.</p><button type="button" class="btn small" data-dedicated>Plan a dedicated environment</button></section>`);
  let busy = false, live = true, snapshot = null;
  const status = $('[data-status]', el), list = $('[data-environments]', el);
  const lock = value => { busy = value; el.querySelectorAll('button,input').forEach(x => x.disabled = value); };
  function render() {
    if (!live || !snapshot) return;
    const m = snapshot.machine;
    $('[data-hardware]', el).textContent = m ? `${m.chip} · ${m.ramGB || '?'} GB RAM. Hardware recommendation: ${m.whisper.engine === 'mlx' ? 'MLX Whisper' : 'faster-whisper'}, ${m.whisper.model}. Model downloads remain optional.` : '';
    list.replaceChildren(...snapshot.environments.map(item => {
      const recommended = snapshot.recommended === item.path;
      const row = h(`<li class="su-item"><div class="su-b" style="min-width:0"><b>Python ${esc(item.version || 'unknown')}${recommended ? ' · Recommended candidate' : ''}${item.source === 'Currently selected' ? ' · Selected' : ''}</b><span class="sub mono" style="overflow-wrap:anywhere">${esc(item.path)}</span><span class="sub">${esc(item.status)}</span><span class="sub">${esc(Object.entries(item.packages || {}).filter(([,v]) => v).map(([k,v]) => `${k} ${v}`).join(' · ') || 'No video libraries found here.')}</span><span class="sub">${item.editing ? 'Editing libraries found' : 'Editing needs NumPy'} · ${item.transcription ? `Transcription: ${esc(item.engine)}` : 'Transcription needs libraries'} · ${item.objectSeparation ? 'Object separation libraries found' : 'Object separation needs setup'}</span>${item.verification ? `<span class="sub">${esc(item.verification.error || `Import checks: ${Object.entries(item.verification.imports || {}).map(([k,v]) => `${k}: ${v ? 'OK' : (item.verification.errors?.[k] || 'unavailable')}`).join(', ')}. SAM 2 video API: ${item.verification.sam2 ? 'OK' : 'unavailable'}.`)}</span>` : ''}</div><div class="su-a"><button class="btn small" data-verify>Verify</button><button class="btn small primary" data-use>Use this environment</button></div></li>`);
      $('[data-verify]', row).disabled = !item.supported;
      $('[data-use]', row).disabled = !item.supported || !item.transcription;
      $('[data-verify]', row).onclick = () => act('verify', item);
      $('[data-use]', row).onclick = async () => {
        if (await confirmBox({ title: 'Use this Python environment?', text: `Video Octopus will use ${item.path} for local Python tasks after checking its imports. Automatic transcription will prefer ${item.engine}. Your selected provider stays the same. If another project owns this environment, keep it in place; future package changes can affect both apps. Nothing is installed.`, ok: 'Verify and use' })) act('select', item);
      };
      return row;
    }));
    if (!snapshot.environments.length) list.append(h('<li class="su-item">No Python environments found. Choose an existing project above, or use the setup action below.</li>'));
  }
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
      status.textContent = `${result.environments.length} environment(s) found. ${result.truncated ? 'Showing the first 32 candidates; check a specific location to include it.' : result.scope}`;
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
  return { el, scan, destroy: () => { live = false; } };
}

// Scheduled: Claude runs a skill or an instruction on a timer. The list on the left, the one you're
// editing on the right (name, skill, what to tell Claude, when, which projects, how much it may change), and its
// runs underneath, each one a Claude Code session you can open and read. Server: server/schedules.mjs.
import { $, esc, h, api, toast, ago, tilde } from './ui.js';
import { mdLite } from './library.js';

const WHEN = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MODE_HINT = {
  report: 'Report only: Claude reads and looks, changes nothing, and writes what it found in the run.',
  ask: 'Ask before changes: what it wants to add to the library waits in the Library inbox for your OK; other changes come back as proposals in the run.',
  change: 'Make changes: Claude may edit files and run commands in the projects it covers, and lists what it changed.',
};
const STATUS = { done: 'Done', error: 'Failed', timeout: 'Stopped (time limit)', stopped: 'Stopped', skipped: 'Nothing to do', running: 'Running' };

// Hourly / Daily / Weekly read and write the cron; anything else is Custom.
function presetOf(cron) {
  const f = String(cron || '').split(' ');
  if (f.length !== 5) return { kind: 'custom' };
  const [m, hh, dom, mon, dow] = f, n = (s) => /^\d+$/.test(s);
  if (n(m) && hh === '*' && dom === '*' && mon === '*' && dow === '*') return { kind: 'hourly', m: +m };
  if (n(m) && n(hh) && dom === '*' && mon === '*' && dow === '*') return { kind: 'daily', m: +m, h: +hh };
  if (n(m) && n(hh) && dom === '*' && mon === '*' && n(dow)) return { kind: 'weekly', m: +m, h: +hh, d: +dow % 7 };
  return { kind: 'custom' };
}
const cronOf = (p) => (p.kind === 'hourly' ? `${p.m} * * * *` : p.kind === 'daily' ? `${p.m} ${p.h} * * *` : `${p.m} ${p.h} * * ${p.d}`);
// The first line of a summary for the list, without markdown marks.
const firstLine = (t) => (String(t || '').split('\n').map((l) => l.replace(/^#+\s*|\*\*|__|`/g, '').trim()).find((l) => l && !/^summary:?$/i.test(l)) || '');
const took = (r) => { const s = Math.round((r.endedAt - r.startedAt) / 1000); return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`; };
const hhmm = (p) => `${String(p.h ?? 9).padStart(2, '0')}:${String(p.m ?? 0).padStart(2, '0')}`;

// route: { alive } from the router (web/nav.js): false once the page has been left, even during its first load.
export async function renderSchedules(main, route = null) {
  // all: what /api/app/schedules sends (schedules, templates, scopes, modes, projects, skills, inbox, catchUp)
  let all = null, sel = null, draft = null, runs = [], poll = null, dirty = false, left = false;
  const alive = () => !left && (route?.alive?.() ?? true);
  main.replaceChildren(h(`<div class="home-wrap wide sched">
    <div class="home-head"><div class="hh-title"><h1>Scheduled</h1>
      <div class="sub">Claude runs a skill on a timer, on one project, a set of them or the whole studio. Like Claude Code's scheduled tasks, inside Video Octopus.</div></div>
      <button class="btn dark" id="schNew">+ New scheduled run</button></div>
    <div class="sch-grid"><div class="sch-list" id="schList"></div><section class="sch-ed" id="schEd" aria-label="Scheduled run"></section></div>
  </div>`));
  const list = $('#schList', main), ed = $('#schEd', main);

  const load = async (keep = true) => {
    all = await api('/api/app/schedules');
    if (!alive()) return; // left the page while it loaded
    if (!keep || (sel && !all.schedules.some((s) => s.id === sel))) sel = null;
    if (!sel && !draft && all.schedules.length) sel = all.schedules[0].id;
    drawList();
    if (!dirty) { await loadRuns(); if (!alive()) return; drawEditor(); }
    clearTimeout(poll);
    if (all.schedules.some((s) => s.running || s.queued)) poll = setTimeout(() => load().catch(() => {}), 3000);
  };
  const loadRuns = async () => { runs = sel ? (await api(`/api/app/schedules/runs?id=${encodeURIComponent(sel)}`)).runs : []; };

  function drawList() {
    const rows = all.schedules.map((s) => `<div class="sch-row${s.id === sel && !draft ? ' on' : ''}${s.enabled ? '' : ' off'}" data-id="${esc(s.id)}" tabindex="0" role="button" aria-pressed="${s.id === sel && !draft}">
        <div class="sr-name"><b>${esc(s.name)}</b><span>${s.skill ? `skill: ${esc(s.skill)}` : 'Claude (no skill)'}</span></div>
        <div><span>${esc(s.when)}</span><code>${esc(s.cron)}</code></div>
        <span class="sr-scope">${esc(s.scopeLabel)}${s.inScope != null ? ` <small>(${s.inScope})</small>` : ''}</span>
        <span class="sr-mode m-${esc(s.mode)}">${esc(s.modeLabel)}</span>
        <div>${s.running ? '<span class="sr-run">● Running</span>' : s.queued ? '<span class="sr-run q">Waiting to run</span>' : `<span>${s.next ? esc(WHEN.format(s.next)) : s.enabled ? '—' : 'Off'}</span>`}
          <small>last: ${s.last ? `${esc(ago(s.last.startedAt))} · ${esc(STATUS[s.last.status] || s.last.status)}` : 'never'}</small></div>
        <label class="toggle" title="${s.enabled ? 'On' : 'Off'}" onclick="event.stopPropagation()"><input type="checkbox" data-on="${esc(s.id)}"${s.enabled ? ' checked' : ''} aria-label="Run ${esc(s.name)} on its schedule"><span class="sw"></span></label>
      </div>`).join('');
    const empty = !all.schedules.length;
    list.replaceChildren(h(`<div class="sch-list-in">
      ${empty ? '' : '<div class="sch-head"><span>Run</span><span>When</span><span>On</span><span>Changes</span><span>Next</span><span></span></div>'}
      ${rows}
      ${all.templates.length ? `<div class="sch-tpl"><div class="sch-cap">${empty ? 'Start from one of these' : 'More to start from'}</div>
        <div class="tpl-grid">${all.templates.filter((t) => !all.schedules.some((s) => s.template === t.template)).map((t) => `<button class="tpl" data-tpl="${esc(t.template)}"><b>${esc(t.name)}</b><span>${esc(t.when)} · ${esc(all.scopes[t.scope] || t.scope)} · ${esc(all.modes[t.mode])}</span></button>`).join('') || '<span class="sub">All the templates are in your list.</span>'}</div></div>` : ''}
      <div class="sch-note"><span>Runs while Video Octopus is open, one at a time. Every run is a Claude Code session you can open and read afterwards.</span>
        <label class="toggle"><input type="checkbox" id="schCatch"${all.catchUp ? ' checked' : ''}><span class="sw"></span>Run one missed while Video Octopus was closed when it starts</label></div>
    </div>`));
    list.querySelectorAll('.sch-row').forEach((r) => {
      const pick = async () => { if (dirty && !confirm('Leave without saving your changes?')) return; dirty = false; draft = null; sel = r.dataset.id; drawList(); await loadRuns(); drawEditor(); };
      r.onclick = pick;
      r.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
    });
    list.querySelectorAll('[data-on]').forEach((c) => (c.onchange = async () => {
      try { all = await api('/api/app/schedules', { op: 'enable', id: c.dataset.on, enabled: c.checked }); drawList(); if (!dirty) drawEditor(); } catch (e) { toast(e.message); c.checked = !c.checked; }
    }));
    list.querySelectorAll('[data-tpl]').forEach((b) => (b.onclick = () => {
      if (dirty && !confirm('Leave without saving your changes?')) return;
      const t = all.templates.find((x) => x.template === b.dataset.tpl);
      draft = { ...t, enabled: true }; sel = null; dirty = true; runs = []; drawList(); drawEditor();
    }));
    $('#schCatch', list).onchange = async (e) => { try { all = await api('/api/app/schedules', { op: 'catch-up', on: e.target.checked }); } catch (er) { toast(er.message); } };
  }

  function drawEditor() {
    const s = draft || all.schedules.find((x) => x.id === sel);
    if (!s) {
      ed.replaceChildren(h(`<div class="sch-empty"><b>No scheduled runs yet</b><span class="sub">Start from one of the templates, or make your own with + New scheduled run.</span></div>`));
      return;
    }
    const edit = { ...s }; // the copy the form changes; Save sends it
    let preset = presetOf(edit.cron); // the When choice: hourly, daily, weekly (m, h, d) or custom
    const projectOpts = all.projects.map((p) => `<option value="project:${esc(p.id)}"${edit.scope === `project:${p.id}` ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
    const live = all.schedules.find((x) => x.id === edit.id);
    const el = h(`<div class="sch-ed-in">
      <div class="se-head"><input class="se-name" id="seName" value="${esc(edit.name || '')}" placeholder="Name this run" aria-label="Name">
        ${edit.id ? `${live?.running || live?.queued ? '<button class="btn small" id="seStop">Stop</button>' : '<button class="btn small" id="seRun">Run now</button>'}` : ''}
        <button class="btn small accent" id="seSave">${edit.id ? 'Save' : 'Add'}</button></div>
      <div class="se-body">
        <label class="se-f"><b>Skill</b><select class="field sel" id="seSkill"><option value="">Claude (no skill)</option>${all.skills.map((k) => `<option${k === edit.skill ? ' selected' : ''}>${esc(k)}</option>`).join('')}</select></label>
        <label class="se-f"><b>What to tell Claude</b><textarea class="field area" id="sePrompt" rows="5" placeholder="What should Claude do on each run?">${esc(edit.prompt || '')}</textarea></label>
        <div class="se-f"><b>When</b>
          <div class="seg se-pre" role="group" aria-label="How often">${[['hourly', 'Hourly'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['custom', 'Custom (cron)']].map(([k, l]) => `<button type="button" data-pre="${k}"${preset.kind === k ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"'}>${l}</button>`).join('')}</div>
          <div class="se-when" id="seWhen"></div>
          <div class="se-next sub" id="seNext"></div></div>
        <label class="se-f"><b>On</b><select class="field sel" id="seScope">
          ${Object.entries(all.scopes).map(([k, l]) => `<option value="${k}"${edit.scope === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}
          <optgroup label="One project">${projectOpts}</optgroup></select></label>
        <div class="se-f"><b>Changes</b><div class="se-modes" role="radiogroup" aria-label="Changes">${Object.entries(all.modes).map(([k, l]) => `<button type="button" role="radio" data-mode="${k}" aria-checked="${edit.mode === k}" class="${edit.mode === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
          <span class="sub" id="seHint">${esc(MODE_HINT[edit.mode] || '')}</span>${edit.mode === 'ask' ? `<span class="sub mono se-inbox">${esc(tilde(all.inbox))}</span>` : ''}</div>
        ${edit.id ? `<div class="se-f"><b>Runs</b><div class="se-runs">${runs.length ? runs.map((r) => `<button class="se-run st-${esc(r.status)}" data-run="${esc(r.id)}"><span class="mono">${esc(WHEN.format(r.startedAt))}</span><span class="st">${esc(STATUS[r.status] || r.status)}${r.why === 'catch-up' ? ' · caught up' : r.why === 'manual' ? ' · run now' : ''}</span><span class="sum">${esc(firstLine(r.summary) || (r.status === 'running' ? 'Claude is working…' : ''))}</span><span class="go">Open session →</span></button>`).join('') : '<span class="sub">No runs yet.</span>'}</div></div>` : ''}
        ${edit.id ? '<div class="se-del"><button class="btn small ghost danger" id="seDel">Delete this scheduled run</button></div>' : ''}
      </div></div>`);
    ed.replaceChildren(el);
    const touch = () => { dirty = true; };
    const whenBox = $('#seWhen', el), nextBox = $('#seNext', el);
    let previewT = null;
    const preview = () => {
      clearTimeout(previewT);
      previewT = setTimeout(async () => {
        try {
          const r = await api('/api/app/schedules', { op: 'preview', schedule: { ...edit, name: edit.name || 'x', prompt: edit.prompt || 'x' } });
          nextBox.textContent = `${r.when}${r.next ? ` · next: ${WHEN.format(r.next)}` : ''}${r.inScopeText ? ` · ${r.inScopeText}` : r.inScope != null ? ` · ${r.inScope} project${r.inScope === 1 ? '' : 's'} in scope now` : ''}`;
          nextBox.classList.remove('bad');
        } catch (e) { nextBox.textContent = e.message; nextBox.classList.add('bad'); }
      }, 250);
    };
    const drawWhen = () => {
      const days = DAY_NAMES.map((d, i) => `<option value="${i}"${preset.d === i ? ' selected' : ''}>${d}</option>`).join('');
      whenBox.innerHTML = preset.kind === 'custom'
        ? `<input class="field small mono" id="seCron" value="${esc(edit.cron || '')}" placeholder="minute hour day month weekday" aria-label="Cron schedule" spellcheck="false">`
        : `${preset.kind === 'weekly' ? `<select class="field small" id="seDay" aria-label="Day">${days}</select>` : ''}
           ${preset.kind === 'hourly' ? `<label class="se-min">at minute <input class="field small mono" id="seMin" type="number" min="0" max="59" value="${preset.m ?? 0}"></label>` : `<input class="field small mono" id="seTime" type="time" value="${hhmm(preset)}" aria-label="Time">`}
           <code class="se-cron">${esc(edit.cron)}</code>`;
      const set = () => { edit.cron = cronOf(preset); const c = $('.se-cron', whenBox); if (c) c.textContent = edit.cron; touch(); preview(); };
      $('#seCron', whenBox)?.addEventListener('input', (e) => { edit.cron = e.target.value.trim(); touch(); preview(); });
      $('#seDay', whenBox)?.addEventListener('change', (e) => { preset.d = +e.target.value; set(); });
      $('#seMin', whenBox)?.addEventListener('input', (e) => { preset.m = Math.max(0, Math.min(59, +e.target.value || 0)); set(); });
      $('#seTime', whenBox)?.addEventListener('change', (e) => { const [hh, mm] = e.target.value.split(':').map(Number); preset.h = hh || 0; preset.m = mm || 0; set(); });
    };
    drawWhen(); preview();
    el.querySelectorAll('[data-pre]').forEach((b) => (b.onclick = () => {
      const k = b.dataset.pre;
      el.querySelectorAll('[data-pre]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
      if (k === 'custom') preset = { kind: 'custom' };
      else { preset = { kind: k, m: preset.m ?? 0, h: preset.h ?? 9, d: preset.d ?? 1 }; edit.cron = cronOf(preset); }
      touch(); drawWhen(); preview();
    }));
    $('#seName', el).oninput = (e) => { edit.name = e.target.value; touch(); };
    $('#seSkill', el).onchange = (e) => { edit.skill = e.target.value; touch(); };
    $('#sePrompt', el).oninput = (e) => { edit.prompt = e.target.value; touch(); };
    $('#seScope', el).onchange = (e) => { edit.scope = e.target.value; touch(); preview(); };
    el.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => {
      edit.mode = b.dataset.mode; touch();
      el.querySelectorAll('[data-mode]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
      $('#seHint', el).textContent = MODE_HINT[edit.mode];
    }));
    $('#seSave', el).onclick = async () => {
      try {
        const r = await api('/api/app/schedules', { op: 'save', schedule: edit });
        all = r; sel = r.saved; draft = null; dirty = false;
        toast(edit.id ? 'Saved.' : `Added: ${edit.name}. It runs ${r.schedules.find((x) => x.id === r.saved)?.when.toLowerCase() || 'on its schedule'}.`);
        await load();
      } catch (e) { toast(e.message); }
    };
    $('#seRun', el)?.addEventListener('click', async () => {
      if (dirty) { toast('Save your changes first, then run it.'); return; }
      try { all = await api('/api/app/schedules', { op: 'run', id: edit.id }); toast('Running now. It shows under Runs.'); await load(); } catch (e) { toast(e.message); }
    });
    $('#seStop', el)?.addEventListener('click', async () => { try { all = await api('/api/app/schedules', { op: 'stop', id: edit.id }); await load(); } catch (e) { toast(e.message); } });
    $('#seDel', el)?.addEventListener('click', async () => {
      if (!confirm(`Delete "${edit.name}"? Its past runs stay in Video Octopus's local folder.`)) return;
      try { all = await api('/api/app/schedules', { op: 'delete', id: edit.id }); sel = null; dirty = false; await load(false); } catch (e) { toast(e.message); }
    });
    el.querySelectorAll('[data-run]').forEach((b) => (b.onclick = () => openRun(edit.id, b.dataset.run)));
  }

  $('#schNew', main).onclick = () => {
    if (dirty && !confirm('Leave without saving your changes?')) return;
    draft = { name: '', skill: '', prompt: '', cron: '0 9 * * 1', scope: 'changed', mode: 'report', enabled: true };
    sel = null; dirty = true; runs = []; drawList(); drawEditor();
    $('#seName', ed)?.focus();
  };
  await load();
  return { teardown: () => { left = true; clearTimeout(poll); } };
}

// One run, read-only: the summary, what it touched, what Video Octopus refused, and the session as it happened.
async function openRun(id, run) {
  let d;
  try { d = await api(`/api/app/schedules/run?id=${encodeURIComponent(id)}&run=${encodeURIComponent(run)}`); } catch (e) { toast(e.message); return; }
  const r = d.run;
  const line = (ev) => {
    if (ev.t === 'user') return `<div class="rv-user"><span class="k">Video Octopus sent</span><pre>${esc(ev.text)}</pre></div>`;
    if (ev.t === 'text') return `<div class="rv-text md">${mdLite(ev.text)}</div>`;
    if (ev.t === 'tool') return `<div class="rv-tool"><span class="k">${esc(ev.name)}</span>${esc(ev.summary || '')}</div>`;
    if (ev.t === 'permission_done') return `<div class="rv-perm ${ev.outcome}">${ev.outcome === 'allowed' ? 'Allowed by the run’s mode' : 'Refused by the run’s mode'}</div>`;
    if (ev.t === 'permission') return `<div class="rv-tool ask"><span class="k">Asked</span>${esc(ev.tool)}: ${esc(ev.summary || '')}</div>`;
    if (ev.t === 'refused') return `<div class="rv-perm denied">Refused: ${esc(ev.tool)}${ev.summary ? ` (${esc(ev.summary)})` : ''}</div>`;
    if (ev.t === 'error') return `<div class="rv-err">${esc(ev.text)}</div>`;
    if (ev.t === 'note') return `<div class="rv-note">${esc(ev.text)}</div>`;
    return '';
  };
  const modal = $('#modal');
  const dlg = h(`<div class="dialog rv" role="dialog" aria-modal="true" aria-labelledby="rvTitle">
    <div class="rv-head"><div><h3 id="rvTitle">${esc(r.name)}</h3><div class="sub">${esc(WHEN.format(r.startedAt))}${r.endedAt ? ` · ${took(r)}` : ''} · ${esc(STATUS[r.status] || r.status)} · ${esc({ report: 'Report only', ask: 'Ask before changes', change: 'Make changes' }[r.mode] || r.mode)}</div></div>
      <button class="btn small ghost" data-x aria-label="Close">Close</button></div>
    ${r.summary ? `<div class="rv-sum md">${mdLite(r.summary)}</div>` : ''}
    <div class="rv-facts">
      ${r.projects?.length ? `<div><b>Projects</b><span>${r.projects.map(esc).join(', ')}</span></div>` : ''}
      ${r.takes?.length ? `<div><b>Recordings</b><span>${r.takes.map(esc).join(', ')}</span></div>` : ''}
      ${r.inbox?.length ? `<div><b>In the Library inbox</b><span class="mono">${r.inbox.map(esc).join('<br>')}</span></div>` : ''}
      ${r.refused?.length ? `<div><b>Refused by the mode</b><span>${r.refused.map((x) => `${esc(x.tool)}: ${esc(x.summary)}`).join('<br>')}</span></div>` : ''}
      ${r.tools?.length ? `<div><b>Tools used</b><span>${r.tools.length}</span></div>` : ''}
    </div>
    <details class="rv-log"${r.summary ? '' : ' open'}><summary>The session</summary><div>${d.events.map(line).join('') || '<span class="sub">No session log.</span>'}</div></details>
  </div>`);
  const close = () => { modal.hidden = true; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  modal.replaceChildren(dlg); modal.hidden = false;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  $('[data-x]', dlg).onclick = close;
  document.addEventListener('keydown', onKey);
}

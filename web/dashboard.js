// Dashboard: what's been made with Video Octopus. Totals are counted from the project folders
// themselves; features and the latest activity come from the usage log, a file that stays on this computer
// (server/usage.mjs). Nothing is sent anywhere.
import { $, esc, h, api, plural } from './ui.js';

let range = (() => { try { return localStorage.getItem('studio.dash.range') || 'all'; } catch { return 'all'; } })();
const RANGES = [['week', 'This week'], ['month', '30 days'], ['all', 'All time']];
const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' });
const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const when = (t) => `${DAY.format(t)} ${TIME.format(t)}`;
const hours = (s) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`);

export async function renderDashboard(main, { recordingsDir = '' } = {}) {
  main.replaceChildren(h(`<div class="home-wrap wide dash">
    <div class="home-head"><div class="hh-title"><h1>Dashboard</h1>
      <div class="sub">What you've made with Video Octopus, counted from your own folders and a usage log that stays on this computer.</div></div>
      <div class="seg dash-range" role="group" aria-label="Range">${RANGES.map(([k, l]) => `<button type="button" data-r="${k}"${k === range ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"'}>${l}</button>`).join('')}</div>
      <span class="dash-local" title="The usage log is a file in Video Octopus's local folder. Nothing is sent anywhere."><i></i>Stays on this computer</span>
    </div>
    <div id="dashBody" class="dash-body" aria-busy="true"><div class="sub">Counting…</div></div>
  </div>`));
  const body = $('#dashBody', main);
  const load = async () => {
    let d;
    try { await api('/api/app/dashboard/catch-up', {}).catch(() => {}); d = await api(`/api/app/dashboard?range=${range}`); } catch (e) { body.replaceChildren(h(`<div class="notice">Couldn't count: ${esc(e.message)}</div>`)); return; }
    body.removeAttribute('aria-busy');
    body.replaceChildren(dashView(d, recordingsDir));
  };
  main.querySelectorAll('[data-r]').forEach((b) => (b.onclick = () => {
    range = b.dataset.r;
    try { localStorage.setItem('studio.dash.range', range); } catch {}
    main.querySelectorAll('[data-r]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    load();
  }));
  await load();
}

function dashView(d, recordingsDir) {
  const T = d.totals, inRange = d.range !== 'all';
  const rangeWord = { week: 'this week', month: 'in 30 days' }[d.range] || '';
  const stats = [
    ['Videos finished', T.finished, 'projects with a final render'],
    ['Projects', T.projects, `${T.studio} made in Video Octopus, ${T.projects - T.studio} earlier edits`],
    ['Speech transcribed', T.speechSecs ? hours(T.speechSecs) : '0', `${plural(T.transcribed, 'project')} · transcribed on this computer`],
    inRange ? [`Renders ${rangeWord}`, T.rendersInRange, `${T.renders} in all`] : ['Renders', T.renders, 'video files in each project’s renders/'],
    ['Recordings', T.recordings, recordingsDir ? `in ${recordingsDir}` : 'takes from the recorder'],
    ['Notes sent to Claude', T.sent, `in change packages · ${plural(T.approved, 'scene')} approved`],
  ];
  const max = Math.max(1, ...d.perDay.map((x) => x.n));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const fmax = Math.max(1, ...d.features.map((f) => f.n));
  const el = h(`<div class="dash-grid">
    <div class="dash-stats">${stats.map(([t, n, s]) => `<div class="dash-stat"><span>${esc(t)}</span><b>${esc(String(n))}</b><small>${esc(s)}</small></div>`).join('')}</div>
    <section class="dash-card dash-chart"><div class="dash-cap"><b>Renders per day</b><span>last two weeks, from the files in each project’s renders/</span></div>
      <div class="bars" role="img" aria-label="${esc(d.perDay.map((x) => `${DAY.format(x.t)}: ${x.n}`).join(', '))}">${d.perDay.map((x) => `<div class="bar-c${x.t === today.getTime() ? ' today' : ''}"><span class="n">${x.n || ''}</span><i class="${x.n ? 'on' : ''}" style="height:${Math.max(2, Math.round((x.n / max) * 100))}%"></i><span class="d">${esc(DAY.format(x.t))}</span></div>`).join('')}</div>
    </section>
    <section class="dash-card dash-feats"><div class="dash-cap"><b>What you use most</b><span>${inRange ? rangeWord : 'all time'}, from the usage log</span></div>
      ${d.features.length ? `<div class="feats">${d.features.map((f) => `<div class="feat"><span>${esc(f.label)}</span><i><b style="width:${Math.round((f.n / fmax) * 100)}%"></b></i><span class="mono">${f.n}</span></div>`).join('')}</div>`
        : `<div class="empty small"><b>Nothing logged ${inRange ? rangeWord : 'yet'}</b><span class="sub">Cuts, scene notes, change packages, exports and skills show here as you use them.</span></div>`}
      <p class="sub dash-note">${d.logged ? `${plural(d.logged, 'action')} logged since ${esc(DAY.format(d.logSince || Date.now()))}.` : 'The log starts now.'} Earlier history is read from your project files. The log keeps counts and kinds only: no words, file names or footage.</p>
    </section>
    <section class="dash-card dash-act"><div class="dash-cap"><b>Latest activity</b><span>from the log</span></div>
      ${d.activity.length ? `<div class="act">${d.activity.map((a) => `<div class="act-r${a.past ? ' past' : ''}"><span class="mono">${esc(when(a.t))}</span><span class="k">${esc(a.label)}${a.n > 1 ? ` <small>×${a.n}</small>` : ''}</span><span>${esc(a.detail || '')}</span><span class="p">${esc(a.project || '')}</span>${a.past ? '<span class="badge" title="Read from the project files when the log started">from files</span>' : '<span></span>'}</div>`).join('')}</div>`
        : '<div class="empty small"><b>No activity yet</b></div>'}
    </section>
  </div>`);
  return el;
}

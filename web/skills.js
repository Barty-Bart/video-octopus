// Skills (#/skills, Direction A artboard 3): what the agent knows how to do. A filterable table with a real
// on/off switch per skill, and a detail panel for the selected one. Same API and dialogs as before
// (/api/learning/skills…): Read / edit, New skill, Import from GitHub, Refresh, Rebuild and database history.
import { $, esc, h, api, toast, confirmBox } from './ui.js';
import { addSkillsDialog } from './brand.js';
import { dialog, field, readOnlySkill, showMenu } from './learning.js';
import { channelHref } from './nav.js';

const E = '/api/learning';
const KIND = { core: 'Core', 'customized-core': 'Core · edited', personal: 'Mine', format: 'Format' };
const FILTERS = [['all', 'All'], ['core', 'Core'], ['mine', 'Mine'], ['formats', 'Formats']];
const DOTS = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>';

function inFilter(skill, filter) {
  if (filter === 'core') return skill.kind === 'core' || skill.kind === 'customized-core';
  if (filter === 'mine') return skill.kind === 'personal';
  if (filter === 'formats') return skill.kind === 'format';
  return true;
}
const skillName = (s) => (s.kind === 'format' ? s.label || `/${s.name}` : `/${s.name}`);
const versionText = (s) => (s.activeVersion ? `v${s.activeVersion}` : s.kind === 'personal' ? 'Personal' : '–');

export async function renderSkills(root, { counts = {} } = {}) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  let filter = FILTERS.some(([k]) => k === params.get('show')) ? params.get('show') : 'all';
  let selected = params.get('skill');
  let search = '';
  let data = { items: [], history: [] };
  let live = true;

  const writeAddress = () => {
    const query = new URLSearchParams();
    if (selected) query.set('skill', selected);
    if (filter !== 'all') query.set('show', filter);
    history.replaceState(null, '', `#/skills${query.size ? `?${query}` : ''}`);
  };
  const visible = () => data.items
    .filter((s) => inFilter(s, filter))
    .filter((s) => {
      const term = search.trim().toLowerCase();
      return !term || `${s.name} ${s.label || ''} ${s.summary || ''}`.toLowerCase().includes(term);
    });
  const run = (fn) => async (e) => {
    const b = e?.currentTarget;
    if (b) b.disabled = true;
    try { await fn(); } catch (err) { toast(err.message); } finally { if (b) b.disabled = false; }
  };

  root.replaceChildren(h(`<div class="home-wrap wide sk-page">
    <div class="page-head">
      <div class="ph-title">
        <h1>Skills</h1>
        <p class="sub">What your agent knows how to do. Core skills update with the app; your own edits are always kept.</p>
      </div>
      <div class="ph-actions">
        <button type="button" class="btn primary" data-a="create">New skill</button>
        <button type="button" class="btn" data-a="import">Import from GitHub</button>
        <button type="button" class="btn icon-btn" data-a="more" aria-haspopup="menu" aria-expanded="false" aria-label="More skill actions">${DOTS}</button>
      </div>
    </div>
    ${counts.skillUpdates > 0 ? `<a class="sk-update" href="#/settings/general/updates"><b>${counts.skillUpdates} core update${counts.skillUpdates === 1 ? '' : 's'} to review</b><span>Review</span></a>` : ''}
    <p class="learn-error" data-error hidden></p>
    <div class="sk-tools">
      <div class="seg sk-filter scroll-row" role="group" aria-label="Show skills" data-filters></div>
      <label class="search sk-search"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="6" cy="6" r="4.2"/><path d="M9.2 9.2l3 3"/></svg><span class="vh">Search skills</span><input type="search" placeholder="Search skills" autocomplete="off" data-search></label>
    </div>
    <div class="sk-body">
      <div class="sk-table-wrap"><table class="sk-table"><thead><tr><th scope="col">Skill</th><th scope="col">Kind</th><th scope="col">Version</th><th scope="col">On</th></tr></thead><tbody data-rows></tbody></table></div>
      <aside class="sk-detail" aria-live="polite" data-detail></aside>
    </div>
  </div>`));

  const rowsEl = $('[data-rows]', root), detailEl = $('[data-detail]', root);

  async function load() {
    data = await api(`${E}/skills`);
    if (!live) return;
    const error = $('[data-error]', root);
    error.hidden = !data.error;
    error.textContent = data.error || '';
    draw();
  }

  function drawFilters() {
    $('[data-filters]', root).innerHTML = FILTERS.map(([key, label]) => {
      const n = data.items.filter((s) => inFilter(s, key)).length;
      return `<button type="button" data-filter="${key}" class="${key === filter ? 'on' : ''}" aria-pressed="${key === filter}">${label} <span class="seg-n">${n}</span></button>`;
    }).join('');
  }

  function rowMarkup(s) {
    const on = s.id === selected;
    const control = s.kind === 'format'
      ? (s.formatId ? `<a class="btn small" href="${channelHref('_', 'formats', { format: s.formatId })}">Open format</a>` : '')
      : `<button type="button" class="switch" role="switch" aria-checked="${!s.disabled}" aria-label="${esc(skillName(s))} on" data-toggle="${esc(s.id)}"><i aria-hidden="true"></i></button>`;
    return `<tr class="${on ? 'on' : ''}${s.disabled ? ' off' : ''}" data-row="${esc(s.id)}">
      <td class="sk-name"><button type="button" class="sk-pick" data-pick="${esc(s.id)}" aria-pressed="${on}">
        <b class="mono">${esc(skillName(s))}</b><span class="sub">${esc(s.summary || (s.kind === 'format' ? 'Generated from this format’s active skill version.' : 'No short explanation yet.'))}</span></button></td>
      <td><span class="chip kind-${esc(s.kind)}">${esc(KIND[s.kind] || s.kind)}</span></td>
      <td class="mono sub">${esc(versionText(s))}</td>
      <td class="sk-on">${control}</td>
    </tr>`;
  }

  function detailMarkup(s) {
    if (!s) {
      return data.items.length
        ? '<div class="empty"><b>Nothing matches</b><span class="sub">Try another word or filter.</span></div>'
        : '<div class="empty"><b>No skills yet</b><span class="sub">Write your own with New skill, or import some from GitHub.</span><button type="button" class="btn primary" data-a="create">New skill</button></div>';
    }
    const kindLine = [KIND[s.kind] || s.kind, versionText(s) !== '–' ? versionText(s) : null, s.kind === 'format' ? null : s.disabled ? 'Off' : 'On'].filter(Boolean).join(' · ');
    const note = s.kind === 'customized-core'
      ? '<p class="sk-note">Your edits are kept when the app updates. Core changes arrive as an update to review.</p>'
      : s.kind === 'format'
        ? '<p class="sk-note">Generated from the format’s active skill version. Change it by talking to the format.</p>'
        : '';
    const actions = s.kind === 'format'
      ? `<button type="button" class="btn primary" data-open="${esc(s.id)}">Open</button>${s.formatId ? `<a class="btn" href="${channelHref('_', 'formats', { format: s.formatId })}">Open format</a>` : ''}`
      : `<button type="button" class="btn primary" data-open="${esc(s.id)}">Open</button><button type="button" class="btn" data-toggle="${esc(s.id)}">${s.disabled ? 'Enable' : 'Disable'}</button>`;
    return `<div class="sk-card">
      <p class="eyebrow">${esc(kindLine)}</p>
      <h2 class="mono">${esc(skillName(s))}</h2>
      ${s.kind === 'format' ? `<p class="sub mono">/${esc(s.name)}</p>` : ''}
      <p>${esc(s.summary || 'Open it to read the skill and add a short explanation.')}</p>
      ${s.reason ? `<p class="sub">${esc(s.reason)}</p>` : ''}
      ${note}
      <div class="learn-actions">${actions}</div>
    </div>`;
  }

  function draw() {
    drawFilters();
    const list = visible();
    if (!list.some((s) => s.id === selected)) selected = list[0]?.id || null;
    rowsEl.innerHTML = list.length
      ? list.map(rowMarkup).join('')
      : `<tr><td colspan="4"><div class="empty"><b>${data.items.length ? 'Nothing matches' : 'No skills yet'}</b></div></td></tr>`;
    detailEl.innerHTML = detailMarkup(data.items.find((s) => s.id === selected));
    writeAddress();
  }

  async function toggle(id) {
    const s = data.items.find((x) => x.id === id);
    if (!s) return;
    await api(`${E}/skills/${id}`, { action: s.disabled ? 'enable' : 'disable', revision: data.revision });
    await load();
  }

  async function open(id) {
    const s = data.items.find((x) => x.id === id);
    const x = await api(`${E}/skills/${id}`);
    if (s?.kind === 'format') return readOnlySkill(x);
    const hint = x.kind === 'core'
      ? 'Changing the workflow creates your own customized core version. Editing only the explanation keeps it Core.'
      : x.name.startsWith('learned-')
        ? 'This edits the reusable skill copy. Pinned projects retain their approved snapshot. To change approved rules, talk to the format in its channel.'
        : 'Saving creates a database revision.';
    dialog(`${x.name} · ${x.kind}`, `<p class="sub">${hint}</p>` + field('Short explanation (shown in the list)', 'summary', x.summary) + field('Skill Markdown', 'text', x.text, 'textarea'), async (form) => {
      await api(`${E}/skills/${id}`, { action: form.text === x.text ? 'describe' : 'edit', text: form.text, summary: form.summary, revision: x.revision });
      await load();
    });
  }

  function create() {
    dialog('New skill', field('Short explanation (shown in the list)', 'summary') + field('Skill Markdown', 'text', '---\nname: my-workflow\ndescription: Describe when this skill should be used.\n---\n\n# Workflow\n', 'textarea'), async (b) => {
      await api(`${E}/skills`, { action: 'create', text: b.text, summary: b.summary, revision: data.revision });
      await load();
    });
  }

  function historyDialog() {
    const body = h('<div class="sk-history"></div>');
    if (!data.history?.length) body.append(h('<p class="sub">No earlier database versions yet.</p>'));
    for (const v of data.history || []) {
      const row = h(`<div class="sk-history-row"><span>${esc(v.created)} · ${esc(v.reason)}</span><button type="button" class="btn small">Restore this version</button></div>`);
      $('button', row).onclick = run(async () => {
        if (!await confirmBox({ title: 'Restore skill version?', text: 'Current skills stay in database history. This older version will be held until you resume updates.', ok: 'Restore' })) return;
        await api(`${E}/skills`, { action: 'restore-sql', snapshot: v.id, revision: data.revision });
        row.closest('.cf-modal')?.querySelector('[data-a=no]')?.click();
        await load();
      });
      body.append(row);
    }
    confirmBox({ title: 'Skill database history', body, ok: 'Done', cancel: 'Close' });
  }

  const moreItems = () => [
    { label: 'Refresh / import file edits', run: async () => { await api(`${E}/skills`, { action: 'refresh', revision: data.revision }); await load(); } },
    { label: 'Rebuild agent files', run: async () => { await api(`${E}/skills`, { action: 'regenerate', revision: data.revision }); toast('Agent files rebuilt.'); await load(); } },
    { label: 'Update & compatibility review', href: '#/settings/general/updates' },
    '-',
    { label: 'Skill database history', run: historyDialog },
  ];

  root.onclick = async (e) => {
    const el = e.target.closest('[data-a],[data-filter],[data-pick],[data-toggle],[data-open]');
    if (!el || !root.contains(el)) return;
    if (el.dataset.a === 'create') return create();
    if (el.dataset.a === 'import') return addSkillsDialog({ onDone: () => load().catch((err) => toast(err.message)) });
    if (el.dataset.a === 'more') return showMenu(el, moreItems());
    if (el.dataset.filter) { filter = el.dataset.filter; draw(); return; }
    if (el.dataset.pick) {
      selected = el.dataset.pick;
      draw();
      // Narrow: the detail sits under the list, so bring it into view.
      if (matchMedia('(max-width: 980px)').matches) detailEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      $(`[data-pick="${CSS.escape(selected)}"]`, root)?.focus({ preventScroll: true });
      return;
    }
    if (el.dataset.toggle) return run(() => toggle(el.dataset.toggle))({ currentTarget: el });
    if (el.dataset.open) return run(() => open(el.dataset.open))({ currentTarget: el });
  };
  $('[data-search]', root).oninput = (e) => { search = e.target.value; draw(); };

  await load();
  return { teardown() { live = false; } };
}

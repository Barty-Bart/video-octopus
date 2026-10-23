// Settings → Updates: app-owned core skills, separate creator preferences, saved forks, comparison and recovery,
// optional non-skill starter files, and Open Video Octopus when I log in. settings.js draws the
// page's frame and passes its row/group/toggle helpers; markUpdateBadge puts "New" on the Updates entry.
import { esc, h, api, toast, ago, plural, confirmBox } from './ui.js';

const S = {}; // what the page last heard, so a redraw (the toggle's save) doesn't lose an update's or a sync's result

export function updatesSection(V, save, { row, group, toggle }) {
  const wrap = h('<div class="upd"></div>');
  wrap.append(group('Video Octopus', row('This copy', '', h('<div class="found"><span class="sub">Looking…</span></div>'))));
  const load = () => api('/api/app/updates').then((u) => { S.u = u; draw(); }).catch((e) => wrap.replaceChildren(h(`<div class="notice">${esc(e.message)}</div>`)));
  S.pulled = S.note = S.offline = S.synced = S.comparison = S.skillError = null;
  S.skillWorking = S.updating = false;

  const skillAction = async (action, item = {}, backup = null) => {
    if (S.skillWorking || S.updating) return;
    const revision = S.u.skills?.revision;
    S.skillWorking = true;
    S.skillError = null;
    draw();
    try {
      if (action === 'latest' && !(await confirmBox({
        title: `Use the latest core ${item.name}?`, ok: 'Use latest core',
        text: `Your custom version stays saved and can be selected again. Your preferences still apply.${item.dependencies?.length ? ` Requirements: ${item.dependencies.join(', ')}.` : ''} No packages or models will be installed automatically.`,
      }))) return;
      if (action === 'customize' && !(await confirmBox({
        title: `Make a custom version of ${item.name}?`, ok: 'Make custom version',
        text: 'For colours, tone, pacing and other supported options, use your studio preferences. A custom version is for changing the workflow itself: it stays separate and does not receive automatic changes to the core instructions.',
      }))) return;
      if (action === 'confirm-compatibility' && !(await confirmBox({
        title: 'Have you adapted this custom version?', ok: 'I reviewed compatibility',
        text: 'Compare with the latest core and update your saved files for the current app commands and file formats first. This records your review; it does not test, fix or merge instructions. It does not select a saved version that is currently inactive.',
      }))) return;
      if (action === 'restore' && !(await confirmBox({
        title: 'Restore this skills backup?', ok: 'Restore skills',
        text: 'This restores the skill files and choices from this backup. Your current skill files are backed up first. Projects, recordings and app settings are not restored or changed.',
      }))) return;
      const r = await api('/api/app/updates/skills', { action, id: item.id, revision, ...(backup ? { backup } : {}) });
      if (r.ok === false || r.error) throw new Error(r.error || 'The skill change could not be applied.');
      if (action === 'compare') S.comparison = r;
      else {
        S.u.skills = r.skills || r;
        // Refresh also follows on-disk preference repairs; never leave old diagnostics on screen.
        S.u = await api('/api/app/updates');
        S.comparison = null;
        toast(action === 'keep' ? 'Core update acknowledged; your selection is unchanged.' : action === 'latest' ? 'Core selected. Your custom version is saved.' : action === 'restore' ? 'Skills backup restored.' : action === 'refresh' ? 'Skills refreshed.' : 'Skill choices saved.');
      }
    } catch (e) {
      S.skillError = e.message;
      // A revision conflict can mean another tab changed the choices. Refresh before offering another action.
      try { S.u = await api('/api/app/updates'); } catch {}
    } finally { S.skillWorking = false; draw(); }
  };

  const draw = () => {
    const u = S.u, a = u.app;
    setUpdateBadge(document, a.behind || 0);
    // ---- this copy and its version ----
    const ver = `<b>Video Octopus ${esc(a.version || '')}</b>${a.clone ? `<span class="sub">${[a.commit && `<code>${esc(a.commit)}</code>`, a.date && esc(a.date), a.branch && (a.upstream ? `${esc(a.branch)}, follows ${esc(a.upstream)}` : esc(a.branch))].filter(Boolean).join(' · ')}</span>` : '<span class="sub">Not a git clone</span>'}`;
    const running = u.restart.needed ? `<span class="sub">Running ${esc(u.restart.running.commit || 'the old version')} until Video Octopus restarts.</span>` : '';
    const activity = u.activity || {}, unavailable = Boolean(activity.busy || S.skillWorking || S.updating);
    const parts = [row('This copy', 'App updates include the matching bundled skills. Your projects and personal skill versions are preserved.', h(`<div class="found"><span class="dot ok"></span>${ver}${running}</div>`))];
    // The Node.js running Video Octopus: updated by the creator, outside the app; a warning only, never a block.
    const rt = u.runtime;
    if (rt) parts.push(row('Node.js', 'Runs Video Octopus. Install updates from nodejs.org, then restart Video Octopus.',
      h(`<div class="found"><span class="dot ${rt.current ? 'ok' : 'warn'}"></span><b>Node.js ${esc(rt.version)}</b>${rt.current ? '' : `<span class="sub" role="status">${esc(rt.text)}</span>`}</div>`)));

    // ---- new version: check, list, update ----
    const card = h('<div class="found"></div>');
    const acts = h('<div class="upd-acts"></div>');
    const checkBtn = h('<button type="button" class="btn small">Check for updates</button>');
    const pullBtn = h('<button type="button" class="btn small dark">Update app and skills</button>');
    const blocked = a.reason && !a.behind;
    if (a.reason === 'not-clone') card.append(h(`<b>Updates by hand</b>`), h(`<span class="sub">${esc(a.text)} ${esc(a.how)}</span>`));
    else {
      if (S.pulled) card.append(h(`<span class="dot ok"></span>`), h(`<b>${esc(S.pulled.text)}</b>`), h(`<span class="sub">${u.restart.needed ? (u.restart.supervised ? 'Restart to finish activating the app and its bundled skills.' : 'Restart using your original launch method to finish activating the app and its bundled skills.') : 'The app and bundled skills are ready. Customized versions stay yours.'}</span>`));
      else if (S.offline) card.append(h(`<b>Couldn't reach ${esc((a.upstream || 'GitHub').split('/')[0])}</b>`), h(`<span class="sub">You may be offline${S.offline !== true ? ` (${esc(S.offline)})` : ''}. Nothing changed.</span>`));
      else if (blocked) card.append(h(`<b>${esc(a.text)}</b>`), h(`<span class="sub">${esc(a.how)}</span>`));
      else if (a.behind) {
        card.append(h(`<span class="dot ok" style="background:var(--accent)"></span>`), h(`<b>${plural(a.behind, 'new commit')} on ${esc(a.upstream)}</b>`),
          h(`<div class="sub"><ul class="upd-log">${a.commits.map((c) => `<li><code>${esc(c.hash)}</code><span title="${esc(c.subject)}">${esc(c.subject)}</span></li>`).join('')}${a.behind > a.commits.length ? `<li><span>… and ${a.behind - a.commits.length} more</span></li>` : ''}</ul></div>`));
        if (a.reason) card.append(h(`<span class="sub">${esc(a.text)} ${esc(a.how)}</span>`));
      } else card.append(h(`<b>Up to date</b>`), h(`<span class="sub">${u.lastCheck ? `Checked ${esc(ago(Date.parse(u.lastCheck)))}.` : 'Not checked yet.'}</span>`));
      if (S.note) card.append(h(`<span class="sub upd-note"><b>${esc(S.note.text || '')}</b> ${esc(S.note.how || '')}</span>`));
      acts.append(checkBtn);
      if (a.behind && !S.pulled) { pullBtn.disabled = !a.can || unavailable; acts.append(pullBtn); }
      card.append(acts);
    }
    checkBtn.disabled = S.skillWorking || S.updating;
    if (activity.busy) card.append(h(`<span class="sub" role="status">Finish the current work before updating or changing skills: ${esc((activity.reasons || []).join('; ') || 'the app is busy')}.</span>`));
    checkBtn.onclick = async () => {
      checkBtn.disabled = true; checkBtn.textContent = 'Checking…';
      try {
        const r = await api('/api/app/updates/check', {});
        S.u = await api('/api/app/updates');
        S.u.app = r.app; S.u.lastCheck = r.lastCheck;
        S.offline = r.app.offline ? (r.app.fetchError || true) : false; S.pulled = S.note = null;
      }
      catch (e) { toast(e.message); }
      draw();
    };
    pullBtn.onclick = async () => {
      if (S.updating || S.skillWorking) return;
      S.updating = true;
      for (const button of wrap.querySelectorAll('button')) button.disabled = true;
      pullBtn.disabled = true; checkBtn.disabled = true; pullBtn.textContent = 'Updating…';
      try {
        const r = await api('/api/app/updates/pull', {});
        if (r.error) throw new Error(r.error);
        if (r.updated) { S.pulled = r; S.note = null; toast(r.text); } else S.note = { text: r.text, how: r.how };
        S.offline = r.offline ? (r.fetchError || true) : false;
        if (r.restarting) {
          await waitForRestart(pullBtn, r.bootId || u.bootId, 'Update app and skills');
          return;
        }
        S.u = await api('/api/app/updates'); // where the folder stands now (no fetch)
      } catch (e) { S.note = { text: e.message }; toast(e.message); }
      finally { S.updating = false; draw(); }
    };
    parts.push(row('New version', 'Fetch the app and its bundled skills together. When launched with start.sh or start.cmd, the app restarts to finish the update after current work is idle.', card));

    // ---- restart ----
    if (u.restart.needed || S.pulled) {
      if (u.restart.supervised) {
        const b = h('<button type="button" class="btn dark">Restart Video Octopus</button>');
        b.disabled = S.skillWorking || S.updating || (activity.busy && !u.restartPending);
        b.onclick = () => restart(b, u.bootId);
        parts.push(row('Restart', 'Restart after current work finishes. Conversations remain available; unfinished work is not automatically replayed.', b));
      } else parts.push(row('Restart', '', h(`<div class="notice small">${esc(u.restart.how)}</div>`)));
    }
    parts.push(row('Check when Video Octopus starts', 'At most once a day, quietly: a small "New" on Settings when there is an update. Offline it says nothing. Only git fetch talks to GitHub.',
      toggle(u.auto, (on) => save('updates', { auto: on }).then(() => { u.auto = on; }))));

    // ---- starter files ----
    const st = u.starter || { ok: false, text: 'No additional starter files.' };
    const sc = h('<div class="found"></div>');
    const list = (title, files, note = '') => (files?.length ? `<li><b>${title}</b>${note ? ` <span>${note}</span>` : ''}<span class="upd-files">${files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</span></li>` : '');
    if (!st.ok) sc.append(h(`<span class="sub">${esc(st.text)}</span>`));
    else {
      if (S.synced && !st.pending) sc.append(h('<span class="dot ok"></span>'), h('<b>Starter files updated</b>'), h(`<span class="sub">${esc(S.synced)}</span>`));
      else sc.append(h(`<b>${esc(st.pending ? `${plural(st.pending, 'change')} from the starter` : 'Up to date')}</b>`), h(`<span class="sub">${esc(st.text)}</span>`));
      if (st.pending) {
        sc.append(h(`<div class="sub"><ul class="upd-log upd-starter">${list('Update', st.update, '(unchanged by you)')}${list('Add', st.add, '(new in the starter)')}${list('Keep yours', st.keep, '(the new version goes in .studio/updates/)')}${list('Stay deleted', st.deleted, '(you deleted them)')}</ul></div>`));
        const go = h('<button type="button" class="btn small dark">Update starter files</button>');
        go.disabled = unavailable;
        go.onclick = async () => {
          go.disabled = true;
          try {
            const r = await api('/api/app/updates/starter', { apply: true });
            S.synced = r.text; toast(r.text);
            S.u.starter = await api('/api/app/updates/starter', {}); // the dry run again: what's left (nothing, normally)
          } catch (e) { toast(e.message); }
          draw();
        };
        const a2 = h('<div class="upd-acts"></div>'); a2.append(go); sc.append(a2);
      }
      if (st.waiting?.length) sc.append(h(`<div class="sub">Waiting in <code>.studio/updates/</code>: ${st.waiting.map((f) => `<code>${esc(f)}</code>`).join(' ')}. Compare each with yours, keep what you like, then delete it there.</div>`));
    }
    const starter = group('Other starter files', row('Optional studio templates', 'Core skills update with the app. This separate action updates studio instructions and library templates. Your preferences, memory and brand/style files are excluded.', sc));

    // ---- managed defaults and personal versions ----
    const skills = u.skills, skillRows = [];
    if (!skills?.ok) {
      skillRows.push(row('Skills', '', h(`<div class="notice small" role="alert">${esc(S.skillError || skills?.error || 'Skills are not available yet.')}</div>`)));
    } else {
      const summary = h('<div class="found"></div>');
      summary.append(h(`<b>${skills.pending ? `${esc(plural(skills.pending, 'skill'))} to review` : 'Your skill choices are up to date'}</b>`),
        h('<span class="sub">Core instructions follow app releases. Your preferences and custom skills belong to you. Saved custom versions stay separate; updates never merge instructions into them.</span>'));
      if (skills.held) summary.append(h(`<span class="notice small" role="status">${esc(skills.holdReason || 'A previous skill snapshot is restored. Resume skill updates when you are ready.')}</span>`));
      if (skills.recovery) summary.append(h(`<span class="sub" role="status">${esc(skills.recovery)}</span>`));
      if (S.skillError) summary.append(h(`<span class="notice small" role="alert">${esc(S.skillError)}</span>`));
      skillRows.push(row('Skill updates', '', summary));
      for (const item of skills.items || []) {
        const box = h('<div class="found"></div>');
        const kind = item.mode === 'override' ? 'Custom version selected' : item.mode === 'custom' ? 'Your own skill' : 'Core selected';
        box.append(h(`<b>${esc(kind)}${item.activeVersion ? ` · ${item.mode === 'override' ? 'based on ' : ''}${esc(item.activeVersion)}` : ''}${item.disabled ? ' · Disabled' : item.compatibilityBlocked && item.mode === 'override' ? ' · Paused for review' : ''}</b>`));
        if (item.availableVersion) box.append(h(`<span class="sub">Available core: ${esc(item.availableVersion)}${item.forkAvailable ? ` · Saved custom version: ${item.forkVersion ? `based on ${esc(item.forkVersion)}` : 'original version unknown'}` : ''}.</span>`));
        if (item.removed) box.append(h('<span class="sub">This skill is no longer bundled with the app. Your saved version is preserved.</span>'));
        if (item.reason) box.append(h(`<span class="${item.pending ? 'notice small' : 'sub'}">${esc(item.reason)}</span>`));
        if (item.mode === 'default' && item.compatibilityReason) box.append(h(`<span class="sub">Saved custom version: ${esc(item.compatibilityReason)} Core remains selected.</span>`));
        if (item.dependencies?.length) box.append(h(`<span class="sub">Requires: ${esc(item.dependencies.join(', '))}. Updates do not install packages or download models.</span>`));
        if (item.overridePath) box.append(h(`<span class="sub">Your version is saved in SQLite. Edit it in <a href="#/skills">Skills</a>. Working copy: <code>${esc(item.overridePath)}</code></span>`));
        const buttons = h('<div class="upd-acts"></div>');
        const add = (label, action, dark = false) => {
          const b = h(`<button type="button" class="btn small${dark ? ' dark' : ''}">${esc(label)}</button>`);
          b.disabled = action === 'compare' ? (S.skillWorking || S.updating) : (unavailable || skills.held);
          if (skills.held && action !== 'compare') b.title = 'Resume skill updates before changing this selection.';
          b.onclick = () => skillAction(action, item);
          buttons.append(b);
        };
        if (item.mode === 'override' && item.pending && !item.compatibilityBlocked) add('Keep my version', 'keep');
        if (item.canUseLatest && (item.mode === 'override' || item.pending)) add('Use latest core', 'latest', true);
        if (item.forkAvailable) add('Compare with core', 'compare');
        if (item.forkAvailable && item.compatibilityBlocked) add('I reviewed compatibility…', 'confirm-compatibility');
        if (item.mode === 'default' && item.forkAvailable && !item.compatibilityBlocked) add('Use my custom version', 'use-custom');
        if (item.mode === 'default' && !item.removed && !item.forkAvailable) add('Make a custom version…', 'customize');
        if ((!item.removed || item.mode !== 'default') && !(item.disabled && item.mode === 'override' && item.compatibilityBlocked)) add(item.disabled ? 'Enable' : 'Disable', item.disabled ? 'enable' : 'disable');
        box.append(buttons);
        skillRows.push(row(esc(item.name || item.id), '', box));
      }
      if (!(skills.items || []).length) skillRows.push(row('No skills yet', 'New bundled skills appear with app updates.', h('<span class="sub">Personal skills stay yours.</span>')));
      if (S.comparison) skillRows.push(row('Compare versions', 'Read the files side by side. Nothing is merged or replaced here.', comparisonView(S.comparison, () => { S.comparison = null; draw(); })));
    }
    const refreshSkills = h(`<button type="button" class="btn small${skills?.held ? ' dark' : ''}">${skills?.held ? 'Resume skill updates' : 'Refresh skills'}</button>`);
    refreshSkills.disabled = unavailable;
    refreshSkills.onclick = () => skillAction('refresh');
    skillRows.push(row(skills?.held ? 'Resume updates' : 'Refresh edited skills',
      skills?.held
        ? 'Resume updates from the installed app while preserving your personal versions. The restored snapshot is backed up before any change.'
        : 'After editing or moving skill files, refresh to preserve your changes and prepare the active versions for the assistant.',
      refreshSkills));
    if (skills?.backups?.length) {
      const list = h('<div class="found"></div>');
      list.append(h('<span class="sub">Backups preserve skill files and choices before changes. Restoring also backs up the current versions.</span>'));
      for (const backup of skills.backups) {
        const line = h('<div class="upd-acts"></div>');
        const at = typeof backup.at === 'number' ? backup.at : Date.parse(backup.at);
        line.append(h(`<span class="sub">${esc(Number.isFinite(at) ? new Date(at).toLocaleString() : backup.id)}${backup.reason ? ` · ${esc(backup.reason)}` : ''}</span>`));
        if (backup.restorable) {
          const b = h('<button type="button" class="btn small">Restore backup</button>');
          b.disabled = unavailable;
          b.onclick = () => skillAction('restore', {}, backup.id);
          line.append(b);
        } else line.append(h(`<span class="sub">Original files retained in <code>.studio/skill-manager/backups/${esc(backup.id)}/</code> for manual recovery.</span>`));
        list.append(line);
      }
      skillRows.push(row('Recovery', '', list));
    }
    const skillGroup = group('Core and personal skills', ...skillRows);
    const preferenceDetails = h('<div class="found"><span class="sub">Supported skill options live in <code>preferences/skills.json</code> inside your studio. Broader creative notes stay in <code>memory/preferences.md</code>, <code>memory/style.md</code>, <code>BRAND.md</code> and <code>STYLE.md</code>. App and starter updates leave these files alone. Ask the assistant to change a supported option; it reads the file again on your next turn.</span><a class="btn small" href="#/settings/brand">Brand and style</a></div>');
    if (u.preferences) {
      preferenceDetails.prepend(h(`<b>${u.preferences.status === 'invalid' ? 'Preferences need attention' : u.preferences.status === 'valid' ? 'Your skill options are valid' : 'Using core option defaults'}</b>`));
      for (const issue of u.preferences.diagnostics || []) preferenceDetails.append(h(`<span class="notice small" role="status">${esc(issue.path)}: ${esc(issue.message)}</span>`));
    }
    const preferences = group('Your preferences', row('Style and supported options',
      'Use preferences for everyday changes. Make a custom skill version only when the workflow itself needs to change.',
      preferenceDetails));

    // ---- open when I log in ----
    const L = u.login;
    const where = { darwin: `a LaunchAgent, ${L.shown}`, win32: `Video Octopus.cmd in your Startup folder`, linux: `${L.shown}` }[L.platform] || L.shown;
    const hint = `Starts Video Octopus in the background when you log in, without opening the browser (${esc(where)}; its log: ${esc(L.log)}). Off removes the file.${L.platform === 'darwin' ? ' macOS may show a "Background item added" notice.' : ''}`;
    const sw = toggle(L.on, async (on) => {
      try { S.u.login = await api('/api/app/updates/login', { on }); toast(on ? 'Video Octopus will open when you log in.' : 'Video Octopus won\'t open by itself any more.'); } catch (e) { toast(e.message); }
      draw();
    });
    const login = group('Start', row('Open Video Octopus when I log in', L.on && !L.here ? `${hint} <b>It starts another copy of Video Octopus now</b>: switch it off and on to point it at this one.` : hint, sw));

    wrap.replaceChildren(group('Video Octopus', ...parts), preferences, skillGroup, starter, login);
  };
  load();
  return wrap;
}

// Restart: the server exits and start.sh / start.cmd start it again; the page waits for the new one, then reloads.
async function restart(btn, bootId) {
  btn.disabled = true; btn.textContent = 'Restarting…';
  try {
    const r = await api('/api/app/updates/restart', {});
    if (!r.restarting) { toast(r.how); btn.disabled = false; btn.textContent = 'Restart Video Octopus'; return; }
  } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Restart Video Octopus'; return; }
  await waitForRestart(btn, bootId, 'Restart Video Octopus');
}

// Update already requested a restart: only poll here, never send a second restart request.
async function waitForRestart(btn, bootId, label) {
  btn.disabled = true; btn.textContent = 'Restarting…';
  const end = Date.now() + 90e3;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 800));
    try { const u = await api('/api/app/updates'); if (u.bootId && u.bootId !== bootId) return location.reload(); } catch {}
  }
  btn.textContent = label; btn.disabled = false;
  toast('Video Octopus didn\'t come back. Start it again with start.sh (Mac) or start.cmd (Windows).');
}

function comparisonView(comparison, close) {
  const box = h('<div></div>');
  box.append(h(`<b>${esc(comparison.name || 'Skill versions')}</b>`));
  if (comparison.note) box.append(h(`<p class="sub">${esc(comparison.note)}</p>`));
  if (comparison.truncated) box.append(h('<p class="notice small">Only the first portion of this comparison is shown. The complete files remain available in your skill folders and backups.</p>'));
  const done = h('<button type="button" class="btn small">Close comparison</button>');
  done.onclick = close; box.append(done);
  for (const file of comparison.files || []) {
    const section = h('<details></details>');
    const title = document.createElement('summary');
    title.textContent = `${file.path} · ${file.status || 'changed'}`;
    section.append(title);
    if (file.binary || file.tooLarge) {
      const message = document.createElement('p');
      message.className = 'sub';
      message.textContent = file.binary ? 'Binary file: compare the saved files using a suitable application.' : 'This file is too large for the inline comparison. The complete saved versions are preserved.';
      section.append(message);
    } else {
      const columns = document.createElement('div');
      columns.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;max-width:100%;';
      for (const [label, value] of [['Your version', file.status === 'added' ? null : file.mine], ['Latest bundled version', file.status === 'removed' ? null : file.latest]]) {
        const column = document.createElement('div'), heading = document.createElement('b'), pre = document.createElement('pre');
        column.style.minWidth = '0';
        heading.textContent = label;
        pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;font-size:12px;';
        pre.textContent = value == null ? '(file absent)' : String(value);
        column.append(heading, pre); columns.append(column);
      }
      section.append(columns);
    }
    box.append(section);
  }
  if (!(comparison.files || []).length) box.append(h('<p class="sub">No file differences.</p>'));
  return box;
}

// Only app updates get a New badge. Skill review notices remain inside Updates.
let badgeRevision = 0;
export function setUpdateBadge(nav, count) {
  badgeRevision++;
  nav.querySelectorAll('a[href="#/settings/updates"]').forEach(a => {
    const existing = a.querySelector('.n');
    if (!(count > 0)) { existing?.remove(); return; }
    if (!existing) a.append(h('<span class="n wait" title="An app update is available">New</span>'));
  });
}
export function markUpdateBadge(nav) {
  const revision = ++badgeRevision;
  return api('/api/app/counts').then(c => {
    if (revision === badgeRevision) setUpdateBadge(nav, c?.update || 0);
  }).catch(() => {});
}

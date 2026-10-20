// Settings → Updates (server/updates.mjs): Video Octopus's own update from GitHub (Check, Update, Restart), the starter files
// in your studio (a dry run first, then Update starter files), and Open Video Octopus when I log in. settings.js draws the
// page's frame and passes its row/group/toggle helpers; markUpdateBadge puts "New" on the Updates entry.
import { esc, h, api, toast, ago, plural } from './ui.js';

const S = {}; // what the page last heard, so a redraw (the toggle's save) doesn't lose an update's or a sync's result

export function updatesSection(V, save, { row, group, toggle }) {
  const wrap = h('<div class="upd"></div>');
  wrap.append(group('Video Octopus', row('This copy', '', h('<div class="found"><span class="sub">Looking…</span></div>'))));
  const load = () => api('/api/app/updates').then((u) => { S.u = u; draw(); }).catch((e) => wrap.replaceChildren(h(`<div class="notice">${esc(e.message)}</div>`)));
  S.pulled = S.note = S.offline = S.synced = null; // a fresh visit starts from what the server says

  const draw = () => {
    const u = S.u, a = u.app;
    // ---- this copy and its version ----
    const ver = `<b>Video Octopus ${esc(a.version || '')}</b>${a.clone ? `<span class="sub">${[a.commit && `<code>${esc(a.commit)}</code>`, a.date && esc(a.date), a.branch && (a.upstream ? `${esc(a.branch)}, follows ${esc(a.upstream)}` : esc(a.branch))].filter(Boolean).join(' · ')}</span>` : '<span class="sub">Not a git clone</span>'}`;
    const running = u.restart.needed ? `<span class="sub">Running ${esc(u.restart.running.commit || 'the old version')} until Video Octopus restarts.</span>` : '';
    const parts = [row('This copy', 'The version in the app folder. Your studio is a separate folder: updates never touch it.', h(`<div class="found"><span class="dot ok"></span>${ver}${running}</div>`))];

    // ---- new version: check, list, update ----
    const card = h('<div class="found"></div>');
    const acts = h('<div class="upd-acts"></div>');
    const checkBtn = h('<button type="button" class="btn small">Check for updates</button>');
    const pullBtn = h('<button type="button" class="btn small dark">Update now</button>');
    const blocked = a.reason && !a.behind;
    if (a.reason === 'not-clone') card.append(h(`<b>Updates by hand</b>`), h(`<span class="sub">${esc(a.text)} ${esc(a.how)}</span>`));
    else {
      if (S.pulled) card.append(h(`<span class="dot ok"></span>`), h(`<b>${esc(S.pulled.text)}</b>`), h(`<span class="sub">${u.restart.supervised ? 'Restart Video Octopus to use the new version.' : 'Start Video Octopus again to use the new version (see Restart below).'}${S.pulled.starter ? ' It brought new starter files: see Starter files below.' : ''}</span>`));
      else if (S.offline) card.append(h(`<b>Couldn't reach ${esc((a.upstream || 'GitHub').split('/')[0])}</b>`), h(`<span class="sub">You may be offline${S.offline !== true ? ` (${esc(S.offline)})` : ''}. Nothing changed.</span>`));
      else if (blocked) card.append(h(`<b>${esc(a.text)}</b>`), h(`<span class="sub">${esc(a.how)}</span>`));
      else if (a.behind) {
        card.append(h(`<span class="dot ok" style="background:var(--accent)"></span>`), h(`<b>${plural(a.behind, 'new commit')} on ${esc(a.upstream)}</b>`),
          h(`<div class="sub"><ul class="upd-log">${a.commits.map((c) => `<li><code>${esc(c.hash)}</code><span title="${esc(c.subject)}">${esc(c.subject)}</span></li>`).join('')}${a.behind > a.commits.length ? `<li><span>… and ${a.behind - a.commits.length} more</span></li>` : ''}</ul></div>`));
        if (a.reason) card.append(h(`<span class="sub">${esc(a.text)} ${esc(a.how)}</span>`));
      } else card.append(h(`<b>Up to date</b>`), h(`<span class="sub">${u.lastCheck ? `Checked ${esc(ago(Date.parse(u.lastCheck)))}.` : 'Not checked yet.'}</span>`));
      if (S.note) card.append(h(`<span class="sub upd-note"><b>${esc(S.note.text || '')}</b> ${esc(S.note.how || '')}</span>`));
      acts.append(checkBtn);
      if (a.behind && !S.pulled) { pullBtn.disabled = !a.can; acts.append(pullBtn); }
      card.append(acts);
    }
    checkBtn.onclick = async () => {
      checkBtn.disabled = true; checkBtn.textContent = 'Checking…';
      try { const r = await api('/api/app/updates/check', {}); S.u.app = r.app; S.u.lastCheck = r.lastCheck; S.offline = r.app.offline ? (r.app.fetchError || true) : false; S.pulled = S.note = null; }
      catch (e) { toast(e.message); }
      draw();
    };
    pullBtn.onclick = async () => {
      pullBtn.disabled = true; checkBtn.disabled = true; pullBtn.textContent = 'Updating…';
      try {
        const r = await api('/api/app/updates/pull', {});
        if (r.updated) { S.pulled = r; S.note = null; toast(r.text); } else S.note = { text: r.text, how: r.how };
        S.offline = r.offline ? (r.fetchError || true) : false;
        S.u = await api('/api/app/updates'); // where the folder stands now (no fetch)
      } catch (e) { toast(e.message); }
      draw();
    };
    parts.push(row('New version', 'Video Octopus asks GitHub with git and updates with git pull. Nothing about you or your studio is sent.', card));

    // ---- restart ----
    if (u.restart.needed || S.pulled) {
      if (u.restart.supervised) {
        const b = h('<button type="button" class="btn dark">Restart Video Octopus</button>');
        b.onclick = () => restart(b, u.bootId);
        parts.push(row('Restart', 'Video Octopus runs the old version until it restarts. Running chats stop; their conversations stay.', b));
      } else parts.push(row('Restart', '', h(`<div class="notice small">${esc(u.restart.how)}</div>`)));
    }
    parts.push(row('Check when Video Octopus starts', 'At most once a day, quietly: a small "New" on Settings when there is an update. Offline it says nothing. Only git fetch talks to GitHub.',
      toggle(u.auto, (on) => save('updates', { auto: on }).then(() => { u.auto = on; }))));

    // ---- starter files ----
    const st = u.starter;
    const sc = h('<div class="found"></div>');
    const list = (title, files, note = '') => (files?.length ? `<li><b>${title}</b>${note ? ` <span>${note}</span>` : ''}<span class="upd-files">${files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</span></li>` : '');
    if (!st.ok) sc.append(h(`<span class="sub">${esc(st.text)}</span>`));
    else {
      if (S.synced && !st.pending) sc.append(h('<span class="dot ok"></span>'), h('<b>Starter files updated</b>'), h(`<span class="sub">${esc(S.synced)}</span>`));
      else sc.append(h(`<b>${esc(st.pending ? `${plural(st.pending, 'change')} from the starter` : 'Up to date')}</b>`), h(`<span class="sub">${esc(st.text)}</span>`));
      if (st.pending) {
        sc.append(h(`<div class="sub"><ul class="upd-log upd-starter">${list('Update', st.update, '(unchanged by you)')}${list('Add', st.add, '(new in the starter)')}${list('Keep yours', st.keep, '(the new version goes in .studio/updates/)')}${list('Stay deleted', st.deleted, '(you deleted them)')}</ul></div>`));
        const go = h('<button type="button" class="btn small dark">Update starter files</button>');
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
    const starter = group('Starter files', row('Your studio', 'What Create my studio copied (CLAUDE.md, skills, the Cut Editor) gets better with updates. Files you never changed are updated; yours stay as they are, with the new version next to them. Files you deleted stay deleted.', sc));

    // ---- open when I log in ----
    const L = u.login;
    const where = { darwin: `a LaunchAgent, ${L.shown}`, win32: `Video Octopus.cmd in your Startup folder`, linux: `${L.shown}` }[L.platform] || L.shown;
    const hint = `Starts Video Octopus in the background when you log in, without opening the browser (${esc(where)}; its log: ${esc(L.log)}). Off removes the file.${L.platform === 'darwin' ? ' macOS may show a "Background item added" notice.' : ''}`;
    const sw = toggle(L.on, async (on) => {
      try { S.u.login = await api('/api/app/updates/login', { on }); toast(on ? 'Video Octopus will open when you log in.' : 'Video Octopus won\'t open by itself any more.'); } catch (e) { toast(e.message); }
      draw();
    });
    const login = group('Start', row('Open Video Octopus when I log in', L.on && !L.here ? `${hint} <b>It starts another copy of Video Octopus now</b>: switch it off and on to point it at this one.` : hint, sw));

    wrap.replaceChildren(group('Video Octopus', ...parts), starter, login);
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
  const end = Date.now() + 90e3;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 800));
    try { const u = await api('/api/app/updates'); if (u.bootId && u.bootId !== bootId) return location.reload(); } catch {}
  }
  btn.textContent = 'Restart Video Octopus'; btn.disabled = false;
  toast('Video Octopus didn\'t come back. Start it again with start.sh (Mac) or start.cmd (Windows).');
}

// "New" on the Updates entry in Settings' list when the quiet check found something.
export function markUpdateBadge(nav) {
  api('/api/app/counts').then((c) => {
    const a = nav.querySelector('a[href="#/settings/updates"]');
    if (c?.update && a && !a.querySelector('.n')) a.append(h(`<span class="n wait" title="${esc(plural(c.update, 'new commit'))} for Video Octopus">New</span>`));
  }).catch(() => {});
}

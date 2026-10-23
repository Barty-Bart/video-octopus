// Updates (Settings → Updates): the app updating itself from GitHub with git (fetch, then pull --ff-only in the app
// folder), the restart after it, a quiet check when Video Octopus starts (at most once a day; only the git fetch, nothing
// else is sent), plus the routes for the starter sync (starter-sync.mjs) and the log-in switch (login-item.mjs).
// Restart: start.sh and start.cmd run the server in a loop and set STUDIO_SUPERVISED=1; the server exits with
// RESTART_CODE and the loop starts it again. Started any other way, Restart says how to start Video Octopus again.
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { APP_DIR, LOCAL_DIR, readJSON, writeJSON, childPathEnv, tildePath, IS_WIN, settings } from './util.mjs';
import { section, settingsChanged } from './settings.mjs';
import { starterView, applyStarter } from './starter-sync.mjs';
import { loginState, setLogin } from './login-item.mjs';
import { syncSkills, skillsView, compareSkill } from './managed-skills.mjs';
import { readSkillPreferences } from './skill-preferences.mjs';
import { activityView, beginMaintenance, endMaintenance, maintenanceActive } from './maintenance.mjs';
import runtime from './runtime-check.cjs';

export const RESTART_CODE = 75;
const CACHE = join(LOCAL_DIR, 'updates.json'); // the last quiet check: { checkedAt, triedAt, offline, behind }
const DAY = 24 * 3600e3;
let skillError = null;
let restartPending = false;

// Run before accepting requests after every launch (including a crash/restart during an update).
// Only hash-owned helper scripts auto-sync. Preferences, instructions, library and projects do not.
export function activateStudioSkills() {
  const studio = settings().studio;
  if (!studio) return;
  try {
    applyStarter(studio, { prefixes: ['tools/'] });
    const result = syncSkills({ studio });
    skillError = result.ok ? null : result.error;
    const cache = readJSON(CACHE, {});
    if (cache.pending && !skillError) writeJSON(CACHE, { ...cache, pending: null, activatedAt: new Date().toISOString() });
    return result;
  } catch (e) { skillError = e.message; console.error('skill activation:', e.message); return { ok: false, error: e.message }; }
}
export function managedSkillsView() {
  const view = skillsView({ studio: settings().studio });
  return skillError ? { ...view, ok: false, error: skillError, pending: Math.max(1, view.pending) } : view;
}

// git in a folder, never asking for a password (no terminal here): a remote that wants one simply fails. The output is
// trimmed only at the end (git status lines start with a space).
async function git(dir, args, ms = 15000) {
  const env = await childPathEnv({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' });
  return new Promise((done) => execFile('git', ['-C', dir, ...args], { env, timeout: ms, windowsHide: true, maxBuffer: 8e6 }, (err, out, errOut) =>
    done({ ok: !err, out: String(out || '').trimEnd(), err: String(errOut || '').trim() || (err ? (err.killed ? 'timed out' : err.message) : '') })));
}
const lastLine = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
const real = (p) => { try { p = realpathSync.native(p); } catch {} return IS_WIN ? p.toLowerCase() : p; };
const pkgVersion = (dir) => readJSON(join(dir, 'package.json'), {})?.version || null;
const shell = IS_WIN ? 'PowerShell' : 'Terminal';

// Is `dir` a git clone of its own (not a zip download, not a folder inside some other repo), and where does it stand?
export async function repoInfo(dir = APP_DIR) {
  const version = pkgVersion(dir);
  if (!existsSync(join(dir, '.git'))) return { clone: false, version };
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok || real(top.out) !== real(dir)) return { clone: false, version };
  const [head, branch, up, date] = await Promise.all([git(dir, ['rev-parse', 'HEAD']), git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']), git(dir, ['log', '-1', '--format=%cs'])]);
  return { clone: true, version, head: head.ok ? head.out : null, commit: head.ok ? head.out.slice(0, 7) : null, date: date.ok ? date.out : null,
    branch: branch.ok ? branch.out : null, upstream: up.ok ? up.out : null };
}

// Files the app folder changed itself (tracked ones: local/ and other ignored files don't count).
async function localChanges(dir) {
  const r = await git(dir, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no']);
  return r.ok ? r.out.split('\n').filter(Boolean).map((l) => l.slice(3)).slice(0, 20) : [];
}

// Why this copy can't update with one button, and what to do instead.
function blocked(r, dir, { dirty = [], ahead = 0 } = {}) {
  const cd = `cd "${dir}"`, and = IS_WIN ? '; ' : ' && '; // Windows PowerShell 5 has no &&
  if (!r.clone) return { reason: 'not-clone', text: 'This copy of Video Octopus isn\'t a git clone (a zip download, for example), so it can\'t update itself.',
    how: `To update by hand: download the new version from the GitHub page you got Video Octopus from, unzip it, and copy your local folder (${tildePath(join(dir, 'local'))}: settings and chats) into the new folder. Your studio lives outside the app, so nothing else moves. Next time, git clone the repo instead: then Update works here.` };
  if (!r.branch) return { reason: 'detached', text: 'This copy is on a fixed commit, not on a branch, so there is nothing to follow.',
    how: `In ${shell}: ${cd}${and}git checkout main, then Check again.` };
  if (!r.upstream) return { reason: 'no-upstream', text: `The branch ${r.branch} doesn't follow a branch on GitHub.`,
    how: `In ${shell}: ${cd}${and}git branch --set-upstream-to=origin/${r.branch}, then Check again.` };
  if (dirty.length) return { reason: 'local-changes', text: `The app folder has changes of its own (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}), so Video Octopus won't update over them.`,
    how: `To keep them, in ${shell}: ${[cd, 'git stash', 'git pull --ff-only', 'git stash pop'].join(and)}. To drop them: ${cd}${and}git checkout -- . (then update here).` };
  if (ahead) return { reason: 'diverged', text: `This copy has ${ahead} commit${ahead === 1 ? '' : 's'} of its own that ${r.upstream} doesn't have, so a plain update can't apply.`,
    how: `In ${shell}: ${cd}${and}git pull --rebase (or ask the Video Octopus assistant to help).` };
  return null;
}

// Fetch (unless fetch: false: then from what git fetched last) and compare with the branch on GitHub.
export async function checkUpdates(dir = APP_DIR, { fetch = true } = {}) {
  const r = await repoInfo(dir);
  const out = { ...r, checkedAt: new Date().toISOString(), behind: 0, ahead: 0, commits: [], dirty: [], offline: false };
  const stop = blocked(r, dir);
  if (stop) return { ...out, can: false, ...stop };
  if (fetch) {
    const f = await git(dir, ['fetch', '--quiet'], 45000);
    if (!f.ok) { out.offline = true; out.fetchError = lastLine(f.err); }
  }
  const lr = await git(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  [out.ahead, out.behind] = lr.ok ? lr.out.split(/\s+/).map((n) => Number(n) || 0) : [0, 0];
  if (out.behind) {
    const log = await git(dir, ['log', '--no-color', '--format=%h%x09%cs%x09%s', '-n', '50', 'HEAD..@{u}']);
    out.commits = log.ok && log.out ? log.out.split('\n').map((l) => { const [hash, date, ...s] = l.split('\t'); return { hash, date, subject: s.join('\t') }; }) : [];
  }
  out.dirty = await localChanges(dir);
  const later = out.behind ? blocked(r, dir, out) : null;
  return { ...out, can: out.behind > 0 && !later, ...(later || {}) };
}

// Update: git pull --ff-only, only when the folder is a clean clone that is just behind.
export async function pullUpdate(dir = APP_DIR) {
  const c = await checkUpdates(dir);
  if (c.reason) return { updated: false, ...pick(c) };
  if (c.offline) return { updated: false, ...pick(c), text: `Couldn't reach ${c.upstream.split('/')[0]} (${c.fetchError || 'offline?'}). Nothing changed; try again when you're online.` };
  if (!c.behind) return { updated: false, ...pick(c), text: 'Video Octopus is up to date.' };
  // A release that needs a different runtime/install step must not surprise the running editor.
  const packageFile = await git(dir, ['show', '@{u}:package.json']);
  let incoming;
  try { incoming = packageFile.ok && JSON.parse(packageFile.out); } catch {}
  const current = readJSON(join(dir, 'package.json'), {});
  if (!incoming || ['dependencies', 'optionalDependencies'].some((k) => JSON.stringify(incoming[k] || {}) !== JSON.stringify(current[k] || {})) ||
      JSON.stringify(incoming.engines || {}) !== JSON.stringify(current.engines || {})) {
    return { updated: false, ...pick(c), text: 'This release changes runtime requirements. Read its installation instructions and update manually; the running app and your studio were left unchanged.' };
  }
  const p = await git(dir, ['pull', '--no-rebase', '--ff-only', '--quiet'], 180000);
  if (!p.ok) return { updated: false, ...pick(c), text: `git pull didn't update: ${lastLine(p.err)}`, how: `Run git pull --ff-only in ${shell} in ${dir} to see the whole message.` };
  const after = await repoInfo(dir);
  const diff = await git(dir, ['diff', '--name-only', c.head, after.head]);
  const files = diff.ok ? diff.out.split('\n').filter(Boolean) : [];
  if (dir === APP_DIR) { writeJSON(CACHE, { ...readJSON(CACHE, {}), behind: 0 }); badge.at = 0; }
  return { updated: true, ...pick(after), from: c.commit, to: after.commit, count: c.behind, files: files.length, starter: files.some((f) => f.startsWith('starter/')),
    text: `Updated ${c.commit} → ${after.commit} (${c.behind} commit${c.behind === 1 ? '' : 's'}).` };
}
const pick = (c) => Object.fromEntries(Object.entries(c).filter(([k]) => ['clone', 'version', 'commit', 'date', 'branch', 'upstream', 'behind', 'ahead', 'commits', 'dirty', 'offline', 'fetchError', 'reason', 'text', 'how', 'can', 'checkedAt'].includes(k)));

// ---- the restart ----
// The commit this server started on: once the folder's HEAD moves (Update, or a git pull in a terminal), Video Octopus runs
// old code until it restarts.
const BOOT = { id: `${process.pid}-${Date.now()}`, head: null, version: pkgVersion(APP_DIR) };
const booted = repoInfo(APP_DIR).then((r) => { BOOT.head = r.head || null; }).catch(() => {});
const SUPERVISED = process.env.STUDIO_SUPERVISED === '1';
delete process.env.STUDIO_SUPERVISED; // only this server runs under the loop: the chats and what they start don't
export const supervised = () => SUPERVISED;
async function restartView(now) {
  await booted;
  const needed = Boolean(BOOT.head && now?.head && now.head !== BOOT.head);
  return { needed, supervised: supervised(), running: { version: BOOT.version, commit: BOOT.head?.slice(0, 7) || null },
    how: supervised() ? '' : `Video Octopus wasn't started with start.sh or start.cmd, so it can't start itself again. Stop it (Ctrl+C in its window, or Stop in the tool that started it) and start it again the same way, or with ${IS_WIN ? 'start.cmd' : './start.sh'} in ${tildePath(APP_DIR)}.` };
}

// ---- the quiet check when Video Octopus starts (Settings → Updates → Check when Video Octopus starts) ----
// At most once a day; offline it says nothing and tries again a few hours later. Only git fetch talks to the network.
export async function quietCheck() {
  if (!section('updates').auto || !existsSync(join(APP_DIR, '.git'))) return null;
  const last = readJSON(CACHE, {});
  if (last.checkedAt && Date.now() - Date.parse(last.checkedAt) < DAY) return null;
  const c = await checkUpdates(APP_DIR);
  if (c.reason && !c.behind) return null; // not a plain clone that follows a branch: nothing to say
  writeJSON(CACHE, c.offline ? { ...last, triedAt: c.checkedAt, offline: true } : { checkedAt: c.checkedAt, behind: c.behind, offline: false });
  badge.at = 0;
  return c;
}
export function startUpdateChecks() {
  const tick = () => quietCheck().catch((e) => console.error('update check:', e.message));
  for (const t of [setTimeout(tick, 15000), setInterval(tick, 3 * 3600e3)]) t.unref?.();
}

// The badge on Settings: commits waiting on GitHub as git last fetched them (no network here), while the quiet check
// is on. Cached for a minute (Home asks on every visit).
const badge = { at: 0, n: 0 };
export async function updateCount() {
  if (!section('updates').auto || !existsSync(join(APP_DIR, '.git'))) return 0;
  if (Date.now() - badge.at < 60e3) return badge.n;
  const r = await git(APP_DIR, ['rev-list', '--count', 'HEAD..@{u}'], 5000);
  Object.assign(badge, { at: Date.now(), n: r.ok ? Number(r.out) || 0 : 0 });
  return badge.n;
}

// ---- the page's data and the routes: /api/app/updates[/check|/pull|/restart|/starter|/login] ----
async function updatesView() {
  const app = await checkUpdates(APP_DIR, { fetch: false });
  const last = readJSON(CACHE, {});
  const preferences = readSkillPreferences({ studio: settings().studio });
  return { app: pick(app), lastCheck: last.checkedAt || null, auto: section('updates').auto, restart: await restartView(app),
    starter: starterView(), skills: managedSkillsView(),
    preferences: { status: preferences.status, path: preferences.path, diagnostics: preferences.diagnostics },
    activity: activityView(), login: loginState(), bootId: BOOT.id, pending: last.pending || null, restartPending,
    // The Node.js running this copy: a non-blocking warning below its line's latest security release.
    runtime: runtime.nodeSecurity(process.versions.node) };
}

export async function updatesRoute(req, res, url, { send, body, restart }) {
  const p = url.pathname;
  if (p !== '/api/app/updates' && !p.startsWith('/api/app/updates/')) return false;
  const post = req.method === 'POST';
  try {
    if (p === '/api/app/updates' && !post) return send(res, 200, await updatesView()), true;
    if (!post) return send(res, 405, { error: 'Use POST.' }), true;
    const b = await body(req);
    if (p === '/api/app/updates/check') {
      const c = await checkUpdates(APP_DIR);
      if (!c.offline && c.upstream) { writeJSON(CACHE, { checkedAt: c.checkedAt, behind: c.behind, offline: false }); badge.at = 0; }
      return send(res, 200, { app: pick(c), lastCheck: c.offline ? readJSON(CACHE, {}).checkedAt || null : c.checkedAt }), true;
    }
    if (p === '/api/app/updates/pull') {
      beginMaintenance('Updating Video Octopus.');
      let changed = false;
      try {
        const r = await pullUpdate(APP_DIR);
        changed = r.updated;
        if (changed) {
          restartPending = true;
          // Keep work paused until the new process starts. Never reconcile new skills with old, loaded server code.
          writeJSON(CACHE, { ...readJSON(CACHE, {}), pending: { from: r.from, to: r.to, phase: 'restart', at: new Date().toISOString() } });
          settingsChanged('skills');
        }
        send(res, 200, { ...r, restarting: changed && supervised(), bootId: BOOT.id,
          restart: await restartView(await repoInfo(APP_DIR)), skills: managedSkillsView() });
        if (changed && supervised()) setTimeout(() => restart(), 300);
        return true;
      } finally { if (!changed) endMaintenance(); }
    }
    if (p === '/api/app/updates/restart') {
      if (!supervised()) return send(res, 200, { restarting: false, how: (await restartView()).how }), true;
      if (!maintenanceActive()) beginMaintenance('Restarting Video Octopus.');
      // An in-progress pull owns maintenance too; it schedules its own restart after git completes.
      else if (!restartPending) throw new Error('An update is still in progress. Wait for it to finish.');
      send(res, 200, { restarting: true, bootId: BOOT.id });
      setTimeout(() => restart(), 300); // the answer goes out first
      return true;
    }
    if (p === '/api/app/updates/skills') {
      const studio = settings().studio;
      if (b.action === 'compare') return send(res, 200, compareSkill({ studio, id: b.id, revision: b.revision })), true;
      beginMaintenance('Updating studio skills.');
      try {
        if (b.action === 'refresh') applyStarter(studio, { prefixes: ['tools/'] });
        const view = syncSkills({ studio, action: b });
        skillError = null;
        settingsChanged('skills'); // close idle processes; the next turn resumes with the chosen publication
        return send(res, 200, view), true;
      } catch (e) { skillError = e.message; throw e; }
      finally { endMaintenance(); }
    }
    if (p === '/api/app/updates/starter') {
      if (!b.apply) return send(res, 200, starterView()), true;
      beginMaintenance('Updating other starter files.');
      try { const result = applyStarter(); settingsChanged('skills'); return send(res, 200, result), true; }
      finally { endMaintenance(); }
    }
    if (p === '/api/app/updates/login') {
      if (typeof b.on !== 'boolean') throw new Error('Say on: true or on: false.');
      return send(res, 200, await setLogin(b.on)), true;
    }
    return send(res, 404, { error: 'Unknown updates action.' }), true;
  } catch (e) { return send(res, e.status || 400, { error: e.message }), true; }
}

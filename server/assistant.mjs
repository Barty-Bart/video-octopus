// The Video Octopus assistant: a Claude chat for the app itself, not tied to a project (chat id "_studio"). Same
// Claude Code and sign-in as the project chats, its own conversation, run in "ask before changes" mode so every
// install or edit comes back as an Allow / Deny card. Its routes are the project chat routes under the id
// _studio (/api/projects/_studio/events|chat|answer|stop), so the app's chat panel works for it unchanged.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeChat, staleChat } from './engines.mjs';
import { forReplay } from './claude.mjs';
import { settings, state, APP_DIR, LOCAL_DIR } from './util.mjs';
import { onSettingsChange, restartWhenIdle } from './settings.mjs';
import { runCheck, lastChecks, CHECKS } from './setup.mjs';
import { lookOnly } from './readonly.mjs';

export const ASSISTANT_ID = '_studio';
const streams = new Set();
let chat = null;

// The assistant for a POST (a message, an answer, the sessions list): made on first use, and after an agent switch in
// Settings a fresh one on the new agent (the old conversation stays listed).
export function assistantChat() {
  if (staleChat(chat)) { chat.kill(); chat = null; }
  if (chat) return chat;
  chat = makeChat(ASSISTANT_ID, context);
  const s = () => settings().studio;
  chat.cwd = () => (s() && existsSync(s()) ? s() : homedir());
  chat.mode = () => 'manual';
  // Read-only answers need no card: a command that only looks (the same rule as Auto's read-only check) or one of the
  // octopus command's read commands, run by its full path (server/readonly.mjs). Every change still asks. A relative
  // path to the octopus command isn't trusted (Claude's shell may be in another folder), unless the command cds there.
  chat.autoAllow = (r) => r?.tool_name === 'Bash' && r.input?.shell !== 'powershell' && lookOnly(r.input?.command, null);
  chat.listeners.add((ev) => { for (const res of streams) res.write(`data: ${JSON.stringify(ev)}\n\n`); });
  return chat;
}
// A look at it for a GET (the event stream): the one in use, even a stale one (it reads the same log), or one made just
// to read the log and never kept. A GET never stops, replaces or starts a chat.
export const peekAssistant = () => chat || makeChat(ASSISTANT_ID, context);
onSettingsChange((what) => { if (what !== 'appearance') restartWhenIdle(chat); });
export const killAssistant = () => chat?.kill();

function context() {
  const s = settings();
  const checks = CHECKS.map(([id, title]) => { const c = lastChecks.get(id); return c ? `${title}: ${c.state === 'ok' ? 'OK' : c.state === 'warn' ? 'needs attention' : 'failing'} (${c.detail})` : null; }).filter(Boolean);
  return [
    `You are the Video Octopus assistant, a chat inside Video Octopus (the creator's local video editing app) for the whole studio, not for one project: the creator opens you with the Ask Claude button on Home, Dashboard, Scheduled, Recordings, Library, Skills and Settings. You set Video Octopus up and keep it working (install or fix the tools it needs, download models, move folders, add or change project formats), and you act on the app for the creator: settings, projects, the library and its inbox, scheduled runs, the dashboard.`,
    `To act on the app, use its command line, which goes through the running Video Octopus so its pages update: \`node "${join(APP_DIR, 'bin', 'octopus.mjs')}" help\` (always by that full path) lists the commands (projects list/new/rename/open, settings show/set, schedules list/add/edit/run/stop/on/off/delete/runs, library list/inbox/accept/aside, dashboard, skills). Prefer it to editing Video Octopus's JSON files by hand. A scheduled run is a skill or an instruction on a five-field cron (minute hour day month weekday) with a scope (changed, all, untranscribed, new-takes = recordings in no project yet or with no transcript, studio or project:<id>) and a mode (report changes nothing, ask may only write into the Library inbox for the creator's OK, change may edit). Before adding one, say in one line what it will do and when.`,
    `The app is at ${APP_DIR}. Its non-secret settings are in ${join(LOCAL_DIR, 'settings.json')} (change them with the command line's settings set; edit the file only for something it can't set, and then tell the creator to reload the Settings page). The creator's Setup answers are in ${join(LOCAL_DIR, 'profile.json')}. Project formats and their steps are in ${join(APP_DIR, 'core', 'pipelines.json')} (the app's generic ones; don't put a creator's own styles there). This studio's own formats and Short styles go in ${join(s.studio || '<studio>', '.studio', 'formats.json')}, merged over them by id (styles added or replaced by id, blocks and steps replaced, defaultStyle first).`,
    `Your working directory is the studio folder${s.studio ? `: ${s.studio}, projects in ${s.projectsDir}/` : ' (none yet: on the Setup page the creator creates one from Video Octopus\'s starter, which goes to ~/Video Octopus by default, or picks a folder they already have)'}. Each project has its own chat in Video Octopus, so leave projects alone unless asked.`,
    `Ask before every install, download, move or delete, say in one plain line what each step is for, prefer user-level installs (no sudo), and check afterwards that the fix works. Video Octopus re-runs its Setup checks when you finish a reply.`,
    `Looking needs no permission: commands that only read (ls, cat, head, grep, find, wc, jq…, chained with ; && | but no redirects) and the command line's read commands (projects, settings, schedules, library, dashboard, skills, help, by its full path) run without an Allow card. Every change still comes to the creator as a card.`,
    `Never ask for, read or touch the creator's Claude login. For API keys, send the creator to Settings (Transcription for a cloud provider, Claude for a Claude API key): Video Octopus keeps keys in the system key store (the Keychain on a Mac) and passes them to every chat as environment variables. Never write a key into a file or a reply.`,
    checks.length ? `Setup checks right now: ${checks.join('; ')}.` : '',
    `The creator reads you in a narrow side panel: keep replies short and plain.`,
  ].filter(Boolean).join('\n');
}

// ---- routes; returns true when it answered ----
export async function assistantRoute(req, res, url, { send, body }) {
  const p = url.pathname;
  const m = /^\/api\/projects\/_studio\/(events|chat|answer|stop|chat-sessions|chat-compact)$/.exec(p);
  if (!m && p !== '/api/app/assistant/fix') return false;

  if (m && m[1] === 'events') {
    const c = peekAssistant();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const open = new Set(c.openRequests());
    const history = c.history();
    const done = new Set(history.filter((e) => e.t === 'permission_done').map((e) => e.id));
    for (const ev of forReplay(history)) {
      if ((ev.t === 'permission' || ev.t === 'question') && !open.has(ev.id) && !done.has(ev.id)) ev.expired = true;
      res.write(`data: ${JSON.stringify({ ...ev, replay: true })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ t: 'busy', busy: c.busy })}\n\n`);
    if (c.contextEvent()) res.write(`data: ${JSON.stringify(c.contextEvent())}\n\n`);
    const sm = state().projects?.[ASSISTANT_ID]?.model; // the model tag next to the title, also after a reload
    if (sm) res.write(`data: ${JSON.stringify({ t: 'session', model: sm, replay: true })}\n\n`);
    streams.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); streams.delete(res); });
    return true;
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }), true;
  const b = await body(req);
  const c = assistantChat();
  try {
    if (p === '/api/app/assistant/fix') {
      // A Setup row's Fix: check again now, and send the assistant what's wrong.
      const check = await runCheck(String(b.id || ''));
      if (check.state === 'ok') return send(res, 200, { ok: true, check, sent: false }), true;
      if (!check.fix) return send(res, 400, { error: check.how || 'This one is yours to fix.' }), true;
      await c.send(check.fix, { brief: { name: `Fix: ${check.title}` } });
      return send(res, 200, { ok: true, check, sent: true }), true;
    }
    if (m[1] === 'chat-sessions') {
      if (b.op === 'new') c.newSession();
      else if (b.op === 'open') c.openSession(String(b.log || ''));
      return send(res, 200, c.sessions()), true;
    }
    if (m[1] === 'chat-compact') { await c.compact(); return send(res, 200, { ok: true }), true; }
    if (m[1] === 'chat') {
      if (!b.text?.trim()) return send(res, 400, { error: 'Empty message' }), true;
      await c.send(b.text.trim());
      return send(res, 200, { ok: true }), true;
    }
    if (m[1] === 'answer') {
      const ok = c.answer(b.id, { allow: Boolean(b.allow), message: b.message, answers: b.answers });
      return send(res, ok ? 200 : 409, ok ? { ok } : { error: 'Claude is no longer waiting on that.' }), true;
    }
    if (m[1] === 'stop') return send(res, 200, { ok: c.stop() }), true;
  } catch (e) { return send(res, 500, { error: e.message }), true; }
  return false;
}

// Scheduled runs: Claude runs a skill or an instruction on a timer, on one project, a set of projects or
// the whole studio, like Claude Code's scheduled tasks inside Video Octopus. Schedules live in local/schedules.json, each
// run in local/runs/<schedule id>/<time>.json with its session log next to it (<time>.jsonl).
// Runs happen while Video Octopus is open, one at a time; a run missed while Video Octopus was closed runs once at the next start
// (setting scheduleCatchUp, on by default). Nobody watches a run, so Video Octopus answers Claude's permission requests by
// the schedule's mode: "report" changes nothing, "ask" may only write into the Library inbox (<library>/inbox/) for
// the creator's OK, "change" may edit and run commands in its scope.
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LOCAL_DIR, readJSON, readOwnJSON, writeJSON, settings, saveSettings, setProjectState, slugify, inside } from './util.mjs';
import { makeChat } from './engines.mjs';
import { EDIT_TOOLS, editPaths } from './claude.mjs';
import { logUse } from './usage.mjs';
import { listProjects, projectsRoot, projectDir, listSkills, listTakes, takeMain } from './studio.mjs';
import { inboxDir } from './inbox.mjs';
import { maintenanceActive } from './maintenance.mjs';

const FILE = join(LOCAL_DIR, 'schedules.json');
const RUNS = join(LOCAL_DIR, 'runs');
const RUN_LIMIT_MS = 45 * 60000;

// ---- cron: five fields (minute hour day-of-month month weekday), with *, lists, ranges, steps and day names ----
const NAMES = { dow: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], mon: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] };
function field(src, lo, hi, kind) {
  const val = (s) => {
    const k = NAMES[kind]?.indexOf(s.toLowerCase());
    const n = k >= 0 ? k + (kind === 'mon' ? 1 : 0) : Number(s);
    if (!Number.isInteger(n)) throw new Error(`"${s}" isn't a number.`);
    return kind === 'dow' && n === 7 ? 0 : n;
  };
  const out = new Set();
  for (const part of src.split(',')) {
    const [r, stepS] = part.split('/');
    const step = stepS == null ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in "${part}".`);
    let a = lo, b = hi;
    if (r !== '*') { const [x, y] = r.split('-'); a = val(x); b = y == null ? (stepS == null ? a : hi) : val(y); }
    if (a < lo || b > hi || a > b) {
      if (!(kind === 'dow' && b === 0 && a > 0)) throw new Error(`"${part}" is outside ${lo}–${hi}.`);
      b = 6; out.add(0); // a range ending on Sunday written as 7 (e.g. 5-7)
    }
    for (let n = a; n <= b; n += step) out.add(n);
  }
  return out;
}
export function parseCron(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) throw new Error('A schedule needs five fields: minute, hour, day of month, month, weekday.');
  return {
    min: field(f[0], 0, 59), hour: field(f[1], 0, 23), dom: field(f[2], 1, 31), mon: field(f[3], 1, 12, 'mon'), dow: field(f[4], 0, 7, 'dow'),
    domAny: f[2] === '*', dowAny: f[4] === '*',
  };
}
const dayOk = (c, d) => (c.domAny && c.dowAny) || (c.domAny ? c.dow.has(d.getDay()) : c.dowAny ? c.dom.has(d.getDate()) : c.dom.has(d.getDate()) || c.dow.has(d.getDay()));
// The first time after `from` (to the minute) the schedule fires.
export function nextRun(expr, from = Date.now()) {
  const c = parseCron(expr), d = new Date(from);
  d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  const end = from + 1500 * 86400000; // four years and a bit, for a 29 February
  while (d.getTime() < end) {
    if (!c.mon.has(d.getMonth() + 1) || !dayOk(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!c.min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d.getTime();
  }
  return null;
}
// The last time at or before `at` it fired (for catching up after Video Octopus was closed).
export function prevRun(expr, at = Date.now()) {
  const c = parseCron(expr), d = new Date(at);
  d.setSeconds(0, 0);
  const end = at - 400 * 86400000;
  while (d.getTime() > end) {
    if (!c.mon.has(d.getMonth() + 1) || !dayOk(c, d)) { d.setHours(0, 0, 0, 0); d.setMinutes(-1); continue; }
    if (!c.hour.has(d.getHours())) { d.setMinutes(0, 0, 0); d.setMinutes(-1); continue; }
    if (!c.min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() - 1, 0, 0); continue; }
    return d.getTime();
  }
  return null;
}
// "Sundays 20:00", "Every day 07:00", "Weekdays 08:30", "Every hour at :15"; anything else shows the cron itself.
const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
export function describeCron(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return expr;
  const [m, h, dom, mon, dow] = f, num = (s) => /^\d+$/.test(s);
  const hm = num(m) && num(h) ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` : null;
  if (num(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every hour at :${m.padStart(2, '0')}`;
  if (/^\*\/\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${m.slice(2)} minutes`;
  if (!hm || mon !== '*') return expr;
  if (dom === '*' && dow === '*') return `Every day ${hm}`;
  if (dom === '*' && (dow === '1-5' || dow === 'mon-fri')) return `Weekdays ${hm}`;
  if (dom === '*' && num(dow)) return `${DAYS[Number(dow) % 7]} ${hm}`;
  if (num(dom) && dow === '*') return `Monthly on the ${dom}${['th', 'st', 'nd', 'rd'][(dom % 100 > 10 && dom % 100 < 14) || dom % 10 > 3 ? 0 : dom % 10]}, ${hm}`;
  return expr;
}

// ---- data ----
const MODES = { report: 'Report only', ask: 'Ask before changes', change: 'Make changes' };
// new-takes also covers recordings no project uses yet: they're transcribed where they are, into the take's own tr/
// folder (<recordings>/<take>/tr/words.json and the SRT), and a project made from the take later starts with that
// transcript (studio.mjs importTakeFrom). Takes are the raw material and projects a deliberate choice, so a run never
// makes projects by itself.
const SCOPES = { changed: 'Projects changed since the last run', all: 'All projects', untranscribed: 'Projects with a recording and no transcript',
  'new-takes': 'New recordings: in no project yet, or in a project with no transcript', studio: 'The studio folder' };
// readOwnJSON: a broken schedules.json is kept aside, never replaced by the next save's shorter list.
export const readSchedules = () => (readOwnJSON(FILE, null)?.schedules || []).filter((x) => x && x.id);
const writeSchedules = (list) => writeJSON(FILE, { v: 1, schedules: list });

// Templates, from pieces Video Octopus already has: the per-project "Learn from this project" step and the starter skills.
// One only shows when its skill is in the studio.
export const TEMPLATES = [
  { template: 'library-sweep', name: 'Library sweep', skill: '', cron: '0 20 * * 0', scope: 'changed', mode: 'ask',
    prompt: 'Look back over each project below. Find what keeps coming back (title styles, lower thirds, layouts, backgrounds, sound cues, settings) and the lessons worth keeping, as the studio\'s CLAUDE.md describes. Propose library pieces in the Library inbox; don\'t save duplicates of what the library already has. Put proposed lessons and style changes in your summary.' },
  { template: 'transcribe-new', name: 'Transcribe new recordings', skill: 'transcribe', cron: '0 7 * * *', scope: 'new-takes', mode: 'change',
    prompt: 'Transcribe each project and recording below the way a project\'s Transcribe step does: the word times in words.json and the SRT next to it, where the list says. Use the transcription settings Video Octopus passes in the environment.' },
  { template: 'join-check', name: 'Join check on changed cuts', skill: 'join-check', cron: '0 22 * * *', scope: 'changed', mode: 'change',
    prompt: 'For each project below that has a cut (work/edl_manual.json or work/rough_map.json), run the join check (it writes work/joins.json, which the Cut tab shows) and report the joins that look clipped, worst first. Don\'t change the cuts themselves.' },
  { template: 'weekly-digest', name: 'Weekly digest', skill: '', cron: '0 17 * * 5', scope: 'changed', mode: 'report',
    prompt: 'Write a short digest of the week for the projects below: what moved forward, renders made, what is waiting for me (notes, next steps), and anything that looks stuck.' },
];

function clean(b, old = {}) {
  const name = String(b.name ?? old.name ?? '').trim().slice(0, 80);
  if (!name) throw new Error('Give the scheduled run a name.');
  const cron = String(b.cron ?? old.cron ?? '').trim().replace(/\s+/g, ' ');
  parseCron(cron); // throws a readable error
  if (nextRun(cron) == null) throw new Error('That schedule never fires.');
  const mode = MODES[b.mode] ? b.mode : old.mode || 'report';
  const scope = SCOPES[b.scope] || /^project:[\w.-]+$/.test(b.scope || '') ? b.scope : old.scope || 'changed';
  const skill = /^[\w:-]*$/.test(b.skill ?? '') ? String(b.skill ?? old.skill ?? '') : old.skill || '';
  const prompt = String(b.prompt ?? old.prompt ?? '').trim().slice(0, 4000);
  if (!prompt && !skill) throw new Error('Tell Claude what to do, or pick a skill.');
  return { ...old, name, cron, mode, scope, skill, prompt, enabled: b.enabled ?? old.enabled ?? true, template: b.template ?? old.template ?? null };
}

// ---- scope: which projects a run covers ----
function scopeProjects(sch, all = listProjects()) {
  if (sch.scope?.startsWith('project:')) return all.filter((p) => p.id === sch.scope.slice(8));
  if (sch.scope === 'all') return all;
  if (sch.scope === 'changed') return all.filter((p) => p.updated > (sch.lastRunAt || 0));
  if (sch.scope === 'untranscribed' || sch.scope === 'new-takes') {
    return all.filter((p) => p.app && !['work/tr/words.json', 'work/words.json'].some((f) => existsSync(join(projectsRoot(), p.id, f)))
      && (() => { try { return readdirSync(join(projectsRoot(), p.id, 'source')).some((f) => /\.(mov|mp4|m4v|wav|m4a|mp3)$/i.test(f)); } catch { return false; } })());
  }
  return null; // the studio folder
}
// The recordings a run covers (new-takes only): takes no project uses and that have no transcript yet, with the file to
// transcribe (the camera file carries the mic) and the one folder the run may write for each, <take>/tr/.
export function scopeTakes(sch) {
  if (sch.scope !== 'new-takes') return [];
  const root = settings().recordingsDir;
  return listTakes().filter((t) => !t.used && !t.transcribed).map((t) => ({ id: t.id, dir: join(root, t.id), main: takeMain(t.files) })).filter((t) => t.main);
}
const scopeLabel = (sch, all = listProjects()) => (sch.scope?.startsWith('project:') ? (all.find((p) => p.id === sch.scope.slice(8))?.name || sch.scope.slice(8)) : SCOPES[sch.scope] || sch.scope);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// "2 projects and 3 recordings in scope now" for the editor (recordings only for a scope that has them).
const inScopeText = (sch, projects, takes) => (projects == null ? null : !projects.length && !takes.length ? 'nothing in scope now'
  : `${[plural(projects.length, 'project'), ...(sch.scope === 'new-takes' ? [plural(takes.length, 'recording')] : [])].join(' and ')} in scope now`);

// ---- running ----
const queue = [];
let current = null; // { sch, chat, run, timer }
export const schedulesBusy = () => Boolean(current || queue.length);
// A file strictly inside a folder (the folder itself isn't a file to change).
const isInside = (base, p) => { const q = p && inside(base, p); return Boolean(q && q !== resolve(base)); };
// The folders a run may change: its projects (or the whole studio), each recording's tr/ folder (never the recording
// files themselves) and the Library inbox.
const roots = (projects, takes = []) => [...(projects == null ? [settings().studio] : projects.map((p) => projectDir(p.id)).filter(Boolean)), ...takes.map((t) => join(t.dir, 'tr')), inboxDir()];
// What a run covers and may change, from its schedule (for a run, and for the smoke test).
export function runScope(sch) { const projects = scopeProjects(sch), takes = scopeTakes(sch); return { projects, takes, roots: roots(projects, takes) }; }
// What a run may always use (reading and searching), and what a "Make changes" run may use besides file edits in its
// scope: commands (README: commands are allowed) and the agents' own helpers. TaskOutput and Agent are Claude Code's
// newer names for BashOutput and Task; PowerShell is its command tool on Windows. Anything else (web access, MCP
// tools, Codex asking for a wider sandbox, a pi tool from another extension) is refused: nobody is watching.
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'];
const RUN_TOOLS = ['Bash', 'BashOutput', 'TaskOutput', 'PowerShell', 'Skill', 'Task', 'Agent', 'TodoWrite'];
const stamp = (t) => new Date(t).toISOString().replace(/[:.]/g, '-');

function runContext(sch, projects) {
  const s = settings();
  return [
    `You are running unattended: this is a scheduled run in Video Octopus (the creator's local video editing app), named "${sch.name}". Nobody is watching while it runs. Don't ask questions: decide sensibly, and put anything that needs the creator in your final summary.`,
    `Your working directory is ${projects?.length === 1 && sch.scope?.startsWith('project:') ? projectDir(projects[0].id) : `the studio folder, ${s.studio}, projects in ${s.projectsDir}/`}.`,
    sch.mode === 'report' ? 'This run is report only: read and look, change nothing. Video Octopus refuses every edit and command that changes something; what you would change goes in the summary.'
      : sch.mode === 'ask' ? `This run asks before changes: don't edit anything in the studio or its projects. Anything you'd add to the library goes in the Library inbox, ${join(inboxDir(), `${stamp(Date.now()).slice(0, 10)}-${sch.template || slugify(sch.name) || 'run'}`)}/, one folder per piece with a short README.md that starts with a line "kind: <backgrounds|sfx|styles|components|broll|stills>", then what it is, which project it came from and why it's worth keeping. The creator reviews the inbox. Other proposed changes go in the summary. Video Octopus refuses writes anywhere else.`
        : 'This run may make changes in its scope: commands are allowed, and file edits only inside the projects listed (or the studio folder, for a studio-wide run), the tr/ folder of each recording listed, and the Library inbox. Video Octopus refuses edits anywhere else. Never change, move or re-encode a recording or a project\'s source files. Say in the summary exactly what you changed.',
    'End with your summary as the last message: a few short plain lines (what you looked at, what you did or propose, what needs the creator).',
  ].join('\n');
}

function runPrompt(sch, projects, takes = []) {
  const head = `${sch.skill ? `Use the ${sch.skill} skill. ` : ''}${sch.prompt || ''}`.trim();
  if (projects == null) return head;
  if (!projects.length && !takes.length) return null;
  const since = sch.lastRunAt ? ` (changed since ${new Date(sch.lastRunAt).toLocaleString()})` : '';
  const parts = [head];
  if (projects.length) parts.push(`Projects${sch.scope === 'changed' ? since : ''}${sch.scope === 'new-takes' ? ' (each into its work/tr/words.json and the SRT next to it)' : ''}:\n${projects.map((p) => `- ${p.name} (${p.id}/)${p.next ? `, next step: ${p.next}` : ''}`).join('\n')}`);
  if (takes.length) parts.push(`Recordings no project uses yet: transcribe each into its own tr/ folder (words.json and the SRT next to it), and change nothing else in the recording's folder:\n${takes.map((t) => `- ${t.id}: ${join(t.dir, t.main)} → ${join(t.dir, 'tr')}/`).join('\n')}`);
  return parts.join('\n\n');
}

// Video Octopus answers the permission requests of a run by its mode. "Make changes" keeps file edits to the run's scope
// (its projects, or the studio for a studio-wide run, plus the Library inbox) and allows commands; every other tool
// is refused. A change to several files (a Codex patch) needs every one of them in scope, and a request to write
// anywhere in a folder (Codex's grant_root) needs that folder in scope. A relative path is a file in the agent's
// working folder (cwd), which needn't be the root it's checked against; with no cwd it's refused.
export function decide(sch, req, scope = [settings().studio, inboxDir()], cwd = null) {
  const tool = req.tool_name, input = req.input || {};
  const full = (f) => (isAbsolute(f) ? f : cwd && f ? resolve(cwd, f) : null);
  const fits = (roots) => editPaths(input).every((f) => { const a = full(f); return a && roots.some((r) => isInside(r, a)); })
    && (!input.grant_root || Boolean(full(input.grant_root) && roots.some((r) => inside(r, full(input.grant_root)))));
  if (tool === 'AskUserQuestion') return { allow: false, message: 'Nobody is watching this scheduled run. Decide yourself, or put the question in your summary.' };
  if (READ_TOOLS.includes(tool)) return { allow: true };
  if (sch.mode === 'change') {
    if (RUN_TOOLS.includes(tool) || (EDIT_TOOLS.includes(tool) && fits(scope))) return { allow: true };
    if (EDIT_TOOLS.includes(tool)) return { allow: false, message: `This run may only change files in its scope: ${scope.join(', ')}. Put the change in your summary instead.` };
    return { allow: false, message: tool === 'Permissions'
      ? 'A scheduled run can\'t widen its own permissions (sandbox): nobody is watching to approve that. Work within them, and put what you needed in your summary.'
      : `A scheduled run can't use ${tool}: it may read, run commands and change files in its scope, nothing else (no web access or MCP tools), because nobody is watching. Put what you needed in your summary.` };
  }
  if (sch.mode === 'ask' && EDIT_TOOLS.includes(tool) && fits([inboxDir()])) return { allow: true };
  return { allow: false, message: sch.mode === 'ask' ? `This run asks before changes: only the Library inbox (${inboxDir()}) can be written. Put the change in your summary instead.` : 'This run is report only: nothing may be changed. Put it in your summary instead.' };
}

function filesSince(dir, t, out = [], base = dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) filesSince(p, t, out, base);
    else if (st.mtimeMs >= t) out.push(relative(base, p));
  }
  return out;
}

export function runNow(id, why = 'manual') {
  const sch = readSchedules().find((x) => x.id === id);
  if (!sch) throw new Error('No such scheduled run.');
  if (current?.sch.id === id || queue.some((q) => q.id === id)) return { queued: true };
  queue.push({ id, why });
  pump();
  return { queued: true };
}

async function pump() {
  if (maintenanceActive() || current || !queue.length) return;
  const { id, why } = queue.shift();
  const sch = readSchedules().find((x) => x.id === id);
  if (!sch) return pump();
  const s = settings();
  const startedAt = Date.now();
  const { projects, takes, roots: scope } = runScope(sch);
  const prompt = runPrompt(sch, projects, takes);
  const dir = join(RUNS, sch.id);
  mkdirSync(dir, { recursive: true });
  const base = join(dir, stamp(startedAt));
  const run = { id: stamp(startedAt), schedule: sch.id, name: sch.name, why, mode: sch.mode, startedAt, endedAt: null, status: 'running',
    projects: (projects || []).map((p) => p.id), takes: takes.map((t) => t.id), summary: '', tools: [], refused: [], inbox: [], sessionId: null };
  const save = () => writeJSON(`${base}.json`, run);
  const finish = (status, extra = {}) => {
    if (run.endedAt) return;
    Object.assign(run, { status: current?.stopped ? 'stopped' : status, endedAt: Date.now(), ...extra });
    if (sch.mode === 'ask') run.inbox = filesSince(inboxDir(), startedAt);
    save();
    clearTimeout(current?.timer);
    current?.chat?.kill();
    current = null;
    patchSchedule(sch.id, { lastRunAt: startedAt, lastStatus: run.status, lastRun: run.id });
    logUse('schedule.run', { status: run.status, mode: sch.mode, why, kind: sch.template || 'custom' });
    pump();
  };
  // Nothing in scope (no project changed since the last run): a quick note instead of a Claude session.
  if (prompt == null) { save(); current = { sch }; finish('skipped', { summary: `Nothing to do: ${SCOPES[sch.scope]?.replace(/^./, (c) => c.toLowerCase()) || 'no projects in scope'} (none).` }); return; }
  const chatId = `_run_${sch.id}`;
  setProjectState(chatId, { sessionId: null, context: null, contextHash: null });
  const chat = makeChat(chatId, () => runContext(sch, projects));
  chat.log = `${base}.jsonl`;
  chat.cwd = () => (sch.scope?.startsWith('project:') && projects?.length ? projectDir(projects[0].id) : s.studio);
  // Every edit comes back as a permission request (no accept-edits mode), so decide() can keep it to the scope.
  chat.mode = () => 'manual';
  let lastText = '';
  chat.listeners.add((ev) => {
    if (ev.t === 'session') run.sessionId = ev.id;
    if (ev.t === 'text') lastText = ev.text;
    if (ev.t === 'tool' && run.tools.length < 200) run.tools.push({ name: ev.name, summary: ev.summary });
    if (ev.t === 'refused') run.refused.push({ tool: ev.tool, summary: ev.summary || '' }); // an agent's tool that asks nobody (codex.mjs)
    if (ev.t === 'permission' || ev.t === 'question') {
      const req = chat.pending.get(ev.id)?.request || {};
      const d = decide(sch, req, scope, chat.cwd());
      if (!d.allow) run.refused.push({ tool: req.tool_name, summary: ev.summary || '' });
      setTimeout(() => chat.answer(ev.id, d), 0);
    }
    if (ev.t === 'result') finish(ev.ok ? 'done' : 'error', { summary: lastText.trim().slice(0, 4000) });
    if (ev.t === 'error') finish('error', { summary: (lastText ? `${lastText.trim()}\n\n` : '') + ev.text });
  });
  current = { sch, chat, run, finish };
  current.timer = setTimeout(() => { chat.stop(); finish('timeout', { summary: `${lastText.trim()}\n\nStopped after ${RUN_LIMIT_MS / 60000} minutes.`.trim() }); }, RUN_LIMIT_MS);
  save();
  try { await chat.send(prompt); } catch (e) { finish('error', { summary: e.message }); }
}

// Stop: interrupt Claude (the run ends with what it has); if it doesn't end within a few seconds, end it anyway.
export function stopRun(id) {
  const i = queue.findIndex((q) => q.id === id);
  if (i >= 0) { queue.splice(i, 1); return true; }
  if (current?.sch.id !== id || !current.chat) return false;
  const c = current;
  c.stopped = true;
  c.chat.stop();
  setTimeout(() => { if (current === c) c.finish('stopped'); }, 5000);
  return true;
}

function patchSchedule(id, patch) {
  const list = readSchedules();
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch };
  writeSchedules(list);
  return list[i];
}

export function listRuns(id, limit = 20) {
  if (!/^[\w-]+$/.test(id || '')) return [];
  try {
    return readdirSync(join(RUNS, id)).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, limit)
      .map((f) => readJSON(join(RUNS, id, f), null)).filter(Boolean);
  } catch { return []; }
}
function runDetail(id, runId) {
  if (!/^[\w-]+$/.test(id) || !/^[\w-]+$/.test(runId)) throw new Error('Bad run.');
  const run = readJSON(join(RUNS, id, `${runId}.json`), null);
  if (!run) throw new Error('That run is gone.');
  let events = [];
  try { events = readFileSync(join(RUNS, id, `${runId}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  return { run, events };
}

// ---- the timer ----
let timer = null;
const nextAt = new Map(); // schedule id -> next time it fires
function plan() {
  const now = Date.now();
  for (const sch of readSchedules()) {
    if (!sch.enabled) { nextAt.delete(sch.id); continue; }
    try { if (!nextAt.has(sch.id)) nextAt.set(sch.id, nextRun(sch.cron, now)); } catch { nextAt.delete(sch.id); }
  }
}
function tick() {
  if (maintenanceActive()) return; // preserve nextAt; the next tick catches up after maintenance
  pump();
  const now = Date.now();
  plan();
  for (const sch of readSchedules()) {
    const at = nextAt.get(sch.id);
    if (!sch.enabled || !at || at > now) continue;
    nextAt.set(sch.id, nextRun(sch.cron, now));
    runNow(sch.id, 'schedule');
  }
}
// At start: a run missed while Video Octopus was closed runs once (unless turned off), then the minute timer.
export function startScheduler() {
  if (timer) return;
  const s = settings();
  if (s.studio && s.scheduleCatchUp !== false) {
    for (const sch of readSchedules()) {
      if (!sch.enabled) continue;
      try { const prev = prevRun(sch.cron); if (prev && prev > (sch.lastRunAt || sch.createdAt || Date.now())) runNow(sch.id, 'catch-up'); } catch {}
    }
  }
  plan();
  timer = setInterval(tick, 30000);
  timer.unref?.();
}
export const stopScheduler = () => { clearInterval(timer); timer = null; current?.chat?.kill(); };

// ---- view and routes ----
function view() {
  const projects = listProjects();
  const skills = (() => { try { return listSkills().map((x) => x.name); } catch { return []; } })();
  const schedules = readSchedules().map((sch) => {
    let next = null;
    try { next = sch.enabled ? nextAt.get(sch.id) ?? nextRun(sch.cron) : null; } catch {}
    const scoped = scopeProjects(sch, projects), takes = scopeTakes(sch);
    return { ...sch, when: describeCron(sch.cron), next, scopeLabel: scopeLabel(sch, projects), modeLabel: MODES[sch.mode], inScope: scoped ? scoped.length + takes.length : null,
      running: current?.sch.id === sch.id, queued: queue.some((q) => q.id === sch.id), last: sch.lastRun ? readJSON(join(RUNS, sch.id, `${sch.lastRun}.json`), null) : null };
  });
  return {
    schedules, modes: MODES, scopes: SCOPES, skills,
    templates: TEMPLATES.filter((t) => !t.skill || skills.includes(t.skill)).map((t) => ({ ...t, when: describeCron(t.cron) })),
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    catchUp: settings().scheduleCatchUp !== false,
    inbox: inboxDir(),
  };
}

export async function schedulesRoute(req, res, url, { send, body }) {
  const p = url.pathname;
  if (!p.startsWith('/api/app/schedules')) return false;
  try {
    if (p === '/api/app/schedules' && req.method === 'GET') return send(res, 200, view()), true;
    if (p === '/api/app/schedules/runs' && req.method === 'GET') return send(res, 200, { runs: listRuns(url.searchParams.get('id') || '') }), true;
    if (p === '/api/app/schedules/run' && req.method === 'GET') return send(res, 200, runDetail(url.searchParams.get('id') || '', url.searchParams.get('run') || '')), true;
    if (p === '/api/app/schedules' && req.method === 'POST') {
      const b = await body(req);
      const list = readSchedules();
      if (b.op === 'save') {
        const old = list.find((x) => x.id === b.schedule?.id);
        const sch = clean(b.schedule || {}, old || {});
        if (old) Object.assign(list[list.indexOf(old)], sch);
        else list.push({ ...sch, id: `s_${randomUUID().slice(0, 8)}`, createdAt: Date.now() });
        writeSchedules(list);
        const saved = old ? list.find((x) => x.id === old.id) : list.at(-1);
        nextAt.delete(saved.id); plan();
        return send(res, 200, { ...view(), saved: saved.id }), true;
      }
      if (b.op === 'enable') { const x = patchSchedule(b.id, { enabled: Boolean(b.enabled) }); if (!x) throw new Error('No such scheduled run.'); nextAt.delete(b.id); plan(); return send(res, 200, view()), true; }
      if (b.op === 'delete') { if (current?.sch.id === b.id) throw new Error('It is running: stop it first.'); writeSchedules(list.filter((x) => x.id !== b.id)); nextAt.delete(b.id); return send(res, 200, view()), true; }
      if (b.op === 'run') { runNow(b.id, 'manual'); return send(res, 200, view()), true; }
      if (b.op === 'stop') { stopRun(b.id); return send(res, 200, view()), true; }
      if (b.op === 'catch-up') { saveSettings({ scheduleCatchUp: Boolean(b.on) }); return send(res, 200, view()), true; }
      if (b.op === 'preview') {
        const sch = clean(b.schedule || {}, list.find((x) => x.id === b.schedule?.id) || {}), pr = scopeProjects(sch), tk = scopeTakes(sch);
        return send(res, 200, { when: describeCron(sch.cron), next: nextRun(sch.cron), inScope: pr ? pr.length + tk.length : null, inScopeText: inScopeText(sch, pr, tk) }), true;
      }
      throw new Error('Unknown operation.');
    }
    return send(res, 405, { error: 'GET or POST' }), true;
  } catch (e) { return send(res, e.status || 400, { error: e.message }), true; }
}

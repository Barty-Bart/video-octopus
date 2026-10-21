// The usage log and the Dashboard. One line per thing done in Video Octopus, kept on this computer (local/usage.jsonl):
// counts and kinds only, no words, file names or paths (a project shows as its id, and only here). Totals on the
// Dashboard come from the folders themselves (renders, transcripts, notes, takes), so they're right from day one;
// the log adds what can't be read back from files (features used, the latest activity). The first time, a backfill
// writes past events from the files (marked "bf"). Nothing leaves the computer.
import { appendFileSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_DIR, readJSON, mtime } from './util.mjs';
import { projectsRoot, projectMeta, listTakes } from './studio.mjs';

// Not the log: the plan limits the agent reported last (Claude Code's rate-limit events, Codex's rateLimits), for the
// meter in the top bar (/api/status). Any chat sets it; local/plan-usage.json retains
// the last reading for diagnostics. Only readings from this server run are displayed.
const PLAN_USAGE = join(LOCAL_DIR, 'plan-usage.json');
// Do not revive an old or differently signed-in account's reading on restart.
export let planUsage = null;
export const getPlanUsage = engine => planUsage?.engine === engine ? planUsage : null;
export const setPlanUsage = (u) => { planUsage = u; try { writeFileSync(PLAN_USAGE, JSON.stringify(u)); } catch {} };

const LOG = join(LOCAL_DIR, 'usage.jsonl');
const SEEN = join(LOCAL_DIR, 'usage-seen.json'); // which renders and transcripts were already counted (local only)
const BACKFILLED = join(LOCAL_DIR, 'usage.backfilled');
const VIDEO = /\.(mp4|mov|m4v)$/i;
const WORDS = ['work/words_refined.json', 'work/editor_words.json', 'work/tr/words.json', 'work/words.json', 'words.json'];

// One file per month: when a new month starts, the current log becomes usage-<YYYY-MM>.jsonl and a new one begins.
const monthOf = (t) => new Date(t).toISOString().slice(0, 7);
let logMonth;
const readFile = (f) => { try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
export function logUse(ev, fields = {}) {
  try {
    const now = Date.now(), m = monthOf(now);
    if (logMonth === undefined) { const last = readFile(LOG).at(-1); logMonth = last ? monthOf(last.t) : m; }
    if (logMonth !== m && existsSync(LOG)) {
      let to = join(LOCAL_DIR, `usage-${logMonth}.jsonl`);
      for (let i = 2; existsSync(to); i++) to = join(LOCAL_DIR, `usage-${logMonth}-${i}.jsonl`);
      renameSync(LOG, to);
    }
    logMonth = m;
    appendFileSync(LOG, JSON.stringify({ t: now, ev, ...fields }) + '\n');
  } catch {}
}
const olderLogs = () => { try { return readdirSync(LOCAL_DIR).filter((f) => /^usage-\d{4}-\d{2}(-\d+)?\.jsonl$/.test(f)).sort().map((f) => join(LOCAL_DIR, f)); } catch { return []; } };
function readLog() { return [...olderLogs().flatMap(readFile), ...readFile(LOG)]; }
let seen = null;
const seenDoc = () => (seen ||= readJSON(SEEN, null) || { renders: {}, words: {} });
const saveSeen = () => { try { writeFileSync(SEEN, JSON.stringify(seenDoc())); } catch {} };

const projectDirs = () => { try { return readdirSync(projectsRoot()).filter((n) => !n.startsWith('.') && !n.startsWith('_')).map((n) => ({ id: n, dir: join(projectsRoot(), n) })).filter((p) => { try { return statSync(p.dir).isDirectory(); } catch { return false; } }); } catch { return []; } };
const rendersOf = (dir) => { try { return readdirSync(join(dir, 'renders')).filter((f) => VIDEO.test(f)).map((f) => ({ f, t: mtime(join(dir, 'renders', f)) })); } catch { return []; } };
function speechOf(dir) {
  for (const w of WORDS) {
    const p = join(dir, w);
    if (!existsSync(p)) continue;
    const j = readJSON(p, null), list = Array.isArray(j) ? j : j?.words;
    const end = Array.isArray(list) && list.length ? Number(list[list.length - 1]?.[1] ?? list[list.length - 1]?.end) : 0;
    return { secs: Number.isFinite(end) ? end : 0, t: mtime(p), file: w };
  }
  return null;
}
const notesOf = (dir) => { const d = readJSON(join(dir, 'work', 'notes.json'), null); return { sent: (d?.notes || []).filter((n) => n && n.status && n.status !== 'open').length, approved: Object.keys(d?.approved || {}).length, t: mtime(join(dir, 'work', 'notes.json')) }; };

// The first time: past events from the files, so the Dashboard has history.
export function backfill() {
  if (existsSync(BACKFILLED)) return;
  const out = [], s = seenDoc();
  for (const { id, dir } of projectDirs()) {
    const meta = projectMeta(dir);
    // Video Octopus projects have a start date; older folders use the folder's creation time (its mtime moves with every file).
    const created = Date.parse(meta?.created || '') || (() => { try { return statSync(dir).birthtimeMs || mtime(dir); } catch { return 0; } })();
    out.push({ t: created, ev: 'project.created', project: id, type: meta?.type || null, bf: 1 });
    for (const r of rendersOf(dir)) out.push({ t: r.t, ev: 'render.done', project: id, bf: 1 });
    s.renders[id] = rendersOf(dir).map((r) => r.f);
    const sp = speechOf(dir);
    if (sp?.secs) { out.push({ t: sp.t, ev: 'transcribe.done', project: id, secs: Math.round(sp.secs), bf: 1 }); s.words[id] = Math.round(sp.secs); }
    const n = notesOf(dir);
    if (n.sent) out.push({ t: n.t, ev: 'package.sent', project: id, items: n.sent, bf: 1 });
    if (n.approved) out.push({ t: n.t, ev: 'scenes.approved', project: id, n: n.approved, bf: 1 });
  }
  for (const tk of listTakes()) out.push({ t: tk.at, ev: 'take.recorded', bf: 1 });
  out.sort((a, b) => a.t - b.t);
  try {
    // History is what happened before the log began: nothing from after its first line, no project started twice.
    const live = readFile(LOG).filter((e) => !e.bf), from = readLog().find((e) => !e.bf)?.t ?? Infinity;
    const started = new Set(live.filter((e) => e.ev === 'project.created').map((e) => e.project));
    const past = out.filter((e) => e.t < from && !(e.ev === 'project.created' && started.has(e.project)));
    writeFileSync(LOG, [...past, ...live].map((e) => JSON.stringify(e)).join('\n') + '\n');
    writeFileSync(BACKFILLED, new Date().toISOString() + '\n');
  } catch {}
  saveSeen();
}

// A new render or a new transcript is one event each (not every write of the file), dated by the file. From the
// project watcher while a project is open, and for every project when the Dashboard opens (work done elsewhere,
// e.g. Claude Code in a terminal, still lands in the log).
export function usageFromFiles(id, dir, files = null) {
  const s = seenDoc();
  let changed = false;
  if (!files || files.some((f) => /^renders\/[^/]+\.(mp4|mov|m4v)$/i.test(f))) {
    const known = new Set(s.renders[id] || []);
    for (const r of rendersOf(dir)) if (!known.has(r.f)) { logUse('render.done', { project: id, t: r.t || Date.now() }); known.add(r.f); changed = true; }
    s.renders[id] = [...known];
  }
  if (!files || files.some((f) => WORDS.includes(f))) {
    const sp = speechOf(dir), secs = Math.round(sp?.secs || 0);
    if (secs && s.words[id] !== secs) { logUse('transcribe.done', { project: id, secs, t: sp.t || Date.now() }); s.words[id] = secs; changed = true; }
  }
  // The Lock step writes "Cut locked (join-check: …)" in WORKLOG.md: one event per new line.
  if (!files || files.includes('WORKLOG.md')) {
    let n = 0;
    try { n = (readFileSync(join(dir, 'WORKLOG.md'), 'utf8').match(/Cut locked/g) || []).length; } catch {}
    s.locked ||= {};
    if (n > (s.locked[id] ?? n)) logUse('cut.locked', { project: id });
    if (s.locked[id] !== n) { s.locked[id] = n; changed = true; }
  }
  if (changed) saveSeen();
}
// A cut being edited saves every second or so: one "cut saved" per project per minute is enough.
const lastCut = new Map();
// trim: which ways of trimming at a cut were on (Settings → Editing): "A", "A+B", "A+C" or "A+B+C".
export function cutSaved(id, trim = null) {
  const now = Date.now();
  if (now - (lastCut.get(id) || 0) < 60000) return;
  lastCut.set(id, now);
  logUse('cut.saved', { project: id, ...(trim ? { trim } : {}) });
}

// Every event: [how "What you use most" counts it, how the activity list says one] (no second line: not listed).
const EVENTS = {
  'render.done': ['Renders', 'Render finished'], 'export.done': ['Exports', 'Exported'], 'cut.saved': ['Cut edits saved', 'Cut saved'],
  'cut.locked': ['Cuts locked', 'Cut locked'], 'package.sent': ['Change packages sent', 'Change package sent to Claude'],
  'scenes.note': ['Scene notes', 'Scene note'], 'scenes.approved': ['Scenes approved', 'Scenes approved'], 'skill.run': ['Skills run', 'Skill run'],
  'transcribe.done': ['Transcriptions', 'Transcribed'], 'take.recorded': ['Takes recorded', 'Take recorded'], 'take.imported': ['Takes imported', 'Take imported'],
  'project.created': ['Projects started', 'Project started'], 'agent.turn': ['Agent replies', null], 'session.new': ['New chat sessions', 'New chat session'],
  compact: ['Chats compacted', 'Chat compacted'], 'retime.done': ['Re-timed after a cut', 'Re-timed to the new cut'], 'schedule.run': ['Scheduled runs', 'Scheduled run'],
};
// Logs from before Codex and pi called every reply "claude.turn"; they count as agent.turn.
const evOf = (e) => (e.ev === 'claude.turn' ? 'agent.turn' : e.ev);
const LABEL = Object.fromEntries(Object.entries(EVENTS).map(([k, [all]]) => [k, all]));
const ONE = Object.fromEntries(Object.entries(EVENTS).filter(([, [, one]]) => one).map(([k, [, one]]) => [k, one]));

// GET /api/app/dashboard?range=week|month|all
// Bring the log up to date from the files (the first-time history, renders and transcripts made outside Video Octopus).
// The Dashboard asks for this first, as a write of its own (POST), and then reads.
export function catchUpUsage() {
  backfill();
  for (const { id, dir } of projectDirs()) { try { usageFromFiles(id, dir); } catch {} }
  return { ok: true };
}

export function dashboard(range = 'all') {
  const now = new Date();
  const since = range === 'week' ? (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); })()
    : range === 'month' ? now.getTime() - 30 * 86400000 : 0;
  const projects = projectDirs();
  let studio = 0, finished = 0, speech = 0, transcribed = 0, renders = 0, rendersIn = 0, sent = 0, approved = 0;
  const day = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const today = day(now.getTime()), perDay = new Map(Array.from({ length: 14 }, (_, i) => [today - (13 - i) * 86400000, 0]));
  const names = {};
  for (const { id, dir } of projects) {
    const meta = projectMeta(dir);
    names[id] = meta?.name || id;
    if (meta) studio++;
    const rs = rendersOf(dir);
    renders += rs.length;
    if (rs.some((r) => /final/i.test(r.f))) finished++;
    for (const r of rs) { if (r.t >= since) rendersIn++; const k = day(r.t); if (perDay.has(k)) perDay.set(k, perDay.get(k) + 1); }
    const sp = speechOf(dir);
    if (sp?.secs) { speech += sp.secs; transcribed++; }
    const n = notesOf(dir);
    sent += n.sent; approved += n.approved;
  }
  const log = readLog();
  const inRange = log.filter((e) => e.t >= since);
  // What's used most: exports split by kind and skills by name; renders have their own chart.
  const counts = {};
  for (const e of inRange) {
    const ev = evOf(e);
    if (!LABEL[ev] || ev === 'render.done') continue;
    const k = ev === 'export.done' ? `Exports: ${e.kind || 'video'}` : ev === 'skill.run' && e.skill ? `Skill: /${e.skill}` : LABEL[ev];
    counts[k] = (counts[k] || 0) + (e.bf && e.n ? e.n : 1);
  }
  const features = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, n]) => ({ label, n }));
  const detail = (e) => [e.kind, e.ev === 'schedule.run' && e.status, e.skill && `/${e.skill}`, e.items != null && `${e.items} item${e.items === 1 ? '' : 's'}`, e.secs != null && e.ev === 'transcribe.done' && (e.secs < 60 ? `${e.secs} s of speech` : `${Math.round(e.secs / 60)} min of speech`), e.scope].filter(Boolean).join(' · ');
  // The latest first; a run of the same thing in the same project (five renders in a row) is one row with a count.
  const activity = [];
  for (const e of [...log].sort((a, b) => b.t - a.t)) {
    if (!ONE[e.ev]) continue;
    const last = activity.at(-1);
    if (last && last.ev === e.ev && last.pid === (e.project || null) && last.past === Boolean(e.bf) && !e.kind && !e.skill) { last.n++; continue; }
    if (activity.length === 12) break;
    activity.push({ t: e.t, ev: e.ev, n: 1, pid: e.project || null, label: ONE[e.ev], project: e.project ? names[e.project] || e.project : null, detail: detail(e), past: Boolean(e.bf) });
  }
  for (const a of activity) delete a.pid;
  return {
    range, since,
    totals: { finished, projects: projects.length, studio, speechSecs: Math.round(speech), transcribed, renders, rendersInRange: rendersIn, recordings: listTakes().length, sent, approved },
    perDay: [...perDay].map(([t, n]) => ({ t, n })),
    features, activity, logged: log.filter((e) => !e.bf).length, logSince: log.reduce((m, e) => (e.bf || (m && m <= e.t) ? m : e.t), null),
  };
}

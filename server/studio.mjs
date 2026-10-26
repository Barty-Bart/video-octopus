// The studio folder: projects, recorder takes, imports, proxies, pipeline status, skills.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync, cpSync, renameSync, rmSync, createWriteStream, constants, openSync, readSync, closeSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join, basename, extname, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { settings, readJSON, writeJSON, globExists, mtime, slugify, studioTool, APP_DIR } from './util.mjs';
import { defaultLayout, cutMap } from '../web/layout.js';
import { motionNote } from './skills-gh.mjs';
import { needsYou, lockState, importLock, clearImportLock } from './cutreview.mjs';
import { builtEnd, isBuilt, EXPORT_NAME } from './built.mjs'; // (read at call time only: built.mjs imports this module too)

const VIDEO = /\.(mov|mp4|m4v|mkv|webm)$/i;
// Sound-only files: they need no playback copy (the browser plays them) and have no picture. Only the recorder's
// mic-only takes (<stamp>_audio.wav, 24-bit PCM) are take files; other sound files in source/ (voice drafts, a
// separate recorder's track, a dropped voiceover) stay out of roles(), but a block can still use them.
export const AUDIO = /\.(wav|m4a|mp3|aif|aiff|caf|flac)$/i;
export const MEDIA = /\.(mov|mp4|m4v|mkv|webm|wav|m4a|mp3|aif|aiff|caf|flac)$/i;
export const isAudio = (f) => AUDIO.test(f || '');
const TAKE_AUDIO = /_audio\.(wav|m4a|mp3|aif|aiff|caf|flac)$/i;
export const isTakeFile = (f) => VIDEO.test(f || '') || TAKE_AUDIO.test(f || '');
// Which take a file in source/ belongs to: the recorder's <stamp>_screen / _webcam / _audio files share <stamp>; an
// imported file (clip.mp4, voice_audio.m4a) is a take of its own, named after the file.
export function takeKey(f) {
  const m = /^(.+)_(screen|webcam)\.(mov|mp4|m4v|mkv|webm)$/i.exec(f || '') || /^(.+)_audio\.(wav|m4a|mp3|aif|aiff|caf|flac)$/i.exec(f || '');
  return m ? m[1] : basename(String(f || ''), extname(String(f || '')));
}
// The formats: the app's generic ones (core/pipelines.json) with the studio's own on top (<studio>/.studio/formats.json),
// so creator-specific formats and Short styles live in the studio, not in the app.
export const STUDIO_FORMATS = join('.studio', 'formats.json');
const PIPELINES = () => {
  const core = readJSON(join(APP_DIR, 'core', 'pipelines.json'));
  const s = settings(), studio = s.studio;
  return forMode(studio ? mergeFormats(core, readJSON(join(studio, STUDIO_FORMATS), null)) : core, s?.editor?.mode === 'advanced' ? 'advanced' : 'simple');
};

// Simple mode (Settings › General › Editor mode; Simple is the default, server/settings.mjs editorMode): a format's step
// may carry `inSimple`, the fields it has there instead of its own (the tutorial's Build: the whole video, every planned
// scene, rather than the intro). Advanced reads every step as written. Every reader of the steps (the status, the step's
// brief, its done rule, the Build's scope and renders) goes through here, so they agree within a mode.
export function forMode(p, mode = 'simple') {
  if (!p?.formats) return p;
  const step = (s) => {
    if (!s || typeof s !== 'object' || !('inSimple' in s)) return s;
    const { inSimple, ...own } = s;
    return mode === 'simple' && inSimple && typeof inSimple === 'object' ? { ...own, ...inSimple } : own;
  };
  const formats = {};
  for (const [k, f] of Object.entries(p.formats)) {
    formats[k] = f && typeof f === 'object' ? { ...f, ...(Array.isArray(f.steps) ? { steps: f.steps.map(step) } : {}), ...(Array.isArray(f.more) ? { more: f.more.map(step) } : {}) } : f;
  }
  return { ...p, formats };
}

// Merge a studio's formats.json over the core: a format by id (an old alias counts), its plain fields replaced,
// `styles` added or replaced by id, `blocks` / `steps` / `more` replaced when given. `defaultStyle` puts that style
// first (new projects and projects without a style start with the first one). A new format needs a label and steps.
// `shared` steps and `blockTypes` are merged by key, so a studio's own steps can be named in its formats.
export function mergeFormats(core, over) {
  if (!over || typeof over !== 'object' || !over.formats || typeof over.formats !== 'object') return core;
  const out = { ...core, shared: { ...core.shared, ...(over.shared || {}) }, blockTypes: { ...core.blockTypes, ...(over.blockTypes || {}) }, formats: { ...core.formats } };
  for (const [rawId, f] of Object.entries(over.formats)) {
    if (!f || typeof f !== 'object' || rawId.startsWith('_')) continue;
    const id = core.aliases?.[rawId] || rawId;
    const base = core.formats[id];
    if (!base && !(f.label && Array.isArray(f.steps))) continue;
    const { styles, defaultStyle, ...rest } = f;
    const next = { ...(base || {}), ...rest };
    let list = [...(base?.styles || [])];
    for (const st of Array.isArray(styles) ? styles : []) {
      if (!st?.id) continue;
      const i = list.findIndex((x) => x.id === st.id);
      if (i >= 0) list[i] = { ...list[i], ...st }; else list.push(st);
    }
    const first = defaultStyle || base?.defaultStyle;
    if (first && list.some((x) => x.id === first)) list = [list.find((x) => x.id === first), ...list.filter((x) => x.id !== first)];
    if (list.length) next.styles = list;
    out.formats[id] = next;
  }
  return out;
}
// Old format ids stay readable: a project.json with "long" or "reel" is a tutorial or a Short (the file isn't rewritten).
export const formatId = (type) => (type && PIPELINES().aliases?.[type]) || type || null;

export const projectsRoot = () => join(settings().studio, settings().projectsDir);

export function projectDir(id) {
  if (!id || /[\\/]/.test(id) || id.includes('..') || id.startsWith('.')) return null;
  const dir = join(projectsRoot(), id);
  return existsSync(dir) && statSync(dir).isDirectory() ? dir : null;
}

export const projectMeta = (dir) => readJSON(join(dir, 'project.json'), null);
export const saveProjectMeta = (dir, patch) => writeJSON(join(dir, 'project.json'), { ...(projectMeta(dir) || {}), ...patch });

export function sources(dir) {
  try {
    return readdirSync(join(dir, 'source')).filter((f) => isTakeFile(f) && !f.startsWith('.')).sort();
  } catch { return []; }
}

// Every video and sound file in source/ (takes, dropped files, voiceovers), for picking a block's file.
export function projectMedia(dir) {
  try {
    return readdirSync(join(dir, 'source')).filter((f) => MEDIA.test(f) && !f.startsWith('.')).sort();
  } catch { return []; }
}

// Which source plays which role: the screen recording and the camera. With several takes in a
// project, the newest imported take (project.json activeTake) is the one on the canvas.
// A take can be screen + camera, camera only (just _webcam), or mic only (just _audio.wav):
// audio is that sound file, and it is the main file only when the take has no video at all.
export function roles(dir) {
  const files = sources(dir);
  const active = projectMeta(dir)?.activeTake;
  // The active take's own files (takeKey), so a take named 2026-10-24_10-00-00 doesn't also pick up
  // 2026-10-24_10-00-00-2 (or clip, clip (2)). Files named another way are matched by their start, as before.
  const own = active ? files.filter((f) => takeKey(f) === active) : [];
  const pool = own.length ? own : active && files.some((f) => f.startsWith(active)) ? files.filter((f) => f.startsWith(active)) : files;
  const screen = pool.find((f) => /_screen\./i.test(f)) || null;
  const webcam = pool.find((f) => /_webcam\./i.test(f)) || null;
  const audio = pool.find((f) => TAKE_AUDIO.test(f)) || null;
  const main = webcam || screen || pool.find((f) => !isAudio(f)) || audio || null;
  return { files, take: pool, screen, webcam, audio, main, audioOnly: Boolean(main && isAudio(main)) };
}

// Size, frame rate, length and audio of a source file (ffprobe, cached until the file changes).
const probes = new Map();
export const probe = (dir, f) => probeFile(join(dir, 'source', f));
// An MP4 / MOV still being written (Claude's ffmpeg, an export, a take being saved) has no index ("moov") yet: it isn't
// probed until it has one, so its length is unknown for now (null, not cached) and the next look tries again. ffprobe's
// own complaints never reach the log.
export function mp4Whole(p) {
  if (!/\.(mp4|mov|m4v|m4a)$/i.test(p)) return true;
  let fd = null;
  try {
    const size = statSync(p).size, b = Buffer.alloc(16);
    fd = openSync(p, 'r');
    for (let off = 0, i = 0; i < 64 && off + 8 <= size; i++) {
      if (readSync(fd, b, 0, 16, off) < 8) return false;
      const type = b.toString('latin1', 4, 8);
      if (type === 'moov') return true;
      let n = b.readUInt32BE(0);
      if (n === 1) n = Number(b.readBigUInt64BE(8));
      if (n < 8) return false; // 0: the box runs to the end of the file (ffmpeg's mdat while it writes)
      off += n;
    }
    return false;
  } catch { return false; } finally { if (fd != null) try { closeSync(fd); } catch {} }
}
// The same for any file (renders use it too).
export function probeFile(p) {
  const key = `${p}:${mtime(p)}`;
  if (probes.has(key)) return probes.get(key);
  if (!mp4Whole(p)) return null;
  try {
    const out = JSON.parse(String(execFileSync(studioTool('ffprobe'), ['-v', 'error', '-show_entries',
      'stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration', '-of', 'json', p], { timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] })));
    const v = out.streams.find((s) => s.codec_type === 'video');
    const [n, d] = String(v?.avg_frame_rate || '0/1').split('/').map(Number);
    const info = { w: v?.width || 0, h: v?.height || 0, fps: d ? n / d : 0, duration: Number(out.format?.duration) || 0,
      audio: out.streams.some((s) => s.codec_type === 'audio'), codec: v?.codec_name || null };
    probes.set(key, info);
    return info;
  } catch { return null; }
}

// The locked cut, if any: the newest of the Cut Editor save and the join-check fix (segments in source seconds).
// A cut saved before the canvas take was replaced belongs to the old take, so it doesn't count.
export function lockedCut(dir) {
  const since = projectMeta(dir)?.activeSince || 0;
  const files = ['work/edl_manual.json', 'work/edl_fixed.json'].filter((f) => existsSync(join(dir, f)) && mtime(join(dir, f)) > since)
    .sort((a, b) => mtime(join(dir, b)) - mtime(join(dir, a)));
  for (const f of files) {
    const segs = readJSON(join(dir, f), {})?.segments_sec;
    if (Array.isArray(segs) && segs.length) return { file: f, segments: segs };
  }
  return null;
}

// ---- a learned format's plan approval (B4 + learning.mjs): the same decision as Approve plan ----
// The approval holds for this plan, on this locked cut, with this pinned guide version: a hash of the three. The plan
// is hashed without what isn't the plan itself: the creator's top-level "approved" (B4) and each scene's build status
// (B5b's marks, sheet.py mark), so approving or building never makes the approval stale; a changed scene or cut does.
export function planToken(plan, cut, versionId) {
  const p = plan && typeof plan === 'object' ? { ...plan } : plan;
  if (p && typeof p === 'object') {
    delete p.approved;
    if (Array.isArray(p.scenes)) p.scenes = p.scenes.map((x) => { if (!x || typeof x !== 'object') return x; const { status, ...rest } = x; return rest; });
  }
  return createHash('sha256').update(JSON.stringify(p)).update(JSON.stringify(cut)).update(String(versionId || '')).digest('hex');
}
// The token an approval made before this rule held (the sheet's raw bytes): still accepted while the bytes are the same.
export const legacyPlanToken = (raw, cut, versionId) => createHash('sha256').update(raw).update(JSON.stringify(cut)).update(String(versionId || '')).digest('hex');
// For a project on a learned format (learning: its pinned learning, project.json or the database's binding): null when
// it isn't one or there is no plan; else { token, ok } where ok says the learned approval is for this plan and cut.
export function learnedPlanApproval(dir, learning = projectMeta(dir)?.learning) {
  if (!learning?.versionId) return null;
  let raw;
  try { raw = readFileSync(join(dir, 'work/production.json')); } catch { return null; }
  let plan; try { plan = JSON.parse(raw); } catch { return null; }
  const cut = lockedCut(dir), token = planToken(plan, cut, learning.versionId);
  const ok = Boolean(learning.planApproval) && (learning.planApproval === token || learning.planApproval === legacyPlanToken(raw, cut, learning.versionId));
  return { token, ok, plan };
}

export const proxyName = (file) => `work/proxy_${basename(file, extname(file))}.mp4`;

export function listProjects() {
  const root = projectsRoot();
  let names = [];
  try { names = readdirSync(root); } catch { return []; }
  return names
    .filter((n) => !n.startsWith('.') && !n.startsWith('_'))
    .map((n) => join(root, n))
    .filter((d) => statSync(d).isDirectory())
    .map((dir) => {
      const meta = projectMeta(dir);
      const id = basename(dir);
      const status = meta ? pipelineStatus(dir, meta.type) : null;
      const next = status?.steps.find((s) => s.id === status.next);
      // The step the editor's dock offers (status.current): the next required step, else an optional one not done or
      // skipped. Home names this one, so Projects and the dock never disagree on what comes next (B2).
      const current = status?.steps.find((s) => s.id === status.current);
      // The stage the video is at, as Home's Continue hero says it: "Step 3 of 6 · Cut". Only a step that must be done
      // counts: a video whose required steps are all done is Done, not "Package" (an optional step never done).
      const stages = status?.stages || [];
      const at = next ? stages.findIndex((x) => x.name === next.stage) : -1;
      return {
        id,
        name: meta?.name || id,
        nameSource: meta?.nameSource === 'auto' ? 'auto' : 'manual',
        type: formatId(meta?.type),
        updated: Math.max(mtime(dir), mtime(join(dir, 'work')), mtime(join(dir, 'WORKLOG.md'))),
        next: next ? next.name : null,
        current: current ? current.name : null,
        currentOptional: Boolean(current?.optional),
        // one entry per step for the progress bar on Home: 1 done, 2 next, 0 still to do
        progress: status ? status.steps.map((s) => (s.done ? 1 : s.id === status.next ? 2 : 0)) : null,
        steps: status ? status.steps.map((s) => s.name) : null,
        // notes and changes waiting in the change package (Home's "waiting for you")
        waiting: (readJSON(join(dir, 'work', 'notes.json'), null)?.notes || []).filter((n) => n?.status === 'open').length,
        stage: at >= 0 ? stages[at].name : null,
        stageIndex: at >= 0 ? at + 1 : null,
        stageCount: stages.length || null,
        // A finished video in renders/ (Home's "Exported" badge), and whether the project has a take yet.
        exported: (() => { try { return readdirSync(join(dir, 'renders')).some((f) => EXPORT_NAME.test(f)); } catch { return false; } })(),
        hasTake: (meta?.takes || []).length > 0 || hasVideo(join(dir, 'source')),
        app: Boolean(meta),
      };
    })
    .sort((a, b) => (b.app - a.app) || (b.updated - a.updated));
}

// A take file (video or sound) straight inside a folder; dot files and partial copies don't count.
function hasVideo(folder) {
  const re = /\.(mp4|mov|m4v|mkv|webm|wav|m4a|mp3|aif|aiff|caf|flac)$/i;
  try { return readdirSync(folder).some((f) => !f.startsWith('.') && !f.endsWith('.part') && re.test(f)); } catch { return false; }
}

// A project id is never given to a new project while something still belongs to it: an archived folder, or (through
// the check index.mjs registers) a saved chat, chat log or rows in the studio database (learning and context pins, a
// memory binding). Those stay with the archived project, so restoring it brings it back as it was, and the new project
// starts clean under the next free name (my-video-2).
let idInUse = () => false;
export const setProjectIdCheck = (fn) => { idInUse = typeof fn === 'function' ? fn : () => false; };
const projectIdTaken = (root, id) => existsSync(join(root, id)) || existsSync(join(root, '_archive', id)) || idInUse(id);

// extra: more project.json fields, e.g. { nameSource: 'auto' } for a video made as "Untitled video" (server/naming.mjs).
export function createProject(name, type, style, extra = {}) {
  const formats = PIPELINES().formats;
  type = formatId(type);
  if (!formats[type]) throw new Error('Unknown project type');
  const styles = formats[type].styles || [];
  style = styles.some((x) => x.id === style) ? style : styles[0]?.id;
  const root = projectsRoot();
  mkdirSync(root, { recursive: true });
  let id = slugify(name);
  for (let i = 2; projectIdTaken(root, id); i++) id = `${slugify(name)}-${i}`;
  const dir = join(root, id);
  for (const sub of ['source', 'work', 'renders']) mkdirSync(join(dir, sub), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(join(dir, 'WORKLOG.md'),
    `# ${name}\n\nType: ${formats[type].label}${style ? ` (${styles.find((x) => x.id === style).label})` : ''}\nStarted: ${today} (Video Octopus app)\n\n## Log\n`);
  saveProjectMeta(dir, { name, type, ...(style ? { shortStyle: style } : {}), created: today, takes: [], layout: defaultLayout(type), ...extra });
  return id;
}

// Takes from the recorder: one folder per take with <stamp>_screen.mp4 / _webcam.mp4 (.mov in older takes; or only
// the _webcam file, or only _audio.wav for a mic-only take).
export function listTakes() {
  const root = settings().recordingsDir;
  let names = [];
  try { names = readdirSync(root); } catch { return []; }
  // Takes already copied into a project (project.json "takes"): Home only offers the unused ones. by: take -> the
  // names of the projects that use it (the New project dialog's full list says so).
  const used = new Set(), by = new Map();
  try {
    for (const n of readdirSync(projectsRoot())) {
      if (n.startsWith('.') || n.startsWith('_')) continue;
      const m = projectMeta(join(projectsRoot(), n));
      for (const t of m?.takes || []) { used.add(t); by.set(t, [...(by.get(t) || []), m.name || n]); }
    }
  } catch {}
  return names
    .map((n) => join(root, n))
    .filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } })
    .map((d) => {
      const files = readdirSync(d).filter((f) => isTakeFile(f) && !f.startsWith('.'));
      const bytes = files.reduce((t, f) => t + statSync(join(d, f)).size, 0);
      // transcribed: "Transcribe new recordings" wrote its words into the take's own tr/ folder (schedules.mjs)
      // An imported file taken off its video (Media › Remove from this video) waits here with import.json: Recordings
      // names it after the original file and marks it Imported (A17).
      const imp = readJSON(join(d, IMPORT_NOTE), null);
      return { id: basename(d), files, bytes, at: mtime(d), used: used.has(basename(d)), projects: by.get(basename(d)) || [], transcribed: existsSync(join(d, 'tr', 'words.json')),
        ...(imp ? { imported: true, name: String(imp.name || files[0]) } : {}) };
    })
    .filter((t) => t.files.length)
    .sort((a, b) => b.at - a.at);
}

// How long a take is: its main file (the camera, else the screen, else the sound), probed once until it changes.
export function takeDuration(t) {
  const f = takeMain(t.files);
  return f ? probeFile(join(settings().recordingsDir, t.id, f))?.duration || null : null;
}

// The file of a take to transcribe, as roles() picks the main one: the camera (it carries the mic), else the screen,
// else any video, else the mic-only sound.
export const takeMain = (files = []) => files.find((f) => /_webcam\./i.test(f)) || files.find((f) => /_screen\./i.test(f)) || files.find((f) => VIDEO.test(f)) || files.find((f) => TAKE_AUDIO.test(f)) || null;

// Copy a take into the project. On APFS this is a clone: instant, no extra disk space.
export function importTake(dir, takeId) {
  if (!takeId || /[\\/]/.test(takeId) || takeId.includes('..')) throw new Error('Bad take');
  return importTakeFrom(dir, join(settings().recordingsDir, takeId));
}

// A take folder's files into the project's source/: a clone (APFS: instant, no extra space) of a recorder take, or, for an
// imported file waiting in Recordings (import.json, A17), the file itself, moved, so it is never in two places. The
// folder then goes (with what Video Octopus made in it: import.json, a tr/ transcript, which is copied below).
// { files, imported: { name, at } | null }.
export const IMPORT_NOTE = 'import.json';
export function takeIntoSource(dir, takeDir) {
  const files = readdirSync(takeDir).filter((f) => isTakeFile(f) && !f.startsWith('.'));
  if (!files.length) throw new Error('That take has no video or sound files.');
  mkdirSync(join(dir, 'source'), { recursive: true });
  const imp = readJSON(join(takeDir, IMPORT_NOTE), null);
  if (!imp) {
    for (const f of files) {
      const to = join(dir, 'source', f);
      if (!existsSync(to)) copyFileSync(join(takeDir, f), to, constants.COPYFILE_FICLONE);
    }
    return { files, imported: null };
  }
  for (const f of files) if (existsSync(join(dir, 'source', f))) throw new Error(`source/${f} is in this video already.`);
  for (const f of files) moveFile(join(takeDir, f), join(dir, 'source', f));
  if (existsSync(join(takeDir, 'tr', 'words.json')) && !['work/tr/words.json', 'work/words.json'].some((f) => existsSync(join(dir, f)))) {
    try { cpSync(join(takeDir, 'tr'), join(dir, 'work', 'tr'), { recursive: true }); } catch {}
  }
  const rest = readdirSync(takeDir).filter((n) => n !== IMPORT_NOTE && n !== 'tr' && !n.startsWith('.'));
  if (!rest.length) rmSync(takeDir, { recursive: true, force: true });
  else rmSync(join(takeDir, IMPORT_NOTE), { force: true });
  return { files, imported: { name: String(imp.name || files[0]), at: imp.at || Date.now() } };
}
// rename, or across disks a copy that is complete before the original goes.
export function moveFile(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  if (existsSync(to)) throw new Error(`${to} is already there.`);
  try { renameSync(from, to); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    copyFileSync(from, to, constants.COPYFILE_EXCL);
    rmSync(from, { force: true });
  }
}

// The same for a take folder anywhere (a take the recorder just saved). The take becomes the active one,
// unless it's added as a layer (keepActive), which leaves the canvas take as it is.
export function importTakeFrom(dir, takeDir, how = 'Imported', { keepActive = false } = {}) {
  const takeId = basename(takeDir);
  const { files, imported } = takeIntoSource(dir, takeDir);
  const meta = projectMeta(dir) || {};
  const active = keepActive && meta.activeTake ? meta.activeTake : keepActive ? (meta.takes || [])[0] || takeId : takeId;
  // activeSince: cuts saved before this moment belong to an earlier take (see lockedCut).
  const since = active !== meta.activeTake && (meta.activeTake || (meta.takes || []).length) ? { activeSince: Date.now() } : {};
  // An imported file moves into the video and is one of its imports again, not a take (it isn't in Recordings twice).
  const list = imported ? { imports: { ...(meta.imports || {}), [takeId]: imported } } : { takes: [...new Set([...(meta.takes || []), takeId])] };
  saveProjectMeta(dir, { ...list, activeTake: active, ...since });
  appendWorklog(dir, imported ? `Moved ${imported.name} from Recordings into the video${keepActive ? ' as a new layer' : ''}: ${files.map((f) => `source/${f}`).join(', ')}`
    : `${how} take ${takeId}${keepActive ? ' as a new layer' : ''}: ${files.join(', ')}`);
  // A take transcribed before it was in a project (its tr/ folder, from "Transcribe new recordings") brings its
  // transcript when it becomes the canvas take of a project that has none: the Transcribe step is done already.
  if (active === takeId && existsSync(join(takeDir, 'tr', 'words.json')) && !['work/tr/words.json', 'work/words.json'].some((f) => existsSync(join(dir, f)))) {
    try { cpSync(join(takeDir, 'tr'), join(dir, 'work', 'tr'), { recursive: true }); appendWorklog(dir, `Transcript of take ${takeId} (made before it was in a project) copied into work/tr/`); } catch {}
  }
  return files;
}

// New project → "Import a file…": a video or sound file from this computer becomes the project's take. It streams
// into source/ (a sound file is named <name>_audio.<ext>, like a mic-only take) and becomes the canvas take.
// keepActive: the file comes in as a layer (the Media section's Add as a layer → Import a file…): the canvas take stays.
export async function importUpload(dir, req, name, { keepActive = false } = {}) {
  const ext = extname(String(name || '')).toLowerCase();
  if (!MEDIA.test(ext)) throw new Error('Pick a video (.mov, .mp4, .m4v, .mkv, .webm) or a sound file (.wav, .m4a, .mp3, .aif, .flac).');
  const stem = basename(String(name), extname(String(name))).replace(/[^\w.() -]/g, '_').replace(/^[.\s]+/, '').slice(0, 80) || 'take';
  let take = stem;
  for (let i = 2; sources(dir).some((f) => f.startsWith(take)); i++) take = `${stem} (${i})`;
  // A screen recording by its name (macOS "Screen Recording 2026-10-24 at 10.02.11.mov", "Bildschirmaufnahme …",
  // QuickTime's and Windows' screen captures, "screencast") lands as the take's screen, not as a camera (A17).
  const screenName = /screen[\s_-]*(recording|capture|cast)|screencast|bildschirmaufnahme|enregistrement de l.écran|grabación de pantalla|schermopname|registrazione schermo/i.test(stem);
  const file = isAudio(ext) ? `${take}_audio${ext}` : screenName && !/_screen$/i.test(take) ? `${take}_screen${ext}` : `${take}${ext}`;
  mkdirSync(join(dir, 'source'), { recursive: true });
  const part = join(dir, 'source', `.${file}.part`);
  try { await pipeline(req, createWriteStream(part)); } catch (e) { rmSync(part, { force: true }); throw e; }
  if (!statSync(part).size) { rmSync(part, { force: true }); throw new Error('The file was empty.'); }
  renameSync(part, join(dir, 'source', file));
  // project.json imports: the original file's name, for Recordings (A17: an imported file is listed where it is, in
  // source/, named after the file it came from; no second copy is made).
  const imported = { name: basename(String(name)).slice(0, 200), at: Date.now() };
  if (keepActive) {
    // A project made by hand may not say which take is on the canvas: it's named now, so the layer can't take its place.
    const before = projectMeta(dir) || {};
    if (!before.activeTake) {
      const main = roles(dir).take.find((f) => f !== file);
      if (main) saveProjectMeta(dir, { activeTake: takeKey(main) });
    }
    saveProjectMeta(dir, { imports: { ...(projectMeta(dir)?.imports || {}), [takeKey(file)]: imported } });
    appendWorklog(dir, `Imported ${name} as a new layer: source/${file}`);
    return [file];
  }
  const meta = projectMeta(dir) || {};
  saveProjectMeta(dir, { activeTake: take, imports: { ...(meta.imports || {}), [takeKey(file)]: imported }, ...(meta.activeTake ? { activeSince: Date.now() } : {}) });
  appendWorklog(dir, `Imported ${name} as the take: source/${file}`);
  return [file];
}

export function appendWorklog(dir, line) {
  const p = join(dir, 'WORKLOG.md');
  const today = new Date().toISOString().slice(0, 10);
  const text = existsSync(p) ? readFileSync(p, 'utf8') : '# Worklog\n';
  writeFileSync(p, text.replace(/\n*$/, '\n') + `- ${today}: ${line}\n`);
}

// What the editor plays and the 720p editing copies: server/playback.mjs (re-exported here for the callers and tests
// that have always found them in this module).
export { makeProxies, proxyRunning } from './playback.mjs';

// ---- pipeline ----
// The stages a video goes through, always the same (core/pipelines.json "stages": name, title, what for the
// first-time help). Every step names one (`stage`); a studio's own step without one joins the stage before it.
// Package (thumbnails, optional, never blocking) comes first; a format without a package step doesn't show it.
export const STAGE_NAMES = ['Package', 'Record', 'Cut', 'Plan', 'Build', 'Polish'];
const TABS = new Set(['packaging', 'canvas', 'scenes', 'cut', 'renders', 'post']);
const two = (t) => { t = Math.max(0, Math.round(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// "your intro, main body, sponsor read and outro": a format's block names, for a step's {blocks}.
const blockList = (fmt) => {
  const names = (fmt.blocks || []).map((b) => (/^[A-Z]{2,}$/.test(b.label) ? b.label : String(b.label || '').toLowerCase())).filter(Boolean);
  if (!names.length) return 'each part';
  return `your ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}`;
};

// opts.lines: each done step's line from its files (the dock's done moment and chat marker, the stage list); opts.seen: the steps done when
// the page last looked (local state, index.mjs), so `finished` is the newest step that finished since then.
// What a step makes, in words, from its done rule: "Build the intro didn't produce its video" (the dock, turns.mjs).
const MAKES = [[/^renders\/.*\.(mp4|mov)$/i, 'its video'], [/production\.json$/, 'the scene plan (work/production.json)'], [/joins\.json$/, 'the checked cut (work/joins.json)'],
  [/blocks\.json$/, 'the sections (work/blocks.json)'], [/edl_manual\.json$/, 'the edited cut (work/edl_manual.json)'], [/words\.json$/, 'the transcript'],
  [/rough_map\.json$/, 'the rough cut (work/rough_map.json)'], [/post\.(md|json)$/, 'the post (post.md)'], [/packaging\.json$/, 'a main thumbnail'], [/zooms\.json$/, 'its zooms'], [/^source\//, 'a take']];
export function makesOf(d = {}) {
  const file = d.files?.[0] || (Array.isArray(d.json) ? d.json[0] : '') || (typeof d.kept === 'string' ? d.kept : '');
  const m = file && MAKES.find(([re]) => re.test(file));
  if (m) return m[1];
  if (file) return file;
  return d.worklog ? `its line in WORKLOG.md ("${d.worklog}")` : 'its result';
}

export function pipelineStatus(dir, type, opts = {}) {
  const p = PIPELINES();
  const fmt = p.formats[formatId(type)];
  if (!fmt) return null;
  const worklog = (() => { try { return readFileSync(join(dir, 'WORKLOG.md'), 'utf8'); } catch { return ''; } })();
  const skippedIds = new Set((projectMeta(dir)?.skipped || []).filter((x) => typeof x === 'string'));
  const importIds = new Set((projectMeta(dir)?.doneByImport || []).filter((x) => typeof x === 'string'));
  let prevStage = null;
  const stepOf = (s) => {
    let step = typeof s === 'string' ? { id: s, ...p.shared[s] } : s;
    const d = step.done || {};
    let done = (d.files || []).some((f) => globExists(dir, f)) || (d.worklog ? worklog.includes(d.worklog) : false)
      || (Array.isArray(d.json) ? Boolean(readJSON(join(dir, d.json[0]), null)?.[d.json[1]]) : false)
      || (typeof d.kept === 'string' ? keptItems(dir, d.kept).kept > 0 : false)
      // built: a Build step of this format has its render (a plan made before plans needed approval, B4).
      || (d.built ? buildRendered(dir, fmt) : false);
    // Done by import (B9, already-edited footage): a required step the import made pointless (Clean up, Lock the cut).
    const byImport = importIds.has(step.id);
    if (byImport) done = true;
    // The cut changed after it was locked (a word deleted since): the lock no longer holds, and the step waits to run
    // again (Claude checks the new joins). changed says why, for the Cut tab, the canvas and Export's words.
    // unlocked: the creator pressed Unlock to edit (B3): the same, by choice.
    // A learned format's plan (B4): Approve plan is also its learned approval, so the plan is approved only while that
    // still holds; once the plan or the cut changed after it, Approve the plan is next again (a built video stays done).
    let restale = false;
    if (done && Array.isArray(d.json) && d.json[1] === 'approved' && !(d.built && buildRendered(dir, fmt))) {
      const la = learnedPlanApproval(dir);
      if (la && !la.ok) { done = false; restale = true; }
    }
    const ls = done && step.id === 'lock' ? lockState(dir) : null;
    const changed = Boolean(ls?.changed), unlocked = Boolean(ls?.unlocked) && !changed;
    if (changed || unlocked) done = false;
    // The plan is written but not approved yet (B4): the creator's turn, so it shows as an app step, "Approve the plan",
    // that opens the Plan stage; Build waits behind it.
    const awaiting = !done && Array.isArray(d.json) && d.json[1] === 'approved' && planWritten(dir, d.json[0]);
    if (awaiting) step = { ...step, name: 'Approve the plan', kind: 'app', action: 'open-plan', skill: null,
      what: restale ? 'The plan or the locked cut changed since you approved it. Read it again, then approve it again (or ask Claude for changes).'
        : 'Read each scene’s line and what’s on screen, then approve the plan, or ask Claude for changes.', where: 'the plan, in the Plan stage' };
    const optional = Boolean(step.optional), kind = step.kind || 'claude';
    // The words the creator reads. A step without them (a studio's own) shows its label and a plain line.
    const stage = STAGE_NAMES.includes(step.stage) ? step.stage : prevStage || (step.action === 'import' ? 'Record' : 'Build');
    prevStage = stage;
    const show = step.show && TABS.has(step.show.tab) ? { tab: step.show.tab, target: String(step.show.target || step.show.tab) } : null;
    const what = step.what || (kind === 'app' ? 'Opens a part of Video Octopus for you to do this step.' : step.skill ? `Claude runs the ${step.skill} skill for this project.` : 'Claude does this step in the chat.');
    return { id: step.id, label: step.label, name: step.name || step.label || step.id, stage, makes: makesOf(d),
             what: String(what).replaceAll('{blocks}', blockList(fmt)), where: step.where || (kind === 'app' ? '' : 'what changed, in Claude’s reply'), show,
             kind, action: step.action || null,
             skill: step.skill || null, ask: step.ask || '', brief: step.brief || null, motion: step.motion || null, ...(step.scenes ? { scenes: String(step.scenes) } : {}), optional, done, ...(changed ? { changed: true } : {}), ...(unlocked ? { unlocked: true } : {}), ...(awaiting ? { awaiting: 'approve', ...(restale ? { again: true } : {}) } : {}), ...(byImport && done ? { byImport: true } : {}),
             skipped: optional && !done && skippedIds.has(step.id),
             subs: step.subs ? step.subs.map((x) => ({ id: x.id, label: x.label, done: x.files.some((f) => globExists(dir, f)) })) : null,
             ...(opts.lines && done ? { line: byImport ? 'Done · already edited' : doneLine(dir, step, worklog) } : {}) };
  };
  const steps = fmt.steps.map(stepOf);
  const next = steps.find((s) => !s.done && !s.optional)?.id || null;
  // The step the dock and the lit stage show: the next one that must be done, else an optional one that isn't
  // done or skipped (Add zooms at the end of a tutorial), else none (every step done).
  const current = next || steps.find((s) => !s.done && !s.skipped)?.id || null;
  const cur = steps.find((s) => s.id === current);
  const words = new Map((Array.isArray(p.stages) ? p.stages : []).map((x) => [x.name, x]));
  const stages = STAGE_NAMES.filter((name) => name !== 'Package' || steps.some((s) => s.stage === name)).map((name) => {
    const ss = steps.filter((s) => s.stage === name);
    return { name, title: words.get(name)?.title || '', what: words.get(name)?.what || '', steps: ss.map((s) => s.id),
      // A stage of optional steps only (Package) is done when they are done or skipped, not by being optional.
      done: ss.length > 0 && ss.every((s) => s.done || s.optional) && (ss.some((s) => !s.optional) || ss.every((s) => s.done || s.skipped)),
      current: cur?.stage === name };
  });
  // Single steps that stay reachable from the rail's ⋯ menu (Clean up runs them in one go).
  prevStage = 'Cut';
  const more = (fmt.more || []).map(stepOf);
  const out = { format: fmt.label, steps, next, current, stages, skipped: steps.filter((s) => s.skipped).map((s) => s.id), learn: p.learn, more };
  if (Array.isArray(opts.seen)) {
    out.seen = opts.seen;
    const fin = steps.filter((s) => s.done && !opts.seen.includes(s.id)).at(-1);
    out.finished = fin ? { id: fin.id, name: fin.name, line: fin.line || '', show: fin.show } : null;
  }
  return out;
}

// A Build step of the format has its render (renders/*intro*.mp4 …): the plan it was built from counts as approved.
function buildRendered(dir, fmt) {
  return (fmt.steps || []).map((x) => (typeof x === 'string' ? { id: x, ...PIPELINES().shared[x] } : x))
    .some((x) => x.stage === 'Build' && (x.done?.files || []).some((f) => globExists(dir, f)));
}
// A sheet with scenes in it (the plan Claude wrote), waiting for the creator's Approve plan.
function planWritten(dir, rel) { const p = readJSON(join(dir, rel), null); return Array.isArray(p?.scenes) && p.scenes.length > 0; }

// ---- what a finished step made, in one line, from its files (the dock, the chat's done marker, the stage list) ----
// The newest file a pattern matches ("renders/*intro*.mp4"), relative to the project.
function newestMatch(dir, pattern) {
  if (!pattern.includes('*')) return existsSync(join(dir, pattern)) ? pattern : null;
  const sub = pattern.split('/').slice(0, -1).join('/');
  const re = new RegExp('^' + pattern.split('/').pop().split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  let best = null, at = -1;
  try { for (const f of readdirSync(join(dir, sub))) if (re.test(f) && !f.startsWith('.')) { const m = mtime(join(dir, sub, f)); if (m > at) { at = m; best = sub ? `${sub}/${f}` : f; } } } catch {}
  return best;
}
export const cutCount = (dir) => {
  const p = readJSON(join(dir, 'work/prepare.json'), null), map = readJSON(join(dir, 'work/rough_map.json'), null);
  return Number.isFinite(Number(p?.cuts)) ? Number(p.cuts) : Array.isArray(map?.applied) ? map.applied.length : Math.max(0, (map?.segments?.length || 1) - 1);
};
// Joins checked, and what still needs the creator (cutreview.mjs needsYou: the same count as the dock, the Cut chip,
// the Cut inspector and the Keep / Cut list).
const joinCounts = (dir) => {
  const p = readJSON(join(dir, 'work/prepare.json'), null), j = readJSON(join(dir, 'work/joins.json'), null);
  const joins = Number.isFinite(Number(p?.joins)) ? Number(p.joins) : Number(j?.summary?.joins) || (Array.isArray(j?.joins) ? j.joins.length : 0);
  return { joins, look: needsYou(dir) };
};
const lookText = (n) => (n ? `${n} to check` : 'nothing to check');
// Edits in the Cut tab's save against the cut it started from: each place where the kept parts differ (a word
// deleted, an edge trimmed, a cut brought back) is one edit, however many edges it moved.
function cutEdits(dir) {
  const segs = (f) => readJSON(join(dir, f), null)?.segments_sec;
  const mine = segs('work/edl_manual.json');
  if (!Array.isArray(mine)) return null;
  // The cut the creator's editing started from: kept by Video Octopus at the first Cut tab save (cutreview.mjs markEdits),
  // else join-check's fixed cut (unless the Lock remade it from the creator's own save), else the rough cut.
  const fixed = readJSON(join(dir, 'work/edl_fixed.json'), null);
  const base = readJSON(join(dir, 'work/cut_review.json'), null)?.editBase?.segments
    || (fixed?.segments_sec && !/edl_manual/.test(String(fixed.from || '')) ? fixed.segments_sec : null)
    || (readJSON(join(dir, 'work/rough_map.json'), null)?.segments || []).map((s) => s.src).filter(Array.isArray);
  if (!base?.length) return { parts: mine.length, edits: null };
  return { parts: mine.length, edits: cutChanges(base, mine).length };
}
// The places where two cuts differ (take seconds; under 20 ms doesn't count), merged when they touch.
export function cutChanges(A, B) {
  const num = (L) => L.map((s) => [Number(s[0]), Number(s[1])]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a);
  const minus = (X, Y) => X.flatMap(([a, b]) => Y.reduce((parts, [c, d]) => parts.flatMap(([x, y]) => (d <= x || c >= y ? [[x, y]] : [[x, Math.min(y, c)], [Math.max(x, d), y]].filter(([p, q]) => q - p > 1e-6))), [[a, b]]));
  const a = num(A), b = num(B);
  const diff = [...minus(a, b), ...minus(b, a)].sort((x, y) => x[0] - y[0]), out = [];
  for (const r of diff) { const l = out.at(-1); if (l && r[0] <= l[1] + 1e-3) l[1] = Math.max(l[1], r[1]); else out.push([...r]); }
  return out.filter(([x, y]) => y - x >= 0.02);
}
// The items of a zooms (or shots) file: how many are kept and how many wait as Claude's proposals (a v1 zooms file's
// punch-ins count as kept).
function keptItems(dir, rel) {
  const f = readJSON(join(dir, rel), null);
  const list = Array.isArray(f?.items) ? f.items : Array.isArray(f?.zooms) ? f.zooms : Array.isArray(f?.shots) ? f.shots : [];
  const proposed = list.filter((x) => x && x.status === 'proposed').length;
  return { kept: list.filter((x) => x && typeof x === 'object').length - proposed, proposed };
}
const RENDERED = { intro: 'Intro', 'edit-short': 'Short', 'edit-explainer': 'Explainer' };
const DONE_LINES = {
  package: (dir) => { const w = readJSON(join(dir, 'packaging/packaging.json'), {})?.winners || []; return `Main thumbnail chosen${w.length > 1 ? `, ${w.length} winners` : ''}`; },
  import: (dir) => { const r = roles(dir); const d = r.main ? probe(dir, r.main)?.duration : 0; return d ? `Take added: ${two(d)}` : 'Take added'; },
  prepare: (dir) => { const { joins, look } = joinCounts(dir); return `${plural(cutCount(dir), 'cut')} made, ${plural(joins, 'join')} checked, ${lookText(look)}`; },
  transcribe: (dir) => { const w = readJSON(join(dir, existsSync(join(dir, 'work/tr/words.json')) ? 'work/tr/words.json' : 'work/words.json'), []); return Array.isArray(w) && w.length ? `${plural(w.length, 'word')} transcribed` : 'Transcript written'; },
  'rough-cut': (dir) => `${plural(cutCount(dir), 'cut')} made`,
  'join-check': (dir) => { const { joins, look } = joinCounts(dir); return `${plural(joins, 'join')} checked, ${lookText(look)}`; },
  sections: (dir) => {
    const list = (readJSON(join(dir, 'work/blocks.json'), null)?.blocks || []).filter((b) => b && Array.isArray(b.source?.take));
    if (!list.length) return 'Sections marked';
    // On the video as it plays (the cut's clock), like every time the creator reads.
    const at = (t) => two(cutMap(lockedCut(dir)?.segments).toCut(t));
    if (list.length === 1) return `1 section added: ${list[0].label}, ${at(list[0].source.take[0])}–${at(list[0].source.take[1])}`;
    const names = list.map((b) => b.label);
    return `${list.length} sections added: ${names.length > 4 ? `${names.slice(0, 4).join(', ')}…` : names.join(', ')}`;
  },
  'cut-editor': (dir) => { const c = cutEdits(dir); return !c ? 'Cut saved' : c.edits != null ? `Cut saved: ${plural(c.edits, 'edit')}` : `Cut saved: ${plural(c.parts, 'part')}`; },
  lock: (dir, worklog) => { const m = /Cut locked[^\n]*?(\d+) joins?,\s*(\d+) clipped/.exec(worklog); return m ? `Cut locked: ${plural(Number(m[1]), 'join')}, ${m[2]} clipped` : 'Cut locked'; },
  plan: (dir) => { const n = (readJSON(join(dir, 'work/production.json'), null)?.scenes || []).length; return n ? `${plural(n, 'scene')} planned` : 'Scene plan written'; },
  review: (dir) => {
    const n = (readJSON(join(dir, 'work/production.json'), null)?.scenes || []).filter((s) => s && s.id != null);
    const ok = readJSON(join(dir, 'work/notes.json'), null)?.approved || {};
    // The scenes there are to approve: the ones a render has built (server/built.mjs), else all of them.
    const end = builtEnd(dir), built = end > 0 ? n.filter((s) => isBuilt({ start: Number(s.start) || 0 }, end)) : n;
    return n.length ? `${built.filter((s) => ok[s.id]).length} of ${built.length} ${built.length < n.length ? 'built ' : ''}scenes approved` : 'Scenes approved';
  },
  zooms: (dir) => {
    const f = readJSON(join(dir, 'work/zooms.json'), null), { kept, proposed } = keptItems(dir, 'work/zooms.json');
    const waiting = proposed ? ` · ${plural(proposed, 'proposal')} to keep or turn down` : '';
    // Nothing to zoom on the face is a finished step too: zooms.json with the reason ("you're never full frame").
    const short = (t) => { t = t.trim().split(/(?<=[.!?])\s/)[0].replace(/[.\s]+$/, ''); return t.length > 80 ? `${t.slice(0, 78).replace(/[\s,;:(]+\S*$/, '')}…` : t; };
    if (!kept && typeof f?.reason === 'string' && f.reason.trim()) return `No zooms needed: ${short(f.reason)}${waiting}`;
    if (!kept) return proposed ? `${plural(proposed, 'zoom')} proposed, none kept yet` : 'No zooms needed';
    return `${plural(kept, 'zoom')} placed${waiting}`;
  },
  'post-kit': () => 'Post kit written',
};
export function doneLine(dir, step, worklog = '') {
  try {
    if (DONE_LINES[step.id]) return DONE_LINES[step.id](dir, worklog);
    // A build step, or a studio's own step: the video it made and how long it is, else the file or the worklog line.
    const d = step.done || {};
    const f = (d.files || []).map((x) => newestMatch(dir, x)).find(Boolean);
    if (f && (RENDERED[step.id] || /\.(mp4|mov|m4v)$/i.test(f))) {
      const dur = probeFile(join(dir, f))?.duration;
      return `${RENDERED[step.id] || basename(f)} rendered${dur ? `: ${two(dur)}` : ''}`;
    }
    if (f) return `Made ${f}`;
    if (d.worklog) { const ln = worklog.split('\n').reverse().find((x) => x.includes(d.worklog)); if (ln) return ln.replace(/^[-*]\s*(\d{4}-\d\d-\d\d:\s*)?/, '').slice(0, 100); }
    if (Array.isArray(d.json)) return `Saved in ${d.json[0]}`;
  } catch {}
  return 'Done';
}

// ---- already-edited footage (B9) ----
// "Is this video already edited?" → Yes, when a file is dropped or imported as the take: the whole file is the cut
// (work/edl_manual.json, by IMPORT_BY), and Clean up and Lock the cut are done by import (project.json doneByImport,
// a done override that holds for required steps; the step list says "Done · already edited"). The lock it stands for
// is kept like a real one (cut_review.json lock, by "import"), so the Cut tab is read-only until Unlock. Claude only
// transcribes it (index.mjs), and Split into sections stays: Plan uses the sections. cleanUpAnyway takes it back.
export const IMPORT_DONE = ['prepare', 'cut-editor', 'lock']; // (Fix the cut is optional: its file is the whole-file cut)
export const IMPORT_BY = 'Video Octopus import: already edited, the whole file is the cut';
export function markAlreadyEdited(dir, { duration = null } = {}) {
  const r = roles(dir);
  if (!r.main) throw new Error('Import the edited video first.');
  const d = duration ?? probe(dir, r.main)?.duration;
  if (!(d > 0)) throw new Error(`Couldn't read how long ${r.main} is, so it can't be the cut yet.`);
  const segs = [[0, Math.round(d * 1000) / 1000]];
  writeJSON(join(dir, 'work', 'edl_manual.json'), { source: join(dir, 'source', r.main), segments_sec: segs, saved_at: new Date().toISOString(), edited_length: segs[0][1], by: IMPORT_BY });
  saveProjectMeta(dir, { doneByImport: IMPORT_DONE });
  importLock(dir, segs);
  appendWorklog(dir, `Imported ${r.main} as already edited: the whole file is the cut (Clean up, Fix the cut and Lock the cut done by import)`);
  return segs;
}
// "Clean it up anyway": the steps done by import are to do again, and the whole-file cut goes (Clean up makes the cut).
export function cleanUpAnyway(dir) {
  const meta = projectMeta(dir);
  if (!meta?.doneByImport?.length) return false;
  saveProjectMeta(dir, { doneByImport: undefined });
  const f = join(dir, 'work', 'edl_manual.json');
  if (readJSON(f, null)?.by === IMPORT_BY) rmSync(f, { force: true });
  clearImportLock(dir);
  appendWorklog(dir, 'Clean it up anyway: Clean up and Lock the cut are to do again (no longer done by import)');
  return true;
}

// Skip an optional step, or take the skip back (project.json "skipped"): the dock moves on.
export function setSkipped(dir, type, id, on) {
  const step = pipelineStatus(dir, type)?.steps.find((s) => s.id === id);
  if (!step) throw new Error('Unknown step');
  if (!step.optional) throw new Error(`${step.name} can't be skipped: the steps after it need it.`);
  const list = new Set((projectMeta(dir)?.skipped || []).filter((x) => typeof x === 'string'));
  if (on) list.add(id); else list.delete(id);
  saveProjectMeta(dir, { skipped: [...list] });
}

// opts.transcribe: how to transcribe, from Settings → Transcription (settings.mjs transcribeHow), for {transcribe}.
export function stepPrompt(dir, type, stepId, opts = {}) {
  const st = pipelineStatus(dir, type);
  const step = stepId === 'learn' ? { ...st.learn, skill: null } : [...st.steps, ...st.more].find((s) => s.id === stepId);
  if (!step) throw new Error('Unknown step');
  const src = roles(dir).take.map((f) => `source/${f}`).join(', ') || 'no source yet';
  const ask = (step.ask || '').replaceAll('{source}', src).replaceAll('{style}', styleText(dir, type))
    .replaceAll('{transcribe}', opts.transcribe || 'How: as Video Octopus\'s Settings → Transcription say (the system prompt has them).').replace(/ +\n/g, '\n').trim() + audioOnlyNote(dir, step.id)
    + (step.motion ? motionNote(step.motion) : ''); // the studio's motion-graphics skills, or what to do without any
  return step.skill ? `/${step.skill} ${ask}`.trim() : ask;
}

// A mic-only take (no screen, no camera) has no picture: the steps that touch the recording work on the sound.
const SOUND_STEPS = new Set(['prepare', 'transcribe', 'rough-cut', 'join-check']);
export function audioOnlyNote(dir, stepId) {
  const r = roles(dir);
  if (!r.audioOnly || !SOUND_STEPS.has(stepId)) return '';
  return `\nThis take is audio only: a mic-only recording, source/${r.main} (uncompressed PCM, no picture). Transcribe that file as the recording.` +
    (stepId === 'transcribe' ? '' : ' The rough cut has no video to render: find and apply the cuts on the sound alone, writing work/rough.wav (the kept parts joined) instead of work/rough.mp4, with work/rough_map.json and work/rough_words.json as usual; if the rough-cut script insists on a video stream, build rough_map.json from work/cuts.json yourself and cut the WAV with ffmpeg (atrim + concat). Run the join check with source/' + r.main + ' as the source.') +
    ' Video Octopus\'s canvas shows the layout\'s background for this take, and its export renders that background with this sound.';
}

// A Short's style ("Talking head style", or "<label> style (use the <skill> skill)" for a style with its own skill);
// Shorts are one format with styles inside.
// project.json "shortStyle" is the preset; "style" is the kit's style file from samples (server/kit.mjs), named too.
export function styleText(dir, type) {
  const meta = projectMeta(dir) || {};
  const styles = PIPELINES().formats[formatId(type)]?.styles || [];
  const st = styles.find((x) => x.id === meta.shortStyle) || styles[0];
  const preset = st ? `${st.label} style${st.skill ? ` (use the ${st.skill} skill)` : ''}` : 'the studio\'s own style';
  return meta.style ? `${preset}, following this project's "${meta.style}" style file` : preset;
}

export const formats = () => Object.fromEntries(Object.entries(PIPELINES().formats).map(([k, v]) => [k, v.label]));
// What the New project dialog shows per format: frame shape, hint, its block row and (Shorts) its styles.
export const formatInfo = () => Object.fromEntries(Object.entries(PIPELINES().formats).map(([k, v]) => [k, {
  label: v.label, aspect: v.aspect || '16:9', hint: v.hint || '', platforms: v.platforms || null, camera: v.record?.camera !== false,
  // simple: a Simple-mode format (Audio only, core/pipelines.json): Advanced's video-setup pickers leave it out.
  simple: Boolean(v.simple), screen: v.record?.screen !== false,
  blocks: (v.blocks || []).map((b) => ({ type: b.type, label: b.label, optional: Boolean(b.optional) })),
  steps: (v.steps || []).map((s) => { const x = typeof s === 'string' ? { id: s, ...PIPELINES().shared[s] } : s; return { id: x.id, label: x.label || x.id, name: x.name || x.label || x.id }; }),
  styles: (v.styles || []).map((x) => ({ id: x.id, label: x.label, hint: x.hint || '' })),
}]));
export const formatTemplate = (type) => PIPELINES().formats[formatId(type)] || null;
export const blockTypes = () => PIPELINES().blockTypes || {};
// A format's steps with the shared ones filled in (their done files and all), for server/built.mjs.
export const formatSteps = (type) => { const p = PIPELINES(), f = p.formats[formatId(type)]; return (f?.steps || []).map((s) => (typeof s === 'string' ? { id: s, ...p.shared[s] } : s)); };

// ---- the studio's skills (for the "More skills" list) ----
export function listSkills(type) {
  const dir = join(settings().studio, '.claude', 'skills');
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names.flatMap((n) => {
    let text;
    try { text = readFileSync(join(dir, n, 'SKILL.md'), 'utf8'); } catch { return []; }
    const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] || '';
    const field = (k) => new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm').exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, '');
    const fmts = (field('formats') || '').replace(/[[\]]/g, '').split(',').map((x) => x.trim()).filter(Boolean);
    if (type && fmts.length && !fmts.map(formatId).includes(formatId(type))) return [];
    const description = (field('description') || '').split(/(?<=\.)\s/)[0].slice(0, 160);
    return [{ name: field('name') || n, description, button: field('button') || null }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

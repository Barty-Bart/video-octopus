// Simple mode's profiles (web/profile-kinds.js has the shared parts): one folder per kind of video a creator makes,
// so each one keeps its own files, instructions and learnings instead of one Resources pile for everything.
//
//   <studio>/profiles/<slug>/
//     profile.json      { name, workflow: topic | batch, shape: youtube | reel | audio, script: full | points, created }
//     INSTRUCTIONS.md   how videos for this profile are made (the creator's words; Claude reads it before every step)
//     LEARNINGS.md      lessons from earlier videos: Video Octopus adds the ones Claude saves (work/learnings.json)
//     resources/        the profile's files: logos, photos, references, music, anything; removed ones go to .removed/
//     skills/           optional skills of this profile's own, skills/<name>/SKILL.md
//
// A video started from a profile is an ordinary Simple video (the built-in style's format for the profile's shape)
// with project.json simpleProfile: <slug>; its chat is told where the profile's folder is (profileContext). The
// Resources page stays as the files every profile shares.
//
// Routes (/api/simple-profiles…):
//   GET  /api/simple-profiles                          → { profiles: [...] }
//   POST /api/simple-profiles { name, workflow, shape, script } → the new profile
//   GET  /api/simple-profiles/<slug>                   → the profile with instructions, learnings, files, skills
//   POST /api/simple-profiles/<slug> { name?, shape?, script?, instructions?, learnings? } → the profile
//   POST /api/simple-profiles/<slug>/upload?name=      → a file into resources/ (raw body)
//   POST /api/simple-profiles/<slug>/remove { name }   → { removed } (moved to resources/.removed/)
//   POST /api/simple-profiles/<slug>/restore { removed } → the file back
//   GET  /api/simple-profiles/<slug>/file/<name>       → the file, for previews
//   POST /api/simple-profiles/<slug>/start { topic? }  → { id } (index.mjs sends the topic's brief to the chat)
//   POST /api/simple-profiles/ref?project=&name=       → a reference file into a batch video's references/
//   POST /api/simple-profiles/split/<project>          → { videos: [ids] } (one video per script of a batch take)
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { settings, readJSON, writeJSON, studioTool, h264 } from './util.mjs';
import { listProjects, projectDir, projectMeta, saveProjectMeta, appendWorklog, roles, probe } from './studio.mjs';
import { createConfiguredProject, simpleVideoChoice } from './profiles.mjs';
import { UNTITLED } from './naming.mjs';
import { mimeOf } from './file-store.mjs';
import { SHAPES, isShape } from '../web/simple.js';
import { WORKFLOWS, SCRIPTS, PRESETS, isWorkflow, isScript, profileSlug, cleanFileName, lessonsOf, splitPlan, cleanLook, lessonLines } from '../web/profile-kinds.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const MAX_FILE = 4e9; // a reference video or a long clip
const REMOVED = '.removed';

export const profilesRoot = () => join(settings().studio || fail('Choose a studio folder first.'), 'profiles');
const dirOf = (slug) => {
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(String(slug || ''))) fail('That profile isn’t in the studio.', 404);
  const d = join(profilesRoot(), slug);
  if (!existsSync(join(d, 'profile.json'))) fail('That profile isn’t in the studio.', 404);
  return d;
};
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

const INSTRUCTIONS = () => '';
const LEARNINGS = `# Learnings

Lessons from earlier videos of this profile. Claude saves one whenever you correct it or say how you want things done, and reads this file before every video. Edit or delete any line.
`;
const SKILLS_README = `Skills of this profile's own: put each one in a folder here with its SKILL.md (skills/<name>/SKILL.md). Claude reads the ones that fit the step it's on, on top of the app's own skills.
`;

// ---- reading ----
const filesOf = (d) => {
  const r = join(d, 'resources');
  let names = [];
  try { names = readdirSync(r); } catch {}
  return names.filter((n) => !n.startsWith('.') && isFile(join(r, n)))
    .map((n) => { const st = statSync(join(r, n)); return { name: n, size: st.size, mime: mimeOf(n), added: st.mtimeMs }; })
    .sort((a, b) => b.added - a.added);
};
const skillsOf = (d) => {
  let names = [];
  try { names = readdirSync(join(d, 'skills')); } catch {}
  return names.filter((n) => !n.startsWith('.') && isFile(join(d, 'skills', n, 'SKILL.md')));
};
const lessonCount = (text) => text.split('\n').filter((l) => /^\s*-\s+\S/.test(l)).length;

function summary(slug, d, videos) {
  const p = readJSON(join(d, 'profile.json'), {});
  return {
    slug, name: p.name || slug, workflow: isWorkflow(p.workflow) ? p.workflow : 'topic',
    shape: isShape(p.shape) ? p.shape : 'youtube', script: isScript(p.script) ? p.script : 'points', created: p.created || 0, look: cleanLook(p.look || {}),
    files: filesOf(d).length, learnings: lessonCount(readText(join(d, 'LEARNINGS.md'))), skills: skillsOf(d).length,
    videos: videos.filter((v) => v.profile === slug).length, path: d,
  };
}

export function listProfiles() {
  if (!settings().studio) return [];
  const root = profilesRoot();
  let names = [];
  try { names = readdirSync(root); } catch { return []; }
  const videos = listProjects();
  return names.filter((n) => !n.startsWith('.') && isFile(join(root, n, 'profile.json')))
    .map((n) => summary(n, join(root, n), videos))
    .sort((a, b) => a.created - b.created);
}

export function getProfile(slug) {
  const d = dirOf(slug);
  return {
    ...summary(slug, d, listProjects()),
    instructions: readText(join(d, 'INSTRUCTIONS.md')),
    learningsText: readText(join(d, 'LEARNINGS.md')),
    lessons: lessonLines(readText(join(d, 'LEARNINGS.md'))).map(({ text, stage, from }) => ({ text, stage, from })),
    fileList: filesOf(d),
    skillList: skillsOf(d),
  };
}

// ---- making and changing ----
export function createProfile({ name, preset, ...rest } = {}) {
  if (preset !== undefined && !PRESETS[preset]) fail('Pick what kind of videos this profile makes.');
  const { workflow = 'topic', shape, script } = preset ? PRESETS[preset] : rest;
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean) fail('Give the profile a name.');
  if (!isWorkflow(workflow)) fail('Choose Topic → video or Batch of shorts.');
  const sh = shape || (workflow === 'batch' ? 'reel' : 'youtube');
  if (!isShape(sh)) fail('Choose YouTube video, Reel or Short, or Audio only.');
  const sc = script || (sh === 'audio' ? 'full' : 'points');
  if (!isScript(sc)) fail('Choose Full script or Talking points.');
  const root = profilesRoot();
  mkdirSync(root, { recursive: true });
  const base = profileSlug(clean) || 'profile';
  let slug = base;
  for (let i = 2; existsSync(join(root, slug)); i++) slug = `${base}-${i}`;
  const d = join(root, slug);
  mkdirSync(join(d, 'resources'), { recursive: true });
  mkdirSync(join(d, 'skills'), { recursive: true });
  writeJSON(join(d, 'profile.json'), { name: clean, workflow, shape: sh, script: sc, created: Date.now() });
  writeFileSync(join(d, 'INSTRUCTIONS.md'), INSTRUCTIONS(clean));
  writeFileSync(join(d, 'LEARNINGS.md'), LEARNINGS);
  writeFileSync(join(d, 'skills', 'README.md'), SKILLS_README);
  return getProfile(slug);
}

export function updateProfile(slug, b = {}) {
  const d = dirOf(slug);
  const p = readJSON(join(d, 'profile.json'), {});
  if (b.name !== undefined) { const n = String(b.name).replace(/\s+/g, ' ').trim().slice(0, 60); if (!n) fail('Give the profile a name.'); p.name = n; }
  if (b.shape !== undefined) { if (!isShape(b.shape)) fail('Choose YouTube video, Reel or Short, or Audio only.'); p.shape = b.shape; }
  if (b.script !== undefined) { if (!isScript(b.script)) fail('Choose Full script or Talking points.'); p.script = b.script; }
  if (b.workflow !== undefined) { if (!isWorkflow(b.workflow)) fail('Choose Topic → video or Batch of shorts.'); p.workflow = b.workflow; }
  if (b.look !== undefined) p.look = cleanLook(b.look);
  writeJSON(join(d, 'profile.json'), p);
  if (typeof b.instructions === 'string') writeFileSync(join(d, 'INSTRUCTIONS.md'), b.instructions.slice(0, 200000));
  if (typeof b.learnings === 'string') writeFileSync(join(d, 'LEARNINGS.md'), b.learnings.slice(0, 200000));
  return getProfile(slug);
}

// ---- lessons (LEARNINGS.md's "- " lines) ----
// Add one in the creator's words, or remove one by its text (the first line that says it).
export function editLessons(slug, { add, remove } = {}) {
  const d = dirOf(slug), file = join(d, 'LEARNINGS.md');
  let text = readText(file) || LEARNINGS;
  if (typeof add === 'string') {
    const t = add.replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!t) fail('Write the lesson first.');
    text = `${text.replace(/\s*$/, '')}\n- ${t} · ${new Date().toISOString().slice(0, 10)}, added by hand\n`;
  }
  if (typeof remove === 'string') {
    const hit = lessonLines(text).find((l) => l.text === remove.trim());
    if (!hit) fail('That lesson isn’t there any more.', 404);
    const lines = text.split('\n');
    lines.splice(lines.indexOf(hit.line), 1);
    text = lines.join('\n');
  }
  writeFileSync(file, text);
  return getProfile(slug);
}

// Remove a profile: its folder moves to profiles/.removed/ (never deleted); its videos stay as they are.
export function removeProfile(slug) {
  const d = dirOf(slug), bin = join(profilesRoot(), REMOVED);
  mkdirSync(bin, { recursive: true });
  const to = `${Date.now()}-${slug}`;
  renameSync(d, join(bin, to));
  return { removed: to };
}

// ---- files ----
const freeIn = (dir, name) => {
  if (!existsSync(join(dir, name))) return name;
  const dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) if (!existsSync(join(dir, `${stem} (${i})${ext}`))) return `${stem} (${i})${ext}`;
};
async function receive(req, dir, rawName) {
  const name = cleanFileName(rawName) || fail('That file has no usable name.');
  mkdirSync(dir, { recursive: true });
  const final = freeIn(dir, name), part = join(dir, `.${final}.part`);
  let size = 0;
  const limit = new Transform({ transform(chunk, enc, done) { size += chunk.length; done(size > MAX_FILE ? Object.assign(new Error('Files can be at most 4 GB.'), { status: 413 }) : null, chunk); } });
  try { await pipeline(req, limit, createWriteStream(part)); }
  catch (e) { rmSync(part, { force: true }); throw e; }
  if (!size) { rmSync(part, { force: true }); fail('The file was empty.'); }
  renameSync(part, join(dir, final));
  return { name: final, size };
}
export const addFile = (slug, req, name) => receive(req, join(dirOf(slug), 'resources'), name);

export function removeFile(slug, name) {
  const d = dirOf(slug), n = cleanFileName(name), from = join(d, 'resources', n);
  if (!n || !isFile(from)) fail('That file isn’t in this profile any more.', 404);
  mkdirSync(join(d, 'resources', REMOVED), { recursive: true });
  const removed = `${Date.now()}-${n}`;
  renameSync(from, join(d, 'resources', REMOVED, removed));
  return { removed };
}
export function restoreFile(slug, removed) {
  const d = dirOf(slug), r = cleanFileName(removed), from = join(d, 'resources', REMOVED, r);
  if (!r || !isFile(from)) fail('That file isn’t in the trash any more.', 404);
  const name = freeIn(join(d, 'resources'), r.replace(/^\d+-/, ''));
  renameSync(from, join(d, 'resources', name));
  return { name };
}
export function filePath(slug, name) {
  const n = cleanFileName(name), p = join(dirOf(slug), 'resources', n);
  if (!n || !isFile(p)) fail('Not found.', 404);
  return p;
}

// ---- videos ----
// A new Simple video started from the profile: the built-in format for its shape, named after the topic (else
// named later from what's said), with simpleProfile in project.json. A batch also gets references/.
export function startVideo(slug, { topic = '', name = '' } = {}) {
  const d = dirOf(slug);
  const p = summary(slug, d, []);
  const t = String(topic || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const title = String(name || '').trim().slice(0, 80) || (p.workflow === 'batch' ? '' : t.slice(0, 80));
  const id = createConfiguredProject({ ...simpleVideoChoice(p.shape), name: title || UNTITLED, nameSource: title ? 'manual' : 'auto' });
  const dir = projectDir(id);
  saveProjectMeta(dir, { simpleProfile: slug, ...(t ? { topic: t } : {}), ...(p.workflow === 'batch' && !name ? { batch: true } : {}) });
  if (p.workflow === 'batch' && !name) mkdirSync(join(dir, 'references'), { recursive: true });
  appendWorklog(dir, `Started from the profile ${p.name}${t ? `: ${t}` : ''}`);
  return { id, profile: p };
}

export const addReference = (project, req, name) => {
  const dir = projectDir(String(project || '')) || fail('That video isn’t in the studio.', 404);
  if (!projectMeta(dir)?.simpleProfile) fail('Only a profile’s video takes references.');
  return receive(req, join(dir, 'references'), name);
};

const profileOf = (meta) => {
  const slug = meta?.simpleProfile;
  if (!slug || !settings().studio) return null;
  try { const d = dirOf(slug); return { slug, dir: d, ...summary(slug, d, []) }; } catch { return null; }
};

// What the first message to a profile's video says: research and script a topic, or break down a batch's references.
export function kickoff(id) {
  const dir = projectDir(id), meta = projectMeta(dir) || {}, p = profileOf(meta);
  if (!p) return '';
  if (meta.batch) {
    const refs = (() => { try { return readdirSync(join(dir, 'references')).filter((n) => !n.startsWith('.')); } catch { return []; } })();
    return [
      `New batch for the profile "${p.name}". ${refs.length ? `The reference videos are in references/ (${refs.length}: ${refs.slice(0, 12).join(', ')}).` : 'There are no reference files; work from the notes below and the profile.'}${meta.topic ? ` The creator's notes: ${meta.topic}` : ''}`,
      `1. Break the references down: transcribe each one with the transcribe skill and look at a few frames (ffmpeg) to see the hook, the structure, the length, the on-screen style and why it works. Write that to work/breakdown.md.`,
      `2. Suggest one short video per reference (or as many as the creator asks for), each in the creator's own words and on what this profile is about, not a copy. Check every fact you use.`,
      `3. Write all the scripts into script.md in the order they'll be read, each one starting with a heading "## <n>. <title>", short enough for the profile's length. The creator reads them in one take on the teleprompter.`,
      `Then tell the creator in two or three lines what the scripts are and to press Record. After the take is in, follow the profile's batch steps (the split into videos).`,
    ].join('\n');
  }
  if (!meta.topic) return '';
  const how = p.script === 'full'
    ? 'a full script: every word the creator will say, hook first, in their voice, ready to read on the teleprompter'
    : 'talking points: the hook and the ending written out word for word, and the middle as short beats the creator talks through in their own words';
  return [
    `New video for the profile "${p.name}". Topic: ${meta.topic}`,
    `1. Research it: search the web for recent, reliable sources (official pages first), and look at what other creators made on it and what they missed. Write work/research.md: the angle, the key facts with their links, and three title ideas. Don't make anything up; mark what you couldn't check.`,
    `2. Write script.md as ${how}.`,
    `Then tell the creator in two lines what the angle is and that the script is on the Record page.`,
  ].join('\n');
}

// The lines a profile's video adds to its chat's context (index.mjs projectContext).
export function profileContext(meta) {
  const p = profileOf(meta);
  if (!p) return [];
  const lines = [
    `This video belongs to the creator's profile "${p.name}" (${WORKFLOWS[p.workflow].name}, ${SHAPES[p.shape].name}${p.workflow === 'topic' ? `, ${SCRIPTS[p.script].name.toLowerCase()}` : ''}). Its folder is ${p.dir}: read INSTRUCTIONS.md (how this profile's videos are made) and LEARNINGS.md (the creator's lessons from earlier videos) before each step and follow them; they override general habits. resources/ holds this profile's own files (logos, photos, references, music): use them where they fit, on top of the shared Resources. skills/ may hold skills of this profile's own (skills/<name>/SKILL.md): read the ones that fit the step you're on. Don't change anything in that folder.`,
    ...(p.look.colors.length || p.look.font || p.look.voice ? [`This profile's look: ${[p.look.colors.length ? `colours ${p.look.colors.join(', ')} (the first leads: titles, cards, thumbnails)` : '', p.look.font ? `font ${p.look.font}` : '', p.look.voice ? `voice: ${p.look.voice}` : ''].filter(Boolean).join('; ')}. Use it in this video's graphics, captions, thumbnails and words.`] : []),
    `Learning: whenever the creator corrects you, pushes back, or says how they want something done in a way that should hold for this profile's next videos, add it to work/learnings.json in this project ({"lessons": [{"text": "one short rule in the creator's words", "stage": "research" | "script" | "record" | "cut" | "scenes" | "build" | "thumbnail" | "post"}]}; keep the lessons already there). Video Octopus copies new ones into the profile's LEARNINGS.md when your reply ends and tells the creator. Only save lasting preferences, not one-off changes to this video.`,
    `The profile's research: work/research.md (if there is one) holds the topic's research and angle. Read it before you plan scenes, build, write titles or the post, so the edit says what the research found.`,
  ];
  if (meta.batch) lines.push(`This is a batch: one take with several short videos in it, one per script in script.md. Once the take is in and transcribed, find where each script starts and ends (when the creator repeated a line, use the last take of it, and leave out the restarts and the pauses between videos) and write work/batch-split.json {"videos": [{"title": "...", "start": <take seconds>, "end": <take seconds>, "script": "that video's script"}]}. Then tell the creator to press Split into videos above the chat: Video Octopus makes one video of this profile per entry, each with its part of the take, and they go on from Rough cut one by one.`);
  return lines;
}

// After a reply: lessons Claude saved in work/learnings.json and not yet copied go into the profile's LEARNINGS.md.
// project.json learned keeps the ones copied (by a hash of their text), so an edited file never copies a lesson twice.
// Returns the lessons added (for one line in the chat).
export function harvestLearnings(id) {
  const dir = projectDir(id);
  if (!dir) return [];
  const meta = projectMeta(dir) || {}, p = profileOf(meta);
  if (!p) return [];
  const lessons = lessonsOf(readJSON(join(dir, 'work', 'learnings.json'), null));
  if (!lessons.length) return [];
  const done = new Set(Array.isArray(meta.learned) ? meta.learned : []);
  const key = (l) => createHash('sha256').update(l.text.toLowerCase()).digest('hex').slice(0, 16);
  const fresh = lessons.filter((l) => !done.has(key(l)));
  if (!fresh.length) return [];
  const file = join(p.dir, 'LEARNINGS.md');
  const text = readText(file) || LEARNINGS;
  const day = new Date().toISOString().slice(0, 10);
  const add = fresh.map((l) => `- ${l.text}${l.stage ? ` _(${l.stage})_` : ''} · ${day}, ${meta.name || id}`).join('\n');
  writeFileSync(file, `${text.replace(/\s*$/, '')}\n${add}\n`);
  saveProjectMeta(dir, { learned: [...done, ...fresh.map(key)] });
  appendWorklog(dir, `Saved ${fresh.length} lesson${fresh.length === 1 ? '' : 's'} to the profile ${p.name}`);
  return fresh.map((l) => ({ ...l, profile: p.name }));
}

// ---- splitting a batch ----
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(studioTool('ffmpeg'), ['-v', 'error', '-nostdin', '-y', ...args]);
    let err = '';
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg stopped (${code})`))));
  });
}
const AUDIO = /\.(wav|m4a|mp3|aif|aiff|caf|flac)$/i;

// Batch → one video per entry of work/batch-split.json: each new video is of the same profile, named after its
// script, with its part of every file of the take (screen, camera, audio, cut at the same times, so they stay in
// sync) and its script in script.md. The batch keeps its take and gets project.json split: [ids].
export async function splitBatch(id) {
  const dir = projectDir(String(id || '')) || fail('That video isn’t in the studio.', 404);
  const meta = projectMeta(dir) || {}, p = profileOf(meta);
  if (!p || !meta.batch) fail('Only a batch can be split.');
  if (Array.isArray(meta.split) && meta.split.length) fail('This batch is split already.');
  const r = roles(dir);
  if (!r.main) fail('Record the take first.');
  const len = probe(dir, r.main)?.duration || Infinity;
  const plan = splitPlan(readJSON(join(dir, 'work', 'batch-split.json'), null), len);
  if (plan.error) fail(plan.error);
  const made = [];
  for (const v of plan.videos) {
    const { id: vid } = startVideo(p.slug, { name: v.title });
    const vdir = projectDir(vid);
    mkdirSync(join(vdir, 'source'), { recursive: true });
    for (const f of r.take) {
      const out = join(vdir, 'source', f.replace(/\.(mov|m4v|mkv|webm)$/i, '.mp4'));
      const codec = AUDIO.test(f) ? (/\.wav$/i.test(f) ? ['-c:a', 'pcm_s24le'] : ['-c:a', 'aac', '-b:a', '256k'])
        : [...h264('12M'), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart'];
      await ffmpeg(['-ss', v.start.toFixed(3), '-to', v.end.toFixed(3), '-i', join(dir, 'source', f), ...codec, out]);
    }
    if (v.script) writeFileSync(join(vdir, 'script.md'), v.script);
    saveProjectMeta(vdir, { batchOf: id });
    appendWorklog(vdir, `Split from the batch ${meta.name || id}: take ${v.start.toFixed(1)}–${v.end.toFixed(1)} s`);
    made.push(vid);
  }
  saveProjectMeta(dir, { split: made });
  appendWorklog(dir, `Split into ${made.length} videos: ${made.join(', ')}`);
  return { videos: made };
}

// The page's Split into videos button: is there a plan to split, and is it done?
export function splitState(id) {
  const dir = projectDir(id);
  const meta = (dir && projectMeta(dir)) || {};
  if (!meta.batch) return null;
  const plan = readJSON(join(dir, 'work', 'batch-split.json'), null);
  return { take: Boolean(roles(dir).main), ready: Boolean(plan?.videos?.length), count: plan?.videos?.length || 0, split: Array.isArray(meta.split) ? meta.split : [] };
}

// ---- the route ----
function serveFile(res, path) {
  const st = statSync(path);
  res.writeHead(200, { 'Content-Type': mimeOf(path), 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'Cache-Control': 'no-cache' });
  createReadStream(path).pipe(res);
}

// started(id): the new video's first message (index.mjs: its chat), split(id): after a split (a broadcast).
export async function simpleProfilesRoute(req, res, url, { send, body, started }) {
  const parts = url.pathname.split('/').slice(3).map((x) => { try { return decodeURIComponent(x); } catch { return ''; } });
  const reply = (data, status = 200) => { send(res, status, data); return true; };
  try {
    if (req.method === 'GET') {
      if (!parts.length) return reply({ profiles: listProfiles() });
      if (parts[0] === 'split-state' && parts[1]) return reply(splitState(parts[1]) || {});
      if (parts[1] === 'file' && parts[2]) { serveFile(res, filePath(parts[0], parts[2])); return true; }
      if (parts.length === 1) return reply(getProfile(parts[0]));
      return reply({ error: 'Not found.' }, 404);
    }
    if (req.method !== 'POST') return reply({ error: 'POST required.' }, 405);
    const q = url.searchParams;
    if (parts[0] === 'ref' && parts.length === 1) return reply(await addReference(q.get('project'), req, q.get('name')));
    if (parts[1] === 'upload') return reply(await addFile(parts[0], req, q.get('name')));
    const b = await body(req);
    if (!parts.length) return reply(createProfile(b));
    if (parts[0] === 'split' && parts[1]) return reply(await splitBatch(parts[1]));
    if (parts[0] === 'kickoff' && parts[1]) {
      const text = kickoff(parts[1]);
      try { if (text) await started(parts[1], text); } catch (e) { return reply({ ok: false, warning: e.message }); }
      return reply({ ok: Boolean(text) });
    }
    if (parts[1] === 'remove') return reply(removeFile(parts[0], b.name));
    if (parts[1] === 'lessons') return reply(editLessons(parts[0], b));
    if (parts[1] === 'delete') return reply(removeProfile(parts[0]));
    if (parts[1] === 'restore') return reply(restoreFile(parts[0], b.removed));
    if (parts[1] === 'start') {
      const { id } = startVideo(parts[0], b);
      // A topic starts right away; a batch waits for its references (the page sends kickoff once they're in).
      // The video exists either way: an agent that can't start is said, not a failed Start (which would make another).
      let warning = null;
      if (b.topic && !projectMeta(projectDir(id))?.batch) { const text = kickoff(id); try { if (text) await started(id, text); } catch (e) { warning = e.message; } }
      return reply({ id, warning });
    }
    if (parts.length === 1) return reply(updateProfile(parts[0], b));
    return reply({ error: 'Unknown profile action.' }, 404);
  } catch (e) { return reply({ error: e.message }, e.status || 400); }
}

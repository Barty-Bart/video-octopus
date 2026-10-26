// Packaging (Phase 1 MVP): a video's thumbnails, before or after it is made. Nothing waits on it.
// - The Packaging chat: its own chat per project (<project>.packaging) that always runs on Codex (the creator's ChatGPT
//   plan has image generation), in the project's folder, with the project chat's pinned context and memories.
// - Generate: one image with 6 numbered ideas in a 3 × 2 grid (one generation), cut into 6 cards by the known grid.
// - Refine: one card → one finished 1280 × 720 thumbnail, a child card of it.
// - The board: star, winners (up to 3), the main thumbnail, old thumbnails uploaded by the creator.
// - Resources (server/resource-store.mjs) at All channels · Channel · This video, live in packaging/RESOURCES.md.
// No API keys, no paid plan of Video Octopus's own, no engine or level settings: Codex's image tool is the provider.
import { mkdirSync, rmSync, createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { CodexSession, codexInfo, codexSource } from './codex.mjs';
import { lookOnly } from './readonly.mjs';
import { forReplay } from './claude.mjs';
import { section } from './settings.mjs';
import { settings } from './util.mjs';
import { projectDir, projectMeta, listProjects, appendWorklog } from './studio.mjs';
import { pinnedContext } from './profiles.mjs';
import { readPost, savePost } from './postkit.mjs';
import { PackagingStore, MAX_WINNERS } from './packaging-store.mjs';
import { addResource, updateResource, archiveResource, getResource, listResources, resourcePath, checkResourceScope,
  RESOURCE_KINDS, LIKENESS, USES, MAX_RESOURCE_BYTES, maxBytesFor, canAttach } from './resource-store.mjs';
import { RESOURCE_LEVELS, parseScope } from './scope-chain.mjs';
import { SHEET_GRID, THUMB_SIZE, sheetBoxes, cutBoxes, fitThumbnail, imageSize, imageType, extensionFor } from './images.mjs';
import { autoName } from './naming.mjs';
import { parseIdeaLine, ideaOf, outlineStub, writeIdeaScript, OUTLINE_ASK } from './idea-script.mjs';

const MAX_UPLOAD = 20 * 1024 * 1024;
const MAX_ATTACHED = 4;
const chats = new Map();     // studio:project -> CodexSession
const streams = new Map();   // project -> Set(res)

const use = (fn) => {
  const s = new PackagingStore(settings().studio);
  try { return fn(s); } finally { s.close(); }
};
const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
export const packagingChatId = (project) => `${project}.packaging`;
export const packagingBusy = (project = null) => [...chats.entries()]
  .some(([key, c]) => c.busy && (!project || key === `${settings().studio}:${project}`));
export function killPackaging(project = null) {
  for (const [key, c] of chats) {
    if (project && key !== `${settings().studio}:${project}`) continue;
    c.kill();
    chats.delete(key);
  }
}

function broadcast(project, ev) {
  for (const res of streams.get(project) || []) res.write(`data: ${JSON.stringify(ev)}\n\n`);
}
const boardChanged = (project, why) => broadcast(project, { t: 'packaging', why });

// ---- can Codex draw? ----
// Image generation needs Codex signed in with a ChatGPT plan (not an API key, not a local model provider).
export async function imageStatus() {
  const info = await codexInfo();
  const provider = section('claude').codexProvider || 'chatgpt';
  if (!info.installed) return { available: false, reason: 'Packaging uses Codex for images. Install Codex (npm install -g @openai/codex) and sign in with your ChatGPT plan.' };
  if (!info.signedIn) return { available: false, reason: 'Codex is installed but not signed in. Run codex login in a terminal, with your ChatGPT plan.' };
  if (provider !== 'chatgpt') return { available: false, reason: 'Codex runs on a local model right now, which cannot make images. Switch Codex to your ChatGPT plan in Settings → Agent & model.' };
  if (info.plan !== 'ChatGPT plan') return { available: false, reason: 'Needs Codex signed in with a ChatGPT plan (it is signed in another way).' };
  return { available: true, provider: 'codex', version: info.version || null };
}

// ---- the Packaging chat ----
function packagingContext(project) {
  const dir = projectDir(project);
  const meta = (dir && projectMeta(dir)) || {};
  const pinned = pinnedContext(project, dir);
  return [
    `You are the Packaging chat inside Video Octopus, the creator's local video app, for one video: "${meta.name || project}". Packaging is the video's thumbnail for now (titles and the hook come later). Nothing waits on it: the creator can package before, during or after making the video.`,
    `Your working directory is this video's folder, ${dir}. Read packaging/PACKAGING.md (the board: title, main thumbnail, winners, shortlist and the creator's notes) and packaging/RESOURCES.md (the creator's resources by level: all channels, this channel, this video; open only the files you need). Video Octopus rewrites both whenever something changes, so re-read them when the creator mentions new resources or choices. Don't edit them, and don't change other project files from this chat.`,
    `Images: make them with your image generation tool. Video Octopus puts every image you make on the creator's Packaging board by itself, so don't save, move, copy or list image files. Make one image per request unless the creator asks for more. Use only pictures of real people that the creator attached and marked as themselves or someone who agreed; never imitate another real person, another brand's logo or another creator's thumbnail.`,
    `When Video Octopus sends a Generate or Refine brief, follow its layout and size exactly, then reply in the format it asks for.`,
    `The creator reads you in a narrow panel next to the board: keep replies short and plain.`,
    pinned?.text || '',
  ].filter(Boolean).join('\n');
}

function chatFor(project) {
  const key = `${settings().studio}:${project}`;
  let c = chats.get(key);
  // Codex moved to another provider in Settings: this chat starts fresh (its thread belongs to the other one).
  if (c && !c.busy && c.source && c.source !== codexSource()) { c.kill(); chats.delete(key); c = null; }
  if (c) return c;
  c = new CodexSession(packagingChatId(project), () => packagingContext(project));
  c.memoryBinding = { project };
  c.projectScope = () => pinnedContext(project, projectDir(project));
  c.cwd = () => projectDir(project) || settings().studio;
  c.guard = () => projectDir(project);
  c.mode = () => 'manual';
  // Only the studio's context: no MCP servers, plugins, web search, or the creator's own Codex hooks and memories.
  c.isolatedThread = true;
  // Reading the board, resources and pictures needs no card (the assistant's read-only rule); every change still asks.
  c.autoAllow = (r) => r?.tool_name === 'Bash' && r.input?.shell !== 'powershell' && lookOnly(r.input?.command, null);
  c.pendingImage = null;
  c.imageWork = Promise.resolve();
  c.listeners.add((ev) => broadcast(project, ev));
  c.listeners.add((ev) => { if (ev.t === 'text' && c.pendingImage) c.pendingImage.texts.push(ev.text); });
  c.onImage = (image) => { c.imageWork = c.imageWork.then(() => keepImage(project, c, image)); return c.imageWork; };
  c.onTurnEnd = () => { c.imageWork = c.imageWork.then(() => turnEnded(project, c)); };
  chats.set(key, c);
  return c;
}

// A temporary folder on the studio's disk (so the file store can clone from it).
function scratch(studio) {
  const dir = join(studio, '.studio', 'packaging-tmp', randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Store what Codex made: a sheet (cut into its cards), a refinement (fitted to 1280 × 720) or a plain chat image.
async function keepImage(project, chat, image) {
  const pending = chat.pendingImage;
  if (image.failure) {
    if (pending?.kind === 'sheet') use((s) => s.failSheet(project, pending.sheet, { message: image.failure.message, kind: image.failure.kind, resetsAt: image.failure.resetsAt || null }));
    chat.emit({ t: 'error', text: image.failure.message });
    if (pending) chat.pendingImage = null;
    boardChanged(project, 'failed');
    return;
  }
  const studio = settings().studio, tmp = scratch(studio);
  try {
    let source = image.path;
    if (!source) {
      source = join(tmp, `codex${extensionFor(image.bytes) || '.png'}`);
      writeFileSync(source, image.bytes);
    }
    let made;
    if (pending?.kind === 'refine') {
      chat.pendingImage = null;
      made = await keepRefined(project, pending, source, image.revisedPrompt, tmp, image.wire);
    } else if (pending?.kind === 'sheet' && !pending.taken) {
      // Its first image is the sheet; any further image in the same turn is a plain card.
      pending.taken = true;
      const original = use((s) => s.files.putFile(source, { maxBytes: 100 * 1024 * 1024 }));
      made = await keepSheet(project, pending, original, imageSize(original.path), image.revisedPrompt, tmp, image.wire);
    } else {
      const original = use((s) => s.files.putFile(source, { maxBytes: 100 * 1024 * 1024 }));
      const size = imageSize(original.path);
      made = use((s) => [s.addItem(project, { origin: 'chat', stored: storedOf(original), size, revisedPrompt: image.revisedPrompt, name: 'From the chat', wire: image.wire })]);
    }
    const dir = projectDir(project);
    if (dir) use((s) => s.writePackaging(project, dir));
    const asSheet = pending?.kind === 'sheet' && made.some((x) => x.sheet === pending.sheet);
    chat.emit({ t: 'images', project, items: made.map((x) => x.id), sheet: asSheet ? pending.sheet : null,
      label: asSheet ? `${made.length} ideas on the board` : pending?.kind === 'refine' ? 'Refined, on the board' : 'On the board' });
    boardChanged(project, 'images');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
const storedOf = (x) => ({ sha256: x.sha256, size: x.size, ext: (x.path.match(/\.[a-z0-9]+$/i) || ['.png'])[0].toLowerCase() });

async function keepSheet(project, pending, original, size, revisedPrompt, tmp, wire = null) {
  let cells = [], boxes = [], problem = null;
  try {
    if (!size) throw new Error('Video Octopus could not read the sheet’s size.');
    boxes = sheetBoxes(size, SHEET_GRID);
    const outs = boxes.map((b) => join(tmp, `cell-${b.n}.png`));
    await cutBoxes(original.path, boxes, outs);
    cells = use((s) => boxes.map((b, i) => {
      const stored = s.files.putFile(outs[i]);
      return { n: b.n, box: b, stored: storedOf(stored), size: { width: b.w, height: b.h } };
    }));
  } catch (e) {
    problem = e.message;
  }
  const sheet = use((s) => s.finishSheet(project, pending.sheet, { stored: storedOf(original), size, revisedPrompt, boxes, cells, problem, wire }));
  // Not cut (no FFmpeg, an unreadable size): the whole sheet goes on the board as one card, and the sheet says why.
  if (problem) return [use((s) => s.addItem(project, { origin: 'chat', sheet: sheet.id, stored: storedOf(original), size, revisedPrompt, name: 'Whole sheet (not cut)', note: problem }))];
  return use((s) => sheet.items.map((id) => s.item(project, id)));
}

// Only the fitted 1280 × 720 file is kept (Codex's own size is not); without FFmpeg, Codex's image as it came.
async function keepRefined(project, pending, source, revisedPrompt, tmp, wire = null) {
  let stored, size, note = '';
  try {
    const out = join(tmp, 'refined.png');
    await fitThumbnail(source, out, THUMB_SIZE);
    stored = use((s) => s.files.putFile(out));
    size = { ...THUMB_SIZE };
  } catch (e) {
    note = e.message;
    stored = use((s) => s.files.putFile(source, { maxBytes: 100 * 1024 * 1024 }));
    size = imageSize(stored.path);
  }
  return use((s) => {
    const parent = s.item(project, pending.parent);
    return [s.addItem(project, { origin: 'refined', parent: parent.id, stored: storedOf(stored), size, prompt: pending.prompt, revisedPrompt,
      resources: parent.resources || [], name: `${parent.name || 'Idea'} · refined`, note, wire, brief: parent.brief || '', idea: parent.idea || null })];
  });
}

// The turn is over: a Generate that brought no image says so; the reply's "1. …" lines name the sheet's cards.
function turnEnded(project, chat) {
  const pending = chat.pendingImage;
  chat.pendingImage = null;
  if (!pending) return;
  if (pending.kind === 'sheet') {
    const sheet = use((s) => s.sheet(project, pending.sheet));
    if (sheet.status === 'running') {
      use((s) => s.failSheet(project, pending.sheet, { message: 'Codex finished without an image. Try Generate again, or ask in the chat.' }));
      chat.emit({ t: 'note', text: 'Codex finished without an image, so nothing was added to the board.' });
    } else if (sheet.status === 'done') nameCards(project, sheet, pending.texts.join('\n'));
  } else if (pending.kind === 'refine') {
    chat.emit({ t: 'note', text: 'Codex finished without a refined image, so nothing was added to the board.' });
  }
  boardChanged(project, 'turn');
}
function nameCards(project, sheet, reply) {
  const ideas = new Map();
  for (const m of String(reply).matchAll(/^\s*(\d)[.)]\s+(.+)$/gm)) ideas.set(Number(m[1]), m[2].replace(/\*\*/g, '').trim().slice(0, 110));
  if (!ideas.size) return;
  use((s) => s.tx(() => {
    for (const id of sheet.items || []) {
      const x = s.item(project, id);
      if (ideas.has(x.cell)) s.saveItem({ ...x, name: `Idea ${x.cell} · ${ideas.get(x.cell)}`.slice(0, 120), idea: parseIdeaLine(ideas.get(x.cell)) });
    }
  }));
  const dir = projectDir(project);
  if (dir) use((s) => s.writePackaging(project, dir));
}

// ---- briefs ----
function generateBrief({ project, brief, attached, more }) {
  const dir = projectDir(project);
  const meta = (dir && projectMeta(dir)) || {};
  const idea = String(brief || '').trim() || `the video "${meta.name || project}"`;
  return [
    `Generate 6 thumbnail ideas for ${idea} as ONE image (a contact sheet). Make exactly one image.`,
    `Layout: a 3 × 2 grid (3 columns, 2 rows) on a plain dark background with thin, even gutters. Each cell is one complete 16:9 YouTube thumbnail idea, all six the same size, with a small number 1–6 in its top-left corner (left to right, then top to bottom). The whole image is landscape.`,
    `Make the six clearly different (composition, text, colour, angle). Text on a thumbnail: at most 4 big, readable words.`,
    `Use the brand and resources in packaging/RESOURCES.md, and the board's notes in packaging/PACKAGING.md.`,
    attached.length ? `Attached: ${attached.map((a, i) => `picture ${i + 1} is ${a}`).join('; ')}.` : '',
    more.length ? `Make these more like the attached cards ${more.join(' and ')} that the creator liked.` : '',
    `After the image, reply with one line per idea: "1. <the words on it> — <the idea in a few words>", nothing else.`,
  ].filter(Boolean).join('\n');
}
function refineBrief(item, note) {
  return [
    `Refine ${item.name || 'this idea'} (the attached picture) into one finished YouTube thumbnail: a single 16:9 landscape image, used at ${THUMB_SIZE.width} × ${THUMB_SIZE.height}. Make exactly one image.`,
    'Keep its idea, layout and words; make it clean, sharp and readable when small. Use the brand in packaging/RESOURCES.md.',
    note ? `The creator asks: ${String(note).slice(0, 2000)}` : '',
    'Then reply in one short line.',
  ].filter(Boolean).join('\n');
}

// ---- the post title ----
// Packaging fills the Post tab's YouTube title only when it is empty; it never overwrites one. Without a post kit yet,
// the title waits in PACKAGING.md (the post kit's brief tells the agent to use it).
export function fillPostTitle(dir, name, title) {
  if (!title) return 'none';
  if (!existsSync(join(dir, 'work/post.json'))) return 'later';
  const current = readPost(dir, name).post.youtube.title;
  if (current.trim()) return 'kept';
  savePost(dir, { 'youtube.title': title }, name);
  return 'filled';
}

// ---- reading a request body to a file (uploads) ----
async function receive(req, dest, max) {
  let size = 0;
  const limit = new Transform({ transform(chunk, enc, done) { size += chunk.length; if (size > max) done(Object.assign(new Error(`Files can be at most ${Math.round(max / 1024 / 1024)} MB.`), { status: 413 })); else done(null, chunk); } });
  await pipeline(req, limit, createWriteStream(dest));
  return size;
}

function serveImage(res, path, ext) {
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
  res.end(readFileSync(path));
}

// ---- resources for the Brand tab and the Packaging drawer ----
function levelsForProfile(s, profileId) {
  const p = s.get('profiles', profileId);
  const videos = listProjects().map((x) => ({ id: x.id, name: x.name, profileId: s.projectIds(x.id).profileId })).filter((x) => x.profileId === profileId);
  return [
    { scope: 'global', level: 'global', label: 'All styles', items: listResources(s, ['global']) },
    { scope: `profile:${profileId}`, level: 'profile', label: `Brand kit: ${p.name}`, items: listResources(s, [`profile:${profileId}`]) },
    { scope: null, level: 'project', label: 'Videos using this kit', videos: videos.map((v) => ({ ...v, scope: `project:${v.id}`, items: listResources(s, [`project:${v.id}`]) })) },
  ];
}
function levelsForProject(s, project) {
  const ids = s.projectIds(project), list = s.chainResources(project);
  return s.resourceChain(project).map((scope) => {
    const level = parseScope(scope).level;
    const label = level === 'global' ? 'All styles' : level === 'profile' ? `Brand kit: ${s.get('profiles', ids.profileId).name}` : 'This video';
    return { scope, level, label, items: list.filter((r) => r.shownAt === scope) };
  });
}
function checkScopeExists(s, scope) {
  checkResourceScope(scope);
  const p = parseScope(scope);
  if (p.level === 'profile') s.get('profiles', p.id);
  if (p.level === 'project' && !projectDir(p.id)) fail('That video no longer exists.', 404);
  return scope;
}
const describeResource = (r) => ({ ...r, attachable: canAttach(r) });

export async function resourcesRoute(req, res, url, { send, body }) {
  const parts = url.pathname.split('/').slice(3); // /api/resources/<id>/<action>
  const reply = (data, status = 200) => { send(res, status, data); return true; };
  try {
    if (req.method === 'GET') {
      if (parts[0] && parts[1] === 'file') {
        const r = use((s) => getResource(s, parts[0]));
        if (!r.hash) fail('This resource has no file.', 404);
        serveImage(res, use((s) => resourcePath(s, r)), r.ext);
        return true;
      }
      const profile = url.searchParams.get('profile'), project = url.searchParams.get('project');
      const levels = use((s) => (project ? levelsForProject(s, project) : profile ? levelsForProfile(s, profile) : fail('Choose a channel or a video.')));
      const shape = (l) => ({ ...l, items: l.items?.map(describeResource), videos: l.videos?.map((v) => ({ ...v, items: v.items.map(describeResource) })) });
      return reply({ levels: levels.map(shape), kinds: RESOURCE_KINDS, likeness: LIKENESS, uses: USES, maxBytes: MAX_RESOURCE_BYTES, shown: RESOURCE_LEVELS });
    }
    if (req.method !== 'POST') return reply({ error: 'POST required.' }, 405);
    if (parts[0] === 'upload') {
      const q = Object.fromEntries(url.searchParams);
      const tmp = scratch(settings().studio);
      try {
        const file = join(tmp, 'upload');
        await receive(req, file, maxBytesFor(q.kind));
        return reply(use((s) => describeResource(addResource(s, { scope: checkScopeExists(s, q.scope), name: q.name, kind: q.kind, likeness: q.likeness || undefined,
          use: q.use || undefined, note: q.note || '', tempPath: file, source: { via: 'upload' } }))));
      } finally { rmSync(tmp, { recursive: true, force: true }); }
    }
    const b = await body(req);
    if (parts[0] === 'note') return reply(use((s) => describeResource(addResource(s, { scope: checkScopeExists(s, b.scope), name: b.name, kind: 'note', text: b.text, note: b.note || '', use: b.use || undefined, source: { via: 'upload' } }))));
    if (parts[0] && parts[1] === 'archive') return reply(use((s) => describeResource(archiveResource(s, parts[0], { expected: b.expected, archived: b.archived !== false }))));
    if (parts[0] && !parts[1]) {
      return reply(use((s) => {
        if (b.scope !== undefined) checkScopeExists(s, b.scope);
        return describeResource(updateResource(s, parts[0], b));
      }));
    }
    return reply({ error: 'Unknown resource action.' }, 404);
  } catch (e) { return reply({ error: e.message }, e.status || 400); }
}

// ---- the Packaging tab ----
export async function packagingRoute(req, res, url, { send, body }) {
  const [project, action, sub, op] = url.pathname.split('/').slice(3).map(decodeURIComponent); // /api/packaging/<project>/<action>/…
  const reply = (data, status = 200) => { send(res, status, data); return true; };
  try {
    const dir = projectDir(project);
    if (!dir) fail('Project not found.', 404);
    const name = projectMeta(dir)?.name || project;
    if (req.method === 'GET') {
      if (!action) {
        // Opening the tab refreshes the projections, so resources changed elsewhere reach this video (live, not pinned).
        const view = use((s) => {
          s.writeResources(project, dir);
          s.writePackaging(project, dir);
          return { board: s.board(project), resources: levelsForProject(s, project).map((l) => ({ ...l, items: l.items.map(describeResource) })) };
        });
        const c = chats.get(`${settings().studio}:${project}`);
        return reply({ ...view, name, status: await imageStatus(), busy: Boolean(c?.busy), pending: c?.pendingImage?.kind || null,
          grid: SHEET_GRID, size: THUMB_SIZE, kinds: RESOURCE_KINDS, likeness: LIKENESS });
      }
      if (action === 'item' || action === 'sheet') {
        const x = use((s) => (action === 'item' ? s.item(project, sub) : s.sheet(project, sub)));
        if (!x.hash) fail('No image yet.', 404);
        serveImage(res, use((s) => s.files.verify(x.hash)), x.ext);
        return true;
      }
      if (action === 'events') {
        const c = chatFor(project);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        const open = new Set(c.openRequests());
        for (const ev of forReplay(c.history())) res.write(`data: ${JSON.stringify({ ...ev, replay: true, ...((ev.t === 'permission' || ev.t === 'question') && !open.has(ev.id) ? { expired: true } : {}) })}\n\n`);
        res.write(`data: ${JSON.stringify({ t: 'busy', busy: c.busy, replay: true })}\n\n`);
        if (!streams.has(project)) streams.set(project, new Set());
        streams.get(project).add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { clearInterval(ping); streams.get(project)?.delete(res); });
        return true;
      }
      return reply({ error: 'Unknown packaging page.' }, 404);
    }
    if (req.method !== 'POST') return reply({ error: 'POST required.' }, 405);

    if (action === 'upload') {
      // An old or planning thumbnail the creator already has.
      const tmp = scratch(settings().studio);
      try {
        const file = join(tmp, 'upload');
        await receive(req, file, MAX_UPLOAD);
        const head = readFileSync(file).subarray(0, 64);
        if (!imageType(head)) fail('Choose a PNG, JPEG, WebP or GIF image.');
        const fileName = String(url.searchParams.get('name') || 'Old thumbnail').replace(/[\\/]/g, '-').slice(0, 120);
        const item = use((s) => {
          const stored = s.files.putFile(file, { ext: extensionFor(head) });
          const x = s.addItem(project, { origin: 'uploaded', status: 'old', stored: storedOf(stored), size: imageSize(stored.path), name: fileName.replace(/\.[^.]+$/, '') });
          s.writePackaging(project, dir);
          return x;
        });
        boardChanged(project, 'upload');
        return reply(item);
      } finally { rmSync(tmp, { recursive: true, force: true }); }
    }

    const b = await body(req);
    if (action === 'title') {
      const meta = use((s) => { const m = s.setTitle(project, b.title); s.writePackaging(project, dir); return m; });
      const post = fillPostTitle(dir, name, meta.title);
      // A video still named automatically ("Untitled video") takes the creator's working title as its name.
      const renamed = meta.title ? autoName(project, meta.title, 'title') : null;
      boardChanged(project, 'title');
      return reply({ title: meta.title, post, renamed });
    }
    if (action === 'items' && sub && !op) {
      const r = use((s) => { const out = s.mark(project, sub, b); s.writePackaging(project, dir); return out; });
      if (b.main === true) appendWorklog(dir, `Packaging: chose the main thumbnail (${r.item.name || 'a card'}).`);
      boardChanged(project, 'mark');
      return reply(r);
    }
    // Use this idea (B8): its outline stub goes into Record's script (script.md). A script with text is never
    // overwritten: the answer says it exists, and the page asks before sending append: true (or skips).
    if (action === 'items' && sub && op === 'use') {
      const { item, sheet, title } = use((s) => {
        const x = s.item(project, sub);
        let sh = null;
        if (x.sheet) { try { sh = s.sheet(project, x.sheet); } catch {} }
        return { item: x, sheet: sh, title: s.packagingMeta(project).title || '' };
      });
      const idea = ideaOf(item, { sheet, title });
      const stub = outlineStub(idea);
      const r = writeIdeaScript(dir, stub, { append: b.append === true });
      if (r.written === 'new' || r.written === 'appended') appendWorklog(dir, `Packaging: put ${item.name || 'an idea'} into the script as an outline.`);
      return reply({ ...r, idea, stub, ask: OUTLINE_ASK });
    }

    // Everything below talks to the Packaging chat (Codex).
    const c = chatFor(project);
    if (action === 'answer') return reply({ ok: c.answer(b.id, { allow: Boolean(b.allow), message: b.message, answers: b.answers, always: Boolean(b.always) }) });
    if (action === 'stop') return reply({ ok: c.stop() });
    if (action === 'chat-sessions') { if (b.op === 'new') c.newSession(); else if (b.op === 'open') c.openSession(String(b.log || '')); return reply(c.sessions()); }
    if (action === 'chat-compact') { await c.compact(); return reply({ ok: true }); }
    if (c.busy) fail('Codex is still working on the last message. Wait for it, or stop it first.', 409);
    const status = await imageStatus();
    if (action === 'chat') {
      if (!status.available) fail(status.reason, 409);
      use((s) => { s.writeResources(project, dir); s.writePackaging(project, dir); });
      // Send again (a turn that stopped): the last message. A Generate or Refine is pressed again on the board (it opens
      // its sheet or card again).
      if (b.retry === true && c.lastBrief) fail('Press Generate 6 or Refine on the board again.', 409);
      if (b.retry === true) await c.retry();
      else await c.send(String(b.text || '').slice(0, 40000));
      return reply({ ok: true });
    }
    if (action === 'generate') {
      if (!status.available) fail(status.reason, 409);
      const more = (Array.isArray(b.more) ? b.more : []).slice(0, 2);
      const plan = use((s) => {
        s.writeResources(project, dir);
        s.writePackaging(project, dir);
        const resources = s.chainResources(project).filter((r) => canAttach(r) && r.use === 'always').slice(0, MAX_ATTACHED);
        const liked = more.map((id) => s.item(project, id));
        const attached = [...resources.map((r) => ({ path: resourcePath(s, r), label: `${r.name} (${RESOURCE_KINDS[r.kind]}${r.kind === 'photo' ? `, ${LIKENESS[r.likeness]}` : ''})` })),
          ...liked.map((x) => ({ path: s.files.verify(x.hash), label: `the liked card "${x.name}"` }))];
        const prompt = generateBrief({ project, brief: b.brief, attached: attached.map((a) => a.label), more: liked.map((x) => `"${x.name}"`) });
        const sheet = s.createSheet(project, { brief: b.brief || '', prompt, resources, grid: SHEET_GRID, more });
        return { sheet, prompt, images: attached.map((a) => a.path) };
      });
      c.pendingImage = { kind: 'sheet', sheet: plan.sheet.id, texts: [] };
      try {
        await c.send(plan.prompt, { brief: { name: 'Generate 6 thumbnail ideas' }, images: plan.images });
      } catch (e) {
        c.pendingImage = null;
        use((s) => s.failSheet(project, plan.sheet.id, { message: e.message }));
        throw e;
      }
      boardChanged(project, 'generate');
      return reply({ sheet: plan.sheet });
    }
    if (action === 'items' && sub && op === 'refine') {
      if (!status.available) fail(status.reason, 409);
      const plan = use((s) => {
        const item = s.item(project, sub);
        s.writeResources(project, dir);
        return { item, path: s.files.verify(item.hash), prompt: refineBrief(item, b.note) };
      });
      c.pendingImage = { kind: 'refine', parent: plan.item.id, prompt: plan.prompt, texts: [] };
      try {
        await c.send(plan.prompt, { brief: { name: `Refine ${plan.item.name || 'a card'}` }, images: [plan.path] });
      } catch (e) { c.pendingImage = null; throw e; }
      return reply({ ok: true, parent: plan.item.id });
    }
    return reply({ error: 'Unknown packaging action.' }, 404);
  } catch (e) { return reply({ error: e.message }, e.status || 400); }
}

export { MAX_WINNERS };

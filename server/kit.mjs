// The kit's routes and the lines it adds to the project chat's context: the post kit (postkit.mjs),
// sound cues and finding sounds (sound.mjs), styles and the studio library (library.mjs). index.mjs calls
// kitRoute() for the project actions below and libraryRoute() for everything under /api/library.
import { existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { inside, reveal } from './util.mjs';
import { projectMeta, saveProjectMeta, probe } from './studio.mjs';
import { canvasSources } from './export.mjs';
import { readPost, savePost, postBrief, postSummary, isShort } from './postkit.mjs';
import { readCues, cueOp, findBrief, cuePath, underVoiceDb, cueMix } from './sound.mjs';
import { KINDS, NEW_SOUNDS, libraryDir, libPath, listLibrary, listStyles, stylePath, saveToLibrary, saveBuffer, upload,
  approveSound, discardSound, freeSounds, freePath, addFreeSound, studioVideos, newStyle, styleBrief, libraryChat,
  libraryEvents, saveLibrarySettings, candidates, soundCatalog, soundCatalogContext, editSound } from './library.mjs';

const POSTS = new Set(['/settings', '/chat', '/answer', '/stop', '/style-new', '/style-make', '/sound-approve', '/sound-discard', '/sound-free-add', '/sound-find', '/sound-edit', '/reveal']);
export const KIT_ACTIONS = new Set(['/post', '/post-write', '/sound', '/sfx', '/sound-find', '/style', '/save-to-library']);

// Extra lines for the project chat's system prompt.
export function kitContext(dir, meta) {
  const lib = libraryDir();
  const style = meta?.style && stylePath(meta.style);
  return [
    style && existsSync(style) ? `This project's style is "${meta.style}": ${style}. Read it before planning, editing or writing for this project and follow it (the studio's own notes win where they differ).` : '',
    `The studio library is ${lib}. Media paths stay in place.`,
    soundCatalogContext(),
    `Sound cues: work/sfx.json {v: 1, cues: [{id, t (seconds on the canvas take, before the cut), file (a path in the library such as sfx/whoosh.wav, or in the project with from "project"), from "library"|"project", gain (dB on top of the default level, which puts the sound's loudest part about ${underVoiceDb()} dB under the voice: Settings → Sound, the level for your own renders too), label, by? ("hand" = the creator placed it in Video Octopus)}]}. Video Octopus shows them on the timeline and mixes them under the voice in its Export. A cue you add inside a block you build (the intro) goes with that block's render: Export → Video puts your render in for the block and mixes the cue only then, so list your render's transition sounds here at the moments they play.`,
    `The post kit is work/post.json (Video Octopus's Post tab; post.md follows it): {word, youtube {title, description, comment}, instagram {caption}, tiktok {caption}, dm {reply, tool}, links [{label, url, checked}], facts [...], notes, edited {field: time}}. Never invent links or prices, and keep fields the creator edited.`,
  ].filter(Boolean);
}

export function kitSummary(dir, meta) {
  const p = postSummary(dir);
  if (p.exists) readPost(dir, meta?.name); // keeps post.md in step when Claude wrote post.json directly
  const style = meta?.style || null;
  return { style, styleOk: Boolean(style && existsSync(stylePath(style) || '')), short: isShort(meta?.type), post: p, cues: readCues(dir).length };
}

const today = () => new Date().toISOString().slice(0, 10);

export async function kitRoute(action, req, res, url, ctx) {
  const { dir, send, body, chat } = ctx;
  const meta = projectMeta(dir) || {};
  try {
    if (action === '/post' && req.method === 'GET') return send(res, 200, readPost(dir, meta.name));
    if (action === '/sound' && req.method === 'GET') {
      const lib = listLibrary();
      // missing: the cue's file isn't there (moved or deleted from the library): the page doesn't try to load it.
      // mix: the dB the canvas preview plays each cue at, so it sits under the voice where the export puts it
      // (Settings → Sound's level, measured against the take's voice like the export: sound.mjs cueMix).
      const cues = readCues(dir), src = canvasSources(dir), voice = [src.cam, src.screen, src.audio].find((f) => f && probe(dir, f)?.audio);
      const mix = cueMix(dir, cues, voice ? join(dir, 'source', voice) : null);
      return send(res, 200, { cues: cues.map((c, i) => ({ ...c, missing: !existsSync(cuePath(dir, c) || ''), mix: mix[i] })), under: underVoiceDb(), sounds: lib.kinds.find((k) => k.key === 'sfx').items.filter(x=>!x.missing), candidates: lib.candidates,
        free: Boolean(lib.settings.sfxFreeDir), library: lib.dir });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    const b = await body(req, action === '/save-to-library' ? 80e6 : 1e6);
    if (action === '/post') return send(res, 200, savePost(dir, b.patch, meta.name));
    if (action === '/post-write') {
      const text = postBrief(dir, meta);
      await chat().send(text, { brief: { step: 'post-kit', name: 'Write the post' } });
      return send(res, 200, { ok: true });
    }
    if (action === '/sfx') return send(res, 200, cueOp(dir, b));
    if (action === '/sound-find') {
      await chat().send(findBrief({ query: b.query, at: b.at == null ? null : Number(b.at), project: true }), { brief: { name: 'Find a sound' } });
      return send(res, 200, { ok: true });
    }
    if (action === '/style') {
      const style = String(b.style || '');
      if (style && !existsSync(stylePath(style) || '')) throw new Error('That style is not in the library.');
      saveProjectMeta(dir, { style: style || undefined }); // the chat gets it with the next message (claude.mjs)
      return send(res, 200, { style: style || null });
    }
    if (action === '/save-to-library') {
      const kind = String(b.kind || '');
      const note = [String(b.note || '').trim(), `from ${basename(dir)}${b.file ? `/${b.file}` : ''}`, today()].filter(Boolean).join(' · ');
      if (b.png) {
        const m = /^data:image\/png;base64,(.+)$/.exec(b.png);
        if (!m) throw new Error('No picture to save.');
        const name = `${b.name || basename(String(b.file || 'still'), extname(String(b.file || '')))}.png`;
        return send(res, 200, saveBuffer(kind, Buffer.from(m[1], 'base64'), name, note));
      }
      const src = inside(dir, String(b.file || ''));
      if (!src) throw new Error('Bad file');
      return send(res, 200, saveToLibrary(kind, src, { name: b.name, note }));
    }
  } catch (e) { return send(res, 400, { error: e.message }); }
  return send(res, 404, { error: 'Unknown action' });
}

// The routes under /api/library. Returns false for a path it doesn't know, so other modules' library routes
// (the look branch's /api/library/backgrounds/<name>) still get it.
export async function libraryRoute(req, res, url, { send, body, serveFile }) {
  const done = (x) => (x === false ? false : true);
  return done(await libraryRouteInner(req, res, url, { send, body, serveFile }));
}
async function libraryRouteInner(req, res, url, { send, body, serveFile }) {
  const p = url.pathname.replace(/^\/api\/library/, '') || '/';
  const q = (k) => url.searchParams.get(k) || '';
  try {
    if (req.method === 'GET') {
      if (p === '/') return send(res, 200, listLibrary());
      if (p === '/events') return libraryEvents(req, res);
      if (p === '/file') return serveFile(req, res, libPath(q('f')));
      if (p === '/free') return send(res, 200, freeSounds(q('q')));
      if (p === '/free-file') return serveFile(req, res, freePath(q('f')));
      if (p === '/videos') return send(res, 200, studioVideos(q('q')).map(({ rel, at, bytes }) => ({ rel, at, bytes })));
      if (p === '/styles') return send(res, 200, listStyles());
      if (p === '/sound-catalog') return send(res, 200, soundCatalog());
      if (p === '/candidates') return send(res, 200, candidates());
      return false;
    }
    if (p === '/upload') return send(res, 200, await upload(req, { kind: q('kind'), style: q('style'), name: q('name'), note: q('note') }));
    if (!POSTS.has(p)) return false;
    const b = await body(req);
    const c = libraryChat();
    if (p === '/settings') return send(res, 200, saveLibrarySettings(b));
    if (p === '/chat') { if (!String(b.text || '').trim()) throw new Error('Empty message'); await c.send(String(b.text).trim()); return send(res, 200, { ok: true }); }
    if (p === '/answer') {
      const ok = c.answer(b.id, { allow: Boolean(b.allow), message: b.message, answers: b.answers });
      return send(res, ok ? 200 : 409, ok ? { ok } : { error: 'Claude is no longer waiting on that.' });
    }
    if (p === '/stop') return send(res, 200, { ok: c.stop() });
    if (p === '/style-new') return send(res, 200, newStyle(String(b.name || '')));
    if (p === '/style-make') {
      const text = styleBrief(String(b.slug || ''), { paths: Array.isArray(b.paths) ? b.paths : [], links: Array.isArray(b.links) ? b.links : [] });
      await c.send(text, { brief: { name: 'Make a style' } });
      return send(res, 200, { ok: true });
    }
    if (p === '/sound-edit') return send(res, 200, editSound(String(b.file||''),b.revision,b));
    if (p === '/sound-approve') return send(res, 200, approveSound(String(b.file || ''), b.note, b.revision));
    if (p === '/sound-discard') return send(res, 200, discardSound(String(b.file || ''), b.revision));
    if (p === '/sound-free-add') return send(res, 200, addFreeSound(String(b.file || ''), b.note));
    if (p === '/sound-find') { await c.send(findBrief({ query: b.query }), { brief: { name: 'Find a sound' } }); return send(res, 200, { ok: true }); }
    if (p === '/reveal') {
      const f = libPath(String(b.file || '.'));
      if (f) reveal(existsSync(f) ? f : libraryDir());
      return send(res, 200, { ok: true });
    }
    return false;
  } catch (e) { return send(res, 400, { error: e.message }); }
}

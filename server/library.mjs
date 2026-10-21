// The studio library: reusable pieces every project can use. One folder per kind inside <studio>/library
// (or libraryDir). Sound metadata lives in SQLite; audio paths stay intact. Other legacy sections use
// INDEX.md. Agents read the generated sound catalog or the app API. Also here: the Library's own Claude chat (style breakdowns and finding sounds from
// Home), uploads (sample videos, sound files), "Save to library" and the "style from samples" brief.
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, appendFileSync, copyFileSync,
  createWriteStream, renameSync, rmSync, watch, constants } from 'node:fs';
import { join, basename, extname, relative, dirname } from 'node:path';
import { APP_DIR, settings, saveSettings, expandHome, inside, readJSON, writeJSON, mtime, slugify } from './util.mjs';
import { makeChat, staleChat } from './engines.mjs';
import { withSoundCatalog } from './sound-catalog.mjs';
import { projectsRoot } from './studio.mjs';

export const KINDS = [
  { key: 'backgrounds', label: 'Backgrounds', about: 'Backgrounds for layouts and scenes: images, videos, or code that draws one.' },
  { key: 'sfx', label: 'Sounds', about: 'Sound effects approved for use. Effects sit under the voice at the level in Settings → Sound.' },
  { key: 'styles', label: 'Legacy styles', about: 'Existing style files remain available to older projects. Study new examples in Video formats.' },
  { key: 'components', label: 'Components', about: 'Reusable scene pieces: cards, titles, windows, lower thirds.' },
  { key: 'broll', label: 'B-roll', about: 'Clips to cut in over the voice.' },
  { key: 'stills', label: 'Stills', about: 'Frames saved from renders.' },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.key, k]));
export const NEW_SOUNDS = 'sfx/_new'; // sounds Claude found or made, waiting for the creator's approval

export const libraryDir = () => {
  const s = settings();
  return expandHome(s.libraryDir || '') || join(s.studio, 'library');
};
export const libPath = (rel) => inside(libraryDir(), rel || '.');

export const typeOf = (f) => (/\.(png|jpe?g|webp|gif|svg)$/i.test(f) ? 'image' : /\.(mp4|mov|m4v|webm)$/i.test(f) ? 'video'
  : /\.(wav|mp3|ogg|m4a|aiff?|flac)$/i.test(f) ? 'audio' : /\.md$/i.test(f) ? 'text' : /\.html?$/i.test(f) ? 'html'
  : /\.(js|mjs|css|json|py)$/i.test(f) ? 'code' : 'other');
export const AUDIO = /\.(wav|mp3|ogg|m4a|aiff?|flac)$/i;
const today = () => new Date().toISOString().slice(0, 10);

// ---- INDEX.md: "- `file` — note" per line ----
export function readIndex(dir) {
  const map = new Map();
  let text = '';
  try { text = readFileSync(join(dir, 'INDEX.md'), 'utf8'); } catch { return map; }
  for (const line of text.split('\n')) {
    const m = /^\s*[-*]\s+(?:`([^`]+)`|([^\s—–:]+))\s*(?:[—–:]+|\s-\s)?\s*(.*)$/.exec(line);
    if (m) map.set((m[1] || m[2]).replace(/^\.\//, ''), m[3].trim());
  }
  return map;
}

export const soundCatalog = () => withSoundCatalog(settings().studio,libraryDir(),c=>c.snapshot());
export function editSound(file,revision,patch){if(!Number.isInteger(revision))throw Error('Include the sound revision.');const row=withSoundCatalog(settings().studio,libraryDir(),c=>c.change(file,revision,patch));soundCatalog();send({t:'files'});return row;}

export function addIndexLine(kind, file, note) {
  if(kind==='sfx'){withSoundCatalog(settings().studio,libraryDir(),c=>c.register(`sfx/${file}`,{note:note||''}));soundCatalog();send({t:'files'});return;}
  const dir = join(libraryDir(), kind);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'INDEX.md');
  if (!existsSync(p)) writeFileSync(p, `# ${KIND[kind]?.label || kind}\n\n${KIND[kind]?.about || ''}\nOne line per file: what it is, where it came from, its licence.\n\n`);
  const text = readFileSync(p, 'utf8');
  appendFileSync(p, `${text.endsWith('\n') ? '' : '\n'}- \`${file}\` — ${String(note || '').replace(/\s+/g, ' ').trim() || 'added from Video Octopus'}\n`);
}

// A file name that isn't taken yet in a folder ("whoosh.wav" → "whoosh-2.wav").
export function freeName(dir, name) {
  const ext = extname(name), raw = basename(name, ext);
  const base = /^[\w-]{1,80}$/.test(raw) ? raw : slugify(raw) || 'file';
  let n = `${base}${ext.toLowerCase()}`;
  for (let i = 2; existsSync(join(dir, n)); i++) n = `${base}-${i}${ext.toLowerCase()}`;
  return n;
}

// ---- listing ----
function styleSummary(p) {
  let text = '';
  try { text = readFileSync(p, 'utf8'); } catch { return ''; }
  const lines = text.split('\n').map((l) => l.trim());
  const sum = lines.find((l) => /^(\*\*)?summary/i.test(l));
  if (sum) return sum.replace(/^(\*\*)?summary(\*\*)?\s*[:—-]*\s*(\*\*)?/i, '').slice(0, 240);
  return (lines.find((l) => l && !l.startsWith('#') && !l.startsWith('|') && !l.startsWith('---')) || '').slice(0, 240);
}

function kindItems(kind) {
  const dir = join(libraryDir(), kind);
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const index = readIndex(dir);
  return names.filter((n) => !n.startsWith('.') && !n.startsWith('_') && n !== 'INDEX.md' && n !== 'README.md')
    .flatMap((n) => {
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { return []; }
      if (kind === 'styles') {
        if (!n.endsWith('.md')) return [];
        const slug = n.replace(/\.md$/, '');
        return [{ file: `${kind}/${n}`, name: slug, type: 'text', at: st.mtimeMs, note: index.get(n) || styleSummary(p),
          samples: readJSON(join(dir, slug, 'samples.json'), null)?.samples?.length || 0 }];
      }
      if (st.isDirectory()) {
        const page = ['index.html', 'preview.html', 'demo.html'].find((f) => existsSync(join(p, f)));
        return [{ file: `${kind}/${n}`, name: n, type: 'folder', at: st.mtimeMs, note: index.get(n) || index.get(`${n}/`) || '',
          preview: page ? `${kind}/${n}/${page}` : null }];
      }
      return [{ file: `${kind}/${n}`, name: n, type: typeOf(n), at: st.mtimeMs, bytes: st.size, note: index.get(n) || '' }];
    })
    .sort((a, b) => b.at - a.at);
}

// Styles still being written: a folder with samples.json but no <slug>.md yet.
function pendingStyles() {
  const dir = join(libraryDir(), 'styles');
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => existsSync(join(dir, n, 'samples.json')) && !existsSync(join(dir, `${n}.md`)))
    .map((n) => ({ name: n, ...readJSON(join(dir, n, 'samples.json'), {}) }));
}

export function candidates() { return soundCatalog().items.filter(r=>r.status==='pending'); }

export function listLibrary() {
  const dir = libraryDir();
  const s = settings(),catalog=soundCatalog();
  return {
    soundCatalog:{storage:catalog.storage,snapshot:catalog.snapshot,warnings:catalog.warnings},
    dir, exists: existsSync(dir),
    settings: { libraryDir: s.libraryDir || '', sfxFreeDir: s.sfxFreeDir || '', defaultDir: join(s.studio, 'library') },
    kinds: KINDS.map((k) => ({ ...k, items: k.key==='sfx'?catalog.items.filter(r=>r.status==='approved'):kindItems(k.key) })),
    candidates: catalog.items.filter(r=>r.status==='pending'), pendingStyles: pendingStyles(),
  };
}

export const listStyles = () => kindItems('styles').map((x) => ({ name: x.name, note: x.note, at: x.at }));
export const stylePath = (slug) => (slug && /^[\w-]+$/.test(slug) ? join(libraryDir(), 'styles', `${slug}.md`) : null);

// ---- adding things ----
// Copy a file into the library (an APFS clone, so it's instant and takes no space) and index it.
export function saveToLibrary(kind, src, { name, note } = {}) {
  if (!KIND[kind] || kind === 'styles') throw new Error('Pick where it goes: backgrounds, sounds, components, B-roll or stills.');
  if (!src || !existsSync(src)) throw new Error('That file is gone.');
  if(kind==='sfx'&&!AUDIO.test(src))throw Error('Choose an audio file for Sounds.');
  const dir = join(libraryDir(), kind);
  mkdirSync(dir, { recursive: true });
  const file = freeName(dir, name ? `${name}${extname(src)}` : basename(src));
  copyFileSync(src, join(dir, file), constants.COPYFILE_FICLONE);
  addIndexLine(kind, file, note);
  return { file: `${kind}/${file}` };
}

export function saveBuffer(kind, buf, name, note) {
  if (!KIND[kind] || kind === 'styles') throw new Error('Unknown library folder.');
  if(kind==='sfx'&&!AUDIO.test(name))throw Error('Choose an audio file for Sounds.');
  const dir = join(libraryDir(), kind);
  mkdirSync(dir, { recursive: true });
  const file = freeName(dir, name);
  writeFileSync(join(dir, file), buf);
  addIndexLine(kind, file, note);
  return { file: `${kind}/${file}` };
}

// A dropped file, streamed to disk: a sample video for a style, or a file for one of the library folders.
export async function upload(req, { kind, style, name, note }) {
  const clean = basename(String(name || 'file')).replace(/[^\w.\- ()]+/g, '_').slice(-120) || 'file';
  if(kind==='sfx'&&!AUDIO.test(clean))throw Error('Choose an audio file for Sounds.');
  let dir, indexed = false;
  if (kind === 'samples') {
    if (!/^[\w-]+$/.test(style || '')) throw new Error('Bad style name');
    dir = join(libraryDir(), 'styles', style, 'samples');
  } else if (KIND[kind] && kind !== 'styles') { dir = join(libraryDir(), kind); indexed = true; }
  else throw new Error('Unknown library folder.');
  mkdirSync(dir, { recursive: true });
  const file = indexed ? freeName(dir, clean) : clean;
  const part = join(dir, `.${file}.part`);
  await new Promise((done, fail) => {
    const out = createWriteStream(part);
    let bytes = 0;
    req.on('data', (c) => { bytes += c.length; if (bytes > 4e9) { req.destroy(); fail(new Error('That file is too big.')); } });
    req.pipe(out);
    out.on('finish', done);
    out.on('error', fail);
    req.on('error', fail);
  });
  renameSync(part, join(dir, file));
  if (indexed) addIndexLine(kind, file, note || 'added from Video Octopus');
  return { file: kind === 'samples' ? `styles/${style}/samples/${file}` : `${kind}/${file}`, path: join(dir, file) };
}

// ---- sounds waiting for approval ----
export function approveSound(rel, note, revision) {
  const row=withSoundCatalog(settings().studio,libraryDir(),c=>{c.scan();return c.change(rel,revision,note===undefined?{}:{note},'approved');});
  soundCatalog();send({t:'files'});return {file:row.file,id:row.id};
}
export function discardSound(rel,revision) {
  withSoundCatalog(settings().studio,libraryDir(),c=>{c.scan();c.change(rel,revision,{},'discarded');});
  soundCatalog();send({t:'files'});return {ok:true,note:'Removed from the review queue. The audio and catalog history are retained.'};
}

// ---- the free sound folder (a setting): search by file name, copy into the library ----
export function freeSounds(q = '', limit = 80) {
  const root = expandHome(settings().sfxFreeDir || '');
  if (!root || !existsSync(root)) return { dir: root || null, items: [] };
  const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  let seen = 0;
  const walk = (d, depth) => {
    let names = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (out.length >= limit || ++seen > 20000) return;
      if (n.startsWith('.')) continue;
      const p = join(d, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth < 6) walk(p, depth + 1); continue; }
      if (!AUDIO.test(n)) continue;
      const rel = relative(root, p);
      if (terms.every((t) => rel.toLowerCase().includes(t))) out.push({ file: rel, name: n, at: st.mtimeMs });
    }
  };
  walk(root, 0);
  return { dir: root, items: out };
}

// The nearest licence file above a sound in the free folder (CC0 packs ship one).
function licenceNear(path, root) {
  for (let d = dirname(path); d.startsWith(root); d = dirname(d)) {
    let names = [];
    try { names = readdirSync(d); } catch { break; }
    const lic = names.find((n) => /^licen[sc]e/i.test(n));
    if (lic) {
      const text = (() => { try { return readFileSync(join(d, lic), 'utf8'); } catch { return ''; } })();
      return /CC0|creative commons zero|public domain/i.test(text) ? 'CC0' : `see ${relative(root, join(d, lic))}`;
    }
    if (d === root) break;
  }
  return '';
}

export function addFreeSound(rel, note) {
  const root = expandHome(settings().sfxFreeDir || '');
  const src = root && inside(root, rel);
  if (!src || !existsSync(src)) throw new Error('That sound is gone from the free folder.');
  const lic = licenceNear(src, root);
  return saveToLibrary('sfx', src, { note: [note || basename(rel, extname(rel)), `from ${basename(root)}/${rel}`, lic && `licence: ${lic}`, `added ${today()}`].filter(Boolean).join(' · ') });
}
export const freePath = (rel) => { const root = expandHome(settings().sfxFreeDir || ''); return root ? inside(root, rel) : null; };

// ---- videos in the studio, to pick as style samples (read only: they're referenced, never copied) ----
let videoCache = { at: 0, items: [] };
export function studioVideos(q = '') {
  if (Date.now() - videoCache.at > 60000) {
    const root = projectsRoot(), items = [];
    let seen = 0;
    const skip = /^(work|source|seq.*|frames?|masks?.*|parts?\d*|tiles|node_modules|\.venv|_.*|cache|tmp)$/i;
    const walk = (d, depth) => {
      let names = [];
      try { names = readdirSync(d); } catch { return; }
      for (const n of names) {
        if (++seen > 40000) return;
        if (n.startsWith('.')) continue;
        const p = join(d, n);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) { if (depth < 4 && !skip.test(n)) walk(p, depth + 1); continue; }
        if (/\.(mp4|mov|m4v|webm)$/i.test(n) && !/\.part/.test(n) && st.size > 200e3) items.push({ path: p, rel: relative(settings().studio, p), at: st.mtimeMs, bytes: st.size });
      }
    };
    walk(root, 0);
    videoCache = { at: Date.now(), items: items.sort((a, b) => b.at - a.at) };
  }
  const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  return videoCache.items.filter((x) => terms.every((t) => x.rel.toLowerCase().includes(t))).slice(0, 80);
}

// ---- styles from samples ----
export function newStyle(name) {
  const slug = slugify(name);
  if (!slug) throw new Error('Give the style a name.');
  const dir = join(libraryDir(), 'styles');
  if (existsSync(join(dir, `${slug}.md`))) throw new Error(`There's already a style called "${slug}".`);
  mkdirSync(join(dir, slug, 'samples'), { recursive: true });
  return { slug };
}

export function styleBrief(slug, { paths = [], links = [] }) {
  const dir = join(libraryDir(), 'styles', slug);
  if (!/^[\w-]+$/.test(slug) || !existsSync(dir)) throw new Error('Unknown style');
  const studio = settings().studio;
  const uploads = (() => { try { return readdirSync(join(dir, 'samples')).filter((f) => !f.startsWith('.')).map((f) => join(dir, 'samples', f)); } catch { return []; } })();
  const files = [...new Set([...uploads, ...paths.map((p) => inside(studio, p) || inside(libraryDir(), p)).filter((p) => p && existsSync(p))])];
  const urls = [...new Set(links.map((l) => String(l).trim()).filter((l) => /^https?:\/\/\S+$/.test(l)))];
  const total = files.length + urls.length;
  if (total < 3 || total > 10) throw new Error(`A style needs 3 to 10 samples (you have ${total}).`);
  writeJSON(join(dir, 'samples.json'), { name: slug, asked: new Date().toISOString(), samples: [...files.map((p) => ({ file: p })), ...urls.map((u) => ({ url: u }))] });
  const md = join(libraryDir(), 'styles', `${slug}.md`);
  return [
    `Make a new style called "${slug}" from these ${total} sample videos, as a breakdown the editor can follow when making a Short in this style.`,
    '',
    ...files.map((p) => `- ${p} (local file: read only, never change or move it)`),
    ...urls.map((u) => `- ${u} (link: download it with yt-dlp into ${join(dir, 'samples')} if yt-dlp is installed; never sign in anywhere. If it can't be downloaded, say so and work from the others)`),
    '',
    `Study each sample the way the studio studies a creator (if the studio has notes on how it breaks down reels, follow them): its length; frames at about 0.3 s, the middle and the end, plus a contact sheet of one frame a second; the speech transcribed with the studio's transcribe skill (or faster-whisper on this computer); how often the shot changes (ffmpeg scene detection); loudness and whether there is music. Put frames, sheets and transcripts in ${join(dir, 'work')}/.`,
    '',
    `Then write ${md} with these sections:`,
    '- **Summary**: one line (it shows on the style card).',
    '- Hook: what happens in the first 3 seconds, on screen and in the words.',
    '- Pacing: length, average shot length, where the cuts land.',
    '- Layouts: framing, face vs full-screen graphics, split, cards, backgrounds.',
    '- Captions: font, size, position, colour, words per line, emphasis.',
    '- Sound: voice, music bed, sound effects and where they sit.',
    '- CTA: how it ends and how viewers are asked to act (comment WORD, link, follow).',
    '- For our version: what to take and what to leave, as short Do / Don\'t lines.',
    'Measure what you can and mark guesses "(guess)". Describe the structure; never copy the creators\' sentences or hooks word for word.',
    'Write only inside the style\'s folder and the .md file: never change, move or re-encode the samples, and never write into project folders.',
    '',
    `Finally add one line for it to ${join(libraryDir(), 'styles', 'INDEX.md')}: "- \`${slug}.md\` — <the summary>". Video Octopus shows the style once the .md file exists. Reply in two or three lines.`,
  ].join('\n');
}

export function soundCatalogContext(){const c=soundCatalog();return `Sound metadata, approval status, source/licence and tags live in SQLite. Read the current generated catalog at ${c.snapshot}, or GET /api/library/sound-catalog (run library sounds --json using ${join(APP_DIR, 'bin/octopus.mjs')}). Each entry has a stable id, revision, relative file and absolute path; use only approved, non-missing sounds. Audio stays at these paths, including approved files in sfx/_new/. Never move media or edit SQLite directly. Use POST /api/library/sound-edit with {file,revision,note,source,licence,tags} for explicitly requested metadata edits. Existing INDEX.md is retained legacy metadata, not the authority. Back up through Storage before any migration; do not reorganize creator folders.`;}

// ---- the Library's own Claude chat ----
function libraryContext() {
  const s = settings(), lib = libraryDir();
  return [
    `You are the Library assistant inside Video Octopus, the creator's local video editing app. You look after the studio library: reusable pieces every project can use.`,
    `Your studio folder (your working directory): ${s.studio}. Library: ${lib}.`,
    `Library folders: ${KINDS.map((k) => `${k.key}/ (${k.about})`).join(' ')} Non-sound folders have an INDEX.md with one line per file: "- \`file\` — what it is · where it came from · licence · date". Keep it in step when you add a file.`,
    soundCatalogContext(),
    `Sounds you find or make go to ${join(lib, NEW_SOUNDS)}/ with a line each in ${join(lib, NEW_SOUNDS, 'candidates.json')} ([{"file", "note", "source", "licence"}]); the app imports NEW candidate entries into SQLite and the creator approves them in Video Octopus. Approval keeps the audio path unchanged. Never edit existing catalog entries through JSON or SQL; use the catalog API. Do not approve sounds yourself.`,
    `Existing legacy styles remain in ${join(lib, 'styles')}/ for older projects. New reference studies belong in Video formats; do not start another file-based style workflow.`,
    `The creator reads you in a narrow side panel: keep replies short and plain, and say what you're doing before long jobs.`,
  ].join('\n');
}

let chat = null;
const streams = new Set();
const send = (ev) => { for (const res of streams) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
export function libraryChat() {
  if (staleChat(chat)) { chat.kill(); chat = null; }
  if (!chat) {
    chat = makeChat('_library', libraryContext);
    chat.listeners.add(send);
    process.on('exit', () => chat.kill()); // index.mjs's shutdown ends with process.exit
  }
  return chat;
}

// The library folder changes (Claude wrote a style or a sound): tell the open Library pages.
let watcher = null, timer = null;
function watchLibrary() {
  if (watcher) return;
  const dir = libraryDir();
  try {
    mkdirSync(dir, { recursive: true });
    watcher = watch(dir, { recursive: true }, (_e, f) => {
      if (f && /(^|\/)work\//.test(f)) return; // frames and sheets of a breakdown: too noisy
      clearTimeout(timer);
      timer = setTimeout(() => send({ t: 'files' }), 600);
    });
  } catch {}
}

// A look at the chat for a GET (the event stream): the one in use, even a stale one (same log), or one made just to read
// the log and never kept. A GET never stops, replaces or starts the chat; the next POST does (libraryChat).
export const peekLibraryChat = () => chat || makeChat('_library', libraryContext);

export function libraryEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const c = peekLibraryChat();
  const open = new Set(c.openRequests());
  const done = new Set(c.history().filter((e) => e.t === 'permission_done').map((e) => e.id));
  for (const ev of c.history().slice(-300)) {
    if ((ev.t === 'permission' || ev.t === 'question') && !open.has(ev.id) && !done.has(ev.id)) ev.expired = true;
    res.write(`data: ${JSON.stringify({ ...ev, replay: true })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ t: 'busy', busy: c.busy })}\n\n`);
  streams.add(res);
  watchLibrary();
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); streams.delete(res); });
}

export function saveLibrarySettings(b) {
  const patch = {};
  for (const k of ['libraryDir', 'sfxFreeDir']) {
    if (typeof b[k] !== 'string') continue;
    const v = b[k].trim();
    if (v && !existsSync(expandHome(v)) && k === 'sfxFreeDir') throw new Error('That folder does not exist.');
    patch[k] = v;
  }
  saveSettings(patch);
  if (patch.libraryDir !== undefined && watcher) { watcher.close(); watcher = null; if (streams.size) watchLibrary(); }
  videoCache.at = 0;
  return listLibrary().settings;
}

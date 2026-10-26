// The creator's brand kit, from Setup's "Your brand" step and Settings → Brand: uploads (logos, photos of the creator,
// product images, brand fonts, example videos and thumbnails they like) stream into <library>/brand/<kind>/ with one
// line each in <library>/brand/INDEX.md, and <studio>/BRAND.md turns the Setup answers, the colours and fonts and those
// files into the studio's own brand notes, which the studio's CLAUDE.md tells every agent to read. BRAND.md's
// generated part sits between two marker lines; anything the creator writes outside them is kept on every rewrite.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, renameSync, rmSync, createWriteStream, createReadStream } from 'node:fs';
import { once } from 'node:events';
import { join, extname, basename, relative, isAbsolute } from 'node:path';
import { settings, inside, tildePath } from './util.mjs';
import { libraryDir, freeName } from './library.mjs';
import { section, profile, onSettingsChange } from './settings.mjs';

const IMG = ['png', 'jpg', 'jpeg', 'webp'];
// What each folder takes, and how big a file may be.
export const BRAND_KINDS = {
  logos: { label: 'Logos', one: 'Logo', ext: [...IMG, 'svg', 'gif'], max: 20e6, hint: 'PNG or SVG, with a see-through background if you have one' },
  photos: { label: 'Photos of you', one: 'Photo of the creator', ext: IMG, max: 40e6, hint: 'For thumbnails and cut-outs' },
  products: { label: 'Product images', one: 'Product image', ext: [...IMG, 'svg'], max: 40e6, hint: 'Things you show or sell' },
  fonts: { label: 'Brand fonts', one: 'Brand font', ext: ['ttf', 'otf', 'woff', 'woff2'], max: 20e6, hint: 'Font files you’re allowed to use' },
  examples: { label: 'Videos and thumbnails you like', one: 'Example the creator likes', ext: ['mp4', 'mov', 'm4v', 'webm', ...IMG], max: 2e9, hint: 'Your own or others’: the look you’re after' },
};
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const kindOfExt = (ext) => (IMG.includes(ext) || ext === 'svg' || ext === 'gif' ? 'image' : ['ttf', 'otf', 'woff', 'woff2'].includes(ext) ? 'font' : 'video');

export const brandDir = () => join(libraryDir(), 'brand');
const studioOk = () => { const s = settings().studio; return Boolean(s) && existsSync(s); };
const today = () => new Date().toISOString().slice(0, 10);

// Does the start of the file look like its extension says? (So a renamed .exe never lands as a "logo".)
export function sniff(ext, head) {
  const b = head, at = (o, s) => b.length >= o + s.length && b.subarray(o, o + s.length).toString('latin1') === s;
  switch (ext) {
    case 'png': return at(0, '\x89PNG\r\n\x1a\n');
    case 'jpg': case 'jpeg': return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'gif': return at(0, 'GIF87a') || at(0, 'GIF89a');
    case 'webp': return at(0, 'RIFF') && at(8, 'WEBP');
    case 'svg': {
      if (b.includes(0)) return false;
      const t = b.toString('utf8').replace(/^\uFEFF/, '').trimStart();
      return t.startsWith('<') && /<svg[\s>]/i.test(t);
    }
    case 'ttf': return at(0, '\x00\x01\x00\x00') || at(0, 'true');
    case 'otf': return at(0, 'OTTO') || at(0, '\x00\x01\x00\x00');
    case 'woff': return at(0, 'wOFF');
    case 'woff2': return at(0, 'wOF2');
    case 'mp4': case 'm4v': case 'mov': return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].some((x) => at(4, x));
    case 'webm': return b.length > 3 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    // Sound files (Resources' music): an ID3 tag or an MPEG frame, RIFF WAVE, an MP4 box, ADTS, Ogg, FLAC.
    case 'mp3': return at(0, 'ID3') || (b.length > 1 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
    case 'wav': return at(0, 'RIFF') && at(8, 'WAVE');
    case 'm4a': return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].some((x) => at(4, x));
    case 'aac': return at(0, 'ID3') || (b.length > 1 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0);
    case 'ogg': return at(0, 'OggS');
    case 'flac': return at(0, 'fLaC');
    default: return false;
  }
}

// ---- INDEX.md: "- `logos/acme.png` — Logo · from Setup · 2026-10-18" ----
const INDEX_HEAD = '# Brand\n\nThe creator\'s brand files: logos/, photos/ (of the creator), products/, fonts/, examples/ (videos and thumbnails they like). One line per file: what it is, where it came from, the date. BRAND.md in the studio folder sums them up.\n\n';
function readIndex() {
  const map = new Map();
  let text = '';
  try { text = readFileSync(join(brandDir(), 'INDEX.md'), 'utf8'); } catch { return map; }
  for (const line of text.split('\n')) {
    const m = /^\s*[-*]\s+`([^`]+)`\s*(?:[—–:-]+)?\s*(.*)$/.exec(line);
    if (m) map.set(m[1], m[2].trim());
  }
  return map;
}
function addIndexLine(file, note) {
  const p = join(brandDir(), 'INDEX.md');
  mkdirSync(brandDir(), { recursive: true });
  const text = existsSync(p) ? readFileSync(p, 'utf8').replace(/\n*$/, '\n') : INDEX_HEAD;
  writeFileSync(p, `${text}- \`${file}\` — ${String(note).replace(/\s+/g, ' ').trim()}\n`);
}
function dropIndexLine(file) {
  const p = join(brandDir(), 'INDEX.md');
  if (!existsSync(p)) return;
  const text = readFileSync(p, 'utf8');
  writeFileSync(p, text.split('\n').filter((l) => !l.includes(`\`${file}\``)).join('\n'));
}

// "logos/acme.png" → its full path, or null (a known folder, one plain file name, inside the brand folder).
function brandPath(rel) {
  const m = /^([a-z]+)\/([^/\\]+)$/.exec(String(rel || ''));
  if (!m || !BRAND_KINDS[m[1]] || m[2].startsWith('.') || m[2] === 'INDEX.md') return null;
  return inside(brandDir(), join(m[1], m[2]));
}

// ---- upload: streamed to a .part file, checked, then named ----
export async function brandUpload(req, { kind, name, note }) {
  if (!studioOk()) throw Object.assign(new Error('Create your studio first: brand files go into its library.'), { status: 400 });
  const k = BRAND_KINDS[kind];
  if (!k) throw Object.assign(new Error('Unknown brand folder.'), { status: 400 });
  const raw = basename(String(name || '').replace(/\\/g, '/'));
  const ext = extname(raw).slice(1).toLowerCase();
  if (!k.ext.includes(ext)) throw Object.assign(new Error(`${k.label} take ${k.ext.map((x) => `.${x}`).join(', ')} files.`), { status: 400 });
  const max = k.max;
  if (Number(req.headers['content-length']) > max) throw Object.assign(new Error(`That file is too big for ${k.label.toLowerCase()} (${Math.round(max / 1e6)} MB at most).`), { status: 413 });
  const dir = join(brandDir(), kind);
  mkdirSync(dir, { recursive: true });
  const stem = basename(raw, extname(raw)).replace(/[^\w.() -]+/g, '_').replace(/^[.\s_]+/, '').slice(0, 80) || kind.slice(0, -1);
  const part = join(dir, `.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.part`);
  const out = createWriteStream(part, { flags: 'wx' });
  let bytes = 0, head = Buffer.alloc(0), checked = false;
  const check = () => { if (!sniff(ext, head)) throw Object.assign(new Error(`That doesn't look like a .${ext} file.`), { status: 400 }); checked = true; };
  // Events rather than for-await: a refused upload stops being written but its rest still drains, so the page gets
  // the reason instead of a dropped connection.
  try {
    await new Promise((done, fail) => {
      let over = false;
      const stop = (e) => { if (over) return; over = true; req.removeListener('data', onData); req.resume(); fail(e); };
      const onData = (chunk) => {
        try {
          bytes += chunk.length;
          if (bytes > max) throw Object.assign(new Error(`That file is too big for ${k.label.toLowerCase()} (${Math.round(max / 1e6)} MB at most).`), { status: 413 });
          if (!checked) {
            head = Buffer.concat([head, chunk]);
            if (head.length < (ext === 'svg' ? 65536 : 64)) return;
            check(); chunk = head;
          }
          if (!out.write(chunk)) { req.pause(); out.once('drain', () => { if (!over) req.resume(); }); }
        } catch (e) { stop(e); }
      };
      req.on('data', onData);
      req.on('end', () => {
        if (over) return;
        try {
          if (!bytes) throw Object.assign(new Error('The file was empty.'), { status: 400 });
          if (!checked) { check(); out.write(head); }
          over = true; out.end(); once(out, 'finish').then(done, fail);
        } catch (e) { stop(e); }
      });
      req.on('error', stop);
      req.on('close', () => { if (!req.complete) stop(new Error('The upload stopped before the end.')); });
      out.on('error', stop);
    });
  } catch (e) {
    out.destroy();
    if (!out.closed) await new Promise((r) => out.once('close', r));
    rmSync(part, { force: true });
    throw e;
  }
  const file = freeName(dir, `${stem}.${ext}`);
  renameSync(part, join(dir, file));
  addIndexLine(`${kind}/${file}`, [String(note || '').trim() || k.one, 'uploaded in Video Octopus', today()].join(' · '));
  writeBrand({ quiet: true });
  return { file: `${kind}/${file}`, bytes, type: kindOfExt(ext) };
}

export function brandRemove(rel) {
  const p = brandPath(rel);
  if (!p || !existsSync(p)) throw new Error('That brand file is gone.');
  rmSync(p, { force: true });
  dropIndexLine(rel);
  writeBrand({ quiet: true });
  return { ok: true };
}

export function brandFiles() {
  const index = readIndex(), out = [];
  for (const kind of Object.keys(BRAND_KINDS)) {
    let names = [];
    try { names = readdirSync(join(brandDir(), kind)); } catch { continue; }
    for (const n of names) {
      if (n.startsWith('.') || n === 'INDEX.md' || n === 'README.md') continue;
      const ext = extname(n).slice(1).toLowerCase();
      if (!BRAND_KINDS[kind].ext.includes(ext)) continue;
      let st;
      try { st = statSync(join(brandDir(), kind, n)); } catch { continue; }
      if (!st.isFile()) continue;
      out.push({ file: `${kind}/${n}`, kind, name: n, bytes: st.size, at: st.mtimeMs, type: kindOfExt(ext), note: index.get(`${kind}/${n}`) || '' });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// A brand file for the page's thumbnails: never run as a page (SVG scripts stay off), with ranges for videos.
export function serveBrandFile(req, res, rel) {
  const p = brandPath(rel);
  let st = null;
  try { st = p && statSync(p); } catch {}
  if (!st?.isFile()) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"Not found"}'); }
  const head = { 'Content-Type': TYPES[extname(p).slice(1).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" };
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return createReadStream(p, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, 'Content-Length': st.size });
  createReadStream(p).pipe(res);
}

// ---- BRAND.md ----
const START = '<!-- studio:brand:start -->', END = '<!-- studio:brand:end -->';
export const brandMdPath = () => join(settings().studio, 'BRAND.md');

// The generated part, from the Setup answers (local/profile.json), Settings → Look's colours and fonts, and the files.
export function brandBlock() {
  const p = profile() || {}, look = section('look'), files = brandFiles();
  const studio = settings().studio;
  const where = (f) => { const abs = join(brandDir(), f); const r = relative(studio, abs); return (r && !r.startsWith('..') && !isAbsolute(r) ? r : abs).split('\\').join('/'); };
  const open = [];
  const text = (v, what) => { const t = String(v || '').trim(); if (!t) open.push(what); return t || '_Not answered yet._'; };
  const lines = [START, '_Written by Video Octopus from your Setup answers and brand files (change them in Settings → Brand). Your own notes go outside the two marker lines; Video Octopus keeps them._', ''];
  lines.push('## Who', text(p.who, 'who you are'), '');
  lines.push('## What they make', text(p.make, 'what you make'), '');
  lines.push('## Formats', p.formats?.length ? p.formats.map((f) => `- ${f}`).join('\n') : (open.push('your formats'), '_Not answered yet._'), '');
  lines.push('## Tone', text(p.tone, 'your tone'), '');
  lines.push('## Creators whose editing they like', text(p.creators, 'creators you like'), '');
  lines.push('## Colours');
  if (look.colors.length) lines.push(...look.colors.map((c, i) => `- \`${c}\`${i === 0 ? ' (main colour)' : ''}`));
  else { lines.push('_None picked yet._'); open.push('brand colours'); }
  if (p.brand) lines.push('', `In their words: ${p.brand.replace(/\s+/g, ' ').trim()}`);
  lines.push('', '## Fonts');
  const fonts = files.filter((f) => f.kind === 'fonts');
  if (look.fonts) lines.push(`- ${look.fonts}`);
  for (const f of fonts) lines.push(`- Font file: \`${where(f.file)}\``);
  if (!look.fonts && !fonts.length) { lines.push('_None picked yet: pick clean, readable ones and say which._'); open.push('fonts'); }
  lines.push('', '## Brand files');
  const groups = Object.entries(BRAND_KINDS).filter(([k]) => k !== 'fonts').map(([k, v]) => [v.label, files.filter((f) => f.kind === k)]);
  if (groups.some(([, list]) => list.length)) {
    for (const [label, list] of groups) if (list.length) lines.push(`- ${label}: ${list.map((f) => `\`${where(f.file)}\`${f.note && !/^(Logo|Photo|Product|Example)/.test(f.note) ? ` (${f.note.split(' · ')[0]})` : ''}`).join(', ')}`);
  } else { lines.push('_None uploaded yet._'); open.push('logo and brand files'); }
  lines.push('', '## How to use this',
    '- Titles, cards, lower thirds and end cards use these colours and fonts; the logo goes where a brand mark belongs (end card, corner bug), never stretched or recoloured.',
    '- Photos of the creator are for thumbnails and cut-outs; product images are real ones, never redrawn.',
    '- The examples show the look they like: take the pacing, framing and type from them, never their words or footage.',
    '- STYLE.md (when there is one) is the fuller style guide; memory/style.md and memory/preferences.md hold the lines added over time. Where they disagree, the newest dated line wins.');
  if (open.length) lines.push('', `Still open: ${open.join(', ')}. Ask the creator when it matters, or follow STYLE.md.`);
  lines.push(END);
  return { text: lines.join('\n'), open, files: files.length };
}

// Write (or update) <studio>/BRAND.md. quiet: only when it exists already or there's something to put in it.
export function writeBrand({ quiet = false } = {}) {
  if (!studioOk()) { if (quiet) return null; throw new Error('Create your studio first: BRAND.md goes into its folder.'); }
  const p = brandMdPath();
  const had = existsSync(p);
  const pr = profile() || {}, look = section('look');
  const anything = pr.who || pr.make || pr.tone || pr.creators || pr.brand || pr.formats?.length || look.colors.length || look.fonts || brandFiles().length;
  if (quiet && !had && !anything) return null;
  const block = brandBlock();
  const old = had ? readFileSync(p, 'utf8') : '';
  let next;
  if (had && old.includes(START) && old.includes(END) && old.indexOf(START) < old.indexOf(END)) {
    next = old.slice(0, old.indexOf(START)) + block.text + old.slice(old.indexOf(END) + END.length);
  } else if (had) {
    next = `${old.replace(/\n*$/, '\n')}\n${block.text}\n`; // a BRAND.md the creator wrote: theirs stays on top
  } else {
    next = `# Brand\n\nWho the creator is and how their videos look. Every agent in this studio reads this before planning or building anything (CLAUDE.md says so).\n\n${block.text}\n`;
  }
  if (next !== old) writeFileSync(p, next);
  return { path: p, shown: tildePath(p), created: !had, open: block.open, files: block.files };
}

// The answers or Settings → Look's colours and fonts changed (from any page, or the octopus command): BRAND.md follows.
onSettingsChange((what) => { if(settings().studio&&existsSync(join(settings().studio,'.studio/profile-storage.json')))return; if (what === 'look' || what === 'profile') { try { writeBrand({ quiet: true }); } catch (e) { console.error('BRAND.md:', e.message); } } });

// What Setup and Settings → Brand draw.
export function brandView() {
  const s = settings(), ok = studioOk();
  const md = ok ? brandMdPath() : null, style = ok ? join(s.studio, 'STYLE.md') : null;
  return { studio: ok, kinds: Object.entries(BRAND_KINDS).map(([key, v]) => ({ key, label: v.label, hint: v.hint, ext: v.ext, max: v.max })),
    files: ok ? brandFiles() : [], dir: ok ? tildePath(brandDir()) : null,
    brandMd: md && existsSync(md) ? tildePath(md) : null, styleMd: style && existsSync(style) ? tildePath(style) : null,
    look: { colors: section('look').colors, fonts: section('look').fonts } };
}

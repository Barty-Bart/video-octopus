// Generated visuals never run on the editor's origin. This service has no studio/API access:
// an unguessable, expiring capability grants only rendering assets beneath one real directory.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

const scopes = new Map();
const TTL = 60 * 60 * 1000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg' };
const bridge = readFileSync(new URL('./sandbox-scene-bridge.js', import.meta.url), 'utf8');
const backgroundBridge = readFileSync(new URL('./sandbox-background-bridge.js', import.meta.url), 'utf8');
let starting;

function permitted(rel) {
  if (!rel || rel.includes('\\') || rel.split('/').some((s) => !s || s.startsWith('.'))) return null;
  const ext = extname(rel).toLowerCase();
  return TYPES[ext] && !(ext === '.json' && !['work/overrides.json', 'work/production.json'].includes(rel) && !rel.startsWith('assets/'));
}
function asset(root, rel) {
  if (!permitted(rel)) return null;
  try {
    const file = realpathSync(resolve(root, rel)), within = relative(root, file);
    if (within.startsWith(`..${sep}`) || within === '..' || isAbsolute(within) || !permitted(within.split(sep).join('/')) || !statSync(file).isFile()) return null;
    return file;
  } catch { return null; }
}

function policy(prefix) {
  return `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${prefix}; style-src 'unsafe-inline' ${prefix}; img-src ${prefix} data: blob:; font-src ${prefix} data:; media-src ${prefix} blob:; connect-src ${prefix}; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
}
const encodePath = (p) => p.split(sep).map(encodeURIComponent).join('/');

// Only rewrite HTML start tags, never JavaScript/CSS strings or comments. No DOM parser or
// package is needed: HTML raw-text bodies end at their matching closing tag, even in a JS string.
function sceneHTML(source) {
  const injection = `<script>${bridge}</script>`;
  let out = '', at = 0, inserted = false, doctypeEnd = 0;
  while (at < source.length) {
    const start = source.indexOf('<', at);
    if (start < 0) { out += source.slice(at); break; }
    out += source.slice(at, start);
    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4), next = end < 0 ? source.length : end + 3;
      out += source.slice(start, next); at = next; continue;
    }
    let end = start + 1, quote = '';
    for (; end < source.length; end++) {
      const ch = source[end];
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') { end++; break; }
    }
    let tag = source.slice(start, end);
    const name = /^<([a-z][\w:-]*)\b/i.exec(tag)?.[1]?.toLowerCase();
    if (['img', 'script'].includes(name) && !/\bcrossorigin(?:\s|=|\/?>)/i.test(tag)) tag = tag.replace(/^<([\w:-]+)/, '$& crossorigin="anonymous"');
    out += tag; at = end;
    if (/^<!doctype\b/i.test(tag)) doctypeEnd = out.length;
    if (name === 'head' && !inserted) { out += injection; inserted = true; }
    if (['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes'].includes(name)) {
      const close = new RegExp(`</${name}\\s*>`, 'ig'); close.lastIndex = at;
      const found = close.exec(source), next = found ? close.lastIndex : source.length;
      out += source.slice(at, next); at = next;
    }
  }
  return inserted ? out : out.slice(0, doctypeEnd) + injection + out.slice(doctypeEnd);
}

export async function sandboxOrigin() {
  if (!starting) starting = new Promise((resolveOrigin, reject) => {
    const server = createServer((req, res) => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const rejectRequest = () => { res.writeHead(403, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' }); res.end('Unavailable rendering asset'); };
      // CORS is for opaque sandbox documents only. In particular, a trusted editor page may not
      // import a generated module into its own realm, even if it knows the capability URL.
      if (req.headers.host !== new URL(origin).host || !['GET', 'HEAD'].includes(req.method) || (req.headers.origin && req.headers.origin !== 'null')) return rejectRequest();
      if (['script', 'worker', 'sharedworker', 'serviceworker'].includes(req.headers['sec-fetch-dest']) && req.headers.origin !== 'null') return rejectRequest();
      let url, parts;
      try { url = new URL(req.url, origin); parts = url.pathname.split('/').slice(1).map(decodeURIComponent); } catch { return rejectRequest(); }
      const scope = scopes.get(parts.shift());
      if (!scope || scope.expires < Date.now()) return rejectRequest();
      scope.expires = Date.now() + TTL;
      const rel = parts.join('/'), wrapper = rel === '__octopus_background__.html' && scope.kind === 'background';
      const file = wrapper ? null : asset(scope.root, rel);
      const optional = ['work/overrides.json', 'work/production.json'].includes(rel);
      if (!wrapper && !file && !optional) return rejectRequest();
      const ext = wrapper ? '.html' : extname(rel).toLowerCase();
      const headers = { 'Content-Type': TYPES[ext], 'Content-Security-Policy': policy(scope.prefix), 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': 'null', 'Cross-Origin-Resource-Policy': 'cross-origin' };
      let data;
      if (!scope.direct && req.headers['sec-fetch-dest'] === 'document' && ['.html', '.htm', '.svg'].includes(ext)) {
        // A direct tab is also framed by trusted inert markup, so generated code never gains a
        // top-level browsing context or an unrestricted self-navigation path.
        const src = `${scope.prefix}${parts.map(encodeURIComponent).join('/')}${url.search}`.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        data = `<!doctype html><meta charset="utf-8"><title>Generated visual</title><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}iframe{display:block}</style><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="${src}" title="Generated visual"></iframe>`;
        headers['Content-Type'] = 'text/html; charset=utf-8';
        headers['Content-Security-Policy'] = `default-src 'none'; style-src 'unsafe-inline'; frame-src ${scope.prefix}; object-src 'none'; base-uri 'none'; form-action 'none'`;
        res.writeHead(200, { ...headers, 'Content-Length': Buffer.byteLength(data) }); return res.end(req.method === 'HEAD' ? undefined : data);
      }
      if (wrapper) data = `<!doctype html><meta charset="utf-8"><script>const OCTOPUS_MODULE=${JSON.stringify(scope.fileURL)};\n${bridge}\n${backgroundBridge}</script>`;
      else if (!file) data = 'null';
      else if (ext === '.html' || ext === '.htm') {
        // The bridge is independent of the copied kit version. Old projects keep working without
        // rewriting their files. Relative URLs retain the document's real project-relative base.
        data = sceneHTML(readFileSync(file, 'utf8'));
      }
      if (data !== undefined) { res.writeHead(200, { ...headers, 'Content-Length': Buffer.byteLength(data) }); return res.end(req.method === 'HEAD' ? undefined : data); }
      const size = statSync(file).size, range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (range) {
        const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
        if (start > end || start >= size) { res.writeHead(416, headers); return res.end(); }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
        return req.method === 'HEAD' ? res.end() : createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...headers, 'Content-Length': size });
      if (req.method === 'HEAD') return res.end();
      createReadStream(file).pipe(res);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.unref(); resolveOrigin(`http://127.0.0.1:${server.address().port}`); });
    const reap = setInterval(() => { for (const [key, value] of scopes) if (value.expires < Date.now()) scopes.delete(key); }, 60000); reap.unref();
  });
  return starting;
}

export async function createSceneSandbox({ file, root = dirname(file), kind = 'scene', search = '', direct = false }) {
  root = realpathSync(root);
  // Both paths may use an OS alias (for example macOS /var -> /private/var).
  const rel = relative(root, realpathSync(file));
  if (!asset(root, rel.split(sep).join('/'))) throw new Error('This file is outside the permitted rendering assets.');
  if (kind === 'background' && !/\.m?js$/i.test(file)) throw new Error('A code background must be a JavaScript module.');
  const origin = await sandboxOrigin(), token = randomBytes(24).toString('hex'), prefix = `${origin}/${token}/`;
  const fileURL = prefix + encodePath(rel);
  scopes.set(token, { root, prefix, fileURL, kind, direct, expires: Date.now() + TTL });
  return { url: (kind === 'background' ? `${prefix}__octopus_background__.html` : fileURL) + search, prefix, dispose: () => scopes.delete(token) };
}

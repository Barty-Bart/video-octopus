// Models from Hugging Face, for Setup's model rows: Whisper (faster-whisper or MLX, the transcription model) and SAM 2.1
// (transformers, object separation). For every model:
//   - where it comes from: its repo, the maker, the licence and the size of exactly the files Video Octopus downloads,
//     all read from Hugging Face's own API (never typed in here) and kept in local/hf-models.json with the date, so
//     Setup shows them offline too; with neither, the row says they couldn't be checked;
//   - whether it's downloaded: refs/main names a snapshot that has the files the library needs (a link into blobs that
//     leads nowhere doesn't count);
//   - the Download: into the Hugging Face cache, laid out the way huggingface_hub lays it out (blobs/<etag>,
//     snapshots/<commit>/<file> pointing at them, refs/main), so faster-whisper and transformers find it there. Each
//     file goes to blobs/<etag>.incomplete first, carries on from there after a break (HTTP Range), must have the size
//     and checksum Hugging Face lists (SHA-256 for the large files, git's blob id for the rest), and only then becomes
//     the blob. The weights come last, so a snapshot never has them before the files around them.
import { mkdirSync, statSync, renameSync, rmSync, createWriteStream, createReadStream, symlinkSync, copyFileSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { hfHub, readJSON, writeJSON, LOCAL_DIR } from './util.mjs';

// `files`: what Video Octopus downloads from a repo (Whisper: faster-whisper's own download list; SAM: the five files
// transformers reads, not the repo's original checkpoint). `need`: what a snapshot must have to count, plus a
// model's own `also` (large-v3 and distil-large-v3 carry a preprocessor_config.json with their 128 mel bins).
export const FAMILIES = {
  whisper: {
    label: 'Whisper', files: ['config.json', 'preprocessor_config.json', 'model.bin', 'tokenizer.json', 'vocabulary.*'],
    need: ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.*'],
    models: Object.fromEntries([
      ['large-v3', 'Systran/faster-whisper-large-v3', ['preprocessor_config.json']],
      // large-v3-turbo: the transcribe skill's faster-whisper conversion of it (transcribe.py fw_cached).
      ['large-v3-turbo', 'mobiuslabsgmbh/faster-whisper-large-v3-turbo', ['preprocessor_config.json']],
      ['distil-large-v3', 'Systran/faster-distil-whisper-large-v3', ['preprocessor_config.json']],
      ['medium', 'Systran/faster-whisper-medium'], ['medium.en', 'Systran/faster-whisper-medium.en'],
      ['small', 'Systran/faster-whisper-small'], ['small.en', 'Systran/faster-whisper-small.en'],
      ['base', 'Systran/faster-whisper-base'], ['base.en', 'Systran/faster-whisper-base.en'],
      ['tiny', 'Systran/faster-whisper-tiny'], ['tiny.en', 'Systran/faster-whisper-tiny.en'],
    ].map(([id, repo, also = []]) => [id, { repo, also }])),
  },
  // MLX Whisper (Apple Silicon): mlx-community's conversions, the same sizes. mlx_whisper loads a repo with
  // snapshot_download, which wants every file in it, so all of them come down (a config, the weights, two small texts).
  mlx: {
    label: 'MLX Whisper', files: ['*'], need: ['config.json', 'weights.*'],
    models: Object.fromEntries([['large-v3', 'mlx-community/whisper-large-v3-mlx'], ['large-v3-turbo', 'mlx-community/whisper-large-v3-turbo'], ['distil-large-v3', 'mlx-community/distil-whisper-large-v3'],
      ...['medium', 'medium.en', 'small', 'small.en', 'base', 'base.en', 'tiny', 'tiny.en'].map((id) => [id, `mlx-community/whisper-${id}-mlx`])]
      .map(([id, repo]) => [id, { repo, also: [] }])),
  },
  // Parakeet (parakeet-mlx, Apple Silicon): mlx-community's conversions of NVIDIA's Parakeet TDT. from_pretrained reads
  // config.json and model.safetensors. v2 is English only; v3 adds 24 more European languages.
  parakeet: {
    label: 'Parakeet', files: ['config.json', 'model.safetensors'], need: ['config.json', 'model.safetensors'],
    models: {
      'parakeet-tdt-0.6b-v2': { repo: 'mlx-community/parakeet-tdt-0.6b-v2', also: [] },
      'parakeet-tdt-0.6b-v3': { repo: 'mlx-community/parakeet-tdt-0.6b-v3', also: [] },
    },
  },
  sam2: {
    label: 'SAM 2.1', files: ['config.json', 'preprocessor_config.json', 'processor_config.json', 'video_preprocessor_config.json', 'model.safetensors'],
    need: ['config.json', 'preprocessor_config.json', 'processor_config.json', 'video_preprocessor_config.json', 'model.safetensors'],
    models: {
      tiny: { repo: 'facebook/sam2.1-hiera-tiny', also: [] },
      'base-plus': { repo: 'facebook/sam2.1-hiera-base-plus', also: [] },
      large: { repo: 'facebook/sam2.1-hiera-large', also: [] },
    },
  },
};

const endpoint = () => (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
export const repoDir = (repo) => join(hfHub(), `models--${repo.replace('/', '--')}`);
const glob = (p) => new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
const sizeOf = (p) => { try { return statSync(p).size; } catch { return -1; } };
// 323 MB, 1.5 GB: decimal, like Hugging Face shows sizes.
export const fmtBytes = (n) => (!(n >= 0) ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(n >= 10e9 ? 0 : 1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);

// ---- downloaded? ----
export function downloaded(family) {
  const F = FAMILIES[family];
  return Object.entries(F.models).filter(([, m]) => {
    const dir = repoDir(m.repo);
    let rev = '';
    try { rev = readFileSync(join(dir, 'refs', 'main'), 'utf8').trim(); } catch { return false; }
    if (!/^[0-9a-f]{40}$/.test(rev)) return false;
    let names = [];
    try { names = readdirSync(join(dir, 'snapshots', rev)); } catch { return false; }
    return [...F.need, ...m.also].every((p) => names.some((n) => glob(p).test(n) && sizeOf(join(dir, 'snapshots', rev, n)) > 0));
  }).map(([id]) => id);
}

// ---- where each model comes from (Hugging Face's API), cached in local/hf-models.json ----
const CACHE = () => join(LOCAL_DIR, 'hf-models.json');
const DAY = 24 * 3600e3;
const readCache = () => { const c = readJSON(CACHE(), null); return c && typeof c === 'object' && c.repos ? c : { repos: {}, makers: {} }; };
const getJSON = async (url, signal) => {
  const r = await fetch(url, { signal: signal || AbortSignal.timeout(8000), headers: { 'User-Agent': 'Video Octopus', Accept: 'application/json' } });
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  return r.json();
};

// The repo now: its commit, maker, licence and the files Video Octopus downloads (name, size, etag, sha256).
async function repoInfo(repo, family, signal) {
  const F = FAMILIES[family], ep = endpoint();
  const d = await getJSON(`${ep}/api/models/${repo}/revision/main?blobs=true`, signal);
  if (!/^[0-9a-f]{40}$/.test(d?.sha || '')) throw new Error(`no commit for ${repo}`);
  const files = (d.siblings || []).filter((s) => F.files.some((p) => glob(p).test(s.rfilename))).map((s) => {
    const sha256 = s.lfs?.sha256 || null, etag = sha256 || s.blobId, size = Number(s.lfs?.size ?? s.size);
    if (!/^[0-9a-f]{40,64}$/.test(etag || '') || !(size > 0)) throw new Error(`no size or checksum for ${s.rfilename}`);
    return { name: s.rfilename, size, etag, sha256 };
  });
  const card = d.cardData || {};
  const license = card.license === 'other' ? card.license_name || 'other' : card.license || (d.tags || []).find((t) => t.startsWith('license:'))?.slice(8) || null;
  return { repo, author: d.author || repo.split('/')[0], license, sha: d.sha, files, bytes: files.reduce((n, f) => n + f.size, 0) };
}

// The maker's name as Hugging Face shows it (an organisation's or a user's full name), else the account name.
async function makerName(author, signal) {
  const ep = endpoint();
  for (const kind of ['organizations', 'users']) {
    try { const o = await getJSON(`${ep}/api/${kind}/${encodeURIComponent(author)}/overview`, signal); if (o?.fullname) return o.fullname; }
    catch (e) { if (e.status !== 404) throw e; }
  }
  return author;
}

const inflight = new Map();
// Fresh info for one repo (and the cache updated), or the error.
async function refresh(repo, family) {
  if (inflight.has(repo)) return inflight.get(repo);
  const p = (async () => {
    const info = await repoInfo(repo, family);
    const cache = readCache();
    const maker = cache.makers?.[info.author]?.name && Date.now() - Date.parse(cache.makers[info.author].fetched) < DAY
      ? cache.makers[info.author].name : await makerName(info.author);
    const now = new Date().toISOString();
    const c = readCache(); // read again: another repo may have been written meanwhile
    c.repos[repo] = { ...info, maker, fetched: now };
    c.makers = { ...(c.makers || {}), [info.author]: { name: maker, fetched: now } };
    writeJSON(CACHE(), c);
    return c.repos[repo];
  })().finally(() => inflight.delete(repo));
  inflight.set(repo, p);
  return p;
}

// What a row shows for one model: { repo, url, maker, license, bytes, size, checked (date), from: 'hub' | 'cache',
// error }. Without fresh info and without a cache: the link, and why the rest couldn't be checked.
const view = (repo, c, from, error = null) => ({
  repo, url: `https://huggingface.co/${repo}`,
  ...(c ? { maker: c.maker, author: c.author, license: c.license, bytes: c.bytes, size: fmtBytes(c.bytes), files: c.files.map((f) => f.name), checked: String(c.fetched).slice(0, 10),
    stale: from === 'cache' && !(Date.now() - Date.parse(c.fetched) < DAY) } : {}),
  from: c ? from : null, error,
});

// Every model of a family: from the cache when it's under a day old, else asked again (all at once); a failed ask
// falls back to the cache, however old. `cached: true` never asks (for pages that must answer at once).
export async function sources(family, { cached = false, fresh = false } = {}) {
  const cache = readCache(), out = {};
  await Promise.all(Object.entries(FAMILIES[family].models).map(async ([id, m]) => {
    const c = cache.repos[m.repo];
    if (cached || (!fresh && c && Date.now() - Date.parse(c.fetched) < DAY)) { out[id] = view(m.repo, c, 'cache', c ? null : 'not checked yet'); return; }
    try { out[id] = view(m.repo, await refresh(m.repo, family), 'hub'); }
    catch (e) { out[id] = view(m.repo, c, 'cache', e.status ? `Hugging Face answered ${e.message}` : `couldn't reach Hugging Face (${e.cause?.code || e.cause?.message || e.message})`); }
  }));
  return out;
}

// One line, the same everywhere (Setup, Settings, the chats): "From Hugging Face · <repo> (<maker>) · <size> ·
// licence: <licence>"; offline from the cache, the date it was checked; never a value Hugging Face didn't give.
export function sourceLine(s) {
  if (!s?.size) return `From Hugging Face · ${s.repo} · ${s.error === 'not checked yet' ? 'size and licence not checked yet (Setup checks them)' : `size and licence couldn't be checked${s.error ? ` (${s.error})` : ''}`}`;
  return `From Hugging Face · ${s.repo}${s.maker ? ` (${s.maker})` : ''} · ${s.size} · licence: ${s.license || 'not stated'}${s.error || s.stale ? ` · as checked on ${s.checked}` : ''}`;
}

// ---- the download: one at a time per family, in the background; the page polls downloadState() ----
const jobs = new Map(); // family -> job
export const downloadsBusy = () => [...jobs.values()].some((j) => j.state === 'downloading');
const jobView = (j) => (j ? { state: j.state, size: j.size, got: j.got, total: j.total, from: j.from, error: j.error || null, cache: hfHub() } : { state: 'idle', cache: hfHub() });
export const downloadState = (family) => jobView(jobs.get(family));
const mbOf = (n) => fmtBytes(Math.max(0, n));

export function startDownload(family, size) {
  const m = FAMILIES[family]?.models[size];
  if (!m) throw new Error(`Unknown model: ${size}.`);
  const cur = jobs.get(family);
  if (cur?.state === 'downloading') {
    if (cur.size === size) return jobView(cur);
    throw new Error(`The ${cur.size} model is downloading already.`);
  }
  const j = { size, state: 'downloading', got: 0, total: 0, from: 0, ctrl: new AbortController() };
  jobs.set(family, j);
  j.promise = fetchModel(j, family, m).then(() => { j.state = 'done'; }, (e) => {
    j.state = j.ctrl.signal.reason === 'stopped' ? 'stopped' : 'error';
    j.error = j.state === 'stopped' ? 'Stopped. Download carries on from where it stopped.' : e.message;
  });
  return jobView(j);
}

export function stopDownload(family) {
  const j = jobs.get(family);
  if (j?.state === 'downloading') j.ctrl.abort('stopped');
  return jobView(j);
}

async function fetchModel(j, family, m) {
  const F = FAMILIES[family], dir = repoDir(m.repo), ep = endpoint();
  let info;
  try { info = await repoInfo(m.repo, family, AbortSignal.any([j.ctrl.signal, AbortSignal.timeout(30000)])); }
  catch (e) { throw new Error(`Couldn't get the file list of ${m.repo} from Hugging Face (${e.cause?.message || e.message}).`); }
  for (const p of [...F.need, ...m.also]) if (!info.files.some((f) => glob(p).test(f.name))) throw new Error(`${m.repo} on Hugging Face has no ${p}.`);
  // Keep what was learnt for the source line too.
  try { const c = readCache(); c.repos[m.repo] = { ...info, maker: c.repos[m.repo]?.maker || c.makers?.[info.author]?.name || info.author, fetched: new Date().toISOString() }; writeJSON(CACHE(), c); } catch {}
  const files = [...info.files].sort((a, b) => a.size - b.size).map((f) => ({ ...f, blob: join(dir, 'blobs', f.etag) })); // the weights last
  j.total = info.bytes;
  j.from = j.got = files.reduce((n, f) => n + (sizeOf(f.blob) === f.size ? f.size : Math.max(0, Math.min(sizeOf(`${f.blob}.incomplete`), f.size))), 0);
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  for (const f of files) {
    if (sizeOf(f.blob) !== f.size) await fetchFile(j, `${ep}/${m.repo}/resolve/${info.sha}/${f.name}`, f);
    // The snapshot's pointer, as huggingface_hub makes it: a relative link to the blob (a copy where links aren't allowed).
    const ptr = join(dir, 'snapshots', info.sha, f.name);
    mkdirSync(join(ptr, '..'), { recursive: true });
    if (sizeOf(ptr) !== f.size) {
      rmSync(ptr, { force: true });
      try { symlinkSync(join('..', '..', 'blobs', f.etag), ptr); } catch { copyFileSync(f.blob, ptr); }
    }
  }
  mkdirSync(join(dir, 'refs'), { recursive: true });
  writeFileSync(join(dir, 'refs', 'main'), info.sha);
  j.got = j.total;
}

// One file into blobs/<etag>: SHA-256 for a large (LFS) file, git's blob id (sha1 of "blob <size>\0" + the bytes) for
// the rest, the same checks Hugging Face's own etags allow.
async function fetchFile(j, url, f) {
  const part = `${f.blob}.incomplete`;
  let have = sizeOf(part);
  if (have >= f.size) { rmSync(part, { force: true }); have = -1; } // too big to be the start of this file
  const before = Math.max(0, have);
  const newHash = () => { const h = createHash(f.sha256 ? 'sha256' : 'sha1'); if (!f.sha256) h.update(`blob ${f.size}\0`); return h; };
  let hash = newHash();
  // No data for a minute: give up (the .incomplete file stays, so Download carries on from there).
  const idle = setTimeout(() => j.ctrl.abort(new Error('no data for a minute')), 60000);
  try {
    // identity: the bytes as stored (a compressed reply would have another length), as huggingface_hub asks too.
    const r = await fetch(url, { signal: j.ctrl.signal, headers: { 'User-Agent': 'Video Octopus', 'Accept-Encoding': 'identity', ...(have > 0 ? { Range: `bytes=${have}-` } : {}) } });
    let append = false, total;
    if (r.status === 206) {
      const m = /^bytes (\d+)-\d+\/(\d+)$/.exec(r.headers.get('content-range') || '');
      if (!m || Number(m[1]) !== have) throw new Error('the server sent another part of the file than asked for');
      total = Number(m[2]); append = true;
    } else if (r.status === 200) {
      const len = r.headers.get('content-length'); // a server that ignores Range sends it all: start over
      total = len === null ? f.size : Number(len);  // no length given: the byte count is checked at the end
      j.got -= before;
    } else if (r.status === 416) {
      rmSync(part, { force: true });
      throw new Error('the part downloaded before doesn\'t fit the file any more: press Download to start again');
    } else throw new Error(`HTTP ${r.status} for ${f.name}`);
    // The size check, before anything is written: the file on offer must be the size Hugging Face lists for it.
    if (total !== f.size) {
      rmSync(part, { force: true });
      throw new Error(`${f.name} came as ${Number.isFinite(total) ? `${total} bytes` : 'a file of unknown size'}, but it is ${f.size} bytes`);
    }
    if (append) await pipeline(createReadStream(part), new Transform({ transform(c, _, done) { hash.update(c); done(); } }));
    let got = append ? have : 0;
    const count = new Transform({
      transform(chunk, _, done) {
        got += chunk.length; j.got += chunk.length; hash.update(chunk);
        idle.refresh();
        done(got > f.size ? new Error('the server sent more than the file\'s size') : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(r.body), count, createWriteStream(part, { flags: append ? 'a' : 'w' }));
    if (got !== f.size) throw new Error(`${f.name} stopped at ${mbOf(got)} of ${mbOf(f.size)}`);
  } catch (e) {
    const why = j.ctrl.signal.aborted && j.ctrl.signal.reason instanceof Error ? j.ctrl.signal.reason.message : e.cause?.message || e.message;
    const kept = sizeOf(part);
    throw new Error(`Download stopped (${why}).${kept > 0 ? ` ${mbOf(j.got)} of ${mbOf(j.total)} kept: Download carries on from there.` : ''}`);
  } finally { clearTimeout(idle); }
  // Whole: every byte, and the checksum Hugging Face lists. Only then is it the blob.
  if (hash.digest('hex') !== f.etag) {
    rmSync(part, { force: true }); j.got -= f.size;
    throw new Error(`${f.name} didn't match its checksum: nothing was kept. Press Download to try again.`);
  }
  renameSync(part, f.blob);
}

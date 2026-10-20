// Object separation's models: Meta's SAM 2.1 in Hugging Face's format, which the object-separation skill loads with
// transformers (Sam2VideoModel / Sam2VideoProcessor, from_pretrained with local_files_only, so it never downloads by
// itself). Three sizes; Setup recommends one for this computer and the creator can pick another (Settings → Rendering
// → Object separation; "auto" = the recommended one), the way Whisper models work.
// The Download button fetches the picked model into the Hugging Face cache, laid out the way huggingface_hub lays it
// out (blobs/<etag>, snapshots/<commit>/<file> pointing at them, refs/main), so from_pretrained finds it there: only the
// five files transformers needs, not the repo's original checkpoint. Each file goes to blobs/<etag>.incomplete first,
// carries on from there after a break (HTTP Range), must have its exact size (and, for the weights, its SHA-256), and
// only then becomes the blob; a model counts as downloaded only when refs/main names a snapshot with all five files.
import { mkdirSync, statSync, renameSync, rmSync, createWriteStream, createReadStream, symlinkSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { hfHub, IS_MAC } from './util.mjs';

// Sizes are the weights (model.safetensors) on the hub. Speed: Meta's own figures for SAM 2.1 (frames a second on one
// GPU: tiny 91, base-plus 64, large 40), as the time against tiny's.
export const SAM2_MODELS = {
  tiny: { repo: 'facebook/sam2.1-hiera-tiny', mb: '156 MB', speed: 'the fastest; edges a little rougher', for: 'computers without a GPU' },
  'base-plus': { repo: 'facebook/sam2.1-hiera-base-plus', mb: '323 MB', speed: 'about 1.4× tiny\'s time; clean edges', for: 'Apple Silicon and NVIDIA cards under 12 GB' },
  large: { repo: 'facebook/sam2.1-hiera-large', mb: '898 MB', speed: 'about 2.3× tiny\'s time; the most exact', for: 'NVIDIA cards with 12 GB or more' },
};
export const SAM2_SIZES = Object.keys(SAM2_MODELS);
export const SAM2_FILES = ['config.json', 'preprocessor_config.json', 'processor_config.json', 'video_preprocessor_config.json', 'model.safetensors'];
const endpoint = () => (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
const repoDir = (repo) => join(hfHub(), `models--${repo.replace('/', '--')}`);

// The recommendation (the skill's own table): NVIDIA 12 GB+ → large, a smaller NVIDIA card or Apple Silicon →
// base-plus, no GPU → tiny (it works, but takes seconds a frame).
export function sam2Recommend({ device, vramGB, gpu } = {}) {
  if (device === 'cuda') {
    const v = Number(vramGB) || 0;
    return { size: v >= 12 ? 'large' : 'base-plus', slow: false, why: `${gpu || 'an NVIDIA card'}${v ? ` with ${Math.round(v)} GB` : ''}` };
  }
  if (device === 'mps') return { size: 'base-plus', slow: false, why: 'Apple Silicon' };
  return { size: 'tiny', slow: true, why: 'no GPU it can use (the CPU)' };
}

// The device from the hardware alone (before torch is installed, or for Settings): Apple Silicon, an NVIDIA card, the CPU.
export const sam2Machine = (mac = {}) => ({ device: IS_MAC && /apple/i.test(mac.chip || '') ? 'mps' : mac.gpu ? 'cuda' : 'cpu', vramGB: mac.vramGB, gpu: mac.gpu });

// Downloaded models, found the way transformers finds them (from_pretrained, revision main): refs/main names a
// snapshot that has all five files (a link into blobs that leads nowhere doesn't count).
export function sam2Have() {
  return SAM2_SIZES.filter((size) => {
    const dir = repoDir(SAM2_MODELS[size].repo);
    let rev = '';
    try { rev = readFileSync(join(dir, 'refs', 'main'), 'utf8').trim(); } catch { return false; }
    return /^[0-9a-f]{40}$/.test(rev) && SAM2_FILES.every((f) => sizeOf(join(dir, 'snapshots', rev, f)) > 0);
  });
}

// ---- the download: one at a time, in the background; the page polls sam2Download() ----
let job = null;
const view = (j) => (j ? { state: j.state, size: j.size, got: j.got, total: j.total, from: j.from, error: j.error || null, cache: hfHub() } : { state: 'idle', cache: hfHub() });
export const sam2Download = () => view(job);
const sizeOf = (p) => { try { return statSync(p).size; } catch { return -1; } };
const mbOf = (n) => `${Math.max(0, Math.round(n / 1e6))} MB`;

export function startSam2Download(size) {
  if (!SAM2_MODELS[size]) throw new Error(`Unknown model: ${size}.`);
  if (job?.state === 'downloading') {
    if (job.size === size) return view(job);
    throw new Error(`The ${job.size} model is downloading already.`);
  }
  job = { size, state: 'downloading', got: 0, total: 0, from: 0, ctrl: new AbortController() };
  const j = job;
  j.promise = fetchModel(j).then(() => { j.state = 'done'; }, (e) => {
    j.state = j.ctrl.signal.reason === 'stopped' ? 'stopped' : 'error';
    j.error = j.state === 'stopped' ? 'Stopped. Download carries on from where it stopped.' : e.message;
  });
  return view(j);
}

export function stopSam2Download() {
  if (job?.state === 'downloading') job.ctrl.abort('stopped');
  return view(job);
}

async function fetchModel(j) {
  const { repo } = SAM2_MODELS[j.size], dir = repoDir(repo), ep = endpoint();
  // What's on the hub now: the commit, and each file's size and etag (the SHA-256 for the weights, git's id for the rest).
  let info;
  try {
    const r = await fetch(`${ep}/api/models/${repo}/revision/main?blobs=true`, { signal: AbortSignal.any([j.ctrl.signal, AbortSignal.timeout(30000)]), headers: { 'User-Agent': 'Video Octopus' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    info = await r.json();
  } catch (e) { throw new Error(`Couldn't reach Hugging Face for ${repo} (${e.cause?.message || e.message}).`); }
  if (!/^[0-9a-f]{40}$/.test(info?.sha || '')) throw new Error(`Hugging Face gave no commit for ${repo}.`);
  const files = SAM2_FILES.map((name) => {
    const s = (info.siblings || []).find((x) => x.rfilename === name);
    const sha256 = s?.lfs?.sha256 || null, etag = sha256 || s?.blobId, bytes = Number(s?.lfs?.size ?? s?.size);
    if (!s || !/^[0-9a-f]{40,64}$/.test(etag || '') || !(bytes > 0)) throw new Error(`${repo} on Hugging Face has no ${name} (or no size for it).`);
    return { name, etag, sha256, bytes, blob: join(dir, 'blobs', etag) };
  });
  j.total = files.reduce((n, f) => n + f.bytes, 0);
  j.from = j.got = files.reduce((n, f) => n + (sizeOf(f.blob) === f.bytes ? f.bytes : Math.max(0, Math.min(sizeOf(`${f.blob}.incomplete`), f.bytes))), 0);
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  for (const f of files) {
    if (sizeOf(f.blob) !== f.bytes) await fetchFile(j, `${ep}/${repo}/resolve/${info.sha}/${f.name}`, f);
    // The snapshot's pointer, as huggingface_hub makes it: a relative link to the blob (a copy where links aren't allowed).
    const ptr = join(dir, 'snapshots', info.sha, f.name);
    mkdirSync(join(ptr, '..'), { recursive: true });
    if (sizeOf(ptr) !== f.bytes) {
      rmSync(ptr, { force: true });
      try { symlinkSync(join('..', '..', 'blobs', f.etag), ptr); } catch { copyFileSync(f.blob, ptr); }
    }
  }
  mkdirSync(join(dir, 'refs'), { recursive: true });
  writeFileSync(join(dir, 'refs', 'main'), info.sha);
  j.got = j.total;
}

async function fetchFile(j, url, f) {
  const part = `${f.blob}.incomplete`;
  let have = sizeOf(part);
  if (have >= f.bytes) { rmSync(part, { force: true }); have = -1; } // too big to be the start of this file
  const before = Math.max(0, have);
  const hash = f.sha256 ? createHash('sha256') : null;
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
      total = len === null ? f.bytes : Number(len);  // no length given: the byte count is checked at the end
      j.got -= before;
    } else if (r.status === 416) {
      rmSync(part, { force: true });
      throw new Error('the part downloaded before doesn\'t fit the file any more: press Download to start again');
    } else throw new Error(`HTTP ${r.status} for ${f.name}`);
    // The size check, before anything is written: the file on offer must be the size Hugging Face lists for it.
    if (total !== f.bytes) {
      rmSync(part, { force: true });
      throw new Error(`${f.name} came as ${Number.isFinite(total) ? `${total} bytes` : 'a file of unknown size'}, but it is ${f.bytes} bytes`);
    }
    if (append && hash) await pipeline(createReadStream(part), new Transform({ transform(c, _, done) { hash.update(c); done(); } }));
    let got = append ? have : 0;
    const count = new Transform({
      transform(chunk, _, done) {
        got += chunk.length; j.got += chunk.length; hash?.update(chunk);
        idle.refresh();
        done(got > f.bytes ? new Error('the server sent more than the file\'s size') : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(r.body), count, createWriteStream(part, { flags: append ? 'a' : 'w' }));
    if (got !== f.bytes) throw new Error(`${f.name} stopped at ${mbOf(got)} of ${mbOf(f.bytes)}`);
  } catch (e) {
    const why = j.ctrl.signal.aborted && j.ctrl.signal.reason instanceof Error ? j.ctrl.signal.reason.message : e.cause?.message || e.message;
    const kept = sizeOf(part);
    throw new Error(`Download stopped (${why}).${kept > 0 ? ` ${mbOf(j.got)} of ${mbOf(j.total)} kept: Download carries on from there.` : ''}`);
  } finally { clearTimeout(idle); }
  // Whole: every byte, and the weights' SHA-256 is the one Hugging Face lists. Only then is it the blob.
  if (hash) {
    const sum = hash.digest('hex');
    if (sum !== f.sha256) { rmSync(part, { force: true }); j.got -= f.bytes; throw new Error(`${f.name} didn't match its checksum (SHA-256): nothing was kept. Press Download to try again.`); }
  }
  renameSync(part, f.blob);
}

// Sound: the project's sound cues (work/sfx.json) and how they're mixed into an export, plus the
// "Find a sound" brief for Claude. A cue is a library sound placed at a moment of the canvas take:
// {id, t (seconds on the take, before the cut), file, from "library"|"project", gain (dB on top of the
// default level), label}. The export maps t through the locked cut and mixes each cue so its loudest
// part sits under the voice by Settings → Sound's "Effects under the voice" (underVoiceDb), then adds the cue's own gain.
// The canvas preview plays each cue at the same level (cueMix), and Claude is told the same number (settings.mjs).
import { existsSync, readdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readJSON, writeJSON, inside, mtime, settings, studioTool, expandHome } from './util.mjs';
import { libraryDir, NEW_SOUNDS, AUDIO, soundCatalogContext } from './library.mjs';

const CUES = 'work/sfx.json';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// How far under the voice an effect's loudest part sits, in dB: Settings → Sound (18 by default). One level for the
// export, the canvas preview, the Layers and timeline files, and Claude's renders.
export function underVoiceDb() {
  const v = Number(settings()?.sound?.fxDb);
  return Number.isFinite(v) ? clamp(Math.abs(v), 0, 40) : 18;
}
// The gain (dB) a cue's file gets in the mix: its loudest part under the voice's speech level (ref, dBFS), plus its own.
export const cueGain = (dir, c, ref) => clamp((ref ?? -24) - underVoiceDb() - (level(cuePath(dir, c), 'loud') ?? -12) + c.gain, -60, 18);
// For the canvas preview: each cue's gain against the take's voice as the export measures it (the preview plays the
// take's sound at its own level, so the cue at this gain sits where the export puts it).
export function cueMix(dir, cues, voicePath) {
  const ref = voicePath && existsSync(voicePath) ? level(voicePath, 'speech') : null;
  return cues.map((c) => { const p = cuePath(dir, c); return p && existsSync(p) ? Math.round(cueGain(dir, c, ref) * 10) / 10 : null; });
}

const norm = (c) => {
  const file = String(c.file || '');
  return { id: String(c.id || randomBytes(4).toString('hex')), t: Math.max(0, Number(c.t) || 0), file,
    from: c.from === 'project' ? 'project' : 'library', gain: clamp(Number(c.gain) || 0, -24, 12),
    label: String(c.label || basename(file, extname(file))), ...(c.by === 'hand' ? { by: 'hand' } : {}) };
};

export function readCues(dir) {
  const j = readJSON(join(dir, CUES), null);
  const list = Array.isArray(j) ? j : Array.isArray(j?.cues) ? j.cues : [];
  return list.filter((c) => c && c.file && Number.isFinite(Number(c.t))).map(norm).sort((a, b) => a.t - b.t);
}

function writeCues(dir, cues) {
  writeJSON(join(dir, CUES), {
    v: 1,
    about: `t = seconds on the canvas take (before the cut; the export maps it through the locked cut). file = a path in the studio library (from "library") or in the project (from "project"). gain = dB on top of the default level, which puts the sound's loudest part about ${underVoiceDb()} dB under the voice (Settings → Sound). by "hand" = placed in Video Octopus; a cue without it inside a built block (the Intro) goes with that block's graphics: Export → Video mixes it only when the block's render is in the video.`,
    cues: cues.sort((a, b) => a.t - b.t),
  });
  return cues;
}

export function cuePath(dir, c) {
  return c.from === 'project' ? inside(dir, c.file) : inside(libraryDir(), c.file);
}

// add {file, from, t, gain, label} · update {id, t?, gain?} · remove {id}
export function cueOp(dir, b) {
  const cues = readCues(dir);
  if (b.op === 'add') {
    // by "hand": placed in Video Octopus (the Sound panel, the timeline), so it stays in an export whatever the picture is
    // there; Claude's cues inside a built block go with its graphics (server/built.mjs).
    const c = norm({ file: b.file, from: b.from, t: b.t, gain: b.gain, label: b.label, by: 'hand' });
    if (!c.file || !AUDIO.test(c.file)) throw new Error('Pick a sound file.');
    const p = cuePath(dir, c);
    if (!p || !existsSync(p)) throw new Error('That sound is not in the library.');
    cues.push(c);
    return { cues: writeCues(dir, cues), id: c.id };
  }
  // set {cues}: the whole list at once (the timeline's undo, multi-cue moves). Cues whose file is gone are left out.
  if (b.op === 'set') {
    if (!Array.isArray(b.cues)) throw new Error('No cues to set.');
    const list = b.cues.map(norm).filter((c) => AUDIO.test(c.file) && existsSync(cuePath(dir, c) || ''));
    return { cues: writeCues(dir, list) };
  }
  const i = cues.findIndex((c) => c.id === String(b.id));
  if (i < 0) throw new Error('That sound cue is gone.');
  if (b.op === 'remove') { cues.splice(i, 1); return { cues: writeCues(dir, cues) }; }
  if (b.op === 'update') {
    const c = cues[i];
    if (b.t != null) c.t = Math.max(0, Number(b.t) || 0);
    if (b.gain != null) c.gain = clamp(Number(b.gain) || 0, -24, 12);
    if (typeof b.label === 'string') c.label = b.label.slice(0, 80);
    return { cues: writeCues(dir, cues) };
  }
  throw new Error('Unknown cue action');
}

// ---- levels (RMS in dBFS), cached until the file changes ----
const levels = new Map();
// mode "speech": RMS of the voice while it talks (50 ms windows within 30 dB of the loudest one, so pauses
// in a raw take don't count); mode "loud": RMS of the loudest 200 ms (a sound effect). Both as the stereo mix plays them
// (a mono camera mic or effect is spread over two channels there, 3 dB down in each), so a cue lands exactly
// Settings → Sound's level under the voice whatever their channels.
export function level(path, mode) {
  const key = `${path}:${mtime(path)}:${mode}`;
  if (levels.has(key)) return levels.get(key);
  // Full band for effects (their air and hiss count); the voice at 24 kHz is enough and keeps long takes quick.
  const SR = mode === 'speech' ? 24000 : 48000;
  const r = spawnSync(studioTool('ffmpeg'), ['-v', 'error', '-i', path, '-vn', '-ac', '2', '-ar', String(SR), '-f', 's16le', 'pipe:1'],
    { maxBuffer: 1.5e9, timeout: 60000 });
  const buf = r.stdout;
  if (!buf || buf.length < 4) return null;
  const n = Math.floor(buf.length / 2);
  let db;
  if (mode === 'speech') {
    const win = (SR / 20) * 2, ms = []; // (two channels, interleaved)
    for (let a = 0; a + win <= n; a += win) {
      let sum = 0;
      for (let i = a; i < a + win; i++) { const v = buf.readInt16LE(i * 2) / 32768; sum += v * v; }
      ms.push(sum / win);
    }
    const top = Math.max(...ms, 1e-12), gate = Math.max(top * 1e-3, 1e-6); // -30 dB under the loudest, and above -60 dBFS
    const on = ms.filter((x) => x >= gate);
    db = 10 * Math.log10((on.length ? on.reduce((t, x) => t + x, 0) / on.length : top) + 1e-12);
  } else {
    const win = (SR / 5) * 2, hop = (SR / 50) * 2;
    const sq = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2) / 32768; sq[i + 1] = sq[i] + v * v; }
    let best = 0;
    for (let a = 0; a + Math.min(win, n) <= n; a += hop) best = Math.max(best, (sq[Math.min(n, a + win)] - sq[a]) / Math.min(win, n));
    db = 10 * Math.log10(best + 1e-12);
  }
  levels.set(key, db);
  return db;
}

// A moment on the take → the same moment in the export. On a cut, a cue in a removed part moves to the
// join after it (a whoosh on a cut stays on that cut); one after the last kept part is dropped.
export function toOutput(t, segs) {
  if (!segs) return t;
  let acc = 0;
  for (const [a, b] of segs) {
    if (t < a) return acc;
    if (t < b) return acc + (t - a);
    acc += b - a;
  }
  return null;
}

// Hook for the export (server/export.mjs): adds the cues' inputs and filters to the ffmpeg graph and
// returns the label of the finished sound ([aout] untouched when there are no cues, null for no sound).
// f = filter list, input = adds an ffmpeg input and returns its index, segs = the cut (source seconds) or
// null, total = export length, voice = label of the voice track or null, voiceFile = its file in source/.
// skip(cue): a cue to leave out (the graphics cues of a built block whose render isn't in the export, server/built.mjs).
export function mixCues(dir, { f, input, segs, total, voice, voiceFile, range, skip }) {
  const placed = [];
  for (const c of readCues(dir)) {
    if (range && (c.t < range[0] || c.t >= range[1])) continue; // a block export mixes each part of the take on its own
    if (skip?.(c)) continue;
    const p = cuePath(dir, c);
    if (!p || !existsSync(p)) continue;
    const at = toOutput(c.t, segs);
    if (at == null || at > total - 0.05) continue;
    placed.push({ c, p, at });
  }
  if (!placed.length) return { label: voice, cues: 0 };
  const ref = (voiceFile ? level(join(dir, 'source', voiceFile), 'speech') : null) ?? -24;
  const labels = placed.map(({ c, p, at }, i) => {
    const k = input(['-i', p]);
    const vol = cueGain(dir, c, ref);
    const ms = Math.round(at * 1000);
    f.push(`[${k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${vol.toFixed(2)}dB,adelay=delays=${ms}:all=1[q${i}]`);
    return `[q${i}]`;
  });
  let base = voice;
  if (!base) { f.push(`anullsrc=r=48000:cl=stereo,atrim=0:${total.toFixed(3)}[qbase]`); base = '[qbase]'; }
  // The voice comes first and sets the length; normalize=0 keeps it at its own level. The limiter only
  // catches overs where an effect lands on a loud word (level=0: no automatic gain; latency=1: no delay, so sound stays in sync with the picture).
  f.push(`${base}${labels.join('')}amix=inputs=${labels.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.97:level=0:latency=1[qmix]`);
  return { label: '[qmix]', cues: placed.length };
}

// ---- Find a sound: the brief for Claude (the project's chat, or the Library's) ----
function designScript() {
  const s = settings();
  if (s.sfxScript && existsSync(expandHome(s.sfxScript))) return expandHome(s.sfxScript);
  const tries = [join(s.studio, 'tools', 'sfx_design.py'), join(s.studio, 'tools', 'sfx', 'sfx_design.py')];
  try {
    const edits = join(s.studio, s.projectsDir || 'projects');
    for (const n of readdirSync(edits)) tries.push(join(edits, n, 'sfx_design.py'));
  } catch {}
  return tries.find((p) => existsSync(p)) || null;
}

export function findBrief({ query, at, project }) {
  const lib = libraryDir(), s = settings();
  const script = designScript();
  const free = expandHome(s.sfxFreeDir || '');
  const q = String(query || '').trim().slice(0, 400);
  if (!q) throw new Error('Say what sound you need.');
  return [
    `Find a sound: "${q}"${project ? ` for this project${at != null ? ` (I'm placing it at ${at.toFixed(1)} s on the take)` : ''}` : ''}.`,
    soundCatalogContext(),
    `First check the sound catalog: if an approved, non-missing sound already fits, tell me its name and file instead of adding another.`,
    `Otherwise find 2 to 4 options, in this order, and stop when you have good ones:`,
    `1. Make it in code when it's a whoosh, riser, swell, thud, click or pop${script ? `: use the studio's own sound design script ${script} (vary its parameters for this request; the studio's notes say which designed sounds were approved)` : ' (Python with numpy/scipy: shaped noise through a swept filter, a soft envelope, a little room)'}. Proper soft swooshes, never sharp synthetic "slash" sounds.`,
    `2. Epidemic Sound: if you have its tools (search and download sound effects), search there and download the best matches. Note the plan's licence.`,
    free ? `3. The free sound folder ${free}: pick files whose names fit (copy them, never move them) and note their licence (the folder's licence file).` : `3. No free sound folder is set in Video Octopus; skip it.`,
    `Put each option as a WAV or MP3 with a clear unused filename in ${join(lib, NEW_SOUNDS)}/ (never overwrite an existing audio file) and list them in ${join(lib, NEW_SOUNDS, 'candidates.json')} as [{"file": "<name>", "note": "<what it is, length>", "source": "made in code" | "Epidemic Sound" | "<folder>", "licence": "<licence>"}] (keep entries already there). Peak around -1 dBFS; Video Octopus sets the level under the voice.`,
    `Never write into other projects' folders: if a script writes files next to itself, run a copy of it from a temporary folder.`,
    `Don't mark sounds approved or place them: I listen in Video Octopus and approve the ones I want. Reply in one or two lines.`,
  ].join('\n');
}

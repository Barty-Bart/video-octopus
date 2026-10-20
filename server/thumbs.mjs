// Poster frames for the home screen's project tiles. Cached in the app's local/ folder, never in the
// studio, and rebuilt when the project gets a newer render or take.
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { LOCAL_DIR, studioTool, mtime } from './util.mjs';

const DIR = join(LOCAL_DIR, 'thumbs');
mkdirSync(DIR, { recursive: true });
const VIDEO = /\.(mp4|mov|m4v)$/i;

// The best picture of a project: its newest render, else a playback copy, else a source take.
function pick(dir) {
  for (const sub of ['renders', 'work', 'source']) {
    let files = [];
    try { files = readdirSync(join(dir, sub)); } catch { continue; }
    files = files.filter((f) => VIDEO.test(f) && !f.startsWith('.') && !f.endsWith('.part') && (sub !== 'work' || f.startsWith('proxy')));
    if (!files.length) continue;
    files.sort((a, b) => mtime(join(dir, sub, b)) - mtime(join(dir, sub, a)));
    return join(dir, sub, files[0]);
  }
  return null;
}

// A few ffmpeg grabs at a time, so opening the home screen doesn't spin up twenty encoders.
let running = 0;
const waiting = [];
const slot = () => new Promise((go) => { if (running < 3) { running++; go(); } else waiting.push(go); });
const release = () => { running--; const next = waiting.shift(); if (next) { running++; next(); } };

const grab = (src, at, out) => new Promise((done) => {
  execFile(studioTool('ffmpeg'), ['-y', '-v', 'error', '-ss', String(at), '-i', src, '-frames:v', '1',
    '-vf', 'scale=640:-2', '-q:v', '4', out], { timeout: 20000 }, () => done(existsSync(out) && statSync(out).size > 0));
});

const pending = new Map();
export async function thumbFor(id, dir) {
  const src = pick(dir);
  if (!src) return null;
  const out = join(DIR, `${id}.jpg`);
  if (existsSync(out) && mtime(out) >= mtime(src)) return out;
  if (pending.has(id)) return pending.get(id);
  const job = (async () => {
    await slot();
    try {
      // A frame a few seconds in shows the shot better than the first one; short clips fall back to the start.
      return (await grab(src, 3, out)) || (await grab(src, 0, out)) ? out : null;
    } finally { release(); pending.delete(id); }
  })();
  pending.set(id, job);
  return job;
}

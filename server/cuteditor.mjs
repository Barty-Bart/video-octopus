// The Cut Editor (transcript + waveform cutting) for one project, run as its own small server
// and shown inside the app. Picks the newest words, cut and join files the skills have written.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { settings, readJSON, writeJSON, python, studioTool, expandHome, childPathEnv } from './util.mjs';
import { roles, proxyName, isAudio } from './studio.mjs';
import { childEnv } from './settings.mjs';

const editors = new Map(); // project id -> { proc, port, key }

const first = (dir, list) => list.find((f) => existsSync(join(dir, f))) || null;

function freePort(start = 8810) {
  return new Promise((done) => {
    const tryPort = (p) => {
      const srv = createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.once('listening', () => srv.close(() => done(p)));
      srv.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

async function waitFor(port, ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Read the page to the end: an unread body over 64 KB makes Node's fetch throw out of the server when the editor closes the connection.
    try { const r = await fetch(`http://127.0.0.1:${port}/`); await r.arrayBuffer(); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export function cutEditorPath() {
  const s = settings();
  const p = expandHome(s.cutEditor || join(s.studio, 'tools', 'cut-editor', 'server.py'));
  return existsSync(p) ? p : null;
}

// What the Cut Editor would open for this project, or why it can't open yet.
export function cutPlan(dir) {
  const r = roles(dir);
  if (!r.main) return { ready: false, why: 'Import a recording first.' };
  const video = existsSync(join(dir, proxyName(r.main))) ? proxyName(r.main) : `source/${r.main}`;
  // A mic-only take opens as it is (the editor plays its sound and draws its waveform; there's no picture).
  if (video.startsWith('source/') && !/\.mp4$/i.test(video) && !isAudio(r.main)) return { ready: false, why: 'The playback copy is still being prepared.' };
  const words = first(dir, ['work/words_refined.json', 'work/editor_words.json', 'work/tr/words.json', 'work/words.json']);
  if (!words) return { ready: false, why: 'Transcribe first: the Cut Editor needs the word times.' };
  let edl = first(dir, ['work/edl_fixed.json', 'work/edl_editor_in.json', 'work/edl.json']);
  if (!edl) {
    // Start from the rough cut if there is one, else from the whole take.
    const map = readJSON(join(dir, 'work/rough_map.json'));
    const words_ = readJSON(join(dir, words), []);
    const end = map?.src_duration || (words_.length ? words_[words_.length - 1][1] + 1 : 0);
    const segments = map?.segments?.length ? map.segments.map((s) => s.src) : [[0, end]];
    writeJSON(join(dir, 'work/edl_editor_in.json'), { segments_sec: segments });
    edl = 'work/edl_editor_in.json';
  }
  const joins = first(dir, ['work/joins.json']);
  return { ready: true, video, words, edl, out: 'work/edl_manual.json', joins };
}

export async function openCutEditor(id, dir) {
  const tool = cutEditorPath();
  if (!tool) return { ok: false, why: 'The Cut Editor was not found in this studio (tools/cut-editor/server.py).' };
  const plan = cutPlan(dir);
  if (!plan.ready) return { ok: false, why: plan.why };
  const key = JSON.stringify(plan);
  const running = editors.get(id);
  if (running && running.key === key && running.proc.exitCode === null) return { ok: true, url: `http://127.0.0.1:${running.port}/`, plan };
  if (running) running.proc.kill();

  const port = await freePort();
  const args = [tool, '--video', join(dir, plan.video), '--words', join(dir, plan.words), '--edl', join(dir, plan.edl),
    '--out', join(dir, plan.out), '--port', String(port)];
  if (plan.joins) args.push('--joins', join(dir, plan.joins));
  const ffmpeg = studioTool('ffmpeg');
  const env = await childPathEnv({ FFMPEG: ffmpeg, ...(await childEnv()) }); // + saved keys, STUDIO_TRANSCRIBE
  // stdout isn't read (it prints a line per save), so don't pipe it: a full pipe would freeze the editor.
  const proc = spawn(python(), args, { cwd: settings().studio, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  editors.set(id, { proc, port, key });
  const up = await waitFor(port);
  if (!up) { proc.kill(); return { ok: false, why: `The Cut Editor didn't start. ${err.trim().split('\n').slice(-2).join(' ')}` }; }
  return { ok: true, url: `http://127.0.0.1:${port}/`, plan };
}

export function closeAll() { for (const e of editors.values()) e.proc.kill(); }

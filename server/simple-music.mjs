// Simple mode's Music tool (V1 spec §5, one-editor §0.2 "Music: pick a bed + volume"). The starter library ships no
// approved sounds, so Simple offers three beds that ffmpeg synthesises on this computer from plain sine tones: nothing
// is downloaded, nothing is sampled, so there is no licence to check. A bed is made once per video and length, in the
// project's work/music/ folder, and is placed like any sound cue (server/sound.mjs, from "project"), so the canvas
// preview and Export mix it as they mix every cue. web/simple-flow.js MUSIC_BEDS names them for the page.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { studioTool } from './util.mjs';
import { appendWorklog } from './studio.mjs';
import { MUSIC_BEDS } from '../web/simple-flow.js';

// The tones, as ffmpeg aevalsrc expressions of t (seconds), left and right. Quiet on purpose (peaks under -6 dBFS):
// the cue's gain sets the level under the voice.
const TAU = '2*PI';
const pluck = (f, step, k) => `(1-exp(-300*mod(t,${step})))*exp(-${k}*mod(t,${step}))*sin(${TAU}*${f}*t)`;
export const BED_TONES = {
  // A major pad that swells every 8 seconds; the right side a touch detuned for width.
  calm: (d = 0) => `0.09*(sin(${TAU}*${110 + d}*t)+sin(${TAU}*${220 + d}*t)+0.8*sin(${TAU}*${277.18 + d}*t)+0.7*sin(${TAU}*${329.63 + d}*t))*(0.7+0.3*sin(${TAU}*t/8))`,
  // 120 BPM: a plucked arpeggio (A, C#, E, A) in eighths over a soft bass on the beat.
  bright: (d = 0) => `0.22*${pluck(`440*pow(2,if(lt(mod(floor(t*4),4),1),0,if(lt(mod(floor(t*4),4),2),4,if(lt(mod(floor(t*4),4),3),7,12)))/12)+${d}`, 0.25, 9)}+0.25*${pluck(110 + d, 0.5, 4)}`,
  // A low D with its fifth, slow vibrato and breathing.
  warm: (d = 0) => `(0.22*sin(${TAU}*${73.42 + d}*t+0.4*sin(${TAU}*0.2*t))+0.13*sin(${TAU}*${110 + d}*t)+0.07*sin(${TAU}*${146.83 + d}*t))*(0.8+0.2*sin(${TAU}*t/6))`,
};
const FILTER = { calm: 'lowpass=f=1800', bright: 'lowpass=f=5000', warm: 'lowpass=f=900' };

export const bedSeconds = (s) => Math.round(Math.min(3600, Math.max(10, Number(s) || 60)));
export const bedFile = (key, seconds) => `work/music/${key}-${bedSeconds(seconds)}s.m4a`;

// Commas inside an expression would end the filter: escaped for the filtergraph.
const esc = (x) => x.replace(/,/g, '\\,');
// The ffmpeg arguments for one bed: stereo 48 kHz AAC, 2 s fade in, 3 s fade out.
export function bedArgs(key, seconds, out) {
  const L = bedSeconds(seconds);
  return ['-y', '-v', 'error', '-f', 'lavfi', '-i', `aevalsrc=${esc(BED_TONES[key](0))}|${esc(BED_TONES[key](0.6))}:s=48000:c=stereo:d=${L}`,
    '-af', `${FILTER[key]},afade=t=in:d=2,afade=t=out:st=${Math.max(0, L - 3)}:d=3`, '-c:a', 'aac', '-b:a', '96k', out];
}

// Make (or reuse) the bed for this video: { file } relative to the project folder.
export async function makeBed(dir, key, seconds) {
  if (!Object.hasOwn(MUSIC_BEDS, key)) throw new Error('Pick one of the music beds.');
  const file = bedFile(key, seconds), out = join(dir, file);
  if (existsSync(out) && statSync(out).size > 0) return { file };
  mkdirSync(join(dir, 'work/music'), { recursive: true });
  const part = `${out}.part.m4a`;
  try {
    await new Promise((done, fail) => execFile(studioTool('ffmpeg'), bedArgs(key, seconds, part), { timeout: 120000 }, (e, so, se) => (e ? fail(new Error(String(se || e.message).trim().split('\n').pop() || 'ffmpeg failed')) : done())));
    renameSync(part, out);
  } finally { rmSync(part, { force: true }); }
  appendWorklog(dir, `Made the music bed "${MUSIC_BEDS[key]}" (${bedSeconds(seconds)} s, synthesised by ffmpeg)`);
  return { file };
}

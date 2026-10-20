// Timeline files for other editors: FCPXML 1.10 (Final Cut Pro, DaVinci Resolve) and Final Cut Pro 7 XML
// (xmeml version 5: Premiere Pro, DaVinci Resolve), written from a plain list of tracks and clips. Times are exact
// rationals of the sequence's frame rate (30/1, or 30000/1001 for 29.97), file paths are absolute file:// URLs.
// No editor was installed on the Mac this was built on, so imports are untested: both writers follow Apple's DTDs
// (FCPXMLv1_10.dtd and the FCP 7 XML v5 DTD) and their output was checked against them with xmllint.
//
// spec = { name, rate: {num, den}, W, H, frames, media: Map(path -> mediaInfo()),
//          video: [{ name, clips: [{ file, name, at, dur, in, alpha }] }]          bottom to top: V1 first
//          audio: [{ name, role, clips: [{ file, name, at, dur, in, gainDb }] }] }  A1 first
// at and dur are frames on the sequence, in is seconds into the file.
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { studioTool } from './util.mjs';
import { snapSegments } from '../web/layout.js';
import { readCues, cuePath, level, toOutput, cueGain } from './sound.mjs';

const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
const xml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// The usual frame rates as exact fractions (29.97 is 30000/1001, not 2997/100).
const RATES = [[24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [48, 1], [50, 1], [60000, 1001], [60, 1]];
export function rateOf(fps) {
  if (typeof fps === 'string' && /^\d+\/\d+$/.test(fps)) { const [n, d] = fps.split('/').map(Number); if (n && d) fps = n / d; }
  const f = Number(fps) || 30;
  const hit = RATES.find(([n, d]) => Math.abs(n / d - f) < 0.005);
  if (hit) return { num: hit[0], den: hit[1] };
  const n = Math.round(f * 1000), g = gcd(n, 1000);
  return { num: n / g, den: 1000 / g };
}
export const fpsOf = (r) => r.num / r.den;
// n frames as an FCPXML time: "3s", "1001/30000s", "0s".
export function tFrames(n, r) {
  const a = Math.round(n) * r.den, b = r.num;
  if (!a) return '0s';
  const g = gcd(a, b);
  return b / g === 1 ? `${a / g}s` : `${a / g}/${b / g}s`;
}
const tSamples = (n, sr) => { if (!n) return '0s'; const g = gcd(n, sr); return sr / g === 1 ? `${n / g}s` : `${n / g}/${sr / g}s`; };
const fileUrl = (p) => pathToFileURL(p).href;

// What a timeline file needs to know about a file: length, picture size and rate, sound channels.
export function mediaInfo(path) {
  const out = JSON.parse(String(execFileSync(studioTool('ffprobe'), ['-v', 'error', '-show_entries',
    'stream=codec_type,width,height,r_frame_rate,nb_frames,channels,sample_rate,bits_per_raw_sample,bits_per_sample:format=duration', '-of', 'json', path], { timeout: 15000 })));
  const v = out.streams.find((s) => s.codec_type === 'video'), a = out.streams.find((s) => s.codec_type === 'audio');
  const duration = Number(out.format?.duration) || 0;
  const rate = v ? rateOf(v.r_frame_rate) : null;
  return {
    path, duration,
    video: v ? { w: v.width, h: v.height, rate, frames: Number(v.nb_frames) || Math.round(duration * fpsOf(rate)) } : null,
    audio: a ? { channels: a.channels || 2, rate: Number(a.sample_rate) || 48000, depth: Number(a.bits_per_raw_sample || a.bits_per_sample) || 16 } : null,
  };
}

// Final Cut Pro's names for the standard 1920×1080 formats; any other size or rate is a custom format (no name).
function formatName(W, H, r) {
  if (W !== 1920 || H !== 1080) return '';
  const tag = { '24000/1001': '2398', '24/1': '24', '25/1': '25', '30000/1001': '2997', '30/1': '30', '50/1': '50', '60000/1001': '5994', '60/1': '60' }[`${r.num}/${r.den}`];
  return tag ? ` name="FFVideoFormat1080p${tag}"` : '';
}

// ---- FCPXML 1.10 ----
// One gap spans the whole sequence in the primary storyline; every track is a lane of clips connected to it
// (video lanes 1, 2, 3… bottom to top, audio lanes −1, −2…), so each layer keeps its own lane.
export function fcpxml(spec) {
  const r = spec.rate, T = (n) => tFrames(n, r), S = (sec) => T(Math.round((sec * r.num) / r.den));
  const formats = [], assets = [], fmtIds = new Map(), assetIds = new Map();
  let next = 1;
  const formatFor = (W, H, rate) => {
    const key = `${W}x${H}@${rate.num}/${rate.den}`;
    if (!fmtIds.has(key)) {
      const id = `r${next++}`;
      fmtIds.set(key, id);
      formats.push(`    <format id="${id}"${formatName(W, H, rate)} frameDuration="${tFrames(1, rate)}" width="${W}" height="${H}" colorSpace="1-1-1 (Rec. 709)"/>`);
    }
    return fmtIds.get(key);
  };
  const seqFmt = formatFor(spec.W, spec.H, r);
  const assetFor = (file) => {
    if (assetIds.has(file)) return assetIds.get(file);
    const m = spec.media.get(file);
    if (!m) throw new Error(`No media info for ${file}`);
    const id = `r${next++}`;
    assetIds.set(file, id);
    const dur = m.video ? tFrames(m.video.frames, m.video.rate) : tSamples(Math.round(m.duration * m.audio.rate), m.audio.rate);
    const attrs = [`id="${id}"`, `name="${xml(basename(file))}"`, 'start="0s"', `duration="${dur}"`];
    if (m.video) attrs.push('hasVideo="1"', `format="${formatFor(m.video.w, m.video.h, m.video.rate)}"`, 'videoSources="1"');
    if (m.audio) attrs.push('hasAudio="1"', 'audioSources="1"', `audioChannels="${m.audio.channels}"`, `audioRate="${m.audio.rate}"`);
    assets.push(`    <asset ${attrs.join(' ')}>\n      <media-rep kind="original-media" src="${xml(fileUrl(file))}"/>\n    </asset>`);
    return id;
  };
  const clips = [];
  const clip = (c, lane, kind, role) => {
    const m = spec.media.get(c.file);
    const ref = assetFor(c.file);
    const attrs = [`ref="${ref}"`, `lane="${lane}"`, `offset="${T(c.at)}"`, `name="${xml(c.name)}"`, `start="${S(c.in || 0)}"`, `duration="${T(c.dur)}"`];
    if (kind === 'video' && m.video) attrs.push(`format="${formatFor(m.video.w, m.video.h, m.video.rate)}"`);
    if (kind === 'video' && m.audio) attrs.push('srcEnable="video"');
    if (kind === 'audio' && m.video) attrs.push('srcEnable="audio"');
    if (kind === 'audio' && role) attrs.push(`audioRole="${xml(role)}"`);
    const vol = kind === 'audio' && c.gainDb ? `\n                <adjust-volume amount="${c.gainDb.toFixed(1)}dB"/>\n              ` : '';
    clips.push(`              <asset-clip ${attrs.join(' ')}${vol ? `>${vol}</asset-clip>` : '/>'}`);
  };
  spec.video.forEach((tr, i) => tr.clips.forEach((c) => clip(c, i + 1, 'video')));
  spec.audio.forEach((tr, i) => tr.clips.forEach((c) => clip(c, -(i + 1), 'audio', tr.role)));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<!-- Made by Video Octopus. Tracks: ${[...spec.video.map((t, i) => `V${i + 1} ${t.name}`), ...spec.audio.map((t, i) => `A${i + 1} ${t.name}`)].join(', ').replace(/--/g, '-')}. -->
<fcpxml version="1.10">
  <resources>
${formats.join('\n')}
${assets.join('\n')}
  </resources>
  <library>
    <event name="${xml(spec.event || spec.name)}">
      <project name="${xml(spec.name)}">
        <sequence format="${seqFmt}" duration="${T(spec.frames)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
            <gap name="Gap" offset="0s" start="0s" duration="${T(spec.frames)}">
${clips.join('\n')}
            </gap>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

// ---- Final Cut Pro 7 XML (xmeml v5) ----
// Video tracks bottom to top. A stereo sound file takes two audio tracks (left and right, FCP 7's way); mono takes one.
export function xmeml(spec) {
  const r = spec.rate;
  const rate = (q) => `<rate><timebase>${Math.round(q.num / q.den)}</timebase><ntsc>${q.den === 1001 ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const F = (sec) => Math.round((sec * r.num) / r.den);
  const files = new Map();
  let clipN = 0;
  const lengthOf = (m) => (m.video ? Math.round((m.video.frames * fpsOf(r)) / fpsOf(m.video.rate)) : Math.round(m.duration * fpsOf(r)));
  const fileXml = (file) => {
    if (files.has(file)) return `<file id="${files.get(file)}"/>`;
    const id = `file-${files.size + 1}`;
    files.set(file, id);
    const m = spec.media.get(file);
    const fr = m.video?.rate || r;
    const v = m.video ? `<video><samplecharacteristics>${rate(fr)}<width>${m.video.w}</width><height>${m.video.h}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>` : '';
    const a = m.audio ? `<audio><samplecharacteristics><depth>${m.audio.depth >= 24 ? 24 : 16}</depth><samplerate>${m.audio.rate}</samplerate></samplecharacteristics><channelcount>${m.audio.channels}</channelcount></audio>` : '';
    return `<file id="${id}"><name>${xml(basename(file))}</name><pathurl>${xml(fileUrl(file).replace(/^file:\/\//, 'file://localhost'))}</pathurl>${rate(fr)}<duration>${m.video ? m.video.frames : F(m.duration)}</duration>` +
      `<timecode>${rate(fr)}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode><media>${v}${a}</media></file>`;
  };
  const head = (c, m) => `<name>${xml(c.name)}</name><enabled>TRUE</enabled><duration>${lengthOf(m)}</duration>${rate(r)}` +
    `<start>${c.at}</start><end>${c.at + c.dur}</end><in>${F(c.in || 0)}</in><out>${F(c.in || 0) + c.dur}</out>`;
  const level = (db) => (db ? `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype>` +
    `<parameter><parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>${(10 ** (db / 20)).toFixed(5)}</value></parameter></effect></filter>` : '');
  const vTracks = spec.video.map((tr) => `        <track>\n${tr.clips.map((c) => {
    const m = spec.media.get(c.file);
    return `          <clipitem id="clipitem-${++clipN}">${head(c, m)}${c.alpha ? '<alphatype>straight</alphatype>' : ''}${fileXml(c.file)}<compositemode>normal</compositemode></clipitem>`;
  }).join('\n')}\n          <enabled>TRUE</enabled><locked>FALSE</locked>\n        </track>`);
  const aTracks = [];
  for (const tr of spec.audio) {
    const ch = Math.min(2, Math.max(1, ...tr.clips.map((c) => spec.media.get(c.file)?.audio?.channels || 1)));
    for (let k = 1; k <= ch; k++) {
      aTracks.push(`        <track>\n${tr.clips.map((c) => {
        const m = spec.media.get(c.file);
        const idx = Math.min(k, m.audio?.channels || 1);
        return `          <clipitem id="clipitem-${++clipN}">${head(c, m)}${fileXml(c.file)}<sourcetrack><mediatype>audio</mediatype><trackindex>${idx}</trackindex></sourcetrack>${level(c.gainDb)}</clipitem>`;
      }).join('\n')}\n          <enabled>TRUE</enabled><locked>FALSE</locked>${ch === 2 ? `<outputchannelindex>${k}</outputchannelindex>` : ''}\n        </track>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<!-- Made by Video Octopus. Video tracks bottom to top: ${spec.video.map((t, i) => `V${i + 1} ${t.name}`).join(', ').replace(/--/g, '-')}. Sound: ${spec.audio.map((t) => t.name).join(', ').replace(/--/g, '-')} (a stereo file takes two tracks, left and right). -->
<xmeml version="5">
  <sequence id="sequence-1">
    <name>${xml(spec.name)}</name>
    <duration>${spec.frames}</duration>
    ${rate(r)}
    <timecode>${rate(r)}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
    <in>-1</in><out>-1</out>
    <media>
      <video>
        <format><samplecharacteristics>${rate(r)}<width>${spec.W}</width><height>${spec.H}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>
${vTracks.join('\n')}
      </video>
      <audio>
        <format><samplecharacteristics><depth>24</depth><samplerate>48000</samplerate></samplecharacteristics></format>
${aTracks.join('\n')}
      </audio>
    </media>
  </sequence>
</xmeml>
`;
}

// ---- straight from the sources: the cut as separate clips (gaps closed), blocks in order, cues at their times ----
// parts = what the export would render, in order: { kind: 'take', segs: [[a, b] source seconds], screen, cam, layers: [file],
// sound: file | null, breaks?: [source seconds], shotName?: (t) → name } or { kind: 'file', screen, cam, sound, duration, name }.
// Paths are absolute. breaks: where the export's look changes (a shot starts): the clips are cut there too, and named
// after their shot (shotName of the clip's first source second).
export function sourcesSpec({ name, W, H, parts, dir, voiceFile, cutSegs }) {
  const media = new Map();
  const info = (f) => { if (!media.has(f)) media.set(f, mediaInfo(f)); return media.get(f); };
  // The sequence runs at the camera's own rate (most takes are 30 or 29.97); with no video at all (a mic-only take), 30.
  const first = parts.find((p) => p.cam || p.screen);
  const rate = (first && info(first.cam || first.screen).video?.rate) || { num: 30, den: 1 };
  const fps = fpsOf(rate);
  const tracks = { screen: [], camera: [], layers: new Map(), voice: [], layerSound: [], cues: [] };
  let at = 0;
  const partStarts = [];
  for (const p of parts) {
    partStarts.push(at);
    if (p.kind === 'take') {
      const vids = [p.cam, p.screen].filter(Boolean);
      const full = Math.min(...(vids.length ? vids : [p.sound]).filter(Boolean).map((f) => info(f).duration)); // mic-only take: the sound's length
      const snapped = snapSegments(p.segs || [[0, full]], full, fps);
      const cuts = (p.breaks || []).map((t) => Math.round(t * fps) / fps);
      for (const [a, b] of snapped) {
        const dur = Math.round((b - a) * fps);
        if (dur <= 0) continue;
        // The pictures are cut at the shot changes inside this piece too (named after their shot); the sound runs on.
        let x = a, k = at;
        for (const c of [...cuts.filter((t) => t > a + 1e-6 && t < b - 1e-6), b]) {
          const d = Math.round((c - x) * fps);
          if (d > 0) {
            const shot = p.shotName ? p.shotName(x) : null;
            const piece = (file, list, label) => file && list.push({ file, name: shot ? `${label} · ${shot}` : label, at: k, dur: d, in: x });
            piece(p.screen, tracks.screen, 'Screen');
            piece(p.cam, tracks.camera, 'Camera');
            for (const f of p.layers || []) { if (!tracks.layers.has(f)) tracks.layers.set(f, []); piece(f, tracks.layers.get(f), basename(f)); }
          }
          k += d; x = c;
        }
        if (p.sound && info(p.sound).audio) tracks.voice.push({ file: p.sound, name: 'Voice', at, dur, in: a });
        for (const f of p.layerSound || []) if (info(f).audio) tracks.layerSound.push({ file: f, name: `${basename(f)} sound`, at, dur, in: a });
        at += dur;
      }
      p.snapped = snapped;
      p.frames = at - partStarts.at(-1);
    } else {
      const dur = Math.floor(p.duration * fps + 1e-6);
      for (const f of [p.screen, p.cam]) if (f) info(f);
      if (p.screen) tracks.screen.push({ file: p.screen, name: p.name, at, dur, in: 0 });
      if (p.cam) tracks.camera.push({ file: p.cam, name: p.name, at, dur, in: 0 });
      if (p.sound && info(p.sound).audio) tracks.voice.push({ file: p.sound, name: p.name, at, dur, in: 0 });
      p.frames = dur;
      at += dur;
    }
  }
  const frames = at;
  // Sound cues (work/sfx.json) sit on the take: each lands where the export plays that moment, at the level the
  // export mixes it (under the voice by Settings → Sound, plus its own gain: sound.mjs cueGain).
  const ref = (voiceFile ? level(voiceFile, 'speech') : null) ?? -24;
  parts.forEach((p, k) => {
    if (p.kind !== 'take') return;
    for (const c of readCues(dir)) {
      if (p.range && (c.t < p.range[0] || c.t >= p.range[1])) continue;
      const file = cuePath(dir, c);
      if (!file) continue;
      let m;
      try { m = info(file); } catch { continue; }
      const t = toOutput(c.t, p.snapped);
      if (t == null) continue;
      const pos = partStarts[k] + Math.round(t * fps);
      const dur = Math.min(Math.ceil(m.duration * fps), frames - pos);
      if (dur <= 0) continue;
      tracks.cues.push({ file, name: c.label, at: pos, dur, in: 0, gainDb: cueGain(dir, c, ref) });
    }
  });
  tracks.cues.sort((a, b) => a.at - b.at);
  const video = [];
  if (tracks.screen.length) video.push({ name: 'Screen', clips: tracks.screen });
  if (tracks.camera.length) video.push({ name: 'Camera', clips: tracks.camera });
  for (const [f, clips] of tracks.layers) video.push({ name: basename(f), clips });
  const audio = [];
  if (tracks.voice.length) audio.push({ name: 'Voice', role: 'dialogue', clips: tracks.voice });
  // Cues may overlap each other: one track per overlap level.
  const cueTracks = [];
  for (const c of tracks.cues) {
    const tr = cueTracks.find((t) => t.at(-1).at + t.at(-1).dur <= c.at) || (cueTracks.push([]), cueTracks.at(-1));
    tr.push(c);
  }
  cueTracks.forEach((clips, i) => audio.push({ name: cueTracks.length > 1 ? `Sound cues ${i + 1}` : 'Sound cues', role: 'effects', clips }));
  if (tracks.layerSound.length) audio.push({ name: 'Layer sound', role: 'dialogue', clips: tracks.layerSound });
  return { name, W, H, rate, frames, media, video, audio, cues: tracks.cues.length };
}

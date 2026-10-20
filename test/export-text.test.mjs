// Actual text/word/timeline export functions with synthetic project files.
// No server, browser, real media process, credentials, model or network.
//   node --test test/export-text.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';

const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const json = (path, value) => write(path, JSON.stringify(value, null, 2));
const snapshot = (root) => {
  const files = {};
  const walk = (dir) => { for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
  } };
  walk(root); return files;
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} differs from ${b}`);

test('transcript and subtitle export on an isolated final timeline', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'octopus-export-text-'));
  const priorLocal = process.env.STUDIO_LOCAL_DIR, priorFetch = globalThis.fetch;
  const priorProcesses = Object.fromEntries(['execFileSync', 'execFile', 'exec', 'execSync', 'spawn', 'spawnSync', 'fork'].map((key) => [key, childProcess[key]]));
  const probe = join(root, 'synthetic-ffprobe'), calls = [];
  process.env.STUDIO_LOCAL_DIR = join(root, 'local');
  json(join(root, 'local/settings.json'), { studio: join(root, 'studio'), ffprobe: probe });
  globalThis.fetch = () => { throw new Error('Network is forbidden in this export fixture'); };
  for (const key of Object.keys(priorProcesses)) childProcess[key] = () => { throw new Error(`Unexpected external process: ${key}`); };
  // Use the actual media-probe consumer, but no executable or codec is needed for
  // a text export. Metadata is returned only for these two synthetic source files.
  childProcess.execFileSync = (file, args) => {
    calls.push({ file, source: args.at(-1) });
    assert.equal(file, probe);
    const source = args.at(-1);
    assert.ok(source.startsWith(root));
    assert.match(source, /(?:fixture_webcam|sponsor)\.webm$/);
    return JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'vp9', width: 1280, height: 720, avg_frame_rate: '30/1' }, { codec_type: 'audio' }],
      format: { duration: source.endsWith('sponsor.webm') ? '2' : '10' } });
  };
  syncBuiltinESMExports();
  t.after(() => {
    Object.assign(childProcess, priorProcesses); syncBuiltinESMExports(); globalThis.fetch = priorFetch;
    if (priorLocal === undefined) delete process.env.STUDIO_LOCAL_DIR; else process.env.STUDIO_LOCAL_DIR = priorLocal;
    rmSync(root, { recursive: true, force: true });
  });
  const { textPreview, saveText, timelineParts, listTextExports } = await import('../server/export-text.mjs');
  const { finalWords, buildCues, srt, vtt } = await import('../server/export-words.mjs');
  const make = (name, { words = true, blocks = true, sponsorWords = true } = {}) => {
    const dir = join(root, 'studio/projects', name);
    json(join(dir, 'project.json'), { name: 'Synthetic text export', type: 'tutorial', activeTake: 'fixture', layout: { preset: 'camera', aspect: '16:9' } });
    write(join(dir, 'source/fixture_webcam.webm'), 'Synthetic metadata fixture; not playable media.');
    write(join(dir, 'source/sponsor.webm'), 'Synthetic sponsor metadata fixture; not playable media.');
    json(join(dir, 'work/edl_manual.json'), { segments_sec: [[0, 2], [4, 6], [7, 9]] });
    if (words) {
      const refined = [[0.1, 0.6, 'Intro'], [0.7, 1, 'starts.'], [2.2, 2.6, 'REMOVED'], [4.1, 4.5, 'Body'], [4.6, 5, 'first.'], [7.1, 7.5, 'Outro'], [7.6, 8, 'ends.']];
      json(join(dir, 'work/words_refined.json'), refined);
      json(join(dir, 'work/tr/words.json'), refined.map((w, i) => i ? w : [w[0], w[1], 'RAW-FALLBACK']));
    }
    if (blocks) json(join(dir, 'work/blocks.json'), { v: 1, marked: true, blocks: [
      { id: 'outro', type: 'outro', label: 'Outro', order: 1, source: { take: [7, 9] } },
      { id: 'sponsor', type: 'sponsor', label: 'Sponsor read', order: 2, source: { file: 'source/sponsor.webm' } },
      { id: 'intro', type: 'intro', label: 'Intro', order: 3, source: { take: [0, 4] } },
      { id: 'body', type: 'body', label: 'Main body', order: 4, source: { take: [4, 7] } },
    ] });
    if (sponsorWords && blocks) json(join(dir, 'work/tr/sponsor/words.json'), [[0.1, 0.6, 'Sponsor'], [0.7, 1.2, 'message.'], [2.2, 2.5, 'TRIMMED']]);
    return dir;
  };
  const dir = make('film'), before = snapshot(dir);
  const protectedFiles = Object.keys(before).filter((f) => /source|words.*\.json|project\.json|edl_manual/.test(f));

  await t.test('final words follow the cut and reordered blocks, including file-block offsets', () => {
    const timeline = timelineParts('film', dir);
    near(timeline.total, 8);
    assert.deepEqual(timeline.parts.map((p) => [p.kind, p.start, p.total]), [['take', 0, 2], ['file', 2, 2], ['take', 4, 4]]);
    const fw = finalWords(dir, timeline.parts, timeline.doc);
    assert.deepEqual(fw.words.map((w) => w.w), ['Outro', 'ends.', 'Sponsor', 'message.', 'Intro', 'starts.', 'Body', 'first.']);
    fw.words.forEach((w, i) => { near(w.s, [0.1, 0.6, 2.1, 2.7, 4.1, 4.7, 6.1, 6.6][i]); near(w.e, [0.5, 1, 2.6, 3.2, 4.6, 5, 6.5, 7][i]); });
    assert.equal(fw.takeFile, 'work/words_refined.json');
    assert.deepEqual(fw.sections.map((x) => [x.label, x.start]), [['Outro', 0], ['Sponsor read', 2], ['Intro', 4], ['Main body', 6]]);
    const cues = buildCues(fw.words, { maxChars: 20, maxLines: 1, maxDur: 2 });
    assert.equal(cues.length, 4);
    assert.match(srt(cues), /00:00:02,100 --> 00:00:03,200\nSponsor message\./);
    assert.match(vtt(cues), /^WEBVTT\n\n00:00:00\.100 --> 00:00:01\.000/);
    assert.ok(cues.every((c) => c.lines.length === 1 && c.lines[0].length <= 20 && c.end - c.start <= 2));
  });

  await t.test('all four previews are read-only, including a fresh block project', () => {
    const fresh = make('preview'), snap = snapshot(fresh);
    for (const [kind, format] of [['transcript', 'txt'], ['transcript', 'md'], ['subtitles', 'srt'], ['subtitles', 'vtt']]) {
      const preview = textPreview('preview', fresh, kind, { format, timecodes: 'sentence' });
      assert.equal(preview.stats.words, 8);
      assert.doesNotMatch(preview.text, /REMOVED|TRIMMED|RAW-FALLBACK/);
      assert.ok(preview.text.indexOf('Outro') < preview.text.indexOf('Sponsor'));
      assert.ok(preview.text.indexOf('Sponsor') < preview.text.indexOf('Intro'));
      assert.equal(existsSync(join(fresh, preview.next)), false);
    }
    assert.deepEqual(snapshot(fresh), snap, 'Preview must not create or change project files');
  });

  await t.test('legacy layouts and automatic block rules are evaluated without rewriting project state', () => {
    const legacy = make('legacy-rules'), blockFile = join(legacy, 'work/blocks.json');
    const doc = JSON.parse(readFileSync(blockFile, 'utf8'));
    doc.blocks.find((b) => b.id === 'intro').layout = 'screen';
    doc.blocks.find((b) => b.id === 'sponsor').rule = 'end';
    json(blockFile, doc);
    const snap = snapshot(legacy);
    const preview = textPreview('legacy-rules', legacy, 'transcript', { format: 'txt' });
    assert.equal(preview.stats.words, 8);
    assert.equal(preview.parts.at(-1).kind, 'file');
    assert.ok(preview.text.indexOf('Sponsor') > preview.text.indexOf('Body'));
    assert.deepEqual(snapshot(legacy), snap, 'Preview must not persist rule placement or migrate legacy layouts');
    const result = saveText('legacy-rules', legacy, 'transcript', { format: 'txt' });
    assert.equal(result.text, preview.text);
    const after = snapshot(legacy);
    for (const file of Object.keys(snap)) assert.equal(after[file], snap[file], `${file} changed`);
    assert.deepEqual(Object.keys(after).filter((file) => !(file in snap)).sort(), ['WORKLOG.md', result.file].sort());
  });

  await t.test('TXT, Markdown, SRT and VTT save successive versions without replacing prior files', () => {
    const saved = new Map();
    for (let round = 0; round < 2; round++) for (const [kind, format, version] of [
      ['transcript', 'txt', 1], ['transcript', 'md', 2], ['subtitles', 'srt', 1], ['subtitles', 'vtt', 2],
    ]) {
      const body = { format, timecodes: 'sentence', maxChars: 20, maxLines: 1, maxDur: 2 };
      const preview = textPreview('film', dir, kind, body);
      const result = saveText('film', dir, kind, body);
      const expected = `renders/film_${kind === 'transcript' ? 'transcript' : 'subtitles'}_v${version + 2 * round}.${format}`;
      assert.equal(result.file, expected); assert.equal(result.file, preview.next); assert.equal(result.text, preview.text);
      assert.equal(readFileSync(join(dir, expected), 'utf8'), result.text);
      assert.doesNotMatch(result.text, /REMOVED|TRIMMED|RAW-FALLBACK/);
      if (format === 'md') { assert.match(result.text, /^# Synthetic text export/); assert.match(result.text, /## Main body · 0:06\n\n\[0:06\] Body first\./); }
      if (format === 'vtt') assert.match(result.text, /^WEBVTT\n/);
      for (const [file, data] of saved) assert.equal(readFileSync(join(dir, file), 'utf8'), data);
      saved.set(expected, result.text);
    }
    assert.equal(saved.size, 8);
    assert.equal(listTextExports(dir).length, 8);
    assert.equal((readFileSync(join(dir, 'WORKLOG.md'), 'utf8').match(/Exported (transcript|subtitles)/g) || []).length, 8);
  });

  await t.test('missing file-block transcript is reported without fabricated subtitle words', () => {
    const missing = make('missing-file-words', { sponsorWords: false });
    const tr = textPreview('missing-file-words', missing, 'transcript', { format: 'txt' });
    assert.equal(tr.missing.length, 1); assert.equal(tr.missing[0].id, 'sponsor');
    assert.match(tr.text, /Sponsor read: no transcript yet/);
    const sub = textPreview('missing-file-words', missing, 'subtitles', { format: 'srt' });
    assert.equal(sub.missing.length, 1);
    assert.doesNotMatch(sub.text, /no transcript yet|Sponsor message/);
  });

  await t.test('a project with no words cannot save an empty export', () => {
    const empty = make('no-words', { words: false, blocks: false }), snap = snapshot(empty);
    for (const kind of ['transcript', 'subtitles']) {
      assert.equal(textPreview('no-words', empty, kind, {}).text, '');
      assert.throws(() => saveText('no-words', empty, kind, {}), /no transcript yet/i);
    }
    assert.deepEqual(snapshot(empty), snap);
  });

  await t.test('source media, refined/raw/file words, cut and project settings remain unchanged', () => {
    const after = snapshot(dir);
    for (const file of protectedFiles) assert.equal(after[file], before[file], `${file} changed`);
    assert.ok(calls.length >= 2);
    assert.ok(calls.every((call) => call.file === probe && call.source.startsWith(root)));
  });
});

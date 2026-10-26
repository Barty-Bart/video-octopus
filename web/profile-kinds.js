// Simple mode's profiles (server/simple-profiles.mjs): the pure parts the server and the page share. No DOM, no state.
//
// A profile is one kind of video a creator makes again and again ("Main channel", "Instagram batch", "Podcast"),
// kept as a folder of its own: how it's made (INSTRUCTIONS.md), what Claude learned from earlier videos
// (LEARNINGS.md), its files (resources/) and any skills of its own (skills/<name>/SKILL.md). Each one starts its
// videos one of two ways:
// - topic: type a topic; Claude researches it and writes the script (every word, or talking points), then Record.
// - batch: drop reference videos; Claude breaks them down and writes several short scripts to read in one take,
//   then splits that one take into one video per script.

export const WORKFLOWS = {
  topic: { key: 'topic', name: 'Topic → video', sub: 'Type a topic. Claude researches it and writes the script.', start: 'Start' },
  batch: { key: 'batch', name: 'Batch of shorts', sub: 'Drop reference videos. Claude writes several scripts, you record once, it splits them.', start: 'Start batch' },
};
export const WORKFLOW_KEYS = Object.keys(WORKFLOWS);
export const isWorkflow = (k) => WORKFLOW_KEYS.includes(k);

// How much of the script Claude writes: full (every word, for voiceover and faceless videos) or points (the hook and
// the ending word for word, the middle as beats to talk through, for talking to camera).
export const SCRIPTS = {
  full: { key: 'full', name: 'Full script', sub: 'Every word, for voiceover or faceless videos' },
  points: { key: 'points', name: 'Talking points', sub: 'Hook and ending written out, beats in between' },
};
export const SCRIPT_KEYS = Object.keys(SCRIPTS);
export const isScript = (k) => SCRIPT_KEYS.includes(k);

// A profile's one-line description on its card: "Topic → video · YouTube · Talking points".
export function profileLine(p, shapes) {
  const w = WORKFLOWS[p.workflow]?.name || '';
  const s = shapes?.[p.shape]?.kind || '';
  const sc = p.workflow === 'batch' ? '' : SCRIPTS[p.script]?.name || '';
  return [w, s, sc].filter(Boolean).join(' · ');
}

// A folder name from a profile's name: lower case, words joined by dashes.
export const profileSlug = (name) =>
  String(name || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 48);

// One file name a profile's resources/ may hold: no folders, no dot files, no control characters.
export function cleanFileName(name) {
  const n = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*]/g, '').trim().slice(0, 120);
  return n && !n.startsWith('.') ? n : '';
}

// The lessons in a project's work/learnings.json ({ lessons: [{ text, stage }] }, or a plain list), cleaned.
export function lessonsOf(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.lessons) ? json.lessons : [];
  return list
    .map((l) => (typeof l === 'string' ? { text: l } : l))
    .filter((l) => l && typeof l.text === 'string' && l.text.trim())
    .map((l) => ({ text: l.text.replace(/\s+/g, ' ').trim().slice(0, 400), stage: typeof l.stage === 'string' ? l.stage.trim().slice(0, 30) : '' }));
}

// The videos in a batch's work/batch-split.json ({ videos: [{ title, start, end, script }] }), checked: times in take
// seconds, each at least a second long, in order, no overlaps. Returns { videos } or { error }.
export function splitPlan(json, takeSeconds = Infinity) {
  const list = Array.isArray(json?.videos) ? json.videos : null;
  if (!list || !list.length) return { error: 'Claude hasn’t marked where each video starts and ends yet.' };
  if (list.length > 30) return { error: 'A batch splits into at most 30 videos.' };
  const out = [];
  let last = 0;
  for (const [i, v] of list.entries()) {
    const start = Number(v?.start), end = Number(v?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < 1) return { error: `Video ${i + 1} has no usable start and end.` };
    if (start < last - 0.05) return { error: `Video ${i + 1} starts before video ${i} ends.` };
    if (end > takeSeconds + 0.5) return { error: `Video ${i + 1} ends after the take does.` };
    last = end;
    out.push({ title: String(v.title || `Video ${i + 1}`).replace(/\s+/g, ' ').trim().slice(0, 80) || `Video ${i + 1}`, start, end: Math.min(end, takeSeconds), script: typeof v.script === 'string' ? v.script.slice(0, 20000) : '' });
  }
  return { videos: out };
}

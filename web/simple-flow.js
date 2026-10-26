// Simple mode's editor flow (V1 spec §5–6, one-editor §0.2–0.3): what Claude's one step card says and offers, from the
// project view (/api/projects/<id>) and a few page facts. Pure: no DOM, no fetch, so the server (cleanTools) and the
// tests import it too. web/simple-editor.js draws the card and runs its buttons.
//
// The six steps (web/simple.js SIMPLE_STEPS): Record · Rough cut · Scenes · Build · Thumbnail (optional) · Download.
// - Record: no take → the Record page; a take → the after-Stop card (Keep · Rough cut next / Record again / Delete take).
// - Rough cut: prepare, sections and lock back to back; at most one listen card when the join check or Clean up left a
//   spot for the creator (Listen / Keep it / Cut it).
// - Scenes: plan, then the B4 approval (Looks good, build it / Change something).
// - Build: the format's Build steps, with the B5b per-scene progress as one card.
// - Thumbnail (optional): six Codex thumbnails (Packaging), Use this one or Skip. Audio only: a podcast cover.
// - Download: the export (1080p MP4 from the originals; Audio only: the cleaned audio and the transcript).
// Audio only skips Scenes and Build (its format has no Plan or Build step).
import { simpleSteps, simpleProgress, shapeOfType } from './simple.js';

export const ROUGH_CUT = ['prepare', 'sections', 'lock'];

// ---- the tools (Captions · Music · Text · Effects) ----
export const CAPTION_LOOKS = { clean: 'Clean', bold: 'Bold', boxed: 'Boxed' };
export const INTENSITY = { 0.6: 'Subtle', 1: 'Normal', 1.4: 'Strong' };
export const DEFAULT_TOOLS = { captions: { on: true, look: 'clean' }, effects: { zooms: true, intensity: 1 }, music: null };
const clampN = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
// The tools as saved (project.json simpleTools), with every field checked; unknown fields are dropped.
export function cleanTools(t = {}) {
  const c = t?.captions || {}, e = t?.effects || {}, m = t?.music;
  return {
    captions: { on: c.on !== false, look: Object.hasOwn(CAPTION_LOOKS, c.look) ? c.look : 'clean' },
    effects: { zooms: e.zooms !== false, intensity: clampN(e.intensity, 0.25, 2, 1) },
    music: m && typeof m === 'object' && typeof m.cue === 'string' && m.cue
      ? { cue: m.cue.slice(0, 40), file: String(m.file || '').slice(0, 300), label: String(m.label || '').slice(0, 80), gain: clampN(m.gain, -24, 12, 0) }
      : null,
  };
}
export const toolsOf = (P) => cleanTools(P?.simpleTools || DEFAULT_TOOLS);

// What Simple's Download sends with the export, from the tools: burned captions in the chosen look (the Subtitles
// line settings of exportkinds.js, its defaults) and the zoom effects.
export const SUBTITLE_DEFAULTS = { format: 'srt', maxChars: 42, maxLines: 2, maxDur: 6, minGap: 0.1, pauses: true };
export function exportOptions(P) {
  const t = toolsOf(P);
  return { captions: t.captions.on ? { ...SUBTITLE_DEFAULTS, look: t.captions.look } : null, effects: { ...t.effects } };
}

// ---- small words ----
export const mmss = (s) => { const t = Math.max(0, Math.round(Number(s) || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const stepOf = (P, id) => P?.pipeline?.steps?.find((s) => s.id === id) || null;
const hasTake = (P) => Boolean(P?.canvas?.screen || P?.canvas?.cam || P?.canvas?.audio);
export const isAudio = (P) => shapeOfType(P?.type) === 'audio';

// ---- what the Download gives ----
// The final video: the newest Export → Video render (server/index.mjs listRenders kind 'export'), or the render marked
// final. Audio only: the newest cleaned audio and transcript (server/export-text.mjs listTextExports).
export function finalVideo(P) {
  const list = P?.renders || [];
  return list.find((r) => r.file === P?.finalRender) || list.find((r) => r.kind === 'export') || null;
}
export function audioFiles(P) {
  const list = P?.textExports || [];
  return { audio: list.find((x) => x.kind === 'audio' && x.ext === 'wav') || list.find((x) => x.kind === 'audio') || null,
    mp3: list.find((x) => x.kind === 'audio' && x.ext === 'mp3') || null,
    transcript: list.find((x) => x.kind === 'transcript') || null };
}
// What the top bar's Download (and the Download card) gives: { kind: 'video' | 'audio', files: [{ file, label }], ready }.
export function downloadTarget(P) {
  if (isAudio(P)) {
    const a = audioFiles(P);
    const files = [a.audio && { file: a.audio.file, label: `Audio (${a.audio.ext.toUpperCase()})` }, a.mp3 && a.audio !== a.mp3 && { file: a.mp3.file, label: 'Audio (MP3)' },
      a.transcript && { file: a.transcript.file, label: 'Transcript' }].filter(Boolean);
    return { kind: 'audio', files, ready: Boolean(a.audio) };
  }
  const v = finalVideo(P);
  return { kind: 'video', files: v ? [{ file: v.file, label: 'Video (MP4)' }] : [], ready: Boolean(v) };
}

// ---- Rough cut: prepare → sections → lock, back to back ----
// phase: start (nothing run yet) | running | listen (one spot to check, not answered yet) | continue (the next step
// waits: the chain runs it) | done. next: the pipeline step to run next.
export function roughCutState(P, { listened = false } = {}) {
  const steps = ROUGH_CUT.map((id) => stepOf(P, id)).filter(Boolean);
  if (!steps.length) return { phase: 'done', next: null };
  const next = steps.find((s) => !s.done)?.id || null;
  if (!next) return { phase: 'done', next: null };
  if (P.busy && ROUGH_CUT.includes(P.running)) return { phase: 'running', next, step: P.running };
  const prep = stepOf(P, 'prepare');
  if (prep?.done && !listened && Number(P.prepare?.needs) > 0) return { phase: 'listen', next };
  return { phase: prep?.done ? 'continue' : 'start', next };
}

// The step Simple is on: the six steps' progress (web/simple.js simpleProgress), except that Thumbnail is offered once
// before Download (optional: Use this one or Skip), and Record stays until the creator keeps the take.
export function simpleStepNow(P, ctx = {}) {
  if (!P?.pipeline) return hasTake(P) ? 'download' : 'record';
  const prog = simpleProgress(P.pipeline, { exported: downloadTarget(P).ready });
  const cur = prog.current;
  if (!hasTake(P) || ctx.recording) return 'record';
  const prep = stepOf(P, 'prepare');
  if (cur === 'rough-cut' && !prep?.done && !(P.busy && P.running === 'prepare') && !ctx.kept) return 'record';
  const thumb = prog.steps.find((s) => s.id === 'thumbnail');
  if ((cur === 'download' || cur === null) && thumb && !thumb.done && !thumb.skipped && !ctx.pastThumb) return 'thumbnail';
  return cur || 'download';
}

// The progress line: the six steps, done / current / todo / skipped, with `now` (simpleStepNow) as the current one.
export function progressLine(P, now) {
  const prog = simpleProgress(P?.pipeline || { steps: [] }, { exported: downloadTarget(P).ready });
  const order = prog.steps.map((s) => s.id), at = order.indexOf(now);
  return prog.steps.map((s, i) => ({ id: s.id, label: s.label,
    state: s.id === now ? 'current' : s.skipped || (s.optional && s.run.length && s.run.every((x) => stepOf(P, x)?.skipped)) ? 'skipped' : s.done || (i < at && s.optional) ? 'done' : 'todo' }));
}

// ---- the step card ----
// ctx: { take: { duration }, takes: [{ id, n, duration, canvas }], deleted: { label, trash }, kept, listened, spot (the
// listen item: { what, a }), thumbs: { state: 'none'|'running'|'ready'|'failed', items, picked, error }, exporting:
// { progress } | null, exportError, posting, postDone, planChange (the Change something box open), errors }
// → { step, say: [lines], title, lines: [], buttons: [{ a, label, kind }], busy, progress, extra }
export function stepCard(P, ctx = {}) {
  const step = simpleStepNow(P, ctx), audio = isAudio(P), who = ctx.agent || 'Claude';
  const card = { step, say: [], title: '', lines: [], buttons: [], busy: false, progress: null, extra: null };
  // Errors: one sentence and one button.
  if (P?.unfinished && !P.busy) {
    const s = stepOf(P, P.unfinished.step);
    return { ...card, error: true, title: `${who} stopped before finishing ${s ? lower(s.name) : 'that step'}.`, buttons: [{ a: 'retry', label: 'Try again', kind: 'primary' }] };
  }
  if (ctx.exportError && step === 'download') return { ...card, error: true, title: ctx.exportError, buttons: [{ a: 'export', label: 'Try again', kind: 'primary' }] };
  if (step === 'record') {
    if (!hasTake(P)) {
      return { ...card, say: [`Paste your script, or ask me to write one. When you press Record, it fills the window as a teleprompter.`], extra: 'record-page' };
    }
    const d = ctx.take?.duration ?? P.export?.duration ?? 0;
    return { ...card, title: `Got it, ${mmss(d)} recorded.`, lines: [audio ? 'Keep it and I’ll clean it up: pauses, ums and retakes.' : 'Keep it and I’ll make the rough cut: pauses, ums and retakes out.'],
      buttons: [{ a: 'keep', label: 'Keep · Rough cut next', kind: 'primary' }, { a: 'again', label: 'Record again' }, { a: 'delete', label: 'Delete take' }], extra: 'takes' };
  }
  if (step === 'rough-cut') {
    const rc = roughCutState(P, ctx);
    if (rc.phase === 'running' || (ctx.chain && rc.phase === 'continue')) {
      const what = { prepare: 'Transcribing and taking out the pauses, ums and retakes…', sections: 'Splitting it into parts…', lock: 'Checking the joins and locking the cut…' }[rc.step || rc.next];
      return { ...card, title: 'Making the rough cut…', lines: [what], busy: true };
    }
    if (rc.phase === 'listen') {
      const spot = ctx.spot;
      return { ...card, title: spot ? `One spot needs your ear: ${spot.what}` : 'One spot needs your ear.', lines: ['Want to listen?'],
        buttons: [{ a: 'listen', label: 'Listen' }, { a: 'keep-spot', label: 'Keep it' }, { a: 'cut-spot', label: 'Cut it' }] };
    }
    if (rc.phase === 'start') return { ...card, title: 'Ready for the rough cut.', lines: ['I take out the pauses, ums and retakes, then lock the cut.'], buttons: [{ a: 'rough', label: 'Make the rough cut', kind: 'primary' }] };
    if (rc.phase === 'continue') return { ...card, title: 'Almost there.', lines: [rc.next === 'lock' ? 'Next I check the joins and lock the cut.' : 'Next I split it into parts and lock the cut.'], buttons: [{ a: 'rough', label: 'Continue', kind: 'primary' }] };
  }
  const roughLine = () => {
    const cut = P.export?.cut, n = Number(/(\d+) cuts?\b/.exec(P.prepare?.summary || '')?.[1] || 0);
    const len = cut?.duration ? ` It’s now ${mmss(cut.duration)}.` : '';
    return `Rough cut done: ${n ? `I took out ${plural(n, 'part')}` : 'I cleaned it up'}.${len} The crossed-out words are gone; click one to bring it back.`;
  };
  if (step === 'scenes') {
    const plan = P.pipeline.steps.find((s) => s.stage === 'Plan');
    if (P.busy && plan && P.running === plan.id) return { ...card, title: 'Planning your scenes…', lines: ['What’s on screen for each part, with zooms and titles.'], busy: true };
    if (plan?.awaiting === 'approve') {
      const n = Number(ctx.sceneCount) || Number(P.scenes?.count) || 0;
      return { ...card, title: n ? `Here’s the plan: ${plural(n, 'scene')}.` : 'Here’s the plan.', lines: ['Does this look right?'], extra: 'scenes',
        buttons: ctx.planChange ? [] : [{ a: 'approve', label: 'Looks good, build it', kind: 'primary' }, { a: 'change', label: 'Change something' }],
        foot: 'You can also just type, e.g. “make the title bigger” or “no zoom in scene 2”.' };
    }
    return { ...card, say: [roughLine()], title: 'Next: scenes.', lines: ['I’ll plan what’s on screen for each part, with zooms and titles.'], buttons: [{ a: 'plan', label: 'Continue', kind: 'primary' }] };
  }
  if (step === 'build') {
    const ids = simpleSteps(P.pipeline.steps).find((s) => s.id === 'build')?.run || [];
    if (P.busy && ids.includes(P.running)) {
      const b = P.build, total = b?.total || 0, built = b?.built || 0;
      const n = b ? Math.min(total, built + 1) : 0;
      const left = b && built && P.runningAt ? Math.round(((Date.now() - P.runningAt) / built) * (total - built) / 60000) : null;
      return { ...card, title: 'Building your video…', lines: [total ? `Scene ${n} of ${total}` : 'Working through the scenes.',
        left == null ? 'You can watch the finished scenes already.' : `${left <= 1 ? 'About a minute' : `About ${left} minutes`} left. You can watch the finished scenes already.`],
      busy: true, progress: total ? built / total : null, extra: 'build' };
    }
    return { ...card, title: 'The plan is approved.', lines: ['I’ll build each scene and put the video together.'], buttons: [{ a: 'build', label: 'Build it', kind: 'primary' }] };
  }
  if (step === 'thumbnail') {
    const t = ctx.thumbs || { state: 'none' };
    const what = audio ? 'a podcast cover' : 'a thumbnail';
    const lead = audio ? 'Your audio is clean.' : 'Your video is built.';
    if (t.state === 'running') return { ...card, title: `Making six ${audio ? 'covers' : 'thumbnails'}…`, lines: ['Codex is drawing them from your video and title.'], busy: true, buttons: [{ a: 'skip-thumb', label: 'Skip' }] };
    if (t.state === 'ready') return { ...card, title: 'Pick the one you like.', lines: ['I can tweak it: “bigger face”, “yellow text”.'], extra: 'thumbs',
      buttons: [{ a: 'use-thumb', label: 'Use this one', kind: 'primary', disabled: !t.picked }, { a: 'skip-thumb', label: 'Skip' }] };
    if (t.state === 'failed') return { ...card, error: true, title: t.error || 'The thumbnails didn’t come.', buttons: [{ a: 'make-thumbs', label: 'Try again', kind: 'primary' }, { a: 'skip-thumb', label: 'Skip' }] };
    return { ...card, say: audio && stepOf(P, 'lock')?.done ? [roughLine()] : [], title: `${lead} Want ${what}?`, lines: [`I’ll make six from your ${audio ? 'audio' : 'video'} and its title.`],
      buttons: [{ a: 'make-thumbs', label: 'Make six', kind: 'primary' }, { a: 'skip-thumb', label: 'Skip' }] };
  }
  // download
  const tgt = downloadTarget(P);
  if (ctx.exporting) return { ...card, title: audio ? 'Getting your audio ready…' : 'Making your video…', lines: [audio ? 'The cleaned audio and the transcript.' : 'MP4 · 1080p, from your original recording.'], busy: true, progress: ctx.exporting.progress ?? null };
  if (!tgt.ready) return { ...card, title: audio ? 'Your audio is clean.' : 'Your video is built.', lines: [audio ? 'I’ll make the WAV, an MP3 and the transcript.' : 'I’ll make the final MP4, 1080p, from your original recording.'], buttons: [{ a: 'export', label: audio ? 'Get the audio' : 'Make the video', kind: 'primary' }] };
  const v = finalVideo(P), len = audio ? audioFiles(P).audio?.duration : v?.duration;
  return { ...card, title: `Your ${audio ? 'audio' : 'video'} is ready${len ? `: ${mmss(len)}` : ''}.`, extra: 'download',
    lines: [audio ? 'WAV and MP3, with the transcript.' : 'MP4 · 1080p, ready for YouTube.'],
    post: !audio && !ctx.postDone ? (ctx.posting ? 'writing' : 'offer') : null,
    buttons: [{ a: 'export', label: 'Make it again' }],
    foot: 'Not quite right? Just tell me what to change, then Make it again.' };
}
const lower = (s) => String(s || '').replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase());

// ---- what Simple hides (code kept; Advanced shows it) ----
// The editor surfaces one-editor §0.2 and V1 §1 hide in Simple, by their selectors in the beta.23 editor. simple.css
// hides them under .project.simple / body.simple-editor; test/simple-editor.test.mjs checks the list against both.
export const SIMPLE_HIDDEN = [
  { what: 'stage menus and checklists (the stage bar)', sel: '#rail' },
  { what: 'the dock and its step checklist', sel: '.dock' },
  { what: 'the change package and the Cut tab bar', sel: '.cut-bar' },
  { what: 'the inspector: Edit, Media, Zoom and scene properties', sel: '.inspector' },
  { what: 'the workspace bar and pane tools', sel: '.ws-bar' },
  { what: 'media layers and the scene timeline lanes', sel: '.timeline' },
  { what: 'the blocks strip', sel: '.blocks-strip' },
  { what: 'Export and its advanced options', sel: '#exportBtn' },
  { what: 'the Advanced record button', sel: '#recBtn' },
  { what: 'permission mode and model pickers', sel: '#chatCtl' },
  { what: 'folding Claude away (⌘J)', sel: '.chat-fold' },
];

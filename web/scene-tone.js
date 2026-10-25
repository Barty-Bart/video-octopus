// A scene's state in the Scenes list (web/scenes.js), as plain rules with no DOM (test/flow-b.test.mjs).
// built: some finished render reaches into the scene (server/built.mjs builtEnd / isBuilt, the longest render).
// inRender: the render picked in Scenes (the newest one by default) reaches it. After a partial Build (only the intro)
// the scenes that render doesn't reach are "Not in this build": a quiet state, not "To review" over a black picture (B5a).
export const TONE_LABEL = { ok: 'Approved', changed: 'Changed · rewatch', question: 'Claude asks', sent: 'With Claude', notes: '', waiting: 'Changes waiting', none: 'To review', unbuilt: 'Not built yet', notin: 'Not in this build',
  queued: 'Queued', building: 'Building…', fresh: 'Built' };
export const TONE_DOT = { ok: 'var(--ok)', changed: 'var(--accent)', question: 'var(--accent)', sent: 'var(--warn)', notes: 'var(--sel)', waiting: 'var(--accent)', none: 'var(--line-2)', unbuilt: 'transparent', notin: 'transparent',
  queued: 'var(--line-2)', building: 'var(--accent)', fresh: 'var(--ok)' };
// While a Build runs and Claude marks its scenes (B5b, server/build-progress.mjs): its state per scene wins.
const RUN_TONE = { queued: 'queued', building: 'building', built: 'fresh', notin: 'notin' };

// notes: the scene's notes that aren't resolved. run: the running Build's state for this scene (queued, building,
// built, notin), or null when no Build runs or Claude marks nothing.
export function sceneTone({ approved = false, notes = [], built = false, inRender = true, run = null } = {}) {
  if (run && RUN_TONE[run]) return run === 'notin' && approved && built ? 'ok' : RUN_TONE[run];
  if (approved && built) return 'ok';
  if (notes.some((n) => n.status === 'question')) return 'question';
  if (notes.some((n) => n.status === 'done')) return 'changed';
  if (notes.some((n) => n.status === 'sent')) return 'sent';
  if (notes.some((n) => n.status === 'open' && n.kind !== 'change')) return 'notes';
  if (notes.some((n) => n.status === 'open')) return 'waiting';
  if (!built) return 'unbuilt';
  return inRender ? 'none' : 'notin';
}

// A row in the list: the picture is quiet (striped, no black frame) when the picked render has no picture of the scene;
// an unbuilt or not-in-this-build scene says so once, on that picture, and not again in the line under the title (A14).
// During a Build (B5b) the picture says Queued or Building… (quiet until there is a picture), and Built in the line.
export function sceneRow({ tone, text, built = false, inRender = true }) {
  const label = ['unbuilt', 'notin', 'queued', 'building'].includes(tone) ? TONE_LABEL[tone] : null;
  return { quiet: !built || !inRender || tone === 'queued' || tone === 'building', picture: label, line: label ? null : text, busy: tone === 'building' };
}
// The list's legend while a Build runs: "Building · scene 3 of 10".
export function buildLegend(b) {
  if (!b?.marked || !b.total) return '';
  return b.current ? `Building · scene ${b.current.k} of ${b.total}` : `${b.built} of ${b.total} built`;
}

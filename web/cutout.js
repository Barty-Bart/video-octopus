// Cutouts inside Build (V1 spec §7, Decision 6): the pure rules the server and the page share. No DOM, no state.
//
// The plan (production-sheet 1.3.0) flags a scene that needs its subject cut out of the background with `cutout: true`
// and says what with `cutout_subject` ("speaker" when left out); a `cutout` layout needs one too. Build runs object
// separation (the object-separation skill, SAM 2.1) for those scenes only, before building each, and records what
// came of it with the sheet helper (`sheet.py cutout … done|skipped <id>`): `cutout_result` and, when skipped,
// `cutout_why`. While it separates, the scene's status is `cutting`. When object separation can't run here (no Python
// that can import SAM 2's video model, no SAM 2.1 model downloaded), Video Octopus says so in work/cutouts.json when
// the Build starts (server/roto.mjs), and the scene builds with its plain layout and a note with a Set up link.

// Where Set up goes: Setup, opened at Python environments and the Object separation row (web/setup.js focus).
export const SETUP_HREF = '#/setup/objsep';

// Why a scene was built without its cutout, in one plain line each.
export const CUTOUT_WHY = {
  'no-python': 'No Python that can run object separation is selected.',
  'no-packages': 'The selected Python can’t run SAM 2.1 yet (it needs torch, torchvision and transformers 4.56+).',
  'no-model': 'The SAM 2.1 model isn’t downloaded yet. Setup downloads it when you say so.',
  failed: 'Object separation didn’t work on this scene.',
};
export const whyText = (why) => CUTOUT_WHY[why] || (why ? String(why) : CUTOUT_WHY.failed);

// Does this production-sheet scene (as written in work/production.json) need a cutout?
export const needsCutout = (s) => Boolean(s) && (s.cutout === true || String(s.layout || s.shot || '') === 'cutout');
// What to cut out: "speaker" unless the plan names something else (product, hand, "the mug").
export const subjectOf = (s) => String(s?.cutout_subject || '').trim().slice(0, 60) || 'speaker';
// "you" for the person on camera, else the subject's own words.
const PERSON = /^(speaker|presenter|person|me|you|host|creator|face)$/i;
export const subjectWords = (subject) => (PERSON.test(String(subject || 'speaker').trim()) ? 'you' : String(subject).trim().replace(/^(the\s+)?/i, 'the '));

// A flagged scene's cutout: { subject, state, why, text } or null for a scene that needs none.
// state: cutting (separating now) | done (the masks are made) | skipped (built with the plain layout) | planned.
// doc: work/cutouts.json ({ ready, why, scenes: [ids] }, what Video Octopus found when the Build started).
export function cutoutOf(s, doc = null) {
  if (!needsCutout(s)) return null;
  const id = String(s.id), subject = subjectOf(s), status = String(s.status || 'planned');
  const result = String(s.cutout_result || '');
  let state = 'planned', why = null;
  if (status === 'cutting') state = 'cutting';
  else if (result === 'done') state = 'done';
  else if (result === 'skipped') { state = 'skipped'; why = String(s.cutout_why || '') || (doc && doc.ready === false ? doc.why : 'failed'); }
  // The Build started without object separation here and the scene got built: it was built without the cutout, also
  // when the builder forgot to say so.
  else if (doc && doc.ready === false && (doc.scenes || []).map(String).includes(id) && ['built', 'approved'].includes(status)) { state = 'skipped'; why = doc.why; }
  return { subject, state, why, text: state === 'skipped' ? whyText(why) : '' };
}

// The line a running Build shows while a scene is being cut out: "Cutting you out for scene 3…".
// n: the scene's number in the sheet.
export const cuttingLine = (n, subject = 'speaker') => `Cutting ${subjectWords(subject)} out for scene ${n}…`;

// The fallback note for one scene, as the Build card and Scenes show it.
export const FALLBACK = 'Built without the cutout';
export const fallbackNote = (n, c) => ({ n, text: `Scene ${n}: ${FALLBACK}`, why: c?.text || whyText(c?.why), href: SETUP_HREF, link: 'Set up' });

// From the project view's cutouts summary (server/roto.mjs cutoutSummary: { scenes: [{ id, n, subject, state, why,
// text }], ready, why }): the fallback notes to show, one per skipped scene, in sheet order.
export const fallbackNotes = (summary) => (summary?.scenes || []).filter((c) => c.state === 'skipped').map((c) => fallbackNote(c.n, c));

// For Simple's Build card (one-editor §0.2 / V1 §5) and anything else that shows a Build: from the project view
// (/api/projects/<id>: build, cutouts), { line, notes }. line: "Cutting you out for scene 3…" while a scene's subject is
// being cut out, else ''. notes: one per scene built without its cutout, each with its Set up link.
export function buildCutouts(P) {
  const cur = P?.build?.current;
  return { line: cur?.cutting ? cuttingLine(cur.n, cur.subject) : '', notes: fallbackNotes(P?.cutouts) };
}
// The notes as HTML (esc: the page's escaper): "Scene 3: Built without the cutout · Set up", the reason as a tooltip.
export const cutoutNotesHTML = (notes, esc) => notes.map((x) => `<p class="cut-fb sub" role="note" title="${esc(x.why)}">${esc(x.text)} · <a href="${esc(x.href)}">${esc(x.link)}</a></p>`).join('');

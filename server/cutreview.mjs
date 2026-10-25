// The Cut tab's review data: Claude's reason for every cut (work/cuts.json, from the rough cut), what Prepare left
// for the creator's ear (work/prepare.json "ask", plus likely clipped joins from work/joins.json), and the creator's
// Keep / Cut decisions on them (work/cut_review.json, Video Octopus's own file). The decisions themselves change the cut in
// the Cut Editor (the page does the edit, so its undo, autosave and the change package all work as for any edit);
// this file only remembers which ones are decided, so the list and the rail's "N need you" count down.
// "Needs you" has one meaning everywhere (needsYou): the parts in the list's To check that nobody has decided yet.
// A part is decided by Keep / Cut in the list, by a direct edit over it in the Cut tab or Scenes (markEdits), or by
// locking the cut (what was skipped stays as it is: settled on the lock). The done line, the dock, the Cut chip, the
// Cut inspector and the list all read it from here.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJSON, writeJSON, mtime } from './util.mjs';
import { cutPlan } from './cuteditor.mjs';
import { lockedCut, cutCount, cutChanges, appendWorklog, projectMeta, saveProjectMeta } from './studio.mjs';

export const REVIEW = 'work/cut_review.json';
const r3 = (x) => Math.round(x * 1000) / 1000;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const KIND = { silence: 'Pause', filler: 'Filler', stutter: 'Stutter', retake: 'Retake' };
const kindOf = (it) => (it.reason === 'filler' && /^\[sound/i.test(it.text || '') ? 'Sound' : KIND[it.reason] || String(it.reason || 'Cut').replace(/^./, (c) => c.toUpperCase()));

// [a, b] minus the given ranges (each [p, q]).
function subtract([a, b], holes) {
  let out = [[a, b]];
  for (const [p, q] of holes) out = out.flatMap(([x, y]) => (q <= x || p >= y ? [[x, y]] : [...(p > x ? [[x, p]] : []), ...(q < y ? [[q, y]] : [])]));
  return out.filter(([x, y]) => y - x > 0.01).map(([x, y]) => [r3(x), r3(y)]);
}

const len = (R) => R.reduce((s, [a, b]) => s + (b - a), 0);
function overlap(R, segs) {
  let k = 0;
  for (const [a, b] of R) for (const [p, q] of segs) { if (q <= a || p >= b) continue; k += Math.min(b, q) - Math.max(a, p); }
  return k;
}
// Did join-check's fix (in segs, work/edl_fixed.json) resolve this join? A chopped word: the bit it brings back is in
// the cut. A leftover: the bit it trims is out of it.
function joinFixed(j, segs) {
  const bits = [];
  if (j.trim[0] > 0 || j.trim[1] > 0) {
    if (j.trim[0] > 0) bits.push([j.out - j.trim[0] / 1000, j.out]);
    if (j.trim[1] > 0) bits.push([j.in, j.in + j.trim[1] / 1000]);
    return overlap(bits, segs) <= 0.1 * len(bits);
  }
  if (j.fix[0] > 0) bits.push([j.out, j.out + j.fix[0] / 1000]);
  if (j.fix[1] > 0) bits.push([j.in - j.fix[1] / 1000, j.in]);
  return bits.length > 0 && overlap(bits, segs) >= 0.9 * len(bits);
}

// The part a Prepare question means, in take seconds, on whole words: from its "t" to its "end" when it says one
// (the brief asks for it on anything longer than a word); else the words it quotes ("Opening false starts: “Hello
// legends, … howdy guys.”"), found in the transcript from t on; else the word at t.
const tok = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
function askRange(q, t, what, words) {
  let i0 = 0;
  for (let i = 0; i < words.length; i++) if (Math.abs(words[i][0] - t) < Math.abs(words[i0][0] - t)) i0 = i;
  const end = Number(q.end);
  if (isNum(end) && end > t + 0.05) {
    const ws = words.filter((w) => (w[0] + w[1]) / 2 >= t - 0.05 && (w[0] + w[1]) / 2 <= end + 0.05);
    return ws.length ? [r3(ws[0][0]), r3(ws.at(-1)[1])] : [r3(t), r3(end)];
  }
  const quoted = /[“"]([^”"]{1,800})[”"]/.exec(what);
  const toks = quoted ? quoted[1].split(/\s+/).map(tok).filter(Boolean) : [];
  if (toks.length > 1) {
    // The first quoted word near t (within 1.5 s), then each next one at most a few words on.
    let start = -1;
    for (let i = 0; i < words.length; i++) {
      if (Math.abs(words[i][0] - t) > 1.5 || tok(words[i][2]) !== toks[0]) continue;
      if (start < 0 || Math.abs(words[i][0] - t) < Math.abs(words[start][0] - t)) start = i;
    }
    if (start >= 0) {
      let j = start + 1, last = start, hit = 1;
      for (const k of toks.slice(1)) {
        const f = words.slice(j, j + 4).findIndex((w) => tok(w[2]) === k);
        if (f < 0) continue;
        last = j + f; j = last + 1; hit++;
      }
      if (hit >= Math.max(2, Math.ceil(0.6 * toks.length))) return [r3(words[start][0]), r3(words[last][1])];
    }
  }
  return [r3(Math.min(t, words[i0][0])), r3(Math.max(words[i0][1], t + 0.3))];
}

// Built once per change of the files it reads (the project view asks on every refresh for the rail's count).
const cache = new Map(); // dir -> { sig, data }
const WORDS = ['work/words_refined.json', 'work/editor_words.json', 'work/tr/words.json', 'work/words.json']; // (cuteditor.mjs cutPlan's order)
function build(dir) {
  const plan = cutPlan(dir);
  // The words, also while the Cut Editor can't open yet (its playback copy is still being made).
  const wordsFile = plan.words || WORDS.find((f) => existsSync(join(dir, f))) || null;
  const files = ['work/cuts.json', 'work/prepare.json', 'work/joins.json', 'work/edl_fixed.json', wordsFile].filter(Boolean);
  const sig = files.map((f) => `${f}:${mtime(join(dir, f))}`).join('|');
  const hit = cache.get(dir);
  if (hit && hit.sig === sig) return hit.data;

  const cutsDoc = readJSON(join(dir, 'work/cuts.json'), null);
  const cuts = (Array.isArray(cutsDoc?.items) ? cutsDoc.items : []).filter((it) => isNum(it.start) && isNum(it.end) && it.end > it.start)
    .map((it) => ({ id: it.id, a: r3(it.start), b: r3(it.end), reason: it.reason || '', kind: kindOf(it), text: String(it.text || '').slice(0, 300),
      note: String(it.note || '').trim().slice(0, 300), action: it.action === 'cut' ? 'cut' : 'ask',
      saved: isNum(it.saved) && it.saved > 0 ? r3(Math.min(it.saved, it.end - it.start)) : r3(it.end - it.start) }));
  const jdoc = readJSON(join(dir, 'work/joins.json'), null);
  const joins = (Array.isArray(jdoc?.joins) ? jdoc.joins : []).filter((j) => j.status && j.status !== 'ok' && isNum(j.src_out) && isNum(j.src_in))
    .map((j) => ({ k: j.k ?? j.rank, out: r3(j.src_out), in: r3(j.src_in), status: j.status, word: j.in?.word || j.out?.word || null,
      why: [...(j.out?.why || []), ...(j.in?.why || [])].join('; ').slice(0, 200),
      fix: [Number(j.fix_ms?.[0]) || Number(j.out?.chopped_ms) || 0, Number(j.fix_ms?.[1]) || Number(j.in?.chopped_ms) || 0],
      trim: [Number(j.trim_ms?.[0]) || 0, Number(j.trim_ms?.[1]) || 0] }));
  // A join join-check's own fix already resolved (work/edl_fixed.json has it: the chopped bit is back, or the leftover
  // is gone) is fixed, not one to check: Claude's Clean up reply doesn't count it either. joins.json describes the cut
  // before the fix (the rough cut), so the fix is read from the cut it wrote.
  const fixedSegs = readJSON(join(dir, 'work/edl_fixed.json'), null)?.segments_sec;
  if (Array.isArray(fixedSegs) && fixedSegs.length) for (const j of joins) j.fixed = joinFixed(j, fixedSegs);
  const prep = readJSON(join(dir, 'work/prepare.json'), null);
  const asks = Array.isArray(prep?.ask) ? prep.ask.filter((q) => isNum(Number(q?.t))) : [];
  const words = wordsFile ? readJSON(join(dir, wordsFile), []) : [];

  const items = [], used = new Set();
  const cutItem = (c, group, ask) => {
    used.add(`c${c.id}`);
    // Keep brings the part back, but not the pauses Claude cut inside it (a retake keeps its own cut pause).
    const inner = cuts.filter((o) => o !== c && o.action === 'cut' && o.a < c.b && o.b > c.a && o.b - o.a < c.b - c.a).map((o) => [o.a, o.b]);
    // saved: what Claude's cut removes (a pause keeps a little of itself, so only part of a..b goes).
    items.push({ key: `c${c.id}`, group, kind: c.kind, a: c.a, b: c.b, saved: c.saved, text: c.text, ask: ask || null, note: c.note,
      keep: subtract([c.a, c.b], inner), cut: [[c.a, c.b]], play: 'raw' });
  };
  const joinItem = (j, group, ask) => {
    used.add(`j${j.k}`);
    if (j.trim[0] > 0 || j.trim[1] > 0) {
      // A leftover: a cut word still sounding past the cut (join-check's fix trims it, in edl_fixed.json).
      const bits = [];
      if (j.trim[0] > 0) bits.push([r3(j.out - j.trim[0] / 1000), j.out]);
      if (j.trim[1] > 0) bits.push([j.in, r3(j.in + j.trim[1] / 1000)]);
      const ms = Math.round(j.trim[0] + j.trim[1]);
      items.push({ key: `j${j.k}`, group, kind: 'Join', a: j.out, b: j.in, saved: r3(ms / 1000), text: ask || `Join ${j.status}: ${j.why}`, ask: null,
        note: `Cut takes out the ${ms} ms of ${j.word ? `“${j.word}”` : 'the cut word'} the cut left in; Keep leaves it in.`, keep: bits, cut: bits, play: 'cut', status: j.status });
      return;
    }
    // The bit of the word the join chops: the fix join-check suggests (already in edl_fixed.json), else what it measured.
    const bits = [];
    if (j.fix[0] > 0) bits.push([j.out, r3(j.out + j.fix[0] / 1000)]);
    if (j.fix[1] > 0) bits.push([r3(j.in - j.fix[1] / 1000), j.in]);
    const ms = Math.round(j.fix[0] + j.fix[1]);
    items.push({ key: `j${j.k}`, group, kind: 'Join', a: j.out, b: j.in, saved: r3((j.fix[0] + j.fix[1]) / 1000), text: ask || `Join ${j.status}: ${j.why}`, ask: null,
      note: bits.length ? `Keep brings back ${ms} ms so ${j.word ? `“${j.word}”` : 'the word'} is whole; Cut leaves the join where the rough cut put it.` : j.why,
      keep: bits, cut: bits, play: 'cut', status: j.status });
  };
  const nearJoin = (t, tol) => joins.find((j) => !used.has(`j${j.k}`) && !j.fixed && (Math.abs(j.in - t) < tol || Math.abs(j.out - t) < tol));
  const nearCut = (t) => cuts.find((c) => !used.has(`c${c.id}`) && Math.abs(c.a - t) < 0.06)
    || cuts.find((c) => !used.has(`c${c.id}`) && c.action === 'ask' && t >= c.a - 0.05 && t <= c.b);
  for (const q of asks) {
    const t = Number(q.t), what = String(q.what || '').slice(0, 300);
    const joinFirst = /\bjoin|clipp/i.test(what);
    // A clipped join Clean up's fix already resolved: nothing to ask (whatever Prepare wrote about it).
    const fixedJ = joinFirst && joins.find((x) => x.fixed && (Math.abs(x.in - t) < 0.1 || Math.abs(x.out - t) < 0.1));
    if (fixedJ) { used.add(`j${fixedJ.k}`); continue; }
    const j = joinFirst ? nearJoin(t, 0.1) : null, c = j ? null : nearCut(t), j2 = j || c ? null : nearJoin(t, 0.04);
    if (j || j2) joinItem(j || j2, 'ask', what);
    else if (c) cutItem(c, 'ask', what);
    else if (words.length) {
      // Prepare named a moment that is neither a listed cut nor a join: the part it means (false starts, an unfinished
      // ending: a range; else the word there). Keep and Cut act on all of it, on safe edges (the editor's word delete).
      const key = `a${Math.round(t * 100)}`;
      if (used.has(key)) continue;
      used.add(key);
      const [a, b] = askRange(q, t, what, words);
      // Keep brings it back without the pauses Claude cut inside it.
      const inner = cuts.filter((o) => o.action === 'cut' && o.a >= a - 0.02 && o.b <= b + 0.02).map((o) => [o.a, o.b]);
      items.push({ key, group: 'ask', kind: 'Check', a, b, saved: r3(b - a), text: what, ask: null, note: '', keep: subtract([a, b], inner), cut: [[a, b]], play: 'raw', safe: true });
    }
  }
  // Without a prepare.json (or when it skipped some): the cuts the rough cut asked about, and likely clipped joins.
  for (const c of cuts) if (c.action === 'ask' && !used.has(`c${c.id}`)) cutItem(c, 'ask');
  for (const j of joins) if (j.status === 'likely clipped' && !j.fixed && !used.has(`j${j.k}`)) joinItem(j, 'ask');
  // The cuts Claude was sure about: listed too, to bring one back.
  for (const c of cuts) if (c.action === 'cut' && !used.has(`c${c.id}`)) cutItem(c, 'auto');
  items.sort((x, y) => x.a - y.a);

  const rmap = readJSON(join(dir, 'work/rough_map.json'), null);
  const duration = Number(cutsDoc?.duration) || Number(rmap?.src_duration) || (words.length ? words[words.length - 1][1] + 1 : 0);
  const data = { cuts, joins, items, duration: r3(duration), summary: typeof prep?.summary === 'string' ? prep.summary.slice(0, 160) : null };
  cache.set(dir, { sig, data });
  return data;
}

// Decisions that still fit their item (same key and range); a new Prepare run makes the old ones fall away.
// key -> { d: 'keep' | 'cut', by: 'list' | 'edit' | 'lock' }
// A Prepare question's part (key a…, from its time) can have a new range on the same question (Video Octopus now reads the
// whole of it): its decision holds if the lock left it, or the cut still shows it.
function decisions(dir, items) {
  const doc = readJSON(join(dir, REVIEW), null);
  if (!doc?.decisions) return {};
  const out = {};
  let segs = null;
  for (const it of items) {
    const d = doc.decisions[it.key];
    if (!d || (d.d !== 'keep' && d.d !== 'cut')) continue;
    const fits = Math.abs((d.a ?? it.a) - it.a) < 0.02 && Math.abs((d.b ?? it.b) - it.b) < 0.02;
    const holds = !fits && it.key[0] === 'a' && (d.by === 'lock' || stateOf(it, segs ??= cutNow(dir)) === (d.d === 'cut' ? 'cut' : 'kept'));
    if (fits || holds) out[it.key] = { d: d.d, by: d.by || 'list' };
  }
  return out;
}

// The cut as it is now: the Cut Editor's file or join-check's fix, whichever is newer (what Video Octopus plays and exports).
function cutNow(dir) {
  const c = lockedCut(dir);
  if (c?.segments?.length) return c.segments;
  const plan = cutPlan(dir);
  return (plan.ready && readJSON(join(dir, plan.edl), null)?.segments_sec) || [];
}
// Cut or kept in a cut, as the Cut inspector's list shows it (web/cutpanel.js stateOf, the same rule).
function stateOf(it, segs) {
  const K = it.keep.length ? it.keep : it.cut, L = len(K);
  if (!L) return null;
  const gone = L - overlap(K, segs);
  if (gone >= Math.max(0.03, 0.3 * Math.min(it.saved || L, L))) return 'cut';
  return gone <= 0.1 * L ? 'kept' : 'mixed';
}
const lockLines = (dir) => { try { return (readFileSync(join(dir, 'WORKLOG.md'), 'utf8').match(/Cut locked/g) || []).length; } catch { return 0; } };
// Unlock to edit (B3): the creator's explicit "Unlock" after a lock, kept in cut_review.json as { at, locks } (the number
// of "Cut locked" lines then). It holds until the next lock (a new "Cut locked" line); WORKLOG also says "Cut unlocked".
const unlockedSince = (doc, n) => Boolean(doc?.unlocked) && Number(doc.unlocked.locks) >= n;
const NOTE = 'Keep / Cut decisions on what Prepare asked about: from the Cut tab\'s list (by "list"), a direct edit there or in Scenes (by "edit"), or left as they were when the cut was locked (by "lock"). Video Octopus keeps this; the cut itself is in the Cut Editor\'s file.';
// Locking the cut settles what nobody decided: it stays as it is in the locked cut. Once per lock (WORKLOG's
// "Cut locked" lines): a later Prepare run's new parts wait for the next lock.
// It also keeps the cut as it was locked (lock.segments), so a later edit shows as "changed after the lock" (lockState).
function settleOnLock(dir, data) {
  const n = lockLines(dir);
  const doc = readJSON(join(dir, REVIEW), null) || {};
  if (n <= (doc.locks || 0)) return;
  const dec = decisions(dir, data.items), segs = cutNow(dir), all = { ...(doc.decisions || {}) }, at = new Date().toISOString();
  for (const it of data.items) if (it.group === 'ask' && !dec[it.key]) all[it.key] = { d: stateOf(it, segs) === 'cut' ? 'cut' : 'keep', by: 'lock', a: it.a, b: it.b, kind: it.kind, at };
  writeJSON(join(dir, REVIEW), { ...doc, v: 1, decisions: all, locks: n, lock: { segments: segs.map(([a, b]) => [r3(Number(a)), r3(Number(b))]), at }, note: NOTE });
}

// Is the cut still the one that was locked? { locked, changed }: changed = an edit since the last "Cut locked" (the
// Lock step then waits to run again: Claude checks the new joins). Read only (Home asks it of every project): the cut
// kept at the lock (settleOnLock, the first time the project's view counts after it), else, for a lock it hasn't kept
// (yet), the cut join-check last checked (work/joins.json).
// unlocked: the creator pressed Unlock to edit since the last lock (the Lock step waits to run again, editing is allowed).
export function lockState(dir) {
  const n = lockLines(dir), imp = !n && importLocked(dir);
  if (!n && !imp) return { locked: false, changed: false, unlocked: false };
  const doc = readJSON(join(dir, REVIEW), null), now = cutNow(dir), ref = doc?.lock?.segments;
  // Done by import (B9): the whole file is the locked cut; an edit since (Claude's, from the chat) undoes it.
  if (imp) return { locked: true, changed: Array.isArray(ref) && ref.length > 0 && now.length > 0 && cutChanges(ref, now).length > 0, unlocked: false, byImport: true };
  const unlocked = unlockedSince(doc, n);
  return { ...lockChanged(dir, n, doc, now, ref), unlocked };
}
function lockChanged(dir, n, doc, now, ref) {
  if (Array.isArray(ref) && ref.length && (doc.locks || 0) >= n) return { locked: true, changed: now.length > 0 && cutChanges(ref, now).length > 0 };
  // Without it: only the creator's own save (work/edl_manual.json: the Cut tab, Scenes) newer than the lock's join check
  // and not the cut it checked counts as changed (join-check's own fix file, edl_fixed.json, never does).
  const j = readJSON(join(dir, 'work/joins.json'), null), file = lockedCut(dir)?.file;
  if (!Array.isArray(j?.joins) || file !== 'work/edl_manual.json' || mtime(join(dir, file)) <= mtime(join(dir, 'work/joins.json')) + 1000) return { locked: true, changed: false };
  const ends = now.slice(0, -1).map((s, i) => [Number(s[1]), Number(now[i + 1][0])]);
  const js = j.joins.filter((x) => isNum(x.src_out) && isNum(x.src_in));
  const same = ends.length === js.length && ends.every(([o, i]) => js.some((x) => Math.abs(x.src_out - o) < 0.005 && Math.abs(x.src_in - i) < 0.005));
  return { locked: true, changed: !same };
}

// The cut is read-only (B3): locked and neither unlocked nor changed since (Claude may still change it from the chat).
export function cutReadOnly(dir) { const s = lockState(dir); return s.locked && !s.changed && !s.unlocked; }
// The lock holds for planning and building (learning.mjs): a "Cut locked" line, not unlocked since.
export function lockHeld(dir) { const s = lockState(dir); return s.locked && !s.unlocked; }
const importLocked = (dir) => (projectMeta(dir)?.doneByImport || []).includes('lock');
// Already-edited footage (B9): the whole-file cut is kept as the lock, so a later edit shows as changed.
export function importLock(dir, segments) {
  const doc = readJSON(join(dir, REVIEW), null) || {};
  writeJSON(join(dir, REVIEW), { ...doc, v: 1, decisions: doc.decisions || {}, locks: 0, lock: { segments, at: new Date().toISOString(), by: 'import' }, note: NOTE });
}
export function clearImportLock(dir) {
  const doc = readJSON(join(dir, REVIEW), null);
  if (doc?.lock?.by !== 'import') return;
  const { lock, ...rest } = doc;
  writeJSON(join(dir, REVIEW), rest);
}
export const LOCKED_ERROR = 'The cut is locked. Unlock it in the Cut tab to edit it; then lock it again.';
// Unlock to edit: the Lock step isn't done any more and Lock is the next step again, as after an edit.
export function unlockCut(dir) {
  const n = lockLines(dir);
  if (!cutReadOnly(dir)) return false;
  if (!n) { // locked by import (B9): Lock the cut is to do again
    saveProjectMeta(dir, { doneByImport: (projectMeta(dir)?.doneByImport || []).filter((x) => x !== 'lock') });
    try { appendWorklog(dir, 'Cut unlocked in the Cut tab, to edit it (Lock the cut again after)'); } catch {}
    return true;
  }
  const doc = readJSON(join(dir, REVIEW), null) || {};
  writeJSON(join(dir, REVIEW), { ...doc, v: 1, decisions: doc.decisions || {}, unlocked: { at: new Date().toISOString(), locks: n }, note: NOTE });
  try { appendWorklog(dir, 'Cut unlocked in the Cut tab, to edit it (Lock the cut again after)'); } catch {}
  return true;
}

export function cutReview(dir) {
  const plan = cutPlan(dir);
  const data = build(dir);
  settleOnLock(dir, data);
  const dec = decisions(dir, data.items);
  // The cut as the Cut Editor opens it (the editor sends the live one once it is open).
  const file = plan.ready ? (readJSON(join(dir, plan.out), null) ? plan.out : plan.edl) : null;
  const segments = (file && readJSON(join(dir, file), null)?.segments_sec) || [];
  const items = data.items.map((it) => ({ ...it, decision: dec[it.key]?.d || null, by: dec[it.key]?.by || null }));
  const needs = items.filter((it) => it.group === 'ask' && !it.decision).length;
  const summary = summaryOf(dir, data, needs);
  return { ready: plan.ready, why: plan.why || null, file, segments, duration: data.duration, summary, needs,
    cuts: data.cuts, joins: data.joins, items, locked: cutReadOnly(dir) };
}

// "Rough cut: 10 cuts, 7 need you": the list's header line, from the same count.
function summaryOf(dir, data, needs) {
  const made = cutCount(dir);
  return data.cuts.length || made ? `Rough cut: ${made} cut${made === 1 ? '' : 's'}, ${needs ? `${needs} need${needs === 1 ? 's' : ''} you` : 'nothing left for you to check'}` : null;
}
export const needsSummary = (dir) => { try { return summaryOf(dir, build(dir), needsYou(dir)); } catch { return null; } };

// What still needs the creator, the one count every place shows: the parts in To check without a decision.
export function needsYou(dir) {
  try {
    const data = build(dir);
    if (!data.items.length) return 0;
    settleOnLock(dir, data); // (the project's view: a new lock settles here, and the cut it locked is kept)
    const dec = decisions(dir, data.items);
    return data.items.filter((it) => it.group === 'ask' && !dec[it.key]).length;
  } catch { return 0; }
}

// A direct edit (the Cut tab, Scenes) is a decision on the parts it touches: whatever the edit left there is the
// creator's call, so they leave To check. before / after: the cut before and after the edit (take seconds).
function minus(A, B) {
  const out = [];
  for (const [a, b] of A) {
    let parts = [[a, b]];
    for (const [c, d] of B) parts = parts.flatMap(([x, y]) => (d <= x || c >= y ? [[x, y]] : [[x, Math.min(y, c)], [Math.max(x, d), y]].filter(([p, q]) => q - p > 0.02)));
    out.push(...parts);
  }
  return out;
}
// Also keeps the cut the creator's editing started from (editBase: the first cut a Cut tab or Scenes edit started
// from since the last Prepare), so "Cut saved: N edits" counts their edits even after Lock rewrites edl_fixed.json.
export function markEdits(dir, before, after) {
  const ok = (L) => Array.isArray(L) && L.every((s) => Array.isArray(s) && isNum(Number(s[0])) && isNum(Number(s[1])));
  if (!ok(before) || !ok(after) || !after.length) return 0;
  const A = before.map(([a, b]) => [Number(a), Number(b)]), B = after.map(([a, b]) => [Number(a), Number(b)]);
  const doc = readJSON(join(dir, REVIEW), null) || {};
  if (!doc.editBase?.segments || Date.parse(doc.editBase.at) < mtime(join(dir, 'work/prepare.json'))) {
    doc.editBase = { segments: A.map(([a, b]) => [r3(a), r3(b)]), at: new Date().toISOString() };
    writeJSON(join(dir, REVIEW), { ...doc, v: 1, decisions: doc.decisions || {}, note: NOTE });
  }
  const changed = [...minus(A, B), ...minus(B, A)];
  const data = build(dir);
  if (!data.items.length) return 0;
  const dec = decisions(dir, data.items), all = { ...(doc.decisions || {}) }, at = new Date().toISOString();
  // An edit undone (the part is back as it was before any edit: the editor's ⌘Z, or the same cut by hand) is no
  // decision any more: the part goes back to To check.
  const E = doc.editBase.segments;
  let undone = 0;
  for (const it of data.items) {
    if (dec[it.key]?.by !== 'edit') continue;
    const lo = Math.min(it.a, it.b) - 0.05, hi = Math.max(it.a, it.b) + 0.05;
    if (sameOver(E, B, lo, hi)) { delete all[it.key]; delete dec[it.key]; undone++; }
  }
  if (!changed.length) { if (undone) writeJSON(join(dir, REVIEW), { ...doc, v: 1, decisions: all, note: NOTE }); return 0; }
  let n = 0;
  for (const it of data.items) {
    if (dec[it.key]) continue;
    const lo = Math.min(it.a, it.b) - 0.05, hi = Math.max(it.a, it.b) + 0.05;
    if (!changed.some(([p, q]) => q > lo && p < hi)) continue;
    all[it.key] = { d: stateOf(it, B) === 'cut' ? 'cut' : 'keep', by: 'edit', a: it.a, b: it.b, kind: it.kind, at };
    n++;
  }
  if (n || undone) writeJSON(join(dir, REVIEW), { ...doc, v: 1, decisions: all, note: NOTE });
  return n;
}
// Two cuts the same between lo and hi (within 2 ms).
function sameOver(A, B, lo, hi) {
  const clip = (L) => L.map(([a, b]) => [Math.max(lo, Number(a)), Math.min(hi, Number(b))]).filter(([a, b]) => b - a > 0.002);
  const x = clip(A), y = clip(B);
  return x.length === y.length && x.every(([a, b], i) => Math.abs(a - y[i][0]) < 0.002 && Math.abs(b - y[i][1]) < 0.002);
}

function decide(dir, patch) {
  const doc = readJSON(join(dir, REVIEW), null) || {};
  const all = { ...(doc.decisions || {}) };
  const items = build(dir).items;
  for (const [key, d] of Object.entries(patch || {})) {
    const it = items.find((x) => x.key === key);
    if (!it) continue;
    if (d === 'keep' || d === 'cut') all[key] = { d, by: 'list', a: it.a, b: it.b, kind: it.kind, at: new Date().toISOString() };
    else delete all[key];
  }
  writeJSON(join(dir, REVIEW), { ...doc, v: 1, decisions: all, note: NOTE });
}

// GET /cut-review → the list; POST {decisions: {key: "keep"|"cut"|null}} → saved, then the list.
export async function cutReviewRoute(req, res, { dir, action, send, body }) {
  if (action !== '/cut-review') return false;
  try {
    if (req.method === 'POST') {
      const b = await body(req);
      if (b.op === 'unlock') unlockCut(dir);
      else { if (cutReadOnly(dir)) throw Object.assign(new Error(LOCKED_ERROR), { status: 409 }); decide(dir, b.decisions); }
    }
    send(res, 200, cutReview(dir));
  } catch (e) { send(res, e.status || 400, { error: e.message }); }
  return true;
}

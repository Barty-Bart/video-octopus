// What happens when one of Claude's turns in a project ends (index.mjs chatFor wires every project chat here):
// - Didn't finish: a step's brief went to Claude (the user event's brief.step) and the turn ended without the step's
//   result (its files, its WORKLOG line). The dock then says so in amber, "Didn't finish: <Claude's one-line reason> ·
//   Read" (web/rail.js), kept in local/state.json (projects[id].unfinished) until the step is done, another step starts
//   or the creator puts it away.
// - Undo: a turn that answered the creator's own message (not a step or another brief) and changed the files the
//   project's window shows (project.json, blocks, sound cues, notes, moves and keys, the post kit, shots, zooms, the cut,
//   the production sheet) can be put back by Video Octopus itself, exactly as they were when the turn began. The quick reply
//   names the files ("Undo the change to blocks.json"); the next message tells Claude what was put back.
// - Proposals: any turn that left new proposed shots or zooms (status "proposed" in work/shots.json, work/zooms.json)
//   adds one block to the chat log: "Claude proposed 3 shots and 6 zooms · Show me · Keep all · No thanks to all"
//   (web/app.js draws it from the event { t: 'proposals', shots: [ids], zooms: [ids] }).
// - Add zooms redoes only Claude's camera punch-ins: a zoom that was there before an Add zooms run (a screen zoom, a
//   creator's own) and is gone after it is put back, with a line in the chat.
import { readFileSync, writeFileSync, existsSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { state, setProjectState } from './util.mjs';
import { projectDir, projectMeta, pipelineStatus } from './studio.mjs';
import { shotsCtx, readShotsAndZooms, ZOOMS } from './shots.mjs';
import { normalizeShots, normalizeZooms, newProposals, proposalWords } from '../web/shots.js';

export const WINDOW_FILES = ['project.json', 'work/blocks.json', 'work/sfx.json', 'work/notes.json', 'work/overrides.json', 'work/post.json',
  'work/shots.json', 'work/zooms.json', 'work/edl_manual.json', 'work/production.json'];
const MAX = 2e6;
const read = (f) => { try { return existsSync(f) && statSync(f).size <= MAX ? readFileSync(f, 'utf8') : existsSync(f) ? undefined : null; } catch { return undefined; } };
const snapshot = (dir) => Object.fromEntries(WINDOW_FILES.map((rel) => [rel, read(join(dir, rel))]));

// Claude's reply in one line: its first sentence, without markdown, at most about 110 characters.
export function oneLine(text) {
  let t = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1').replace(/\*\*|__|^#+\s*/gm, '').replace(/^\s*([-*]|\d+[.)])\s+/gm, '');
  t = t.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  if (m && m[1].length >= 12) t = m[1];
  return t.length > 110 ? `${t.slice(0, 107).replace(/\s+\S*$/, '')}…` : t;
}

const offers = new Map(); // project id -> { id, files: [{ rel, before, after }] }
const turns = new Map();  // project id -> the turn running now

export function trackTurns(id, chat, { broadcast }) {
  chat.listeners.add((ev) => {
    if (ev.t === 'user') {
      // Adapters mark startup/auth discovery busy before echoing the user's message.
      // Attach its metadata without discarding that turn's already-captured files.
      const before = turns.get(id)?.before ?? null;
      turns.set(id, { step: ev.brief?.step || null, human: !ev.brief && !String(ev.text || '').startsWith('/'), text: '', textTs: 0, error: '', ok: true, before });
    }
    else if (ev.t === 'busy' && ev.busy) {
      const dir = projectDir(id);
      const t = turns.get(id) || { step: null, human: false, text: '', textTs: 0, error: '', ok: true };
      t.before = dir ? snapshot(dir) : null;
      turns.set(id, t);
      offers.delete(id); // a new turn: the last one's undo has gone
    } else if (ev.t === 'text') { const t = turns.get(id); if (t) { t.text = ev.text; t.textTs = ev.ts || Date.now(); } }
    else if (ev.t === 'error') { const t = turns.get(id); if (t) t.error = ev.text; }
    else if (ev.t === 'result') { const t = turns.get(id); if (t) t.ok = ev.ok !== false; }
    else if (ev.t === 'busy' && !ev.busy) {
      const t = turns.get(id);
      turns.delete(id);
      if (!t) return;
      const dir = projectDir(id);
      if (!dir) return;
      // Undo first, before the turn's result reaches the page (its quick replies are drawn then).
      if (t.human && t.before) {
        const files = WINDOW_FILES.map((rel) => ({ rel, before: t.before[rel], after: read(join(dir, rel)) }))
          .filter((f) => f.before !== undefined && f.after !== undefined && f.before !== f.after);
        if (files.length) {
          const offer = { id: randomUUID().slice(0, 8), files };
          offers.set(id, offer);
          broadcast({ t: 'undo-offer', id: offer.id, files: files.map((f) => f.rel) });
        }
      }
      if (t.before) {
        try { if (t.step === 'zooms') keepOtherZooms(dir, t.before[ZOOMS], chat); } catch (e) { console.error('zooms guard:', e.message); }
        try {
          const np = proposalsMade(dir, t.before);
          if (np.shots.length || np.zooms.length) chat.emit({ t: 'proposals', shots: np.shots, zooms: np.zooms, text: `Claude proposed ${proposalWords(np)}` });
        } catch (e) { console.error('proposals:', e.message); }
      }
      // Didn't finish: after the result (a stop or an error is in it), whether the step got its result.
      setImmediate(() => {
        if (!t.step) return;
        const meta = projectMeta(dir);
        const st = meta?.type ? pipelineStatus(dir, meta.type) : null;
        const step = st ? [...st.steps, ...(st.more || [])].find((x) => x.id === t.step) : null;
        if (!step) return;
        const reason = oneLine(t.error) || (t.ok ? oneLine(t.text) : '') || 'Stopped before it finished.';
        setProjectState(id, { unfinished: step.done ? null : { step: step.id, name: step.name, reason, ts: t.error ? null : t.textTs || null, at: Date.now() } });
        broadcast({ t: 'files' });
      });
    }
  });
}

// A change Video Octopus itself makes to a window file while a turn runs (an automatic name from the agent's own reply,
// server/naming.mjs) is not the agent's change: it goes into the turn's "before" as well, so Undo neither offers it nor
// puts the old name back. patch: the top-level JSON fields that changed.
export function keepInTurn(id, rel, patch) {
  const t = turns.get(id);
  if (typeof t?.before?.[rel] !== 'string') return;
  try { t.before[rel] = JSON.stringify({ ...JSON.parse(t.before[rel]), ...patch }, null, 2) + '\n'; } catch { /* not JSON: leave it */ }
}

// The unfinished step the page shows, while that step still isn't done.
export function unfinishedOf(id, pipeline) {
  const u = state().projects?.[id]?.unfinished;
  if (!u?.step || !pipeline) return null;
  const s = [...pipeline.steps, ...(pipeline.more || [])].find((x) => x.id === u.step);
  return s && !s.done ? u : null;
}
export const clearUnfinished = (id) => { if (state().projects?.[id]?.unfinished) setProjectState(id, { unfinished: null }); };

// Put the files back. Only those still as the turn left them (a later change by the creator or Claude stays).
export function undoTurn(id, offerId, chat) {
  const o = offers.get(id), dir = projectDir(id);
  if (!o || o.id !== offerId || !dir) throw new Error('There is nothing to undo any more: something changed since that reply.');
  if (chat?.busy) throw new Error('Claude is working: wait for it to finish first.');
  const back = [], kept = [];
  for (const f of o.files) {
    const p = join(dir, f.rel);
    if (read(p) !== f.after) { kept.push(f.rel); continue; }
    if (f.before === null) rmSync(p, { force: true });
    else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.before); }
    back.push(f.rel);
  }
  offers.delete(id);
  if (!back.length) throw new Error(`${kept.map((f) => basename(f)).join(', ')} changed again since, so nothing was put back.`);
  const list = back.join(', ');
  chat?.addStudioNote?.(`The creator pressed Undo on your last reply: Video Octopus put ${list} back exactly as ${back.length > 1 ? 'they were' : 'it was'} before it. Take that into account.`);
  return { back, kept, note: `Undone: ${list} ${back.length > 1 ? 'are' : 'is'} back as before Claude's last reply.${kept.length ? ` ${kept.join(', ')} changed again since, so ${kept.length > 1 ? 'they stay' : 'it stays'}.` : ''}` };
}

// ---- proposals and the Add zooms guard ----
const parse = (text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
// The proposals a turn left that weren't waiting when it began (the files as Video Octopus reads them, ids and all).
export function proposalsMade(dir, before) {
  const ctx = shotsCtx(dir);
  const was = { shots: normalizeShots(parse(before['work/shots.json']), ctx), zooms: normalizeZooms(parse(before[ZOOMS]), ctx) };
  return newProposals(was, readShotsAndZooms(dir));
}
// Add zooms places Claude's camera punch-ins (target camera, by claude) and nothing else: any other zoom that was in
// work/zooms.json before the run (the plan's screen zooms, the creator's own) and isn't there after it goes back in.
export function keepOtherZooms(dir, beforeText, chat) {
  const raw = parse(beforeText);
  if (!raw) return [];
  const ctx = shotsCtx(dir);
  const before = normalizeZooms(raw, ctx).items.filter((z) => !(z.target === 'camera' && z.by === 'claude'));
  if (!before.length) return [];
  const nowRaw = parse(read(join(dir, ZOOMS)));
  const now = nowRaw ? normalizeZooms(nowRaw, ctx).items : [];
  const same = (a, b) => a.target === b.target && Math.abs(a.a - b.a) < 0.05 && Math.abs(a.d - b.d) < 0.05;
  const lost = before.filter((z) => !now.some((y) => y.id === z.id && y.target === z.target) && !now.some((y) => same(y, z)));
  if (!lost.length) return [];
  const ids = new Set(now.map((z) => z.id));
  const back = lost.map((z) => (ids.has(z.id) ? { ...z, id: undefined } : z));
  const doc = { ...(nowRaw && typeof nowRaw === 'object' && Array.isArray(nowRaw.items) ? nowRaw : {}), v: 2, items: [...now, ...back], updated: new Date().toISOString() };
  writeFileSync(join(dir, ZOOMS), JSON.stringify(doc, null, 2));
  const n = lost.length, what = lost.every((z) => z.target === 'screen') ? 'screen zoom' : 'zoom';
  const text = `Add zooms only redoes Claude's camera punch-ins, so Video Octopus put back ${n} ${what}${n > 1 ? 's' : ''} it had removed (${lost.map((z) => z.name || z.id).slice(0, 4).join(', ')}${n > 4 ? '…' : ''}).`;
  chat?.emit?.({ t: 'note', text });
  chat?.addStudioNote?.(`${text} Leave zooms other than your own camera punch-ins in work/zooms.json as they are.`);
  return lost;
}

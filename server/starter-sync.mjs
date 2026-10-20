// Starter updates (Settings → Updates → Starter files): when the app's starter/ has newer files than the studio's copy,
// bring them over without touching what the creator changed. <studio>/.studio/starter.json ({version, created,
// files: {path: sha1}, kept}, written by Create my studio) says which starter version each file came from:
//   - creator-owned preferences, memory and brand/style files: never considered for updates;
//   - other files unchanged by the creator (its sha1 is the manifest's): updated in place;
//   - changed by the creator: theirs stays, the new version goes next to it in .studio/updates/<path>;
//   - new in the starter: added;
//   - deleted by the creator: stays deleted.
// A studio with no starter.json wasn't made from the starter (a studio set up by hand is one): it's left alone.
// starterPlan() is the dry run the page shows first; applyStarter() does it and updates the manifest.
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, lstatSync, readFileSync, constants } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { STARTER_DIR, MANIFEST, starterFiles, sha1 } from './starter.mjs';
import { settings, readJSON, writeJSON, inside, tildePath } from './util.mjs';

export const UPDATES_DIR = join('.studio', 'updates');
const versionOf = (dir) => { try { return readFileSync(join(dir, 'VERSION'), 'utf8').trim() || '1'; } catch { return '1'; } };
const at = (root, rel) => join(root, ...rel.split('/'));
function plainPath(root, rel) {
  const base = resolve(root), target = resolve(base, rel);
  if (!target.startsWith(base + sep)) throw new Error('Starter path leaves the studio.');
  for (let p = target; ; p = dirname(p)) {
    try { if (lstatSync(p).isSymbolicLink()) throw new Error(`Starter update kept a symbolic link unchanged: ${p}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (p === base) break;
  }
  return target;
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The files waiting in .studio/updates: new starter versions of files the creator changed, until they delete them.
export function waitingUpdates(studio) {
  const root = join(studio, UPDATES_DIR), out = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n !== '.DS_Store') out.push(relative(root, p).split(sep).join('/')); } };
  try { walk(root); } catch {}
  return out.sort().slice(0, 200);
}

// The dry run: what an update would do, file by file. Nothing is written.
export function starterPlan(studio = settings().studio, { starter = STARTER_DIR, prefixes = null } = {}) {
  if (!studio || !existsSync(studio)) return { ok: false, reason: 'no-studio', text: 'There is no studio folder yet: Setup creates one.' };
  const man = readJSON(join(studio, MANIFEST), null);
  if (!man || typeof man.files !== 'object' || !man.files) return { ok: false, reason: 'no-manifest', studio: tildePath(studio),
    text: `${tildePath(studio)} wasn't made from Video Octopus's starter (it has no .studio/starter.json), so starter updates leave it alone.` };
  if (!existsSync(starter)) return { ok: false, reason: 'no-starter', text: 'The app has no starter/ folder.' };
  const kept = new Set(Array.isArray(man.kept) ? man.kept : []);
  const plan = { ok: true, studio: tildePath(studio), from: String(man.version || '1'), to: versionOf(starter),
    update: [], add: [], keep: [], deleted: [], adopt: [], same: 0, hashes: {} };
  for (const rel of starterFiles(starter)) {
    if (rel.startsWith('.claude/skills/')) continue; // the transactional skill manager owns this entire root
    // These are initial templates, not vendor-managed files. Even an unchanged or deleted
    // preference belongs to the creator; never overwrite it or offer a replacement on update.
    const ownedPath = rel.toLowerCase();
    if (ownedPath.startsWith('preferences/') || ownedPath.startsWith('memory/') || ['brand.md', 'style.md'].includes(ownedPath)) continue;
    if (prefixes && !prefixes.some((prefix) => rel.startsWith(prefix))) continue;
    const now = sha1(at(starter, rel)), was = man.files[rel];
    if (was === now) { plan.same++; continue; } // the starter hasn't changed this file since the studio got it
    plan.hashes[rel] = now;
    const mine = plainPath(studio, rel);
    if (!existsSync(mine)) { (was || kept.has(rel) ? plan.deleted : plan.add).push(rel); continue; }
    const h = sha1(mine);
    if (h === now) plan.adopt.push(rel);               // already the new version: only the manifest changes
    else if (was && h === was) plan.update.push(rel);  // untouched by the creator
    else plan.keep.push(rel);                          // the creator's own version (changed, or theirs from before)
  }
  plan.waiting = waitingUpdates(studio);
  plan.pending = plan.update.length + plan.add.length + plan.keep.length; // what the creator sees (adopt is bookkeeping)
  plan.text = !plan.pending
    ? `Your studio has the starter's latest files (starter version ${plan.to}).`
    : [plan.update.length && `${plural(plan.update.length, 'starter file')} to update`, plan.add.length && `${plan.add.length} new`,
      plan.keep.length && `${plan.keep.length} kept as you changed ${plan.keep.length === 1 ? 'it' : 'them'} (the new version goes in ${keptWhere(plan.keep)})`]
      .filter(Boolean).join('; ') + '.';
  if (plan.deleted.length) plan.text += ` ${plural(plan.deleted.length, 'file')} you deleted ${plan.deleted.length === 1 ? 'stays' : 'stay'} deleted.`;
  return plan;
}
const keptWhere = (list) => (list.length === 1 ? `.studio/updates/${list[0]}` : '.studio/updates/');

// Do it: update, add and set aside as the plan says (checked again file by file), then write the manifest.
export function applyStarter(studio = settings().studio, { starter = STARTER_DIR, prefixes = null } = {}) {
  const plan = starterPlan(studio, { starter, prefixes });
  if (!plan.ok) return plan;
  const manPath = join(studio, MANIFEST), man = readJSON(manPath, {});
  const files = { ...man.files };
  const done = { updated: [], added: [], kept: [] };
  const put = (rel, to, flags) => {
    if (!inside(studio, to)) throw new Error(`Not inside the studio: ${rel}`);
    plainPath(studio, relative(studio, to));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(at(starter, rel), to, flags);
  };
  for (const rel of plan.update) {
    const mine = at(studio, rel);
    // Changed since the dry run? Then it's the creator's now: set the new version aside instead. Deleted: stays so.
    if (!existsSync(mine)) continue;
    if (sha1(mine) === man.files[rel]) { put(rel, mine); done.updated.push(rel); }
    else { put(rel, at(join(studio, UPDATES_DIR), rel)); done.kept.push(rel); }
    files[rel] = plan.hashes[rel];
  }
  for (const rel of plan.add) {
    try { put(rel, at(studio, rel), constants.COPYFILE_EXCL); done.added.push(rel); }
    catch (e) { if (e.code !== 'EEXIST') throw e; put(rel, at(join(studio, UPDATES_DIR), rel)); done.kept.push(rel); } // appeared meanwhile
    files[rel] = plan.hashes[rel];
  }
  for (const rel of plan.keep) { put(rel, at(join(studio, UPDATES_DIR), rel)); done.kept.push(rel); files[rel] = plan.hashes[rel]; }
  for (const rel of plan.adopt) files[rel] = plan.hashes[rel];
  // A file set aside counts from now on as based on the new version: the creator's copy still differs from it, so a
  // later update keeps it too, and the same version isn't set aside again.
  const now = new Date().toISOString();
  writeJSON(manPath, { ...man, version: plan.to, updated: now, files });
  const text = [done.updated.length && `${plural(done.updated.length, 'starter file')} updated`, done.added.length && `${done.added.length} added`,
    done.kept.length && `${done.kept.length} kept as you changed ${done.kept.length === 1 ? 'it' : 'them'}: new version in ${keptWhere(done.kept)}`]
    .filter(Boolean).join('; ');
  const { hashes, ...view } = plan;
  return { ...view, applied: true, done, waiting: waitingUpdates(studio), text: text ? `${text}.` : 'Nothing to change: your studio has the starter\'s latest files.' };
}

// The plan as the page gets it (no hashes).
export const starterView = (studio) => { const { hashes, ...v } = starterPlan(studio); return v; };

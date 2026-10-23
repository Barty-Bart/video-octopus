// SQLite owns skill versions and choices. Working files project them into ONE discoverable directory.
import { defaultSkillSummary, validateSkillSummary } from './skill-summary.mjs';
import { sqlSkillState, saveSkillSnapshot, stageSqlSkills, sqlSkillHistory, sqlLearnedSkillSummary } from './skill-db.mjs';
import { projectedPaths, readProjectedManifest } from './file-store.mjs';
// Deliberately standalone: importing this module performs no IO, starts no app and reads no user settings.
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync,
  copyFileSync, chmodSync, openSync, closeSync, fsyncSync, utimesSync, constants as fsConstants } from 'node:fs';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const MARKER = '.octopus-skill.json';
const SCHEMA = 1;
const TARGETS = ['.claude/skills', 'skills/overrides', 'skills/custom', '.studio/skill-manager/state.json'];
const hash = (b, algorithm = 'sha256') => createHash(algorithm).update(b).digest('hex');
const json = (p, fallback = null) => {
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { throw new Error(`Cannot read ${p}; restore it from a backup before updating skills.`); }
};
const write = (p, value) => {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${randomUUID()}.tmp`, fd = openSync(tmp, 'wx');
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, p);
};
const manager = (studio) => join(studio, '.studio', 'skill-manager');
const statePath = (studio) => join(manager(studio), 'state.json');
const stamp = () => new Date().toISOString();
const clone = (v) => JSON.parse(JSON.stringify(v));
// Generated skills (one per Video format) are projections of other SQLite data. They are published like any skill,
// but have no source folder: never in skills/custom or skills/overrides, never imported from edited copies, and
// rebuilt from their generator. Their names are protected from personal skills.
const GENERATED_ID = /^format\.[a-f0-9-]{36}$/;
const GENERATED_NAME = /^format-[a-f0-9]{8}$/;
let generatedSource = null;
let generatedProjector = null;
// The app registers the generator once (server/learning.mjs). Without it, existing generated publications are kept.
// project(studio, folders) clones file-store files (listed in a generated folder's manifest) into published folders;
// those files are never part of a skill snapshot, so their bytes stay out of SQLite.
export function registerGeneratedSkills(fn, { project = null } = {}) {
  generatedSource = typeof fn === 'function' ? fn : null;
  generatedProjector = typeof project === 'function' ? project : null;
}
const kindOf = (e) => e.mode === 'generated' ? 'format' : e.mode === 'custom' ? 'personal' : e.mode === 'override' ? 'customized-core' : 'core';
const present = (p) => { try { return lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

// No links (including ancestors), special files or traversal in a managed write path. Fail before touching content.
function safe(root, rel) {
  const base = resolve(root), p = resolve(base, rel);
  if (p !== base && !p.startsWith(base + sep)) throw new Error('Skill path leaves its root.');
  for (let q = p; ; q = dirname(q)) {
    const st = present(q);
    if (st?.isSymbolicLink()) throw new Error(`A skill path is a symbolic link: ${q}. Keep it unchanged and choose a plain folder.`);
    if (q === dirname(q)) break;
  }
  return p;
}
function tree(dir) {
  const out = {};
  let bytes = 0, count = 0;
  // Files a generated skill lists as file-store projections are not skill content: they are left out here.
  const walk = (d, skip = new Set()) => {
    if (!existsSync(d)) return;
    const projected = withProjected(d, skip);
    for (const name of readdirSync(d).sort()) {
      if (name === '.DS_Store' || name === '__pycache__') continue;
      const p = join(d, name);
      if (projected.has(p)) continue;
      const st = lstatSync(p);
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) throw new Error(`Unsupported skill file: ${p}. No files were replaced.`);
      if (st.isDirectory()) walk(p, projected);
      else {
        if (++count > 10000 || (bytes += st.size) > 128 * 1024 * 1024) throw new Error('Skill files exceed the safe update limit (10,000 files / 128 MB).');
        out[relative(dir, p).split(sep).join('/')] = { hash: hash(readFileSync(p)), executable: Boolean(st.mode & 0o111) };
      }
    }
  };
  walk(dir);
  return out;
}
function digest(dir, metadata = false) {
  const files = tree(dir);
  if (!metadata) delete files[MARKER];
  return hash(JSON.stringify(files));
}
function fingerprint(p) {
  const st = present(p);
  if (!st) return null;
  if (st.isSymbolicLink()) throw new Error(`Refusing a symbolic link: ${p}`);
  return st.isDirectory() ? digest(p, true) : hash(readFileSync(p));
}
// Absolute paths of file-store projections listed by dir's manifest, added to the ones inherited from its parents.
function withProjected(dir, inherited) {
  const own = projectedPaths(dir);
  if (!own.size) return inherited;
  const all = new Set(inherited);
  for (const p of own) all.add(join(dir, ...p.split('/')));
  return all;
}
function copy(from, to, skip = new Set()) {
  if (skip.has(from)) return;
  const st = present(from);
  if (!st) return;
  if (st.isSymbolicLink()) throw new Error(`Refusing a symbolic link: ${from}`);
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    const projected = withProjected(from, skip);
    for (const name of readdirSync(from)) {
      if (name === '.DS_Store' || name === '__pycache__') continue;
      copy(join(from, name), join(to, name), projected);
    }
  } else if (st.isFile()) {
    mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); chmodSync(to, st.mode & 0o777);
  } else throw new Error(`Unsupported skill file: ${from}`);
}
function replaceStage(from, to) { rmSync(to, { recursive: true, force: true }); copy(from, to); }
function skillName(dir, fallback) {
  const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || '';
  const name = /^\s*name:\s*(.+)$/m.exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, '') || fallback;
  if (!NAME.test(name)) throw new Error(`Invalid skill name in ${dir}/SKILL.md.`);
  return name;
}
function directories(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => !n.startsWith('.')).map((folder) => {
    const dir = safe(root, folder), st = lstatSync(dir);
    if (!st.isDirectory() || !existsSync(join(dir, 'SKILL.md'))) return null;
    const meta = json(join(dir, MARKER));
    if (meta && (!ID.test(meta.id || '') || meta.schema !== SCHEMA)) throw new Error(`Unrecognized skill identity in ${dir}; nothing was replaced.`);
    return { folder, dir, id: meta?.id, name: skillName(dir, folder), hash: digest(dir) };
  }).filter(Boolean);
}
function mark(dir, id) { write(join(dir, MARKER), { schema: SCHEMA, id }); }

export function loadSkillCatalog(appRoot = APP) {
  const raw = json(join(appRoot, 'core', 'skills.json'));
  if (raw?.schema !== SCHEMA || !Array.isArray(raw.skills)) throw new Error('This app has no supported bundled-skill catalog. Skills were left unchanged.');
  const apiVersion = raw.apiVersion === undefined ? 1 : raw.apiVersion;
  if (!Number.isSafeInteger(apiVersion) || apiVersion < 1) throw new Error('Invalid app skill API version.');
  const ids = new Set(), names = new Set(), paths = new Set();
  const items = raw.skills.map((v) => {
    if (!ID.test(v.id || '') || !NAME.test(v.name || '') || !VERSION.test(v.version || '') ||
      typeof v.path !== 'string' || v.path.includes('\\') || v.path.startsWith('/') || v.path.split('/').some((s) => !s || s === '..' || s === '.')) {
      throw new Error('Invalid bundled-skill identity, version or source path.');
    }
    if (ids.has(v.id) || names.has(v.name.toLowerCase()) || paths.has(v.path)) throw new Error('Duplicate bundled-skill identity, name or path.');
    ids.add(v.id); names.add(v.name.toLowerCase()); paths.add(v.path);
    const dir = safe(appRoot, v.path);
    if (skillName(dir, v.name) !== v.name) throw new Error(`Catalog name differs from SKILL.md for ${v.id}.`);
    const legacyNames = v.legacyNames || [];
    const dependencies = v.dependencies || [];
    if (!Array.isArray(legacyNames) || legacyNames.some((n) => !NAME.test(n)) ||
      !Array.isArray(dependencies) || dependencies.some((n) => typeof n !== 'string' || n.length > 300)) throw new Error(`Invalid metadata for ${v.id}.`);
    return { ...v, legacyNames, dependencies, dir, hash: digest(dir) };
  });
  return { items, apiVersion, release: hash(JSON.stringify({ apiVersion, items: items.map(({ dir, ...v }) => v) })) };
}

// A fork records the core version it began from, separately from the available release.
// Missing metadata is deliberately unknown: old managers mislabeled forks with upstream versions.
const forkProblem = (e, apiVersion) => e.mode !== 'custom' && e.forkAvailable
  ? !Number.isSafeInteger(e.forkApiVersion)
    ? 'This custom version has no recorded app API compatibility. Review it, then confirm compatibility or use core.'
    : e.forkApiVersion !== apiVersion
      ? `This custom version was reviewed for app API ${e.forkApiVersion}; the app now uses API ${apiVersion}. Review and adapt it, then confirm compatibility or use core.`
      : null
  : null;
function forkMetadata(e, published = null) {
  e.forkAvailable = true;
  if (!Object.hasOwn(e, 'forkVersion')) e.forkVersion = published?.version || null;
  if (!Object.hasOwn(e, 'forkApiVersion')) e.forkApiVersion = published?.apiVersion || null;
}

function validateState(s) {
  if (s && (s.schema !== SCHEMA || !s.entries || typeof s.entries !== 'object' || Array.isArray(s.entries))) throw new Error('Unsupported skill-state schema. Nothing was replaced.');
  for (const [id, e] of Object.entries(s?.entries || {})) {
    if (!ID.test(id) || e.id !== id || !['default', 'override', 'custom', 'generated'].includes(e.mode) || !NAME.test(e.name || '') ||
      (e.folder && !NAME.test(e.folder)) || (e.published?.folder && !NAME.test(e.published.folder))) throw new Error('Invalid skill-state entry. Nothing was replaced.');
    if ((e.forkName && !NAME.test(e.forkName)) ||
      (e.forkVersion != null && !VERSION.test(e.forkVersion)) ||
      (e.forkApiVersion != null && (!Number.isSafeInteger(e.forkApiVersion) || e.forkApiVersion < 1)))
      throw new Error('Invalid custom-version metadata. Nothing was replaced.');
  }
  return s;
}
const readState = (studio) => {
  const authoritative = sqlSkillState(studio);
  if(authoritative) return validateState(authoritative);
  const legacy = json(statePath(studio));
  if(legacy?.storage === 'sqlite') throw new Error('The skill database is missing. Restore a database backup; generated files are not a replacement for its history.');
  return validateState(legacy);
};
function lock(studio, fn) {
  const root = safe(studio, '.studio/skill-manager'); mkdirSync(root, { recursive: true });
  const p = join(root, 'lock.json');
  if (existsSync(p)) {
    const prior = json(p);
    if (!Number.isInteger(prior?.pid) || prior.pid < 1) throw new Error('An unreadable skill-update lock needs manual recovery.');
    try { process.kill(prior.pid, 0); throw new Error('Another skill update is in progress. Try again after it finishes.'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    rmSync(p);
  }
  const fd = openSync(p, 'wx');
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, at: stamp() })); return fn(); }
  finally { closeSync(fd); rmSync(p, { force: true }); }
}

// Write-ahead journal. On an interrupted commit, roll back, saving anything subsequently written as recovery evidence.
// State is committed last; its transaction id is the commit point. No backup is deleted automatically.
function recover(studio) {
  const root = manager(studio), jp = join(root, 'journal.json'), j = json(jp);
  if (!j) return null;
  if (!ID.test(j.id || '') || !Array.isArray(j.targets) || JSON.stringify(j.targets) !== JSON.stringify(TARGETS) ||
    !Array.isArray(j.had) || j.had.length !== TARGETS.length || j.had.some((v) => typeof v !== 'boolean')) throw new Error('Invalid skill recovery journal; no files were moved.');
  const tx = safe(root, `backups/${j.id}`);
  if (sqlSkillState(studio)?.transaction === j.id) {
    if (!existsSync(join(tx, 'receipt.json'))) write(join(tx, 'receipt.json'), { id: j.id, at: j.at, reason: 'Completed update recovered after interruption' });
    rmSync(jp); return j.id;
  }
  for (let i = TARGETS.length - 1; i >= 0; i--) {
    const target = safe(studio, TARGETS[i]), old = join(tx, 'before', String(i)), next = join(tx, 'next', String(i));
    if (existsSync(old)) {
      if (existsSync(target)) { const extra = join(tx, 'interrupted', `${i}-${randomUUID()}`); mkdirSync(dirname(extra), { recursive: true }); renameSync(target, extra); }
      mkdirSync(dirname(target), { recursive: true }); renameSync(old, target);
    } else if (!j.had[i] && !existsSync(next) && existsSync(target)) {
      const extra = join(tx, 'interrupted', `${i}-${randomUUID()}`); mkdirSync(dirname(extra), { recursive: true }); renameSync(target, extra);
    }
  }
  write(join(tx, 'receipt.json'), { id: j.id, at: j.at, reason: 'Interrupted update recovered; extra files retained here', recovered: true });
  rmSync(jp);
  return j.id;
}
function commit(studio, next, staged, before, reason, fault) {
  const id = randomUUID(), root = manager(studio), tx = join(root, 'backups', id), jp = join(root, 'journal.json');
  mkdirSync(join(tx, 'next'), { recursive: true }); mkdirSync(join(tx, 'before'), { recursive: true });
  for (let i = 0; i < 3; i++) copy(staged[i], join(tx, 'next', String(i)));
  next.transaction = id; next.revision = randomUUID(); next.storage = 'sqlite';
  write(join(tx, 'next', '3'), next);
  for (let i = 0; i < TARGETS.length; i++) {
    if (fingerprint(safe(studio, TARGETS[i])) !== before[i]) throw new Error('Skill files changed while preparing this update. Your files were kept; refresh and try again.');
  }
  const j = { id, at: stamp(), targets: TARGETS, had: before.map((v) => v !== null) };
  write(jp, j);
  for (let i = 0; i < TARGETS.length; i++) {
    const target = safe(studio, TARGETS[i]); mkdirSync(dirname(target), { recursive: true });
    if (i === 0) carryProjected(target, join(tx, 'next', '0'));
    if (existsSync(target)) renameSync(target, join(tx, 'before', String(i)));
    fault?.(`before-install-${i}`);
    renameSync(join(tx, 'next', String(i)), target);
    fault?.(`after-install-${i}`);
  }
  saveSkillSnapshot(studio, next, reason);
  fault?.('after-database-commit');
  write(join(tx, 'receipt.json'), { id, at: j.at, reason });
  rmSync(jp);
  return next;
}
// File-store projections are not in the snapshot. Unchanged ones (same path and hash in the old and new manifest) move
// into the new publication instead of being copied again; the projector verifies and completes them afterwards.
function carryProjected(from, to) {
  if (!existsSync(from) || !existsSync(to)) return;
  for (const name of readdirSync(to)) {
    const next = join(to, name), prev = join(from, name);
    if (!present(prev)?.isDirectory()) continue;
    const wanted = readProjectedManifest(next);
    if (!wanted.length) continue;
    const had = new Map(readProjectedManifest(prev).map((f) => [f.path, f.sha256]));
    for (const f of wanted) {
      if (had.get(f.path) !== f.sha256) continue;
      try {
        const src = safe(prev, f.path), dst = safe(next, f.path);
        if (!present(src)?.isFile() || present(dst)) continue;
        mkdirSync(dirname(dst), { recursive: true });
        renameSync(src, dst);
      } catch {}
    }
  }
}
// Clone file-store files into the published generated skills. Problems are reported, never fatal to a skill sync.
function projectGenerated(studio) {
  if (!generatedProjector) return [];
  try {
    const entries = Object.values(readState(studio)?.entries || {});
    const folders = entries.filter((e) => e.mode === 'generated' && e.published?.folder).map((e) => e.published.folder);
    return generatedProjector(studio, folders) || [];
  } catch (e) { return [e.message]; }
}
function withFileProblems(view, problems) {
  if (problems.length) view.fileProblems = problems;
  return view;
}
function provenUnmodified(found, legacy) {
  const files = tree(found.dir); delete files[MARKER];
  const prefix = `.claude/skills/${found.folder}/`;
  const recorded = Object.keys(legacy?.files || {}).filter((p) => p.startsWith(prefix));
  if (!recorded.length || recorded.length !== Object.keys(files).length) return false;
  return recorded.every((p) => existsSync(join(found.dir, p.slice(prefix.length))) &&
    hash(readFileSync(join(found.dir, p.slice(prefix.length))), 'sha1') === legacy.files[p]);
}
// Notices about generated skills Video Octopus put back (below), for the next chat to show once (claude.mjs skillRoot).
const skillNotices = [];
export const takeSkillNotices = () => skillNotices.splice(0);
const editedStamp = () => new Date().toISOString().replace(/[:.]/g, '-');
function keepEditedAside(studio, folder, label) {
  const live = safe(studio, `.claude/skills/${folder}`);
  if (!existsSync(live)) {
    skillNotices.push(`The format skill ${label} was deleted outside Video formats, so Video Octopus put its saved version back.`);
    return null;
  }
  const aside = safe(studio, `.studio/edited-skill-files/${editedStamp()}-${folder}`);
  mkdirSync(dirname(aside), { recursive: true });
  renameSync(live, aside);
  skillNotices.push(`The format skill ${label} was changed outside Video formats, so Video Octopus put its saved version back. The changed copy is kept in ${aside}.`);
  console.warn(skillNotices.at(-1));
  return aside;
}
// Startup sync (syncSkills, database projection): when every changed file is inside a generated format skill's
// folder, move those folders aside so the sync republishes them from the database. Returns false otherwise.
function isolateGenerated(studio, state, changedPaths) {
  const generated = new Map(Object.values(state?.entries || {}).filter((e) => e.mode === 'generated' && e.published?.folder).map((e) => [e.published.folder, e]));
  const folders = new Set(changedPaths.map((p) => p.split('/')[0]));
  if (![...folders].every((f) => generated.has(f))) return false;
  for (const f of folders) keepEditedAside(studio, f, generated.get(f).name);
  return true;
}
// A chat is starting and a generated format skill's files don't match its publication (an agent or the creator edited
// one): keep the edited folder aside, put the database's version back with its file-store files, and carry on. Only
// that skill is touched; the next chat says what happened. Returns false when the database copy can't be verified.
function restoreGenerated(studio, entries) {
  return lock(studio, () => {
    const stage = join(manager(studio), `restore-${randomUUID()}`);
    const staged = [join(stage, 'active'), join(stage, 'overrides'), join(stage, 'custom')];
    try {
      staged.forEach((p) => mkdirSync(p, { recursive: true }));
      stageSqlSkills(studio, staged);
      for (const e of entries) {
        const canonical = join(staged[0], e.published.folder);
        if (!existsSync(join(canonical, 'SKILL.md')) || digest(canonical) !== e.published.hash) return false;
      }
      for (const e of entries) {
        keepEditedAside(studio, e.published.folder, e.name);
        copy(join(staged[0], e.published.folder), safe(studio, `.claude/skills/${e.published.folder}`));
      }
    } finally { rmSync(stage, { recursive: true, force: true }); }
    const problems = projectGenerated(studio);
    for (const p of problems) skillNotices.push(p);
    return true;
  });
}

// Apply the generated list (explicit, or from the registered generator) to the skill entries.
// Returns [id, rendered folder] pairs to publish. Generated entries the list no longer names are dropped,
// except those the generator could not rebuild this time (keep), which retain their current publication.
function reconcileGenerated(studio, stage, entries, explicit) {
  let list = explicit, keep = [];
  if (list === undefined && generatedSource) {
    try {
      const result = generatedSource(studio, join(stage, 'generated'));
      list = result.items; keep = result.keep || [];
      if (result.problems?.length) console.error('format skills:', result.problems.join(' '));
    } catch (e) { console.error('format skills:', e.message); return []; }
  }
  if (!Array.isArray(list)) return [];
  const wanted = new Map();
  for (const g of list) {
    if (!GENERATED_ID.test(g?.id || '') || !GENERATED_NAME.test(g.name || '') || !g.dir || skillName(g.dir, g.name) !== g.name)
      throw new Error('Invalid generated skill. Nothing was replaced.');
    wanted.set(g.id, g);
  }
  for (const e of Object.values(entries)) if (e.mode === 'generated' && !wanted.has(e.id) && !keep.includes(e.id)) delete entries[e.id];
  for (const g of wanted.values()) {
    const prior = entries[g.id];
    if (prior && prior.mode !== 'generated') throw new Error(`Skill identity ${g.id} is not a generated skill. Nothing was replaced.`);
    entries[g.id] = { ...(prior || {}), id: g.id, name: g.name, mode: 'generated', generator: 'format', formatId: g.formatId || null,
      versionId: g.versionId || null, disabled: false, deleted: false, summary: String(g.summary || '').slice(0, 320) || 'Generated format skill.', summaryCustom: false };
  }
  return [...wanted.values()].map((g) => [g.id, g.dir]);
}
function requireRevision(old, action) {
  if (action && action.action !== 'refresh' && action.revision !== old?.revision) throw new Error('The skill list changed. Refresh and review the latest choices before applying.');
}

// generated: [{ id, name, dir, summary, formatId, versionId }] replaces every generated skill (omit to use the
// registered generator, or to keep current generated publications when none is registered).
export function syncSkills({ studio, appRoot = APP, fresh = false, action = null, fault, generated, reason } = {}) {
  if (!studio || !existsSync(studio)) throw new Error('Choose a studio before updating skills.');
  safe(studio, '.');
  const catalog = loadSkillCatalog(appRoot);
  return lock(studio, () => {
    const recovered = recover(studio);
    const old = readState(studio);
    requireRevision(old, action);
    if (old?.held && !action && sqlSkillState(studio)) return withFileProblems(skillsView({ studio, appRoot }), projectGenerated(studio));
    if (old?.held && !['refresh', 'restore', 'regenerate', 'restore-sql'].includes(action?.action))
      throw new Error('This restored skill snapshot is held. Resume updates before changing a skill choice; comparison remains available.');
    const before = TARGETS.map((p) => fingerprint(safe(studio, p)));
    const stage = join(manager(studio), `stage-${randomUUID()}`);
    const staged = [join(stage, 'active'), join(stage, 'overrides'), join(stage, 'custom')];
    try {
      staged.forEach(p => mkdirSync(p, {recursive:true}));
      if(old?.storage === 'sqlite' && !action) {
        // Startup and app updates read canonical database bytes. Missing projections are regenerated;
        // external edits are never silently imported or overwritten. Explicit Refresh imports them.
        stageSqlSkills(studio,staged);
        for(let i=0;i<3;i++) {
          const disk=tree(safe(studio,TARGETS[i])), canonical=tree(staged[i]);
          let changed=Object.keys(disk).filter(p=>JSON.stringify(disk[p])!==JSON.stringify(canonical[p]));
          // Edits inside generated format skills only: those are rebuilt from the database (their edited folders kept
          // aside) instead of blocking every skill update. Any other edit still needs Refresh or Rebuild.
          if(i===0&&changed.length&&isolateGenerated(studio,old,changed))changed=[];
          if(changed.length)
            throw new Error('Working skill files changed. Use Skills → Refresh / import file edits to save them, or Rebuild agent files to restore the database version. Your files are unchanged.');
        }
      } else staged.forEach((p,i)=>copy(join(studio,TARGETS[i]),p));
      let createdFolder;
      if (action && Object.hasOwn(action, 'summary')) validateSkillSummary(action.summary);
      if(action?.action === 'create') {
        if(typeof action.text !== 'string' || !action.text.trim() || action.text.length > 100000) throw new Error('Skill text must be 1–100,000 characters.');
        const folder = createdFolder = `custom-${randomUUID()}`, path = join(staged[2],folder);mkdirSync(path,{recursive:true});writeFileSync(join(path,'SKILL.md'),action.text);skillName(path,folder);
      }
      let next = old ? clone(old) : { schema: SCHEMA, entries: {}, versions: {} };
      next.versions ||= {};
      const priorSemantic = JSON.stringify(next);
      const entries = next.entries;
      const bundled = new Map(catalog.items.map((v) => [v.id, v]));
      const active = directories(staged[0]), seenIds = new Set();
      for (const s of active) {
        if (s.id && seenIds.has(s.id)) throw new Error(`Two active folders claim skill ${s.id}; resolve the duplicate without deleting either copy.`);
        if (s.id) seenIds.add(s.id);
      }
      const legacy = json(join(studio, '.studio', 'starter.json'), {});
      const sourceFor = (e) => join(e.mode === 'custom' ? staged[2] : staged[1], e.folder || e.id);
      // Stable markers also preserve identity when the creator renames a source folder.
      const sourceDirs = [...directories(staged[1]).map((s) => ({ ...s, mode: 'override' })),
        ...directories(staged[2]).map((s) => ({ ...s, mode: 'custom' }))];
      const sourceIds = new Set();
      for (const s of sourceDirs) {
        if (s.id && (GENERATED_ID.test(s.id) || entries[s.id]?.mode === 'generated')) {
          // A copied generated folder is the creator's own skill now; it gets its own identity.
          if (s.mode === 'override') throw new Error(`${s.folder} is a copy of a generated format skill; move it to skills/custom to keep it.`);
          s.id = null;
        }
        if (s.mode === 'custom' && s.id && bundled.has(s.id)) throw new Error(`The identity of ${s.folder} belongs to a bundled skill; use skills/overrides.`);
        if (s.id && sourceIds.has(s.id)) throw new Error(`Two personal skill folders claim ${s.id}. Both were kept.`);
        if (s.id) sourceIds.add(s.id);
        if (s.id && entries[s.id]) {
          const e = entries[s.id];
          if (s.mode === 'custom' && e.mode !== 'custom') throw new Error(`The identity of ${s.folder} belongs to a bundled skill; put an override in skills/overrides instead.`);
          if (s.mode === 'override' && e.mode === 'custom') throw new Error(`The identity of ${s.folder} belongs to a custom skill.`);
          e.folder = s.folder;
          if (s.mode === 'override') {
            if (e.mode === 'default' && !e.forkAvailable) { e.forkVersion = null; e.forkApiVersion = null; }
            forkMetadata(e); e.forkName = s.name;
          }
        }
        else {
          if (s.mode === 'override' && (!s.id || !bundled.has(s.id))) throw new Error(`Unrecognized override ${s.folder}; add independent skills under skills/custom.`);
          const id = s.id || `user-${randomUUID()}`;
          entries[id] = { id, name: s.name, mode: s.mode, folder: s.folder, sourceHash: s.hash, disabled: false };
          if (s.mode === 'override') { forkMetadata(entries[id]); entries[id].forkName = s.name; }
          mark(s.dir, id);
        }
      }
      // Import existing/native skill folders. Missing or partial legacy metadata is never proof of ownership.
      const importedIds = new Set();
      for (const s of active) {
        let id = s.id;
        if (!id) {
          const known = Object.values(entries).find((e) => e.published?.folder === s.folder);
          const legacySkill = catalog.items.find((b) => b.legacyNames.includes(s.folder));
          id = known?.id || legacySkill?.id || `user-${randomUUID()}`;
        }
        if (importedIds.has(id)) throw new Error(`Two active folders resolve to skill ${id}; both were kept. Resolve their identity before updating.`);
        importedIds.add(id);
        if (GENERATED_ID.test(id) || entries[id]?.mode === 'generated') {
          // Generated publications are rebuilt, never imported. An edited copy stays in this update's backup.
          s.id = id;
          continue;
        }
        let e = entries[id];
        if (!e) {
          const b = bundled.get(id), managed = b && provenUnmodified(s, legacy);
          e = entries[id] = { id, name: s.name, mode: managed ? 'default' : b ? 'override' : 'custom',
            folder: id, disabled: false, legacy: !old };
          if (!managed) { replaceStage(s.dir, sourceFor(e)); mark(sourceFor(e), id); e.sourceHash = s.hash; }
          if (b && !managed) { forkMetadata(e); e.forkName = s.name; e.reviewedHash = null; }
        } else if (old && !e.published) {
          // A manually reintroduced inactive publication is not permission to replace its saved source.
          // Identical copies can be removed during projection; different bytes need an explicit review.
          const src = sourceFor(e);
          if (!existsSync(join(src, 'SKILL.md')) || digest(src) !== s.hash)
            throw new Error(`An inactive skill ${e.name} has a different active copy. Both are preserved; reconcile the files before refreshing.`);
        } else if (e.published && s.hash !== e.published.hash) {
          const src = sourceFor(e), currentHash = existsSync(join(src, 'SKILL.md')) ? digest(src) : null;
          if (e.mode === 'default' && currentHash && currentHash !== s.hash)
            throw new Error(`The active core copy and saved custom version of ${e.name} differ. Both are preserved; reconcile them before refreshing.`);
          if (currentHash && currentHash !== e.sourceHash && currentHash !== s.hash) throw new Error(`Both the active and personal copies of ${e.name} changed. Both are preserved; reconcile them before updating.`);
          if (e.mode === 'default') {
            if (!currentHash) { e.forkVersion = e.published.version || null; e.forkApiVersion = e.published.apiVersion || null; }
            forkMetadata(e, e.published); e.mode = 'override'; e.folder ||= id;
          }
          replaceStage(s.dir, src); mark(src, id); e.sourceHash = s.hash; e.name = s.name; e.reviewedHash = null;
          if (e.mode === 'override') { forkMetadata(e); e.forkName = s.name; }
        }
        if (!old && e.mode === 'custom') e.legacy = true;
        s.id = id;
      }
      for (const e of Object.values(entries)) {
        if (e.mode === 'generated') continue;
        const found = active.find((s) => s.id === e.id);
        if (e.published && !found && !e.disabled) { e.disabled = true; e.deleted = true; }
        if (e.mode !== 'default' || e.forkAvailable) {
          const src = sourceFor(e);
          if (existsSync(join(src, 'SKILL.md'))) {
            e.sourceHash = digest(src);
            const name = skillName(src, e.forkName || e.name);
            if (e.mode === 'custom') e.name = name;
            else { forkMetadata(e); e.forkName = name; if (e.mode === 'override') e.name = name; }
            mark(src, e.id);
          } else {
            if (e.mode !== 'custom') e.forkAvailable = false;
            if (e.mode !== 'default') { e.disabled = true; e.deleted = true; }
          }
        }
      }
      for (const b of catalog.items) {
        const versionKey = `${b.id}@${b.version}`;
        if (next.versions[versionKey] && next.versions[versionKey] !== b.hash) throw new Error(`${b.name} changed without a version bump. The release must assign a new version before it can update.`);
        next.versions[versionKey] = b.hash;
        let e = entries[b.id];
        if (!e) {
          const installedBefore = b.legacyNames.some((n) => Object.keys(legacy.files || {}).some((p) => p.startsWith(`.claude/skills/${n}/`)) ||
            (legacy.kept || []).some((p) => p.startsWith(`.claude/skills/${n}/`)));
          const uncertainAbsence = !old && !fresh && !legacy.files && b.legacyNames.length;
          e = entries[b.id] = { id: b.id, name: b.name, mode: 'default', disabled: Boolean(installedBefore || uncertainAbsence),
            deleted: Boolean(installedBefore), uncertain: Boolean(uncertainAbsence), reviewedHash: b.hash };
        }
        if (e.mode === 'default') e.name = b.name;
        if (e.version && VERSION.test(e.version) && b.version.split('.').map(Number).some((n, i, a) =>
          n < Number(e.version.split('.')[i]) && a.slice(0, i).every((x, j) => x === Number(e.version.split('.')[j])))) e.rollbackNotice = true;
        if (JSON.stringify(e.dependencies || []) !== JSON.stringify(b.dependencies) && (old || !fresh)) e.requirementsNotice = Boolean(b.dependencies.length);
        e.version = b.version; e.upstreamHash = b.hash; e.dependencies = b.dependencies;
        if (e.removed) { e.disabled = true; e.returned = true; }
        e.removed = false;
      }
      for (const e of Object.values(entries)) {
        if (e.mode !== 'custom' && e.mode !== 'generated' && !bundled.has(e.id)) {
          e.removed = true;
          if (e.mode === 'default') e.disabled = true; // never erase a creator's override or its recovery copy
        }
      }
      const a = action?.action;
      if (a && !['refresh', 'keep', 'latest', 'disable', 'enable', 'customize', 'use-custom', 'confirm-compatibility', 'restore', 'edit', 'create', 'describe', 'regenerate', 'restore-sql'].includes(a)) throw new Error('Unknown skill action.');
      if (a === 'regenerate' || a === 'restore-sql') {
        for(const p of staged){rmSync(p,{recursive:true,force:true});mkdirSync(p,{recursive:true});}
        next = stageSqlSkills(studio, staged, a === 'restore-sql' ? action.snapshot : null);
        if(a === 'restore-sql') { next.held = true; next.holdReason = 'A database skill version was restored. Review before resuming updates.'; }
        for(const e of Object.values(next.entries)) {
          if(e.published && e.mode === 'default' && e.published.apiVersion !== catalog.apiVersion) throw new Error('This database snapshot belongs to another app API.');
          if(e.mode === 'override' && forkProblem(e,catalog.apiVersion)) { if(e.published) rmSync(join(staged[0],e.published.folder),{recursive:true,force:true});e.published=null; }
        }
      } else if (a === 'restore') {
        if (!ID.test(action.backup || '')) throw new Error('Invalid skill backup.');
        const backup = safe(manager(studio), `backups/${action.backup}`);
        const receipt = json(join(backup, 'receipt.json'));
        if (!receipt || receipt.recovered) throw new Error('This is not a completed update backup.');
        const previous = validateState(json(join(backup, 'before', '3')));
        if (!previous) throw new Error('This backup predates the skill manager; its original files remain available for manual recovery.');
        // Preserve current sources in the new transaction backup; restore the requested prior snapshot and pin it.
        for (let i = 0; i < 3; i++) {
          rmSync(staged[i], { recursive: true, force: true }); mkdirSync(staged[i], { recursive: true });
          copy(join(backup, 'before', String(i)), staged[i]);
        }
        next = previous; next.held = true; next.holdReason = 'A previous skill snapshot was restored. Review and resume updates when ready.';
        // A held snapshot never bypasses a breaking API change. Keep its sources and choices,
        // but withhold incompatible forks. Reject stale core snapshots rather than label them current.
        for (const e of Object.values(next.entries)) {
          if (e.mode === 'override' && e.published) {
            forkMetadata(e);
            if (forkProblem(e, catalog.apiVersion)) {
              rmSync(safe(staged[0], e.published.folder), { recursive: true, force: true }); e.published = null;
            }
          } else if (e.mode === 'default' && e.published && e.published.apiVersion !== catalog.apiVersion) {
            throw new Error('This backup contains core skills from a different or unknown app API. Its files remain in the backup; restore them manually or use the current core.');
          }
        }
      } else {
        if (a === 'refresh' && next.held) next.held = false;
        const rebuilt = reconcileGenerated(studio, stage, entries, generated);
        if (a && a !== 'refresh' && a !== 'create') {
          const e = entries[action.id], b = bundled.get(action.id);
          if (!e) throw new Error('No such skill.');
          if (e.mode === 'generated') throw new Error('Format skills are generated from Video formats. Change the format there; each change is reviewed and saved as a new version.');
          if (a === 'describe' || (a === 'edit' && Object.hasOwn(action, 'summary'))) { e.summary = validateSkillSummary(action.summary); e.summaryCustom = true; }
          if (a === 'keep') { e.reviewedHash = b?.hash || 'removed'; e.requirementsNotice = false; e.rollbackNotice = false; e.returned = false; }
          if (a === 'disable') { e.disabled = true; e.deleted = false; }
          if (a === 'enable') {
            if (e.removed && e.mode === 'default') throw new Error('This default was removed from the app.');
            if (e.mode !== 'default' && !existsSync(join(sourceFor(e), 'SKILL.md'))) throw new Error('This personal skill source is missing. Restore a backup or choose Use latest before enabling it.');
            e.disabled = false; e.deleted = false; e.uncertain = false; e.returned = false;
          }
          if (a === 'latest') {
            if (!b) throw new Error('This skill has no current bundled version.');
            // Selecting core does not delete the creator's saved fork or reset its baseline.
            Object.assign(e, { mode: 'default', name: b.name, disabled: false, deleted: false, uncertain: false, reviewedHash: b.hash,
              requirementsNotice: false, rollbackNotice: false });
            e.returned = false;
          }
          if (a === 'edit' && (typeof action.text !== 'string' || !action.text.trim() || action.text.length > 100000)) throw new Error('Skill text must be 1–100,000 characters.');
          if (a === 'customize' || a === 'use-custom' || (a === 'edit' && e.mode !== 'custom')) {
            if (e.mode === 'custom') throw new Error('This is already an independent custom skill.');
            if (!e.forkAvailable || !existsSync(join(sourceFor(e), 'SKILL.md'))) {
              if (a === 'use-custom') throw new Error('No saved custom version. Create one with Customize first.');
              if (!b) throw new Error('This default was removed from the app.');
              e.folder ||= e.id;
              if (existsSync(sourceFor(e)) && Object.keys(tree(sourceFor(e))).length)
                throw new Error('The saved custom source is incomplete. Its files were kept; restore or reconcile it before creating a new custom version.');
              copy(b.dir, sourceFor(e)); mark(sourceFor(e), e.id);
              e.sourceHash = digest(sourceFor(e)); e.forkAvailable = true; e.forkName = b.name;
              e.forkVersion = b.version; e.forkApiVersion = catalog.apiVersion; e.reviewedHash = b.hash;
            }
            e.mode = 'override'; e.name = e.forkName; e.disabled = false; e.deleted = false; e.uncertain = false;
          }
          if (a === 'edit') {
            const src = sourceFor(e);
            writeFileSync(join(src, 'SKILL.md'), action.text);
            const name = skillName(src, e.name); e.name = name; if(e.mode === 'override') e.forkName = name;
            e.sourceHash = digest(src);
          }
          if (a === 'confirm-compatibility') {
            if (e.mode === 'custom' || !e.forkAvailable) throw new Error('No saved custom version to review.');
            // Explicit acknowledgement after review, not a code merge, migration or correctness proof.
            e.forkApiVersion = catalog.apiVersion; e.compatibilityReviewedAt = stamp();
          }
        }
        // One path/name per active identity. New custom skills cannot claim core names;
        // preserve an already-selected legacy collision explicitly instead of merging folders.
        // Generated skills that were not rebuilt keep their current, unmodified publication.
        const generatedSources = new Map(rebuilt);
        for (const e of Object.values(entries)) {
          if (e.mode !== 'generated' || generatedSources.has(e.id) || !e.published) continue;
          const current = join(staged[0], e.published.folder), kept = join(stage, 'generated-kept', e.id);
          if (existsSync(join(current, 'SKILL.md')) && digest(current) === e.published.hash) { copy(current, kept); generatedSources.set(e.id, kept); }
        }
        for (const s of active) rmSync(join(staged[0], s.folder), { recursive: true, force: true });
        const occupied = new Map();
        const rank = (e) => e.mode === 'generated' ? 0 : e.mode === 'default' ? 2 : 1;
        const order = Object.values(entries).sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
        for (const e of order) {
          e.collision = null; e.published = null;
          if (e.disabled || (e.removed && e.mode === 'default')) continue;
          if (e.mode === 'override' && forkProblem(e, catalog.apiVersion)) continue;
          if (e.mode === 'generated') {
            const src = generatedSources.get(e.id), key = e.name.toLowerCase(), to = join(staged[0], e.name);
            const reserved = catalog.items.some((b) => [b.name, ...b.legacyNames].some((n) => n.toLowerCase() === key));
            if (!src || !existsSync(join(src, 'SKILL.md'))) { e.collision = 'This format skill is waiting to be rebuilt from its approved version.'; continue; }
            if (reserved || occupied.has(key) || existsSync(to)) { e.collision = `The name ${e.name} is already in use, so this format skill was not published.`; continue; }
            copy(src, to); mark(to, e.id); occupied.set(key, e.id);
            e.published = { folder: e.name, hash: digest(to), version: null, apiVersion: null };
            continue;
          }
          const src = e.mode === 'default' ? bundled.get(e.id)?.dir : sourceFor(e);
          if (!src || !existsSync(join(src, 'SKILL.md'))) continue;
          const key = e.name.toLowerCase(), to = join(staged[0], e.name);
          const reserved = catalog.items.find((b) => b.id !== e.id &&
            [b.name, ...b.legacyNames].some((name) => name.toLowerCase() === key));
          if (reserved && e.mode !== 'default') {
            const previous = old?.entries[e.id]?.published;
            e.legacyCollision = Boolean((!old && e.legacy) || previous?.folder.toLowerCase() === key ||
              (e.legacyCollision && e.legacyCollisionName === key));
            if (e.legacyCollision) e.legacyCollisionName = key;
            e.collision = `The name ${e.name} is reserved for core skill ${reserved.name}. Rename this independent skill; its files were kept.${e.legacyCollision ? ' Its existing legacy selection is preserved until then.' : ' It was not activated.'}`;
            if (!e.legacyCollision) continue;
          }
          if (occupied.has(key) && entries[occupied.get(key)]?.mode === 'generated') {
            e.collision = `The name ${e.name} belongs to a generated format skill. Rename this skill; its files were kept and it was not activated.`;
            continue;
          }
          if (occupied.has(key) || existsSync(to)) {
            if (e.mode !== 'default') throw new Error(`Two personal skills use the name ${e.name}. Both sources are preserved; rename one before continuing.`);
            e.collision = `The name is used by ${occupied.get(key) || 'an existing folder'}. Your files were kept.`; continue;
          }
          copy(src, to); mark(to, e.id); occupied.set(key, e.id);
          e.published = { folder: e.name, hash: digest(to),
            version: e.mode === 'default' ? bundled.get(e.id).version : e.mode === 'override' ? e.forkVersion : null,
            apiVersion: e.mode === 'default' ? catalog.apiVersion : e.mode === 'override' ? e.forkApiVersion : null };
        }
        next.release = catalog.release;
        next.apiVersion = catalog.apiVersion;
      }
      if (!['restore', 'restore-sql', 'regenerate'].includes(a)) {
        for (const e of Object.values(next.entries)) {
          if (e.mode === 'generated') continue;
          if (createdFolder && createdFolder === e.folder && Object.hasOwn(action || {}, 'summary')) { e.summary = validateSkillSummary(action.summary); e.summaryCustom = true; }
          if (!e.summaryCustom) {
            const src = e.mode === 'default' ? bundled.get(e.id)?.dir : sourceFor(e);
            const body = src && existsSync(join(src, 'SKILL.md')) ? readFileSync(join(src, 'SKILL.md'), 'utf8') : '';
            e.summary = sqlLearnedSkillSummary(studio, e.name) || defaultSkillSummary(body, e.mode === 'default' ? e.id : null);
          }
        }
      }
      if (recovered) next.recovery = `Recovered interrupted update ${recovered}; extra files are kept in that backup.`;
      const changed = JSON.stringify(next) !== priorSemantic || staged.some((p, i) => fingerprint(p) !== before[i]);
      if (changed || !sqlSkillState(studio)) commit(studio, next, staged, before, a ? `Skill choice: ${a}` : reason || (old ? 'Bundled skill update' : 'Legacy skill migration'), fault);
      return withFileProblems(skillsView({ studio, appRoot }), projectGenerated(studio));
    } finally { rmSync(stage, { recursive: true, force: true }); }
  });
}

export function skillsView({ studio, appRoot = APP } = {}) {
  if (!studio) return { ok: false, error: 'Choose a studio first.', items: [], backups: [], pending: 0 };
  try {
    const s = readState(studio), catalog = loadSkillCatalog(appRoot);
    if (!s) return { ok: false, error: 'Skills have not been migrated yet. Restart the app or refresh skills.', items: [], backups: [], pending: 1 };
    const items = Object.values(s.entries).map((e) => {
      const b = catalog.items.find((v) => v.id === e.id);
      const forkAvailable = e.mode !== 'custom' && e.mode !== 'generated' && existsSync(safe(studio, `skills/overrides/${e.folder || e.id}/SKILL.md`));
      const compatibilityReason = forkProblem({ ...e, forkAvailable }, catalog.apiVersion);
      const compatibilityBlocked = Boolean(compatibilityReason);
      const changed = e.mode === 'override' && e.reviewedHash !== (e.removed ? 'removed' : e.upstreamHash);
      const reasons = [changed && (e.removed ? 'The app removed this skill; your version is preserved.' : 'A bundled version is available; your custom files are preserved.'),
        e.mode === 'override' && compatibilityReason,
        e.requirementsNotice && 'Requirements changed. Review them in Setup; nothing was installed.',
        e.rollbackNotice && 'The application returned to an older skill version.',
        e.uncertain && 'Legacy file history is missing; kept disabled until you choose.',
        e.collision, e.returned && 'This previously removed skill returned; enable it explicitly.'].filter(Boolean);
      return { ...e, kind: kindOf(e), forkAvailable, forkVersion: e.forkVersion || null, forkApiVersion: e.forkApiVersion || null,
        activeVersion: e.published && !(e.mode === 'override' && compatibilityBlocked)
          ? e.published.version || (e.mode === 'default' ? e.version : e.forkVersion) || null : null,
        availableVersion: b?.version || null, apiVersion: catalog.apiVersion, compatibilityBlocked, compatibilityReason,
        pending: reasons.length > 0, reason: reasons.join(' '),
        overridePath: e.mode === 'generated' || (e.mode === 'default' && !forkAvailable) ? null : `skills/${e.mode === 'custom' ? 'custom' : 'overrides'}/${e.folder || e.id}`,
        canUseLatest: Boolean(b) };
    });
    const backups = [];
    const root = join(manager(studio), 'backups');
    if (existsSync(root)) for (const id of readdirSync(root)) {
      if (!ID.test(id)) continue;
      const r = json(join(root, id, 'receipt.json'));
      if (r) backups.push({ ...r, restorable: !r.recovered && existsSync(join(root, id, 'before', '3')) });
    }
    return { ok: true, storage: 'sqlite', history: sqlSkillHistory(studio), revision: s.revision, release: s.release, apiVersion: catalog.apiVersion, held: Boolean(s.held), holdReason: s.holdReason,
      recovery: s.recovery, pending: items.filter((e) => e.pending).length + Number(Boolean(s.held)),
      items, backups: backups.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20) };
  } catch (e) { return { ok: false, error: e.message, items: [], backups: [], pending: 1 }; }
}

export function compareSkill({ studio, appRoot = APP, id, revision } = {}) {
  const s = readState(studio); requireRevision(s, { revision });
  const e = s?.entries[id]; if (!e) throw new Error('No such skill.');
  if (e.mode === 'generated') throw new Error('Format skills are generated from their approved version; compare versions in Video formats → History.');
  const b = loadSkillCatalog(appRoot).items.find((v) => v.id === id);
  const savedFork = safe(studio, `skills/overrides/${e.folder || e.id}`);
  const mine = e.mode === 'default' && !existsSync(join(savedFork, 'SKILL.md'))
    ? e.published && safe(studio, `.claude/skills/${e.published.folder}`)
    : e.mode === 'custom' ? safe(studio, `skills/custom/${e.folder || e.id}`) : savedFork;
  const aFiles = mine && existsSync(mine) ? tree(mine) : {}, bFiles = b ? tree(b.dir) : {};
  const paths = [...new Set([...Object.keys(aFiles), ...Object.keys(bFiles)])].filter((p) => p !== MARKER).sort();
  let remaining = 256 * 1024;
  const files = paths.filter((p) => JSON.stringify(aFiles[p]) !== JSON.stringify(bFiles[p])).slice(0, 200).map((p) => {
    const left = aFiles[p] ? readFileSync(safe(mine, p)) : Buffer.alloc(0), right = bFiles[p] ? readFileSync(safe(b.dir, p)) : Buffer.alloc(0);
    const binary = left.includes(0) || right.includes(0), tooLarge = left.length + right.length > Math.min(32768, remaining);
    remaining -= Math.min(remaining, left.length + right.length);
    return { path: p, status: !aFiles[p] ? 'added' : !bFiles[p] ? 'removed' : 'changed', binary, tooLarge,
      mine: binary || tooLarge ? null : left.toString('utf8'), latest: binary || tooLarge ? null : right.toString('utf8') };
  });
  return { name: e.name, files, truncated: paths.length > 200, note: 'Text comparison only; no code is executed or merged.' };
}

// All three harnesses use this exact publication. Never give an agent backups, defaults and overrides as extra roots.
export function activeSkillRoot({ studio, appRoot = APP, repaired = false } = {}) {
  if (!studio) return null;
  if (existsSync(join(manager(studio), 'journal.json'))) throw new Error('A skill update needs recovery. Restart Video Octopus before starting a chat.');
  const s = readState(studio);
  if (!s) throw new Error('Restart Video Octopus to migrate this studio’s skills before starting a chat.');
  const catalog = loadSkillCatalog(appRoot);
  if (!s.held && s.release !== catalog.release) throw new Error('The app changed on disk. Restart it to activate matching skills before starting a chat.');
  for (const e of Object.values(s.entries)) {
    if (e.mode === 'override' && e.published) forkMetadata(e);
    if (e.published && ((e.mode === 'override' && (forkProblem(e, catalog.apiVersion) || e.published.apiVersion !== e.forkApiVersion)) ||
      (e.mode === 'default' && e.published.apiVersion !== catalog.apiVersion)))
      throw new Error('Published skills have incompatible or unknown app API metadata. Refresh skills before starting a chat; saved custom versions will be preserved.');
  }
  const root = safe(studio, '.claude/skills'), seen = new Set(), edited = [];
  for (const found of directories(root)) {
    const e = s.entries[found.id];
    // A changed generated format skill doesn't block the chat: it is put back from the database below.
    if (e?.mode === 'generated' && e.published && !e.disabled && e.published.folder === found.folder && e.published.hash !== found.hash && !repaired) {
      edited.push(e); seen.add(found.name.toLowerCase()); continue;
    }
    if (!e?.published || e.disabled || e.published.folder !== found.folder || e.published.hash !== found.hash || seen.has(found.name.toLowerCase()))
      throw new Error('Skill files changed. Open Settings → Updates and refresh skills before starting a chat.');
    seen.add(found.name.toLowerCase());
  }
  for (const e of Object.values(s.entries)) if (e.published && !existsSync(join(root, e.published.folder, 'SKILL.md'))) {
    if (e.mode === 'generated' && !e.disabled && !repaired) { edited.push(e); continue; }
    throw new Error('A skill was deleted. Refresh skills in Settings → Updates to preserve that choice.');
  }
  if (edited.length) {
    if (!restoreGenerated(studio, edited)) throw new Error('Skill files changed. Open Settings → Updates and refresh skills before starting a chat.');
    return activeSkillRoot({ studio, appRoot, repaired: true });
  }
  const sources = [...directories(safe(studio, 'skills/overrides')), ...directories(safe(studio, 'skills/custom'))];
  const sourceIds = new Set();
  for (const source of sources) {
    const e = s.entries[source.id];
    if (!e || (e.mode === 'default' && !e.forkAvailable) || sourceIds.has(source.id) || e.sourceHash !== source.hash || e.folder !== source.folder)
      throw new Error('Personal skill sources changed. Refresh skills in Settings → Updates before starting a chat.');
    sourceIds.add(source.id);
  }
  for (const e of Object.values(s.entries)) if (((e.mode !== 'default' && e.mode !== 'generated' && !e.deleted) || e.forkAvailable) && !sourceIds.has(e.id))
    throw new Error('A personal skill source is missing. Refresh skills in Settings → Updates to preserve that choice.');
  // Do not let nested/unregistered SKILL.md files bypass the single-publication rule of the harnesses.
  const expected = new Set(Object.values(s.entries).filter((e) => e.published).map((e) => `${e.published.folder}/SKILL.md`));
  if (Object.keys(tree(root)).some((p) => /(^|\/)SKILL\.md$/i.test(p) && !expected.has(p)))
    throw new Error('An unregistered or nested skill was found. Keep its files and resolve it in Settings → Updates before starting a chat.');
  return root;
}

// A chat that should see only some generated format skills (a format conversation: its channel's; brand research:
// none) gets its own skill root instead of the studio's: every other published skill plus the allowed format skills,
// cloned (copy-on-write where the disk supports it, file-store files included) into
// .studio/scoped-skills/<key>/.claude/skills. Laid out like a project's pinned context, so Claude Code loads it with
// --add-dir; Codex and pi get the skills folder itself. Reused while the publications are the same; a copy whose files
// changed is replaced. Returns { root, hidden }: hidden = the generated skill names this chat must not see.
export function scopedSkillRoot({ studio, formatIds = [], appRoot = APP } = {}) {
  const live = activeSkillRoot({ studio, appRoot });
  if (!live) return null;
  const s = readState(studio), allowed = new Set(formatIds);
  const published = Object.values(s.entries).filter((e) => e.published && !e.disabled && !(e.mode === 'override' && forkProblem(e, loadSkillCatalog(appRoot).apiVersion)));
  const visible = published.filter((e) => e.mode !== 'generated' || allowed.has(e.formatId));
  const hidden = published.filter((e) => e.mode === 'generated' && !allowed.has(e.formatId)).map((e) => e.name);
  const key = hash(JSON.stringify(visible.map((e) => [e.id, e.published.folder, e.published.hash]).sort())).slice(0, 24);
  const parent = safe(studio, '.studio/scoped-skills'), base = join(parent, key), root = join(base, '.claude', 'skills');
  const intact = () => existsSync(join(base, 'ready.json')) && visible.every((e) => existsSync(join(root, e.published.folder, 'SKILL.md')) && digest(join(root, e.published.folder)) === e.published.hash);
  if (intact()) { touch(base); return { root, hidden }; }
  const staging = join(parent, `.staging-${randomUUID()}`);
  try {
    for (const e of visible) cloneTree(join(live, e.published.folder), join(staging, '.claude', 'skills', e.published.folder));
    write(join(staging, 'ready.json'), { at: stamp(), skills: visible.map((e) => e.name).sort() });
    if (existsSync(base)) renameSync(base, join(parent, `.replaced-${randomUUID()}`));
    renameSync(staging, base);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  pruneScoped(parent, key);
  return { root, hidden };
}
// The names of the published generated format skills (Claude Code isolation: skillOverrides).
export function generatedSkillNames({ studio } = {}) {
  const s = studio ? readState(studio) : null;
  return Object.values(s?.entries || {}).filter((e) => e.mode === 'generated' && e.published).map((e) => e.name);
}
// A whole skill folder, file-store projections included (scopedSkillRoot). Symbolic links are refused, as everywhere.
function cloneTree(from, to) {
  const st = lstatSync(from);
  if (st.isSymbolicLink()) throw new Error(`Refusing a symbolic link: ${from}`);
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) if (name !== '.DS_Store' && name !== '__pycache__') cloneTree(join(from, name), join(to, name));
  } else if (st.isFile()) {
    copyFileSync(from, to, fsConstants.COPYFILE_FICLONE);
    chmodSync(to, st.mode & 0o777);
  } else throw new Error(`Unsupported skill file: ${from}`);
}
const touch = (dir) => { try { const now = new Date(); utimesSync(dir, now, now); } catch {} };
// Scoped roots nobody used for a day, and replaced copies, go (a running chat keeps the one it started with).
function pruneScoped(parent, keep) {
  const day = Date.now() - 24 * 3600 * 1000;
  for (const name of readdirSync(parent)) {
    if (name === keep || name.startsWith('.staging-')) continue;
    const dir = join(parent, name);
    try { if (name.startsWith('.replaced-') ? lstatSync(dir).mtimeMs < Date.now() - 3600 * 1000 : lstatSync(dir).mtimeMs < day) rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// Per-turn context: unavailable forks must not be rediscovered as executable instructions.
// Agents may still help review their source while unrelated compatible workflows remain usable.
export function skillSelectionBrief({ studio, appRoot = APP } = {}) {
  if (!studio) return '';
  const s = readState(studio), catalog = loadSkillCatalog(appRoot);
  const entries = Object.values(s?.entries || {}).sort((a, b) => a.id.localeCompare(b.id));
  const blocked = entries.filter((e) => e.mode === 'override' && !e.disabled &&
    forkProblem({ ...e, forkAvailable: true }, catalog.apiVersion));
  const unavailable = new Set(blocked.map((e) => e.id));
  const active = entries.filter((e) => e.published && !e.disabled && !unavailable.has(e.id)).map((e) => ({
    id: e.id, name: e.name, selection: e.mode === 'default' ? 'core' : e.mode === 'override' ? 'fork' : e.mode === 'generated' ? 'format' : 'custom',
    version: e.published.version || null, content: e.published.hash,
  }));
  const disabled = entries.filter((e) => e.disabled).map(({ id, name }) => ({ id, name }));
  // A compatible selection/edit also invalidates cached agent instructions. Use
  // content identities, not random transaction ids, so an unchanged refresh is quiet.
  const revision = hash(JSON.stringify({ api: catalog.apiVersion, active, disabled,
    blocked: blocked.map((e) => e.id), held: Boolean(s?.held) })).slice(0, 24);
  return `Video Octopus skill API: ${catalog.apiVersion}. Core workflows belong to the app; creator preferences and custom versions are separate. ` +
    `Active publication revision: ${revision}. Active skills: ${JSON.stringify(active)}. Disabled skills: ${JSON.stringify(disabled)}. ` +
    'When this revision changes, discard cached instructions for the prior selection and read the relevant SKILL.md from the active .claude/skills publication before using it. Do not use a disabled, absent or saved inactive workflow from chat history. ' +
    (s?.held ? 'A restored skill snapshot is held. Use this active inventory for compatible work; skill choices cannot change until the creator explicitly resumes updates in Settings → Updates. ' : '') +
    (blocked.length ? `Unavailable selected custom workflows: ${blocked.map((e) => e.name).join(', ')}. They need compatibility review and are not active skills. Help the creator review or adapt their saved source when asked, but do not run those workflows until they explicitly confirm compatibility in Settings → Updates or select the latest core version. Confirmation is the creator's review acknowledgement, not an automatic merge or a test result.`
      : 'Use only the active skill publication. Saved inactive custom versions are not additional skills.');
}

// One generated skill per format: a projection of the format's ACTIVE version. SQLite is the authority;
// these folders are rebuilt from it (on approve, activate, rename, archive and every skill sync, including startup).
// Projects get their own copy of their PINNED version in their context folder (see pinnedFormatSkill).
// Importing performs no IO. Nothing here writes skills/custom, approved versions or project files other than
// a project's generated context folder.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, renameSync, lstatSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LearningStore, safeFile, formatSkillName, formatSkillId } from './learning-store.mjs';
import { FileStore, PROJECTED_MANIFEST, projectedManifest, readProjectedManifest, hashFile } from './file-store.mjs';

// Bump when the generated layout or wording changes: unmodified pinned project copies are then regenerated.
export const FORMAT_SKILL_GENERATOR = 1;
const PINNED_MARKER = '.octopus-format-skill.json';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const TYPE_LABELS = { tutorial: 'Tutorial', faceless: 'Faceless', short: 'Short', explainer: 'Explainer' };
const oneLine = (s, max) => {
  const flat = String(s || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

// The approved versions this version builds on, oldest first (follows baseVersion; copies start a new chain).
function lineage(store, version) {
  const chain = [version], seen = new Set([version.id]);
  for (let v = version; v.baseVersion && !seen.has(v.baseVersion);) {
    try { v = store.version(v.baseVersion); } catch { break; }
    seen.add(v.id);
    chain.unshift(v);
  }
  return chain;
}

function evidenceLabel(e, references) {
  if (e.kind === 'instruction') return `Edited in chat: "${oneLine(e.quote, 200)}"`;
  if (e.kind === 'manual') return 'Edited by you';
  const ref = references.get(e.referenceId);
  return `Study: ${ref ? ref.name : 'reference'} — ${oneLine(e.note, 300)}`;
}

// A pinned copy names only its pinned type: target length is a planning hint that may change for future videos.
function setupLine(format, pinned) {
  const type = TYPE_LABELS[format.type] || format.type;
  if (pinned) return type;
  return `${type} · ${format.targetSeconds ? `target ${format.targetSeconds} s` : 'no target length'}`;
}

function write(dest, rel, body) {
  const path = safeFile(dest, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

// Renders the skill folder for one version into dest (which must not exist yet).
// names: { profileName, formatName } — current names for the studio skill, pinned names for a project copy.
// Assets, knowledge and key frames are listed in PROJECTED_MANIFEST. With projectFiles they are cloned from the file
// store now (a project's pinned copy); otherwise the projector clones them after the skill is published.
export function renderFormatSkill(store, { format, version, names, videos = null, pinned = false, activeNumber = null, projectFiles = false }, dest) {
  const name = formatSkillName(format.id);
  const chain = lineage(store, version);
  const references = new Map();
  for (const v of chain) for (const ref of v.evidence || []) if (!references.has(ref.id)) references.set(ref.id, { ...ref, studiedIn: v.number });
  const title = `${names.profileName || 'Channel'} › ${names.formatName || format.name}`;
  const description = oneLine(`${title}: approved ${TYPE_LABELS[format.type] || format.type} format skill (v${version.number}). ` +
    (pinned ? `Pinned copy for one project; it governs that project even if the format has a newer version.`
      : `Use for videos made with this channel and format. A project pinned to another version follows its own pinned copy.`), 900);
  mkdirSync(dest, { recursive: true });
  const projected = [];
  const shaOf = (v, file) => (v.files || []).find((x) => x.file === file);
  const place = (rel, entry) => {
    if (!entry) return false;
    projected.push({ path: rel, sha256: entry.sha256, size: entry.size ?? null });
    if (projectFiles) store.files.project(entry.sha256, safeFile(dest, rel));
    return true;
  };

  const byArea = new Map();
  for (const r of version.rules) byArea.set(r.area, [...(byArea.get(r.area) || []), r]);
  const rulesMd = [`# Rules · ${title} · v${version.number}`, '',
    'Generated from the studio database. Change rules by talking to the format in Video formats; every change is reviewed and saved as a new version.', '',
    ...[...byArea.entries()].flatMap(([area, rules]) => [`## ${area}`, '', ...rules.flatMap((r) => [
      `### ${r.id}`, '', r.text, '', `Confidence: ${r.confidence || 'unspecified'}.`,
      ...(r.evidence || []).map((e) => `- ${evidenceLabel(e, references)}`), ''])])].join('\n');
  write(dest, 'rules.md', rulesMd);

  // Examples: notes and links only. Originals stay in the conversation's intake folder; a few key frames are copied.
  const exampleLines = [`# Examples · ${title}`, '',
    'Studied references for this format. Original files stay in the conversation folder; only key frames are copied here.', ''];
  const framesFor = new Map();
  for (const v of chain) for (const x of v.examples || []) framesFor.set(x.referenceId, { version: v, frames: x.frames });
  for (const ref of references.values()) {
    exampleLines.push(`## ${ref.name}`, '', `- Studied for v${ref.studiedIn}.`);
    if (ref.url) exampleLines.push(`- Link: ${ref.url}`);
    if (ref.file) exampleLines.push(`- Original: ${join(store.sessionDir(chain.find((v) => (v.evidence || []).some((x) => x.id === ref.id))?.sourceSession || version.sourceSession), ref.file)}`);
    if (ref.note) exampleLines.push(`- Note: ${oneLine(ref.note, 1000)}`);
    const cited = version.rules.filter((r) => (r.evidence || []).some((e) => e.referenceId === ref.id)).map((r) => r.id);
    if (cited.length) exampleLines.push(`- Evidence for rules: ${cited.join(', ')}`);
    const frames = framesFor.get(ref.id);
    if (frames) {
      for (const fr of frames.frames) {
        const rel = `examples/${ref.id}/${fr.file.split('/').pop()}`;
        if (!place(rel, shaOf(frames.version, fr.file))) continue;
        exampleLines.push(`- Key frame${fr.seconds === null || fr.seconds === undefined ? '' : ` near ${fr.seconds} s`}: ${rel.slice('examples/'.length)}`);
      }
    }
    exampleLines.push('');
  }
  if (!references.size) exampleLines.push('No studied references yet: this version came from direct edits or chat instructions.', '');
  write(dest, 'examples/examples.md', exampleLines.join('\n'));

  mkdirSync(join(dest, 'assets'), { recursive: true });
  const assetLines = [];
  for (const a of version.assets || []) {
    const rel = `assets/${a.file.split('/').pop()}`;
    place(rel, { sha256: a.sha256, size: a.size ?? shaOf(version, a.file)?.size });
    assetLines.push(`- ${rel}${a.note ? `: ${oneLine(a.note, 300)}` : ''}`);
  }
  // Knowledge: product sheets, specs, brand facts, price lists. SKILL.md keeps only an index, so the agent opens a
  // file when the task needs it.
  const knowledge = version.knowledge || [];
  if (knowledge.length) mkdirSync(join(dest, 'knowledge'), { recursive: true });
  const knowledgeLines = knowledge.map((k) => {
    const rel = `knowledge/${k.file.split('/').pop()}`;
    place(rel, { sha256: k.sha256, size: k.size ?? shaOf(version, k.file)?.size });
    return `- **${oneLine(k.title || k.name || rel, 120)}**${k.note ? ` — ${oneLine(k.note, 200)}` : ''} (${rel})`;
  });
  write(dest, PROJECTED_MANIFEST, projectedManifest(projected));

  const learnings = version.learnings || [];
  write(dest, 'learnings.md', [`# Learnings · ${title}`, '',
    'Observations from studies and conversations. They are context, not rules.', '',
    ...(learnings.length ? learnings.flatMap((l) => [`- ${l.text}`, ...(l.evidence || []).map((e) => `  - ${evidenceLabel(e, references)}`)])
      : ['No learnings recorded yet.']), ''].join('\n'));

  if (videos) {
    const groups = new Map();
    for (const row of videos) groups.set(row.number, [...(groups.get(row.number) || []), row]);
    const lines = [`# Videos · ${title}`, '', 'Projects made with this format, by the version they are pinned to. Each keeps its version.', ''];
    for (const number of [...groups.keys()].sort((a, b) => (b || 0) - (a || 0))) {
      lines.push(`## ${number ? `v${number}` : 'Unknown version'}${number === activeNumber ? ' (active)' : ''}`, '');
      for (const row of groups.get(number)) lines.push(`- ${row.name || row.project}${row.created ? ` — ${String(row.created).slice(0, 10)}` : ''} (${row.project})`);
      lines.push('');
    }
    if (!videos.length) lines.push('No videos use this format yet.', '');
    write(dest, 'videos.md', lines.join('\n'));
  }

  const summary = version.rules.slice(0, 40).map((r) => `- **${r.area} · ${r.id}**: ${oneLine(r.text, 280)}`);
  const skill = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    `# ${title}`,
    '',
    `Approved format skill, version v${version.number} (${version.id}), saved ${String(version.created).slice(0, 10)}. Setup: ${setupLine(format, pinned)}.`,
    '',
    '## When to use it',
    '',
    pinned
      ? `This project is pinned to v${version.number} of this format. This copy governs this project even if the format's active skill is newer${activeNumber && activeNumber !== version.number ? ` (now v${activeNumber})` : ''}; do not use a studio-wide copy of ${name} for this project.`
      : `Use it for a video whose project context names this format (${format.id}). A project pinned to another version of this format follows that version's copy in its own context folder, not this one.`,
    '',
    '## Rules summary',
    '',
    ...summary,
    ...(version.rules.length > summary.length ? [`- …and ${version.rules.length - summary.length} more in rules.md.`] : []),
    '',
    '## Workflow',
    '',
    version.workflow,
    '',
    '## Files',
    '',
    '- rules.md: every approved rule with its evidence.',
    '- examples/examples.md: studied references (links, original paths, notes) and key frames.',
    '- assets/: approved reusable assets (backgrounds, icons, motion graphics, styles).' + (assetLines.length ? '' : ' None yet.'),
    ...assetLines.map((x) => `  ${x}`),
    ...(knowledgeLines.length ? ['- knowledge/: reference facts for this format (see the index below). Open a file only when the task needs it.'] : []),
    '- learnings.md: observations, not rules.',
    ...(videos ? ['- videos.md: projects made with each version.'] : []),
    '',
    ...(knowledgeLines.length ? ['## Knowledge index', '', ...knowledgeLines, ''] : []),
    'These files are generated from the studio database: do not edit them. Propose changes in a format conversation (Video formats → Talk to this format); the creator reviews each draft and saves it as a new version.',
    '',
  ].join('\n');
  write(dest, 'SKILL.md', skill);
  return { name, summary: oneLine(description, 320) };
}

// Every visible format with an approved version, rendered for the managed-skills publication.
// Formats that fail to render keep their previous publication (listed in keep) instead of blocking every skill.
export function generateFormatSkills(studio, stageRoot, { projectName = () => null } = {}) {
  // No database yet means no formats; never create one here (a missing database may need a restore instead).
  if (!existsSync(join(studio, '.studio', 'studio.sqlite'))) return { items: [], keep: [], problems: [] };
  const store = new LearningStore(studio);
  try {
    const items = [], keep = [], problems = [];
    for (const format of store.list('formats')) {
      if (!format.activeVersion || store.formatArchived(format)) continue;
      try {
        const version = store.version(format.activeVersion), profile = store.get('profiles', format.profileId);
        const videos = store.formatVideos(format.id).map((row) => ({ ...row, name: projectName(row.project) }));
        const dir = join(stageRoot, formatSkillName(format.id));
        rmSync(dir, { recursive: true, force: true });
        const rendered = renderFormatSkill(store, { format, version, names: { profileName: profile.name, formatName: format.name }, videos, activeNumber: version.number }, dir);
        items.push({ id: formatSkillId(format.id), name: rendered.name, dir, summary: rendered.summary, formatId: format.id, versionId: version.id });
      } catch (e) {
        keep.push(formatSkillId(format.id));
        problems.push(`${format.name}: ${e.message}`);
      }
    }
    return { items, keep, problems };
  } finally { store.close(); }
}

function filesOf(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name), st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error('Generated project context cannot contain links.');
      if (st.isDirectory()) walk(p);
      else if (name !== PINNED_MARKER) out[relative(dir, p).split(sep).join('/')] = hashFile(p);
    }
  };
  walk(dir);
  return out;
}

// A project's own copy of its pinned version, inside its generated context skill root. Names come from the pin,
// so a later rename never changes it. Unmodified copies from an older generator are regenerated; edited ones fail
// like any other generated context file.
export function pinnedFormatSkill(store, bundle, skillRoot) {
  if (!bundle?.versionId || !bundle.formatId) return null;
  const format = store.get('formats', bundle.formatId), version = store.version(bundle.versionId);
  if (version.formatId !== format.id) throw new Error('Pinned version belongs to another format.');
  const name = formatSkillName(format.id), target = safeFile(skillRoot, name);
  const active = format.activeVersion ? store.get('versions', format.activeVersion) : null;
  const result = { name, path: target, versionId: version.id, number: version.number, activeNumber: active?.number || null };
  if (existsSync(target)) {
    let marker = null;
    try { marker = JSON.parse(readFileSync(safeFile(target, PINNED_MARKER), 'utf8')); } catch {}
    const files = marker?.files && filesOf(target);
    if (!marker || JSON.stringify(files) !== JSON.stringify(marker.files)) {
      throw new Error('Generated project context changed. Restore its files from the project context panel.');
    }
    if (marker.generator === FORMAT_SKILL_GENERATOR && marker.versionId === version.id) return result;
    rmSync(target, { recursive: true, force: true });
  }
  const staging = safeFile(skillRoot, `.${name}.staging-${randomUUID()}`);
  try {
    const pinnedFormat = { ...format, type: bundle.type || format.type };
    renderFormatSkill(store, { format: pinnedFormat, version, names: { profileName: bundle.profileName, formatName: bundle.formatName }, pinned: true, activeNumber: null, projectFiles: true }, staging);
    writeFileSync(safeFile(staging, PINNED_MARKER), JSON.stringify({ generator: FORMAT_SKILL_GENERATOR, formatId: format.id, versionId: version.id, files: filesOf(staging) }, null, 2));
    renameSync(staging, target);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  return result;
}

// After every skill sync: clone each published format skill's assets, knowledge and key frames from the file store
// (the managed-skills snapshot leaves them out, so SQLite never holds their bytes). A file that no longer matches is
// kept aside in .studio/edited-skill-files and restored. Returns problems instead of failing the skill sync.
export function projectPublishedFiles(studio, folders) {
  const problems = [];
  if (!folders.length) return problems;
  const files = new FileStore(studio);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const folder of folders) {
    let dir;
    try {
      dir = safeFile(studio, `.claude/skills/${folder}`);
      if (!existsSync(join(dir, 'SKILL.md'))) continue;
      for (const entry of readProjectedManifest(dir)) {
        const target = safeFile(dir, entry.path);
        if (existsSync(target)) {
          const st = lstatSync(target);
          if (st.isFile() && hashFile(target) === entry.sha256) continue;
          const aside = safeFile(studio, `.studio/edited-skill-files/${stamp}-${folder}/${entry.path}`);
          mkdirSync(dirname(aside), { recursive: true });
          renameSync(target, aside);
          problems.push(`${folder}/${entry.path} was changed outside Video formats. It was restored; the edited copy is in ${aside}.`);
        }
        files.project(entry.sha256, target);
      }
    } catch (e) {
      problems.push(`${folder}: ${e.message}`);
    }
  }
  return problems;
}

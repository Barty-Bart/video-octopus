// Automatic project names (design V2 §6; Bart approved the naming proposal on 23 October 2026).
// New video makes "Untitled video" straight away, with nameSource 'auto' in project.json. While the name is still
// automatic, two things may rename it, and only these two:
//   - the project agent's own reply, with a fenced ```octopus-name block (index.mjs reads its `text` events), and
//   - the Packaging working title, when the creator saves it (packaging.mjs).
// A rename by the creator (POST /api/projects/<id>/rename) sets nameSource 'manual', and then nothing automatic
// touches the name again. Only the display name changes: the project's folder and id never do.
import { projectDir, projectMeta, saveProjectMeta, appendWorklog } from './studio.mjs';

export const UNTITLED = 'Untitled video';
export const NAME_MAX = 60;

const listeners = new Set();
// fn(id, name, by): an automatic rename happened (index.mjs tells the project's open pages).
export function onAutoRename(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// One line of plain text, at most NAME_MAX characters (cut at a word when it can be), without wrapping quotes.
export function cleanName(raw) {
  const line = String(raw ?? '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
  let name = line
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/^[\s"'“”‘’`*#]+|[\s"'“”‘’`*]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length > NAME_MAX) {
    const cut = name.slice(0, NAME_MAX);
    name = (cut.replace(/\s+\S*$/, '') || cut).trim();
  }
  return name || null;
}

// The name the agent proposes in its own reply: the first ```octopus-name block, or null.
export function nameFromReply(text) {
  const m = /```octopus-name[ \t]*\r?\n([\s\S]*?)```/.exec(String(text || ''));
  return m ? cleanName(m[1]) : null;
}

// Is this project's name still automatic? (project.json, or the meta already read.)
export const nameIsAuto = (meta) => meta?.nameSource === 'auto';

// Apply an automatic name. by: 'agent' | 'title'. The creator's working title outranks the agent: once a title has
// named the video, the agent's later proposals don't replace it (a newer working title still does).
// Returns the new name, or null when nothing changed.
export function autoName(id, raw, by) {
  const dir = projectDir(id);
  if (!dir) return null;
  const meta = projectMeta(dir);
  if (!nameIsAuto(meta)) return null;
  if (by === 'agent' && meta.autoNamedBy === 'title') return null;
  const name = cleanName(raw);
  if (!name || name === meta.name) return null;
  saveProjectMeta(dir, { name, autoNamedBy: by });
  const how = by === 'title' ? 'from the Packaging working title' : 'by the agent';
  appendWorklog(dir, `Named “${name}” ${how}. Renaming it by hand keeps your name.`);
  for (const fn of listeners) {
    try { fn(id, name, by); } catch (e) { console.error(`Rename listener: ${e.message}`); }
  }
  return name;
}

// The line the project agent's context gets while the name is automatic and no working title has named it.
export function namingContext(meta) {
  if (!nameIsAuto(meta) || meta.autoNamedBy === 'title') return '';
  const now = meta.autoNamedBy === 'agent'
    ? `You named this video “${meta.name}”. Propose a new name only if the creator's description of the video changes a lot.`
    : `This video has no name yet: it shows as “${meta.name || UNTITLED}”.`;
  return `${now} Once the creator has described what the video is about, propose a short title (at most ${NAME_MAX} characters, plain words) once, on its own in a fenced block: \`\`\`octopus-name\nThe title\n\`\`\`. Video Octopus applies it as the video's display name (its folder stays the same). A name the creator gives the video by hand always wins, and then you stop proposing names.`;
}

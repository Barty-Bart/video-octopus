// The scope ladder one project sees: global → profile:<channel> → format:<format> → project:<id>. Memories and
// resources store exactly one of these strings per record, so which levels exist is data, not schema. Adding a level
// later (Format for resources) means adding its name to the list a feature uses; hiding one means taking it out, and
// its records then show under the nearest level that is still on (nothing is rewritten or deleted).
// Pure functions: no database, files or settings.

export const LEVELS = ['global', 'profile', 'format', 'project'];
// Memories keep every level (older format: and project: memories must keep reaching their chats).
export const MEMORY_LEVELS = LEVELS;
// Resources for Packaging (MVP): All channels · Channel · This video. Format stays off with no UI (PLAN.md, follow-up
// decisions); turning it on is adding 'format' here.
export const RESOURCE_LEVELS = ['global', 'profile', 'project'];

const PREFIXES = new Set(['profile', 'format', 'project']);

// "profile:abc" → { level: 'profile', id: 'abc' }; "global" → { level: 'global', id: null }; anything else → null.
export function parseScope(scope) {
  if (scope === 'global') return { level: 'global', id: null };
  const text = String(scope ?? '');
  const colon = text.indexOf(':');
  if (colon < 1) return null;
  const level = text.slice(0, colon), id = text.slice(colon + 1);
  if (!PREFIXES.has(level) || !id || id.includes(':')) return null;
  return { level, id };
}

// The ladder for one chat or project, broadest first. A format implies its channel, so callers pass both when they
// know them. levels filters which rungs appear; a missing id simply leaves its rung out.
export function scopeChain({ profileId = null, formatId = null, project = null } = {}, { levels = LEVELS } = {}) {
  const on = new Set(levels);
  const chain = [];
  if (on.has('global')) chain.push('global');
  if (profileId && on.has('profile')) chain.push(`profile:${profileId}`);
  if (formatId && on.has('format')) chain.push(`format:${formatId}`);
  if (project && on.has('project')) chain.push(`project:${project}`);
  return chain;
}

// Where a record at `scope` shows when its own level is switched off: the nearest broader level that is on, in this
// project's full chain. { shownAt, from } — from is the record's own scope when it was moved up, else null. A scope that
// is not in the chain at all (another channel's, another video's) is not visible: null.
export function visibleAt(scope, ids, { levels = LEVELS } = {}) {
  const full = scopeChain(ids, { levels: LEVELS });
  const index = full.indexOf(scope);
  if (index < 0) return null;
  const on = new Set(levels);
  for (let i = index; i >= 0; i--) {
    const level = parseScope(full[i])?.level;
    if (on.has(level)) return { shownAt: full[i], from: i === index ? null : scope };
  }
  return null;
}

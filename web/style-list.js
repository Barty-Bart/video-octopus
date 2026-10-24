// My styles (Flat 3, ADDENDUM-styles-gallery.md): the flat list of styles. A style is a format; the brand kit it
// uses is its profile. Pure functions (no DOM, no fetch), shared by the My styles page, a kit's Styles tab and the
// editor's style picker, and tested in test/style-list.test.mjs.

import { COLOR, kitColor, idColor } from './kit-colors.js';

export { COLOR, kitColor };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const MAX_COVER_VIDEOS = 4;

// The orientation and badge of a video setup: "Short · 9:16" (tall) or "Long · 16:9" (wide), and whether it is made
// on camera (a presenter) or faceless (narration over visuals), for the drawn cover.
export function setupShape(type, formatInfo = {}) {
  const aspect = formatInfo[type]?.aspect || (type === 'short' ? '9:16' : '16:9');
  const [w, h] = aspect.split(':').map(Number);
  const tall = h > w;
  const camera = typeof formatInfo[type]?.camera === 'boolean' ? formatInfo[type].camera : type !== 'faceless';
  return { aspect, tall, camera, badge: `${tall ? 'Short' : 'Long'} · ${aspect}` };
}

// The first letter or digit of a name, for the drawn cover.
export const initialOf = (name) => (String(name || '').match(/[\p{L}\p{N}]/u)?.[0] || '•').toUpperCase();

// One entry per style, most recently used first (its newest video, else when the style was last changed).
// data: { profiles, formats, versions, projects, drafts (Map formatId → changes waiting), formatInfo }.
// opts: { archived: include archived styles (and styles of archived kits), profileId: only this kit's }.
export function styleEntries(data, opts = {}) {
  const { profiles = [], formats = [], versions = [], projects = [], drafts = new Map(), formatInfo = {} } = data;
  const kits = new Map(profiles.map((p) => [p.id, p]));
  const lastUse = new Map(), videos = new Map(), made = new Map();
  for (const p of projects) {
    if (!p.formatId) continue;
    videos.set(p.formatId, (videos.get(p.formatId) || 0) + 1);
    lastUse.set(p.formatId, Math.max(lastUse.get(p.formatId) || 0, Number(p.updated) || 0));
    made.set(p.formatId, [...(made.get(p.formatId) || []), p]);
  }
  // The style's newest videos, for its cover picture (server/style-covers.mjs looks there first).
  const coverVideos = (id) => (made.get(id) || []).slice().sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0))
    .slice(0, MAX_COVER_VIDEOS).map((p) => p.id);
  const stamp = (iso) => { const t = Date.parse(iso || ''); return Number.isNaN(t) ? 0 : t; };
  return formats
    .filter((f) => !opts.profileId || f.profileId === opts.profileId)
    .map((f) => {
      const kit = kits.get(f.profileId) || null;
      const unbranded = !kit || Boolean(kit.system);
      const shape = setupShape(f.type, formatInfo);
      const number = f.activeVersion ? versions.find((v) => v.id === f.activeVersion)?.number || null : null;
      const used = videos.get(f.id) || 0;
      const archived = Boolean(f.archived || kit?.archived);
      const color = unbranded ? null : kitColor(kit);
      return {
        id: f.id, name: f.name, description: f.description || '', type: f.type, profileId: f.profileId,
        kitName: unbranded ? 'No brand' : kit.name, kitColor: color, unbranded,
        // The drawn cover: the kit colour; a No brand style (or a kit not yet given a colour) one derived from its id.
        coverColor: color || idColor(f.id), initial: initialOf(f.name), camera: shape.camera, coverVideos: coverVideos(f.id),
        tall: shape.tall, aspect: shape.aspect, badge: shape.badge, version: number, videos: used,
        meta: `${number ? `Skill v${number}` : 'Basic'} · ${used ? plural(used, 'video') : 'no videos yet'}`,
        changes: drafts.get(f.id) || 0, archived,
        lastUsed: Math.max(lastUse.get(f.id) || 0, stamp(f.updated), stamp(f.created)),
      };
    })
    .filter((x) => opts.archived || !x.archived)
    .sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name));
}

// The editor's style picker (Flat 3 §4, Decision 6): a flat list, no grouping by kit. Each style row carries its
// kit chip (dot in the kit colour; No brand has none); then "No style · decide as I go" and "+ New style from this video". After a Build step a style with
// another video setup is locked (the server refuses it too). context: the project's { profileId, formatId }.
export function pickerItems(entries, { context = {}, built = false, type = null } = {}) {
  const current = context.formatId || null;
  const rows = entries
    .filter((e) => !e.archived || e.id === current)
    .map((e) => ({
      kind: 'style', formatId: e.id, profileId: e.profileId, label: e.name, kit: e.kitName, kitColor: e.kitColor,
      tall: e.tall, locked: Boolean(built && type && e.type !== type), selected: e.id === current,
    }));
  // A video pinned to a kit without a style (beta.14 allowed that) keeps its row until it picks another.
  if (!current && context.profileId) {
    rows.unshift({ kind: 'kit-only', formatId: null, profileId: context.profileId, label: context.profileName || 'Brand kit only', kit: context.profileName || '', selected: true });
  }
  return [
    ...rows,
    { kind: 'none', formatId: null, profileId: null, label: 'No style · decide as I go', selected: !current && !context.profileId },
    { kind: 'new', label: '+ New style from this video' },
  ];
}

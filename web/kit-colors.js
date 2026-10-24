// Brand kit colours (My styles, Flat 3). Every kit has a colour: its approved brand's first colour, else a kit colour
// picked automatically from this palette when the kit is made (an older kit gets one once, when the studio opens) and
// saved on the kit (profile `color`). The creator can change it on the kit's Brand tab. It is display only: covers,
// dots and avatars. It is never written into the brand (BRAND.md, brand colours, project context).
// Pure: no DOM, no fetch; used by the server (server/learning-store.mjs, server/profiles.mjs) and the browser.

export const COLOR = /^#[0-9a-f]{6}$/i;

// Distinct, saturated but not loud, and each reads with white or near-black text (avatarInk) at 4.5:1 or better.
// The order is the order kits receive them, so the first few kits get clearly different hues.
export const KIT_PALETTE = [
  ['#4f5bd5', 'Indigo'], ['#c4532a', 'Ember'], ['#0e8578', 'Teal'], ['#c4386c', 'Raspberry'],
  ['#e0a526', 'Amber'], ['#7150d8', 'Violet'], ['#2f8545', 'Green'], ['#2a72c0', 'Azure'],
  ['#a043b6', 'Orchid'], ['#cc3f3f', 'Red'], ['#1f6f80', 'Petrol'], ['#946233', 'Copper'],
];
const HEXES = KIT_PALETTE.map(([hex]) => hex);

export const cleanColor = (c) => (typeof c === 'string' && COLOR.test(c) ? c.toLowerCase() : null);
const brandColor = (profile) => cleanColor(profile?.brand?.brand?.colors?.[0]);

// A kit's colour: its approved brand's first colour, else its saved kit colour, else null (No brand, or a kit read
// before the studio was opened by this version: callers fall back to autoKitColors).
export function kitColor(profile) {
  if (!profile || profile.system) return null;
  return brandColor(profile) || cleanColor(profile.color);
}

// The next automatic colour: the first palette colour no other kit shows; when all twelve are taken, the palette
// again in order (by how many kits there are), so the choice is still deterministic.
export function nextKitColor(taken = [], count = taken.length) {
  const used = new Set(taken.map(cleanColor).filter(Boolean));
  return HEXES.find((hex) => !used.has(hex)) || HEXES[count % HEXES.length];
}

// The kit colours to save for kits that have none (profiles in creation order, oldest first): Map id → hex. Kits
// without a brand colour are served first, so they get the most distinct hues; a kit with a brand colour still gets
// a saved one (shown if its brand ever loses its colours). Colours other kits already show count as taken.
export function autoKitColors(profiles = []) {
  const kits = profiles.filter((p) => p && !p.system);
  const saved = (p) => cleanColor(p.color);
  const taken = kits.map(kitColor).filter(Boolean);
  const out = new Map();
  const order = [...kits.filter((p) => !brandColor(p)), ...kits.filter((p) => brandColor(p))];
  for (const p of order) {
    if (saved(p)) continue;
    const hex = nextKitColor(taken, kits.indexOf(p));
    taken.push(hex);
    out.set(p.id, hex);
  }
  return out;
}

// A colour for something without a kit (a No brand style's cover), derived from its id: stable, from the palette.
export function idColor(id = '') {
  let n = 2166136261;
  for (const ch of String(id)) n = Math.imul(n ^ ch.charCodeAt(0), 16777619) >>> 0;
  return HEXES[n % HEXES.length];
}

// Text on a kit colour: white or near-black, whichever reads better (WCAG contrast). The theme's --text can't be
// used here: it turns light in the dark theme, while the kit colour stays the same.
export function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
export const INK_DARK = '#141416';
export function avatarInk(hex) {
  const l = luminance(hex);
  const onWhite = 1.05 / (l + 0.05), onDark = (l + 0.05) / (luminance(INK_DARK) + 0.05);
  return onWhite >= onDark ? '#ffffff' : INK_DARK;
}
export function inkContrast(hex) {
  const l = luminance(hex);
  return Math.max(1.05 / (l + 0.05), (l + 0.05) / (luminance(INK_DARK) + 0.05));
}

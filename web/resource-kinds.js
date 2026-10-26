// Simple mode's Resources page (V1 spec §4): the five kinds of file the creator keeps for every video, and how each is
// stored as a resource (server/resource-store.mjs) at the built-in profile's level (profile:<My brand>). Pure: no DOM,
// no fetch; used by the server (server/simple-resources.mjs) and the page (web/resources-page.js).
//   kind      the resource kind it is stored as
//   likeness  who is in it (a photo of you is "Me"; everything else has no people)
//   use       always: attached to every thumbnail Generate (photos of you); ask: listed for Claude, used when it fits
//   line      the tile's one line of use
export const SIMPLE_KINDS = {
  logo: { label: 'Logo', line: 'Your logo', kind: 'logo', likeness: 'nobody', use: 'ask' },
  font: { label: 'Font', line: 'Your font', kind: 'font', likeness: 'nobody', use: 'ask' },
  photo: { label: 'Photo of you', line: 'Used in thumbnails', kind: 'photo', likeness: 'self', use: 'always' },
  product: { label: 'Product', line: 'Your product', kind: 'product', likeness: 'nobody', use: 'ask' },
  clip: { label: 'Clip', line: 'Video clip', kind: 'clip', likeness: 'nobody', use: 'ask' },
};
export const SIMPLE_KIND_KEYS = Object.keys(SIMPLE_KINDS);
// The kinds a picture can be (the upload's one question, and the tile menu's "Use as").
export const PICTURE_KINDS = ['photo', 'product', 'logo'];

export const IMAGE_FILE = /\.(png|jpe?g|webp|gif|svg)$/i;
export const FONT_FILE = /\.(ttf|otf|woff2?)$/i;
export const VIDEO_FILE = /\.(mp4|mov|m4v|webm)$/i;
export const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.svg,.ttf,.otf,.woff,.woff2,.mp4,.mov,.m4v,.webm';

// What an upload is, from its name alone: a font, a clip, a logo (an SVG, or "logo" in the name), or null for a
// picture, which asks one question ("Is this a photo of you?"). Unsupported files: 'unsupported'.
export function guessKind(name = '') {
  const n = String(name);
  if (FONT_FILE.test(n)) return 'font';
  if (VIDEO_FILE.test(n)) return 'clip';
  if (!IMAGE_FILE.test(n)) return 'unsupported';
  if (/\.svg$/i.test(n) || /(^|[^a-z])logo/i.test(n)) return 'logo';
  return null;
}

// A file dropped for Claude in a video, added to Resources too ("Also add to Resources", V1 §6): the kind it is stored
// as without asking. Fonts, clips and logos are known by name; any other picture is most likely a product shot or a
// screenshot (product; "Use as" on the Resources page changes it). null: Resources doesn't keep this kind of file
// (sound, PDF, text), so the link isn't offered.
export function dropKind(name = '') {
  const k = guessKind(name);
  return k === 'unsupported' ? null : k || 'product';
}

// A resource's Simple kind (logo | font | photo | product | clip), or null for anything else at that level (an image
// or reference thumbnail added from a Simple video's Packaging tab, a style note). A photo of someone else is not "of
// you": it shows as null too.
export function simpleKindOf(r) {
  if (!r) return null;
  if (r.kind === 'photo') return r.likeness === 'self' ? 'photo' : null;
  return SIMPLE_KINDS[r.kind] && r.kind !== 'photo' ? r.kind : null;
}

// The resource fields for a Simple kind (what addResource / updateResource take).
export function resourceFields(kind) {
  const k = SIMPLE_KINDS[kind];
  if (!k) throw new Error('Choose what this is: logo, font, photo of you, product or clip.');
  return { kind: k.kind, likeness: k.likeness, use: k.use };
}

// Can a file of this name be this kind? (A picture can be a logo, photo of you or product; fonts and clips stay what
// they are.)
export function fitsKind(name, kind) {
  if (kind === 'font') return FONT_FILE.test(name);
  if (kind === 'clip') return VIDEO_FILE.test(name);
  return IMAGE_FILE.test(name);
}

// "Me at my desk" → "Me at my desk.jpg": a rename keeps the file's own extension.
export function renamed(name, ext) {
  const t = String(name || '').trim();
  if (!t) throw new Error('Give it a name.');
  const e = String(ext || '').toLowerCase();
  return e && !t.toLowerCase().endsWith(e) ? `${t}${e}` : t;
}

// The look's colours: the main colour first (the built-in kit colour: covers and dots use a kit's first brand colour,
// web/kit-colors.js), then up to five more. Lower case, no repeats, six-digit hex only.
export function lookColors(main, more = []) {
  const ok = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
  const out = [];
  for (const c of [main, ...more]) if (ok(c) && !out.includes(c.toLowerCase())) out.push(c.toLowerCase());
  return out.slice(0, 6);
}

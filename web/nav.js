// Page navigation, one page at a time. `open(nav)` loads the page for the current hash and returns it ({ teardown })
// or null. A newer navigation aborts the one still loading (nav.signal, nav.alive() turns false, so the page can skip
// work and stop polling early), waits for it to finish, then tears it down before the next page loads. So every page
// that loaded is torn down, even one left during its first load, and a slow page can't draw over the next one.
// `reset()` runs before every page opens, after the last one's teardown: a page that failed while loading never
// returned its teardown, so whatever it set up on <body> (its page classes) is undone here instead.
import { hiddenInSimple } from './simple.js';

export function makeRouter(open, { onError = (e) => console.error(e), reset = () => {} } = {}) {
  let current = null, chain = Promise.resolve(), ctl = null;
  return function navigate() {
    ctl?.abort();
    const mine = ctl = new AbortController();
    chain = chain.then(async () => {
      current?.teardown?.();
      current = null;
      reset();
      if (mine.signal.aborted) return; // an even newer navigation is queued: this page needn't load at all
      current = (await open({ signal: mine.signal, alive: () => !mine.signal.aborted })) || null;
    }).catch(onError);
    return chain;
  };
}

// The classes a page puts on <body>: the shell pages (Projects, Recordings, styles…) `in-home`, Settings and Setup
// also `in-app-page`, the editor `in-project`. `in-home` hides the editor's top bar, so one left over from a page that
// failed to load (Settings while the server restarts, say) used to take the editor's bar and its way back with it.
// The router clears them all before each page (makeRouter reset).
export const PAGE_CLASSES = ['in-home', 'in-app-page', 'in-project'];

// Direction A routes (23 Oct 2026), the V2 Settings groups and the Flat 3 "My styles" pages. Old addresses keep
// working: the router asks `legacyRoute` first and, when it returns a new address, replaces the old one in place (no
// extra history entry) before drawing the page.
//
// Flat 3 (ADDENDUM-styles-gallery.md): a style is a format and a brand kit is a profile. Beta.14's style pages were
// keyed by profile (#/style/<profileId>/<tab>); now #/style/<formatId>/<tab> is a style and #/styles/kit/<profileId>
// a brand kit. Both use ids of the same shape, so the profile-keyed addresses are told apart by looking the id up:
// `legacyRoute(hash, lookup)` with lookup = { profiles: [{ id }], formats: [{ id, profileId }], sessions: [{ id,
// formatId }] } (the /api/learning view). Without a lookup only the addresses that need none are rewritten.
// `_` as an id means "work it out on the page": from the format, session, chat or scope in the query, else the
// remembered kit, else the first one.
const withQuery = (base, query) => {
  const text = query.toString();
  return text ? `${base}?${text}` : base;
};

// Settings in six groups (design V2 §8): #/settings/<group>[/<section>]. The old one-section-per-page addresses
// (#/settings/claude…) land on their group, scrolled to the section.
export const SETTINGS_GROUPS = ['general', 'agent', 'recording', 'editing', 'export', 'storage'];
export const SETTINGS_SECTION_GROUP = {
  editor: 'general', appearance: 'general', updates: 'general',
  claude: 'agent',
  recorder: 'recording', transcribe: 'recording',
  editing: 'editing', sound: 'editing', look: 'editing',
  render: 'export',
  folders: 'storage', storage: 'storage', playback: 'storage', trash: 'storage', usage: 'storage',
};

// The style pages (Flat 3): #/styles[/instructions|/memories|/kits], a style #/style/<formatId>/<tab> and a brand
// kit #/styles/kit/<profileId>/<tab>. The side-column panels of a style's Skill tab are ?panel=<name>.
export const STYLE_TABS = ['skill', 'examples', 'brand', 'people', 'memories'];
export const STYLES_TABS = ['instructions', 'memories', 'kits'];
export const KIT_TABS = ['brand', 'people', 'memories', 'styles'];
export const STYLE_PANELS = ['files', 'insights', 'history', 'videos'];
// Beta.14's format-home tabs → the style page: skill and examples are tabs, the rest are Skill-tab panels.
const OLD_FORMAT_TAB = { skill: ['skill'], examples: ['examples'], files: ['skill', 'files'], learnings: ['skill', 'insights'], insights: ['skill', 'insights'], history: ['skill', 'history'], videos: ['skill', 'videos'] };

// A style's page: styleHref('F', 'examples') → '#/style/F/examples'.
export function styleHref(formatId, tab = '', query = null) {
  return linkTo(`#/style/${encodeURIComponent(formatId || '_')}${tab ? `/${tab}` : ''}`, query);
}
// A brand kit's page: kitHref('P', 'memories') → '#/styles/kit/P/memories'.
export function kitHref(profileId, tab = '', query = null) {
  return linkTo(`#/styles/kit/${encodeURIComponent(profileId || '_')}${tab ? `/${tab}` : ''}`, query);
}
function linkTo(base, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== '') params.set(key, value);
  }
  return withQuery(base, params);
}

// Does this address need the lookup to be rewritten (a #/style/<id> address whose id may be a profile's)?
export function routeNeedsLookup(hash) {
  const path = String(hash || '').split('?')[0];
  return /^#\/(style|channel)\/[^/]+/.test(path) || path === '#/learning';
}

// One rewrite step; legacyRoute repeats it until the address is current (#/channel/… → #/style/<profile>/… → kit).
function rewrite(raw, lookup) {
  const cut = raw.indexOf('?');
  const path = cut < 0 ? raw : raw.slice(0, cut);
  const query = new URLSearchParams(cut < 0 ? '' : raw.slice(cut + 1));

  if (path === '#/learning') {
    const profile = query.get('profile');
    query.delete('profile');
    return withQuery(`#/style/${profile ? encodeURIComponent(profile) : '_'}/formats`, query);
  }
  if (path === '#/memories') {
    const scope = query.get('scope') || '';
    if (!query.has('chat') && (!scope || scope === 'global')) return '#/styles/memories';
    if (!query.has('chat') && scope.startsWith('profile:')) return kitHref(scope.slice('profile:'.length), 'memories');
    return withQuery('#/styles/kit/_/memories', query);
  }
  if (path === '#/storage') return '#/settings/storage/storage';
  if (path === '#/dashboard') return '#/settings/storage/usage';
  if (path === '#/settings/brand') return '#/styles/kit/_/brand';
  if (path === '#/settings/instructions') return '#/styles/instructions';
  // Direction A's channel pages: #/channels[/<tab>] → #/styles[/<tab>], #/channel/<id>[/<tab>] → #/style/<id>[/<tab>].
  const channels = /^#\/channels(?:\/([^/]*))?\/?$/.exec(path);
  if (channels) return withQuery(`#/styles${channels[1] ? `/${channels[1]}` : ''}`, query);
  const channel = /^#\/channel(\/.*)?$/.exec(path);
  if (channel) return withQuery(`#/style${channel[1] || ''}`, query);
  const old = /^#\/settings\/([a-z]+)$/.exec(path);
  if (old && !SETTINGS_GROUPS.includes(old[1]) && SETTINGS_SECTION_GROUP[old[1]]) {
    return withQuery(`#/settings/${SETTINGS_SECTION_GROUP[old[1]]}/${old[1]}`, query);
  }
  const style = /^#\/style\/([^/]+)(?:\/([^/]*))?\/?$/.exec(path);
  if (style) return oldStyleRoute(style[1], style[2] || '', query, lookup);
  return null;
}

// Beta.14's profile-keyed style pages. Returns null for a current (format-keyed) address.
function oldStyleRoute(rawId, tab, query, lookup) {
  let id = rawId;
  try { id = decodeURIComponent(rawId); } catch {}
  const isFormat = (x) => Boolean(lookup?.formats?.some((f) => f.id === x));
  const isProfile = (x) => x === '_' || Boolean(lookup?.profiles?.some((p) => p.id === x));
  const sessionFormat = (x) => lookup?.sessions?.find((s) => s.id === x)?.formatId || null;
  if (tab === 'formats' || (tab === '' && id === '_')) {
    // The old Formats tab: ?format=<F>&tab=<t>&session=<S> → the style F, its tab or Skill-tab panel.
    const format = query.get('format') || sessionFormat(query.get('session'));
    if (format) {
      const [next, panel] = OLD_FORMAT_TAB[query.get('tab')] || ['skill'];
      const kept = new URLSearchParams(query);
      for (const key of ['format', 'tab']) kept.delete(key);
      if (panel) kept.set('panel', panel);
      return withQuery(`#/style/${encodeURIComponent(format)}/${next}`, kept);
    }
    if (query.get('session') && !lookup) return null; // which style it was needs the lookup (or the page) to say
    const kept = new URLSearchParams(query);
    kept.delete('tab');
    kept.delete('session');
    // A legacy-notes hand-off (Library) or no style at all: My styles, where a style is picked.
    if (id === '_') return withQuery('#/styles', kept);
    return withQuery(kitHref(id, 'styles'), kept);
  }
  if (id === '_') {
    if (tab === 'brand' || tab === 'memories') return withQuery(kitHref('_', tab), query);
    return null;
  }
  if (!lookup || isFormat(id) || !isProfile(id)) return null; // a style's own address (or one nobody knows)
  if (tab === 'brand' || tab === 'memories') return withQuery(kitHref(id, tab), query);
  return withQuery(kitHref(id, 'styles'), query);
}

export function legacyRoute(hash, lookup = null) {
  let raw = String(hash || ''), moved = null;
  for (let i = 0; i < 4; i++) {
    const next = rewrite(raw, lookup);
    if (!next || next === raw) break;
    moved = raw = next;
  }
  return moved;
}

// The app-level page for a hash: { page, ...details }. Projects (`#/` and anything unknown) is the default.
export function parseRoute(hash) {
  const raw = String(hash || '');
  const cut = raw.indexOf('?');
  const path = cut < 0 ? raw : raw.slice(0, cut);
  const query = new URLSearchParams(cut < 0 ? '' : raw.slice(cut + 1));
  const parts = path.replace(/^#\/?/, '').split('/').filter(Boolean).map((x) => {
    try { return decodeURIComponent(x); } catch { return x; }
  });
  const [first, second, third, fourth] = parts;
  if ((first === 'style' || first === 'channel') && second) {
    const tab = STYLE_TABS.includes(third) ? third : 'skill';
    const panel = tab === 'skill' && STYLE_PANELS.includes(query.get('panel')) ? query.get('panel') : null;
    return { page: 'style', id: second, tab, panel, query };
  }
  if ((first === 'styles' || first === 'channels') && second === 'kit' && third) {
    return { page: 'kit', id: third, tab: KIT_TABS.includes(fourth) ? fourth : 'brand', query };
  }
  if (first === 'styles' || first === 'channels') {
    const tab = STYLES_TABS.includes(second) ? second : 'styles';
    return { page: 'styles', tab, query };
  }
  // profile: Simple mode's profile page, #/profile/<slug> (web/simple-profiles.js).
  if (first === 'profile' && second) return { page: 'profile', id: second, query };
  // resources: Simple mode's Resources page (V1 spec §4). Which pages Simple hides: web/simple.js HIDDEN_PAGES.
  if (['recordings', 'skills', 'scheduled', 'library', 'resources'].includes(first)) return { page: first, query };
  return { page: 'projects', query };
}

// Simple mode hides some shell pages (web/simple.js HIDDEN_PAGES: Recordings, My styles and kits, Library, Skills,
// Scheduled). A deep link to one in Simple lands on Projects with one quiet line (ADVANCED_NOTE); the router replaces
// the address in place. Returns { to: '#/', hidden: <page> } or null (shown as it is). Run it after legacyRoute, so
// old addresses (#/learning, #/memories, #/settings/brand…) are caught by the page they now open.
export function simpleRedirect(hash, mode) {
  const route = parseRoute(hash);
  return hiddenInSimple(route, mode) ? { to: '#/', hidden: route.page } : null;
}

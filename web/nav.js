// Page navigation, one page at a time. `open(nav)` loads the page for the current hash and returns it ({ teardown })
// or null. A newer navigation aborts the one still loading (nav.signal, nav.alive() turns false, so the page can skip
// work and stop polling early), waits for it to finish, then tears it down before the next page loads. So every page
// that loaded is torn down, even one left during its first load, and a slow page can't draw over the next one.
export function makeRouter(open, { onError = (e) => console.error(e) } = {}) {
  let current = null, chain = Promise.resolve(), ctl = null;
  return function navigate() {
    ctl?.abort();
    const mine = ctl = new AbortController();
    chain = chain.then(async () => {
      current?.teardown?.();
      current = null;
      if (mine.signal.aborted) return; // an even newer navigation is queued: this page needn't load at all
      current = (await open({ signal: mine.signal, alive: () => !mine.signal.aborted })) || null;
    }).catch(onError);
    return chain;
  };
}

// Direction A routes (23 Oct 2026), the V2 Settings groups and the V2 "My styles" pages. Old addresses keep working:
// the router asks `legacyRoute` first and, when it returns a new address, replaces the old one in place (no extra
// history entry) before drawing the page.
// `_` as a style id means "work it out on the page": from the format, session, chat or scope in the query, else the
// remembered style, else the first one. (In the UI a learning profile is a "style"; it was a "channel" before V2.)
const withQuery = (base, query) => {
  const text = query.toString();
  return text ? `${base}?${text}` : base;
};

// Settings in six groups (design V2 §8): #/settings/<group>[/<section>]. The old one-section-per-page addresses
// (#/settings/claude…) land on their group, scrolled to the section.
export const SETTINGS_GROUPS = ['general', 'agent', 'recording', 'editing', 'export', 'storage'];
export const SETTINGS_SECTION_GROUP = {
  appearance: 'general', updates: 'general',
  claude: 'agent',
  recorder: 'recording', transcribe: 'recording',
  editing: 'editing', sound: 'editing', look: 'editing',
  render: 'export',
  folders: 'storage', storage: 'storage', usage: 'storage',
};

// The style pages (design V2 §5): #/styles[/instructions|/memories] and a style's hub #/style/<id>/<tab>.
export const STYLE_TABS = ['formats', 'brand', 'memories'];
export const STYLES_TABS = ['instructions', 'memories'];

export function legacyRoute(hash) {
  const raw = String(hash || '');
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
    if (!query.has('chat') && scope.startsWith('profile:')) return `#/style/${encodeURIComponent(scope.slice('profile:'.length))}/memories`;
    return withQuery('#/style/_/memories', query);
  }
  if (path === '#/storage') return '#/settings/storage/storage';
  if (path === '#/dashboard') return '#/settings/storage/usage';
  if (path === '#/settings/brand') return '#/style/_/brand';
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
  return null;
}

// A link to a style hub tab: styleHref('abc', 'formats', { format: 'f1' }) → '#/style/abc/formats?format=f1'.
export function styleHref(profileId, tab = '', query = null) {
  const base = `#/style/${encodeURIComponent(profileId || '_')}${tab ? `/${tab}` : ''}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== '') params.set(key, value);
  }
  return withQuery(base, params);
}
// The Direction A name, still used by the pages that link to a style's hub.
export const channelHref = styleHref;

// The app-level page for a hash: { page, ...details }. Projects (`#/` and anything unknown) is the default.
export function parseRoute(hash) {
  const raw = String(hash || '');
  const cut = raw.indexOf('?');
  const path = cut < 0 ? raw : raw.slice(0, cut);
  const query = new URLSearchParams(cut < 0 ? '' : raw.slice(cut + 1));
  const parts = path.replace(/^#\/?/, '').split('/').filter(Boolean).map((x) => {
    try { return decodeURIComponent(x); } catch { return x; }
  });
  const [first, second, third] = parts;
  if ((first === 'style' || first === 'channel') && second) {
    const tab = STYLE_TABS.includes(third) ? third : 'formats';
    return { page: 'style', id: second, tab, query };
  }
  if (first === 'styles' || first === 'channels') {
    const tab = STYLES_TABS.includes(second) ? second : 'styles';
    return { page: 'styles', tab, query };
  }
  if (['recordings', 'skills', 'scheduled', 'library'].includes(first)) return { page: first, query };
  return { page: 'projects', query };
}

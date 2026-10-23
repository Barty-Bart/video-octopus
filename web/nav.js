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

// Direction A routes (23 Oct 2026). Old addresses keep working: the router asks `legacyRoute` first and, when it
// returns a new address, replaces the old one in place (no extra history entry) before drawing the page.
// `_` as a channel id means "work it out on the page": from the format, session, chat or scope in the query, else the
// remembered channel, else the first one.
const withQuery = (base, query) => {
  const text = query.toString();
  return text ? `${base}?${text}` : base;
};

export function legacyRoute(hash) {
  const raw = String(hash || '');
  const cut = raw.indexOf('?');
  const path = cut < 0 ? raw : raw.slice(0, cut);
  const query = new URLSearchParams(cut < 0 ? '' : raw.slice(cut + 1));

  if (path === '#/learning') {
    const profile = query.get('profile');
    query.delete('profile');
    return withQuery(`#/channel/${profile ? encodeURIComponent(profile) : '_'}/formats`, query);
  }
  if (path === '#/memories') {
    const scope = query.get('scope') || '';
    if (!query.has('chat') && (!scope || scope === 'global')) return '#/channels/memories';
    if (!query.has('chat') && scope.startsWith('profile:')) return `#/channel/${encodeURIComponent(scope.slice('profile:'.length))}/memories`;
    return withQuery('#/channel/_/memories', query);
  }
  if (path === '#/storage') return '#/settings/storage';
  if (path === '#/dashboard') return '#/settings/usage';
  if (path === '#/settings/brand') return '#/channel/_/brand';
  if (path === '#/settings/instructions') return '#/channels/instructions';
  return null;
}

// A link to a channel hub tab: channelHref('abc', 'formats', { format: 'f1' }) → '#/channel/abc/formats?format=f1'.
export function channelHref(profileId, tab = '', query = null) {
  const base = `#/channel/${encodeURIComponent(profileId || '_')}${tab ? `/${tab}` : ''}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== '') params.set(key, value);
  }
  return withQuery(base, params);
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
  const [first, second, third] = parts;
  if (first === 'channel' && second) {
    const tab = ['formats', 'brand', 'memories'].includes(third) ? third : 'formats';
    return { page: 'channel', id: second, tab, query };
  }
  if (first === 'channels') {
    const tab = ['instructions', 'memories'].includes(second) ? second : 'channels';
    return { page: 'channels', tab, query };
  }
  if (['recordings', 'skills', 'scheduled', 'library'].includes(first)) return { page: first, query };
  return { page: 'projects', query };
}

// Direction A and V2: every old address lands on its new page (SPEC §2, §5), and the route parser reads the new ones.
// In the UI a learning profile is a "style" (V2 §5): #/styles and #/style/<id>/<tab>; the Direction A channel
// addresses (#/channels…, #/channel/…) redirect there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyRoute, styleHref, kitHref, parseRoute, routeNeedsLookup, SETTINGS_GROUPS, SETTINGS_SECTION_GROUP } from '../web/nav.js';

// Flat 3: a style is a format (#/style/<formatId>/…), a brand kit a profile (#/styles/kit/<profileId>/…). The lookup
// tells beta.14's profile-keyed style addresses from a style's own: kit P has the styles F and G, session S is F's.
const LOOKUP = {
  profiles: [{ id: 'P' }, { id: 'a b/c' }],
  formats: [{ id: 'F', profileId: 'P' }, { id: 'G', profileId: 'P' }],
  sessions: [{ id: 'S', formatId: 'F' }],
};
const moved = (hash) => legacyRoute(hash, LOOKUP);

test('legacyRoute maps every old address in the table', () => {
  const rows = [
    ['#/learning?profile=P&format=F&tab=files', '#/style/F/skill?panel=files'],
    ['#/learning?profile=P&format=F&tab=examples', '#/style/F/examples'],
    ['#/learning?profile=P&format=F&tab=learnings', '#/style/F/skill?panel=insights'],
    ['#/learning?profile=P', '#/styles/kit/P/styles'],
    ['#/learning?format=F&session=S', '#/style/F/skill?session=S'],
    ['#/learning?session=S', '#/style/F/skill?session=S'],
    ['#/learning?legacyStyle=Old+notes', '#/styles?legacyStyle=Old+notes'],
    ['#/learning', '#/styles'],
    ['#/memories', '#/styles/memories'],
    ['#/memories?scope=global', '#/styles/memories'],
    ['#/memories?scope=profile:P', '#/styles/kit/P/memories'],
    ['#/memories?scope=format:F', '#/styles/kit/_/memories?scope=format%3AF'],
    ['#/memories?scope=project:X', '#/styles/kit/_/memories?scope=project%3AX'],
    ['#/memories?chat=C', '#/styles/kit/_/memories?chat=C'],
    ['#/storage', '#/settings/storage/storage'],
    ['#/dashboard', '#/settings/storage/usage'],
    ['#/settings/brand', '#/styles/kit/_/brand'],
    ['#/settings/instructions', '#/styles/instructions'],
  ];
  for (const [from, to] of rows) assert.equal(moved(from), to, from);
  // The addresses that need no lookup are rewritten without one too.
  assert.equal(legacyRoute('#/learning?profile=P&format=F&tab=history'), '#/style/F/skill?panel=history');
  assert.equal(legacyRoute('#/settings/brand'), '#/styles/kit/_/brand');
});

// Beta.14 (design V2 phase B): #/style/<profileId>/<formats|brand|memories> was a kit-keyed hub.
test('legacyRoute sends beta.14 profile-keyed style addresses to the style or the kit', () => {
  const rows = [
    ['#/style/P/formats?format=F', '#/style/F/skill'],
    ['#/style/P/formats?format=F&tab=skill', '#/style/F/skill'],
    ['#/style/P/formats?format=F&tab=examples', '#/style/F/examples'],
    ['#/style/P/formats?format=F&tab=files', '#/style/F/skill?panel=files'],
    ['#/style/P/formats?format=F&tab=learnings', '#/style/F/skill?panel=insights'],
    ['#/style/P/formats?format=F&tab=history', '#/style/F/skill?panel=history'],
    ['#/style/P/formats?format=F&tab=videos', '#/style/F/skill?panel=videos'],
    ['#/style/P/formats?format=F&session=S', '#/style/F/skill?session=S'],
    ['#/style/P/formats?format=G&tab=examples&session=S2', '#/style/G/examples?session=S2'],
    ['#/style/P/formats', '#/styles/kit/P/styles'],
    ['#/style/P/brand', '#/styles/kit/P/brand'],
    ['#/style/P/memories', '#/styles/kit/P/memories'],
    ['#/style/P/memories?chat=C', '#/styles/kit/P/memories?chat=C'],
    ['#/style/P', '#/styles/kit/P/styles'],
    ['#/style/_/formats?format=F', '#/style/F/skill'],
    ['#/style/_/formats?session=S', '#/style/F/skill?session=S'],
    ['#/style/_/formats', '#/styles'],
    ['#/style/_/formats?legacyStyle=Old+notes', '#/styles?legacyStyle=Old+notes'],
    ['#/style/_/brand', '#/styles/kit/_/brand'],
    ['#/style/_/memories?scope=format%3AF', '#/styles/kit/_/memories?scope=format%3AF'],
    ['#/style/a%20b%2Fc/brand', '#/styles/kit/a%20b%2Fc/brand'],
  ];
  for (const [from, to] of rows) {
    assert.equal(moved(from), to, from);
    assert.equal(moved(to), null, `${to} is a current address`);
  }
  // A style's own addresses (its format id) are current, with or without the lookup.
  for (const hash of ['#/style/F', '#/style/F/skill', '#/style/F/brand', '#/style/F/memories', '#/style/F/people', '#/style/F/skill?panel=files']) {
    assert.equal(moved(hash), null, hash);
    assert.equal(legacyRoute(hash), null, hash);
  }
  // An id nobody knows (a removed style) is left to the page, which says so.
  assert.equal(moved('#/style/gone/brand'), null);
  assert.ok(routeNeedsLookup('#/style/P/brand') && routeNeedsLookup('#/channel/P') && routeNeedsLookup('#/learning?session=S'));
  assert.ok(!routeNeedsLookup('#/styles') && !routeNeedsLookup('#/styles/kit/P') && !routeNeedsLookup('#/p/demo'));
});

test('legacyRoute sends every Direction A channel address to its style or kit page', () => {
  const rows = [
    ['#/channels', '#/styles'],
    ['#/channels/', '#/styles'],
    ['#/channels/instructions', '#/styles/instructions'],
    ['#/channels/memories', '#/styles/memories'],
    ['#/channels/memories?x=1', '#/styles/memories?x=1'],
    ['#/channel/P', '#/styles/kit/P/styles'],
    ['#/channel/P/formats', '#/styles/kit/P/styles'],
    ['#/channel/P/formats?format=F&tab=files', '#/style/F/skill?panel=files'],
    ['#/channel/P/brand', '#/styles/kit/P/brand'],
    ['#/channel/P/memories?chat=C', '#/styles/kit/P/memories?chat=C'],
    ['#/channel/_/formats?legacyStyle=Old+notes', '#/styles?legacyStyle=Old+notes'],
    ['#/channel/a%20b%2Fc/brand', '#/styles/kit/a%20b%2Fc/brand'],
  ];
  for (const [from, to] of rows) {
    assert.equal(moved(from), to, from);
    assert.equal(moved(to), null, `${to} is a current address`);
  }
  // The pages they land on are the ones the old addresses showed.
  assert.deepEqual({ ...parseRoute(moved('#/channel/P/brand')), query: undefined }, { page: 'kit', id: 'P', tab: 'brand', query: undefined });
  assert.deepEqual({ ...parseRoute(moved('#/channels/memories')), query: undefined }, { page: 'styles', tab: 'memories', query: undefined });
});

test('legacyRoute leaves current addresses alone', () => {
  for (const hash of ['', '#/', '#/?style=P', '#/?channel=P', '#/recordings', '#/library', '#/scheduled', '#/skills?skill=a', '#/p/demo',
    '#/setup', '#/settings', '#/settings/storage', '#/settings/editing', '#/settings/general', '#/settings/agent',
    '#/settings/recording', '#/settings/export', '#/settings/storage/usage', '#/settings/general/appearance',
    '#/settings/nowhere', '#/style/F/brand', '#/styles', '#/styles/memories', '#/styles/instructions', '#/styles/kits',
    '#/styles/kit/P', '#/styles/kit/P/people', '#/p/channel-intro']) {
    assert.equal(moved(hash), null, hash);
  }
});

test('kit ids with spaces or symbols survive the round trip', () => {
  const to = legacyRoute('#/learning?profile=a%20b%2Fc');
  assert.equal(to, '#/styles/kit/a%20b%2Fc/styles');
  assert.deepEqual({ ...parseRoute(to), query: undefined }, { page: 'kit', id: 'a b/c', tab: 'styles', query: undefined });
});

test('styleHref and kitHref build the Flat 3 links', () => {
  assert.equal(styleHref('F'), '#/style/F');
  assert.equal(styleHref('F', 'examples'), '#/style/F/examples');
  assert.equal(styleHref('F', 'skill', { panel: 'files', tab: null }), '#/style/F/skill?panel=files');
  assert.equal(kitHref('P'), '#/styles/kit/P');
  assert.equal(kitHref('P', 'memories'), '#/styles/kit/P/memories');
  assert.equal(kitHref(null, 'memories', { chat: 'C' }), '#/styles/kit/_/memories?chat=C');
});

test('parseRoute reads the new pages', () => {
  assert.equal(parseRoute('#/').page, 'projects');
  assert.equal(parseRoute('#/?style=P').query.get('style'), 'P');
  assert.deepEqual({ ...parseRoute('#/style/F'), query: undefined }, { page: 'style', id: 'F', tab: 'skill', panel: null, query: undefined });
  assert.equal(parseRoute('#/style/F/people').tab, 'people');
  assert.equal(parseRoute('#/style/F/skill?panel=history').panel, 'history');
  assert.equal(parseRoute('#/style/F/skill?panel=nope').panel, null);
  assert.equal(parseRoute('#/style/F/examples?panel=files').panel, null, 'panels belong to the Skill tab');
  assert.equal(parseRoute('#/style/F/nowhere').tab, 'skill');
  assert.equal(parseRoute('#/styles').page, 'styles');
  assert.equal(parseRoute('#/styles').tab, 'styles');
  assert.equal(parseRoute('#/styles/instructions').tab, 'instructions');
  assert.equal(parseRoute('#/styles/kits').tab, 'kits');
  assert.equal(parseRoute('#/styles/nowhere').tab, 'styles');
  assert.deepEqual({ ...parseRoute('#/styles/kit/P'), query: undefined }, { page: 'kit', id: 'P', tab: 'brand', query: undefined });
  assert.equal(parseRoute('#/styles/kit/P/styles').tab, 'styles');
  assert.equal(parseRoute('#/styles/kit/P/memories?chat=C').query.get('chat'), 'C');
  assert.equal(parseRoute('#/skills?skill=x&show=mine').page, 'skills');
  assert.equal(parseRoute('#/library/inbox').page, 'library');
  assert.equal(parseRoute('#/nowhere').page, 'projects');
});

// Design V2 §8: every old Settings section address lands on its group, at the section.
test('legacyRoute maps the old Settings sections to the six groups', () => {
  const rows = [
    ['#/settings/claude', '#/settings/agent/claude'],
    ['#/settings/transcribe', '#/settings/recording/transcribe'],
    ['#/settings/recorder', '#/settings/recording/recorder'],
    ['#/settings/render', '#/settings/export/render'],
    ['#/settings/folders', '#/settings/storage/folders'],
    ['#/settings/usage', '#/settings/storage/usage'],
    ['#/settings/appearance', '#/settings/general/appearance'],
    ['#/settings/updates', '#/settings/general/updates'],
    ['#/settings/sound', '#/settings/editing/sound'],
    ['#/settings/look', '#/settings/editing/look'],
  ];
  for (const [from, to] of rows) assert.equal(legacyRoute(from), to, from);
  // A section that shares its group's name is already a group page.
  assert.equal(legacyRoute('#/settings/editing'), null);
  assert.equal(legacyRoute('#/settings/storage'), null);
});

test('every Settings section belongs to one of the six groups', () => {
  assert.deepEqual(SETTINGS_GROUPS, ['general', 'agent', 'recording', 'editing', 'export', 'storage']);
  const sections = ['claude', 'transcribe', 'render', 'recorder', 'editing', 'sound', 'appearance', 'look', 'folders', 'storage', 'playback', 'trash', 'usage', 'updates', 'editor'];
  assert.deepEqual(Object.keys(SETTINGS_SECTION_GROUP).sort(), sections.sort());
  for (const group of Object.values(SETTINGS_SECTION_GROUP)) assert.ok(SETTINGS_GROUPS.includes(group), group);
});

// Design V2 §5 / Flat 3: the pages link to the current addresses themselves (the old ones only redirect).
test('no page links to a Direction A channel address any more', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../web/', import.meta.url);
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js') && n !== 'nav.js')) {
    const text = readFileSync(new URL(name, dir), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(text, /#\/channels?\b/, name);
  }
});

// Flat 3: no page builds a beta.14 profile-keyed style address (#/style/<id>/formats) any more.
test('no page links to the old Formats tab address', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../web/', import.meta.url);
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js') && n !== 'nav.js')) {
    const text = readFileSync(new URL(name, dir), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(text, /#\/style\/[^'"`\s]*\/formats|(?:style|kit|channel)Href\([^)\n]*'formats'/, name);
  }
});

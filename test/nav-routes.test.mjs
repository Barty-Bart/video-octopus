// Direction A and V2: every old address lands on its new page (SPEC §2, §5), and the route parser reads the new ones.
// In the UI a learning profile is a "style" (V2 §5): #/styles and #/style/<id>/<tab>; the Direction A channel
// addresses (#/channels…, #/channel/…) redirect there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyRoute, channelHref, styleHref, parseRoute, SETTINGS_GROUPS, SETTINGS_SECTION_GROUP } from '../web/nav.js';

test('legacyRoute maps every old address in the table', () => {
  const rows = [
    ['#/learning?profile=P&format=F&tab=files', '#/style/P/formats?format=F&tab=files'],
    ['#/learning?profile=P', '#/style/P/formats'],
    ['#/learning?format=F&session=S', '#/style/_/formats?format=F&session=S'],
    ['#/learning?legacyStyle=Old+notes', '#/style/_/formats?legacyStyle=Old+notes'],
    ['#/learning', '#/style/_/formats'],
    ['#/memories', '#/styles/memories'],
    ['#/memories?scope=global', '#/styles/memories'],
    ['#/memories?scope=profile:P', '#/style/P/memories'],
    ['#/memories?scope=format:F', '#/style/_/memories?scope=format%3AF'],
    ['#/memories?scope=project:X', '#/style/_/memories?scope=project%3AX'],
    ['#/memories?chat=C', '#/style/_/memories?chat=C'],
    ['#/storage', '#/settings/storage/storage'],
    ['#/dashboard', '#/settings/storage/usage'],
    ['#/settings/brand', '#/style/_/brand'],
    ['#/settings/instructions', '#/styles/instructions'],
  ];
  for (const [from, to] of rows) assert.equal(legacyRoute(from), to, from);
});

test('legacyRoute sends every Direction A channel address to its style page', () => {
  const rows = [
    ['#/channels', '#/styles'],
    ['#/channels/', '#/styles'],
    ['#/channels/instructions', '#/styles/instructions'],
    ['#/channels/memories', '#/styles/memories'],
    ['#/channels/memories?x=1', '#/styles/memories?x=1'],
    ['#/channel/P', '#/style/P'],
    ['#/channel/P/formats', '#/style/P/formats'],
    ['#/channel/P/formats?format=F&tab=files', '#/style/P/formats?format=F&tab=files'],
    ['#/channel/P/brand', '#/style/P/brand'],
    ['#/channel/P/memories?chat=C', '#/style/P/memories?chat=C'],
    ['#/channel/_/formats?legacyStyle=Old+notes', '#/style/_/formats?legacyStyle=Old+notes'],
    ['#/channel/a%20b%2Fc/brand', '#/style/a%20b%2Fc/brand'],
  ];
  for (const [from, to] of rows) {
    assert.equal(legacyRoute(from), to, from);
    assert.equal(legacyRoute(to), null, `${to} is a current address`);
  }
  // The pages they land on are the ones the old addresses showed.
  assert.deepEqual({ ...parseRoute(legacyRoute('#/channel/P/brand')), query: undefined }, { page: 'style', id: 'P', tab: 'brand', query: undefined });
  assert.deepEqual({ ...parseRoute(legacyRoute('#/channels/memories')), query: undefined }, { page: 'styles', tab: 'memories', query: undefined });
});

test('legacyRoute leaves current addresses alone', () => {
  for (const hash of ['', '#/', '#/?style=P', '#/?channel=P', '#/recordings', '#/library', '#/scheduled', '#/skills?skill=a', '#/p/demo',
    '#/setup', '#/settings', '#/settings/storage', '#/settings/editing', '#/settings/general', '#/settings/agent',
    '#/settings/recording', '#/settings/export', '#/settings/storage/usage', '#/settings/general/appearance',
    '#/settings/nowhere', '#/style/P/brand', '#/styles', '#/styles/memories', '#/styles/instructions', '#/p/channel-intro']) {
    assert.equal(legacyRoute(hash), null, hash);
  }
});

test('style ids with spaces or symbols survive the round trip', () => {
  const to = legacyRoute('#/learning?profile=a%20b%2Fc');
  assert.equal(to, '#/style/a%20b%2Fc/formats');
  assert.deepEqual({ ...parseRoute(to), query: undefined }, { page: 'style', id: 'a b/c', tab: 'formats', query: undefined });
});

test('styleHref (and its older name channelHref) builds hub links', () => {
  assert.equal(channelHref, styleHref);
  assert.equal(styleHref('P'), '#/style/P');
  assert.equal(styleHref('P', 'brand'), '#/style/P/brand');
  assert.equal(styleHref('P', 'formats', { format: 'F', tab: null }), '#/style/P/formats?format=F');
  assert.equal(styleHref(null, 'memories', { chat: 'C' }), '#/style/_/memories?chat=C');
});

test('parseRoute reads the new pages', () => {
  assert.equal(parseRoute('#/').page, 'projects');
  assert.equal(parseRoute('#/?style=P').query.get('style'), 'P');
  assert.equal(parseRoute('#/style/P').tab, 'formats');
  assert.equal(parseRoute('#/style/P/memories?chat=C').tab, 'memories');
  assert.equal(parseRoute('#/style/P/memories?chat=C').query.get('chat'), 'C');
  assert.equal(parseRoute('#/styles').page, 'styles');
  assert.equal(parseRoute('#/styles').tab, 'styles');
  assert.equal(parseRoute('#/styles/instructions').tab, 'instructions');
  assert.equal(parseRoute('#/styles/nowhere').tab, 'styles');
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
  const sections = ['claude', 'transcribe', 'render', 'recorder', 'editing', 'sound', 'appearance', 'look', 'folders', 'storage', 'usage', 'updates'];
  assert.deepEqual(Object.keys(SETTINGS_SECTION_GROUP).sort(), sections.sort());
  for (const group of Object.values(SETTINGS_SECTION_GROUP)) assert.ok(SETTINGS_GROUPS.includes(group), group);
});

// Design V2 §5: the pages link to the style addresses themselves (the old ones only redirect).
test('no page links to a Direction A channel address any more', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../web/', import.meta.url);
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js') && n !== 'nav.js')) {
    const text = readFileSync(new URL(name, dir), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(text, /#\/channels?\b/, name);
  }
});

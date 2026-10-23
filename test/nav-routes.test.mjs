// Direction A: every old address lands on its new page (SPEC §2), and the route parser reads the new ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyRoute, channelHref, parseRoute, SETTINGS_GROUPS, SETTINGS_SECTION_GROUP } from '../web/nav.js';

test('legacyRoute maps every old address in the table', () => {
  const rows = [
    ['#/learning?profile=P&format=F&tab=files', '#/channel/P/formats?format=F&tab=files'],
    ['#/learning?profile=P', '#/channel/P/formats'],
    ['#/learning?format=F&session=S', '#/channel/_/formats?format=F&session=S'],
    ['#/learning?legacyStyle=Old+notes', '#/channel/_/formats?legacyStyle=Old+notes'],
    ['#/learning', '#/channel/_/formats'],
    ['#/memories', '#/channels/memories'],
    ['#/memories?scope=global', '#/channels/memories'],
    ['#/memories?scope=profile:P', '#/channel/P/memories'],
    ['#/memories?scope=format:F', '#/channel/_/memories?scope=format%3AF'],
    ['#/memories?scope=project:X', '#/channel/_/memories?scope=project%3AX'],
    ['#/memories?chat=C', '#/channel/_/memories?chat=C'],
    ['#/storage', '#/settings/storage/storage'],
    ['#/dashboard', '#/settings/storage/usage'],
    ['#/settings/brand', '#/channel/_/brand'],
    ['#/settings/instructions', '#/channels/instructions'],
  ];
  for (const [from, to] of rows) assert.equal(legacyRoute(from), to, from);
});

test('legacyRoute leaves current addresses alone', () => {
  for (const hash of ['', '#/', '#/?channel=P', '#/recordings', '#/library', '#/scheduled', '#/skills?skill=a', '#/p/demo',
    '#/setup', '#/settings', '#/settings/storage', '#/settings/editing', '#/settings/general', '#/settings/agent',
    '#/settings/recording', '#/settings/export', '#/settings/storage/usage', '#/settings/general/appearance',
    '#/settings/nowhere', '#/channel/P/brand', '#/channels/memories']) {
    assert.equal(legacyRoute(hash), null, hash);
  }
});

test('channel ids with spaces or symbols survive the round trip', () => {
  const to = legacyRoute('#/learning?profile=a%20b%2Fc');
  assert.equal(to, '#/channel/a%20b%2Fc/formats');
  assert.deepEqual({ ...parseRoute(to), query: undefined }, { page: 'channel', id: 'a b/c', tab: 'formats', query: undefined });
});

test('channelHref builds hub links', () => {
  assert.equal(channelHref('P'), '#/channel/P');
  assert.equal(channelHref('P', 'brand'), '#/channel/P/brand');
  assert.equal(channelHref('P', 'formats', { format: 'F', tab: null }), '#/channel/P/formats?format=F');
  assert.equal(channelHref(null, 'memories', { chat: 'C' }), '#/channel/_/memories?chat=C');
});

test('parseRoute reads the new pages', () => {
  assert.equal(parseRoute('#/').page, 'projects');
  assert.equal(parseRoute('#/?channel=P').query.get('channel'), 'P');
  assert.equal(parseRoute('#/channel/P').tab, 'formats');
  assert.equal(parseRoute('#/channel/P/memories?chat=C').tab, 'memories');
  assert.equal(parseRoute('#/channel/P/memories?chat=C').query.get('chat'), 'C');
  assert.equal(parseRoute('#/channels').tab, 'channels');
  assert.equal(parseRoute('#/channels/instructions').tab, 'instructions');
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

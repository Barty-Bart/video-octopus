// Run only in an approved isolated environment:
//   node --test test/maintenance.test.mjs
// The module is process-local bookkeeping: no app server, subprocess or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

let instance = 0;
// Fresh module state keeps a failed accounting assertion from affecting later cases.
const fixture = () => import(`../server/maintenance.mjs?test-instance=${++instance}`);

test('idle maintenance state allows work and reports no busy reasons', async () => {
  const m = await fixture();
  assert.equal(m.maintenanceActive(), false);
  assert.deepEqual(m.activityView(), { busy: false, reasons: [] });
  assert.doesNotThrow(() => m.assertNotUpdating());
});

test('outstanding writes block maintenance until every request releases its claim', async () => {
  const m = await fixture();
  const first = m.beginWrite(), second = m.beginWrite();
  assert.equal(m.activityView().busy, true);
  assert.throws(() => m.beginMaintenance('Updating app and skills.'), /finishing|current work/i);
  first();
  assert.equal(m.activityView().busy, true);
  second();
  assert.deepEqual(m.activityView(), { busy: false, reasons: [] });
  assert.doesNotThrow(() => m.beginMaintenance('Updating app and skills.'));
  m.endMaintenance();
});

test('activity probe reasons prevent updates and are evaluated again on the next attempt', async () => {
  const m = await fixture();
  let active = true;
  m.setActivityProbe(() => active ? ['An export is running.', 'An assistant is working.'] : []);
  assert.deepEqual(m.activityView().reasons, ['An export is running.', 'An assistant is working.']);
  assert.throws(() => m.beginMaintenance('Updating skills.'), /export.*assistant/i);
  assert.equal(m.maintenanceActive(), false);
  active = false;
  assert.doesNotThrow(() => m.beginMaintenance('Updating skills.'));
  assert.equal(m.maintenanceActive(), true);
  m.endMaintenance();
});

test('two app or skill updates cannot overlap and new work remains paused until release', async () => {
  const m = await fixture();
  m.beginMaintenance('Updating app and skills.');
  assert.equal(m.maintenanceActive(), true);
  assert.throws(() => m.beginMaintenance('Changing a skill choice.'), /updating app and skills/i);
  assert.deepEqual(m.activityView().reasons, ['Updating app and skills.']);
  assert.throws(() => m.assertNotUpdating(), /paused|finishes/i);
  m.endMaintenance();
  assert.equal(m.maintenanceActive(), false);
  assert.doesNotThrow(() => m.assertNotUpdating());
  assert.doesNotThrow(() => m.beginMaintenance('Changing a skill choice.'));
  m.endMaintenance();
});

test('finishing a response releases its write claim even if close follows finish', async () => {
  const m = await fixture(), response = new EventEmitter();
  const release = m.beginWrite();
  response.once('finish', release);
  response.once('close', release);
  assert.equal(m.activityView().busy, true);
  response.emit('finish');
  assert.equal(m.activityView().busy, false);
  response.emit('close');
  assert.deepEqual(m.activityView(), { busy: false, reasons: [] },
    'A duplicate release must not make the write count negative');
  const next = m.beginWrite();
  assert.equal(m.activityView().busy, true, 'A later write must still be counted');
  next();
  assert.equal(m.activityView().busy, false);
});

test('failed work can release claims in finally and allow a later update', async () => {
  const m = await fixture();
  const release = m.beginWrite();
  assert.throws(() => {
    try { throw new Error('Synthetic write failure'); }
    finally { release(); }
  }, /Synthetic write failure/);
  assert.equal(m.activityView().busy, false);
  assert.throws(() => {
    m.beginMaintenance('Updating skills.');
    try { throw new Error('Synthetic update failure'); }
    finally { m.endMaintenance(); }
  }, /Synthetic update failure/);
  assert.equal(m.maintenanceActive(), false);
  assert.doesNotThrow(() => m.beginMaintenance('A later update.'));
  m.endMaintenance();
});

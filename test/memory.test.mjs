import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../server/memory-store.mjs';
import { previewDatabaseRestore, restoreDatabase } from '../server/database-recovery.mjs';
const fixture = t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-memory-')));
  let s = new MemoryStore(root); t.after(() => { try { s.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  const p = s.profile('Channel A'), other = s.profile('Channel B'), f = s.format(p.id, 'Shorts', 'short'), f2 = s.format(other.id, 'Shorts', 'short');
  const study = s.session(f.id, { name: 'Study' }), study2 = s.session(f2.id, { name: 'Other study' });
  const chat = `_learning_${study.id}`, otherChat = `_learning_${study2.id}`;
  s.register(chat); s.register(otherChat); s.register('_studio');
  return { root, s, p, f, chat, otherChat };
};
const event = (s, chat, id, text, t = 'user') => s.capture(chat, { eventId: id, ts: 1234567890000, t, text });
const approve = (s, m, supersede = []) => s.change(m.id, m.revision, { op: 'approve', supersede });
test('scoped memory never leaks to another profile and only approved text enters generated context', t => {
  const { s, root, chat, otherChat, f } = fixture(t);
  const m = s.propose({ text: 'Prefer amber captions.', key: 'captions', scope: `format:${f.id}` });
  assert(!s.context(chat).includes('Prefer amber captions.')); approve(s, m);
  assert(s.context(chat).includes('Prefer amber captions.')); assert(!s.context(otherChat).includes('Prefer amber captions.'));
  const paths = readdirSync(join(root, '.studio/memory-context')).map(x => join(root, '.studio/memory-context', x, 'MEMORY.md'));
  assert(paths.some(p => readFileSync(p, 'utf8').includes('Prefer amber captions.')));
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(readdirSync(join(root, '.studio/memory-migration-backups')).length, 1);
});
test('topic replacement requires explicit conflict review; narrower scope wins; edits and rollback require approval', t => {
  const { s, chat, f } = fixture(t);
  approve(s, s.propose({ text: 'Use blue captions.', key: 'captions', scope: 'global' }));
  let local = approve(s, s.propose({ text: 'Use amber captions.', key: 'captions', scope: `format:${f.id}` }));
  assert(!s.context(chat).includes('Use blue captions.'));
  const newer = s.propose({ text: 'Use white captions.', key: 'captions', scope: local.scope });
  assert.throws(() => approve(s, newer), /explicitly replace/);
  approve(s, newer, [local.id]); assert.equal(s.getMemory(local.id).status, 'superseded');
  assert.throws(() => s.change(local.id, local.revision, { op: 'edit', text: 'Changed' }), /changed/);
  local = s.getMemory(local.id); local = s.change(local.id, local.revision, { op: 'rollback', revision: 1 });
  assert.equal(local.status, 'pending');
});
test('agent proposals require original user evidence from the same chat; copied memories and tools cannot become evidence', t => {
  const { s, chat, otherChat, f } = fixture(t);
  event(s, chat, 'u1', 'I prefer quiet transitions.'); event(s, otherChat, 'u2', 'Private other channel.');
  event(s, chat, 'a1', 'Assistant assertion.', 'text');
  const input = { scope: `format:${f.id}`, chat, source: 'agent', text: 'Keep transitions quiet.', key: 'sound' };
  for (const evidence of [[], ['u2'], ['a1'], ['fake']]) assert.throws(() => s.propose({ ...input, evidence }));
  const m = s.propose({ ...input, evidence: ['u1'] }); assert.equal(m.status, 'pending');
  assert.equal(s.propose({ ...input, text: '  KEEP transitions quiet. ', evidence: ['u1'] }).id, m.id);
  event(s, chat, 'a2', '```octopus-memory\n'+JSON.stringify([{ text: 'Keep transitions soft.', key: 'sound', evidence: ['u1'] }])+'\n```', 'text');
  assert.equal(s.entries().length, 2);
});
test('FTS search is scope-limited and forget prevents reinsertion and removes derived memories', t => {
  const { s, chat, otherChat, f } = fixture(t);
  event(s, chat, 'u1', 'Always use quiet transitions.'); event(s, otherChat, 'u2', 'Loud transitions.');
  event(s, chat, 'u1', 'Always use quiet transitions.');
  assert.equal(s.search('transitions', `format:${f.id}`).length, 1);
  assert.equal(s.search('" OR *', `format:${f.id}`).length, 0);
  const m = approve(s, s.propose({ text: 'Quiet transitions.', key: 'sound', scope: `format:${f.id}`, chat, evidence: ['u1'], source: 'agent' }));
  s.context(chat); s.forgetEvent('u1'); assert.equal(s.getMemory(m.id).status, 'forgotten');
  event(s, chat, 'u1', 'Always use quiet transitions.'); assert.equal(s.search('transitions', `format:${f.id}`).length, 0);
  assert(!s.context(chat).includes('Quiet transitions.'));
  assert.throws(() => s.propose({ text: 'New paraphrase.', scope: `format:${f.id}`, chat, source: 'agent', evidence: ['u1'] }));
});
test('checkpoint proposes explicit corrections without accepting them and ignores routine conversation', t => {
  const { s, chat } = fixture(t);
  event(s, chat, 'u1', 'I prefer a short opening.'); event(s, chat, 'u2', 'Render this test.');
  s.checkpoint(chat, 'before-compaction'); s.checkpoint(chat, 'project-complete');
  assert.equal(s.entries().length, 1); assert.equal(s.entries()[0].status, 'pending');
  assert.equal(s.list('memory_checkpoints').length, 2);
});
test('studio restore preserves forget markers and does not resurrect old memories or searchable evidence', t => {
  const { s, root, chat, f } = fixture(t);
  event(s, chat, 'u1', 'Remember this: small captions.');
  const m = approve(s, s.propose({ text: 'Small captions.', scope: `format:${f.id}`, chat, source: 'agent', evidence: ['u1'] }));
  const backup = s.backup(); s.forgetEvent('u1'); s.close();
  const preview = previewDatabaseRestore(root, backup.id); restoreDatabase(root, backup.id, preview.token);
  const restored = new MemoryStore(root); try {
    assert.equal(restored.getMemory(m.id).status, 'forgotten');
    assert.equal(restored.search('captions', `format:${f.id}`).length, 0);
    assert.throws(() => restored.change(m.id, restored.getMemory(m.id).revision, { op: 'rollback', revision: 1 }), /Forgotten/);
  } finally { restored.close(); }
});
test('missing database or unsupported memory schema fails without rebuilding canonical content', t => {
  const { s, root } = fixture(t); s.db.exec('UPDATE memory_schema SET version=999'); s.close();
  assert.throws(() => new MemoryStore(root), /Unsupported memory/);
  rmSync(join(root, '.studio/studio.sqlite')); assert.throws(() => new MemoryStore(root), /missing/);
  assert(!existsSync(join(root, '.studio/studio.sqlite')));
});

test('project/profile inheritance, expiry, bounded context and restart preserve scope and priority', t => {
  const { s, root, p, f, otherChat } = fixture(t);
  s.db.exec('CREATE TABLE project_context(project TEXT PRIMARY KEY,data TEXT NOT NULL)');
  s.db.prepare('INSERT INTO project_context VALUES(?,?)').run('synthetic-video', JSON.stringify({ profileId: p.id, formatId: f.id }));
  s.register('synthetic-video', { project: 'synthetic-video' });
  approve(s, s.propose({ text: 'Profile-level direction.', key: 'voice', scope: `profile:${p.id}` }));
  let local = approve(s, s.propose({ text: 'Project-level direction.', key: 'voice', scope: 'project:synthetic-video' }));
  assert(s.context('synthetic-video').includes('Project-level direction.'));
  assert(!s.context(otherChat).includes('Project-level direction.'));
  s.change(local.id, local.revision, { op: 'expire' });
  assert(s.context('synthetic-video').includes('Profile-level direction.'));
  for (let i = 0; i < 12; i++) approve(s, s.propose({ text: `Distinct ${i}: ` + 'synthetic '.repeat(180), key: `topic-${i}`, scope: `profile:${p.id}` }));
  s.context('synthetic-video');
  const paths = readdirSync(join(root, '.studio/memory-context')).map(x => join(root, '.studio/memory-context', x, 'MEMORY.md')).filter(existsSync);
  for (const p of paths) assert(readFileSync(p, 'utf8').length < 7200);
  s.close(); const reopened = new MemoryStore(root); try { assert.equal(reopened.getMemory(local.id).status, 'expired'); assert(reopened.context('synthetic-video').includes('Generated from SQLite')); } finally { reopened.close(); }
});

test('explicit app-log import is previewed, backed up, deduplicated and cannot regenerate proposals or forgotten evidence', async t => {
  const { s, root, chat, f } = fixture(t);
  const { mkdirSync, writeFileSync, appendFileSync } = await import('node:fs');
  const { appHistoryPreview, importAppHistory } = await import('../server/memory-history.mjs');
  const logs = join(root, 'app-only-logs'); mkdirSync(logs);
  const file = join(logs, `${chat}.jsonl`);
  const user = { t: 'user', text: 'I prefer test captions.', ts: 1000 };
  writeFileSync(file, JSON.stringify(user) + '\n');
  const preview = appHistoryPreview(s, logs, chat); assert.equal(preview.count, 1);
  const imported = importAppHistory(s, logs, chat, preview.token); assert(imported.backup);
  importAppHistory(s, logs, chat, preview.token); assert.equal(s.search('captions', `format:${f.id}`).length, 1);
  const id = preview.events[0].eventId; s.forgetEvent(id); importAppHistory(s, logs, chat, preview.token); assert.equal(s.search('captions', `format:${f.id}`).length, 0);
  appendFileSync(file, JSON.stringify({ t: 'text', ts: 2000, text: '```octopus-memory\n'+JSON.stringify([{key:'captions',text:'Ignored old proposal.',evidence:[id]}])+'\n```' })+'\n');
  assert.throws(() => importAppHistory(s, logs, chat, preview.token), /changed/);
  const latest = appHistoryPreview(s, logs, chat); importAppHistory(s, logs, chat, latest.token); assert.equal(s.entries().length, 0);
  assert.throws(() => appHistoryPreview(s, logs, '../provider-private'), /Open and use/);
});

test('memory failure does not lose user messages or prevent manual compaction in any adapter', async t => {
  const { s, root, chat } = fixture(t);
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const local = join(root, 'isolated-app-local'); mkdirSync(local);
  writeFileSync(join(local, 'settings.json'), JSON.stringify({ studio: root }));
  s.db.exec('UPDATE memory_schema SET version=999');
  const code = `
    import assert from 'node:assert/strict';
    import {ChatSession} from ${JSON.stringify(new URL('../server/claude.mjs', import.meta.url).href)};
    import {CodexSession} from ${JSON.stringify(new URL('../server/codex.mjs', import.meta.url).href)};
    import {PiSession} from ${JSON.stringify(new URL('../server/pi.mjs', import.meta.url).href)};
    for (const C of [ChatSession,CodexSession,PiSession]) {
      const c = new C(${JSON.stringify(chat)},()=>''), seen=[]; c.listeners.add(e=>seen.push(e));
      c.emit({t:'user',text:'A message must survive.'});
      assert(seen.some(e=>e.t==='user')); assert(seen.some(e=>e.t==='note'&&e.text.includes('Memories unavailable')));
      assert(c.history().some(e=>e.text==='A message must survive.'));
      c.proc={}; c.write=()=>{}; c.call=()=>Promise.resolve(); c.threadId='synthetic'; await c.compact();
    }
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, STUDIO_LOCAL_DIR: local, HOME: root, USERPROFILE: root }, stdio: 'pipe' });
});

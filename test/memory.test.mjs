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
  return { root, s, p, other, f, f2, chat, otherChat };
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
  const { s, chat, otherChat, p } = fixture(t);
  event(s, chat, 'u1', 'I prefer quiet transitions.'); event(s, otherChat, 'u2', 'Private other channel.');
  event(s, chat, 'a1', 'Assistant assertion.', 'text');
  const input = { scope: `profile:${p.id}`, chat, source: 'agent', text: 'Keep transitions quiet.', key: 'sound' };
  for (const evidence of [[], ['u2'], ['a1'], ['fake']]) assert.throws(() => s.propose({ ...input, evidence }));
  const m = s.propose({ ...input, evidence: ['u1'] }); assert.equal(m.status, 'pending');
  assert.equal(s.propose({ ...input, text: '  KEEP transitions quiet. ', evidence: ['u1'] }).id, m.id);
  event(s, chat, 'a2', '```octopus-memory\n'+JSON.stringify([{ text: 'Keep transitions soft.', key: 'sound', evidence: ['u1'] }])+'\n```', 'text');
  assert.equal(s.entries().length, 2);
});
test('FTS search is scope-limited and forget prevents reinsertion and removes derived memories', t => {
  const { s, chat, otherChat, f, p } = fixture(t);
  event(s, chat, 'u1', 'Always use quiet transitions.'); event(s, otherChat, 'u2', 'Loud transitions.');
  event(s, chat, 'u1', 'Always use quiet transitions.');
  assert.equal(s.search('transitions', `format:${f.id}`).length, 1);
  assert.equal(s.search('" OR *', `format:${f.id}`).length, 0);
  const m = approve(s, s.propose({ text: 'Quiet transitions.', key: 'sound', scope: `profile:${p.id}`, chat, evidence: ['u1'], source: 'agent' }));
  s.context(chat); s.forgetEvent('u1'); assert.equal(s.getMemory(m.id).status, 'forgotten');
  event(s, chat, 'u1', 'Always use quiet transitions.'); assert.equal(s.search('transitions', `format:${f.id}`).length, 0);
  assert(!s.context(chat).includes('Quiet transitions.'));
  assert.throws(() => s.propose({ text: 'New paraphrase.', scope: `profile:${p.id}`, chat, source: 'agent', evidence: ['u1'] }), /Evidence must/);
});
test('checkpoint proposes explicit corrections without accepting them and ignores routine conversation', t => {
  const { s, chat } = fixture(t);
  event(s, chat, 'u1', 'I prefer a short opening.'); event(s, chat, 'u2', 'Render this test.');
  s.checkpoint(chat, 'before-compaction'); s.checkpoint(chat, 'project-complete');
  assert.equal(s.entries().length, 1); assert.equal(s.entries()[0].status, 'pending');
  assert.equal(s.list('memory_checkpoints').length, 2);
});
test('studio restore preserves forget markers and does not resurrect old memories or searchable evidence', t => {
  const { s, root, chat, f, p } = fixture(t);
  event(s, chat, 'u1', 'Remember this: small captions.');
  const m = approve(s, s.propose({ text: 'Small captions.', scope: `profile:${p.id}`, chat, source: 'agent', evidence: ['u1'] }));
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

// ---- Memory levels: Everything (global) and This channel (profile:<id>) ----
const projectChat = (s, project, profileId, formatId) => {
  s.db.exec('CREATE TABLE IF NOT EXISTS project_context(project TEXT PRIMARY KEY,data TEXT NOT NULL)');
  s.db.prepare('INSERT INTO project_context VALUES(?,?)').run(project, JSON.stringify({ profileId, formatId }));
  return s.register(project, { project });
};
const lesson = (s, chat, id, said, proposal) => {
  event(s, chat, id, said);
  event(s, chat, `${id}-reply`, '```octopus-memory\n' + JSON.stringify([{ evidence: [id], ...proposal }]) + '\n```', 'text');
  return s.entries().find(m => m.chat === chat && m.key === proposal.key);
};
const routeGet = async (root, query) => {
  const { memoryRoute } = await import('../server/memory.mjs');
  let out;
  await memoryRoute({ method: 'GET' }, {}, new URL(`http://local/api/memory${query}`), { studio: root, body: null, send: (res, status, value) => { out = { status, value }; } });
  return out;
};

test('agent proposals default to the chat channel, or Everything without one, and cannot pick their own level', t => {
  const { s, p, f, other, chat } = fixture(t);
  projectChat(s, 'video-a', p.id, f.id);
  const fromProject = lesson(s, 'video-a', 'u1', 'I prefer two-line captions.', { key: 'captions', text: 'Two-line captions.', scope: `format:${f.id}` });
  assert.equal(fromProject.scope, `profile:${p.id}`);
  assert(fromProject.fingerprint.startsWith(`profile:${p.id}:`));
  assert.equal(lesson(s, chat, 'u2', 'I prefer quiet music.', { key: 'music', text: 'Quiet music.' }).scope, `profile:${p.id}`);
  assert.equal(lesson(s, '_studio', 'u3', 'I prefer British spelling.', { key: 'spelling', text: 'British spelling.', scope: `profile:${other.id}` }).scope, 'global');
  // Explicit corrections quoted before compaction land on the channel too.
  event(s, 'video-a', 'u4', 'From now on, never use white boxes.');
  s.checkpoint('video-a', 'before-compaction');
  assert.equal(s.entries().find(m => m.evidence.includes('u4')).scope, `profile:${p.id}`);
  // The chat's binding still reads every scope in its chain.
  assert.deepEqual(s.chat('video-a').scopes, ['global', `profile:${p.id}`, `format:${f.id}`, 'project:video-a']);
  for (const scope of [`format:${f.id}`, 'project:video-a', 'global', `profile:${other.id}`]) {
    assert.throws(() => s.propose({ text: 'Another lesson.', key: 'other', scope, chat: 'video-a', evidence: ['u1'], source: 'agent' }), /scope mismatch|valid|Unknown/);
  }
});

test('approve picks This channel or Everything within the source chat chain, never another channel or a narrower scope', t => {
  const { s, p, f, other, chat, otherChat } = fixture(t);
  projectChat(s, 'video-a', p.id, f.id);
  const m = lesson(s, 'video-a', 'u1', 'I prefer short intros.', { key: 'intro', text: 'Short intros.' });
  for (const scope of [`profile:${other.id}`, `format:${f.id}`, 'project:video-a']) {
    assert.throws(() => s.change(m.id, m.revision, { op: 'approve', scope }), /This channel or Everything/);
  }
  assert.equal(s.getMemory(m.id).status, 'pending');
  const kept = s.change(m.id, m.revision, { op: 'approve', scope: 'global' });
  assert.equal(kept.scope, 'global'); assert.equal(kept.status, 'approved');
  assert(kept.fingerprint.startsWith('global:'));
  assert(s.context(otherChat).includes('Short intros.'));
  // Creator memories without a chat: one for Everything may go to any channel; a channel's stays with its channel.
  const anywhere = s.propose({ text: 'Warm colour grade.', key: 'grade', scope: 'global' });
  assert.equal(s.change(anywhere.id, anywhere.revision, { op: 'approve', scope: `profile:${other.id}` }).scope, `profile:${other.id}`);
  const mine = s.propose({ text: 'Square thumbnails.', key: 'thumbs', scope: `profile:${p.id}` });
  assert.throws(() => s.change(mine.id, mine.revision, { op: 'approve', scope: `profile:${other.id}` }), /This channel or Everything/);
  // Omitting the level keeps today's behaviour.
  assert.equal(approve(s, mine).scope, `profile:${p.id}`);
  assert(s.context(chat).includes('Square thumbnails.'));
});

test('moving re-fingerprints, keeps rejected texts blocked, reuses a duplicate and reviews same-topic memories at the target', t => {
  const { s, p } = fixture(t);
  const channel = `profile:${p.id}`;
  // A text rejected for Everything stays blocked there after a move.
  const bold = approve(s, s.propose({ text: 'Use bold captions.', key: 'captions', scope: channel }));
  const rejected = s.propose({ text: 'use BOLD captions. ', key: 'captions', scope: 'global' });
  s.change(rejected.id, rejected.revision, { op: 'reject' });
  assert.throws(() => s.change(bold.id, bold.revision, { op: 'move', scope: 'global' }), /forgotten or rejected/);
  assert.equal(s.getMemory(bold.id).scope, channel);
  // The same text already approved for Everything: that one is kept and the moved one is closed in its favour.
  const spelling = approve(s, s.propose({ text: 'British spelling.', key: 'spelling', scope: channel }));
  const existing = approve(s, s.propose({ text: 'British spelling.', key: 'spelling', scope: 'global' }));
  assert.equal(s.change(spelling.id, spelling.revision, { op: 'move', scope: 'global' }).id, existing.id);
  assert.equal(s.getMemory(spelling.id).status, 'superseded');
  assert.equal(s.entries('global').filter(m => m.key === 'spelling' && m.status === 'approved').length, 1);
  // Same topic at the target must be named explicitly; the move keeps approval and appears in history.
  const music = approve(s, s.propose({ text: 'Music at -24 dB under speech.', key: 'music', scope: channel }));
  const older = approve(s, s.propose({ text: 'Music at -18 dB under speech.', key: 'music', scope: 'global' }));
  assert.throws(() => s.change(music.id, music.revision, { op: 'move', scope: 'global' }), /explicitly replace/);
  assert.throws(() => s.change(music.id, music.revision - 1, { op: 'move', scope: 'global', supersede: [older.id] }), /changed/);
  const moved = s.change(music.id, music.revision, { op: 'move', scope: 'global', supersede: [older.id] });
  assert.equal(moved.status, 'approved'); assert.equal(moved.scope, 'global'); assert.equal(moved.revision, music.revision + 1);
  assert(moved.fingerprint.startsWith('global:'));
  assert.equal(s.getMemory(older.id).status, 'superseded');
  assert.deepEqual(s.history(music.id).slice(0, 2).map(r => r.scope), ['global', channel]);
  assert.throws(() => s.change(moved.id, moved.revision, { op: 'move', scope: 'global' }), /another level/);
  const pending = s.propose({ text: 'Pending lesson.', key: 'pending', scope: channel });
  assert.throws(() => s.change(pending.id, pending.revision, { op: 'move', scope: 'global' }), /Only approved/);
  // Approving to a level where the same text waits for review closes that pending twin.
  const twin = s.propose({ text: 'Pending lesson.', key: 'pending', scope: 'global' });
  assert.equal(s.change(pending.id, pending.revision, { op: 'approve', scope: 'global' }).status, 'approved');
  assert.equal(s.getMemory(twin.id).status, 'superseded');
});

test('older format and video memories keep working, list under their channel with their real scope and move to the channel', async t => {
  const { s, root, p, f, other, otherChat } = fixture(t);
  projectChat(s, 'video-a', p.id, f.id);
  const formatMemory = approve(s, s.propose({ text: 'Format-level pacing.', key: 'pacing', scope: `format:${f.id}` }));
  const videoMemory = approve(s, s.propose({ text: 'Video-level colour.', key: 'colour', scope: 'project:video-a' }));
  for (const text of ['Format-level pacing.', 'Video-level colour.']) {
    assert(s.context('video-a').includes(text)); assert(!s.context(otherChat).includes(text));
  }
  const listed = await routeGet(root, `?profile=${p.id}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.value.scopes.map(x => x.name), ['Everything', 'Channel A', 'Channel B']);
  const byId = new Map(listed.value.entries.map(m => [m.id, m]));
  assert.equal(byId.get(formatMemory.id).scope, `format:${f.id}`);
  assert.deepEqual(byId.get(formatMemory.id).origin, { kind: 'format', name: 'Shorts' });
  assert.equal(byId.get(videoMemory.id).origin.kind, 'project');
  assert.deepEqual(byId.get(formatMemory.id).levels.map(l => l.scope), ['global', `profile:${p.id}`]);
  assert(!(await routeGet(root, `?profile=${other.id}`)).value.entries.some(m => byId.has(m.id)));
  // A chat's dialog defaults to its channel and offers only the chat's two levels.
  const forChat = await routeGet(root, '?chat=video-a');
  assert.equal(forChat.value.scope, `profile:${p.id}`);
  assert.deepEqual(forChat.value.scopes.map(x => x.id), ['global', `profile:${p.id}`]);
  const lifted = s.change(formatMemory.id, formatMemory.revision, { op: 'move', scope: `profile:${p.id}` });
  assert.equal(lifted.scope, `profile:${p.id}`); assert.equal(lifted.status, 'approved');
  assert(s.context('video-a').includes('Format-level pacing.'));
  assert(!s.context(otherChat).includes('Format-level pacing.'));
  assert.throws(() => s.change(videoMemory.id, videoMemory.revision, { op: 'move', scope: `profile:${other.id}` }), /This channel or Everything/);
  assert.equal(s.change(videoMemory.id, videoMemory.revision, { op: 'move', scope: `profile:${p.id}` }).scope, `profile:${p.id}`);
});

test('isolation: a memory from channel A never reaches channel B, whatever level or move is attempted', async t => {
  const { s, root, p, f, other, f2 } = fixture(t);
  projectChat(s, 'video-a', p.id, f.id);
  projectChat(s, 'video-b', other.id, f2.id);
  const secret = lesson(s, 'video-a', 'ua', 'I prefer MEM-ALPHA lower thirds.', { key: 'lower-thirds', text: 'MEM-ALPHA lower thirds.' });
  assert.equal(secret.scope, `profile:${p.id}`);
  const legacy = approve(s, s.propose({ text: 'MEM-ALPHA format pacing.', key: 'pacing', scope: `format:${f.id}` }));
  for (const scope of [`profile:${other.id}`, `format:${f2.id}`, 'project:video-b']) {
    assert.throws(() => s.change(secret.id, secret.revision, { op: 'approve', scope }));
  }
  const kept = approve(s, s.getMemory(secret.id));
  for (const m of [kept, legacy]) assert.throws(() => s.change(m.id, m.revision, { op: 'move', scope: `profile:${other.id}` }), /This channel or Everything/);
  assert(s.context('video-a').includes('MEM-ALPHA lower thirds.'));
  assert(!s.context('video-b').includes('MEM-ALPHA'));
  assert(!s.listing(`profile:${other.id}`).some(m => m.text.includes('MEM-ALPHA')));
  assert.equal(s.search('ALPHA', `profile:${other.id}`, { within: true }).length, 0);
  assert(s.search('ALPHA', `profile:${p.id}`, { within: true }).some(e => e.id === 'ua'));
  const forB = await routeGet(root, '?chat=video-b');
  assert(!forB.value.entries.some(m => m.text.includes('MEM-ALPHA')));
  assert(!forB.value.scopes.some(x => x.id === `profile:${p.id}`));
  // An agent in channel B cannot cite channel A's message to propose it there.
  assert.throws(() => s.propose({ text: 'MEM-ALPHA lower thirds.', key: 'lower-thirds', scope: `profile:${other.id}`, chat: 'video-b', evidence: ['ua'], source: 'agent' }), /Evidence must/);
});

test('restore with tombstones still blocks a forgotten memory after a move at both levels', t => {
  const { s, root, p } = fixture(t);
  projectChat(s, 'video-a', p.id, null);
  const m = approve(s, lesson(s, 'video-a', 'u1', 'Remember this: no stock music.', { key: 'music', text: 'No stock music.' }));
  const moved = s.change(m.id, m.revision, { op: 'move', scope: 'global' });
  const backup = s.backup();
  s.change(moved.id, moved.revision, { op: 'forget' });
  s.close();
  const preview = previewDatabaseRestore(root, backup.id); restoreDatabase(root, backup.id, preview.token);
  const restored = new MemoryStore(root); try {
    assert.equal(restored.getMemory(m.id).status, 'forgotten');
    assert(!restored.context('video-a').includes('No stock music.'));
    for (const scope of ['global', `profile:${p.id}`]) assert.throws(() => restored.propose({ text: 'No stock music.', key: 'music', scope }), /forgotten or rejected/);
  } finally { restored.close(); }
});

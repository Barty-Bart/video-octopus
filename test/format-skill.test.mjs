// Format skill (22 October 2026 spec, phase 1): continuing conversations, instruction/manual evidence,
// rule replace/remove, learnings, key frames, rename/archive, videos query, the generated per-format skill
// and the pinned copy a project sees. Disposable temporary studios only; no agents, network or creator data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LearningStore, formatSkillName, formatSkillId } from '../server/learning-store.mjs';
import { ProfileStore } from '../server/profile-store.mjs';
import { syncSkills, skillsView, activeSkillRoot, registerGeneratedSkills, skillSelectionBrief, takeSkillNotices } from '../server/managed-skills.mjs';
import { generateFormatSkills, pinnedFormatSkill } from '../server/format-skills.mjs';
import { pinnedSkillDir } from '../server/claude.mjs';

registerGeneratedSkills((studio, stage) => generateFormatSkills(studio, stage, { projectName: (id) => `Video ${id}` }));

function fixture(t, Store = LearningStore) {
  // macOS temp folders are symlinks; the app correctly refuses symlinked storage, so use the real path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-format-skill-')));
  const store = new Store(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const profile = store.profile('Main YouTube'), format = store.format(profile.id, 'Instagram reel', 'short', 45);
  return { root, store, profile, format };
}
const writeDraft = (store, sessionId, draft) => writeFileSync(join(store.sessionDir(sessionId), 'work/proposal.json'), JSON.stringify(draft));
const noteRef = (store, session, note = 'At 00:02 the finished result appears.') =>
  store.reference(session.id, session.revision, { name: `Reference ${randomUUID().slice(0, 4)}`, kind: 'note', note });
function approveAll(store, sessionId, overrides = {}) {
  const p = store.proposal(sessionId);
  const decisions = [...p.rules, ...p.removals].map((r) => ({ id: r.id, action: 'keep', ...(overrides[r.id] || {}) }));
  return store.approve(sessionId, { revision: p.revision, token: p.token, decisions });
}
// v1 with rules "opening" and "outro", from a studied note reference.
function firstVersion(store, format) {
  let s = store.session(format.id, { name: 'First study' });
  s = noteRef(store, s);
  const ref = s.references[0].id;
  writeDraft(store, s.id, {
    rules: [
      { id: 'opening', area: 'scripting', text: 'Show the result first.', confidence: 'medium', evidence: [{ referenceId: ref, note: '00:02: result visible.' }] },
      { id: 'outro', area: 'pacing', text: 'End on a two second hold.', confidence: 'low', evidence: [{ referenceId: ref, note: '00:30: hold.' }] },
    ],
    workflow: 'Draft the script, lock the cut, approve the plan, build and review.',
    learnings: [{ text: 'Openings run under three seconds.', evidence: [{ referenceId: ref, note: 'All openings are short.' }] }],
  });
  return { session: store.get('sessions', s.id), ref, v1: approveAll(store, s.id) };
}

test('a conversation continues after approval: proposal archived, base moves to the new version, chat writes allowed', (t) => {
  const { store, format } = fixture(t);
  const { session, v1 } = firstVersion(store, format);
  const s = store.get('sessions', session.id);
  assert.equal(s.status, 'draft');
  assert.equal(s.baseVersion, v1.id);
  assert.deepEqual(s.approvedVersions, [v1.id]);
  assert.equal(existsSync(join(store.sessionDir(s.id), 'work/proposal.json')), false);
  assert.ok(existsSync(join(store.sessionDir(s.id), `work/proposals/${v1.id}.json`)), 'the used draft is archived, not deleted');
  assert.throws(() => store.proposal(s.id), /No proposal yet/);
  // The same conversation keeps working and can save v2.
  const next = store.change(s.id, s.revision, (x) => { x.status = 'running'; });
  store.change(s.id, next.revision, (x) => { x.status = 'review'; });
  writeDraft(store, s.id, { rules: [{ id: 'opening', area: 'scripting', text: 'Show the result in the first second.', confidence: 'high', evidence: [{ referenceId: s.references[0].id, note: '00:01: result.' }] }] });
  const v2 = approveAll(store, s.id);
  assert.equal(v2.number, 2);
  assert.deepEqual(store.get('sessions', s.id).approvedVersions, [v1.id, v2.id]);
  assert.equal(store.version(v2.id).workflow, store.version(v1.id).workflow, 'workflow carries forward when the draft omits it');
});

test('a legacy approved conversation reopens on the next change and approval still guards a moved base', (t) => {
  const { store, format } = fixture(t);
  const { session, v1 } = firstVersion(store, format);
  // Simulate the old locked state: status approved, proposal still in work/, no approvedVersions.
  const legacy = store.update('sessions', { ...store.get('sessions', session.id), status: 'approved', approvedVersions: undefined, baseVersion: null });
  writeDraft(store, legacy.id, { rules: [] });
  assert.throws(() => store.approve(legacy.id, { revision: legacy.revision, token: 'x', decisions: [] }), /no rule changes|already saved/);
  const reopened = store.configure(legacy.id, legacy.revision, { direction: 'Keep going' });
  assert.equal(reopened.status, 'draft');
  assert.equal(reopened.baseVersion, v1.id);
  assert.deepEqual(reopened.approvedVersions, [v1.id]);
  assert.ok(existsSync(join(store.sessionDir(legacy.id), `work/proposals/${v1.id}.json`)));
  // Another conversation saves v2: the first one's draft must be rebased before it can be saved.
  let other = store.session(format.id, { name: 'Other' });
  other = noteRef(store, other);
  writeDraft(store, other.id, { rules: [{ id: 'captions', area: 'captions', text: 'Use large captions.', confidence: 'medium', evidence: [{ referenceId: other.references[0].id, note: '00:03: captions.' }] }] });
  approveAll(store, other.id);
  writeDraft(store, legacy.id, { rules: [{ id: 'sound', area: 'sound', text: 'Quiet whooshes only.', confidence: 'low', evidence: [{ referenceId: legacy.references[0].id, note: '00:05: whoosh.' }] }] });
  const stale = store.proposal(legacy.id);
  assert.equal(stale.stale, true);
  assert.throws(() => approveAll(store, legacy.id), (e) => e.status === 409 && /Rebase the draft/.test(e.message));
  const rebased = store.rebase(legacy.id, store.get('sessions', legacy.id).revision);
  assert.equal(rebased.baseVersion, store.get('formats', format.id).activeVersion);
  const v3 = approveAll(store, legacy.id);
  assert.deepEqual(store.version(v3.id).rules.map((r) => r.id).sort(), ['captions', 'opening', 'outro', 'sound']);
});

test('instruction evidence must cite a stored creator message of this conversation with a real quote', (t) => {
  const { store, format } = fixture(t);
  const { session } = firstVersion(store, format);
  const messageId = randomUUID();
  assert.equal(store.recordMessage(session.id, { id: messageId, text: 'Please use blue instead of red next time.' }), true);
  const otherSession = store.session(format.id, { name: 'Elsewhere' });
  const foreign = randomUUID();
  store.recordMessage(otherSession.id, { id: foreign, text: 'Use blue instead of red.' });
  const rule = (evidence) => ({ rules: [{ id: 'colour', area: 'visuals', text: 'Use blue accents instead of red.', confidence: 'high', evidence }] });
  writeDraft(store, session.id, rule([{ kind: 'instruction', messageId, quote: 'use blue instead of red' }]));
  const ok = store.proposal(session.id);
  assert.equal(ok.rules[0].change, 'new');
  assert.deepEqual(ok.rules[0].evidence, [{ kind: 'instruction', messageId, quote: 'use blue instead of red' }]);
  for (const [evidence, why] of [
    [[{ kind: 'instruction', messageId: randomUUID(), quote: 'use blue instead of red' }], /creator message/],
    [[{ kind: 'instruction', messageId: foreign, quote: 'use blue instead of red' }], /creator message/],
    [[{ kind: 'instruction', messageId, quote: 'use green' }], /does not appear/],
    [[{ kind: 'instruction', messageId, quote: '' }], /quote/],
    [[{ kind: 'manual', editId: randomUUID(), note: 'Edited by creator' }], /direct edit/],
    [[{ kind: 'mystery' }], /reference, a creator instruction or a direct edit/],
  ]) {
    writeDraft(store, session.id, rule(evidence));
    assert.throws(() => store.proposal(session.id), why);
  }
  // Messages captured by the memory feature before this table existed still count, unless forgotten.
  store.db.exec('CREATE TABLE IF NOT EXISTS memory_events(id TEXT PRIMARY KEY, chat TEXT NOT NULL, scope TEXT NOT NULL, role TEXT NOT NULL, created TEXT NOT NULL, text TEXT NOT NULL, conversation TEXT NOT NULL)');
  store.db.exec('CREATE TABLE IF NOT EXISTS memory_tombstones(kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(kind,id))');
  const remembered = randomUUID();
  store.db.prepare('INSERT INTO memory_events VALUES(?,?,?,?,?,?,?)').run(remembered, `_learning_${session.id}`, 'format', 'user', new Date().toISOString(), 'Make captions yellow.', 'c');
  writeDraft(store, session.id, { rules: [{ id: 'captions', area: 'captions', text: 'Yellow captions.', confidence: 'high', evidence: [{ kind: 'instruction', messageId: remembered, quote: 'captions yellow' }] }] });
  assert.equal(store.proposal(session.id).rules[0].id, 'captions');
  store.db.prepare("INSERT INTO memory_tombstones VALUES('event',?)").run(remembered);
  assert.throws(() => store.proposal(session.id), /creator message/);
  // A plain-language edit produces a valid draft and a new version without any new references.
  writeDraft(store, session.id, rule([{ kind: 'instruction', messageId, quote: 'blue instead of red' }]));
  const v2 = approveAll(store, session.id);
  assert.equal(store.version(v2.id).rules.find((r) => r.id === 'colour').evidence[0].kind, 'instruction');
});

test('drafts replace, add and remove rules explicitly; removals are reviewed like rules', (t) => {
  const { store, format } = fixture(t);
  const { session, ref } = firstVersion(store, format);
  const messageId = randomUUID();
  store.recordMessage(session.id, { id: messageId, text: 'Drop the outro hold, it drags.' });
  writeDraft(store, session.id, {
    rules: [
      { id: 'opening', area: 'scripting', text: 'Show the result within one second.', confidence: 'high', evidence: [{ referenceId: ref, note: '00:01.' }] },
      { id: 'hook', area: 'scripting', text: 'Ask a question in the hook.', confidence: 'medium', evidence: [{ referenceId: ref, note: '00:00 question.' }] },
    ],
    remove: [{ id: 'outro', evidence: [{ kind: 'instruction', messageId, quote: 'Drop the outro hold' }] }],
    learnings: [{ text: 'Hooks are questions.', evidence: [{ referenceId: ref, note: 'Three of three.' }] }],
  });
  const p = store.proposal(session.id);
  assert.deepEqual(p.rules.map((r) => [r.id, r.change]), [['opening', 'changed'], ['hook', 'new']]);
  assert.equal(p.rules[0].previous.text, 'Show the result first.');
  assert.deepEqual(p.removals.map((r) => [r.id, r.change, r.text]), [['outro', 'removed', 'End on a two second hold.']]);
  assert.throws(() => store.approve(session.id, { revision: p.revision, token: p.token, decisions: p.rules.map((r) => ({ id: r.id, action: 'keep' })) }), /Review every/);
  // Discarding the removal keeps the rule.
  const kept = approveAll(store, session.id, { outro: { action: 'discard' } });
  const pack = store.version(kept.id);
  assert.deepEqual(pack.rules.map((r) => r.id).sort(), ['hook', 'opening', 'outro']);
  assert.equal(pack.rules.find((r) => r.id === 'opening').text, 'Show the result within one second.');
  assert.deepEqual(pack.changes, { new: ['hook'], changed: ['opening'], removed: [] });
  assert.deepEqual(pack.learnings.map((l) => l.text), ['Openings run under three seconds.', 'Hooks are questions.'], 'learnings accumulate in the version package');
  // Removing again, accepted this time.
  writeDraft(store, session.id, { remove: [{ id: 'outro', evidence: [{ kind: 'instruction', messageId, quote: 'it drags' }] }] });
  const v3 = approveAll(store, session.id);
  assert.deepEqual(store.version(v3.id).rules.map((r) => r.id).sort(), ['hook', 'opening']);
  assert.deepEqual(store.version(v3.id).changes.removed, ['outro']);
  writeDraft(store, session.id, { remove: ['not-a-rule'] });
  assert.throws(() => store.proposal(session.id), /not in the version/);
  writeDraft(store, session.id, { rules: [{ id: 'x', area: 'scripting', text: 'X', confidence: 'low', evidence: [{ referenceId: ref, note: 'n' }] }], remove: [{ id: 'x', evidence: [{ referenceId: ref, note: 'n' }] }] });
  assert.throws(() => store.proposal(session.id), /unique/);
});

test('a direct creator edit lands in an open conversation draft as manual evidence and is still reviewed', (t) => {
  const { store, format } = fixture(t);
  // No version yet: the edit starts a conversation and the first draft gets the default workflow.
  const first = store.draftRule(format.id, { area: 'visuals', text: 'Use the channel blue for titles.' });
  assert.equal(first.status, 'review');
  assert.equal(first.manualEdits.length, 1);
  const p1 = store.proposal(first.id);
  assert.equal(p1.rules[0].evidence[0].kind, 'manual');
  assert.equal(p1.rules[0].evidence[0].note, 'Edited by creator');
  const v1 = approveAll(store, first.id);
  assert.equal(store.get('formats', format.id).activeVersion, v1.id);
  const ruleId = store.version(v1.id).rules[0].id;
  // Next edit reuses the open conversation (based on v1) and replaces the rule.
  const edited = store.draftRule(format.id, { ruleId, area: 'visuals', text: 'Use the channel blue for titles and lower thirds.' });
  assert.equal(edited.id, first.id);
  const p2 = store.proposal(edited.id);
  assert.equal(p2.rules[0].change, 'changed');
  assert.equal(p2.rules[0].previous.text, 'Use the channel blue for titles.');
  // An agent cannot forge "Edited by you": changed text or another rule id fails validation.
  const draftPath = join(store.sessionDir(edited.id), 'work/proposal.json');
  const draft = JSON.parse(readFileSync(draftPath, 'utf8'));
  writeFileSync(draftPath, JSON.stringify({ ...draft, rules: [{ ...draft.rules[0], text: 'Agent rewrote this.' }] }));
  assert.throws(() => store.proposal(edited.id), /direct edit/);
  writeFileSync(draftPath, JSON.stringify({ ...draft, rules: [{ ...draft.rules[0], id: 'other-rule' }] }));
  assert.throws(() => store.proposal(edited.id), /direct edit/);
  writeFileSync(draftPath, JSON.stringify(draft));
  // A removal edit, stale revision check and unknown rule.
  const removal = store.draftRule(format.id, { ruleId, remove: true });
  assert.deepEqual(store.proposal(removal.id).removals.map((r) => r.id), [ruleId]);
  assert.deepEqual(store.proposal(removal.id).rules, [], 'the replacement for the same rule is superseded by the removal');
  assert.throws(() => store.draftRule(format.id, { sessionId: removal.id, revision: removal.revision - 1, area: 'visuals', text: 'x' }), /changed/);
  assert.throws(() => store.draftRule(format.id, { ruleId: 'missing', remove: true }), /saved skill/);
  assert.throws(() => store.draftRule(format.id, { area: 'nonsense', text: 'x' }), /area/);
  store.draftRule(format.id, { area: 'pacing', text: 'Cut on the beat.' });
  const p3 = store.proposal(removal.id);
  assert.equal(p3.rules[0].area, 'pacing');
  const pacingId = p3.rules[0].id;
  assert.throws(() => approveAll(store, removal.id, { [pacingId]: { action: 'discard' } }), /Keep at least one rule/);
  const v2 = approveAll(store, removal.id, { [ruleId]: { action: 'discard' } });
  assert.deepEqual(store.version(v2.id).rules.map((r) => r.area).sort(), ['pacing', 'visuals']);
});

test('references cited by a saved version stay with the conversation', (t) => {
  const { store, format } = fixture(t);
  const { session, ref } = firstVersion(store, format);
  const s = store.get('sessions', session.id);
  assert.throws(() => store.removeReference(s.id, s.revision, ref), /evidence for a saved skill version/);
  const extra = noteRef(store, s, 'Unused note');
  const after = store.removeReference(extra.id, extra.revision, extra.references[1].id);
  assert.equal(after.references.length, 1);
});

test('rename, setup change, archive and restore use revision checks and leave versions and pins alone', (t) => {
  const { store, profile, format } = fixture(t);
  const { v1 } = firstVersion(store, format);
  store.pin('old-project', { formatId: format.id, versionId: v1.id });
  let f = store.get('formats', format.id);
  assert.throws(() => store.updateFormat(f.id, { expected: f.revision + 1, name: 'Stale' }), /changed/);
  f = store.updateFormat(f.id, { expected: f.revision, name: 'Reels', type: 'explainer', targetSeconds: 60 });
  assert.equal(f.name, 'Reels'); assert.equal(f.type, 'explainer'); assert.equal(f.targetSeconds, 60);
  assert.equal(store.version(v1.id).rules.length, 2, 'versions are immutable');
  assert.throws(() => store.updateFormat(f.id, { expected: f.revision, type: 'podcast' }), /supported/);
  f = store.archiveFormat(f.id, f.revision, true);
  assert.equal(f.archived, true);
  assert.equal(store.formatArchived(f), true);
  assert.equal(store.binding('old-project').versionId, v1.id);
  f = store.archiveFormat(f.id, f.revision, false);
  assert.equal(f.archived, false);
  let p = store.updateProfile(profile.id, { expected: 1, name: 'Second channel name' });
  assert.equal(p.name, 'Second channel name');
  assert.throws(() => store.archiveProfile(p.id, 1, true), /changed/);
  p = store.archiveProfile(p.id, p.revision, true);
  assert.equal(store.formatArchived(store.get('formats', f.id)), true, 'a format of an archived channel is hidden too');
  assert.throws(() => store.format(p.id, 'New', 'short'), /archived/);
  assert.throws(() => store.archiveFormat(f.id, store.get('formats', f.id).revision, false), /Restore the channel/);
  p = store.archiveProfile(p.id, p.revision, false);
  assert.equal(p.archived, false);
  // History switching bumps the format revision too, so a stale rename fails.
  const before = store.get('formats', f.id).revision;
  store.activate(f.id, v1.id, v1.id);
  assert.equal(store.get('formats', f.id).revision, before + 1);
});

test('videos query lists projects pinned to each version of a format', (t) => {
  const { store, format } = fixture(t, ProfileStore);
  const { session, v1 } = firstVersion(store, format);
  writeDraft(store, session.id, { rules: [{ id: 'opening', area: 'scripting', text: 'Changed.', confidence: 'low', evidence: [{ referenceId: store.get('sessions', session.id).references[0].id, note: 'n' }] }] });
  const v2 = approveAll(store, session.id);
  store.pin('project-a', { formatId: format.id, versionId: v1.id });
  store.pinContext('project-a', { formatId: format.id, versionId: v1.id, created: '2026-10-01T00:00:00.000Z' });
  store.pinContext('project-b', { formatId: format.id, versionId: v2.id, created: '2026-10-20T00:00:00.000Z' });
  store.pin('unrelated', { formatId: randomUUID(), versionId: randomUUID() });
  const rows = store.formatVideos(format.id);
  assert.deepEqual(rows.map((r) => [r.project, r.number]), [['project-b', 2], ['project-a', 1]]);
});

test('approval keeps up to six key frames per studied video; copies carry them', (t) => {
  const { store, format, profile } = fixture(t);
  let s = store.session(format.id, { name: 'Video study' });
  s = store.upload(s.id, s.revision, 'reel.mp4', Buffer.from('synthetic video bytes, not media'));
  const ref = s.references[0];
  const frames = join(store.sessionDir(s.id), `work/frames/${ref.id}`);
  mkdirSync(frames, { recursive: true });
  for (let i = 1; i <= 10; i++) writeFileSync(join(frames, `frame-${String(i).padStart(6, '0')}.jpg`), `jpeg ${i}`);
  writeFileSync(join(frames, 'coverage.json'), JSON.stringify({ fps: 2 }));
  writeDraft(store, s.id, { rules: [{ id: 'opening', area: 'visuals', text: 'Open on the product.', confidence: 'medium', evidence: [{ referenceId: ref.id, note: '00:00 product.' }] }], workflow: 'Plan, build, review.' });
  const v1 = approveAll(store, s.id);
  const pack = store.version(v1.id);
  assert.equal(pack.examples.length, 1);
  assert.equal(pack.examples[0].frames.length, 6);
  assert.equal(pack.examples[0].frames[0].seconds, 0);
  assert.equal(pack.examples[0].frames.at(-1).seconds, 4.5);
  assert.ok(pack.files.some((x) => x.file.startsWith('examples/frames/')));
  // Key frames live in the content-addressed file store (skill-assets spec, 23 October 2026), not in SQLite or the version folder.
  const frame = pack.files.find((x) => x.file === pack.examples[0].frames[0].file);
  assert.equal(readFileSync(store.files.locate(frame.sha256), 'utf8'), 'jpeg 1', 'frames are kept in the file store');
  assert.equal(existsSync(join(pack.path, frame.file)), false, 'not copied into the version folder');
  const copy = store.copyFormat(format.id, { profileId: profile.id, name: 'Copy', expected: v1.id, reviewed: true });
  assert.equal(store.version(copy.activeVersion).examples[0].frames.length, 6);
});

test('format skill: generated per format, rebuilt from the active version, never in skills/custom', (t) => {
  const { root, store, format, profile } = fixture(t);
  syncSkills({ studio: root, fresh: true });
  const name = formatSkillName(format.id);
  assert.equal(existsSync(join(root, '.claude/skills', name)), false, 'no skill before a version exists');
  const { session } = firstVersion(store, format);
  syncSkills({ studio: root });
  const dir = join(root, '.claude/skills', name);
  for (const file of ['SKILL.md', 'rules.md', 'examples/examples.md', 'learnings.md', 'videos.md']) assert.ok(existsSync(join(dir, file)), file);
  assert.ok(existsSync(join(dir, 'assets')));
  let skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.match(skill, new RegExp(`^---\\nname: ${name}\\n`));
  assert.match(skill, /Main YouTube › Instagram reel: approved Short format skill \(v1\)/);
  assert.match(readFileSync(join(dir, 'learnings.md'), 'utf8'), /Openings run under three seconds/);
  let entry = skillsView({ studio: root }).items.find((x) => x.id === formatSkillId(format.id));
  assert.equal(entry.kind, 'format'); assert.equal(entry.overridePath, null); assert.ok(entry.published);
  assert.equal(readdirSync(join(root, 'skills/custom')).some((x) => x.startsWith('learned-') || x.startsWith('format-')), false);
  assert.ok(activeSkillRoot({ studio: root }), 'a generated skill has no source folder and still passes the chat check');
  assert.match(skillSelectionBrief({ studio: root }), /"selection":"format"/);
  // v2 from the same conversation: the skill follows the active version.
  store.pin('p1', { formatId: format.id, versionId: store.get('formats', format.id).activeVersion });
  writeDraft(store, session.id, { rules: [{ id: 'opening', area: 'scripting', text: 'Second version opening.', confidence: 'high', evidence: [{ referenceId: store.get('sessions', session.id).references[0].id, note: 'n' }] }] });
  const v2 = approveAll(store, session.id);
  syncSkills({ studio: root });
  skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.match(skill, /\(v2\)/); assert.match(skill, /Second version opening/);
  assert.match(readFileSync(join(dir, 'videos.md'), 'utf8'), /## v1[\s\S]*Video p1/);
  assert.equal(skillsView({ studio: root }).items.find((x) => x.id === formatSkillId(format.id)).versionId, v2.id);
  // Rename changes the description, never the skill name.
  let f = store.updateFormat(format.id, { expected: store.get('formats', format.id).revision, name: 'Vertical reel' });
  syncSkills({ studio: root });
  assert.match(readFileSync(join(dir, 'SKILL.md'), 'utf8'), /Main YouTube › Vertical reel/);
  // Archive withdraws it; restore brings it back. Archiving the channel withdraws it too.
  f = store.archiveFormat(f.id, f.revision, true);
  syncSkills({ studio: root });
  assert.equal(existsSync(dir), false);
  assert.equal(skillsView({ studio: root }).items.some((x) => x.id === formatSkillId(format.id)), false);
  f = store.archiveFormat(f.id, f.revision, false);
  syncSkills({ studio: root });
  assert.ok(existsSync(join(dir, 'SKILL.md')));
  const p = store.archiveProfile(profile.id, store.get('profiles', profile.id).revision, true);
  syncSkills({ studio: root });
  assert.equal(existsSync(dir), false);
  store.archiveProfile(p.id, p.revision, false);
  syncSkills({ studio: root });
  // Deleting the projection regenerates it from SQLite on the next sync (startup).
  rmSync(dir, { recursive: true });
  syncSkills({ studio: root });
  assert.ok(existsSync(join(dir, 'SKILL.md')));
});

test('format skill: protected from collisions, edits are not imported, skill actions are refused', (t) => {
  const { root, store, format } = fixture(t);
  syncSkills({ studio: root, fresh: true });
  firstVersion(store, format);
  syncSkills({ studio: root });
  const name = formatSkillName(format.id), dir = join(root, '.claude/skills', name);
  const generatedBytes = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  // A personal skill claiming the same name is withheld; its files are kept and the format skill stays.
  const custom = join(root, 'skills/custom/my-copy');
  mkdirSync(custom, { recursive: true });
  writeFileSync(join(custom, 'SKILL.md'), `---\nname: ${name}\ndescription: Creator skill with a clashing name\n---\nCREATOR CONTENT\n`);
  let view = syncSkills({ studio: root, action: { action: 'refresh' } });
  const personal = view.items.find((x) => x.kind === 'personal' && x.folder === 'my-copy');
  assert.equal(personal.published, null);
  assert.match(personal.collision, /generated format skill/);
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), generatedBytes);
  assert.match(readFileSync(join(custom, 'SKILL.md'), 'utf8'), /CREATOR CONTENT/);
  // A creator copy of the generated folder (with its identity marker) becomes an independent skill.
  const copied = join(root, 'skills/custom/kept-format');
  mkdirSync(copied, { recursive: true });
  writeFileSync(join(copied, 'SKILL.md'), '---\nname: kept-format-copy\ndescription: copy\n---\nCopy\n');
  writeFileSync(join(copied, '.octopus-skill.json'), JSON.stringify({ schema: 1, id: formatSkillId(format.id) }));
  view = syncSkills({ studio: root, action: { action: 'refresh' } });
  const independent = view.items.find((x) => x.name === 'kept-format-copy');
  assert.equal(independent.kind, 'personal');
  assert.notEqual(independent.id, formatSkillId(format.id));
  assert.equal(view.items.find((x) => x.id === formatSkillId(format.id)).kind, 'format');
  // Skill-manager actions cannot edit or disable a generated skill.
  assert.throws(() => syncSkills({ studio: root, action: { action: 'edit', id: formatSkillId(format.id), revision: view.revision, text: 'x' } }), /generated from Video formats/);
  assert.throws(() => syncSkills({ studio: root, action: { action: 'disable', id: formatSkillId(format.id), revision: view.revision } }), /generated from Video formats/);
  // An edited active copy no longer blocks chats (phase 2, audit S5): the next chat puts the database version back,
  // keeps the edited copy aside and says so once. Nothing is imported.
  writeFileSync(join(dir, 'SKILL.md'), generatedBytes + '\nEDITED BY HAND\n');
  takeSkillNotices();
  assert.equal(activeSkillRoot({ studio: root }), join(root, '.claude/skills'));
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), generatedBytes);
  const notices = takeSkillNotices();
  assert.equal(notices.length, 1);
  const aside = /kept in (.+)\.$/.exec(notices[0])[1];
  assert.match(readFileSync(join(aside, 'SKILL.md'), 'utf8'), /EDITED BY HAND/);
  // Refresh rebuilds it from SQLite instead of importing, as before.
  writeFileSync(join(dir, 'SKILL.md'), generatedBytes + '\nEDITED AGAIN\n');
  syncSkills({ studio: root, action: { action: 'refresh' } });
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), generatedBytes);
  assert.equal(existsSync(join(root, 'skills/custom', name)), false);
  assert.equal(existsSync(join(root, 'skills/overrides', name)), false);
  assert.ok(activeSkillRoot({ studio: root }));
});

test('a project pinned to an older version gets that version as its format skill and is told so', (t) => {
  const { root, store, format } = fixture(t, ProfileStore);
  syncSkills({ studio: root, fresh: true });
  const { session, v1 } = firstVersion(store, format);
  syncSkills({ studio: root });
  const bundle = store.bundle({ profileId: format.profileId, formatId: format.id, type: 'short' });
  assert.equal(bundle.versionId, v1.id);
  assert.equal(bundle.skills.some((x) => x.kind === 'format'), false, 'the studio format skill follows the active version and is not pinned');
  const projectDir = join(root, 'projects/pinned');
  mkdirSync(projectDir, { recursive: true });
  store.pinContext('pinned', bundle);
  writeDraft(store, session.id, { rules: [{ id: 'opening', area: 'scripting', text: 'Version two opening.', confidence: 'high', evidence: [{ referenceId: store.get('sessions', session.id).references[0].id, note: 'n' }] }] });
  approveAll(store, session.id);
  syncSkills({ studio: root });
  const x = store.materialize('pinned', projectDir);
  assert.ok(x.skillRoot.endsWith(join('.octopus', 'context', '.claude', 'skills')));
  const copy = join(x.skillRoot, formatSkillName(format.id), 'SKILL.md');
  const text = readFileSync(copy, 'utf8');
  assert.match(text, /\(v1\)/); assert.match(text, /pinned to v1/); assert.match(text, /Show the result first/);
  assert.doesNotMatch(text, /Version two opening/);
  assert.match(readFileSync(join(root, '.claude/skills', formatSkillName(format.id), 'SKILL.md'), 'utf8'), /Version two opening/);
  const context = store.contextText('pinned', projectDir);
  assert.match(context, /is this project's copy of Instagram reel v1/);
  assert.match(context, /active skill is now v2, which does not apply here/);
  assert.deepEqual(pinnedSkillDir(x.skillRoot), ['--add-dir', join(projectDir, '.octopus/context')]);
  // Renaming the format does not change the pinned copy; tampering is detected like other generated context.
  store.updateFormat(format.id, { expected: store.get('formats', format.id).revision, name: 'Renamed later' });
  store.materialize('pinned', projectDir);
  assert.equal(readFileSync(copy, 'utf8'), text);
  writeFileSync(copy, text + 'tampered');
  assert.throws(() => store.materialize('pinned', projectDir), /Generated project context changed/);
  store.restoreProjectFiles('pinned', projectDir);
  assert.equal(readFileSync(copy, 'utf8'), text);
  // New video cannot use an archived format; the pinned project still materializes.
  store.archiveFormat(format.id, store.get('formats', format.id).revision, true);
  assert.throws(() => store.bundle({ profileId: format.profileId, formatId: format.id, type: 'short' }), /archived/);
  assert.ok(store.materialize('pinned', projectDir).formatSkill);
  assert.equal(pinnedFormatSkill(store, { ...bundle, versionId: null }, x.skillRoot), null);
});

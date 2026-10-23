// Skill files outside the database (23 October 2026 spec): the content-addressed file store, projections into the
// published and pinned skill folders, assets and knowledge in drafts, limits, the blob migration, restore reports and
// unused files. Disposable temporary studios only; no agents, network or creator data. The 1 GB limit uses sparse files.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, truncateSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { LearningStore, formatSkillName } from '../server/learning-store.mjs';
import { FileStore, MAX_SKILL_FILES, MAX_SKILL_FILE_BYTES } from '../server/file-store.mjs';
import { syncSkills, registerGeneratedSkills } from '../server/managed-skills.mjs';
import { generateFormatSkills, pinnedFormatSkill, projectPublishedFiles } from '../server/format-skills.mjs';
import { previewDatabaseRestore, restoreDatabase } from '../server/database-recovery.mjs';

registerGeneratedSkills((studio, stage) => generateFormatSkills(studio, stage, { projectName: (id) => `Video ${id}` }), { project: projectPublishedFiles });

const sha = (b) => createHash('sha256').update(b).digest('hex');
function fixture(t) {
  // macOS temp folders are symlinks; the app correctly refuses symlinked storage, so use the real path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-skill-files-')));
  const store = new LearningStore(root);
  // Windows can't delete a folder while its SQLite file is open: every handle closes before the folder goes, in this
  // one hook (after hooks run in the order they were added, so a later t.after(close) would run too late).
  const handles = [store];
  t.after(() => {
    for (const handle of handles) { try { handle.close(); } catch {} }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const closeLater = (handle) => { handles.push(handle); return handle; };
  const profile = store.profile('Main channel'), format = store.format(profile.id, 'Product reel', 'short', 30);
  return { root, store, profile, format, closeLater };
}
const put = (path, body) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, body); };
function conversation(store, format) {
  let s = store.session(format.id, { name: 'Study' });
  s = store.reference(s.id, s.revision, { name: 'Note', kind: 'note', note: '00:02 the product appears.' });
  return s;
}
function writeDraft(store, s, draft) {
  writeFileSync(join(store.sessionDir(s.id), 'work/proposal.json'), JSON.stringify(draft));
}
const rule = (s, id = 'opening', text = 'Show the product first.') =>
  ({ id, area: 'visuals', text, confidence: 'high', evidence: [{ referenceId: s.references[0].id, note: '00:02 product.' }] });
function approveAll(store, sessionId, fileDecisions = []) {
  const p = store.proposal(sessionId);
  const decisions = [...p.rules, ...p.removals].map((r) => ({ id: r.id, action: 'keep' }));
  return store.approve(sessionId, { revision: p.revision, token: p.token, decisions, fileDecisions });
}
// v1 with one asset and two knowledge files, written the way an agent does (work/assets, work/knowledge).
function firstVersion(store, format) {
  const s = conversation(store, format), dir = store.sessionDir(s.id);
  put(join(dir, 'work/assets/logo.svg'), '<svg>logo</svg>');
  put(join(dir, 'work/knowledge/product-sheet.md'), '# Product\nWeight 2 kg.');
  put(join(dir, 'work/knowledge/prices.csv'), 'sku,price\nA1,10\n');
  writeDraft(store, s, {
    rules: [rule(s)],
    workflow: 'Plan, build, review.',
    assets: [{ file: 'work/assets/logo.svg', note: 'Brand logo, top left.' }],
    knowledge: [
      { file: 'work/knowledge/product-sheet.md', title: 'Product sheet', note: 'Specs: read for any claim about the product.' },
      { file: 'work/knowledge/prices.csv', title: 'Price list', note: 'Current prices by SKU.' },
    ],
  });
  return { s, v1: approveAll(store, s.id) };
}

test('file store: atomic write, dedupe, hash verification and damaged objects kept aside', (t) => {
  const { root } = fixture(t);
  const files = new FileStore(root);
  const a = files.putBuffer(Buffer.from('same bytes'), { ext: '.txt' });
  assert.equal(a.created, true);
  assert.equal(a.path, join(root, '.studio/files', a.sha256.slice(0, 2), `${a.sha256}.txt`));
  const source = join(root, 'source.txt');
  writeFileSync(source, 'same bytes');
  const b = files.putFile(source, { ext: '.md' });
  assert.equal(b.created, false, 'identical bytes are stored once, whatever the name');
  assert.equal(b.path, a.path);
  assert.equal(files.list().length, 1);
  assert.equal(files.verify(a.sha256), a.path);
  assert.throws(() => files.putFile(source, { expect: sha('other') }), /changed while it was being saved/);
  // A damaged object fails verification, is moved aside (not deleted) and rewritten on the next store.
  writeFileSync(a.path, 'damaged bytes');
  assert.throws(() => files.verify(a.sha256), /failed verification/);
  const again = files.putBuffer(Buffer.from('same bytes'), { ext: '.txt' });
  assert.equal(again.created, true);
  assert.equal(readFileSync(again.path, 'utf8'), 'same bytes');
  assert.equal(readdirSync(join(root, '.studio/files/.damaged')).length, 1);
  assert.equal(readdirSync(join(root, '.studio/files/.incoming')).length, 0, 'no temporary files are left behind');
});

test('knowledge and assets: proposal, version records, SKILL.md index and a database without the bytes', (t) => {
  const { root, store, format } = fixture(t);
  const { s, v1 } = firstVersion(store, format);
  const version = store.version(v1.id);
  assert.deepEqual(version.assets.map((x) => [x.file, x.kind, x.addedIn]), [['assets/logo.svg', 'asset', v1.id]]);
  assert.deepEqual(version.knowledge.map((x) => [x.file, x.title]), [['knowledge/product-sheet.md', 'Product sheet'], ['knowledge/prices.csv', 'Price list']]);
  assert.equal(version.knowledge[0].size, Buffer.byteLength('# Product\nWeight 2 kg.'));
  assert.equal(existsSync(join(version.path, 'assets/logo.svg')), false, 'version folders keep only text');
  const db = new DatabaseSync(join(root, '.studio/studio.sqlite'), { readOnly: true });
  try {
    const blobs = new Set(db.prepare('SELECT hash FROM learning_blobs').all().map((r) => r.hash));
    for (const f of version.files) assert.equal(blobs.has(f.sha256), !f.store, `${f.file}: ${f.store ? 'not in SQLite' : 'text stays in SQLite'}`);
    assert.equal(db.prepare('SELECT count(*) n FROM skill_files').get().n, 3, 'one record per stored file');
  } finally { db.close(); }

  // Published skill: files are cloned from the store after the snapshot, which never stores their bytes.
  const view = syncSkills({ studio: root, fresh: true });
  assert.equal(view.fileProblems, undefined);
  const dir = join(root, '.claude/skills', formatSkillName(format.id));
  assert.equal(readFileSync(join(dir, 'assets/logo.svg'), 'utf8'), '<svg>logo</svg>');
  assert.equal(readFileSync(join(dir, 'knowledge/prices.csv'), 'utf8'), 'sku,price\nA1,10\n');
  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.match(skill, /## Knowledge index/);
  assert.match(skill, /\*\*Product sheet\*\* — Specs: read for any claim about the product\. \(knowledge\/product-sheet\.md\)/);
  assert.match(skill, /assets\/logo\.svg: Brand logo, top left\./);
  const sdb = new DatabaseSync(join(root, '.studio/studio.sqlite'), { readOnly: true });
  try {
    const skillBlobs = new Set(sdb.prepare('SELECT hash FROM skill_blobs').all().map((r) => r.hash));
    for (const f of version.files.filter((x) => x.store)) assert.equal(skillBlobs.has(f.sha256), false, `${f.file} bytes are not in the skill snapshot`);
  } finally { sdb.close(); }
  // Startup sync (no action) with the projections present does not report "working files changed".
  assert.equal(syncSkills({ studio: root }).ok, true);

  // The Files tab view.
  const listed = store.formatFiles(format.id);
  assert.equal(listed.totals.count, 3);
  assert.equal(listed.totals.limit, MAX_SKILL_FILES);
  assert.ok(listed.files.every((x) => x.addedIn.number === 1 && x.stored));
  assert.ok(s);
});

test('projection: an edited published file is restored and the edited copy kept aside; pinned copies keep their version', (t) => {
  const { root, store, format, profile } = fixture(t);
  const { s, v1 } = firstVersion(store, format);
  syncSkills({ studio: root, fresh: true });
  const dir = join(root, '.claude/skills', formatSkillName(format.id));
  writeFileSync(join(dir, 'assets/logo.svg'), '<svg>edited outside</svg>');
  rmSync(join(dir, 'knowledge/prices.csv'));
  const view = syncSkills({ studio: root });
  assert.equal(view.ok, true);
  assert.equal(readFileSync(join(dir, 'assets/logo.svg'), 'utf8'), '<svg>logo</svg>');
  assert.equal(readFileSync(join(dir, 'knowledge/prices.csv'), 'utf8'), 'sku,price\nA1,10\n');
  assert.match(view.fileProblems.join(' '), /changed outside Video formats/);
  const aside = join(root, '.studio/edited-skill-files');
  const kept = readdirSync(aside);
  assert.equal(readFileSync(join(aside, kept[0], 'assets/logo.svg'), 'utf8'), '<svg>edited outside</svg>');

  // v2 adds a file; carried files keep their bytes and "added in v1".
  const dirS = store.sessionDir(s.id);
  put(join(dirS, 'work/knowledge/faq.txt'), 'Q: Waterproof? A: Yes.');
  writeDraft(store, store.get('sessions', s.id), { knowledge: [{ file: 'work/knowledge/faq.txt', title: 'FAQ', note: 'Customer questions.' }] });
  const p = store.proposal(s.id);
  assert.deepEqual(p.files.added.map((x) => [x.path, x.change]), [['knowledge/faq.txt', 'new']]);
  assert.equal(p.files.count, 4);
  const v2 = approveAll(store, s.id);
  assert.equal(v2.number, 2);
  syncSkills({ studio: root });
  assert.equal(readFileSync(join(dir, 'knowledge/faq.txt'), 'utf8'), 'Q: Waterproof? A: Yes.');
  const files = store.formatFiles(format.id).files;
  assert.deepEqual(files.map((x) => [x.file, x.addedIn.number]).sort(),
    [['assets/logo.svg', 1], ['knowledge/faq.txt', 2], ['knowledge/prices.csv', 1], ['knowledge/product-sheet.md', 1]]);

  // A project pinned to v1 gets v1's files only, cloned from the same hashes.
  const skillRoot = join(root, 'projects/p1/.octopus/context/.claude/skills');
  mkdirSync(skillRoot, { recursive: true });
  const pinned = pinnedFormatSkill(store, { formatId: format.id, versionId: v1.id, profileName: profile.name, formatName: format.name }, skillRoot);
  assert.equal(pinned.number, 1);
  assert.equal(readFileSync(join(pinned.path, 'assets/logo.svg'), 'utf8'), '<svg>logo</svg>');
  assert.equal(existsSync(join(pinned.path, 'knowledge/faq.txt')), false);
  // Unchanged pinned copies are reused; an edit is refused as before (Restore project context files).
  assert.equal(pinnedFormatSkill(store, { formatId: format.id, versionId: v1.id }, skillRoot).path, pinned.path);
  writeFileSync(join(pinned.path, 'knowledge/prices.csv'), 'edited');
  assert.throws(() => pinnedFormatSkill(store, { formatId: format.id, versionId: v1.id }, skillRoot), /Restore its files/);
});

test('limits: 300 files per skill and 1 GB per file (sparse files, nothing large is written)', (t) => {
  const { root, store, format } = fixture(t);
  const s = conversation(store, format), dir = store.sessionDir(s.id);
  const assets = [], knowledge = [];
  for (let i = 0; i < 150; i++) { put(join(dir, `work/assets/a${i}.txt`), `a${i}`); assets.push({ file: `work/assets/a${i}.txt` }); }
  for (let i = 0; i <= 150; i++) { put(join(dir, `work/knowledge/k${i}.md`), `k${i}`); knowledge.push({ file: `work/knowledge/k${i}.md` }); }
  writeDraft(store, s, { rules: [rule(s)], workflow: 'Plan.', assets, knowledge });
  assert.throws(() => store.proposal(s.id), new RegExp(`at most ${MAX_SKILL_FILES} files .*would have 301`));
  writeDraft(store, s, { rules: [rule(s)], workflow: 'Plan.', assets, knowledge: knowledge.slice(0, 150) });
  assert.equal(store.proposal(s.id).files.count, 300);

  const big = join(dir, 'work/assets/huge.mov');
  writeFileSync(big, '');
  truncateSync(big, MAX_SKILL_FILE_BYTES + 1);
  assert.ok(statSync(big).blocks * 512 < 1024 * 1024, 'sparse: no real gigabyte written');
  writeDraft(store, s, { rules: [rule(s)], workflow: 'Plan.', assets: [{ file: 'work/assets/huge.mov' }] });
  assert.throws(() => store.proposal(s.id), /larger than 1 GB/);
  // The Add files path refuses it too, before staging.
  const temp = store.files.incoming();
  writeFileSync(temp, '');
  truncateSync(temp, MAX_SKILL_FILE_BYTES + 1);
  assert.throws(() => store.stageDraftFile(format.id, { kind: 'asset', name: 'huge.mov', tempPath: temp }), /at most 1 GB/);
  rmSync(temp);
  rmSync(big);
  assert.throws(() => store.files.putFile(join(dir, 'work/assets/a1.txt'), { maxBytes: 1 }), /at most 1 bytes/);
  assert.ok(root);
});

test('Add files stages uploads into the draft with New / Removed markers; discarded files are not saved', (t) => {
  const { store, format } = fixture(t);
  const { s, v1 } = firstVersion(store, format);
  const upload = (name, body) => { const temp = store.files.incoming(); writeFileSync(temp, body); return temp; };
  let session = store.stageDraftFile(format.id, { sessionId: s.id, kind: 'knowledge', name: 'Spec sheet.pdf', note: 'Dimensions', tempPath: upload('Spec sheet.pdf', '%PDF synthetic') });
  assert.equal(session.status, 'review');
  session = store.stageDraftFile(format.id, { sessionId: s.id, kind: 'asset', name: 'background.png', tempPath: upload('background.png', 'png bytes') });
  assert.throws(() => store.stageDraftFile(format.id, { sessionId: s.id, kind: 'knowledge', name: 'tool.exe', tempPath: upload('tool.exe', 'x') }), /knowledge can be/);
  session = store.draftFileChange(format.id, { sessionId: s.id, action: 'remove', path: 'knowledge/prices.csv' });
  assert.throws(() => store.draftFileChange(format.id, { sessionId: s.id, action: 'remove', path: 'knowledge/not-saved.csv' }), /Only files of the saved skill/);
  let p = store.proposal(s.id);
  assert.deepEqual(p.files.added.map((x) => [x.path, x.change, x.via]).sort(), [['assets/background.png', 'new', 'upload'], ['knowledge/Spec sheet.pdf', 'new', 'upload']]);
  assert.equal(p.files.added.find((x) => x.kind === 'knowledge').title, 'Spec sheet');
  assert.deepEqual(p.files.removed.map((x) => [x.path, x.change]), [['knowledge/prices.csv', 'removed']]);
  assert.equal(p.rules.length, 0, 'a files-only draft is a valid draft');
  // Take one staged file back out of the draft.
  store.draftFileChange(format.id, { sessionId: s.id, action: 'unstage', path: 'assets/background.png' });
  p = store.proposal(s.id);
  assert.deepEqual(p.files.added.map((x) => x.path), ['knowledge/Spec sheet.pdf']);
  const v2 = approveAll(store, s.id, [{ path: 'knowledge/prices.csv', action: 'discard' }]);
  const saved = store.version(v2.id);
  assert.deepEqual(saved.knowledge.map((x) => x.file).sort(), ['knowledge/Spec sheet.pdf', 'knowledge/prices.csv', 'knowledge/product-sheet.md']);
  assert.deepEqual(saved.changes.files, { added: ['knowledge/Spec sheet.pdf'], changed: [], removed: [] });
  assert.deepEqual(saved.rules, store.version(v1.id).rules, 'rules carry forward unchanged');
  // Re-listing a saved file unchanged is not a change.
  const dir = store.sessionDir(s.id);
  put(join(dir, 'work/assets/logo.svg'), '<svg>logo</svg>');
  writeDraft(store, store.get('sessions', s.id), { assets: [{ file: 'work/assets/logo.svg', note: 'Brand logo, top left.' }] });
  assert.throws(() => store.proposal(s.id), /no rule changes or file changes/);
});

test('unused files are reported with their size; delete refuses files a version still uses', (t) => {
  const { store, format } = fixture(t);
  const { v1 } = firstVersion(store, format);
  const orphan = store.files.putBuffer(Buffer.from('left over from a failed save'), { ext: '.bin' });
  const used = store.version(v1.id).assets[0].sha256;
  const report = store.fileReport();
  assert.equal(report.objects, 4);
  assert.deepEqual(report.unused.map((x) => x.sha256), [orphan.sha256]);
  assert.equal(report.unusedBytes, Buffer.byteLength('left over from a failed save'));
  assert.deepEqual(report.missing, []);
  assert.throws(() => store.deleteUnusedFiles([orphan.sha256, used]), /still used by a saved skill version, so nothing was deleted/);
  assert.ok(store.files.locate(orphan.sha256), 'nothing deleted after a refusal');
  assert.deepEqual(store.deleteUnusedFiles([orphan.sha256]), { deleted: 1, bytes: report.unusedBytes });
  assert.equal(store.files.locate(orphan.sha256), null);
  assert.ok(store.files.locate(used));
});

test('database restore lists missing skill files instead of failing; file store backup is incremental', (t) => {
  const { root, store, format } = fixture(t);
  const { v1 } = firstVersion(store, format);
  const backup = store.backup();
  const manifest = JSON.parse(readFileSync(join(backup.path, 'manifest.json'), 'utf8'));
  assert.deepEqual([manifest.skillFiles.objects, manifest.skillFiles.included], [3, false]);
  const lost = store.version(v1.id).knowledge[1];
  store.files.remove(lost.sha256);
  store.close();
  const preview = previewDatabaseRestore(root, backup.id);
  assert.deepEqual(preview.missingFiles.map((x) => [x.file, x.version, x.format]), [['knowledge/prices.csv', 1, 'Product reel']]);
  const done = restoreDatabase(root, backup.id, preview.token);
  assert.equal(done.ok, true);
  assert.match(done.note, /1 skill file is missing/);
  const reopened = new LearningStore(root);
  try {
    assert.deepEqual(reopened.fileReport().missing.map((x) => x.file), ['knowledge/prices.csv']);
    assert.throws(() => reopened.version(v1.id), /missing from the file store: knowledge\/prices\.csv/);
    // Back up the store to another folder: copies once, then skips by hash.
    const target = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-file-backup-')));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    const first = reopened.files.backupTo(target), second = reopened.files.backupTo(target);
    assert.deepEqual([first.copied, second.copied, second.skipped], [2, 0, 2]);
    assert.throws(() => reopened.files.backupTo(join(root, 'inside')), /does not exist/);
    mkdirSync(join(root, 'inside'));
    assert.throws(() => reopened.files.backupTo(join(root, 'inside')), /outside this studio/);
  } finally { reopened.close(); }
});

// ---- Migration of studios saved before the file store: asset and key-frame bytes in learning_blobs. ----

// A version exactly as the previous release stored it: blobs in SQLite, copies in the version folder.
function legacyVersion(store, format) {
  const s = conversation(store, format), ref = s.references[0].id, keyV = randomUUID(), folder = store.versionDir(keyV);
  const bodies = {
    'guide.md': '# Product reel\n\n## visuals · opening\nLegacy rule.\n',
    'SKILL.md': `---\nname: learned-${keyV}\ndescription: legacy\n---\n`,
    'assets/0-logo.svg': '<svg>legacy logo</svg>',
    [`examples/frames/${ref}/frame-000001.jpg`]: 'legacy jpeg',
  };
  const files = Object.entries(bodies).map(([file, body]) => { put(join(folder, file), body); return { file, sha256: sha(body) }; });
  const pack = { rules: [{ ...rule(s), text: 'Legacy rule.', sourceSession: s.id }], workflow: 'Legacy workflow.',
    assets: [{ file: 'assets/0-logo.svg', note: 'Legacy logo', sha256: sha(bodies['assets/0-logo.svg']) }], files,
    evidence: s.references, sourceSession: s.id, learnings: [], examples: [{ referenceId: ref, frames: [{ file: files[3].file, seconds: 0 }] }] };
  const raw = JSON.stringify(pack);
  put(join(folder, 'package.json'), raw);
  store.tx(() => {
    for (const [file, body] of Object.entries(bodies)) store.db.prepare('INSERT OR IGNORE INTO learning_blobs(hash,bytes) VALUES(?,?)').run(sha(body), Buffer.from(body));
    store.put('versions', { id: keyV, formatId: format.id, number: 1, name: 'Legacy', created: new Date().toISOString(), sha256: sha(raw), package: pack, baseVersion: null }, format.id);
    store.update('formats', { ...store.get('formats', format.id), activeVersion: keyV });
    store.db.exec('DELETE FROM file_store_meta; DELETE FROM skill_files');
  });
  return { keyV, bodies };
}
const blobCount = (store) => store.db.prepare('SELECT count(*) n FROM learning_blobs').get().n;
const backups = (root) => existsSync(join(root, '.studio/file-store-migration-backups')) ? readdirSync(join(root, '.studio/file-store-migration-backups')) : [];

test('migration: backs up first, resumes after a crash, removes blobs only when all are verified, runs twice safely', (t) => {
  const { root, store, format, profile, closeLater } = fixture(t);
  const { keyV, bodies } = legacyVersion(store, format);
  assert.equal(blobCount(store), 4);
  // Crash after the first file was written.
  assert.throws(() => store.migrateFileStore({ fault: (p) => { if (p === 'after-file-0') throw Error('simulated crash'); } }), /simulated crash/);
  assert.equal(blobCount(store), 4, 'no blob removed before every file is verified');
  assert.equal(backups(root).length, 1, 'database backed up before anything moved');
  assert.equal(store.meta('blob-migration'), 'running');
  // Crash again just before the blobs would be removed: every file is now in the store, the blobs are still there.
  assert.throws(() => store.migrateFileStore({ fault: (p) => { if (p === 'before-drop') throw Error('simulated crash'); } }), /simulated crash/);
  assert.equal(blobCount(store), 4);
  for (const file of ['assets/0-logo.svg', Object.keys(bodies)[3]]) assert.ok(store.files.locate(sha(bodies[file])), file);
  store.close();
  // Next open resumes and finishes; the backup is not repeated.
  const reopened = closeLater(new LearningStore(root));
  assert.equal(reopened.meta('blob-migration'), 'done');
  assert.equal(blobCount(reopened), 2, 'only SKILL.md and guide.md stay in SQLite');
  assert.equal(backups(root).length, 1);
  const backupDb = new DatabaseSync(join(root, '.studio/file-store-migration-backups', backups(root)[0], 'studio.sqlite'), { readOnly: true });
  try { assert.equal(backupDb.prepare('SELECT count(*) n FROM learning_blobs').get().n, 4, 'the pre-migration backup keeps every blob'); } finally { backupDb.close(); }
  // Run again: nothing to do.
  assert.deepEqual(reopened.migrateFileStore(), { moved: 0, done: true });
  reopened.db.exec('DELETE FROM file_store_meta');
  assert.deepEqual(reopened.migrateFileStore(), { moved: 0, done: true });
  assert.equal(backups(root).length, 1);
  // The legacy version folder (with its own copies) and new projections keep working.
  const v = reopened.version(keyV);
  assert.equal(readFileSync(join(v.path, 'assets/0-logo.svg'), 'utf8'), '<svg>legacy logo</svg>');
  assert.equal(reopened.formatFiles(format.id).files[0].size, Buffer.byteLength('<svg>legacy logo</svg>'));
  const skillRoot = join(root, 'projects/p1/.octopus/context/.claude/skills');
  mkdirSync(skillRoot, { recursive: true });
  const pinned = pinnedFormatSkill(reopened, { formatId: format.id, versionId: keyV, profileName: profile.name, formatName: format.name }, skillRoot);
  assert.equal(readFileSync(join(pinned.path, 'assets/0-logo.svg'), 'utf8'), '<svg>legacy logo</svg>');
  assert.equal(readFileSync(join(pinned.path, `examples/${Object.keys(bodies)[3].split('/')[2]}/frame-000001.jpg`), 'utf8'), 'legacy jpeg');
  syncSkills({ studio: root, fresh: true });
  assert.equal(readFileSync(join(root, '.claude/skills', formatSkillName(format.id), 'assets/0-logo.svg'), 'utf8'), '<svg>legacy logo</svg>');
  // A new version on top of the migrated one carries the legacy asset forward by hash.
  const s = reopened.rebase(reopened.list('sessions')[0].id, reopened.list('sessions')[0].revision);
  writeDraft(reopened, s, { rules: [rule(s, 'closing', 'End on the logo.')] });
  const v2 = approveAll(reopened, s.id);
  assert.equal(reopened.version(v2.id).assets[0].sha256, sha(bodies['assets/0-logo.svg']));
});

test('migration: an unreadable blob is left in SQLite and reported; the others move', (t) => {
  const { root, store, format } = fixture(t);
  const { bodies } = legacyVersion(store, format);
  const frame = sha(bodies[Object.keys(bodies)[3]]);
  store.db.prepare('UPDATE learning_blobs SET bytes=? WHERE hash=?').run(Buffer.from('corrupted'), frame);
  const result = store.migrateFileStore();
  assert.deepEqual(result.problems, [frame]);
  assert.equal(result.moved, 1);
  assert.equal(blobCount(store), 3);
  assert.equal(store.meta('blob-migration'), 'done');
  assert.ok(root);
});

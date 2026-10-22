// Studio-local relationships in SQLite; approved content stays in inspectable files.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';

const id = () => randomUUID();
const now = () => new Date().toISOString();
const hash = (s) => createHash('sha256').update(s).digest('hex');
const json = (v) => JSON.stringify(v);
const parse = (r) => r && JSON.parse(r.data);
const fail = (s) => { throw new Error(s); };
const text = (s, max = 200) => typeof s === 'string' && s.trim() && s.length <= max ? s.trim() : fail(`Enter text between 1 and ${max} characters.`);
const focusAreas = ['scripting','pacing','visuals','captions','sound','knowledge'];
export const FOCUS_AREAS = focusAreas;
const formatTypes = ['tutorial', 'faceless', 'short', 'explainer'];
const openStatuses = ['draft', 'review', 'interrupted', 'failed'];
const VIDEO_REFERENCE = /\.(mp4|mov|m4v|webm)$/i;
const KEY_FRAMES = 6;
// Used when a creator's direct edit starts a format's first version: the creator still reviews it before saving.
export const DEFAULT_WORKFLOW = 'Use the approved rules with the core production workflow: review the script, lock the cut, approve the scene plan, build, and stop for the final visual review before export.';
const revisionOf = (item) => item.revision || 1;
const bump = (item) => ({ ...item, revision: revisionOf(item) + 1, updated: now() });
const normalized = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
// One generated skill per format. Named from the immutable format id so a rename never breaks it.
export const formatSkillName = (formatId) => `format-${learningId(formatId).replace(/-/g, '').slice(0, 8)}`;
export const formatSkillId = (formatId) => `format.${learningId(formatId)}`;
export const learningId = (s) => typeof s === 'string' && /^[a-f0-9-]{36}$/.test(s) ? s : fail('Invalid learning ID.');
export function safeFile(root, rel) {
  const path = resolve(root, rel), r = relative(resolve(root), path);
  if (isAbsolute(rel) || !r || r.startsWith('..') || isAbsolute(r)) fail('Path is outside its learning folder.');
  const rejectLink = path => { let st; try { st=lstatSync(path); } catch(e) { if(e.code!=='ENOENT')throw e; } if(st?.isSymbolicLink())fail('Learning storage cannot use symbolic links.'); };
  let p = resolve(root);
  // Reject links in the root and every existing ancestor too, including .studio.
  for (let a = p; a !== dirname(a); a = dirname(a)) rejectLink(a);
  for (const bit of r.split(/[\\/]/)) { p = join(p, bit); rejectLink(p); }
  return path;
}
const clampTarget = (seconds) => Math.max(0, Math.min(7200, Number(seconds) || 0));
function atomic(path, data) { mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.${id()}.tmp`; writeFileSync(tmp, data, { flag: 'wx' }); renameSync(tmp, path); }
function approvedSkill(keyV, type, workflow) { return `---\nname: learned-${keyV}\ndescription: Apply this approved format only when the project explicitly pins learning version ${keyV}.\n---\n\nRead the pinned guide and project brief first. This skill applies only to version ${keyV}.\nKeep source media untouched, preserve creator overrides, lock cuts before planning/building, and review before export.\n${type === 'faceless' ? 'Use narration and appropriate visuals; do not apply talking-head zooms. Do not choose a TTS provider automatically.\n' : ''}\n${workflow}\n`; }
export class LearningStore {
  constructor(studio) {
    if (!studio || !existsSync(studio)) fail('Choose an existing studio first.');
    this.root = resolve(studio); this.dir = safeFile(this.root, '.studio/learning');
    const file = safeFile(this.root, '.studio/studio.sqlite');
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      const v = this.db.prepare('PRAGMA user_version').get().user_version;
      if (v > 1) fail('This studio uses a newer learning database. Update Video Octopus before opening it.');
      this.db.exec('CREATE TABLE IF NOT EXISTS learning_blobs(hash TEXT PRIMARY KEY, bytes BLOB NOT NULL); CREATE TABLE IF NOT EXISTS project_learning(project TEXT PRIMARY KEY, data TEXT NOT NULL)');
      // Creator chat messages in a format conversation: the provenance for instruction evidence.
      this.db.exec('CREATE TABLE IF NOT EXISTS learning_messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created TEXT NOT NULL, text TEXT NOT NULL)');
      if (!v) this.tx(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS formats(id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, format_id TEXT NOT NULL REFERENCES formats(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY, format_id TEXT NOT NULL REFERENCES formats(id), data TEXT NOT NULL);
        PRAGMA user_version=1;`));
    } catch (e) { this.db.close(); throw e; }
  }
  close() { this.db.close(); }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  get(table, key) { return parse(this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(learningId(key))) || fail('Learning item no longer exists.'); }
  list(table) { return this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(parse); }
  put(table, item, parent) {
    if (parent) this.db.prepare(`INSERT INTO ${table}(id,${table === 'formats' ? 'profile_id' : 'format_id'},data) VALUES(?,?,?)`).run(item.id, parent, json(item));
    else this.db.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?)`).run(item.id, json(item));
    return item;
  }
  update(table, item) { this.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(json(item), item.id); return item; }
  pin(project, data) { this.db.prepare('INSERT INTO project_learning(project,data) VALUES(?,?) ON CONFLICT(project) DO UPDATE SET data=excluded.data').run(project,json(data)); return data; }
  binding(project) { return parse(this.db.prepare('SELECT data FROM project_learning WHERE project=?').get(project)); }
  view() {
    return {
      profiles: this.list('profiles'),
      formats: this.list('formats').map((f) => ({ ...f, skillName: formatSkillName(f.id) })),
      sessions: this.list('sessions'),
      versions: this.list('versions').map(({ package: ignored, ...v }) => v),
    };
  }
  profile(name) { return this.put('profiles', { id: id(), name: text(name), revision: 1, created: now() }); }
  format(profileId, name, type, targetSeconds = 0) {
    const profile = this.get('profiles', profileId);
    if (profile.archived) fail('This channel is archived. Restore it before adding formats.');
    if (!formatTypes.includes(type)) fail('Choose a supported production format.');
    return this.put('formats', { id: id(), profileId, name: text(name), type, targetSeconds: clampTarget(targetSeconds), activeVersion: null, revision: 1, created: now() }, profileId);
  }

  // ---- Rename, setup changes and soft archive. Revisions catch stale edits; projects stay pinned. ----
  changeRecord(table, key, expected, label, fn) {
    return this.tx(() => {
      const item = this.get(table, key);
      if (revisionOf(item) !== expected) fail(`${label} changed. Reload before saving.`);
      fn(item);
      return this.update(table, bump(item));
    });
  }
  updateProfile(profileId, { expected, name } = {}) {
    return this.changeRecord('profiles', profileId, expected, 'This channel', (p) => {
      if (name !== undefined) p.name = text(name);
    });
  }
  archiveProfile(profileId, expected, archived = true) {
    return this.changeRecord('profiles', profileId, expected, 'This channel', (p) => {
      p.archived = Boolean(archived);
      p.archivedAt = archived ? now() : null;
    });
  }
  // Type and target length apply to future videos only: versions and pinned projects are untouched.
  updateFormat(formatId, { expected, name, type, targetSeconds } = {}) {
    return this.changeRecord('formats', formatId, expected, 'This format', (f) => {
      if (name !== undefined) f.name = text(name);
      if (type !== undefined) {
        if (!formatTypes.includes(type)) fail('Choose a supported production format.');
        f.type = type;
      }
      if (targetSeconds !== undefined) f.targetSeconds = clampTarget(targetSeconds);
    });
  }
  archiveFormat(formatId, expected, archived = true) {
    return this.changeRecord('formats', formatId, expected, 'This format', (f) => {
      if (!archived && this.get('profiles', f.profileId).archived) fail('Restore the channel before restoring its format.');
      f.archived = Boolean(archived);
      f.archivedAt = archived ? now() : null;
    });
  }
  // Archived formats, or formats of an archived channel, are hidden from New video and lose their generated skill.
  formatArchived(format) {
    return Boolean(format.archived || this.get('profiles', format.profileId).archived);
  }

  // Projects pinned to a format: from SQLite pins, newest first.
  formatVideos(formatId) {
    const format = this.get('formats', formatId);
    const numbers = new Map(this.list('versions').filter((v) => v.formatId === format.id).map((v) => [v.id, v.number]));
    const rows = new Map();
    for (const row of this.db.prepare('SELECT project, data FROM project_learning').all()) {
      const pin = JSON.parse(row.data);
      if (pin.formatId === format.id || numbers.has(pin.versionId)) rows.set(row.project, { project: row.project, versionId: pin.versionId || null, created: null });
    }
    if (this.hasTable('project_context')) {
      for (const row of this.db.prepare('SELECT project, data FROM project_context').all()) {
        const bundle = JSON.parse(row.data);
        if (bundle.formatId !== format.id) continue;
        const known = rows.get(row.project);
        rows.set(row.project, { project: row.project, versionId: known?.versionId || bundle.versionId || null, created: bundle.created || null });
      }
    }
    return [...rows.values()]
      .map((x) => ({ ...x, number: numbers.get(x.versionId) || null }))
      .sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
  }
  hasTable(name) {
    return Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
  }
  session(formatId, { name, focus, direction = '', study = 'overview', project = null } = {}) {
    const f = this.get('formats', formatId);
    const autoFocus = focus === undefined;
    if (autoFocus) focus = focusAreas;
    if (!Array.isArray(focus) || !focus.length || focus.some(x => !focusAreas.includes(x))) fail('Choose at least one learning focus.');
    if (!['overview','detailed'].includes(study)) fail('Unknown study mode.');
    const s = { id: id(), formatId, name: text(name), autoFocus, focus: [...new Set(focus)], direction: String(direction).slice(0, 12000), study, project, baseVersion: f.activeVersion, revision: 1, status: 'draft', references: [], approvedVersions: [], manualEdits: [], created: now() };
    const folder = this.sessionDir(s.id); mkdirSync(join(folder, 'work'), { recursive: true }); mkdirSync(join(folder, 'intake'), { recursive: true });
    return this.put('sessions', s, formatId);
  }
  sessionDir(key) { return safeFile(this.root, `.studio/learning/sessions/${learningId(key)}`); }
  versionDir(key) { return safeFile(this.root, `.studio/learning/versions/${learningId(key)}`); }
  change(key, rev, fn) {
    return this.tx(() => {
      const s = this.get('sessions', key);
      if (s.revision !== rev) fail('This session changed. Reload before saving.');
      if (s.status === 'approved') this.reopen(s);
      fn(s);
      s.revision++;
      s.updated = now();
      return this.update('sessions', s);
    });
  }
  // Older app versions locked a conversation once approved. It continues from the format's current skill.
  reopen(s) {
    const format = this.get('formats', s.formatId);
    s.approvedVersions = s.approvedVersions?.length ? s.approvedVersions : (s.approvedVersion ? [s.approvedVersion] : []);
    this.archiveProposal(s.id, s.approvedVersion || `legacy-${id()}`);
    s.baseVersion = format.activeVersion;
    s.status = 'draft';
  }
  // The used draft is kept beside the conversation, never deleted.
  archiveProposal(sessionId, label) {
    const draft = safeFile(this.sessionDir(sessionId), 'work/proposal.json');
    if (!existsSync(draft)) return null;
    const archived = safeFile(this.sessionDir(sessionId), `work/proposals/${label}.json`);
    mkdirSync(dirname(archived), { recursive: true });
    renameSync(draft, archived);
    return archived;
  }
  // The format moved on (another conversation saved, or History switched versions): base the draft on the current skill.
  rebase(key, rev) {
    return this.change(key, rev, (s) => {
      if (s.status === 'running') fail('Wait for the agent to finish before rebasing.');
      s.baseVersion = this.get('formats', s.formatId).activeVersion;
    });
  }
  // Creator chat messages (never app-written briefs) are kept so a rule can cite them as instruction evidence.
  recordMessage(sessionId, { id: messageId, text: message, ts } = {}) {
    this.get('sessions', sessionId);
    if (typeof messageId !== 'string' || !/^[\w-]{8,100}$/.test(messageId) || typeof message !== 'string' || !message.trim()) return false;
    const created = new Date(ts || Date.now()).toISOString();
    this.db.prepare('INSERT OR IGNORE INTO learning_messages(id, session_id, created, text) VALUES(?,?,?,?)').run(messageId, sessionId, created, message.slice(0, 40000));
    return true;
  }
  instructionMessage(sessionId, messageId) {
    if (typeof messageId !== 'string' || messageId.length > 100) return null;
    if (this.hasTable('memory_tombstones') && this.db.prepare("SELECT 1 FROM memory_tombstones WHERE kind='event' AND id=?").get(messageId)) return null;
    const row = this.db.prepare('SELECT session_id, text FROM learning_messages WHERE id=?').get(messageId);
    if (row) return row.session_id === sessionId ? row.text : null;
    // Messages from before this table existed may still be in the memory feature's capture of the same chat.
    if (!this.hasTable('memory_events')) return null;
    const memory = this.db.prepare('SELECT chat, role, text FROM memory_events WHERE id=?').get(messageId);
    return memory && memory.role === 'user' && memory.chat === `_learning_${sessionId}` ? memory.text : null;
  }
  // Rule ids whose current or past approved rules cite a reference; that reference stays with the conversation.
  citedReferences() {
    const cited = new Set();
    for (const v of this.list('versions')) {
      for (const item of [...(v.package.rules || []), ...(v.package.learnings || [])]) {
        for (const e of item.evidence || []) if (e.referenceId) cited.add(e.referenceId);
      }
    }
    return cited;
  }
  // The conversation a direct edit goes into: open, idle and based on the format's current skill.
  openConversation(formatId) {
    const format = this.get('formats', formatId);
    const candidates = this.list('sessions')
      .filter((s) => s.formatId === format.id && openStatuses.includes(s.status) && s.baseVersion === format.activeVersion)
      .sort((a, b) => String(b.updated || b.created).localeCompare(String(a.updated || a.created)));
    const hasDraft = (s) => existsSync(safeFile(this.sessionDir(s.id), 'work/proposal.json'));
    return candidates.find(hasDraft) || candidates[0] || null;
  }
  configure(key, rev, { name, direction, study } = {}) {
    return this.change(key, rev, s => {
      if (s.status === 'running') fail('Stop the study before changing its settings.');
      if (study !== undefined && !['overview','detailed'].includes(study)) fail('Unknown study mode.');
      if (direction !== undefined && (typeof direction !== 'string' || direction.length > 12000)) fail('Guidance must be text up to 12000 characters.');
      if (name !== undefined) s.name = text(name);
      if (direction !== undefined) s.direction = direction;
      if (study !== undefined) s.study = study;
    });
  }
  reference(key, rev, input) {
    return this.change(key, rev, s => {
      if (s.status === 'running') fail('Stop learning before changing references.');
      if (s.references.length >= 20) fail('Use at most 20 references per session.');
      let ref = { id: id(), name: text(input.name), kind: input.kind };
      if (input.kind === 'link') { const u = new URL(input.url); if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) fail('Use a public HTTP or HTTPS link.'); ref.url = u.href; }
      else if (input.kind === 'note') ref.note = text(input.note, 20000);
      else fail('Use upload for local files.');
      s.references.push(ref); s.status = 'draft';
    });
  }
  removeReference(key, rev, referenceId) {
    const cited = this.citedReferences();
    return this.change(key, rev, (s) => {
      if (s.status === 'running') fail('Stop the study before removing a reference.');
      if (!s.references.some((r) => r.id === referenceId)) fail('Reference not found.');
      if (cited.has(referenceId)) fail('This reference is evidence for a saved skill version, so it stays with the conversation.');
      s.references = s.references.filter((r) => r.id !== referenceId);
      s.status = 'draft';
    });
  }
  upload(key, rev, name, buffer) {
    name = text(name); if (!/\.(mp4|mov|m4v|webm|mp3|wav|m4a|ogg|flac|png|jpe?g|webp|txt|md|pdf)$/i.test(name)) fail('Choose video, audio, an image, PDF or text.');
    const rid = id(), file = `intake/${rid}${name.slice(name.lastIndexOf('.')).toLowerCase()}`;
    if (buffer.length > 512 * 1024 * 1024) fail('Reference limit is 512 MB.');
    const path = safeFile(this.sessionDir(key), file);
    try {
      return this.change(key, rev, s => { if (s.status === 'running' || s.references.length >= 20) fail('Stop learning first, and use at most 20 references.');
        atomic(path, buffer); s.references.push({ id: rid, name, kind: 'file', file, size: buffer.length, sha256: hash(buffer) }); s.status = 'draft'; });
    } catch (e) { if (existsSync(path)) rmSync(path); throw e; }
  }
  // The draft in work/proposal.json, validated against SQLite. Rules may add ("new"), replace ("changed") or
  // remove ("removed") rules of the version the draft is based on; anything else is preserved on approval.
  proposal(key) {
    const s = this.get('sessions', key), path = safeFile(this.sessionDir(key), 'work/proposal.json');
    if (!existsSync(path)) fail('No proposal yet. Ask the agent to write work/proposal.json.');
    if (lstatSync(path).size > 1024 * 1024) fail('Proposal is too large.');
    for (const ref of s.references.filter((r) => r.kind === 'file')) {
      const source = safeFile(this.sessionDir(key), ref.file);
      if (!existsSync(source) || !lstatSync(source).isFile() || hash(readFileSync(source)) !== ref.sha256) fail('A reference copy changed or is missing. Add it again and repeat the study before approval.');
    }
    const raw = readFileSync(path);
    let p;
    try { p = JSON.parse(raw); } catch { fail('The draft in work/proposal.json is not valid JSON. Ask the agent to repair it.'); }
    if (!p || typeof p !== 'object' || Array.isArray(p)) fail('The draft must be a JSON object.');
    const base = s.baseVersion ? this.version(s.baseVersion) : null;
    const baseRules = new Map((base?.rules || []).map((r) => [r.id, r]));
    const ruleInput = p.rules === undefined ? [] : p.rules;
    const removeInput = p.remove === undefined ? [] : p.remove;
    if (!Array.isArray(ruleInput) || ruleInput.length > 100) fail('Proposal needs at most 100 rules.');
    if (!Array.isArray(removeInput) || removeInput.length > 100) fail('Remove at most 100 rules in one draft.');
    const seen = new Set();
    const ruleId = (value) => {
      const key = text(value, 100);
      if (!/^[\w.-]+$/.test(key) || seen.has(key)) fail('Rule IDs must be unique simple names.');
      seen.add(key);
      return key;
    };
    const rules = ruleInput.map((r) => {
      const key = ruleId(r?.id);
      if (!s.focus.includes(r.area)) fail('Proposed rules must match the selected focus.');
      if (!['low', 'medium', 'high'].includes(r.confidence)) fail('Each rule needs a confidence.');
      const ruleText = text(r.text, 8000);
      const evidence = this.checkEvidence(s, r.evidence, 'Every rule', { ruleId: key, text: ruleText });
      const previous = baseRules.get(key);
      return { id: key, area: r.area, text: ruleText, confidence: r.confidence, evidence,
        change: previous ? 'changed' : 'new', previous: previous ? { area: previous.area, text: previous.text } : null };
    });
    const removals = removeInput.map((r) => {
      const key = ruleId(typeof r === 'string' ? r : r?.id);
      const previous = baseRules.get(key) || fail(`Rule ${key} is not in the version this draft is based on.`);
      const evidence = this.checkEvidence(s, r?.evidence, 'Every removal', { ruleId: key, remove: true });
      return { id: key, area: previous.area, text: previous.text, change: 'removed', evidence };
    });
    if (!rules.length && !removals.length) fail('The draft has no rule changes yet.');
    if (p.learnings !== undefined && (!Array.isArray(p.learnings) || p.learnings.length > 50)) fail('Use at most 50 learnings.');
    const learnings = (p.learnings || []).map((l) => ({ text: text(l?.text, 4000), evidence: this.checkEvidence(s, l?.evidence, 'Every learning') }));
    const assets = (p.assets || []).map((a) => {
      const path = safeFile(this.sessionDir(key), text(a.file, 500));
      if (!a.file.startsWith('work/assets/') || !existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).size > 20 * 1024 * 1024) fail('Assets must be regular files below work/assets, at most 20 MB each.');
      return { file: a.file, note: text(a.note, 2000), sha256: hash(readFileSync(path)) };
    });
    if (assets.length > 30) fail('Use at most 30 reusable assets.');
    // A plain-language edit may leave the workflow out: the base version's workflow carries forward.
    const workflow = p.workflow !== undefined ? text(p.workflow, 40000) : base ? base.workflow : fail('The first version needs a workflow.');
    const formatNow = this.get('formats', s.formatId);
    return { rules, removals, learnings, assets, workflow, workflowChanged: Boolean(base) && workflow !== base.workflow,
      token: hash(Buffer.concat([raw, Buffer.from(json(assets))])), revision: s.revision, baseVersion: s.baseVersion,
      baseNumber: base?.number || null, activeVersion: formatNow.activeVersion, stale: formatNow.activeVersion !== s.baseVersion };
  }
  // Evidence is a studied reference, a creator chat message (validated against stored messages) or a direct edit.
  checkEvidence(session, list, what, target = {}) {
    if (!Array.isArray(list) || !list.length || list.length > 20) fail(`${what} needs evidence from this conversation, with a timestamp/page or a specific observation.`);
    const refs = new Set(session.references.map((x) => x.id));
    return list.map((e) => {
      if (!e || typeof e !== 'object' || Array.isArray(e)) fail(`${what} needs evidence objects.`);
      const kind = e.kind || (e.referenceId !== undefined ? 'reference' : null);
      if (kind === 'reference') {
        if (!refs.has(e.referenceId) || typeof e.note !== 'string' || !e.note.trim() || e.note.length > 2000) fail(`${what} needs evidence from this session, with a timestamp/page or a specific observation.`);
        return { referenceId: e.referenceId, note: e.note };
      }
      if (kind === 'instruction') {
        const message = this.instructionMessage(session.id, e.messageId);
        if (message === null) fail('Instruction evidence must cite a creator message from this conversation by its message ID.');
        if (typeof e.quote !== 'string' || !e.quote.trim() || e.quote.length > 1000) fail('Instruction evidence needs a short quote of the creator message.');
        if (!normalized(message).includes(normalized(e.quote))) fail('The quoted instruction does not appear in the cited creator message.');
        return { kind: 'instruction', messageId: e.messageId, quote: e.quote.trim() };
      }
      if (kind === 'manual') {
        const edit = (session.manualEdits || []).find((m) => m.id === e.editId);
        if (!edit || edit.ruleId !== target.ruleId || Boolean(edit.remove) !== Boolean(target.remove) || (!edit.remove && edit.text !== target.text)) {
          fail('Edited-by-creator evidence must match a direct edit made in Video formats.');
        }
        return { kind: 'manual', editId: edit.id, note: 'Edited by creator' };
      }
      return fail('Evidence must be a reference, a creator instruction or a direct edit.');
    });
  }
  // A direct creator edit (pencil). It lands in a conversation draft; it is still reviewed and saved as a new version.
  draftRule(formatId, { sessionId, revision, ruleId, area, text: ruleText, remove = false } = {}) {
    const format = this.get('formats', formatId);
    let s = sessionId ? this.get('sessions', sessionId) : this.openConversation(format.id);
    if (s && s.formatId !== format.id) fail('That conversation belongs to another format.');
    if (s && sessionId && revision !== undefined && s.revision !== revision) fail('This session changed. Reload before saving.');
    if (!s) s = this.session(format.id, { name: `Edits to ${format.name}`.slice(0, 200) });
    if (s.status === 'running') fail('Wait for the agent to finish before editing the draft.');
    const base = s.status === 'approved' ? (format.activeVersion ? this.version(format.activeVersion) : null) : (s.baseVersion ? this.version(s.baseVersion) : null);
    const key = ruleId === undefined || ruleId === null || ruleId === '' ? `rule-${id().slice(0, 8)}` : text(ruleId, 100);
    if (!/^[\w.-]+$/.test(key)) fail('Rule IDs must be simple names.');
    const path = safeFile(this.sessionDir(s.id), 'work/proposal.json');
    let draft = {};
    if (existsSync(path) && s.status !== 'approved') {
      try { draft = JSON.parse(readFileSync(path)); } catch { fail('The current draft is not valid JSON. Ask the agent to repair it first.'); }
      if (!draft || typeof draft !== 'object' || Array.isArray(draft)) fail('The current draft must be a JSON object.');
    }
    const edit = { id: id(), ruleId: key, remove: Boolean(remove), created: now() };
    if (remove) {
      if (!base?.rules.some((r) => r.id === key)) fail('Only rules of the saved skill can be removed.');
    } else {
      if (!focusAreas.includes(area)) fail('Choose a rule area.');
      edit.area = area;
      edit.text = text(ruleText, 8000);
    }
    const evidence = [{ kind: 'manual', editId: edit.id, note: 'Edited by creator' }];
    draft.rules = (Array.isArray(draft.rules) ? draft.rules : []).filter((r) => r?.id !== key);
    draft.remove = (Array.isArray(draft.remove) ? draft.remove : []).filter((r) => (typeof r === 'string' ? r : r?.id) !== key);
    if (remove) draft.remove.push({ id: key, evidence });
    else draft.rules.push({ id: key, area, text: edit.text, confidence: 'high', evidence });
    if (!draft.remove.length) delete draft.remove;
    if (!base && draft.workflow === undefined) draft.workflow = DEFAULT_WORKFLOW;
    return this.change(s.id, s.revision, (x) => {
      if (!remove && !x.focus.includes(area)) x.focus.push(area);
      x.manualEdits = [...(x.manualEdits || []), edit].slice(-200);
      x.status = 'review';
      atomic(path, JSON.stringify(draft, null, 2));
    });
  }
  version(key) {
    const v = this.get('versions', key), folder = this.versionDir(key);
    const raw = json(v.package); if (hash(raw) !== v.sha256) fail('The approved database package failed integrity verification.');
    const p = v.package;
    for (const a of p.files) {
      const f = safeFile(folder, a.file), bytes = this.db.prepare('SELECT bytes FROM learning_blobs WHERE hash=?').get(a.sha256)?.bytes;
      if (!bytes || hash(bytes) !== a.sha256) fail('Approved database content failed integrity verification.');
      if (!existsSync(f)) atomic(f, bytes);
      else if (!lstatSync(f).isFile() || hash(readFileSync(f)) !== a.sha256) fail(`Approved file changed: ${a.file}. Use Restore generated files before reuse; edits belong in a new proposal.`);
    }
    const file = safeFile(folder, 'package.json');
    if (!existsSync(file)) atomic(file, raw);
    else if (hash(readFileSync(file)) !== v.sha256) fail('Generated package was edited. Restore generated files before reuse.');
    return { ...v, package: undefined, ...p, path: folder };
  }
  regenerateVersion(key) {
    this.get('versions',key);
    const folder=this.versionDir(key);
    if(existsSync(folder)) renameSync(folder, `${folder}.edited-${id()}`);
    return this.version(key);
  }
  // Saves the reviewed draft as the format's next immutable version. The conversation stays open afterwards.
  approve(key, { revision, token, decisions, deletedRules = [] }) {
    const s = this.get('sessions', key), p = this.proposal(key), f = this.get('formats', s.formatId);
    if (s.status === 'running') fail('Finish or stop the study before approval.');
    if (s.status === 'approved') fail('This draft was already saved. Send a message to continue the conversation.');
    if (p.token !== token || s.revision !== revision) fail('The proposal changed. Review it again.');
    if (f.activeVersion !== s.baseVersion) {
      const active = f.activeVersion ? this.get('versions', f.activeVersion) : null;
      const error = new Error(`The active format changed since this draft started${active ? ` (it is now v${active.number})` : ''}. Rebase the draft onto the current version, check it, then save again.`);
      error.status = 409;
      throw error;
    }
    const reviewed = [...p.rules, ...p.removals];
    if (!Array.isArray(decisions) || decisions.length !== reviewed.length || new Set(decisions.map((x) => x?.id)).size !== reviewed.length) fail('Review every proposed rule.');
    const decisionFor = (item) => {
      const d = decisions.find((x) => x.id === item.id);
      const allowed = item.change === 'removed' ? ['keep', 'discard'] : ['keep', 'edit', 'discard'];
      if (!d || !allowed.includes(d.action)) fail('Review every proposed rule.');
      return d;
    };
    const old = f.activeVersion ? this.version(f.activeVersion) : { rules: [], assets: [], learnings: [] };
    const rules = new Map(old.rules.map((r) => [r.id, r]));
    if (!Array.isArray(deletedRules) || deletedRules.some((x) => !rules.has(x))) fail('Only existing rules can be explicitly removed.');
    for (const d of deletedRules) rules.delete(d);
    for (const r of p.removals) if (decisionFor(r).action === 'keep') rules.delete(r.id);
    for (const r of p.rules) {
      const d = decisionFor(r);
      if (d.action === 'discard') continue;
      rules.set(r.id, { id: r.id, area: r.area, text: d.action === 'edit' ? text(d.text, 8000) : r.text, confidence: r.confidence, evidence: r.evidence, sourceSession: s.id });
    }
    if (!rules.size) fail('Keep at least one rule.');
    const keyV = id(), folder = this.versionDir(keyV), staging = `${folder}.staging`;
    const learnings = [...(old.learnings || []), ...p.learnings.map((l) => ({ ...l, sourceSession: s.id, versionId: keyV }))];
    let archived = null;
    mkdirSync(staging, { recursive: true });
    try {
      const guide = `# ${f.name}\n\n${[...rules.values()].map(r=>`## ${r.area} · ${r.id}\n${r.text}\n`).join('\n')}`;
      atomic(join(staging, 'guide.md'), guide);
      atomic(join(staging, 'SKILL.md'), approvedSkill(keyV, f.type, p.workflow));
      const assets = [];
      for (const [i, a] of p.assets.entries()) {
        const file = `assets/${i}-${a.file.split('/').pop()}`, target = safeFile(staging, file);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(safeFile(this.sessionDir(key), a.file), target);
        assets.push({ ...a, file });
      }
      // Carry prior approved assets forward when the study supplies no replacement collection.
      if (!p.assets.length && old.path) {
        for (const a of old.assets) {
          const target = safeFile(staging, a.file);
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(safeFile(old.path, a.file), target);
          assets.push(a);
        }
      }
      const examples = this.stageKeyFrames(s, staging);
      const files = ['guide.md', 'SKILL.md', ...assets.map((a) => a.file), ...examples.flatMap((x) => x.frames.map((fr) => fr.file))]
        .map((file) => ({ file, sha256: hash(readFileSync(safeFile(staging, file))) }));
      const changes = { new: p.rules.filter((r) => r.change === 'new' && rules.has(r.id)).map((r) => r.id),
        changed: p.rules.filter((r) => r.change === 'changed' && rules.has(r.id)).map((r) => r.id),
        removed: old.rules.map((r) => r.id).filter((x) => !rules.has(x)) };
      const pack = { rules: [...rules.values()], workflow: p.workflow, assets, files, evidence: s.references, sourceSession: s.id, learnings, examples, changes };
      const raw = json(pack);
      atomic(join(staging, 'package.json'), raw);
      const v = { id: keyV, formatId: f.id, number: this.list('versions').filter(x => x.formatId === f.id).length + 1, name: s.name, created: now(), sha256: hash(raw), package: pack, baseVersion: f.activeVersion };
      renameSync(staging, folder);
      archived = this.archiveProposal(s.id, keyV);
      return this.tx(() => {
        const current = this.get('sessions', key), fmt = this.get('formats', f.id);
        if (current.revision !== revision || fmt.activeVersion !== s.baseVersion) fail('Another approval won. Reload before continuing.');
        for (const file of files) this.db.prepare('INSERT OR IGNORE INTO learning_blobs(hash,bytes) VALUES(?,?)').run(file.sha256, readFileSync(safeFile(folder, file.file)));
        this.put('versions', v, f.id);
        this.update('formats', bump({ ...fmt, activeVersion: keyV }));
        // The conversation continues: the next draft builds on the version just saved.
        this.update('sessions', { ...current, status: 'draft', approvedVersion: keyV,
          approvedVersions: [...(current.approvedVersions || (current.approvedVersion ? [current.approvedVersion] : [])), keyV],
          baseVersion: keyV, revision: revision + 1, updated: now() });
        return { ...v, package: undefined };
      });
    } catch (e) {
      if (archived && existsSync(archived) && !existsSync(safeFile(this.sessionDir(key), 'work/proposal.json'))) renameSync(archived, safeFile(this.sessionDir(key), 'work/proposal.json'));
      rmSync(staging, { recursive: true, force: true });
      rmSync(folder, { recursive: true, force: true });
      throw e;
    }
  }
  // Up to six evenly spaced extraction frames per studied video reference; the original stays in the intake folder.
  stageKeyFrames(session, staging) {
    const examples = [];
    for (const ref of session.references) {
      if (ref.kind !== 'file' || !VIDEO_REFERENCE.test(ref.name)) continue;
      const dir = safeFile(this.sessionDir(session.id), `work/frames/${learningId(ref.id)}`);
      if (!existsSync(dir)) continue;
      const names = readdirSync(dir).filter((x) => /^frame-\d+\.jpg$/.test(x)).sort();
      if (!names.length) continue;
      let fps = null;
      try { fps = Number(JSON.parse(readFileSync(safeFile(dir, 'coverage.json'))).fps) || null; } catch {}
      const picks = [...new Set(Array.from({ length: Math.min(KEY_FRAMES, names.length) }, (_, i) =>
        names[Math.round(i * (names.length - 1) / Math.max(1, Math.min(KEY_FRAMES, names.length) - 1))]))];
      const frames = [];
      for (const name of picks) {
        const source = safeFile(dir, name);
        if (!lstatSync(source).isFile() || lstatSync(source).size > 2 * 1024 * 1024) continue;
        const file = `examples/frames/${ref.id}/${name}`, target = safeFile(staging, file);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
        const index = Number(/\d+/.exec(name)[0]);
        frames.push({ file, seconds: fps ? Math.round(((index - 1) / fps) * 10) / 10 : null });
      }
      if (frames.length) examples.push({ referenceId: ref.id, frames });
    }
    return examples;
  }
  copyFormat(sourceId, { profileId, name, expected, reviewed } = {}) {
    if (reviewed !== true) fail('Review the approved guide before copying it.');
    const source = this.get('formats', sourceId), destination = this.get('profiles', profileId);
    if (destination.archived) fail('This channel is archived. Restore it before copying formats into it.');
    if (!source.activeVersion || expected !== source.activeVersion) fail('The source format changed. Review its approved version again.');
    const original = this.version(expected), sourceProfile = this.get('profiles', source.profileId);
    const keyF = id(), keyV = id(), folder = this.versionDir(keyV), staging = `${folder}.staging`;
    const copiedFrom = { profileId: source.profileId, formatId: source.id, versionId: original.id,
      profileName: sourceProfile.name, formatName: source.name, number: original.number };
    const format = { id: keyF, profileId: destination.id, name: text(name), type: source.type,
      targetSeconds: source.targetSeconds, skillIds: [...(source.skillIds || [])],
      activeVersion: keyV, revision: 1, created: now(), copiedFrom };
    const rules = structuredClone(original.rules), assets = structuredClone(original.assets);
    const carried = original.files.map((x) => x.file).filter((file) => file !== 'guide.md' && file !== 'SKILL.md');
    mkdirSync(staging, { recursive: true });
    try {
      atomic(join(staging, 'guide.md'), `# ${format.name}\n\n${rules.map(r=>`## ${r.area} · ${r.id}\n${r.text}\n`).join('\n')}`);
      atomic(join(staging, 'SKILL.md'), approvedSkill(keyV, format.type, original.workflow));
      // Assets and key frames are copied byte for byte.
      for (const file of carried) {
        const target = safeFile(staging, file); mkdirSync(dirname(target), { recursive: true });
        copyFileSync(safeFile(original.path, file), target);
      }
      const files = ['guide.md', 'SKILL.md', ...carried].map(file=>({file,sha256:hash(readFileSync(safeFile(staging,file)))}));
      // Evidence points back to the retained original study. No draft sessions or profile brand are copied.
      const pack = { rules, workflow: original.workflow, assets, files,
        evidence: structuredClone(original.evidence), sourceSession: original.sourceSession, copiedFrom,
        learnings: structuredClone(original.learnings || []), examples: structuredClone(original.examples || []) };
      const raw = json(pack); atomic(join(staging, 'package.json'), raw);
      const version = { id: keyV, formatId: keyF, number: 1, name: `Copied: ${format.name}`,
        created: now(), sha256: hash(raw), package: pack, baseVersion: null, copiedFrom };
      renameSync(staging, folder);
      return this.tx(() => {
        if (this.get('formats', sourceId).activeVersion !== expected) fail('The source format changed. Review it again.');
        this.get('profiles', profileId);
        for (const file of files) this.db.prepare('INSERT OR IGNORE INTO learning_blobs(hash,bytes) VALUES(?,?)').run(file.sha256,readFileSync(safeFile(folder,file.file)));
        this.put('formats', format, profileId); this.put('versions', version, keyF);
        return format;
      });
    } catch (e) { rmSync(staging,{recursive:true,force:true}); rmSync(folder,{recursive:true,force:true}); throw e; }
  }
  activate(formatId, versionId, expected) {
    this.version(versionId);
    return this.tx(() => {
      const f = this.get('formats', formatId), v = this.get('versions', versionId);
      if (v.formatId !== f.id || f.activeVersion !== expected) fail('Format changed. Reload and review before switching versions.');
      return this.update('formats', bump({ ...f, activeVersion: versionId }));
    });
  }
  // Consistent local recovery bundle. Files are immutable during this synchronous operation.
  backup() {
    const key = id(), dest = safeFile(this.root, `.studio/learning-backups/${key}`); mkdirSync(dest,{recursive:true});
    try {
      for (const v of this.list('versions')) { this.version(v.id); const folder=join(dest,'versions',v.id); mkdirSync(folder,{recursive:true}); const copy=(src,out)=>{ for(const e of readdirSync(src,{withFileTypes:true})) { const p=safeFile(src,e.name),q=join(out,e.name); if(e.isDirectory()){mkdirSync(q,{recursive:true});copy(p,q);} else if(e.isFile())copyFileSync(p,q); else fail('Unsupported backup file.'); } }; copy(this.versionDir(v.id),folder); }
      this.db.exec(`VACUUM INTO '${join(dest,'studio.sqlite').replaceAll("'","''")}'`);
      atomic(join(dest,'manifest.json'),json({schema:1,created:now(),profiles:this.list('profiles').length,versions:this.list('versions').length,sounds:this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sound_assets'").get()?this.db.prepare('SELECT count(*) n FROM sound_assets').get().n:0}));
      return { id:key, path:dest };
    } catch(e){rmSync(dest,{recursive:true,force:true});throw e;}
  }
}

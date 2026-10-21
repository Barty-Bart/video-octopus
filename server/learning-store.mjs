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
function atomic(path, data) { mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.${id()}.tmp`; writeFileSync(tmp, data, { flag: 'wx' }); renameSync(tmp, path); }
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
  view() { return { profiles: this.list('profiles'), formats: this.list('formats'), sessions: this.list('sessions'), versions: this.list('versions').map(({package: ignored, ...v})=>v) }; }
  profile(name) { return this.put('profiles', { id: id(), name: text(name), created: now() }); }
  format(profileId, name, type, targetSeconds = 0) {
    this.get('profiles', profileId);
    if (!['tutorial', 'faceless', 'short', 'explainer'].includes(type)) fail('Choose a supported production format.');
    return this.put('formats', { id: id(), profileId, name: text(name), type, targetSeconds: Math.max(0, Math.min(7200, Number(targetSeconds) || 0)), activeVersion: null, created: now() }, profileId);
  }
  session(formatId, { name, focus, direction = '', study = 'overview', project = null } = {}) {
    const f = this.get('formats', formatId);
    if (!Array.isArray(focus) || !focus.length || focus.some(x => !['scripting','pacing','visuals','captions','sound','knowledge'].includes(x))) fail('Choose at least one learning focus.');
    if (!['overview','detailed'].includes(study)) fail('Unknown study mode.');
    const s = { id: id(), formatId, name: text(name), focus: [...new Set(focus)], direction: String(direction).slice(0, 12000), study, project, baseVersion: f.activeVersion, revision: 1, status: 'draft', references: [], created: now() };
    const folder = this.sessionDir(s.id); mkdirSync(join(folder, 'work'), { recursive: true }); mkdirSync(join(folder, 'intake'), { recursive: true });
    return this.put('sessions', s, formatId);
  }
  sessionDir(key) { return safeFile(this.root, `.studio/learning/sessions/${learningId(key)}`); }
  versionDir(key) { return safeFile(this.root, `.studio/learning/versions/${learningId(key)}`); }
  change(key, rev, fn) {
    return this.tx(() => { const s = this.get('sessions', key); if (s.revision !== rev) fail('This session changed. Reload before saving.'); if (s.status === 'approved') fail('Approved sessions are retained. Start another learning session.'); fn(s); s.revision++; s.updated = now(); return this.update('sessions', s); });
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
  removeReference(key,rev,referenceId){return this.change(key,rev,s=>{if(s.status==='running')fail('Stop the study before removing a reference.');if(!s.references.some(r=>r.id===referenceId))fail('Reference not found.');s.references=s.references.filter(r=>r.id!==referenceId);s.status='draft';});}
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
  proposal(key) {
    const s = this.get('sessions', key), path = safeFile(this.sessionDir(key), 'work/proposal.json');
    if (!existsSync(path)) fail('No proposal yet. Ask the agent to write work/proposal.json.');
    if (lstatSync(path).size > 1024 * 1024) fail('Proposal is too large.');
    for(const ref of s.references.filter(r=>r.kind==='file')){const source=safeFile(this.sessionDir(key),ref.file);if(!existsSync(source)||!lstatSync(source).isFile()||hash(readFileSync(source))!==ref.sha256)fail('A reference copy changed or is missing. Add it again and repeat the study before approval.');}
    const raw = readFileSync(path), p = JSON.parse(raw);
    if (!Array.isArray(p.rules) || p.rules.length > 100) fail('Proposal needs at most 100 rules.');
    const seen = new Set(), refs = new Set(s.references.map(x => x.id));
    const rules = p.rules.map(r => {
      const key = text(r.id, 100); if (!/^[\w.-]+$/.test(key) || seen.has(key)) fail('Rule IDs must be unique simple names.'); seen.add(key);
      if (!s.focus.includes(r.area)) fail('Proposed rules must match the selected focus.');
      if (!['low','medium','high'].includes(r.confidence)) fail('Each rule needs a confidence.');
      if (!Array.isArray(r.evidence) || !r.evidence.length || r.evidence.some(e => !refs.has(e.referenceId) || typeof e.note !== 'string' || !e.note.trim() || e.note.length > 2000)) fail('Every rule needs evidence from this session, with a timestamp/page or a specific observation.');
      return { id: key, area: r.area, text: text(r.text, 8000), confidence: r.confidence, evidence: r.evidence };
    });
    const assets = (p.assets || []).map(a => { const path = safeFile(this.sessionDir(key), text(a.file, 500)); if (!a.file.startsWith('work/assets/') || !existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).size > 20 * 1024 * 1024) fail('Assets must be regular files below work/assets, at most 20 MB each.'); return { file: a.file, note: text(a.note, 2000), sha256: hash(readFileSync(path)) }; });
    if (assets.length > 30) fail('Use at most 30 reusable assets.');
    const workflow = text(p.workflow, 40000);
    return { rules, assets, workflow, token: hash(Buffer.concat([raw, Buffer.from(json(assets))])), revision: s.revision, baseVersion: s.baseVersion };
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
  approve(key, { revision, token, decisions, deletedRules = [] }) {
    const s = this.get('sessions', key), p = this.proposal(key), f = this.get('formats', s.formatId);
    if (s.status === 'running' || s.status === 'approved') fail('Finish or stop the study before approval.');
    if (p.token !== token || s.revision !== revision) fail('The proposal changed. Review it again.');
    if (f.activeVersion !== s.baseVersion) fail('The active format changed. Start a new session against its current version.');
    if (!Array.isArray(decisions) || decisions.length !== p.rules.length || new Set(decisions.map(x=>x.id)).size !== p.rules.length) fail('Review every proposed rule.');
    const old = f.activeVersion ? this.version(f.activeVersion) : { rules: [], assets: [] };
    const rules = new Map(old.rules.map(r => [r.id, r]));
    if (!Array.isArray(deletedRules) || deletedRules.some(x => !rules.has(x))) fail('Only existing rules can be explicitly removed.');
    for (const d of deletedRules) rules.delete(d);
    for (const r of p.rules) { const d = decisions.find(x => x.id === r.id); if (!d || !['keep','edit','discard'].includes(d.action)) fail('Review every proposed rule.'); if (d.action !== 'discard') rules.set(r.id, { ...r, text: d.action === 'edit' ? text(d.text, 8000) : r.text, sourceSession: s.id }); }
    if (!rules.size) fail('Keep at least one rule.');
    const keyV = id(), folder = this.versionDir(keyV), staging = `${folder}.staging`;
    mkdirSync(staging, { recursive: true });
    try {
      const guide = `# ${f.name}\n\n${[...rules.values()].map(r=>`## ${r.area} · ${r.id}\n${r.text}\n`).join('\n')}`;
      const skill = `---\nname: learned-${keyV}\ndescription: Apply this approved format only when the project explicitly pins learning version ${keyV}.\n---\n\nRead the pinned guide and project brief first. This skill applies only to version ${keyV}.\nKeep source media untouched, preserve creator overrides, lock cuts before planning/building, and review before export.\n${f.type === 'faceless' ? 'Use narration and appropriate visuals; do not apply talking-head zooms. Do not choose a TTS provider automatically.\n' : ''}\n${p.workflow}\n`;
      atomic(join(staging, 'guide.md'), guide); atomic(join(staging, 'SKILL.md'), skill);
      const assets = [];
      for (const [i,a] of p.assets.entries()) { const file = `assets/${i}-${a.file.split('/').pop()}`; const target = safeFile(staging, file); mkdirSync(dirname(target), { recursive: true }); copyFileSync(safeFile(this.sessionDir(key),a.file),target); assets.push({ ...a, file }); }
      // Carry prior approved assets forward when the study supplies no replacement collection.
      if (!p.assets.length && old.path) for (const a of old.assets) { const target = safeFile(staging,a.file); mkdirSync(dirname(target),{recursive:true}); copyFileSync(safeFile(old.path,a.file),target); assets.push(a); }
      const files = ['guide.md','SKILL.md', ...assets.map(a=>a.file)].map(file=>({file,sha256:hash(readFileSync(safeFile(staging,file)))}));
      const pack = { rules: [...rules.values()], workflow: p.workflow, assets, files, evidence: s.references, sourceSession: s.id };
      const raw = json(pack); atomic(join(staging,'package.json'),raw);
      const v = { id: keyV, formatId: f.id, number: this.list('versions').filter(x=>x.formatId===f.id).length+1, name: s.name, created: now(), sha256: hash(raw), package: pack, baseVersion: f.activeVersion };
      renameSync(staging,folder);
      return this.tx(() => {
        const current = this.get('sessions',key), fmt = this.get('formats',f.id);
        if (current.revision !== revision || fmt.activeVersion !== s.baseVersion) fail('Another approval won. Reload before continuing.');
        for (const file of files) this.db.prepare('INSERT OR IGNORE INTO learning_blobs(hash,bytes) VALUES(?,?)').run(file.sha256,readFileSync(safeFile(folder,file.file)));
        this.put('versions',v,f.id); this.update('formats',{...fmt,activeVersion:keyV}); this.update('sessions',{...current,status:'approved',approvedVersion:keyV,revision:revision+1,updated:now()}); return { ...v, package: undefined };
      });
    } catch(e) { rmSync(staging,{recursive:true,force:true}); rmSync(folder,{recursive:true,force:true}); throw e; }
  }
  activate(formatId, versionId, expected) { this.version(versionId); return this.tx(()=>{ const f=this.get('formats',formatId),v=this.get('versions',versionId); if(v.formatId!==f.id || f.activeVersion!==expected) fail('Format changed. Reload and review before switching versions.'); return this.update('formats',{...f,activeVersion:versionId}); }); }
  // Consistent local recovery bundle. Files are immutable during this synchronous operation.
  backup() {
    const key = id(), dest = safeFile(this.root, `.studio/learning-backups/${key}`); mkdirSync(dest,{recursive:true});
    try {
      for (const v of this.list('versions')) { this.version(v.id); const folder=join(dest,'versions',v.id); mkdirSync(folder,{recursive:true}); const copy=(src,out)=>{ for(const e of readdirSync(src,{withFileTypes:true})) { const p=safeFile(src,e.name),q=join(out,e.name); if(e.isDirectory()){mkdirSync(q,{recursive:true});copy(p,q);} else if(e.isFile())copyFileSync(p,q); else fail('Unsupported backup file.'); } }; copy(this.versionDir(v.id),folder); }
      this.db.exec(`VACUUM INTO '${join(dest,'studio.sqlite').replaceAll("'","''")}'`);
      atomic(join(dest,'manifest.json'),json({schema:1,created:now(),profiles:this.list('profiles').length,versions:this.list('versions').length}));
      return { id:key, path:dest };
    } catch(e){rmSync(dest,{recursive:true,force:true});throw e;}
  }
}

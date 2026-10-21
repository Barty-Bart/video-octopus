// SQLite owns skill state and versioned bytes. Files on disk are editable projections.
// Importing performs no IO. No settings, credentials or agent processes are consulted.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, readdirSync, chmodSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
const roots=['.claude/skills','skills/overrides','skills/custom'];
const sha=b=>createHash('sha256').update(b).digest('hex');
function safe(root,rel) {
  const p=resolve(root,rel);if(p!==resolve(root)&&!p.startsWith(resolve(root)+sep))throw Error('Skill database path escapes its root.');
  for(let q=p;;q=dirname(q)){let st;try{st=lstatSync(q);}catch(e){if(e.code!=='ENOENT')throw e;}if(st?.isSymbolicLink())throw Error('Skill database cannot use symbolic links.');if(q===dirname(q))break;}return p;
}
function dbFor(studio,create=false) {
  const p=safe(studio,'.studio/studio.sqlite');if(!create&&!existsSync(p))return null;
  mkdirSync(dirname(p),{recursive:true});const db=new DatabaseSync(p);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    if(db.prepare('PRAGMA user_version').get().user_version>1)throw Error('Newer studio database: update the app before changing skills.');
    if(create)db.exec(`
      CREATE TABLE IF NOT EXISTS skill_blobs(hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS skill_snapshots(id TEXT PRIMARY KEY, created TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL, files TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skill_head(singleton INTEGER PRIMARY KEY CHECK(singleton=1), snapshot TEXT NOT NULL REFERENCES skill_snapshots(id));
    `);
    else if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_head'").get()){db.close();return null;}
    return db;
  }catch(e){db.close();throw e;}
}
export function sqlSkillState(studio) {const db=dbFor(studio);if(!db)return null;try{const r=db.prepare('SELECT state FROM skill_snapshots WHERE id=(SELECT snapshot FROM skill_head WHERE singleton=1)').get();return r?JSON.parse(r.state):null;}finally{db.close();}}
export function saveSkillSnapshot(studio,state,reason) {
  const db=dbFor(studio,true);const files=[];let size=0;
  try{
    db.exec('BEGIN IMMEDIATE');
    for(const root of roots){const base=safe(studio,root); const walk=dir=>{if(!existsSync(dir))return;for(const name of readdirSync(dir).sort()){const p=safe(dir,name),st=lstatSync(p);if(st.isDirectory())walk(p);else if(st.isFile()){if(name==='.DS_Store')continue;const bytes=readFileSync(p);size+=bytes.length;if(files.length>=30000||size>384*1024*1024)throw Error('Skill database import exceeds 384 MB / 30,000 files.');const hash=sha(bytes);db.prepare('INSERT OR IGNORE INTO skill_blobs(hash,bytes) VALUES(?,?)').run(hash,bytes);files.push({path:relative(studio,p).split(sep).join('/'),hash,mode:st.mode&0o777});}else throw Error('Unsupported skill file.');}};walk(base);}
    db.prepare('INSERT INTO skill_snapshots(id,created,reason,state,files) VALUES(?,?,?,?,?)').run(state.transaction,new Date().toISOString(),reason,JSON.stringify(state),JSON.stringify(files));
    db.prepare('INSERT INTO skill_head(singleton,snapshot) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET snapshot=excluded.snapshot').run(state.transaction);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}finally{db.close();}
}
export function sqlSkillHistory(studio) {const db=dbFor(studio);if(!db)return [];try{return db.prepare('SELECT id,created,reason FROM skill_snapshots ORDER BY rowid DESC LIMIT 50').all();}finally{db.close();}}
export function sqlSkillContent(studio,id) {
  const db=dbFor(studio);if(!db)throw Error('Refresh skills to migrate them into SQLite.');try{
    const row=db.prepare('SELECT * FROM skill_snapshots WHERE id=(SELECT snapshot FROM skill_head WHERE singleton=1)').get();const state=JSON.parse(row.state),e=state.entries[id];if(!e)throw Error('Skill not found.');
    const path=e.mode==='custom'?`skills/custom/${e.folder}/SKILL.md`:e.forkAvailable?`skills/overrides/${e.folder||e.id}/SKILL.md`:`.claude/skills/${e.published?.folder}/SKILL.md`;
    const file=JSON.parse(row.files).find(f=>f.path===path);if(!file)throw Error('No saved skill text.');const bytes=db.prepare('SELECT bytes FROM skill_blobs WHERE hash=?').get(file.hash)?.bytes;
    if(!bytes||sha(bytes)!==file.hash)throw Error('Skill content failed integrity verification. Restore a database backup.');
    return {id,name:e.name,kind:e.mode==='custom'?'personal':e.mode==='override'?'customized-core':'core',summary:e.summary || '',text:Buffer.from(bytes).toString('utf8'),revision:state.revision,history:sqlSkillHistory(studio)};
  }finally{db.close();}
}
// Materialize only into fresh staging directories; callers publish under their existing journal lock.
export function stageSqlSkills(studio,destinations,snapshot=null) {
  const db=dbFor(studio);if(!db)throw Error('No database snapshot exists.');try{
    const row=snapshot?db.prepare('SELECT * FROM skill_snapshots WHERE id=?').get(snapshot):db.prepare('SELECT * FROM skill_snapshots WHERE id=(SELECT snapshot FROM skill_head WHERE singleton=1)').get();
    if(!row)throw Error('Skill snapshot not found.');
    for(const f of JSON.parse(row.files)){
      const index=roots.findIndex(r=>f.path.startsWith(r+'/'));if(index<0)throw Error('Invalid skill snapshot path.');
      const path=safe(destinations[index],f.path.slice(roots[index].length+1)),b=db.prepare('SELECT bytes FROM skill_blobs WHERE hash=?').get(f.hash)?.bytes;
      if(!b||sha(b)!==f.hash)throw Error('Skill content failed integrity verification.');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,b,{flag:'wx'});chmodSync(path,f.mode);
    }return JSON.parse(row.state);
  }finally{db.close();}
}

// Summarize approved package metadata rather than exposing its internal version id on a card.
export function sqlLearnedSkillSummary(studio, name) {
  if (!/^learned-[a-f0-9-]{36}$/.test(name || '')) return null;
  const db=dbFor(studio);if(!db)return null;
  try {
    if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='versions'").get())return null;
    const row=db.prepare('SELECT data FROM versions WHERE id=?').get(name.slice(8));if(!row)return null;
    const pack=JSON.parse(row.data).package,areas=[...new Set(pack.rules.map(r=>r.area))].join(', ');
    return `Approved ${areas || 'format'} guidance: ${pack.rules.length} rule${pack.rules.length===1?'':'s'}, a reusable workflow and ${pack.assets.length} asset${pack.assets.length===1?'':'s'}. Used by projects pinned to this version.`.slice(0,320);
  } finally {db.close();}
}

// Rebuild a project's selected publication from its pinned database snapshot.
export function sqlSelectedSkills(studio,snapshot,ids,dest){
 const db=dbFor(studio);if(!db)throw Error('Skill database missing.');
 try{const row=db.prepare('SELECT state,files FROM skill_snapshots WHERE id=?').get(snapshot);if(!row)throw Error('Pinned skill version is missing.');const state=JSON.parse(row.state),folders=ids.map(id=>{const e=state.entries[id];if(!e?.published||e.disabled)throw Error('Pinned skill was not available.');return e.published.folder;});
 for(const f of JSON.parse(row.files)){const folder=folders.find(n=>f.path.startsWith(`.claude/skills/${n}/`));if(!folder)continue;const p=safe(dest,f.path.slice('.claude/skills/'.length)),bytes=db.prepare('SELECT bytes FROM skill_blobs WHERE hash=?').get(f.hash)?.bytes;if(!bytes||sha(bytes)!==f.hash)throw Error('Pinned skill integrity verification failed.');if(existsSync(p)){if(sha(readFileSync(p))!==f.hash)throw Error('Generated project skills changed. Restore project context files.');}else{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,bytes,{flag:'wx'});chmodSync(p,f.mode);}}
 mkdirSync(dest,{recursive:true});return dest;
 }finally{db.close();}
}

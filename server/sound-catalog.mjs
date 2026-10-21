// SQLite owns sound metadata. Media paths and legacy catalogs are never reorganized by migration.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, copyFileSync, renameSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { LearningStore, safeFile } from './learning-store.mjs';
const AUDIO=/\.(wav|mp3|ogg|m4a|aiff?|flac)$/i;
const now=()=>new Date().toISOString();
const encode=JSON.stringify;
const read=p=>existsSync(p)?JSON.parse(readFileSync(p,'utf8')):null;
const bounded=(v,max)=>{if(typeof v!=='string'||v.length>max)throw Error(`Use text up to ${max} characters.`);return v.trim();};
function metadata(input={}) {
 const tags=input.tags??[];if(!Array.isArray(tags)||tags.length>30||tags.some(t=>typeof t!=='string'||!t.trim()||t.length>60))throw Error('Use up to 30 tags, each 1–60 characters.');
 return {note:bounded(input.note??'',4000),source:bounded(input.source??'',2000),licence:bounded(input.licence??input.license??'',2000),tags:[...new Set(tags.map(t=>t.trim()))]};
}
function atomic(path,content){const tmp=path+'.'+randomUUID()+'.tmp';writeFileSync(tmp,content,{flag:'wx'});renameSync(tmp,path);}
function legacy(root){
 const p=safeFile(root,'sfx/INDEX.md'),index=new Map();
 if(existsSync(p)){if(lstatSync(p).size>4e6)throw Error('Sound index is too large to migrate safely.');for(const line of readFileSync(p,'utf8').split('\n')){const m=/^\s*[-*]\s+(?:`([^`]+)`|([^\s—–:]+))\s*(?:[—–:]+|\s-\s)?\s*(.*)$/.exec(line);if(m)index.set((m[1]||m[2]).replace(/^\.\//,''),m[3]);}}
 const cp=safeFile(root,'sfx/_new/candidates.json');if(existsSync(cp)&&lstatSync(cp).size>4e6)throw Error('Sound candidates are too large to migrate safely.');
 const raw=read(cp),items=Array.isArray(raw)?raw:raw?.candidates||[];
 if(!Array.isArray(items))throw Error('Invalid sound candidates. Repair the JSON before importing.');
 return {index,candidates:new Map(items.filter(c=>c&&typeof c.file==='string').map(c=>[c.file.replace(/^sfx\/_new\//,''),c]))};
}
export class SoundCatalog {
 constructor(studio,library) {
  this.studio=resolve(studio);this.root=resolve(library);
  const rel=relative(this.studio,this.root);this.key=!rel.startsWith('..')&&!isAbsolute(rel)?`studio:${rel}`:`external:${this.root}`;
  // Creates the shared database when needed; preserves its existing learning schema.
  const learning=new LearningStore(studio);learning.close();
  this.db=new DatabaseSync(safeFile(studio,'.studio/studio.sqlite'));
  try {
   this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
   const table=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sound_catalog_schema'").get();
   if(table&&this.db.prepare('SELECT version FROM sound_catalog_schema WHERE singleton=1').get()?.version!==1)throw Error('Newer sound catalog. Update Video Octopus before opening it.');
   if(!table){
    if(existsSync(safeFile(studio,'.studio/sound-storage.json')))throw Error('Sound catalog is missing from this database. Restore a backup containing the sound catalog.');
    this.backup('before-sound-schema');
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE sound_catalog_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
      INSERT INTO sound_catalog_schema VALUES(1,1);
      CREATE TABLE sound_libraries(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE sound_assets(id TEXT PRIMARY KEY,library TEXT NOT NULL REFERENCES sound_libraries(id),file TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(library,file));
      CREATE TABLE sound_history(id INTEGER PRIMARY KEY,asset TEXT NOT NULL,created TEXT NOT NULL,reason TEXT NOT NULL,data TEXT NOT NULL);
      COMMIT;`);
   }
   const marker=safeFile(studio,'.studio/sound-storage.json');if(!existsSync(marker))atomic(marker,encode({schema:1,created:now()}));
   if(!this.db.prepare('SELECT id FROM sound_libraries WHERE id=?').get(this.key))this.importLibrary();
  }catch(e){this.db.close();throw e;}
 }
 close(){this.db.close();}
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 backup(reason){
  const dir=safeFile(this.studio,`.studio/sound-migration-backups/${randomUUID()}`);mkdirSync(dir,{recursive:true});
  this.db.exec(`VACUUM INTO '${join(dir,'studio.sqlite').replaceAll("'","''")}'`);
  if(existsSync(this.root))for(const [rel,name] of [['sfx/INDEX.md','INDEX.md'],['sfx/_new/candidates.json','candidates.json']]){const p=safeFile(this.root,rel);if(existsSync(p))copyFileSync(p,join(dir,name));}
  atomic(join(dir,'manifest.json'),encode({schema:1,created:now(),reason,library:this.root,mediaIncluded:false}));
  atomic(join(dir,'RECOVERY.md'),'# Sound catalog recovery\n\nAudio files were not moved or changed. This backup contains the database before import and copies of legacy metadata, not audio. Keep your media backup separately. Stop the app before any manual database recovery; preserve the current database and its SQLite sidecars first. Do not copy a backup over a running database or mix it with old journals. Prefer Storage restore using a full post-migration backup. A pre-catalog database needs deliberate coordinated rollback of the app and migration marker by a developer, not an agent guessing SQL changes.\n');
  return dir;
 }
 files(){
  const out=[];const walk=(rel,depth)=>{if(depth>8)throw Error('Sound folder exceeds supported nesting; no files moved.');const dir=safeFile(this.root,rel);if(!existsSync(dir))return;for(const name of readdirSync(dir)){if(name.startsWith('.')||(name.startsWith('_')&&!(rel==='sfx'&&name==='_new')))continue;const file=rel+'/'+name,p=safeFile(this.root,file),st=lstatSync(p);if(st.isDirectory())walk(file,depth+1);else if(st.isFile()&&AUDIO.test(name)){out.push({file,at:st.mtimeMs,bytes:st.size});if(out.length>20000)throw Error('Sound catalog exceeds 20,000 files.');}}};walk('sfx',0);return out;
 }
 rows(){return this.db.prepare('SELECT data FROM sound_assets WHERE library=? ORDER BY rowid DESC').all(this.key).map(r=>JSON.parse(r.data));}
 byFile(file){const r=this.db.prepare('SELECT data FROM sound_assets WHERE library=? AND file=?').get(this.key,file);return r?JSON.parse(r.data):null;}
 put(row,reason){this.db.prepare('INSERT INTO sound_assets(id,library,file,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(row.id,this.key,row.file,encode(row));this.db.prepare('INSERT INTO sound_history(asset,created,reason,data) VALUES(?,?,?,?)').run(row.id,now(),reason,encode(row));return row;}
 create(file,status,meta,reason){return this.put({id:randomUUID(),file,name:file.split('/').pop(),status,intakeManaged:status==='pending',...metadata(meta),revision:1,created:now(),updated:now()},reason);}
 importLibrary(){
  const inputs=legacy(this.root),files=this.files(),backup=this.backup('before-sound-library-import');
  this.tx(()=>{this.db.prepare('INSERT INTO sound_libraries(id,data) VALUES(?,?)').run(this.key,encode({root:this.root,imported:now(),backup}));for(const f of files){const pending=f.file.startsWith('sfx/_new/');this.create(f.file,pending?'pending':'approved',pending?inputs.candidates.get(f.file.slice(9))||{}:{note:inputs.index.get(f.file.slice(4))||''},'legacy import');}});
 }
 scan(){
  const files=this.files(),rows=this.rows(),known=new Set(rows.map(r=>r.file));this.warnings=[];
  if(files.some(f=>!known.has(f.file))||rows.some(r=>r.status==='pending'&&r.intakeManaged)){
   let inputs;try{inputs=legacy(this.root);}catch(e){this.warnings.push(`New sound intake is waiting: ${e.message}`);return this.view();}
   try{this.tx(()=>{
    for(const f of files)if(!known.has(f.file))this.create(f.file,'pending',inputs.candidates.get(f.file.replace(/^sfx\/_new\//,''))||{note:inputs.index.get(f.file.slice(4))||''},'new file awaiting review');
    // Incoming candidate metadata may arrive after its audio. Only unreviewed inbox entries follow it.
    for(const old of rows)if(old.status==='pending'&&old.intakeManaged){const input=inputs.candidates.get(old.file.replace(/^sfx\/_new\//,''));if(!input)continue;const meta=metadata(input);if(encode(meta)!==encode(metadata(old)))this.put({...old,...meta,revision:old.revision+1,updated:now()},'incoming candidate metadata');}
   });}catch(e){this.warnings.push(`New sound intake is waiting: ${e.message}`);}
  }
  return this.view();
 }
 view(){return this.rows().map(row=>{const p=safeFile(this.root,row.file);const st=existsSync(p)?lstatSync(p):null;return {...row,type:'audio',path:p,missing:!st?.isFile(),bytes:st?.size||0,at:st?.mtimeMs||0};});}
 register(file,meta={}){
  if(!file.startsWith('sfx/')||!AUDIO.test(file))throw Error('Choose a supported audio file.');const p=safeFile(this.root,file);if(!lstatSync(p).isFile())throw Error('Sound file is missing.');
  return this.tx(()=>{const old=this.byFile(file);if(old)return this.put({...old,...metadata({...old,...meta}),status:'approved',intakeManaged:false,revision:old.revision+1,updated:now()},'creator added file');return this.create(file,'approved',meta,'creator added file');});
 }
 change(file,revision,patch,status){return this.tx(()=>{const old=this.byFile(file);if(!old)throw Error('Sound is not in the catalog. Refresh the library.');if(revision!==undefined&&revision!==old.revision)throw Error('Sound changed. Refresh before saving.');if(status&&old.status!=='pending')throw Error('This sound is no longer waiting for review.');if(status==='approved'&&!existsSync(safeFile(this.root,file)))throw Error('Sound file is missing.');const row={...old,...metadata({...old,...patch}),status:status||old.status,intakeManaged:false,revision:old.revision+1,updated:now()};return this.put(row,status||'metadata edit');});}
 snapshot(){const data={schema:1,storage:'sqlite',library:this.root,items:this.scan(),warnings:this.warnings||[]};const path=safeFile(this.studio,'.studio/sound-catalog.json'),content=encode(data);if(!existsSync(path)||readFileSync(path,'utf8')!==content)atomic(path,content);return {...data,snapshot:path};}
}
export function withSoundCatalog(studio,library,fn){const catalog=new SoundCatalog(studio,library);try{return fn(catalog);}finally{catalog.close();}}

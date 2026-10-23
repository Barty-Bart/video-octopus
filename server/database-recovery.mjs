// Recovery only uses backups created inside this studio. No arbitrary uploaded SQL is executed.
import { applyMemoryTombstones, MemoryStore } from './memory-store.mjs';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync, copyFileSync, renameSync, mkdirSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { safeFile, learningId } from './learning-store.mjs';
import { FileStore, TEXT_FILES } from './file-store.mjs';
import { otherFileUses } from './resource-store.mjs';
const digest=p=>existsSync(p)?createHash('sha256').update(readFileSync(p)).digest('hex'):null;
export function databaseBackups(studio){const root=safeFile(studio,'.studio/learning-backups');if(!existsSync(root))return [];return readdirSync(root).flatMap(id=>{try{learningId(id);const manifest=safeFile(root,`${id}/manifest.json`),file=safeFile(root,`${id}/studio.sqlite`);if(!existsSync(manifest)||!existsSync(file))return [];return [{id,...JSON.parse(readFileSync(manifest)),bytes:lstatSync(file).size}];}catch{return [];}}).sort((a,b)=>b.created.localeCompare(a.created));}
export function previewDatabaseRestore(studio,id,projects=[]){
 learningId(id);const file=safeFile(studio,`.studio/learning-backups/${id}/studio.sqlite`);if(!existsSync(file))throw Error('Backup not found.');const db=new DatabaseSync(file,{readOnly:true});
 try{
  if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Backup integrity check failed.');
  if(db.prepare('PRAGMA user_version').get().user_version!==1)throw Error('Unsupported backup database version.');
  if(existsSync(safeFile(studio,'.studio/profile-storage.json'))&&(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='instruction_head'").get()||!db.prepare('SELECT version FROM instruction_head WHERE singleton=1').get()))throw Error('This backup predates profile/instruction storage. Choose a backup containing canonical profile data.');
  const soundSchema=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sound_catalog_schema'").get();
  if(existsSync(safeFile(studio,'.studio/sound-storage.json'))&&!soundSchema)throw Error('This backup predates the sound catalog. Choose a backup containing sound metadata.');
  if(soundSchema&&db.prepare('SELECT version FROM sound_catalog_schema WHERE singleton=1').get()?.version!==1)throw Error('Unsupported sound catalog backup version.');
  const memorySchema=db.prepare("SELECT name FROM sqlite_master WHERE name='memory_schema'").get();
  if(existsSync(safeFile(studio,'.studio/memory-storage.json'))&&!memorySchema)throw Error('This backup predates memories. Choose a complete studio backup.');
  if(memorySchema&&db.prepare('SELECT version FROM memory_schema').get()?.version!==1)throw Error('Unsupported memory backup version.');
  const counts={};for(const table of ['profiles','formats','sessions','versions','skill_snapshots','brand_versions','instruction_versions','project_context','sound_assets','sound_history','memory_entries','memory_events','memory_revisions','memory_checkpoints'])counts[table]=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)?db.prepare(`SELECT count(*) n FROM ${table}`).get().n:0;
  const has=(table,id)=>!id||(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)&&db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id));
  const missingPins=projects.filter(p=>{
    if(!has('versions',p.versionId)||!has('brand_versions',p.brandVersion)||!has('instruction_versions',p.instructionVersion)||!has('skill_snapshots',p.skillSnapshot))return true;
    if(p.project&&p.instructionVersion){
      if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_context'").get())return true;
      const row=db.prepare('SELECT data FROM project_context WHERE project=?').get(p.project);if(!row)return true;
      const old=JSON.parse(row.data);return ['profileId','brandVersion','instructionVersion','skillSnapshot','formatId','versionId'].some(k=>(old[k]||null)!==(p[k]||null));
    }return false;
  }).map(p=>p.name);
  return {id,counts,missingPins,missingFiles:missingSkillFiles(studio,db),token:createHash('sha256').update(`${digest(file)}:${digest(safeFile(studio,'.studio/studio.sqlite'))}`).digest('hex')};
 }finally{db.close();}
}
// Skill files the backup's versions use that are neither in the file store nor (for an older backup) still in its
// SQLite blobs. Listed so the creator can restore the file store backup; a restore is not refused for them.
function missingSkillFiles(studio,db){
  const has=(table)=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const store=new FileStore(studio),blobs=has('learning_blobs'),formats=new Map();
  if(has('formats'))for(const row of db.prepare('SELECT id,data FROM formats').all())formats.set(row.id,JSON.parse(row.data).name);
  const missing=new Map();
  // Resources and Packaging images (server/resource-store.mjs) are in the same file store.
  for(const use of otherFileUses(db)){
    if(!missing.has(use.sha256)&&!store.locate(use.sha256))missing.set(use.sha256,{sha256:use.sha256,file:use.file,format:null,version:null});
  }
  if(!has('versions'))return [...missing.values()];
  for(const row of db.prepare('SELECT data FROM versions').all()){
    const v=JSON.parse(row.data);
    for(const f of v.package?.files||[]){
      if(TEXT_FILES.has(f.file)||missing.has(f.sha256)||store.locate(f.sha256))continue;
      if(blobs&&db.prepare('SELECT 1 FROM learning_blobs WHERE hash=?').get(f.sha256))continue;
      missing.set(f.sha256,{sha256:f.sha256,file:f.file,format:formats.get(v.formatId)||null,version:v.number});
    }
  }
  return [...missing.values()];
}
export function restoreDatabase(studio,id,token,projects=[]){
 const p=previewDatabaseRestore(studio,id,projects);if(token!==p.token)throw Error('Database or backup changed. Review the restore again.');
 if(p.missingPins.length)throw Error(`This backup lacks versions pinned by current projects: ${p.missingPins.join(', ')}. Restore individual skill/format versions instead.`);
 const current=safeFile(studio,'.studio/studio.sqlite'),backup=safeFile(studio,`.studio/learning-backups/${id}/studio.sqlite`),tmp=safeFile(studio,`.studio/restore-${randomUUID()}.sqlite`),saved=safeFile(studio,`.studio/database-before-restore-${randomUUID()}.sqlite`);
 mkdirSync(dirname(current),{recursive:true});copyFileSync(backup,tmp);
 if(existsSync(safeFile(studio,'.studio/memory-storage.json'))){
   const db=new DatabaseSync(current,{readOnly:true});let tombstones;try{tombstones=db.prepare('SELECT kind,id FROM memory_tombstones').all();}finally{db.close();}
   const staged=new DatabaseSync(tmp);try{applyMemoryTombstones(staged,tombstones);}finally{staged.close();}
   const memory=new MemoryStore(studio);try{memory.invalidate();}finally{memory.close();}
 }
 const moved=[];
 // Preserve SQLite sidecars with the displaced database; never pair an old journal with a restored DB.
 const sidecars=['-wal','-shm','-journal'].map(suffix=>({from:safeFile(studio,`.studio/studio.sqlite${suffix}`),to:saved+suffix}));
 try {
   if(existsSync(current)){renameSync(current,saved);moved.push({from:current,to:saved});}
   for(const pair of sidecars)if(existsSync(pair.from)){renameSync(pair.from,pair.to);moved.push(pair);}
   renameSync(tmp,current);
 } catch(e){for(const pair of moved.reverse())if(existsSync(pair.to))renameSync(pair.to,pair.from);throw e;}
 return {ok:true,previous:saved,missingFiles:p.missingFiles,note:'Database restored. Media, projects and intake files remain in place. Generated skill files will be rebuilt from this database.'+(p.missingFiles.length?` ${p.missingFiles.length} skill file${p.missingFiles.length===1?' is':'s are'} missing from the file store: restore the skill file backup.`:'')};
}

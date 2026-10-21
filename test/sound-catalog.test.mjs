import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SoundCatalog } from '../server/sound-catalog.mjs';
import { LearningStore } from '../server/learning-store.mjs';
import { previewDatabaseRestore, restoreDatabase } from '../server/database-recovery.mjs';
function fixture(t){const root=realpathSync(mkdtempSync(join(tmpdir(),'sound-catalog-'))),lib=join(root,'library');mkdirSync(join(lib,'sfx/_new'),{recursive:true});t.after(()=>rmSync(root,{recursive:true,force:true}));const open=()=>new SoundCatalog(root,lib);return {root,lib,open};}
const put=(p,text)=>{mkdirSync(join(p,'..'),{recursive:true});writeFileSync(p,text);};
test('migration imports metadata and backs up without moving media or rewriting original catalogs',t=>{
 const {root,lib,open}=fixture(t);const index='# Sounds\n- `whoosh.wav` — soft page turn · licence: CC0\n',meta=JSON.stringify([{file:'click.wav',note:'gentle click',source:'made in code',licence:'original',tags:['ui']}]);
 put(join(lib,'sfx/whoosh.wav'),'synthetic audio');put(join(lib,'sfx/INDEX.md'),index);put(join(lib,'sfx/_new/click.wav'),'synthetic candidate');put(join(lib,'sfx/_new/candidates.json'),meta);
 let c=open();let rows=c.scan();assert.equal(rows.length,2);assert.equal(rows.find(x=>x.name==='whoosh.wav').status,'approved');const pending=rows.find(x=>x.name==='click.wav');assert.equal(pending.status,'pending');assert.deepEqual(pending.tags,['ui']);
 const approved=c.change(pending.file,pending.revision,{},'approved');assert.equal(approved.file,'sfx/_new/click.wav');assert.equal(readFileSync(join(lib,'sfx/_new/click.wav'),'utf8'),'synthetic candidate');c.close();
 c=open();assert.equal(c.scan().length,2);assert.equal(c.byFile(approved.file).id,approved.id);c.close();assert.equal(readFileSync(join(lib,'sfx/INDEX.md'),'utf8'),index);assert.equal(readFileSync(join(lib,'sfx/_new/candidates.json'),'utf8'),meta);
 const backups=readdirSync(join(root,'.studio/sound-migration-backups'));assert.equal(backups.length,2);for(const b of backups){assert(existsSync(join(root,'.studio/sound-migration-backups',b,'studio.sqlite')));assert.equal(readFileSync(join(root,'.studio/sound-migration-backups',b,'INDEX.md'),'utf8'),index);}
});
test('SQLite metadata wins over legacy edits; new sounds await approval; discarded files stay retained',t=>{
 const {lib,open}=fixture(t);put(join(lib,'sfx/existing.wav'),'sound');const c=open();t.after(()=>c.close());let row=c.scan()[0];row=c.change(row.file,row.revision,{note:'creator note',tags:['approved']});put(join(lib,'sfx/INDEX.md'),'- `existing.wav` — overwrite attempt');
 put(join(lib,'sfx/_new/next.wav'),'next');put(join(lib,'sfx/_new/candidates.json'),JSON.stringify([{file:'next.wav',note:'candidate'}]));let items=c.scan();assert.equal(items.find(x=>x.id===row.id).note,'creator note');let next=items.find(x=>x.name==='next.wav');assert.equal(next.status,'pending');
 c.change(next.file,next.revision,{},'discarded');assert.equal(c.scan().find(x=>x.id===next.id).status,'discarded');assert(existsSync(join(lib,next.file)));assert.equal(c.db.prepare('SELECT count(*) n FROM sound_history WHERE asset=?').get(next.id).n,2);
});
test('metadata edits are revision checked and approval cannot resurrect discarded candidates',t=>{
 const {lib,open}=fixture(t);const c=open();t.after(()=>c.close());put(join(lib,'sfx/_new/x.wav'),'x');const row=c.scan()[0];const edited=c.change(row.file,row.revision,{note:'new',source:'local',licence:'check source',tags:['click']});assert.throws(()=>c.change(row.file,row.revision,{note:'stale'}),/changed/);assert.throws(()=>c.change(row.file,edited.revision,{tags:['x'.repeat(61)]}),/tags/);const discarded=c.change(row.file,edited.revision,{},'discarded');assert.throws(()=>c.change(row.file,discarded.revision,{},'approved'),/no longer/);
});
test('missing audio is visible without deleting metadata, snapshot gives exact paths',t=>{
 const {lib,open}=fixture(t);put(join(lib,'sfx/a.wav'),'a');const c=open();t.after(()=>c.close());const row=c.scan()[0];rmSync(join(lib,row.file));const view=c.snapshot();assert.equal(view.items[0].missing,true);assert.equal(view.items[0].path,join(lib,row.file));assert.equal(JSON.parse(readFileSync(view.snapshot)).items[0].id,row.id);
});
test('full database backup restores metadata while audio and old paths remain intact; pre-catalog restore is rejected',t=>{
 const {root,lib,open}=fixture(t);const st=new LearningStore(root);const before=st.backup();st.close();put(join(lib,'sfx/a.wav'),'a');let c=open(),row=c.scan()[0];c.close();assert.throws(()=>previewDatabaseRestore(root,before.id),/predates the sound catalog/);
 const s=new LearningStore(root);const backup=s.backup();s.close();c=open();c.change(row.file,row.revision,{note:'later edit'});c.close();const preview=previewDatabaseRestore(root,backup.id);assert.equal(preview.counts.sound_assets,1);restoreDatabase(root,backup.id,preview.token);c=open();assert.equal(c.byFile(row.file).note,'');assert.equal(readFileSync(join(lib,row.file),'utf8'),'a');c.close();
});
test('custom library root imports independently and refuses links and newer catalog versions',t=>{
 const {root,lib,open}=fixture(t);const other=join(root,'alternate');put(join(other,'sfx/a.wav'),'a');let c=new SoundCatalog(root,other);assert.equal(c.scan()[0].path,join(other,'sfx/a.wav'));c.close();c=open();assert.equal(c.scan().length,0);c.db.exec('UPDATE sound_catalog_schema SET version=2');c.close();assert.throws(open,/Newer/);
});
test('symlinked audio is rejected without moving or editing its target',t=>{
 if(process.platform==='win32'){t.skip('symlink privileges differ');return;}const {root,lib,open}=fixture(t);put(join(root,'outside.wav'),'keep');symlinkSync(join(root,'outside.wav'),join(lib,'sfx/link.wav'));assert.throws(open,/symbolic/);assert.equal(readFileSync(join(root,'outside.wav'),'utf8'),'keep');
});
test('late candidate metadata follows only unreviewed intake, malformed JSON preserves the catalog',t=>{
 const {lib,open}=fixture(t);const c=open();t.after(()=>c.close());put(join(lib,'sfx/_new/late.wav'),'late');let row=c.scan()[0];assert.equal(row.note,'');
 put(join(lib,'sfx/_new/candidates.json'),JSON.stringify([{file:'late.wav',note:'Arrived later',source:'local'}]));row=c.scan()[0];assert.equal(row.note,'Arrived later');
 row=c.change(row.file,row.revision,{note:'Creator edit'});put(join(lib,'sfx/_new/candidates.json'),JSON.stringify([{file:'late.wav',note:'Must not override'}]));assert.equal(c.scan()[0].note,'Creator edit');
 put(join(lib,'sfx/_new/new.wav'),'new');put(join(lib,'sfx/_new/candidates.json'),'{partial');assert.equal(c.scan().length,1);assert(c.warnings.length);assert.equal(c.byFile(row.file).note,'Creator edit');
});

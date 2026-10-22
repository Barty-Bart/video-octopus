import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { databaseBackups, previewDatabaseRestore, restoreDatabase } from '../server/database-recovery.mjs';
import { LearningStore } from '../server/learning-store.mjs';
import { syncSkills, activeSkillRoot } from '../server/managed-skills.mjs';
import { sqlSkillState, sqlSkillContent, sqlSkillHistory } from '../server/skill-db.mjs';
function fixture(t){const root=realpathSync(mkdtempSync(join(tmpdir(),'octopus-learning-')));const store=new LearningStore(root);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});const p=store.profile('Synthetic creator'),f=store.format(p.id,'Synthetic format','faceless',90);return {root,store,p,f};}
function draft(st,f,rules){let s=st.session(f.id,{name:'Study',focus:['scripting','pacing']});s=st.reference(s.id,s.revision,{name:'Observed sample',kind:'note',note:'At 00:02 the finished result appears.'});const proposal={rules:(rules||[{id:'opening',text:'Show the result first.'}]).map(r=>({area:'scripting',confidence:'medium',evidence:[{referenceId:s.references[0].id,note:'00:02: result is visible.'}],...r})),workflow:'Use core production skills after script review. Preserve cut lock and scene review.',assets:[]};writeFileSync(join(st.sessionDir(s.id),'work','proposal.json'),JSON.stringify(proposal));return {s,proposal};}
function approve(st,d,decisions){const p=st.proposal(d.s.id);return st.approve(d.s.id,{revision:p.revision,token:p.token,decisions:decisions||p.rules.map(r=>({id:r.id,action:'keep'}))});}
test('SQLite owns approval content; pinning, further learning and active rollback keep earlier projects stable',t=>{const {store:st,f,root}=fixture(t);const d=draft(st,f),v1=approve(st,d);st.pin('project-one',{versionId:v1.id,formatId:f.id});const d2=draft(st,f,[{id:'opening',text:'A different opening.'},{id:'pace',area:'pacing',text:'Pause on the result.'}]);const v2=approve(st,d2,[{id:'opening',action:'discard'},{id:'pace',action:'edit',text:'Hold the result for two seconds.'}]);const pack=st.version(v2.id);assert.equal(pack.rules[0].text,'Show the result first.');assert.equal(pack.rules[1].text,'Hold the result for two seconds.');assert.equal(st.binding('project-one').versionId,v1.id);st.activate(f.id,v1.id,v2.id);assert.equal(st.get('formats',f.id).activeVersion,v1.id);assert.equal(st.list('versions').length,2);rmSync(st.versionDir(v1.id),{recursive:true});assert.equal(st.version(v1.id).rules[0].text,'Show the result first.');assert(existsSync(join(root,'.studio','studio.sqlite')));});
test('stale proposal, stale session and concurrent approvals fail without activating partial snapshots',t=>{const {store:st,f}=fixture(t);const d=draft(st,f),p=st.proposal(d.s.id);writeFileSync(join(st.sessionDir(d.s.id),'work/proposal.json'),JSON.stringify({...d.proposal,workflow:'Changed during review'}));assert.throws(()=>st.approve(d.s.id,{revision:p.revision,token:p.token,decisions:[{id:'opening',action:'keep'}]}),/changed/);assert.throws(()=>st.reference(d.s.id,1,{name:'Other',kind:'note',note:'x'}),/changed/);const d2=draft(st,f);approve(st,d);assert.throws(()=>approve(st,d2),/active format changed/);assert.equal(st.list('versions').length,1);});
test('missing evidence, path traversal, symlinks and modified approved content fail closed',t=>{const {store:st,f,root}=fixture(t);const d=draft(st,f);d.proposal.rules[0].evidence[0].referenceId='invented';writeFileSync(join(st.sessionDir(d.s.id),'work/proposal.json'),JSON.stringify(d.proposal));assert.throws(()=>st.proposal(d.s.id),/evidence/);const d2=draft(st,f);d2.proposal.assets=[{file:'../outside',note:'bad'}];writeFileSync(join(st.sessionDir(d2.s.id),'work/proposal.json'),JSON.stringify(d2.proposal));assert.throws(()=>st.proposal(d2.s.id),/outside/);const d3=draft(st,f),v=approve(st,d3);writeFileSync(join(st.versionDir(v.id),'guide.md'),'external edit');assert.throws(()=>st.version(v.id),/changed/);st.regenerateVersion(v.id);assert.match(readFileSync(join(st.versionDir(v.id),'guide.md'),'utf8'),/Show the result/);if(process.platform!=='win32'){const other=join(root,'other');mkdirSync(other);symlinkSync(other,join(st.sessionDir(d3.s.id),'work','assets'));assert.throws(()=>st.upload(d2.s.id,d2.s.revision,'bad.exe',Buffer.from('x')),/Choose/);}});
test('uploads and notes survive restart; backup holds approved bodies and skill content',t=>{const {store:st,f,root}=fixture(t);const d=draft(st,f),s=st.upload(d.s.id,d.s.revision,'reference.txt',Buffer.from('Synthetic reference'));assert.equal(readFileSync(join(st.sessionDir(s.id),s.references[1].file),'utf8'),'Synthetic reference');const v=approve(st,d);const backup=st.backup();const db=new DatabaseSync(join(backup.path,'studio.sqlite'));assert.equal(db.prepare('SELECT count(*) n FROM versions').get().n,1);assert(db.prepare('SELECT count(*) n FROM learning_blobs').get().n>=2);db.close();const reopened=new LearningStore(root);assert.equal(reopened.version(v.id).rules.length,1);reopened.close();});
test('a corrupt or newer schema is never silently replaced',t=>{const root=realpathSync(mkdtempSync(join(tmpdir(),'octopus-schema-')));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'.studio'));const path=join(root,'.studio/studio.sqlite');writeFileSync(path,'corrupt');assert.throws(()=>new LearningStore(root));assert.equal(readFileSync(path,'utf8'),'corrupt');rmSync(path);const db=new DatabaseSync(path);db.exec('PRAGMA user_version=999');db.close();assert.throws(()=>new LearningStore(root),/newer/);});
test('SQL skill editing, canonical authority, rebuild, custom creation and history restore',t=>{const {root}=fixture(t);let v=syncSkills({studio:root,fresh:true}),core=v.items[0],text=sqlSkillContent(root,core.id).text;v=syncSkills({studio:root,action:{action:'edit',id:core.id,revision:v.revision,text:text+'\nSynthetic preference.\n'}});assert.equal(v.items.find(x=>x.id===core.id).kind,'customized-core');assert.match(sqlSkillContent(root,core.id).text,/Synthetic preference/);const before=sqlSkillState(root);writeFileSync(join(root,'.studio/skill-manager/state.json'),'{}');assert.equal(sqlSkillState(root).revision,before.revision);rmSync(join(root,'.claude/skills'),{recursive:true});rmSync(join(root,'skills'),{recursive:true});v=syncSkills({studio:root,action:{action:'regenerate',revision:v.revision}});assert.match(sqlSkillContent(root,core.id).text,/Synthetic preference/);assert(activeSkillRoot({studio:root}));v=syncSkills({studio:root,action:{action:'create',revision:v.revision,text:'---\nname: synthetic-personal\ndescription: Synthetic workflow\n---\nDo a synthetic thing.\n'}});assert(v.items.some(x=>x.kind==='personal'&&x.name==='synthetic-personal'));const hist=sqlSkillHistory(root);assert(hist.length>=3);v=syncSkills({studio:root,action:{action:'restore-sql',snapshot:hist.at(-1).id,revision:v.revision}});assert(v.held);assert.equal(v.items.find(x=>x.id===core.id).kind,'core');});
test('interruption after database commit recovers as committed and retains canonical version',t=>{const {root}=fixture(t);syncSkills({studio:root,fresh:true});const old=sqlSkillState(root);assert.throws(()=>syncSkills({studio:root,action:{action:'disable',id:Object.keys(old.entries)[0],revision:old.revision},fault:p=>{if(p==='after-database-commit')throw Error('injected');}}),/injected/);assert.notEqual(sqlSkillState(root).revision,old.revision);const v=syncSkills({studio:root});assert(v.ok);assert(v.items[0].disabled);assert(activeSkillRoot({studio:root}));});

test('startup reads SQLite, regenerates missing projections and refuses to import external edits silently',t=>{const {root}=fixture(t);const first=syncSkills({studio:root,fresh:true});const entry=first.items[0],path=join(root,'.claude/skills',entry.published.folder,'SKILL.md'),text=readFileSync(path,'utf8');rmSync(join(root,'.claude/skills'),{recursive:true});const rebuilt=syncSkills({studio:root});assert.equal(rebuilt.items.length,first.items.length);assert.equal(readFileSync(path,'utf8'),text);writeFileSync(path,text+'\nExternal edit\n');assert.throws(()=>syncSkills({studio:root}),/Working skill files changed/);assert.equal(sqlSkillContent(root,entry.id).text,text);syncSkills({studio:root,action:{action:'refresh'}});assert.match(sqlSkillContent(root,entry.id).text,/External edit/);});

test('database recovery checks stale reviews, protects project pins and preserves displaced bytes',t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'octopus-recovery-')));t.after(()=>rmSync(root,{recursive:true,force:true}));let st=new LearningStore(root);const profile=st.profile('Test'),f=st.format(profile.id,'Test','short');const v1=approve(st,draft(st,f)),backup=st.backup();const v2=approve(st,draft(st,f));st.close();
 assert.equal(databaseBackups(root).length,1);const blocked=previewDatabaseRestore(root,backup.id,[{name:'Pinned newer project',versionId:v2.id}]);assert.equal(blocked.missingPins.length,1);assert.throws(()=>restoreDatabase(root,backup.id,blocked.token,[{name:'Pinned newer project',versionId:v2.id}]),/lacks versions/);
 const preview=previewDatabaseRestore(root,backup.id,[{name:'Old project',versionId:v1.id}]);st=new LearningStore(root);st.profile('Changed after review');st.close();assert.throws(()=>restoreDatabase(root,backup.id,preview.token),/changed/);
 const fresh=previewDatabaseRestore(root,backup.id),done=restoreDatabase(root,backup.id,fresh.token);assert(existsSync(done.previous));st=new LearningStore(root);assert.equal(st.list('versions').length,1);assert.equal(st.list('profiles').length,1);st.close();
});

test('dangling storage links cannot redirect uploads or database creation',t=>{if(process.platform==='win32'){t.skip('Symlink creation needs a privileged Windows fixture.');return;}const {root,store:st,f}=fixture(t),d=draft(st,f),intake=join(st.sessionDir(d.s.id),'intake'),outside=join(root,'missing-target');rmSync(intake,{recursive:true});symlinkSync(outside,intake);assert.throws(()=>st.upload(d.s.id,d.s.revision,'reference.txt',Buffer.from('test')),/symbolic links/);assert.equal(existsSync(outside),false);});

test('approval rejects a reference modified after intake',t=>{const {store:st,f}=fixture(t);const d=draft(st,f);const s=st.upload(d.s.id,d.s.revision,'source.txt',Buffer.from('Original evidence'));writeFileSync(join(st.sessionDir(s.id),s.references[1].file),'Changed evidence');assert.throws(()=>st.proposal(s.id),/reference copy changed/);assert.equal(st.list('versions').length,0);st.removeReference(s.id,s.revision,s.references[1].id);assert.equal(st.proposal(s.id).rules.length,1);assert(existsSync(join(st.sessionDir(s.id),s.references[1].file)),'Removed intake remains available for recovery');});

test('skill explanations are versioned SQL metadata without changing core ownership or workflow bytes',t=>{
 const {root}=fixture(t);let view=syncSkills({studio:root,fresh:true});const core=view.items.find(x=>x.id==='octopus.transcribe'),original=sqlSkillContent(root,core.id).text;
 assert.match(core.summary,/word-by-word/);const initial=sqlSkillHistory(root)[0].id;
 view=syncSkills({studio:root,action:{action:'describe',id:core.id,revision:view.revision,summary:'My short explanation.'}});
 assert.equal(view.items.find(x=>x.id===core.id).kind,'core');assert.equal(sqlSkillContent(root,core.id).text,original);
 assert.equal(sqlSkillState(root).entries[core.id].summary,'My short explanation.');assert.match(view.items.find(x=>x.id==='octopus.rough-cut').summary,/Proposes cuts/);
 assert.throws(()=>syncSkills({studio:root,action:{action:'describe',id:core.id,revision:view.revision,summary:'x'.repeat(321)}}),/1–320/);
 view=syncSkills({studio:root});assert.equal(view.items.find(x=>x.id===core.id).summary,'My short explanation.');
 view=syncSkills({studio:root,action:{action:'regenerate',revision:view.revision}});assert.equal(sqlSkillContent(root,core.id).summary,'My short explanation.');
 view=syncSkills({studio:root,action:{action:'create',revision:view.revision,summary:'A concise personal workflow.',text:'---\nname: summary-test\ndescription: Agent instructions use a different description.\n---\n# Workflow\nSynthetic instructions.'}});
 const personal=view.items.find(x=>x.name==='summary-test');assert.equal(personal.summary,'A concise personal workflow.');assert.match(sqlSkillContent(root,personal.id).text,/different description/);
 view=syncSkills({studio:root,action:{action:'restore-sql',snapshot:initial,revision:view.revision}});assert.equal(view.items.find(x=>x.id===core.id).summary,core.summary);
});

test('copying an approved format preserves provenance and assets with independent history', t => {
 const {store:st,f,p}=fixture(t), target=st.profile('Second synthetic channel'),d=draft(st,f);
 const asset=join(st.sessionDir(d.s.id),'work/assets/shape.svg');mkdirSync(join(st.sessionDir(d.s.id),'work/assets'),{recursive:true});writeFileSync(asset,'<svg><rect width="2" height="2"/></svg>');
 d.proposal.assets=[{file:'work/assets/shape.svg',note:'Synthetic shape'}];writeFileSync(join(st.sessionDir(d.s.id),'work/proposal.json'),JSON.stringify(d.proposal));
 const source=approve(st,d);st.update('formats',{...st.get('formats',f.id),skillIds:['synthetic-shared-skill']});
 st.pin('original-project',{versionId:source.id});
 const copy=st.copyFormat(f.id,{profileId:target.id,name:'Second channel explainers',expected:source.id,reviewed:true});
 assert.notEqual(copy.id,f.id);assert.equal(copy.profileId,target.id);assert.deepEqual(copy.skillIds,['synthetic-shared-skill']);
 const v=st.version(copy.activeVersion),original=st.version(source.id);
 assert.equal(v.number,1);assert.equal(v.copiedFrom.profileId,p.id);assert.equal(v.copiedFrom.versionId,source.id);assert.deepEqual(v.rules,original.rules);
 assert.equal(readFileSync(join(v.path,v.assets[0].file),'utf8'),readFileSync(join(original.path,original.assets[0].file),'utf8'));
 assert.match(readFileSync(join(v.path,'SKILL.md'),'utf8'),new RegExp(v.id));assert.doesNotMatch(readFileSync(join(v.path,'SKILL.md'),'utf8'),new RegExp(source.id));
 assert.equal(st.list('sessions').filter(s=>s.formatId===copy.id).length,0);
 const newer=approve(st,draft(st,copy,[{id:'opening',text:'Use a different opening.'}]));
 assert.equal(newer.number,2);assert.equal(st.get('formats',f.id).activeVersion,source.id);assert.equal(st.binding('original-project').versionId,source.id);
 assert.equal(st.version(source.id).rules[0].text,'Show the result first.');
});

test('format copy requires explicit review and a current approved source without partial writes', t => {
 const {store:st,f}=fixture(t),target=st.profile('Destination');
 assert.throws(()=>st.copyFormat(f.id,{profileId:target.id,name:'Copy',expected:null,reviewed:true}),/changed/);
 const v=approve(st,draft(st,f));
 assert.throws(()=>st.copyFormat(f.id,{profileId:target.id,name:'Copy',expected:v.id}),/Review/);
 const newer=approve(st,draft(st,f));
 assert.throws(()=>st.copyFormat(f.id,{profileId:target.id,name:'Copy',expected:v.id,reviewed:true}),/changed/);
 writeFileSync(join(st.versionDir(newer.id),'guide.md'),'Unaccepted edits');
 assert.throws(()=>st.copyFormat(f.id,{profileId:target.id,name:'Copy',expected:newer.id,reviewed:true}),/changed/);
 assert.equal(st.list('formats').length,1);assert.equal(st.list('versions').length,2);
});

test('examples-first sessions discover all supported areas while explicit and legacy focus stay scoped',t=>{
 const {store:st,f}=fixture(t);
 const automatic=st.session(f.id,{name:'Examples first'});
 assert.equal(automatic.autoFocus,true);
 assert.deepEqual(automatic.focus,['scripting','pacing','visuals','captions','sound','knowledge']);
 const manual=st.session(f.id,{name:'Only visuals',focus:['visuals']});
 assert.equal(manual.autoFocus,false);assert.deepEqual(manual.focus,['visuals']);
 assert.throws(()=>st.session(f.id,{name:'Invalid',focus:[]}),/focus/);
 assert.throws(()=>st.session(f.id,{name:'Invalid',focus:['invented']}),/focus/);
});
test('study settings preserve references and scope, reject stale, running and approved writes',t=>{
 const {store:st,f}=fixture(t);let d=draft(st,f);
 const changed=st.configure(d.s.id,d.s.revision,{direction:'Watch the opening',study:'detailed',name:'Opening study'});
 assert.deepEqual(changed.references,d.s.references);assert.deepEqual(changed.focus,d.s.focus);
 assert.equal(changed.direction,'Watch the opening');assert.equal(changed.study,'detailed');assert.equal(changed.name,'Opening study');
 assert.throws(()=>st.configure(changed.id,d.s.revision,{direction:'stale'}),/changed/);
 assert.throws(()=>st.configure(changed.id,changed.revision,{study:'unbounded'}),/mode/);
 assert.equal(st.get('sessions',changed.id).revision,changed.revision);
 assert.throws(()=>st.configure(changed.id,changed.revision,{direction:'x'.repeat(12001)}),/12000/);
 const running=st.change(changed.id,changed.revision,s=>s.status='running');
 assert.throws(()=>st.configure(running.id,running.revision,{direction:'during run'}),/Stop/);
 st.change(running.id,running.revision,s=>s.status='review');approve(st,d);
 const approved=st.get('sessions',d.s.id);
 // Conversations continue after approval (format skill spec, 22 October 2026): the session reopens on the new version.
 assert.equal(approved.status,'draft');assert.equal(approved.baseVersion,approved.approvedVersion);assert.deepEqual(approved.approvedVersions,[approved.approvedVersion]);
 assert.equal(st.configure(approved.id,approved.revision,{name:'After approval'}).name,'After approval');
});

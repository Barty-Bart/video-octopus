// Disposable runtime integration; no genuine agents, sign-ins, models or creator studios.
// node test/learning-integration.mjs [--serve] leaves only the owned fixture server for UI checks.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, cpSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
const source=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const root=realpathSync(mkdtempSync(join(tmpdir(),'octopus-learning-runtime-'))),app=join(root,'app'),studio=join(root,'studio'),home=join(root,'home'),local=join(root,'local'),bin=join(root,'bin');
const port=Number(process.env.OCTOPUS_TEST_PORT||43832),url=`http://127.0.0.1:${port}`;
const put=(p,s)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,s);};
for(const p of [app,studio,home,local,bin])mkdirSync(p,{recursive:true});
for(const p of ['server','web','core','starter','bin','package.json'])cpSync(join(source,p),join(app,p),{recursive:true});
put(join(app,'server/keychain.mjs'),`export const KEY_STORE='Synthetic fixture';export async function readKey(){return null;}export async function hasKey(){return false;}export async function saveKey(){throw Error('Fixture forbids credentials');}export async function removeKey(){throw Error('Fixture forbids credentials');}`);
const path=[bin,dirname(process.execPath),'/usr/bin','/bin','/usr/sbin','/sbin'].join(':');
put(join(bin,'fixture-shell'),`#!/bin/sh\nprintf '__P__%s__P__' '${path}'\n`);chmodSync(join(bin,'fixture-shell'),0o755);
for(const name of ['claude','codex','pi','lms','ollama']){put(join(bin,name),'#!/bin/sh\necho "Synthetic fixture: no real agent" >&2\nexit 1\n');chmodSync(join(bin,name),0o755);}
if(process.env.OCTOPUS_TEST_AGENT==='1'){
 async function fakeLearningAgent(){
  const {writeFileSync}=await import('node:fs'),{join}=await import('node:path'),{createInterface}=await import('node:readline');
  const argv=process.argv.slice(2);if(argv.includes('--version')){console.log('9.9.9 synthetic');return;}if(argv[0]==='auth'){console.log('{"loggedIn":true,"authMethod":"fixture"}');return;}
  const context=argv[argv.indexOf('--append-system-prompt')+1],mode=argv[argv.indexOf('--permission-mode')+1];
  const isBrand=context.includes('brand onboarding research'),isLearning=context.includes('This is a learning session');
  if((isBrand||isLearning)&&mode!=='manual')throw Error('Study permission mode missing');
  let session=isLearning?JSON.parse(context.match(/^Session: (.+)$/m)[1]):null,referenceId=session?.references[0]?.id;
  if(session?.autoFocus&&(!context.includes('Discover the relevant patterns yourself')||!context.includes('still images do not demonstrate timing, motion or sound')))throw Error('Automatic study guidance missing');
  writeFileSync(join(process.cwd(),'work','adapter-receipt.json'),JSON.stringify({mode,resumed:argv.includes('--resume'),session:session?.id,contextContainsFormat:context.includes('Practical explainer'),contextContainsReference:referenceId?context.includes(referenceId):false,isBrand,hasSharedPrivate:context.includes('SHARED_NOTES_RESEARCH_SENTINEL'),projectPinned:context.includes('Project context is pinned in SQLite'),hasAlpha:context.includes('Alpha research identity'),hasLegacy:context.includes('SYNTHETIC_CONTEXT_ISOLATION_SENTINEL')}));
  const out=x=>console.log(JSON.stringify(x));
  for await(const line of createInterface({input:process.stdin})){let x;try{x=JSON.parse(line);}catch{continue;}if(x.type!=='user')continue;const update=String(x.message?.content||'').match(/^Session: (.+)$/m);if(isLearning&&update){session=JSON.parse(update[1]);referenceId=session.references[0]?.id;}
   out({type:'system',subtype:'init',session_id:'fixture-learning',model:'synthetic'});
   if(isBrand)writeFileSync(join(process.cwd(),'work','brand-proposal.json'),JSON.stringify({identity:'Alpha research identity',audience:'Synthetic makers',voice:'Clear',colors:['#123456'],fonts:'Unknown',notes:'Synthetic evidence only',sources:[{url:'https://example.com/alpha',note:'Synthetic fixture observation, not a live website visit.'}],assets:[]}));
   else if(isLearning&&!referenceId){if(!context.includes('With no registered examples'))throw Error('Missing research-only context');writeFileSync(join(process.cwd(),'work','suggested-examples.json'),JSON.stringify([{name:'Synthetic example',url:'https://example.com/reference',note:'Fixture suggestion, not live research.'}]));}
   else if(isLearning)writeFileSync(join(process.cwd(),'work','proposal.json'),JSON.stringify({rules:[{id:'opening',area:'scripting',text:'Show the result first.',confidence:'medium',evidence:[{referenceId,note:'00:02: synthetic result appears.'}]}],workflow:'Review the script, lock the cut, approve the scene plan and review the build.',assets:[]}));
   const message=String(x.message?.content||'');
   const evidence=message.match(/original user message ID for memory evidence: ([^\]]+)/)?.[1];
   if(evidence&&message.includes('I prefer quiet synthetic transitions.'))out({type:'assistant',message:{content:[{type:'text',text:'```octopus-memory\n'+JSON.stringify([{key:'transition-sound',text:'Keep synthetic transitions quiet.',evidence:[evidence]}])+'\n```'}]}});
   if(message.includes('CHECK_MEMORY_CONTEXT'))writeFileSync(join(process.cwd(),'work','memory-receipt.json'),JSON.stringify({hasMemory:(context+message).includes('Keep synthetic transitions quiet.')}));
   out({type:'rate_limit_event',rate_limit_info:{unifiedWindows:{five_hour:{utilization:0.23},seven_day:{utilization:0.45}}}});
   out({type:'assistant',message:{content:[{type:'text',text:'Synthetic context checked and proposal saved when applicable.'}]}});out({type:'result',subtype:'success',is_error:false,duration_ms:1});
  }
 }
 put(join(bin,'claude'),`#!${process.execPath}\n(${fakeLearningAgent.toString()})().catch(e=>{console.error(e);process.exitCode=1;});\n`);chmodSync(join(bin,'claude'),0o755);
}
const env={HOME:home,USERPROFILE:home,TMPDIR:root,PATH:path,SHELL:join(bin,'fixture-shell'),XDG_CONFIG_HOME:join(home,'.config'),XDG_CACHE_HOME:join(home,'.cache'),XDG_DATA_HOME:join(home,'.local/share'),CODEX_HOME:join(home,'.codex'),CLAUDE_CONFIG_DIR:join(home,'.claude'),PI_CODING_AGENT_DIR:join(home,'.pi'),HF_HOME:join(home,'.cache/hf'),HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',STUDIO_LOCAL_DIR:local,STUDIO_NO_OPEN:'1',STUDIO_NO_SCHEDULES:'1',PORT:String(port),STUDIO_KEYCHAIN_SERVICE:`octopus-learning-fixture-${process.pid}`,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',LC_ALL:'C'};
const guard=join(root,'network-guard.mjs');put(guard,`import net from 'node:net';import tls from 'node:tls';import {syncBuiltinESMExports} from 'node:module';const allow=new Set(['127.0.0.1','localhost','::1']);function check(args){const a=args[0],h=typeof a==='object'?a.hostname||a.host:typeof args[1]==='string'?args[1]:undefined;if(h&&!allow.has(h))throw Error('Fixture blocked remote network');}for(const [o,k] of [[net,'connect'],[net,'createConnection'],[tls,'connect']]){const f=o[k];o[k]=function(...a){check(a);return f.apply(this,a);};}const f=fetch;globalThis.fetch=(u,...a)=>{if(!allow.has(new URL(typeof u==='string'||u instanceof URL?u:u.url).hostname))throw Error('Fixture blocked remote fetch');return f(u,...a);};syncBuiltinESMExports();`);env.NODE_OPTIONS=`--import=${guard}`;
put(join(local,'settings.json'),JSON.stringify({studio,...(process.env.OCTOPUS_TEST_FFMPEG?{ffmpeg:process.env.OCTOPUS_TEST_FFMPEG,ffprobe:process.env.OCTOPUS_TEST_FFPROBE}:{}),setup:{done:true,agent:''},updates:{auto:false},scheduleCatchUp:false,claude:{engine:'claude',lean:true,useApiKey:false},help:{stepsIntro:'dismissed'},...Object.fromEntries(['claude','codex','pi','lms','ollama'].map(n=>[`${n}Path`,join(bin,n)]))}));put(join(local,'schedules.json'),'{"v":1,"schedules":[]}');
execFileSync(process.execPath,['--input-type=module','-e',"const {createStudio}=await import(process.argv[1]);createStudio(process.argv[2],{use:false});",new URL(`file://${join(app,'server/starter.mjs')}`).href,studio],{env,stdio:['ignore','pipe','pipe']});
// Legacy catalog fixtures: real tiny PCM WAVs, no provider or creator files.
const wav=Buffer.alloc(44+1600);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(1600,40);
put(join(studio,'library/sfx/legacy.wav'),wav);put(join(studio,'library/sfx/INDEX.md'),'# Sounds\n- `legacy.wav` — synthetic page turn · CC0 fixture\n');
put(join(studio,'library/sfx/_new/candidate.wav'),wav);put(join(studio,'library/sfx/_new/candidates.json'),JSON.stringify([{file:'candidate.wav',note:'Synthetic candidate',source:'local synthesis',licence:'fixture only'}]));
put(join(studio,'library/styles/legacy-example.md'),'# Synthetic legacy style\nShow a clear outcome before the explanation.\n');
put(join(local,'plan-usage.json'),JSON.stringify({engine:'claude',fiveHour:0.99,sevenDay:0.99,at:Date.now()}));
const child=spawn(process.execPath,[join(app,'server/index.mjs')],{cwd:app,env,stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
const call=async(p='',data,expected=200)=>{const r=await fetch(url+'/api/learning'+p,data===undefined?{}:{method:'POST',headers:{'X-Studio':'1','Content-Type':'application/json'},body:JSON.stringify(data)});const j=await r.json();assert.equal(r.status,expected,JSON.stringify(j));return j;};
async function ready(){for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(logs);try{await call();return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Server timeout\n'+logs);}
try{
 await ready();assert.equal((await (await fetch(url+'/api/plan-usage')).json()).usage,null,'Old persisted usage must not be shown');const p=await call('/profiles',{name:'Synthetic channel'}),f=await call('/formats',{profileId:p.id,name:'Practical explainer',type:'faceless',targetSeconds:60});
 if(process.env.OCTOPUS_TEST_AGENT==='1'){
  const research=await call('/sessions',{formatId:f.id,name:'Chat-first research'});
  const endpoint=`/sessions/${research.id}`;
  await call(endpoint+'/run',{},400);await call(endpoint+'/chat',{text:' '},400);
  await call(endpoint+'/chat',{text:'Find examples for this format before I add references.'});
  let state;for(let i=0;i<100;i++){state=await call(endpoint);if(state.status!=='running')break;await new Promise(r=>setTimeout(r,50));}
  assert.equal(state.status,'draft',state.error);assert.equal(state.references.length,0);
  const suggestions=await call(endpoint+'/suggestions');assert.equal(suggestions[0].url,'https://example.com/reference');
  await call(endpoint+'/proposal',undefined,400);
  const usage=await (await fetch(url+'/api/plan-usage')).json();assert.equal(usage.usage.engine,'claude');assert.equal(usage.usage.fiveHour,0.23);assert(usage.usage.at>0);
  const sessions=await call(endpoint+'/chat-sessions',{op:'list'});assert(sessions.current.messages>0);
  await call(endpoint+'/chat',{text:'Keep the format concise.'});
  for(let i=0;i<100;i++){state=await call(endpoint);if(state.status!=='running')break;await new Promise(r=>setTimeout(r,50));}
  assert.equal(state.status,'draft');
  const memoryCall=async(path='',data)=>{const r=await fetch(url+'/api/memory'+path,data===undefined?{}:{method:'POST',headers:{'X-Studio':'1','Content-Type':'application/json'},body:JSON.stringify(data)});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;};
  const waitStudy=async()=>{for(let i=0;i<100;i++){state=await call(endpoint);if(state.status!=='running'&&!(await call(endpoint+'/chat-sessions',{op:'list'})).busy)return;await new Promise(r=>setTimeout(r,50));}throw Error('Study did not finish');};
  await call(endpoint+'/chat',{text:'I prefer quiet synthetic transitions.'});await waitStudy();
  let memories=await memoryCall('?chat=_learning_'+research.id);let lesson=memories.entries.find(m=>m.key==='transition-sound');assert(lesson);assert.equal(lesson.status,'pending');assert.equal((await memoryCall('/evidence?id='+lesson.id))[0].text,'I prefer quiet synthetic transitions.');
  lesson=await memoryCall('/action',{id:lesson.id,expected:lesson.revision,op:'approve'});
  await call(endpoint+'/chat',{text:'CHECK_MEMORY_CONTEXT'});await waitStudy();assert.equal(JSON.parse(readFileSync(join(studio,'.studio/learning/sessions',research.id,'work/memory-receipt.json'))).hasMemory,true);
  const recall=JSON.parse(execFileSync(process.execPath,[join(app,'bin/octopus.mjs'),'memory','search','quiet','--chat','_learning_'+research.id,'--json'],{env:{...env,STUDIO_URL:url},encoding:'utf8'}));assert.equal(recall.origin,'recall');assert(recall.results.some(e=>e.role==='user'));
  const found=await memoryCall('/search?scope='+encodeURIComponent(memories.scope)+'&q=quiet');assert(found.some(e=>e.role==='user'));
  await call(endpoint+'/chat-compact',{});await waitStudy();memories=await memoryCall('?chat=_learning_'+research.id);assert(memories.checkpoints.some(c=>c.reason==='before-compaction'));
  await memoryCall('/checkpoint',{chat:'_learning_'+research.id,reason:'project-complete'});
  await memoryCall('/forget-event',{id:lesson.evidence[0]});assert.equal((await memoryCall('?chat=_learning_'+research.id)).entries.find(m=>m.id===lesson.id).status,'forgotten');
  const archived=await call(endpoint+'/chat-sessions',{op:'new'});assert(archived.earlier.length);
  await call(endpoint+'/chat-sessions',{op:'open',log:archived.earlier[0].log});
  await call(endpoint+'/chat',{text:'Continue this exact research conversation.'});
  for(let i=0;i<100;i++){state=await call(endpoint);if(state.status!=='running')break;await new Promise(r=>setTimeout(r,50));}
  const receipt=JSON.parse(readFileSync(join(studio,'.studio/learning/sessions',research.id,'work/adapter-receipt.json')));assert.equal(receipt.resumed,true);
  const registered=await call(endpoint+'/references',{revision:state.revision,kind:'link',...suggestions[0]});assert.equal(registered.references.length,1);
  put(join(studio,'.studio/learning/sessions',research.id,'work/suggested-examples.json'),JSON.stringify([{url:'javascript:alert(1)'}]));await call(endpoint+'/suggestions',undefined,400);
 }
 let s=await call('/sessions',{formatId:f.id,name:'Synthetic reference study',focus:['scripting','visuals'],study:'overview'});
 s=await call(`/sessions/${s.id}/references`,{kind:'note',name:'Synthetic reference',note:'00:02: completed result appears before explanation.',revision:s.revision});
 const raw={rules:[{id:'opening',area:'scripting',text:'Show the finished result first.',confidence:'medium',evidence:[{referenceId:s.references[0].id,note:'00:02: the finished result is visible.'}]}],workflow:'Draft and review script.md. Use the approved guide, lock the cut, approve the plan, build scenes and stop for visual review.',assets:[]};
 put(join(studio,'.studio/learning/sessions',s.id,'work/proposal.json'),JSON.stringify(raw));
 const proposal=await call(`/sessions/${s.id}/proposal`);const v1=await call(`/sessions/${s.id}/approve`,{revision:proposal.revision,token:proposal.token,decisions:[{id:'opening',action:'keep'}]});assert(!v1.warning,v1.warning);
 await fetch(url+`/api/profiles/${p.id}/brand`,{method:'POST',headers:{'Content-Type':'application/json','X-Studio':'1'},body:JSON.stringify({brand:{identity:'Synthetic fixture brand'},expected:null})});
 const project=await call('/projects',{name:'Synthetic project',versionId:v1.id,entry:'script',brief:'Here is the result. Now let us build it.',build:'full'});
 const projectView=await (await fetch(url+`/api/projects/${project.id}`)).json();assert.equal(projectView.learning.versionId,v1.id);assert.equal(projectView.learning.entry,'script');
 const script=await (await fetch(url+`/api/projects/${project.id}/script`)).json();assert.match(script.text,/Here is the result/);
 await call(`/projects/${project.id}/plan-review`,{},400);
 let s2=await call('/sessions',{formatId:f.id,name:'Second study · review me',focus:['scripting','visuals'],study:'overview'});s2=await call(`/sessions/${s2.id}/references`,{kind:'note',name:'Synthetic reference two',note:'00:04: hold on the useful outcome.',revision:s2.revision});
 const raw2={...raw,rules:[{...raw.rules[0],text:'Show the finished result, then pause.',evidence:[{referenceId:s2.references[0].id,note:'00:04: the outcome is held for inspection.'}]}]};put(join(studio,'.studio/learning/sessions',s2.id,'work/proposal.json'),JSON.stringify(raw2));
 const projectPath=join(studio,'projects',project.id);put(join(projectPath,'work/edl_manual.json'),JSON.stringify({segments_sec:[[0,2]]}));put(join(projectPath,'WORKLOG.md'),'Cut locked (join-check: 0 joins, 0 clipped)');put(join(projectPath,'work/production.json'),JSON.stringify({scenes:[{id:'scene-1',text:'Synthetic scene'}]}));const plan=await call(`/projects/${project.id}/plan-review`,{});await call(`/projects/${project.id}/approve-plan`,{token:plan.token});assert((await call(`/projects/${project.id}/plan-review`,{})).approved);put(join(projectPath,'work/production.json'),JSON.stringify({scenes:[{id:'scene-1',text:'Changed scene'}]}));assert.equal((await call(`/projects/${project.id}/plan-review`,{})).approved,false);
 if(process.env.OCTOPUS_TEST_FFMPEG){const media=join(root,'reference.mp4');execFileSync(process.env.OCTOPUS_TEST_FFMPEG,['-v','error','-f','lavfi','-i','color=c=blue:s=320x180:r=8','-t','2','-c:v','libx264','-pix_fmt','yuv420p',media]);let ex=await call('/sessions',{formatId:f.id,name:'Extraction fixture',focus:['visuals'],study:'detailed'});const upload=await fetch(url+`/api/learning/sessions/${ex.id}/upload?revision=${ex.revision}&name=reference.mp4`,{method:'POST',headers:{'X-Studio':'1'},body:readFileSync(media)});assert.equal(upload.status,200);await call(`/sessions/${ex.id}/extract`,{});let result;for(let i=0;i<100;i++){result=await call(`/sessions/${ex.id}/extraction`);if(result.status!=='running')break;await new Promise(r=>setTimeout(r,50));}assert.equal(result.status,'complete',result.error);const report=JSON.parse(readFileSync(join(studio,'.studio/learning/sessions',ex.id,'work/extraction.json')));assert.equal(report.references[0].frames,8);await call(`/sessions/${ex.id}/extract`,{});for(let i=0;i<100;i++){result=await call(`/sessions/${ex.id}/extraction`);if(result.status!=='running')break;await new Promise(r=>setTimeout(r,50));}assert.equal(result.status,'complete');}
 let sk=await call('/skills');assert(sk.items.every(x=>x.summary?.length));assert.match(sk.items.find(x=>x.name.startsWith('learned-')).summary,/Approved scripting guidance/);const summaryCore=sk.items.find(x=>x.kind==='core'),summaryText=(await call(`/skills/${summaryCore.id}`)).text;sk=await call(`/skills/${summaryCore.id}`,{action:'describe',revision:sk.revision,summary:summaryCore.summary});assert.equal(sk.items.find(x=>x.id===summaryCore.id).kind,'core');assert.match(sk.items.find(x=>x.id==='octopus.rough-cut').summary,/Proposes cuts/);assert.equal((await call(`/skills/${summaryCore.id}`)).text,summaryText);assert(sk.items.some(x=>x.kind==='personal'));assert(sk.items.some(x=>x.kind==='core'));const c=sk.items.find(x=>x.kind==='core'),content=await call(`/skills/${c.id}`);const edited=await call(`/skills/${c.id}`,{action:'edit',revision:content.revision,text:content.text+'\nSynthetic creator preference.\n'});assert(edited.items.some(x=>x.id===c.id&&x.kind==='customized-core'));
 const backup=await call('/backup',{});assert(backup.path);
 const preview=await call(`/backups/${backup.id}/preview`,{});assert.equal(preview.missingPins.length,0);const restored=await call(`/backups/${backup.id}/restore`,{token:preview.token});assert(restored.ok);assert(!restored.warning,restored.warning);assert.equal((await call('/skills')).storage,'sqlite');
 const rejected=await fetch(url+'/api/learning/profiles',{method:'POST',headers:{'Content-Type':'application/json','Origin':'https://example.invalid'},body:JSON.stringify({name:'blocked'})});assert.equal(rejected.status,403);
 if(process.env.OCTOPUS_TEST_AGENT==='1'){
  let agentSession=await call('/sessions',{formatId:f.id,name:'Fake agent lifecycle'});agentSession=await call(`/sessions/${agentSession.id}/references`,{kind:'note',name:'Synthetic evidence',note:'00:02: the result appears.',revision:agentSession.revision});
  assert.equal(agentSession.autoFocus,true);assert.equal(agentSession.focus.length,6);
  const priorRevision=agentSession.revision;agentSession=await call(`/sessions/${agentSession.id}/configure`,{revision:priorRevision,direction:'Notice the opening',study:'overview'});
  await call(`/sessions/${agentSession.id}/configure`,{revision:priorRevision,name:'Stale edit'},400);
  await call(`/sessions/${agentSession.id}/run`,{revision:agentSession.revision});let finished;
  for(let i=0;i<100;i++){finished=await call(`/sessions/${agentSession.id}`);if(finished.status!=='running')break;await new Promise(r=>setTimeout(r,50));}
  assert.equal(finished.status,'review',finished.error);const output=await call(`/sessions/${agentSession.id}/proposal`);assert.equal(output.rules[0].evidence[0].referenceId,agentSession.references[0].id);
  const receipt=JSON.parse(readFileSync(join(studio,'.studio/learning/sessions',agentSession.id,'work/adapter-receipt.json')));assert.equal(receipt.mode,'manual');assert(receipt.contextContainsFormat&&receipt.contextContainsReference);
  assert.equal(finished.direction,'Notice the opening');
  const approved=await call(`/sessions/${agentSession.id}/approve`,{revision:output.revision,token:output.token,decisions:[{id:'opening',action:'keep'}]});assert(approved.id);assert(!approved.warning,approved.warning);
 }
 const appCall=async(path,data)=>{const r=await fetch(url+'/api/'+path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Studio':'1'},body:JSON.stringify(data)});const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));return j;};
 const alpha=await appCall('profiles',{name:'Alpha test brand'}),beta=await appCall('profiles',{name:'Beta test brand'});
 await appCall(`profiles/${beta.id}/brand`,{brand:{identity:'Beta identity stays separate'},expected:null});
 const beforeResearch=await appCall('instructions');await appCall('instructions',{files:{...beforeResearch.current.files,'PROMPT.md':'SHARED_NOTES_RESEARCH_SENTINEL'},expected:beforeResearch.current.id});
 if(process.env.OCTOPUS_TEST_AGENT==='1'){
  const research=await appCall(`profiles/${alpha.id}/research`,{url:'https://example.com/alpha',direction:'Synthetic brand fixture'});
  await appCall(`profile-research/${research.id}/run`,{revision:research.revision});let state;
  for(let i=0;i<100;i++){state=await appCall(`profile-research/${research.id}`);if(state.status!=='running')break;await new Promise(r=>setTimeout(r,50));}assert.equal(state.status,'review',state.error);
  const proposal=await appCall(`profile-research/${research.id}/proposal`);await appCall(`profile-research/${research.id}/approve`,proposal);
  const receipt=JSON.parse(readFileSync(join(studio,'.studio/brand-research',research.id,'work/adapter-receipt.json')));assert(receipt.isBrand);assert.equal(receipt.mode,'manual');assert.equal(receipt.hasSharedPrivate,false);
 }else await appCall(`profiles/${alpha.id}/brand`,{brand:{identity:'Alpha research identity',colors:['#123456']},expected:null});
 const all=await appCall('profiles');assert.equal(all.profiles.find(x=>x.id===beta.id).brand.brand.identity,'Beta identity stays separate');
 const instructions=await appCall('instructions');await appCall('instructions',{files:{...instructions.current.files,'PROMPT.md':'Synthetic studio rule: preserve originals.'},expected:instructions.current.id});
 // Saved formats are usable before optional brand research and style study.
 const basicProfile=await appCall('profiles',{name:'Basic setup fixture'});
 const basicFormat=await call('/formats',{profileId:basicProfile.id,name:'Narrated basics',type:'faceless'});
 const basicPreview=await appCall('video-context',{profileId:basicProfile.id,formatId:basicFormat.id,type:'faceless'});
 assert.equal(basicPreview.brandVersion,null);assert.equal(basicPreview.versionId,null);
 const basicVideo=await appCall('projects',{name:'Basic format video',profileId:basicProfile.id,formatId:basicFormat.id,type:'faceless',contextExpected:basicPreview});
 const basicPin=await appCall(`project-context/${basicVideo.id}`);assert.equal(basicPin.bundle.formatId,basicFormat.id);assert.equal(basicPin.bundle.formatName,'Narrated basics');assert.deepEqual(basicPin.brand,{});
 assert.equal((await appCall(`projects/${basicVideo.id}`)).type,'faceless');
 await appCall(`profiles/${basicProfile.id}/brand`,{brand:{identity:'Later brand',colors:['#112233']},expected:null});
 assert.deepEqual((await appCall(`project-context/${basicVideo.id}`)).brand,{});
 assert.deepEqual((await appCall(`projects/${basicVideo.id}`)).brandColors,[]);
 const staleBasic=await fetch(url+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json','X-Studio':'1'},body:JSON.stringify({name:'Stale basic setup',profileId:basicProfile.id,formatId:basicFormat.id,type:'faceless',contextExpected:basicPreview})});assert.equal(staleBasic.status,400);
 const previewContext=await appCall('video-context',{profileId:alpha.id,type:'short'});
 const newVideo=await appCall('projects',{name:'Profile context API check',type:'short',profileId:alpha.id,contextExpected:previewContext});
 const pinned=await appCall(`project-context/${newVideo.id}`);assert.equal(pinned.brand.identity,'Alpha research identity');assert.match(pinned.instructions['PROMPT.md'],/preserve originals/);assert.equal(pinned.bundle.skills.length,6);assert.equal((await appCall(`projects/${newVideo.id}`)).brandColors[0],'#123456');
 const oldBrand=all.profiles.find(x=>x.id===alpha.id).brand.id;await appCall(`profiles/${alpha.id}/brand`,{brand:{identity:'New Alpha for new projects'},expected:oldBrand});assert.equal((await appCall(`project-context/${newVideo.id}`)).brand.identity,'Alpha research identity');
 if(process.env.OCTOPUS_TEST_AGENT==='1'){
  put(join(local,'profile.json'),JSON.stringify({brand:'SYNTHETIC_CONTEXT_ISOLATION_SENTINEL'}));put(join(studio,'BRAND.md'),'SYNTHETIC_CONTEXT_ISOLATION_SENTINEL');
  await appCall(`projects/${newVideo.id}/chat`,{text:'Verify the synthetic selected project context.'});const receiptPath=join(studio,'projects',newVideo.id,'work/adapter-receipt.json');
  for(let i=0;i<100;i++){try{const r=JSON.parse(readFileSync(receiptPath));assert(r.projectPinned&&r.hasAlpha);assert.equal(r.hasLegacy,false);break;}catch(e){if(i===99)throw e;await new Promise(r=>setTimeout(r,50));}}
 }
 const sourceFormat=(await call()).formats.find(x=>x.id===f.id);
 await call(`/formats/${f.id}/copy`,{profileId:beta.id,name:'Missing review',expected:sourceFormat.activeVersion},400);
 const copied=await call(`/formats/${f.id}/copy`,{profileId:beta.id,name:'Reused synthetic format',expected:sourceFormat.activeVersion,reviewed:true});
 assert.equal(copied.profileId,beta.id);assert.notEqual(copied.activeVersion,sourceFormat.activeVersion);
 const copiedContext=await appCall('video-context',{profileId:beta.id,formatId:copied.id,type:copied.type});
 const copiedVideo=await appCall('projects',{name:'Copied format project',profileId:beta.id,formatId:copied.id,type:copied.type,contextExpected:copiedContext});
 const copiedPin=await appCall(`project-context/${copiedVideo.id}`);assert.equal(copiedPin.brand.identity,'Beta identity stays separate');assert.equal(copiedPin.bundle.versionId,copied.activeVersion);
 const originalIndex=readFileSync(join(studio,'library/sfx/INDEX.md'),'utf8');
 let catalog=await appCall('library/sound-catalog');assert.equal(catalog.storage,'sqlite');let old=catalog.items.find(x=>x.name==='legacy.wav');assert(old);assert.equal(old.status,'approved');
 const changed=await appCall('library/sound-edit',{file:old.file,revision:old.revision,note:'Catalog description',source:'Synthetic fixture',licence:'CC0 fixture',tags:['whoosh','page']});assert.equal(changed.revision,old.revision+1);
 const stale=await fetch(url+'/api/library/sound-edit',{method:'POST',headers:{'Content-Type':'application/json','X-Studio':'1'},body:JSON.stringify({file:old.file,revision:old.revision,note:'stale'})});assert.equal(stale.status,400);
 let candidate=catalog.items.find(x=>x.name==='candidate.wav');assert.equal(candidate.status,'pending');const approvedSound=await appCall('library/sound-approve',{file:candidate.file,revision:candidate.revision});assert.equal(approvedSound.file,candidate.file);
 const cue=await appCall(`projects/${project.id}/sfx`,{op:'add',file:approvedSound.file,from:'library',t:0,gain:-3});assert.equal(cue.cues[0].file,candidate.file);
 const oldCues=readFileSync(join(studio,'projects',project.id,'work/sfx.json'),'utf8');catalog=await appCall('library/sound-catalog');assert.equal(readFileSync(join(studio,'projects',project.id,'work/sfx.json'),'utf8'),oldCues);assert.equal(readFileSync(join(studio,'library/sfx/INDEX.md'),'utf8'),originalIndex);assert.deepEqual(readFileSync(join(studio,'library',candidate.file)),wav);
 const cli=JSON.parse(execFileSync(process.execPath,[join(app,'bin/octopus.mjs'),'library','sounds','--json'],{env:{...env,STUDIO_URL:url},encoding:'utf8'}));assert.equal(cli.items.find(x=>x.id===old.id).note,'Catalog description');assert(cli.items.find(x=>x.id===old.id).path.endsWith('library/sfx/legacy.wav'));
 const soundBackup=await call('/backup',{}),soundPreview=await call(`/backups/${soundBackup.id}/preview`,{});assert.equal(soundPreview.counts.sound_assets,2);
 const upload=await fetch(url+'/api/library/upload?kind=sfx&name=uploaded.wav',{method:'POST',headers:{'X-Studio':'1'},body:wav});assert.equal(upload.status,200);assert((await appCall('library')).kinds.find(x=>x.key==='sfx').items.some(x=>x.name==='uploaded.wav'));
 const counts=await appCall('app/counts');assert.equal(counts.update,0,'Skill notices must not appear as app updates');
 const info={root,app,studio,url,project:project.id,session:s2.id,checks:['Scoped memory capture, evidence review, approval, live context refresh, FTS search, compaction and completion checkpoints, forgetting','Chat before examples, retained conversation, reviewed suggestions and unsafe URL rejection','Provider-scoped usage events; persisted stale reading ignored','SQLite sound metadata migration, edit and stale-write protection','Sound approval preserves audio and cue paths; agent CLI reads catalog','Sound metadata backup and upload registration','Cross-profile format copy with destination brand and independent version','App update badge count excludes skill notices','Profile and format creation','Standalone learning and reference intake','Evidence-backed approval and skill publication','Project version pin and script handoff','Scene plan approval and invalidation','Core versus personal ownership and skill editing','Database backup and verified restore','Cross-origin write rejection','Profile-isolated brand research and approval','New video pins brand, instructions and selected skill content','Project context excludes legacy brand identity',...(process.env.OCTOPUS_TEST_AGENT==='1'?['Actual learning adapter with fake agent, manual permissions, proposal and approval']:[]),...(process.env.OCTOPUS_TEST_FFMPEG?['Synthetic video frame extraction','Extraction resumes completed references']:[])]};put(join(root,'fixture.json'),JSON.stringify(info,null,2));put('/tmp/octopus-learning-fixture.json',JSON.stringify(info,null,2));console.log(JSON.stringify(info,null,2));console.log('PASS: API lifecycle, skill database edit, pinned context, script, backup and origin gate');
 if(process.argv.includes('--serve')){console.log('Disposable fixture left running for browser verification.');await new Promise(resolve=>{process.on('SIGTERM',resolve);process.on('SIGINT',resolve);});}
}catch(e){console.error(e);console.error(logs);process.exitCode=1;}finally{child.kill('SIGTERM');}

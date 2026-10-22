// Bounded local frame extraction. No downloads, providers or model installers.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LearningStore, safeFile } from './learning-store.mjs';
import { studioTool } from './util.mjs';
const jobs=new Map();
const key=(studio,id)=>`${studio}:${id}`;
export const extractionBusy=()=>[...jobs.values()].some(j=>j.status==='running');
export function stopExtraction(studio,id){const j=jobs.get(key(studio,id));if(j){j.cancelled=true;j.child?.kill('SIGTERM');}return Boolean(j);}
export function stopAllExtractions(){for(const j of jobs.values()){j.cancelled=true;j.child?.kill('SIGTERM');}}
export function extractionStatus(studio,id){const j=jobs.get(key(studio,id));return j?{status:j.status,completed:j.completed,total:j.total,error:j.error}:null;}
function command(j,bin,args){return new Promise((ok,no)=>{if(j.cancelled)return no(Error('Cancelled'));const child=spawn(bin,args,{stdio:['ignore','pipe','pipe'],windowsHide:true});j.child=child;let out='',err='',settled=false;const timer=setTimeout(()=>child.kill('SIGTERM'),120000);const finish=(e)=>{if(settled)return;settled=true;clearTimeout(timer);j.child=null;e?no(e):ok(out);};child.stdout.on('data',b=>{if(out.length<1000000)out+=b;});child.stderr.on('data',b=>{err=(err+b).slice(-2000);});child.on('error',finish);child.on('close',code=>finish(j.cancelled?Error('Cancelled'):code?Error(err||`Media tool exited ${code}`):null));});}
export function startExtraction(studio,id){
 const k=key(studio,id);if(jobs.get(k)?.status==='running')throw Error('Reference extraction is already running.');
 const st=new LearningStore(studio);let session,folder;try{session=st.get('sessions',id);folder=st.sessionDir(id);if(session.status==='running')throw Error('Finish the current study before extracting references.');}finally{st.close();}
 const j={status:'running',completed:0,total:session.references.filter(r=>r.kind==='file'&&/\.(mp4|mov|m4v|webm)$/i.test(r.name)).length,cancelled:false};jobs.set(k,j);
 j.promise=(async()=>{
  const report=[];let remaining=2400;
  for(const ref of session.references){if(ref.kind!=='file'||!/\.(mp4|mov|m4v|webm)$/i.test(ref.name))continue;if(j.cancelled)throw Error('Cancelled');
   const input=safeFile(folder,ref.file);if(createHash('sha256').update(readFileSync(input)).digest('hex')!==ref.sha256)throw Error('A reference copy changed. Add it again before analysis.');
   const dest=safeFile(folder,`work/frames/${ref.id}`);mkdirSync(dest,{recursive:true});const receipt=safeFile(dest,'coverage.json');
   if(existsSync(receipt)){const prior=JSON.parse(readFileSync(receipt));if(prior.source===ref.sha256&&prior.study===session.study&&readdirSync(dest).filter(x=>/^frame-\d+\.jpg$/.test(x)).length===prior.frames){report.push(prior);j.completed++;remaining-=prior.frames;continue;}}
   const info=JSON.parse(await command(j,studioTool('ffprobe'),['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration','-of','json',input])),duration=Number(info.format?.duration);
   if(!Number.isFinite(duration)||duration<=0)throw Error(`Cannot measure ${ref.name}.`);
   if(remaining<=0){report.push({referenceId:ref.id,unexamined:'Session frame budget reached.'});continue;}
   const fps=session.study==='detailed'?4:Math.min(1,30/duration),seconds=Math.min(duration,remaining/fps,session.study==='detailed'?300:duration),frames=Math.min(remaining,Math.ceil(seconds*fps));
   await command(j,studioTool('ffmpeg'),['-nostdin','-v','error','-y','-protocol_whitelist','file,pipe','-i',input,'-t',String(seconds),'-vf',`fps=${fps},scale=640:-2`,'-frames:v',String(frames),'-q:v','5',safeFile(dest,'frame-%06d.jpg')]);
   const count=readdirSync(dest).filter(x=>/^frame-\d+\.jpg$/.test(x)).length;
   const coverage={referenceId:ref.id,source:ref.sha256,study:session.study,duration,examinedFrom:0,examinedTo:seconds,fps,frames:count,timestampRule:'frame N is sampled near (N-1)/fps seconds; verify precise events against the original',unexamined:seconds<duration?`${seconds}–${duration} seconds were not extracted`:null};
   writeFileSync(receipt,JSON.stringify(coverage,null,2));report.push(coverage);remaining-=count;j.completed++;
  }
  writeFileSync(safeFile(folder,'work/extraction.json'),JSON.stringify({references:report,frameLimit:2400,created:new Date().toISOString()},null,2));j.status='complete';
 })().catch(e=>{j.status=j.cancelled?'cancelled':'failed';j.error=e.message;});
 return extractionStatus(studio,id);
}

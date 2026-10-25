// Cut Editor: Video Octopus's Cut tab. index.html?theme=studio loads this file (and studio.css) before its own script, which
// then calls studioSetup(); opened on its own the page never loads it. Everything here runs in the page's own scope
// (kept, words, cut(), save() …), so the edits Video Octopus asks for are the page's own edits. The page is served by
// Video Octopus itself (web/cut-editor/), so its fonts come from /fonts/ and its messages stay on this one address.

// The waveform and fine-trim colours in Video Octopus's light look (index.html's PAL has the page's own dark ones).
const PAL_STUDIO={ruler:'#737378',mono:'"Geist Mono",ui-monospace,Menlo,monospace',sans:'Geist,-apple-system,system-ui,sans-serif',sans2:'Geist,-apple-system,system-ui',
 join:'rgba(142,141,136,.75)',hoverSide:'rgba(194,65,12,.12)',acc:'#c2410c',tip:'rgba(26,26,28,.88)',tipInk:'#fff',cutFill:'rgba(26,26,28,.045)',cutHatch:'rgba(26,26,28,.09)',cutEdge:'#b5b4af',clip:'#dc2626',check:'#d97706',
 pkK:'#d6d5d0',pkC:'#ecebe7',rmK:'#8e8d88',rmC:'#d6d5d0',bubSel:'rgba(37,99,235,.16)',bub:'rgba(194,65,12,.07)',bubSelLine:'#2563eb',bubLine:'rgba(194,65,12,.32)',bubInk:'#1a1a1c',
 barK:'rgba(194,65,12,.55)',barC:'rgba(26,26,28,.18)',wK:'#1a1a1c',wC:'#a1a09b',leadK:'rgba(194,65,12,.3)',leadC:'rgba(26,26,28,.12)',hlTrim:'rgba(220,38,38,.16)',hlBack:'rgba(37,99,235,.14)',hlTrimTag:'#dc2626',hlBackTag:'#2563eb',
 selFill:'rgba(37,99,235,.10)',selEdge:'#2563eb',flagMine:'#c2410c',flagOther:'rgba(115,115,120,.8)',head:'#c2410c',
 lensRow:'#f6f6f4',lpkK:'#d6d5d0',lpkC:'#ecebe7',lrmK:'#8e8d88',lrmC:'#d6d5d0',lwK:'rgba(194,65,12,.10)',lwC:'rgba(26,26,28,.04)',lwInkK:'#1a1a1c',lwInkC:'#a1a09b',lOrig:'#a1a09b',lTip:'rgba(26,26,28,.85)'};

// ---- Video Octopus's look (Settings → Appearance) ----
// Video Octopus passes its look as &look=<id> and, for any look but Edit Bay, the look's colours (as rgba()), radii and fonts
// after #look=, so the page paints in it from the start; then a studio:look message on every change. The page's own
// colours (studio.css, html.studio[data-look]) and the waveform's (PAL_STUDIO) follow it. With no look, or Edit Bay,
// nothing here applies and the page keeps the light theme above, exactly as before.
const PAL_BASE={...PAL_STUDIO};
let LOOK_VARS=[];
const lkParse=c=>{const m=/^rgba?\(([^)]+)\)$/.exec(String(c||'').trim());if(!m)return null;const p=m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
 return p.length>=3&&p.every(Number.isFinite)?[p[0],p[1],p[2],p.length>3?Math.max(0,Math.min(1,p[3])):1]:null};
const lkStr=([r,g,b,a])=>`rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(3)})`;
const lkOver=(t,b)=>{const a=t[3]+b[3]*(1-t[3]);return a?[0,1,2].map(i=>(t[i]*t[3]+b[i]*b[3]*(1-t[3]))/a).concat(a):[0,0,0,0]};
function applyStudioLook(L){
 const root=document.documentElement,id=L&&typeof L.id==='string'?L.id:'';
 const C={};if(L&&L.c&&typeof L.c==='object')for(const [k,v] of Object.entries(L.c)){const x=lkParse(v);if(x)C[k]=x}
 for(const k of LOOK_VARS)root.style.removeProperty(k);LOOK_VARS=[];document.getElementById('lookFonts')?.remove();
 if(!/^[a-z]{2,20}$/.test(id)||id==='editbay'||!['bg','panel','text','muted','faint','accent','sel'].every(k=>C[k])){
  delete root.dataset.look;root.style.removeProperty('color-scheme');Object.assign(PAL_STUDIO,PAL_BASE);lookRedraw();return}
 const dark=!!L.dark,clear=!!L.clear,tx=C.text,bg=C.bg,A=(c,a)=>lkStr([c[0],c[1],c[2],c[3]*a]),get=(k,f)=>C[k]||C[f]||tx;
 // the panel as it shows (over the ground), for the canvas colours that must be solid
 const base=lkOver(C.panel,bg[3]<1?[bg[0],bg[1],bg[2],1]:bg),on=(c,a)=>clear?A(c,a):lkStr(lkOver([c[0],c[1],c[2],c[3]*a],base));
 const font=s=>typeof s==='string'&&/^[\w\s"',.-]{1,200}$/.test(s)?s:null,px=s=>typeof s==='string'&&/^\d{1,3}(\.\d+)?px$/.test(s)?s:null;
 const V={'--bg':clear?'transparent':lkStr(bg),'--panel':lkStr(C.panel),'--line':lkStr(get('line')),'--line2':lkStr(get('line2','line')),'--ink':lkStr(tx),'--dim':lkStr(C.muted),'--faint':lkStr(C.faint),
  '--acc':lkStr(get('accentText','accent')),'--sel':A(C.sel,.22),'--selb':lkStr(C.sel),'--cut':A(tx,.06),
  '--lk-panel2':lkStr(get('panel2','panel')),'--lk-panel3':lkStr(get('panel3','panel2')),'--lk-text2':lkStr(get('text2')),'--lk-hi':lkStr(get('textHi')),
  '--lk-pri':lkStr(tx),'--lk-pri-ink':lkStr([bg[0],bg[1],bg[2],1]),'--lk-accent':lkStr(C.accent),'--lk-accent-ink':lkStr(get('accentInk','bg')),'--lk-accent-soft':lkStr(get('accentSoft','sel')),
  '--lk-sel-text':lkStr(get('selText')),'--lk-sel-wash':A(C.sel,.16),'--lk-ok':lkStr(get('okInk','ok')),'--lk-warn':lkStr(get('warn')),'--lk-warn-soft':A(get('warn'),dark?.2:.16),
  '--lk-bad':lkStr(get('bad')),'--lk-bad-ink':lkStr(get('badInk','bad')),'--lk-bad-soft':A(get('bad'),dark?.22:.14),'--lk-check':lkStr(get('check')),'--lk-pop':lkStr(get('pop','panel')),
  '--lk-line-hover':A(tx,.3),'--lk-scroll':A(tx,.2),'--lk-shadow':dark?'0 16px 40px -12px rgba(0,0,0,.7),0 0 0 1px '+A(tx,.1):'0 16px 40px -12px '+A(tx,.22)+',0 0 0 1px '+A(tx,.06)};
 const sans=font(L.font),mono=font(L.mono),ctl=px(L.ctl),card=px(L.card);
 if(sans)V['--sans']=sans;if(mono)V['--mono']=mono;V['--lk-ctl']=ctl?`min(${ctl},16px)`:'8px';V['--lk-card']=card||'14px';
 for(const [k,v] of Object.entries(V)){root.style.setProperty(k,v);LOOK_VARS.push(k)}
 root.dataset.look=id;root.style.colorScheme=dark?'dark':'light';
 // the look's fonts, from Video Octopus's own files
 if(Array.isArray(L.f)){const css=L.f.filter(f=>Array.isArray(f)&&/^[\w ]{1,40}$/.test(f[0])&&/^[a-z0-9-]{1,80}\.woff2$/.test(f[1])&&/^\d{3}( \d{3})?$/.test(f[2])&&/^(normal|italic)$/.test(f[3]))
  .map(([fam,file,w,st])=>`@font-face{font-family:"${fam}";src:url("/fonts/${file}") format("woff2");font-weight:${w};font-style:${st};font-display:swap}`).join('');
  if(css){const el=document.createElement('style');el.id='lookFonts';el.textContent=css;document.head.append(el)}}
 // the waveform and fine trim: the light theme's roles in the look's colours
 const ac=C.accent,se=C.sel,wave=C.wave||[tx[0],tx[1],tx[2],.6],mute=C.faint,ss=sans||PAL_BASE.sans,mm=mono||PAL_BASE.mono;
 Object.assign(PAL_STUDIO,{ruler:lkStr(C.faint),mono:mm,sans:ss,sans2:ss,join:A(tx,.4),hoverSide:A(ac,dark?.16:.12),acc:lkStr(get('accentText','accent')),tip:A(tx,.9),tipInk:lkStr([bg[0],bg[1],bg[2],1]),
  cutFill:A(tx,dark?.05:.045),cutHatch:A(tx,dark?.1:.09),cutEdge:lkStr(mute),clip:lkStr(get('bad')),check:lkStr(get('warn')),
  pkK:on(wave,.38),pkC:on(wave,.16),rmK:on(wave,1),rmC:on(wave,.36),bubSel:A(se,dark?.3:.16),bub:A(ac,dark?.16:.08),bubSelLine:lkStr(se),bubLine:A(ac,dark?.5:.34),bubInk:lkStr(tx),
  barK:A(ac,.6),barC:A(tx,.2),wK:lkStr(tx),wC:lkStr(mute),leadK:A(ac,.32),leadC:A(tx,.14),hlTrim:A(get('bad'),dark?.3:.16),hlBack:A(se,dark?.28:.14),hlTrimTag:lkStr(get('bad')),hlBackTag:lkStr(se),
  selFill:A(se,dark?.2:.1),selEdge:lkStr(se),flagMine:lkStr(ac),flagOther:A(mute,.85),head:lkStr(get('playhead','accent')),
  lensRow:on(get('panel2','panel'),1),lpkK:on(wave,.38),lpkC:on(wave,.14),lrmK:on(wave,1),lrmC:on(wave,.32),lwK:A(ac,dark?.22:.1),lwC:A(tx,dark?.08:.04),lwInkK:lkStr(tx),lwInkC:lkStr(mute),lOrig:lkStr(mute),lTip:A(tx,.9)});
 lookRedraw()}
function lookRedraw(){try{if(typeof draw==='function')draw();if(typeof drawLens==='function')drawLens()}catch(e){}}
// at load: the look in the address (#look=…), before the page paints
(()=>{const id=new URLSearchParams(location.search).get('look');if(!id||id==='editbay')return;
 try{const m=/(?:^#|&)look=([^&]*)/.exec(location.hash);if(m)applyStudioLook(JSON.parse(decodeURIComponent(m[1])))}catch(e){}})();

// ---- Inside Video Octopus's Cut tab (?theme=studio) ----
// Video Octopus's light look and fonts, a tidier header (Edit, Options and Keys menus), paragraph times, "pause
// 2.7 s" chips where a pause was cut, join marks and "needs your ear" highlights in the transcript, and a line to
// Video Octopus's Cut inspector: the selection and the cut go up as they change; Cut it, Bring back, Play, Keep / Cut and
// "save now" come back and run as this page's own edits (so undo, autosave and the change package work as usual).
// Opened on its own (no ?theme=studio) none of this runs.
let PT=[],CH=[],EAR=[],stT=null;
function toStudio(m){if(!STUDIO||parent===window)return;try{parent.postMessage(m,location.origin)}catch(e){}}
function studioTx(){PT=[];CH=new Array(words.length+1).fill(null);const jm=new Map();
 // long paragraphs (the page breaks only at pauses over 1.4 s) also break at the first sentence end after 20 s
 for(const p of [...document.querySelectorAll('#tx p')]){let q=p,t0=null;for(const el of [...p.querySelectorAll('.w')]){const w=words[+el.dataset.i];if(t0===null)t0=w[0];
  if(w[1]-t0>=20&&/[.?!]["”’')\]]*$/.test(w[2])&&el.nextSibling&&el.nextSibling.nextSibling){const np=document.createElement('p');q.after(np);let n=el.nextSibling.nextSibling;while(n){const nx=n.nextSibling;np.appendChild(n);n=nx}q=np;t0=null}}}
 for(const j of (D.joins||[])){if(j.status==='ok')continue;const i=words.findIndex(w=>w[0]>=j.src_in-.15);if(i<0)continue;if(!jm.has(i))jm.set(i,[]);jm.get(i).push(j)}
 document.querySelectorAll('#tx p').forEach(p=>{const w=p.querySelector('.w');if(!w)return;const s=document.createElement('span');s.className='ptime';s.dataset.i=w.dataset.i;
  s.onclick=()=>{const t=words[+s.dataset.i][0];v.pause();v.currentTime=t;centre(t);refresh()};p.prepend(s);PT.push(s)});
 document.querySelectorAll('#tx .w').forEach(el=>{const i=+el.dataset.i;
  for(const j of jm.get(i)||[]){const m=document.createElement('span');m.className='jmark'+(j.status==='likely clipped'?' bad':'');
   m.title=`Join ${j.status}${(j.in&&j.in.why&&j.in.why.length)||(j.out&&j.out.why&&j.out.why.length)?': '+[...(j.out?.why||[]),...(j.in?.why||[])].join('; '):''} · N jumps to the next one`;el.before(m)}
  const c=document.createElement('span');c.className='pchip';c.hidden=true;el.after(c);CH[i+1]=c});
 const f=document.querySelector('#tx .w');if(f){const c=document.createElement('span');c.className='pchip';c.hidden=true;f.before(c);CH[0]=c}
 setEar(EAR);drawShots()}
const mmss=t=>{const m=Math.floor(t/60);return `${m}:${String(Math.floor(t-m*60)).padStart(2,'0')}`};
function studioRefresh(){
 for(const s of PT){const w=words[+s.dataset.i],t=edTime(w[0]),txt=mmss(t);if(s.textContent!==txt){s.textContent=txt;s.title=`${fmt(t)} in the cut · ${fmt(w[0])} in the take`}}
 // where the cut removes half a second or more of the silence between two words (one of them kept): a chip
 const n=words.length;let j=0;
 for(let i=0;i<=n;i++){const c=CH[i];if(!c)continue;const a=i?words[i-1][1]:0,b=i<n?words[i][0]:D.duration;let txt='',tip='';
  if(b-a>=.5){while(j<kept.length&&kept[j][1]<=a)j++;let k=0;for(let m=j;m<kept.length&&kept[m][0]<b;m++)k+=Math.min(b,kept[m][1])-Math.max(a,kept[m][0]);const r=b-a-k;
   const nb=(i>0&&inKept((words[i-1][0]+words[i-1][1])/2))||(i<n&&inKept((words[i][0]+words[i][1])/2));
   if(r>=.5&&nb){txt=`pause ${r.toFixed(1)} s`;tip=`${r.toFixed(2)} s of a ${(b-a).toFixed(2)} s pause cut`}}
  if(c.textContent!==txt){c.textContent=txt;c.title=tip;c.hidden=!txt}}
 studioState()}
// Video Octopus's "needs your ear" items: [{a, b, join, done}] in take seconds; open ones mark their words amber.
function setEar(items){EAR=items||[];if(!words.length)return;const on=new Set();
 for(const it of EAR){if(it.done)continue;const lo=it.join?it.b-.05:it.a,hi=it.join?it.b+.2:it.b;words.forEach((w,i)=>{if(w[1]>lo+.01&&w[0]<hi-.01)on.add(i)})}
 document.querySelectorAll('#tx .w').forEach(el=>el.classList.toggle('ear',on.has(+el.dataset.i)))}
function selInfo(){if(!sel)return null;const [a,b]=sel,ws=words.filter(w=>w[1]>a+.01&&w[0]<b-.01);let k=0;const w0=ws.length?+ws[0][0].toFixed(3):null;
 for(const [p,q] of kept){if(q<=a)continue;if(p>=b)break;k+=Math.min(b,q)-Math.max(a,p)}const len=b-a;
 return {a:+a.toFixed(3),b:+b.toFixed(3),len:+len.toFixed(3),words:ws.length,text:ws.map(w=>w[2]).join(' ').slice(0,400),ea:+edTime(a).toFixed(3),eb:+edTime(b).toFixed(3),w0,state:k>=len*.9-.005?'kept':k<=len*.15+.005?'cut':'mixed'}}
function studioState(){if(!STUDIO||parent===window||!D||stT)return;stT=setTimeout(()=>{stT=null;
 toStudio({type:'studio:cut-state',segments:kept.map(([a,b])=>[+a.toFixed(3),+b.toFixed(3)]),length:+edLen().toFixed(3),duration:D.duration,sel:selInfo()})},120)}
function studioReady(){toStudio({type:'studio:cut-ready'});studioState()}
// edited seconds → take seconds, whatever "Collapse cuts" is set to
function srcAtE(e){cum();if(!kept.length)return 0;let lo=0,hi=CUM.length-1;while(lo<hi){const m=(lo+hi+1)>>1;if(CUM[m]<=e)lo=m;else hi=m-1}const [a,b]=kept[lo];return Math.min(b,a+Math.max(0,e-CUM[lo]))}
// Play a part: raw = as it was recorded (cuts included), else as the cut plays it; pad seconds either side.
function playRange(a,b,pad,raw){if(!D)return;scrubEnd();joinStop=null;rawStop=null;v.playbackRate=1;
 if(raw){v.currentTime=Math.max(0,a-pad);rawStop=Math.min(D.duration,b+pad)}else{v.currentTime=srcAtE(Math.max(0,edTime(a)-pad));joinStop=edTime(b)+pad}
 centre(v.currentTime);v.play().catch(()=>{})}
// Keep / Cut from Video Octopus's list: exact ranges (they come from the rough cut), one undo step. safe: a part Prepare named
// on whole words (false starts, an unfinished ending): its outer edges go where a word delete puts them (safeEdges).
// A cut never leaves a wordless sliver under 0.12 s at its edges (join-check's rule; index.html SLIVER).
function applyRanges(op,R,safe){if(ro())return;R=(R||[]).filter(r=>Array.isArray(r)&&r[1]-r[0]>.005).map(r=>[+r[0],+r[1]]).sort((x,y)=>x[0]-y[0]);if(!R.length||!D)return;
 if(safe&&$('snap').checked){const [a,b]=safeEdges(R[0][0],R[R.length-1][1]);R[0][0]=Math.min(R[0][0],a);R[R.length-1][1]=Math.max(R[R.length-1][1],b)}
 let L=kept.map(s=>[...s]);
 for(const [a,b] of R){if(op==='keep')L=norm(L.concat([[a,b]]));else{const o=[];for(const [p,q] of L){if(b<=p||a>=q){o.push([p,q]);continue}if(a>p&&!sliver(p,a))o.push([p,a]);if(b<q&&!sliver(b,q))o.push([b,q])}L=norm(o)}}
 if(JSON.stringify(L)===JSON.stringify(kept)){refresh();return}
 push();kept=L;sel=null;refresh();const d=R.reduce((s,[a,b])=>s+b-a,0);toast(`${op==='keep'?'Kept':'Cut'} ${d.toFixed(2)} s`);const t=op==='keep'?R[0][0]:R[R.length-1][1];setTimeout(()=>preview(t),30)}
// "Save and lock the cut": save what isn't saved yet, then say so.
async function studioFlush(){let ok=true;
 for(let i=0;i<50&&autoBusy;i++)await new Promise(r=>setTimeout(r,100));
 try{if(AUTOSAVE){if(!autoStop&&autoLast!==null&&JSON.stringify(kept)!==autoLast){autoBusy=true;try{await save(false,true)}finally{autoBusy=false}if(!autoStop)autoAgo()}}else if(dirty)await save()}catch(e){ok=false}
 if(AUTOSAVE&&autoStop)ok=false;toStudio({type:'studio:cut-flushed',ok,length:+edLen().toFixed(3)})}
function studioSetup(){
 // Geist, from Video Octopus's own fonts
 const ff=(w,file,fam)=>`@font-face{font-family:"${fam||'Geist'}";src:url("/fonts/${file}") format("woff2");font-weight:${w};font-display:swap}`;
 const st=document.createElement('style');st.textContent=ff('400','geist-sans-latin-400-normal.woff2')+ff('500 600','geist-sans-latin-600-normal.woff2')+ff('700','geist-sans-latin-700-normal.woff2')+ff('400 600','geist-mono-latin-500-normal.woff2','Geist Mono');document.head.append(st);
 // header: the lengths and the playhead, Undo, then Edit (cut, restore, hear the join, tidy), Options (speed and the
 // toggles) and Keys (the key help) as menus, autosave and Save
 const ls=$('len').parentNode;ls.innerHTML='<span id="dur">–</span> raw → <b id="len">–</b> cut';ls.title='The take, and the cut as it is now';
 const ps=$('ph').parentNode;ps.firstChild.textContent='at ';ps.title='The playhead, in the cut';
 const menu=(id,label,title)=>{const d=document.createElement('details');d.className='mn';d.id=id;d.innerHTML=`<summary title="${title}">${label}</summary><div class="mbody"></div>`;
  const sm=d.querySelector('summary');sm.addEventListener('click',()=>setTimeout(()=>sm.blur(),0));return d};
 const caret=' <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true"><path d="M1.5 3l3 3 3-3"/></svg>';
 const edit=menu('mEdit','Edit'+caret,'Cut the selection, restore it, hear the nearest join, tidy'),opts=menu('mOpts','Options'+caret,'Speed, previews, snapping, what the transcript shows'),
  keys=menu('mKeys','<b aria-hidden="true">?</b><span class="vh">Keys</span>','Every key and mouse move'),eb=edit.querySelector('.mbody'),ob=opts.querySelector('.mbody');
 for(const [id,k] of [['bCut','⌫'],['bRest','R'],['bJoin','J'],['bTidy','']]){const b=$(id);if(k)b.insertAdjacentHTML('beforeend',`<kbd>${k}</kbd>`);eb.append(b);b.addEventListener('click',()=>{edit.open=false})}
 ob.insertAdjacentHTML('beforeend','<div class="mh">Source</div>');ob.append($('src'));
 for(const el of [$('spd').closest('label'),$('auto').closest('label'),$('coll').closest('label'),$('snap').closest('label'),$('scrub').closest('label'),$('trimOpts'),$('hide').closest('label')])if(el)ob.append(el);
 keys.querySelector('.mbody').append(document.querySelector('.help'));
 // the buttons stay together on the right (on a narrow screen the group goes under the lengths as a whole)
 const hb=document.createElement('div');hb.className='hbtns';$('bSave').after(hb);hb.append($('bUndo'),edit,opts,keys,...($('autoState')?[$('autoState')]:[]),$('bSave'));
 addEventListener('mousedown',e=>{for(const d of document.querySelectorAll('details.mn[open]'))if(!d.contains(e.target))d.open=false});
 for(const d of [edit,opts,keys])d.addEventListener('toggle',()=>{if(d.open)for(const o of [edit,opts,keys])if(o!==d)o.open=false});
 // Video Octopus's Cut inspector drives the page through the same edits as the keys and buttons here.
 addEventListener('message',e=>{const m=e.data;if(!m||e.source!==parent||e.origin!==location.origin||typeof m.type!=='string')return;
  if(m.type==='studio:cut-review'){setEar(m.items);return}
  if(m.type==='studio:shots'){setShots(m);return}
  if(m.type==='studio:look'){applyStudioLook(m.look);return}
  if(m.type==='studio:lock'){setRO(m.locked);return}
  if(m.type!=='studio:cut-do'||!D)return;const op=m.op;
  if(op==='cut-sel'){if(sel)cut(...sel)}
  else if(op==='restore-sel'){if(sel)restore(...sel)}
  else if(op==='play-sel'){if(sel){const i=selInfo();playRange(sel[0],sel[1],0,i.state!=='kept')}}
  else if(op==='play')playRange(+m.a,+m.b,+m.pad||0,!!m.raw);
  else if(op==='select'){const a=+m.a,b=+m.b;sel=[a,b];v.pause();v.currentTime=a;centre(a);refresh();
   const i=words.findIndex(w=>w[1]>a+.01);const el=i>=0&&document.querySelector(`.w[data-i="${i}"]`);if(el)el.scrollIntoView({block:'center'})}
  else if(op==='keep'||op==='cut')applyRanges(op,m.ranges,!!m.safe);
  else if(op==='save')studioFlush()});
}

// ---- Shots: a "/" before the word where each shot starts ----
// Video Octopus sends the breaks (studio:shots: [{id, n, t (take seconds), label ("Crossfade 0.4 s", or '' for a cut), section}]);
// the "/" goes before the first word whose middle is at or after t (Video Octopus's own rule). "/" typed with words selected
// starts a new shot at the first one (with nothing selected, "/" is still the razor). A "/" clicked is selected and
// Video Octopus opens its transition popover; Delete merges it; dragged onto another word it moves there. Each of these goes
// to Video Octopus as studio:shot-* and comes back as a new studio:shots. Without a Video Octopus that sends breaks, nothing changes.
let SHOTS=null,SHOT_SEL=null,shotDrag=null;
const shotWord=t=>words.findIndex(w=>(w[0]+w[1])/2>=t-1e-6);
function setShots(m){SHOTS=m&&m.on?{breaks:Array.isArray(m.breaks)?m.breaks:[]}:null;
 const hp=document.querySelector('.help');if(SHOTS&&hp&&!hp.querySelector('.sl-help')){const x=document.createElement('span');x.className='sl-help';x.innerHTML='<br><b>Shots</b>: <kbd>/</kbd> with words selected starts a new shot at the first of them (nothing selected: <kbd>/</kbd> splits at the playhead as above) · click a / for how that shot comes in · <kbd>Delete</kbd> merges it · drag it onto another word to move it';hp.append(x)}if(SHOTS&&m.sel!==undefined)SHOT_SEL=m.sel;if(SHOT_SEL&&!(SHOTS&&SHOTS.breaks.some(b=>b.id===SHOT_SEL)))SHOT_SEL=null;drawShots()}
function drawShots(){document.querySelectorAll('#tx .slash,#tx .sl-lab').forEach(e=>e.remove());if(!SHOTS||!words.length)return;
 for(const b of SHOTS.breaks){const i=shotWord(b.t);if(i<0)continue;const el=document.querySelector(`#tx .w[data-i="${i}"]`);if(!el)continue;
  const s=document.createElement('span');s.className='slash'+(b.id===SHOT_SEL?' on':'');s.dataset.id=b.id;s.textContent='/';s.setAttribute('role','button');
  s.title=`Shot ${b.n} starts here · ${b.label||'Cut'}${b.section?' · a section starts here too':''}\nClick for how it comes in · Delete merges it · drag it onto another word to move it`;
  el.before(s);
  if(b.label||b.id===SHOT_SEL){const l=document.createElement('span');l.className='sl-lab';l.dataset.id=b.id;l.textContent=b.label||'Cut';l.title='How this shot comes in';el.before(l)}}}
function shotPick(id,el){SHOT_SEL=id;drawShots();const r=(document.querySelector(`#tx .slash[data-id="${id}"]`)||el).getBoundingClientRect();toStudio({type:'studio:shot-pick',id,rect:{x:r.left,y:r.top,h:r.height}})}
function shotDesel(){if(!SHOT_SEL)return;SHOT_SEL=null;drawShots();toStudio({type:'studio:shot-desel'})}
addEventListener('mousedown',e=>{const s=e.target.closest&&e.target.closest('#tx .slash,#tx .sl-lab');
 if(!s){if(SHOT_SEL&&e.target.closest&&e.target.closest('#tx'))shotDesel();return}
 e.stopPropagation();try{window.focus()}catch(x){}shotDrag={id:s.dataset.id,x:e.clientX,y:e.clientY,moved:false,over:null}},true);
addEventListener('mousemove',e=>{if(!shotDrag)return;if(Math.abs(e.clientX-shotDrag.x)+Math.abs(e.clientY-shotDrag.y)>4)shotDrag.moved=true;if(!shotDrag.moved)return;
 const w=e.target.closest&&e.target.closest('#tx .w');if(shotDrag.over&&shotDrag.over!==w)shotDrag.over.classList.remove('sl-drop');shotDrag.over=w||null;if(w)w.classList.add('sl-drop')});
addEventListener('mouseup',e=>{const d=shotDrag;shotDrag=null;if(!d)return;if(d.over)d.over.classList.remove('sl-drop');
 if(!d.moved){shotPick(d.id,e.target);return}
 if(d.over){const i=+d.over.dataset.i;if(words[i])toStudio({type:'studio:shot-move',id:d.id,t:+words[i][0].toFixed(3)})}},true);
addEventListener('keydown',e=>{if(!SHOTS||!D||e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA')return;const k=e.key;
 if(SHOT_SEL&&(k==='Delete'||k==='Backspace')){e.preventDefault();e.stopImmediatePropagation();toStudio({type:'studio:shot-merge',id:SHOT_SEL});return}
 if(SHOT_SEL&&k==='Escape'){e.preventDefault();e.stopImmediatePropagation();shotDesel();return}
 if(k==='/'&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&sel){const i=words.findIndex(w=>w[1]>sel[0]+.01&&w[0]<sel[1]-.01);if(i<0)return;
  e.preventDefault();e.stopImmediatePropagation();toStudio({type:'studio:shot-add',t:+words[i][0].toFixed(3)})}},true);

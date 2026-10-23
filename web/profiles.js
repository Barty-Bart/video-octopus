import { $, esc, h, api, toast, confirmBox } from './ui.js';
const field=(label,name,value='',rows=2)=>`<label>${label}<textarea name="${name}" rows="${rows}">${esc(value)}</textarea></label>`;
const run=fn=>async e=>{const b=e?.currentTarget;if(b)b.disabled=true;try{await fn(e);}catch(err){toast(err.message);}finally{if(b)b.disabled=false;}};
function brandFields(b={},assets=[]){return ['identity','audience','voice','fonts','notes'].map(k=>field(({identity:'Brand identity and offering',audience:'Audience',voice:'Voice and tone',fonts:'Fonts',notes:'Brand guidance and uncertainties'})[k],k,b[k]||'')).join('')+field('Colours (hex codes, separated by commas)','colors',(b.colors||[]).join(', '))+`<fieldset><legend>Assets included in this brand version</legend>${assets.map(a=>`<label class="learn-check"><input type="checkbox" name="asset-${a.id}"${b.assets?.includes(a.id)?' checked':''}>${esc(a.name)}</label>`).join('')||'<p class="sub">Upload logos, images or fonts below.</p>'}</fieldset>`;}
const values=(form,sources)=>{const v=Object.fromEntries(new FormData(form));return {...Object.fromEntries(['identity','audience','voice','fonts','notes'].map(k=>[k,v[k]||''])),colors:(v.colors||'').split(',').map(x=>x.trim()).filter(Boolean),assets:Object.keys(v).filter(k=>k.startsWith('asset-')).map(k=>k.slice(6)),sources:sources||[]};};
const when = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? String(iso || '') : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
// A channel's Brand tab (the channel hub, #/channel/<id>/brand): the approved brand, its assets, research and
// version history for one channel, as cards. New videos keep the version they were made with.
// onBrandChange(profile) runs after a brand version is approved, saved or restored, so the hub's tab status, avatar
// and sidebar can follow.
export function profileSettings({ makeChat, profileId, onBrandChange } = {}) {
 const root = h('<div class="brand-tab"><p class="sub">Loading the brand…</p></div>');
 let session = null, live = true, chat = null, events = null;
 const cleanup = () => { events?.close(); chat?.destroy?.(); events = null; chat = null; };
 root.teardown = () => { live = false; cleanup(); };

 async function paint() {
  cleanup();
  const data = await api('/api/profiles');
  if (!live) return;
  const p = data.profiles.find((x) => x.id === profileId);
  if (!p) { root.innerHTML = '<div class="vo-card"><p class="learn-error">This channel no longer exists.</p></div>'; return; }
  const brand = p.brand?.brand || {};
  const lead = p.brand ? '' : `<section class="vo-card brand-lead">
    <h2>No brand yet</h2>
    <p class="sub">Research a website or fill it in yourself. New videos in this channel load the approved brand.</p>
    <div class="learn-actions"><button type="button" class="btn primary" data-go="research">Research a website</button><button type="button" class="btn" data-go="brand">Fill it in yourself</button></div>
   </section>`;
  const history = p.history.map((v) => `<li><span>${esc(when(v.created))} · ${esc(v.reason)}</span><button type="button" class="btn small" data-brand-version="${v.id}">Review version</button></li>`).join('');
  const assets = p.assets.map((a) => `<li><span>${esc(a.name)}</span><small class="sub">${Math.max(1, Math.round((a.size || 0) / 1024))} KB</small></li>`).join('');
  const sessions = p.research.map((r) => `<button type="button" class="btn small${r.id === session ? ' on' : ''}" data-research="${r.id}">${esc(r.url)} · ${esc(r.status)}</button>`).join('');
  root.innerHTML = `${lead}
   <section class="vo-card" id="brandCard" aria-labelledby="brandCardTitle">
    <div class="vo-card-head"><h2 id="brandCardTitle">Brand</h2><span class="sub">${p.brand ? `Approved · ${esc(when(p.brand.created))}` : 'Not set'}</span></div>
    <form id="brandForm" class="learn-page brand-form">${brandFields(brand, p.assets)}<div class="learn-actions"><button class="btn primary">Save brand version</button></div></form>
   </section>
   <section class="vo-card" aria-labelledby="assetsTitle">
    <div class="vo-card-head"><h2 id="assetsTitle">Assets</h2><label class="btn small">Upload<input type="file" id="brandUpload" multiple hidden accept=".png,.jpg,.jpeg,.webp,.svg,.ttf,.otf,.woff,.woff2"></label></div>
    <p class="sub">Images and fonts up to 20 MB each are stored in SQLite. After uploading, tick them in the brand above and save a brand version.</p>
    ${assets ? `<ul class="brand-assets">${assets}</ul>` : '<p class="sub">No assets yet.</p>'}
   </section>
   <section class="vo-card" id="researchCard" aria-labelledby="researchTitle">
    <div class="vo-card-head"><h2 id="researchTitle">Research this brand</h2></div>
    <p class="sub">Give the assistant a public website. It researches in a separate session and proposes a brand for your review. Running research uses your configured agent/provider.</p>
    <form id="researchForm" class="learn-page brand-form"><label>Brand website<input type="url" name="url" placeholder="https://example.com" required></label>${field('Research direction', 'direction')}<div class="learn-actions"><button class="btn">Create research session</button></div></form>
    ${sessions ? `<div class="learn-actions brand-sessions">${sessions}</div>` : ''}
    <div id="researchDetail"></div>
   </section>
   <details class="vo-card brand-history"><summary>Version history${p.history.length ? ` · ${p.history.length}` : ''}</summary>${history ? `<ul>${history}</ul>` : '<p class="sub">No versions yet.</p>'}</details>`;

  root.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => {
   const target = b.dataset.go === 'research' ? $('#researchCard', root) : $('#brandCard', root);
   target.scrollIntoView({ behavior: 'smooth', block: 'start' });
   target.querySelector('input,textarea')?.focus({ preventScroll: true });
  });
  $('#brandForm', root).onsubmit = run(async (e) => {
   e.preventDefault();
   await api(`/api/profiles/${profileId}/brand`, { brand: values(e.target, brand.sources), expected: p.brand?.id || null });
   toast('Brand saved. Existing projects keep their version.');
   await brandChanged();
  });
  $('#brandUpload', root).onchange = run(async (e) => {
   const draft = values($('#brandForm', root), brand.sources), added = [];
   for (const file of [...e.target.files]) {
    const r = await fetch(`/api/profiles/${profileId}/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'X-Studio': '1' }, body: file });
    const j = await r.json();
    if (!r.ok) throw Error(j.error);
    added.push(j.id);
   }
   if (!live) return;
   await paint();
   // Keep what was typed but not saved, and tick the new assets.
   const form = $('#brandForm', root);
   for (const k of ['identity', 'audience', 'voice', 'fonts', 'notes']) form.elements[k].value = draft[k];
   form.elements.colors.value = draft.colors.join(', ');
   for (const id of [...draft.assets, ...added]) if (form.elements['asset-' + id]) form.elements['asset-' + id].checked = true;
   toast('Assets uploaded and selected. Save the brand version to include them.');
  });
  $('#researchForm', root).onsubmit = run(async (e) => {
   e.preventDefault();
   const r = await api(`/api/profiles/${profileId}/research`, Object.fromEntries(new FormData(e.target)));
   session = r.id;
   await paint();
  });
  root.querySelectorAll('[data-research]').forEach((b) => b.onclick = run(async () => { session = b.dataset.research; await paint(); }));
  root.querySelectorAll('[data-brand-version]').forEach((b) => b.onclick = run(async () => {
   const v = p.history.find((x) => x.id === b.dataset.brandVersion);
   if (await confirmBox({ title: 'Use this brand version for new videos?', text: JSON.stringify(v.brand, null, 2), ok: 'Use this version' })) {
    await api(`/api/profiles/${profileId}/brand`, { brand: v.brand, expected: p.brand?.id || null });
    await brandChanged();
   }
  }));
  if (session && p.research.some((r) => r.id === session)) await research(p, session);
  return p;
 }

 // A new approved brand version: repaint the tab, then tell the hub.
 async function brandChanged() {
  const p = await paint();
  if (p && live) await onBrandChange?.(p);
 }

 async function research(p, id) {
  const r = await api(`/api/profile-research/${id}`);
  if (!live) return;
  const host = $('#researchDetail', root);
  host.innerHTML = `<h3>Research session</h3><p id="researchStatus">${esc(r.url)} · ${esc(r.status)}</p><p class="learn-error" id="researchError"${r.error ? '' : ' hidden'}>${esc(r.error || '')}</p>${r.status === 'approved' ? '<p>Approved and retained as evidence.</p>' : '<div class="learn-actions"><button class="btn primary" id="brandRun">Run / resume research</button><button class="btn" id="brandReview">Review proposal</button><button class="btn" id="brandStop">Stop research</button></div><div id="brandReviewBody"></div><div id="brandChat"></div>'}`;
  if (r.status === 'approved') return;
  // The session's status (draft → running → review or failed) in the panel line and its chip, without redrawing the
  // chat. Read from the server, which changes it when a run starts and when the agent stops.
  const refreshStatus = async () => {
   const now = await api(`/api/profile-research/${id}`).catch(() => null);
   if (!now || !live || !host.isConnected) return;
   $('#researchStatus', host).textContent = `${now.url} · ${now.status}`;
   const error = $('#researchError', host);
   error.textContent = now.error || '';
   error.hidden = !now.error;
   const chip = root.querySelector(`[data-research="${id}"]`);
   if (chip) chip.textContent = `${now.url} · ${now.status}`;
  };
  $('#brandRun', host).onclick = run(async () => {
   const latest = await api(`/api/profile-research/${id}`);
   await api(`/api/profile-research/${id}/run`, { revision: latest.revision });
   await refreshStatus();
   toast('Research started. Follow the assistant and permission requests below.');
  });
  $('#brandStop', host).onclick = run(async () => { await api(`/api/profile-research/${id}/stop`, {}); await paint(); });
  $('#brandReview', host).onclick = run(async () => {
   const proposal = await api(`/api/profile-research/${id}/proposal`), el = $('#brandReviewBody', host);
   el.innerHTML = `<form id="approveBrand" class="learn-page brand-form"><h3>Review the proposed brand</h3>${brandFields(proposal.brand, p.assets)}<h4>Evidence</h4>${proposal.brand.sources.map((s) => `<p><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a><br>${esc(s.note)}</p>`).join('')}<label class="learn-check"><input type="checkbox" required>I reviewed the brand and its evidence.</label><button class="btn primary">Approve brand version</button></form>`;
   $('#approveBrand', el).onsubmit = run(async (e) => {
    e.preventDefault();
    await api(`/api/profile-research/${id}/approve`, { revision: proposal.revision, token: proposal.token, brand: values(e.target, proposal.brand.sources) });
    toast('Approved for this channel.');
    await brandChanged();
   });
  });
  const el = h('<section class="col chat learn-chat"><div class="chat-head"><b>Brand research assistant</b><span id="sessionInfo"></span></div><div class="msgs" id="msgs"><div class="empty-chat" id="emptyChat">Run research or discuss the brand here. Nothing is approved until you review it.</div></div><div class="working" id="working" hidden><span class="spin"></span><span id="workText">Working…</span></div><div class="composer"><textarea id="input" rows="2" aria-label="Message the brand assistant"></textarea><button class="send" id="sendBtn" aria-label="Send"><span class="l-send">↑</span><i class="stop-sq l-stop"></i></button></div></section>');
  $('#brandChat', host).append(el);
  chat = makeChat?.(el, '_brand_' + id, {}, { base: `/api/profile-research/${id}` });
  events = new EventSource(`/api/profile-research/${id}/events`);
  events.onmessage = (e) => {
   const ev = JSON.parse(e.data);
   chat?.handle(ev);
   if (ev.t === 'busy' && !ev.replay) {
    refreshStatus();
    if (!ev.busy) toast('Research paused or finished. Review its proposal when ready.');
   }
  };
 }

 paint().catch((e) => { if (live) root.innerHTML = `<p class="learn-error">${esc(e.message)}</p>`; });
 return root;
}
export function instructionSettings(){const root=h('<div class="learn-page"><p>Loading instructions…</p></div>');let selected='CLAUDE.md',live=true;root.teardown=()=>live=false;
 async function paint(){const v=await api('/api/instructions');if(!live)return;const files=v.current.files,names=[...new Set([...Object.keys(files),'CLAUDE.md','AGENTS.md','PROMPT.md','INSTRUCTIONS.md'])];if(!names.includes(selected))selected=names[0];const older=v.pinned?.older||0;root.innerHTML=`<p>Shared studio instructions are stored and versioned in SQLite. Keep channel identity in each channel’s Brand tab. Existing files were imported and retained; file edits require an explicit import.</p><p class="notice instruction-scope"><b>Saved changes apply to new videos only.</b> Each video keeps the instruction version it was made with${older?`: ${older} of your ${v.pinned.projects} video${v.pinned.projects===1?'':'s'} use${older===1?'s':''} an earlier version`:''}. The assistant, the library chat and scheduled runs on the whole studio use the current version.</p><label>Instruction document<select id="instructionFile">${names.map(n=>`<option${n===selected?' selected':''}>${esc(n)}</option>`).join('')}</select></label><form id="instructionForm">${field('Instructions','text',files[selected]||'',16)}<button class="btn primary">Save instruction version</button></form><div class="learn-actions"><button class="btn" id="importInstructions">Import file edits</button><button class="btn" id="rebuildInstructions">Rebuild instruction files</button></div><details><summary>Version history</summary>${v.history.map(x=>`<p>${esc(x.created)} · ${esc(x.reason)} <button class="btn small" data-restore="${x.id}">Restore</button></p>`).join('')}</details>`;
 $('#instructionFile',root).onchange=e=>{selected=e.target.value;paint().catch(e=>toast(e.message));};$('#instructionForm',root).onsubmit=run(async e=>{e.preventDefault();await api('/api/instructions',{files:{...files,[selected]:new FormData(e.target).get('text')},expected:v.current.id});toast('Saved. New videos use this version; existing videos keep theirs.');await paint();});$('#importInstructions',root).onclick=run(async()=>{await api('/api/instructions',{action:'import',expected:v.current.id});await paint();});$('#rebuildInstructions',root).onclick=run(async()=>{await api('/api/instructions',{action:'regenerate',expected:v.current.id});toast('Files rebuilt; displaced edits retained for recovery.');});root.querySelectorAll('[data-restore]').forEach(b=>b.onclick=run(async()=>{if(await confirmBox({title:'Restore these instructions?',text:'New projects will use this version. Existing project pins remain unchanged.',ok:'Restore'})){await api('/api/instructions',{action:'restore',versionId:b.dataset.restore,expected:v.current.id});await paint();}}));
 }paint().catch(e=>root.innerHTML=`<p class="learn-error">${esc(e.message)}</p>`);return root;}
export async function projectProfilePanel(root,id){let data;try{data=await api(`/api/project-context/${id}`);}catch(e){
  // The saved setup can't be used: its files were edited, or an older upgrade left a brand from another channel.
  // Repair keeps what is still valid, re-pins the rest and rebuilds the files; it says what it changed.
  const fix=h(`<div class="project-learning project-repair"><p class="learn-error">${esc(e.message)}</p><p class="sub">Repair keeps this video's saved setup where it is still valid, replaces what is not (for example a brand from another channel with this channel's approved brand) and rebuilds the generated context files. Displaced files are kept.</p><button class="btn small">Repair project setup</button></div>`);
  root.append(fix);
  $('button',fix).onclick=run(async()=>{
   const r=await api(`/api/project-context/${id}/repair`,{});
   if(r.changes?.length)await confirmBox({title:'Project setup repaired',text:r.changes.join(' '),ok:'Reload',cancel:'Close'});
   location.reload();
  });
  return;
 }if(!data||!root.isConnected)return;const b=data.bundle;const el=h(`<details class="project-learning"><summary>Brand & instructions · ${esc(b.profileName||'No brand')}</summary><div class="project-learning-body"><p>Saved setup: ${esc(b.profileName||'No brand')} · ${b.brandVersion?'approved brand':'unbranded'} · ${b.skills.length} selected skills.</p>${b.formatId?`<p>Format: ${esc(b.formatName||'Saved format')} · ${b.versionId?'reviewed style guide included':'basic setup; no style guide added'}.</p>`:''}<p class="sub">Brand, instructions and skills are pinned for this video. Later profile edits apply to new videos.</p><p>${esc(data.brand.identity||'No profile identity selected.')}</p><p>Skills: ${b.skills.map(s=>esc(s.name)).join(', ')}</p><button class="btn small">Restore generated context files</button></div></details>`);root.append(el);$('button',el).onclick=run(async()=>{await api(`/api/project-context/${id}/restore`,{});toast('Context restored from SQLite. Displaced files retained.');});}

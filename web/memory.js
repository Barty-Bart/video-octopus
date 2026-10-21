import { $, esc, h, api, toast, confirmBox } from './ui.js';
const E = '/api/memory';
const options = (list, selected) => list.map(s => `<option value="${esc(s.id)}"${s.id === selected ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
function editor(title, scopes, selected, initial, save) {
  const fields = h(`<div class="learn-dialog"><label>Applies to<select name="scope">${options(scopes, selected)}</select></label><label>Topic<input name="key" maxlength="120" value="${esc(initial.key || '')}" placeholder="For example: caption style"></label><label>What should it remember?<textarea name="text" rows="5" maxlength="2000">${esc(initial.text || '')}</textarea></label><p class="sub">Save to the review inbox first. Approving a memory makes it available to future turns in this scope. It never rewrites your approved format or core skills.</p><p class="learn-error" role="alert"></p></div>`);
  return confirmBox({ title, body: fields, ok: 'Save for review', onOk: async () => {
    try { await save({ scope: $('[name=scope]', fields).value, key: $('[name=key]', fields).value, text: $('[name=text]', fields).value }); return true; }
    catch (e) { $('.learn-error', fields).textContent = e.message; return false; }
  } });
}
export async function rememberMessage(chat, event) {
  try {
    const data = await api(`${E}?chat=${encodeURIComponent(chat)}`);
    if (!data.scopes.length) throw Error('Send a new message in this chat before saving a memory.');
    if (await editor('Remember this', data.scopes, data.scope, { text: event.text.slice(0, 2000) }, value => api(`${E}/propose`, { ...value, chat, evidence: event.t === 'user' && event.eventId ? [event.eventId] : [] }))) toast('Saved to Memories → Review inbox.');
  } catch (e) { toast(e.message); }
}
export async function reviewLessons(chat, send) {
  const body = h('<div><label><input type="checkbox" name="complete"> This project is complete</label><p class="sub">Save a local checkpoint and ask your selected agent to propose useful lessons from this chat. This uses a normal agent turn. Nothing becomes a memory until you approve it.</p></div>');
  await confirmBox({ title: 'Review lessons', body, ok: 'Propose lessons', onOk: async () => {
    try {
      const complete = $('[name=complete]', body).checked;
      await api(`${E}/checkpoint`, { chat, reason: complete ? 'project-complete' : 'review-lessons' });
      await send(`${complete ? 'This project is complete. ' : ''}Review our original conversation for durable creator corrections and preferences. Propose concise lessons in the octopus-memory JSON format using the original user message IDs provided in your context. Do not infer preferences from recalled memories, your own output or research references. Leave uncertain lessons out. Do not modify skills or approved guides. Tell me to review proposals in Memories.`);
      return true;
    } catch (e) { toast(e.message); return false; }
  } });
}
export async function renderMemories(root) {
  let live = true, data, scope = new URLSearchParams(location.hash.split('?')[1]).get('scope') || 'global', tab = 'pending';
  const initialChat = new URLSearchParams(location.hash.split('?')[1]).get('chat');
  if (initialChat) scope = (await api(`${E}?chat=${encodeURIComponent(initialChat)}`)).scope;
  const reload = async () => {
    data = await api(`${E}?scope=${encodeURIComponent(scope)}`);
    if (!live) return;
    root.replaceChildren(h(`<section class="memory-page"><div class="home-head"><h1>Memories</h1><button class="btn primary" data-add>+ Memory</button></div><p>Preferences that carry into your next video. Choose who they apply to, review proposed lessons, and keep only what helps.</p><p class="sub">Profiles keep their own brand; formats keep their own approved guide. Memories add reviewed preferences. More specific memories win when they share a topic. Your current request and pinned project setup take precedence.</p><label>Applies to<select data-scope>${options(data.scopes, scope)}</select></label><div class="learn-actions" role="group" aria-label="Memory views"><button class="btn ${tab === 'pending' ? 'primary' : ''}" data-tab="pending">Review inbox (${data.entries.filter(m => m.status === 'pending').length})</button><button class="btn ${tab === 'approved' ? 'primary' : ''}" data-tab="approved">Approved</button><button class="btn ${tab === 'history' ? 'primary' : ''}" data-tab="history">History</button><button class="btn ${tab === 'search' ? 'primary' : ''}" data-tab="search">Search chat history</button></div><div data-list></div><details><summary>Storage, forgetting and backups</summary><p>SQLite owns these memories and newly recorded app chat messages. A small generated MEMORY.md gives each agent the approved context. This does not train the model or read its private memory.</p><p>Forget removes a memory and its revision text from the active catalog and blocks its evidence from proposing it again. Forgetting a history result also removes that message from the search catalog. Existing app/provider transcripts and older backups can still contain the text. Start a new chat to leave an already-loaded memory behind. Studio restores preserve current forget markers.</p><p>Automatic candidates quote explicit corrections before compaction and after a successful export. Review lessons asks your chosen agent for a broader recap, including at project completion. Both wait for approval.</p></details></section>`));
    $('[data-scope]', root).onchange = e => { scope = e.target.value; reload().catch(e => toast(e.message)); };
    root.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; reload().catch(e => toast(e.message)); });
    $('[data-add]', root).onclick = async () => { if (await editor('New memory', data.scopes, scope, {}, value => api(`${E}/propose`, value))) await reload(); };
    const list = $('[data-list]', root);
    if (tab === 'search') {
      list.append(h('<form class="learn-actions"><input aria-label="Search chat history" name="q" placeholder="Find an earlier correction or decision" required><button class="btn">Search</button></form><div></div>'));
      if (data.chats.length) {
        const importer = h(`<details><summary>Import earlier app chat history</summary><p>Only Video Octopus logs from this installation. Earlier logs may predate studio bindings: verify the preview belongs to this scope. Provider logs are never read. A database backup is made first.</p><select aria-label="Chat to import">${data.chats.map(c => `<option>${esc(c)}</option>`).join('')}</select><button class="btn">Preview import</button></details>`);
        $('button', importer).onclick = async () => { try { const p = await api(`${E}/import-preview`, { chat: $('select', importer).value }); const preview = h(`<div><p>${p.count} messages from ${p.files} app log files will be assigned to ${esc(data.scopes.find(s => s.id === scope)?.name)}.</p>${p.sample.map(e => `<blockquote class="memory-text">${esc(e.text)}</blockquote>`).join('')}<p>Continue only if these are your messages for this scope. Import does not approve memories or start an agent.</p></div>`); await confirmBox({ title: 'Import this app history?', body: preview, ok: 'Back up and import', onOk: async () => { try { await api(`${E}/import-history`, { chat: p.chat, token: p.token }); toast('App history imported.'); return true; } catch (e) { toast(e.message); return false; } } }); } catch (e) { toast(e.message); } }; list.append(importer);
      }
      const results = h('<div></div>'); list.append(results);
      $('form', list).onsubmit = async e => {
        e.preventDefault(); try {
          const rows = await api(`${E}/search?scope=${encodeURIComponent(scope)}&q=${encodeURIComponent($('[name=q]', list).value)}`);
          results.replaceChildren();
          if (!rows.length) results.textContent = 'No matching messages in this scope. History starts with chats used after this update.';
          for (const r of rows) {
            const el = h(`<article class="memory-card"><p class="sub">${esc(r.role)} · ${esc(r.chat)} · ${esc(r.conversation)} · ${esc(r.created)}</p><p class="memory-text">${esc(r.text)}</p><button class="btn small" data-forget>Forget history result</button></article>`);
            $('[data-forget]', el).onclick = async () => { if (await confirmBox({ title: 'Forget this history result?', text: 'Removes it from SQLite search and forgets memories that cite it. App/provider transcripts and backups are retained.', ok: 'Forget' })) { await api(`${E}/forget-event`, { id: r.id }); el.remove(); } };
            results.append(el);
          }
        } catch (err) { toast(err.message); }
      };
      return;
    }
    const rows = data.entries.filter(m => tab === 'history' ? !['pending', 'approved'].includes(m.status) : m.status === tab);
    if (!rows.length) list.append(h(`<p class="empty">${tab === 'pending' ? 'No proposed memories here yet. Use Remember this beside a chat message or Review lessons at a stopping point.' : 'No memories in this view.'}</p>`));
    for (const m of rows) {
      const card = h(`<article class="memory-card"><b>${esc(m.key || 'Forgotten memory')}</b><p class="memory-text">${esc(m.text || 'Text removed from the active memory catalog.')}</p><p class="sub">${esc(m.status)} · revision ${m.revision} · ${esc(m.source === 'agent' ? 'Agent proposal — check the evidence' : 'Saved by you')} · ${esc(new Date(m.updated).toLocaleString())}</p><div class="learn-actions">${m.status === 'pending' ? '<button class="btn primary" data-op="approve">Approve</button><button class="btn" data-op="reject">Reject</button>' : ''}${m.status === 'approved' ? '<button class="btn" data-op="expire">Expire</button>' : ''}${m.status !== 'forgotten' ? '<button class="btn" data-edit>Edit</button><button class="btn" data-history>Versions & evidence</button><button class="btn" data-op="forget">Forget</button>' : ''}</div><div data-detail></div></article>`);
      card.querySelectorAll('[data-op]').forEach(b => b.onclick = async () => {
        try {
          const op = b.dataset.op, conflicts = op === 'approve' ? data.entries.filter(x => x.id !== m.id && x.key === m.key && x.status === 'approved') : [];
          if (op === 'forget' && !await confirmBox({ title: 'Forget this memory?', text: 'Its text and revisions are removed from the active catalog. Its original sources cannot propose it again. Existing transcripts and backups are retained.', ok: 'Forget' })) return;
          if (conflicts.length && !await confirmBox({ title: 'Replace the existing preference?', text: conflicts.map(x => x.text).join('\n'), ok: 'Replace and approve' })) return;
          await api(`${E}/action`, { id: m.id, expected: m.revision, op, supersede: conflicts.map(x => x.id) }); await reload();
        } catch (err) { toast(err.message); }
      });
      if ($('[data-edit]', card)) $('[data-edit]', card).onclick = async () => { if (await editor('Edit memory', data.scopes.filter(s => s.id === scope), scope, m, value => api(`${E}/action`, { ...value, id: m.id, expected: m.revision, op: 'edit' }))) await reload(); };
      if ($('[data-history]', card)) $('[data-history]', card).onclick = async () => {
        try {
          const detail = $('[data-detail]', card), history = await api(`${E}/history?id=${encodeURIComponent(m.id)}`); detail.replaceChildren();
          detail.append(h(`<p class="sub">Chat: ${esc(m.chat || 'Manual entry')}. Original user evidence IDs: ${esc(m.evidence.join(', ') || 'Manual entry')}. Inspect the source chat or search its history before approval.</p>`));
          for (const v of history) { const row = h(`<div><p class="memory-text">Revision ${v.revision} · ${esc(v.status)}: ${esc(v.text)}</p>${v.revision !== m.revision && v.text ? '<button class="btn small">Restore for review</button>' : ''}</div>`); if ($('button', row)) $('button', row).onclick = async () => { try { await api(`${E}/action`, { id: m.id, expected: m.revision, op: 'rollback', revision: v.revision }); await reload(); } catch (e) { toast(e.message); } }; detail.append(row); }
        } catch (err) { toast(err.message); }
      };
      if (m.evidence.length) {
        const evidence = h('<details><summary>Original evidence</summary><div></div></details>');
        evidence.ontoggle = async () => { if (!evidence.open || evidence.dataset.loaded) return; try { const rows = await api(`${E}/evidence?id=${encodeURIComponent(m.id)}`); $('div', evidence).replaceChildren(...rows.map(r => h(`<blockquote class="memory-text">${esc(r.text)}<p class="sub">${esc(r.chat)} · ${esc(r.conversation)} · ${esc(r.created)}</p></blockquote>`))); evidence.dataset.loaded = '1'; } catch (e) { toast(e.message); } };
        card.append(evidence);
      }
      list.append(card);
    }
  };
  await reload(); return { teardown() { live = false; } };
}

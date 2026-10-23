import { $, esc, h, api, toast, confirmBox } from './ui.js';
import { channelHref } from './nav.js';
const E = '/api/memory';
const options = (list, selected) => list.map(s => `<option value="${esc(s.id)}"${s.id === selected ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
const HINT = 'Only about one video? Choose Not a rule; it stays in that video’s chat. About one format? Add it to the format’s rules instead.';
// The hint links "the format’s rules" to the channel's Formats tab when the channel is known.
let hintChannel = null;
const hintHTML = () => hintChannel
  ? esc(HINT).replace('the format’s rules', `<a href="${channelHref(hintChannel, 'formats')}">the format’s rules</a>`)
  : esc(HINT);
// Video names for "You said, in …" (project ids otherwise).
let projectNames = new Map();
const day = iso => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// The two levels a creator sees. `levels` are {scope|id, name} pairs; the channel one reads "This channel".
const levelId = level => level.scope || level.id;
function keepFor(name, levels, selected) {
  const channelFirst = [...levels].sort((a, b) => (levelId(a) === 'global') - (levelId(b) === 'global'));
  const choices = channelFirst.map(level => {
    const id = levelId(level), global = id === 'global';
    return `<label class="memory-keep-choice"><input type="radio" name="${esc(name)}" value="${esc(id)}"${id === selected ? ' checked' : ''}><span><b>${global ? 'Everything' : 'This style'}</b><small>${global ? 'All channels' : esc(level.name)}</small></span></label>`;
  }).join('');
  return `<fieldset class="memory-keep"><legend>Keep for</legend><div class="memory-keep-choices">${choices}</div><p class="sub memory-hint">${hintHTML()}</p></fieldset>`;
}
// The level chip on a memory: its channel (accent tint), Everything (solid), or where an older one came from.
function levelChip(m, names) {
  if (m.origin) return `<span class="memory-level from">${m.origin.kind === 'format' ? 'From a format' : 'From a video'}: ${esc(m.origin.name)}</span>`;
  if (m.scope === 'global') return '<span class="memory-level everything">Everything</span>';
  return `<span class="memory-level channel">${esc(names.get(m.scope) || 'Style')}</span>`;
}
// Where a pending memory starts: where it was proposed when that is a level, otherwise its channel, otherwise Everything.
function suggestedLevel(m) {
  const scopes = m.levels.map(l => l.scope);
  if (scopes.includes(m.scope)) return m.scope;
  return scopes.find(s => s.startsWith('profile:')) || scopes[0];
}
const chatLink = q => q.project ? `<a href="#/p/${encodeURIComponent(q.project)}">${esc(projectNames.get(q.project) || q.project)}</a>` : esc(q.chat);

function editor(title, scopes, selected, initial, save, { keep = false } = {}) {
  const level = keep ? keepFor('scope', scopes, selected) : `<label>Applies to<select name="scope">${options(scopes, selected)}</select></label>`;
  const fields = h(`<div class="learn-dialog memory-editor">${level}<label>Topic<input name="key" maxlength="120" value="${esc(initial.key || '')}" placeholder="For example: caption style"></label><label>What should it remember?<textarea name="text" rows="5" maxlength="2000">${esc(initial.text || '')}</textarea></label><p class="sub">Save to the review inbox first. Approving a memory makes it available to future videos at its level. It never rewrites your approved format or core skills.</p><p class="learn-error" role="alert"></p></div>`);
  const chosenScope = () => keep ? $('[name=scope]:checked', fields)?.value : $('[name=scope]', fields).value;
  return confirmBox({ title, body: fields, ok: 'Save for review', onOk: async () => {
    try { await save({ scope: chosenScope(), key: $('[name=key]', fields).value, text: $('[name=text]', fields).value }); return true; }
    catch (e) { $('.learn-error', fields).textContent = e.message; return false; }
  } });
}
export async function rememberMessage(chat, event) {
  try {
    const data = await api(`${E}?chat=${encodeURIComponent(chat)}`);
    if (!data.scopes.length) throw Error('Send a new message in this chat before saving a memory.');
    const save = value => api(`${E}/propose`, { ...value, chat, evidence: event.t === 'user' && event.eventId ? [event.eventId] : [] });
    if (await editor('Remember this', data.scopes, data.scope, { text: event.text.slice(0, 2000) }, save, { keep: true })) toast('Saved to Memories → Review inbox.');
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
// The Memories pages. `profileId`: a channel hub's Memories tab (the channel's level, plus the Everything memories
// it inherits, read-only). `scope: 'global'`: All channels › Memories. Neither: the scope picker, as before.
export async function renderMemories(root, { profileId = null, profileName = '', scope: fixedScope = null } = {}) {
  const query = new URLSearchParams(location.hash.split('?')[1]);
  let live = true, data, inherited = [], tab = 'pending';
  let scope = profileId ? `profile:${profileId}` : fixedScope || query.get('scope') || 'global';
  const embedded = Boolean(profileId || fixedScope);
  let onlyChat = query.get('chat');
  hintChannel = profileId;
  if (onlyChat && !embedded) scope = (await api(`${E}?chat=${encodeURIComponent(onlyChat)}`)).scope;
  if (!embedded) onlyChat = null;
  projectNames = new Map((await api('/api/projects').catch(() => [])).map(p => [p.id, p.name]));
  const levelName = () => profileId ? profileName || 'this style' : 'Everything';
  const reload = async () => {
    data = await api(profileId ? `${E}?profile=${encodeURIComponent(profileId)}` : `${E}?scope=${encodeURIComponent(scope)}`);
    // A channel also uses every approved Everything memory; they are shown read-only here and edited in All channels.
    inherited = profileId ? (await api(`${E}?scope=global`)).entries.filter(m => m.status === 'approved' && m.scope === 'global') : [];
    if (!live) return;
    const names = new Map(data.scopes.map(s => [s.id, s.name]));
    const pending = data.entries.filter(m => m.status === 'pending');
    const tabs = [
      ['pending', `Review inbox`, pending.length],
      ['approved', profileId ? `In use for ${levelName()}` : 'Approved', null],
      ['history', 'History', null],
      ['search', 'Search chat history', null],
    ];
    const tabBar = `<div class="seg mem-tabs scroll-row" role="group" aria-label="Memory views">${tabs.map(([key, label, n]) => `<button type="button" data-tab="${key}" class="${tab === key ? 'on' : ''}" aria-pressed="${tab === key}">${esc(label)}${n ? ` <span class="pill accent">${n}</span>` : n === 0 ? ' <span class="seg-n">0</span>' : ''}</button>`).join('')}</div>`;
    const intro = profileId
      ? `<p class="sub">Lessons for every video in ${esc(levelName())}. They win over an <a href="#/styles/memories">Everything</a> memory on the same topic. A format’s style belongs in <a href="${channelHref(profileId, 'formats')}">its rules</a>; notes about one video stay in that video’s chat.</p>`
      : `<p class="sub">Two levels: <b>Everything</b> reaches every style and video; <b>This style</b> reaches every video in that style and wins when both cover the same topic. A format’s style belongs in its rules, and notes about one video stay in that video’s chat. Your current request and pinned project setup take precedence.</p>`;
    const head = embedded
      ? `<div class="tab-head"><div>${intro}</div><button class="btn primary" data-add>+ Memory</button></div>`
      : `<div class="home-head"><h1>Memories</h1><button class="btn primary" data-add>+ Memory</button></div><p>Preferences that carry into your next video. Review proposed lessons, choose where each one applies, and keep only what helps.</p>${intro}<label>Applies to<select data-scope>${options(data.scopes, scope)}</select></label>`;
    const chatNote = onlyChat && tab === 'pending' ? `<p class="notice mem-chat-note">Showing the lessons proposed in one chat. <button type="button" class="link-btn" data-all-chats>Show the whole inbox</button></p>` : '';
    root.replaceChildren(h(`<section class="memory-page${embedded ? ' embedded' : ''}">${head}${tabBar}${chatNote}<div data-list></div><details><summary>Storage, forgetting and backups</summary><p>SQLite owns these memories and newly recorded app chat messages. A small generated MEMORY.md gives each agent the approved context. This does not train the model or read its private memory.</p><p>Forget removes a memory and its revision text from the active catalog and blocks its evidence from proposing it again. Forgetting a history result also removes that message from the search catalog. Existing app/provider transcripts and older backups can still contain the text. Start a new chat to leave an already-loaded memory behind. Studio restores preserve current forget markers.</p><p>Automatic candidates quote explicit corrections before compaction and after a successful export. Review lessons asks your chosen agent for a broader recap, including at project completion. Both wait for approval.</p></details></section>`));
    $('[data-all-chats]', root)?.addEventListener('click', () => { onlyChat = null; reload().catch(e => toast(e.message)); });
    $('[data-scope]', root)?.addEventListener('change', e => { scope = e.target.value; reload().catch(e => toast(e.message)); });
    root.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; reload().catch(e => toast(e.message)); });
    $('[data-add]', root).onclick = async () => {
      // In a channel: This channel (default) or Everything, as the Keep for choice.
      const levels = profileId ? data.scopes.filter(x => x.id === 'global' || x.id === scope) : data.scopes;
      if (await editor('New memory', levels, scope, {}, value => api(`${E}/propose`, value), { keep: Boolean(profileId) })) await reload();
    };
    const list = $('[data-list]', root);
    if (tab === 'search') {
      list.append(h('<form class="learn-actions"><input aria-label="Search chat history" name="q" placeholder="Find an earlier correction or decision" required><button class="btn">Search</button></form><div></div>'));
      if (data.chats.length) {
        const importer = h(`<details><summary>Import earlier app chat history</summary><p>Only Video Octopus logs from this installation. Earlier logs may predate studio bindings: verify the preview belongs to this chat. Provider logs are never read. A database backup is made first.</p><select aria-label="Chat to import">${data.chats.map(c => `<option>${esc(c)}</option>`).join('')}</select><button class="btn">Preview import</button></details>`);
        $('button', importer).onclick = async () => { try { const p = await api(`${E}/import-preview`, { chat: $('select', importer).value }); const preview = h(`<div><p>${p.count} messages from ${p.files} app log files will be added to the history of ${esc(p.chat)} (${esc(names.get(scope) || scope)}).</p>${p.sample.map(e => `<blockquote class="memory-text">${esc(e.text)}</blockquote>`).join('')}<p>Continue only if these are your messages for this chat. Import does not approve memories or start an agent.</p></div>`); await confirmBox({ title: 'Import this app history?', body: preview, ok: 'Back up and import', onOk: async () => { try { await api(`${E}/import-history`, { chat: p.chat, token: p.token }); toast('App history imported.'); return true; } catch (e) { toast(e.message); return false; } } }); } catch (e) { toast(e.message); } }; list.append(importer);
      }
      const results = h('<div></div>'); list.append(results);
      $('form', list).onsubmit = async e => {
        e.preventDefault(); try {
          const rows = await api(`${E}/search?scope=${encodeURIComponent(scope)}&q=${encodeURIComponent($('[name=q]', list).value)}`);
          results.replaceChildren();
          if (!rows.length) results.textContent = 'No matching messages at this level. History starts with chats used after this update.';
          for (const r of rows) {
            const el = h(`<article class="memory-card"><p class="sub">${esc(r.role)} · ${esc(r.chat)} · ${esc(r.conversation)} · ${esc(r.created)}</p><p class="memory-text">${esc(r.text)}</p><button class="btn small" data-forget>Forget history result</button></article>`);
            $('[data-forget]', el).onclick = async () => { if (await confirmBox({ title: 'Forget this history result?', text: 'Removes it from SQLite search and forgets memories that cite it. App/provider transcripts and backups are retained.', ok: 'Forget' })) { await api(`${E}/forget-event`, { id: r.id }); el.remove(); } };
            results.append(el);
          }
        } catch (err) { toast(err.message); }
      };
      return;
    }
    const act = async payload => { await api(`${E}/action`, payload); await reload(); };
    const rows = data.entries
      .filter(m => tab === 'history' ? !['pending', 'approved'].includes(m.status) : m.status === tab)
      .filter(m => tab !== 'pending' || !onlyChat || m.chat === onlyChat);
    const emptyText = tab === 'pending'
      ? 'Nothing to review. When you correct your agent in a chat, it may suggest a lesson here; nothing is used until you approve it.'
      : tab === 'approved' && profileId ? `No memories for ${levelName()} yet.` : 'No memories in this view.';
    if (!rows.length) {
      const empty = h(`<div class="vo-card mem-empty"><p>${esc(emptyText)}</p>${tab === 'pending' ? '<button type="button" class="btn" data-add-empty>+ Memory</button>' : ''}</div>`);
      $('[data-add-empty]', empty)?.addEventListener('click', () => $('[data-add]', root).click());
      list.append(empty);
    }
    for (const m of rows) {
      const card = m.status === 'pending' ? pendingCard(m, names, act) : m.status === 'approved' ? approvedCard(m, names, act) : pastCard(m, names);
      wireCommon(card, m, names, act);
      list.append(card);
    }
    // Everything memories a channel inherits: read-only here, with a link to where they are edited.
    if (tab === 'approved' && inherited.length) {
      list.append(h(`<h3 class="mem-sub">From Everything <span class="sub">· used by every style</span></h3>`));
      for (const m of inherited) {
        list.append(h(`<article class="memory-card inherited"><div class="memory-head"><p class="memory-text">${esc(m.text)}</p><a class="memory-level everything" href="#/styles/memories" title="Edit in My stynnels › Memories">Everything</a></div><p class="sub">${esc(m.key)}</p></article>`));
      }
    }
  };
  // Pending: the lesson, the creator's own words with a link to the chat, then the level to keep it at.
  function pendingCard(m, names, act) {
    const quotes = m.quotes.map(q => `<blockquote class="memory-quote"><p class="sub">You said, in ${chatLink(q)} · ${esc(day(q.created))}</p><p class="memory-text">“${esc(q.text)}”</p></blockquote>`).join('');
    const from = m.origin ? `<p>${levelChip(m, names)}</p>` : '';
    const card = h(`<article class="memory-card memory-pending"><p class="memory-lesson memory-text">${esc(m.text)}</p><p class="sub">${esc(m.key)} · ${esc(m.source === 'agent' ? 'Agent proposal — check the evidence' : 'Saved by you')}</p>${quotes}${from}${keepFor(`keep-${m.id}`, m.levels, suggestedLevel(m))}<p class="memory-replaces" hidden></p><div class="learn-actions"><button class="btn primary" data-approve></button><button class="btn" data-edit>Edit wording</button><button class="btn ghost" data-op="reject">Not a rule</button><button class="btn ghost small" data-history>Versions & evidence</button><button class="btn ghost small" data-op="forget">Forget</button></div><div data-detail></div></article>`);
    const button = $('[data-approve]', card), replaces = $('.memory-replaces', card);
    const chosen = () => m.levels.find(l => l.scope === $(`[name="keep-${m.id}"]:checked`, card)?.value) || m.levels[0];
    const update = () => {
      const level = chosen(), conflicts = level.conflicts;
      button.textContent = conflicts.length ? 'Approve and replace' : level.scope === 'global' ? 'Approve for everything' : `Approve for ${level.name}`;
      replaces.hidden = !conflicts.length;
      replaces.textContent = conflicts.map(c => `Replaces “${c.text}” (${names.get(c.scope) || 'Everything'}, approved ${day(c.updated)}). The old one stays in history.`).join(' ');
    };
    card.querySelectorAll(`[name="keep-${m.id}"]`).forEach(r => r.onchange = update);
    update();
    button.onclick = async () => {
      const level = chosen();
      try { await act({ id: m.id, expected: m.revision, op: 'approve', scope: level.scope, supersede: level.conflicts.map(c => c.id) }); }
      catch (err) { toast(err.message); }
    };
    return card;
  }
  // Approved: the text and its level; an older format/video memory offers Move to channel up front.
  function approvedCard(m, names, act) {
    const moves = m.levels.filter(l => l.scope !== m.scope);
    const moveButton = l => `<button class="btn${m.origin ? '' : ' ghost small'}" data-move="${esc(l.scope)}">${l.scope === 'global' ? 'Move to everything' : 'Move to style'}</button>`;
    const upFront = m.origin ? moves.filter(l => l.scope !== 'global').map(moveButton).join('') : '';
    const inMenu = moves.filter(l => !m.origin || l.scope === 'global').map(moveButton).join('');
    const card = h(`<article class="memory-card"><div class="memory-head"><p class="memory-text">${esc(m.text)}</p>${levelChip(m, names)}</div><p class="sub">${esc(m.key)} · revision ${m.revision} · ${esc(m.source === 'agent' ? 'Agent proposal' : 'Saved by you')} · ${esc(new Date(m.updated).toLocaleString())}</p><div class="learn-actions">${upFront}<details class="memory-menu"><summary class="btn ghost small">Options</summary><div class="memory-menu-items">${inMenu}<button class="btn ghost small" data-history>History</button><button class="btn ghost small" data-edit>Edit</button><button class="btn ghost small" data-op="expire">Expire</button><button class="btn ghost small" data-op="forget">Forget</button></div></details></div><div data-detail></div></article>`);
    card.querySelectorAll('[data-move]').forEach(b => b.onclick = async () => {
      const level = m.levels.find(l => l.scope === b.dataset.move);
      try {
        if (level.conflicts.length && !await confirmBox({ title: 'Replace the existing preference?', text: level.conflicts.map(c => c.text).join('\n'), ok: 'Move and replace' })) return;
        await act({ id: m.id, expected: m.revision, op: 'move', scope: level.scope, supersede: level.conflicts.map(c => c.id) });
      } catch (err) { toast(err.message); }
    });
    return card;
  }
  // Expired, replaced, rejected or forgotten.
  function pastCard(m, names) {
    const tools = m.status !== 'forgotten' ? '<button class="btn" data-edit>Edit</button><button class="btn" data-history>Versions & evidence</button><button class="btn" data-op="forget">Forget</button>' : '';
    return h(`<article class="memory-card"><div class="memory-head"><b>${esc(m.key || 'Forgotten memory')}</b>${m.status !== 'forgotten' ? levelChip(m, names) : ''}</div><p class="memory-text">${esc(m.text || 'Text removed from the active memory catalog.')}</p><p class="sub">${esc(m.status)} · revision ${m.revision} · ${esc(m.source === 'agent' ? 'Agent proposal' : 'Saved by you')} · ${esc(new Date(m.updated).toLocaleString())}</p><div class="learn-actions">${tools}</div><div data-detail></div></article>`);
  }
  // Reject, expire and forget; editing; versions with each revision's level; the original evidence.
  function wireCommon(card, m, names, act) {
    card.querySelectorAll('[data-op]').forEach(b => b.onclick = async () => {
      try {
        const op = b.dataset.op;
        if (op === 'forget' && !await confirmBox({ title: 'Forget this memory?', text: 'Its text and revisions are removed from the active catalog. Its original sources cannot propose it again. Existing transcripts and backups are retained.', ok: 'Forget' })) return;
        await act({ id: m.id, expected: m.revision, op });
      } catch (err) { toast(err.message); }
    });
    const levelName = scope => names.get(scope) || (scope === m.scope && m.origin ? `${m.origin.kind === 'format' ? 'Format' : 'Video'} · ${m.origin.name}` : scope);
    if ($('[data-edit]', card)) $('[data-edit]', card).onclick = async () => {
      if (await editor('Edit memory', [{ id: m.scope, name: levelName(m.scope) }], m.scope, m, value => api(`${E}/action`, { ...value, id: m.id, expected: m.revision, op: 'edit' }))) await reload();
    };
    if ($('[data-history]', card)) $('[data-history]', card).onclick = async () => {
      try {
        const detail = $('[data-detail]', card), history = await api(`${E}/history?id=${encodeURIComponent(m.id)}`); detail.replaceChildren();
        detail.append(h(`<p class="sub">Chat: ${esc(m.chat || 'Manual entry')}. Original user evidence IDs: ${esc(m.evidence.join(', ') || 'Manual entry')}. Inspect the source chat or search its history before approval.</p>`));
        for (const v of history) { const row = h(`<div><p class="memory-text">Revision ${v.revision} · ${esc(v.status)} · ${esc(levelName(v.scope))}: ${esc(v.text)}</p>${v.revision !== m.revision && v.text ? '<button class="btn small">Restore for review</button>' : ''}</div>`); if ($('button', row)) $('button', row).onclick = async () => { try { await act({ id: m.id, expected: m.revision, op: 'rollback', revision: v.revision }); } catch (e) { toast(e.message); } }; detail.append(row); }
      } catch (err) { toast(err.message); }
    };
    if (m.evidence.length && m.status !== 'pending') {
      const evidence = h('<details><summary>Original evidence</summary><div></div></details>');
      evidence.ontoggle = async () => { if (!evidence.open || evidence.dataset.loaded) return; try { const rows = await api(`${E}/evidence?id=${encodeURIComponent(m.id)}`); $('div', evidence).replaceChildren(...rows.map(r => h(`<blockquote class="memory-text">${esc(r.text)}<p class="sub">${esc(r.chat)} · ${esc(r.conversation)} · ${esc(r.created)}</p></blockquote>`))); evidence.dataset.loaded = '1'; } catch (e) { toast(e.message); } };
      card.append(evidence);
    }
  }
  await reload(); return { teardown() { live = false; } };
}

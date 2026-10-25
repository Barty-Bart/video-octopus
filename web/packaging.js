// The Packaging tab (Phase 1 MVP): a chat with Codex, Generate (six ideas in one image, cut into cards), a simple board
// (star, winners up to 3, the main thumbnail, Refine, old thumbnails) and, in the inspector, the working title, the
// winners and this video's resources. Optional and never blocking. Server: server/packaging.mjs.
import { $, esc, h, api, toast, confirmBox } from './ui.js';
import { mountResources } from './resources.js';

const STAR = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.4l1.7 3.6 3.9.5-2.9 2.7.7 3.9L7 10.2l-3.4 1.9.7-3.9L1.4 5.5l3.9-.5z"/></svg>';
const ORIGIN = { 'sheet-cell': 'From a sheet', refined: 'Refined · 1280 × 720', uploaded: 'Your thumbnail', chat: 'From the chat' };

// pane: the tab's pane; makeChat: app.js's chat builder; onChange(): the project view refreshes (the rail's Package step).
// ideaUsed({ name, ask }): a card's idea went into Record's script (B8); the project chat offers "Ask Claude to outline
// it" (ask: the message it sends). outline(ask): sends it in the project chat now.
export function makePackaging({ pane, id, makeChat, onChange, ideaUsed, outline }) {
  const P = `/api/packaging/${encodeURIComponent(id)}`;
  let view = null, chat = null, events = null, busy = false, started = false, timer = 0, insBox = null, resources = null, used = null;
  const more = new Set();

  pane.innerHTML = `<div class="pg">
    <section class="pg-chat" aria-label="Packaging chat with Codex">
      <div class="chat-head"><b>Packaging</b><span class="sub pg-who">· Codex</span><span id="sessionInfo"></span></div>
      <div class="msgs" id="msgs"><div class="empty-chat" id="emptyChat"><b>Thumbnail ideas, with Codex.</b><br>Press Generate for six ideas in one image, or tell Codex what you want.</div></div>
      <div class="working" id="working" hidden><span class="spin"></span><span id="workText">Working…</span></div>
      <form class="pg-gen" autocomplete="off">
        <input name="brief" maxlength="2000" aria-label="What the video is about (optional)" placeholder="What the video is about (optional)">
        <button class="btn primary pg-go" type="submit">Generate 6</button>
      </form>
      <p class="pg-like sub" hidden></p>
      <div class="composer"><textarea id="input" rows="1" aria-label="Message Codex" placeholder="Ask Codex for a change…"></textarea>
        <button class="send" id="sendBtn" aria-label="Send"><span class="l-send">↑</span><i class="stop-sq l-stop" aria-hidden="true"></i></button></div>
    </section>
    <section class="pg-board" aria-labelledby="pgTitle">
      <div class="pg-head">
        <h2 id="pgTitle">Thumbnails</h2>
        <span class="pg-sub" aria-label="Later in Packaging"><span class="pg-soon">Titles · soon</span><span class="pg-soon">Hook · soon</span></span>
        <span class="gap"></span>
        <label class="btn small pg-upload">Upload old thumbnail<input type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif"></label>
      </div>
      <div class="pg-status" role="status"></div>
      <div class="pg-grid"></div>
    </section>
  </div>`;
  const grid = $('.pg-grid', pane), status = $('.pg-status', pane), gen = $('.pg-gen', pane), like = $('.pg-like', pane);

  // ---- data ----
  async function load() {
    view = await api(P);
    busy = view.busy || busy;
    paint();
    paintInspector();
  }
  const reload = () => { clearTimeout(timer); timer = setTimeout(() => load().catch((e) => toast(e.message)), 150); };

  function start() {
    if (started) return;
    started = true;
    chat = makeChat($('.pg-chat', pane), `${id}.packaging`, {}, { base: P, agent: 'Codex' });
    events = new EventSource(`${P}/events`);
    events.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.t === 'packaging') { reload(); return; }
      chat.handle(ev);
      if (ev.t === 'busy') { busy = ev.busy; paintGenerate(); if (!ev.busy && !ev.replay) reload(); }
      if (ev.t === 'images' && !ev.replay) { reload(); onChange?.(); }
    };
  }

  // ---- the board ----
  const img = (x) => `${P}/item/${encodeURIComponent(x.id)}`;
  function card(x) {
    const main = view.board.main === x.id, rejected = x.status === 'rejected';
    const tags = [main ? 'Main' : x.winner ? 'Winner' : null, more.has(x.id) ? 'More like this' : null].filter(Boolean);
    return `<article class="pg-card${x.winner ? ' win' : ''}${main ? ' main' : ''}${rejected ? ' rej' : ''}" data-id="${esc(x.id)}">
      <a class="pg-img" href="${img(x)}" target="_blank" rel="noopener" aria-label="${esc(`Open ${x.name || 'this card'} full size`)}"><img src="${img(x)}" alt="" loading="lazy">
        ${tags.length ? `<span class="pg-tags">${tags.map((t) => `<span class="pg-tag">${esc(t)}</span>`).join('')}</span>` : ''}</a>
      <div class="pg-meta"><b title="${esc(x.name || '')}">${esc(x.name || 'Card')}</b><small>${esc(ORIGIN[x.origin] || '')}${x.note ? ` · ${esc(x.note)}` : ''}</small></div>
      <div class="pg-acts">
        <button type="button" class="pg-ic${x.star ? ' on' : ''}" data-act="star" aria-pressed="${x.star}" aria-label="${esc(`Star ${x.name || 'this card'}`)}" title="Star (shortlist)">${STAR}</button>
        <button type="button" class="btn ghost small${x.winner ? ' on' : ''}" data-act="winner" aria-pressed="${x.winner}"${rejected ? ' disabled' : ''}>Winner</button>
        <button type="button" class="btn ghost small" data-act="refine"${rejected || x.origin === 'uploaded' ? ' disabled' : ''}>Refine</button>
        ${main ? '<button type="button" class="btn small pg-use" data-act="use" title="Put this idea into Record’s script as an outline">Use this idea</button>' : ''}
        <details class="pg-menu"><summary class="btn ghost small" aria-label="${esc(`More for ${x.name || 'this card'}`)}">⋯</summary>
          <div class="menu">
            <button type="button" class="mi" data-act="main"${rejected ? ' disabled' : ''}>${main ? 'Main thumbnail ✓' : 'Make it the main thumbnail'}</button>
            <button type="button" class="mi" data-act="use">Use this idea (outline in the script)</button>
            <button type="button" class="mi" data-act="more"${x.origin === 'uploaded' ? '' : ''}>${more.has(x.id) ? 'Not for the next Generate' : 'More like this (next Generate)'}</button>
            <button type="button" class="mi" data-act="reject">${rejected ? 'Bring back' : 'Reject'}</button>
          </div></details>
      </div>
    </article>`;
  }
  function paint() {
    if (!view) return;
    const b = view.board, latest = b.sheets[0];
    const notes = [];
    if (!view.status.available) notes.push(`<p class="notice pg-off">${esc(view.status.reason)}</p>`);
    if (latest?.status === 'running') notes.push('<p class="pg-run"><span class="spin" aria-hidden="true"></span>Codex is drawing six ideas in one image (one generation on your ChatGPT plan)…</p>');
    else if (latest?.status === 'failed') notes.push(`<p class="notice pg-fail">${esc(latest.failure?.message || 'The last Generate failed.')}</p>`);
    else if (latest?.problem) notes.push(`<p class="notice">${esc(latest.problem)}</p>`);
    if (view.pending === 'refine') notes.push('<p class="pg-run"><span class="spin" aria-hidden="true"></span>Codex is refining a card to 1280 × 720…</p>');
    if (used) notes.push(`<p class="pg-used" role="status"><span><b>${esc(used.name)}</b> ${used.written === 'appended' ? 'is under your script in Record' : used.written === 'already' ? 'is already in Record’s script' : 'is in Record’s script as an outline'}.</span>
      <button type="button" class="btn small primary" data-u="ask">Ask ${esc(window.STUDIO_AGENT || 'Claude')} to outline it</button><button type="button" class="btn ghost small" data-u="x" aria-label="Put this away">✕</button></p>`);
    status.innerHTML = notes.join('');
    status.querySelectorAll('[data-u]').forEach((b) => (b.onclick = () => { const ask = used?.ask; used = null; paint(); if (b.dataset.u === 'ask' && ask) outline?.(ask); }));
    const skeleton = latest?.status === 'running' ? `<div class="pg-skel" aria-hidden="true">${'<i></i>'.repeat(6)}</div>` : '';
    // An empty board: Generate is its big action (B8), with the idea typed right here (the same brief as the chat's field).
    const typing = document.activeElement?.classList.contains('pg-brief') ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    grid.innerHTML = skeleton + (b.items.length ? b.items.map(card).join('') : skeleton ? ''
      : `<div class="pg-empty pg-start"><b>Start with the idea</b><span>Say what the video is about. Codex draws six thumbnail ideas in one image and cuts them into cards here; you can also upload thumbnails you already have.</span>
        <label class="vh" for="pgBrief">What the video is about</label><textarea id="pgBrief" class="pg-brief" rows="3" maxlength="2000" placeholder="Describe your idea…"></textarea>
        <button type="button" class="btn primary pg-go6">Generate 6 ideas</button><small class="pg-cost">One generation on your ChatGPT plan.</small></div>`);
    for (const n of grid.querySelectorAll('.pg-card')) wireCard(n, b.items.find((x) => x.id === n.dataset.id));
    const brief = $('.pg-brief', grid);
    if (brief) {
      brief.value = gen.elements.brief.value;
      brief.oninput = () => { gen.elements.brief.value = brief.value; };
      brief.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); gen.requestSubmit(); } };
      $('.pg-go6', grid).onclick = () => gen.requestSubmit();
      if (typing) { brief.focus(); brief.setSelectionRange(...typing); }
    }
    paintGenerate();
  }
  function paintGenerate() {
    for (const go of pane.querySelectorAll('.pg-go, .pg-go6')) {
      go.disabled = busy || !view?.status?.available;
      go.title = !view?.status?.available ? view?.status?.reason || '' : busy ? 'Codex is working' : 'One image with six ideas (3 × 2), cut into six cards';
    }
    const liked = view ? view.board.items.filter((x) => more.has(x.id)) : [];
    like.hidden = !liked.length;
    like.innerHTML = liked.length ? `Next Generate: more like ${liked.map((x) => `<b>${esc(x.name)}</b>`).join(' and ')} <button type="button" class="nc-link">Clear</button>` : '';
    const clear = like.querySelector('button');
    if (clear) clear.onclick = () => { more.clear(); paint(); };
  }
  async function mark(x, patch) {
    try {
      await api(`${P}/items/${encodeURIComponent(x.id)}`, patch);
      await load();
      if ('main' in patch || 'winner' in patch || 'rejected' in patch) onChange?.();
    } catch (e) { toast(e.message); }
  }
  function wireCard(n, x) {
    n.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
      b.closest('details')?.removeAttribute('open');
      const act = b.dataset.act;
      if (act === 'star') return mark(x, { star: !x.star });
      if (act === 'winner') return mark(x, { winner: !x.winner });
      if (act === 'main') return mark(x, { main: view.board.main !== x.id });
      if (act === 'reject') return mark(x, { rejected: x.status !== 'rejected' });
      if (act === 'use') return useIdea(x);
      if (act === 'more') {
        if (more.has(x.id)) more.delete(x.id); else { if (more.size >= 2) more.delete(more.values().next().value); more.add(x.id); }
        return paint();
      }
      if (act === 'refine') {
        try {
          await api(`${P}/items/${encodeURIComponent(x.id)}/refine`, {});
          busy = true;
          await load();
        } catch (e) { toast(e.message); }
      }
    }));
  }

  // Use this idea (B8): its outline stub goes into Record's script. A script with text is never overwritten: asked
  // first, the outline goes under it or nothing changes. Then the project chat offers "Ask Claude to outline it".
  async function useIdea(x) {
    try {
      let r = await api(`${P}/items/${encodeURIComponent(x.id)}/use`, {});
      if (r.exists) {
        const yes = await confirmBox({ title: 'Record’s script already has text', ok: 'Add it under the script', cancel: 'Skip',
          text: `It has ${r.words} word${r.words === 1 ? '' : 's'}. Add the outline of ${r.idea?.name || 'this idea'} under it? Nothing is replaced.` });
        if (!yes) return toast('Skipped: the script is as it was.');
        r = await api(`${P}/items/${encodeURIComponent(x.id)}/use`, { append: true });
      }
      used = { name: r.idea?.name || x.name || 'The idea', written: r.written, ask: r.ask };
      paint();
      ideaUsed?.({ name: used.name, ask: r.ask });
    } catch (e) { toast(e.message); }
  }

  gen.onsubmit = async (e) => {
    e.preventDefault();
    const go = $('.pg-go', pane);
    go.disabled = true;
    try {
      await api(`${P}/generate`, { brief: gen.elements.brief.value, more: [...more] });
      more.clear();
      busy = true;
      await load();
    } catch (err) { toast(err.message); paintGenerate(); }
  };
  $('.pg-upload input', pane).onchange = async (e) => {
    for (const f of [...e.target.files]) {
      const r = await fetch(`${P}/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'X-Studio': '1' }, body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast(j.error || `Could not add ${f.name}.`); break; }
    }
    e.target.value = '';
    await load();
  };

  // ---- the inspector: title, winners, resources ----
  function paintInspector() {
    if (!insBox?.isConnected || !view) return;
    const b = view.board, winners = b.items.filter((x) => x.winner);
    const slots = [0, 1, 2].map((i) => {
      const x = winners[i];
      if (!x) return '<li class="pg-slot empty"><span>Empty</span></li>';
      const main = b.main === x.id;
      return `<li class="pg-slot${main ? ' main' : ''}" data-id="${esc(x.id)}"><img src="${img(x)}" alt="">
        <span class="pg-slot-tx"><b>${esc(x.name || 'Card')}</b>${main ? '<span class="pg-tag">Main</span><button type="button" class="nc-link" data-act="use">Use this idea</button>' : `<button type="button" class="nc-link" data-act="main">Make main</button>`}
        <button type="button" class="nc-link" data-act="out">Take out</button></span></li>`;
    }).join('');
    const keep = $('.pg-title input', insBox)?.value;
    insBox.innerHTML = `<div class="pg-ins">
      <section class="ins-sec"><h3>Working title</h3>
        <form class="pg-title"><input name="title" maxlength="200" value="${esc(b.title)}" aria-label="Working title" placeholder="The title you plan to use"><button class="btn small">Save</button></form>
        <p class="sub">Fills the Post tab’s YouTube title when it is empty; never replaces one. A video that is still named automatically takes it as its name.</p></section>
      <section class="ins-sec"><h3>Winners <span class="sub">${winners.length} of ${b.limits.winners}</span></h3>
        <ol class="pg-slots">${slots}</ol>
        <p class="sub">The main thumbnail finishes Package on the rail.</p></section>
      <section class="ins-sec"><h3>Resources</h3><div class="rs-panel pg-res"></div></section>
    </div>`;
    if (keep !== undefined && keep !== b.title) $('.pg-title input', insBox).value = keep;
    $('.pg-title', insBox).onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api(`${P}/title`, { title: e.target.elements.title.value });
        // (An automatically named video is renamed too; the project bar hears it from its own event stream.)
        toast(r.post === 'filled' ? 'Saved, and put in the Post tab’s empty title.' : r.post === 'kept' ? 'Saved. The Post tab keeps its own title.' : 'Saved. The post kit will use it.');
        await load();
        onChange?.();
      } catch (err) { toast(err.message); }
    };
    insBox.querySelectorAll('.pg-slot[data-id]').forEach((li) => {
      const x = b.items.find((y) => y.id === li.dataset.id);
      li.querySelectorAll('[data-act]').forEach((btn) => (btn.onclick = () => (btn.dataset.act === 'use' ? useIdea(x) : mark(x, btn.dataset.act === 'main' ? { main: true } : { winner: false }))));
    });
    resources?.teardown?.();
    resources = $('.pg-res', insBox);
    mountResources(resources, { project: id, compact: true });
  }

  return {
    show() { start(); load().catch((e) => toast(e.message)); },
    hide() {},
    // Called on every project refresh: repainted only when the box shows something else (keeps an open form).
    inspector(box) {
      if (insBox === box && box.querySelector('.pg-ins')) return;
      insBox = box;
      if (view) paintInspector(); else box.innerHTML = '<p class="sub pg-wait">Loading…</p>';
    },
    destroy() { events?.close(); chat?.destroy?.(); resources?.teardown?.(); clearTimeout(timer); },
  };
}

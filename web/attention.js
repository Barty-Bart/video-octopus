// Never miss a permission request: every chat (a project's, Packaging's, a study's, the assistant's, the Library's)
// tells this module when its agent is waiting for an answer, and when it no longer is. While anything waits:
// - the tab's title starts with "● Waiting for you", whatever page set it;
// - listeners (the chat panel's banner, the editor's top bar badge) repaint;
// - a fresh request (not a replay) shows a desktop notification when the window isn't in front, if the creator allowed
//   them (offered once, from the banner: offerNotifications), and plays a short sound if they turned it on.
// Claude's state (B10) is the same model, one level up: see "Claude's state" below.
const PREFIX = '● Waiting for you · ';
const asks = new Map(); // key (`${chat}:${id}`) -> { chat, id, kind: 'permission' | 'question', text, focus(), at }
const listeners = new Set();
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

export const pending = (chat = null) => [...asks.values()].filter((a) => !chat || (Array.isArray(chat) ? chat.includes(a.chat) : a.chat === chat)).sort((a, b) => a.at - b.at);
export function onAttention(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ask: { chat, id, kind, text, focus }. fresh: it just arrived (not replayed after a reload): notify and ring.
export function waiting(ask, { fresh = false } = {}) {
  const key = `${ask.chat}:${ask.id}`;
  const known = asks.has(key);
  asks.set(key, { kind: 'permission', at: Date.now(), ...asks.get(key), ...ask });
  changed();
  if (fresh && !known) { notify(ask); if (soundOn()) ring(); }
}
export function settled(chat, id) { if (asks.delete(`${chat}:${id}`)) changed(); }
// A chat that goes away (a new session's waits, the panel closed): its waits and its state go with it.
export function clearChat(chat) {
  let any = acts.delete(chat);
  for (const [k, a] of asks) if (a.chat === chat) { asks.delete(k); any = true; }
  if (any) changed();
}

function changed() {
  if (typeof document !== 'undefined') paintTitle();
  for (const fn of listeners) { try { fn(pending()); } catch {} }
}

// ---- Claude's state (B10): working, waiting for you, finished with open items, stopped ----
// Every chat reports what its agent is doing (app.js makeChat; the rail adds a step that didn't finish), and the top
// bar badge, the dock line, the folded chat rail and the tab title show it the same way, in the same words (describe):
//   waiting  a permission request or a question waits for an answer (the asks above; answered in the chat's banner)
//   stopped  the agent stopped mid-turn (it quit or crashed): Send again
//   working  a turn is running: a step's, or a plain chat message
//   open     the turn finished with something left for you: its last reply asks you something ('questions'), the
//            dock's "Didn't finish" ('unfinished'), or notes still open ('notes', for the Polish notes summary).
// Across chats the most pressing wins: waiting, stopped, working, then open.
const acts = new Map(); // chat -> { agent, busy, stopped: { text, retry(), focus() } | null, open: Map(key -> item) }
const act = (chat) => { let a = acts.get(chat); if (!a) acts.set(chat, (a = { agent: null, busy: false, detail: null, stopped: null, open: new Map() })); return a; };
export const RANK = { idle: 0, open: 1, working: 2, stopped: 3, waiting: 4 };
export function chatAgent(chat, name) { act(chat).agent = name || null; }
// detail: what the agent says it is doing ("Compacting the chat…"), while it works.
export function setWorking(chat, on, { detail = null } = {}) {
  const a = act(chat), d = on ? detail ?? (a.busy ? a.detail : null) : null;
  if (a.busy === Boolean(on) && !(on && a.stopped) && a.detail === d) return;
  a.busy = Boolean(on);
  a.detail = d;
  if (on) a.stopped = null; // a new turn: the last one's stop has been dealt with
  changed();
}
// info: { text, retry() (Send again), focus() (the error line in the chat) } or null.
export function setStopped(chat, info) {
  const a = act(chat);
  if (!info && !a.stopped) return;
  a.stopped = info ? { text: '', ...info } : null;
  changed();
}
// item: { count, text (what is open, in words), read() (where to look) } or null to take it away.
export function openItems(chat, key, item) {
  const a = act(chat), old = a.open.get(key);
  if (!item || item.count === 0) { if (a.open.delete(key)) changed(); return; }
  const next = { count: 1, ...item, key };
  if (old && old.count === next.count && old.text === next.text) { a.open.set(key, next); return; }
  a.open.set(key, next);
  changed();
}

// One chat's state from what it reported.
export function chatState({ asks: n = 0, busy = false, stopped = null, open = [] } = {}) {
  return n > 0 ? 'waiting' : busy ? 'working' : stopped ? 'stopped' : open.length ? 'open' : 'idle';
}
// The most pressing of several chats' snapshots ({ chat, agent, asks: [ask], busy, stopped, open: [item] }):
// { state, chat, agent, count, text, items, retry, focus }.
export function pickState(snaps) {
  let best = null, bestRank = 0;
  for (const x of snaps) {
    const state = chatState({ asks: x.asks?.length || 0, busy: x.busy, stopped: x.stopped, open: x.open || [] });
    if (RANK[state] > bestRank) { best = { ...x, state }; bestRank = RANK[state]; }
  }
  if (!best) return { state: 'idle', chat: null, count: 0, text: '', items: [] };
  const out = { state: best.state, chat: best.chat, agent: best.agent || null, count: 0, text: '', items: [] };
  if (best.state === 'waiting') {
    const all = snaps.flatMap((x) => x.asks || []).sort((a, b) => a.at - b.at);
    Object.assign(out, { count: all.length, text: all[0]?.text || '', chat: all[0]?.chat ?? best.chat, focus: all[0]?.focus });
  } else if (best.state === 'stopped') Object.assign(out, { count: 1, text: best.stopped.text || '', retry: best.stopped.retry, focus: best.stopped.focus });
  else if (best.state === 'open') {
    const items = best.open || [];
    Object.assign(out, { items, count: items.reduce((n, i) => n + (i.count || 1), 0), text: items.map((i) => i.text).filter(Boolean).join(' · '), focus: items.find((i) => i.read)?.read });
  } else if (best.state === 'working') Object.assign(out, { count: 1, text: best.detail || '' });
  return out;
}
// The state of these chats (an id, a list, or null for every chat on the page).
export function stateOf(chats = null) {
  const want = chats == null ? null : new Set(Array.isArray(chats) ? chats : [chats]);
  const names = new Set([...acts.keys(), ...[...asks.values()].map((a) => a.chat)]);
  const snaps = [...names].filter((c) => !want || want.has(c)).map((c) => {
    const a = acts.get(c) || { busy: false, stopped: null, open: new Map() };
    return { chat: c, agent: a.agent, asks: pending(c), busy: a.busy, detail: a.detail || null, stopped: a.stopped, open: [...a.open.values()] };
  });
  return pickState(snaps);
}
// The same words everywhere: badge (top bar), line (dock), title (the tab's prefix), mark (folded rail), label (a
// screen reader's and the tooltip's sentence).
export function describe(st, agent = st?.agent || agentName()) {
  const n = st?.count || 0;
  switch (st?.state) {
    case 'waiting': return { badge: n > 1 ? `${n} waiting for you` : 'Waiting for you', line: 'Waiting for you', title: PREFIX, mark: 'waiting',
      label: `${agent} is waiting for you${st.text ? `: ${st.text}` : ''}` };
    case 'stopped': return { badge: `${agent} stopped`, line: `${agent} stopped`, title: STOPPED_MARK, mark: 'stopped',
      label: `${agent} stopped${st.text ? `: ${st.text}` : ''}. Send again to retry.` };
    case 'working': return { badge: 'Working', line: `${agent} is working`, title: WORKING_MARK, mark: 'working', label: `${agent} is working` };
    case 'open': return { badge: `Finished · ${n} open`, line: 'Finished', title: '', mark: 'open',
      label: `${agent} finished${st.text ? `, with this left for you: ${st.text}` : ''}` };
    default: return { badge: '', line: '', title: '', mark: '', label: '' };
  }
}
// The tab's title: "● Waiting for you · " while anything waits; a quieter "◌ " while working; "! " once stopped.
const WORKING_MARK = '◌ ', STOPPED_MARK = '! ';
export function titleFor(title, st, applied = '') {
  const base = applied && title.startsWith(applied) ? title.slice(applied.length) : title.startsWith(PREFIX) ? title.slice(PREFIX.length) : title;
  const mark = describe(st).title;
  return { title: mark + base, applied: mark };
}

// ---- the tab's title ----
let watching = false, applied = '';
function paintTitle() {
  const next = titleFor(document.title, stateOf(), applied);
  applied = next.applied;
  if (document.title !== next.title) document.title = next.title;
  // A page that sets its own title meanwhile (another stage, Settings) gets the mark back.
  if (!watching && document.head) {
    watching = true;
    new MutationObserver(() => { if (applied && !document.title.startsWith(applied)) paintTitle(); })
      .observe(document.head, { subtree: true, childList: true, characterData: true });
  }
}

// ---- desktop notifications: asked once, nicely, from the banner (a click, so the browser allows the question) ----
export const notificationsOn = () => typeof Notification !== 'undefined' && Notification.permission === 'granted';
export const canOfferNotifications = () => typeof Notification !== 'undefined' && Notification.permission === 'default' && store.get('vo.notify.asked') !== '1';
export async function offerNotifications() {
  store.set('vo.notify.asked', '1');
  try { return (await Notification.requestPermission()) === 'granted'; } catch { return false; }
}
function notify(ask) {
  if (!notificationsOn() || (!document.hidden && document.hasFocus())) return;
  try {
    const n = new Notification(ask.kind === 'question' ? `${agentName()} has a question for you` : `${agentName()} is waiting for you`, {
      body: ask.text || 'Allow or deny the next step in Video Octopus.', tag: `vo-${ask.chat}`, renotify: true,
    });
    n.onclick = () => { window.focus(); ask.focus?.(); n.close(); };
  } catch {}
}
export const agentName = () => (typeof window !== 'undefined' && window.STUDIO_AGENT) || 'Claude';

// ---- the optional sound: two short soft tones ----
export const soundOn = () => store.get('vo.notify.sound') === '1';
export function setSound(on) { store.set('vo.notify.sound', on ? '1' : '0'); if (on) ring(); }
let ctx = null;
function ring() {
  try {
    ctx ||= new AudioContext();
    const t = ctx.currentTime;
    [[660, 0], [880, 0.16]].forEach(([f, d]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.12, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.14);
      o.connect(g).connect(ctx.destination);
      o.start(t + d); o.stop(t + d + 0.16);
    });
  } catch {}
}

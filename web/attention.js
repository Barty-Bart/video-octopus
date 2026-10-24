// Never miss a permission request: every chat (a project's, Packaging's, a study's, the assistant's, the Library's)
// tells this module when its agent is waiting for an answer, and when it no longer is. While anything waits:
// - the tab's title starts with "● Waiting for you", whatever page set it;
// - listeners (the chat panel's banner, the editor's top bar badge) repaint;
// - a fresh request (not a replay) shows a desktop notification when the window isn't in front, if the creator allowed
//   them (offered once, from the banner: offerNotifications), and plays a short sound if they turned it on.
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
export function clearChat(chat) {
  let any = false;
  for (const [k, a] of asks) if (a.chat === chat) { asks.delete(k); any = true; }
  if (any) changed();
}

function changed() {
  paintTitle();
  for (const fn of listeners) { try { fn(pending()); } catch {} }
}

// ---- the tab's title ----
let watching = false;
function paintTitle() {
  const base = document.title.startsWith(PREFIX) ? document.title.slice(PREFIX.length) : document.title;
  const want = asks.size ? PREFIX + base : base;
  if (document.title !== want) document.title = want;
  // A page that sets its own title meanwhile (another stage, Settings) gets the dot back.
  if (!watching && document.head) {
    watching = true;
    new MutationObserver(() => { if (asks.size && !document.title.startsWith(PREFIX)) paintTitle(); })
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
export const agentName = () => window.STUDIO_AGENT || 'Claude';

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

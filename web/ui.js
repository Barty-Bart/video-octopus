// Small helpers shared by the Video Octopus pages.
export const $ = (sel, el = document) => el.querySelector(sel);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

export async function api(path, data) {
  const opts = data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify(data) };
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !('ok' in j)) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

let toastTimer;
export function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

export const ago = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
export const clock = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); const s = (t % 60).toFixed(1).padStart(4, '0'); return `${m}:${s}`; };
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// The cut's name where the creator reads it (Export → Length, the Cut tab's files): the locked cut only while the Lock
// holds (server/export.mjs cut.state: locked | changed | rough).
export const cutWord = (cut) => (cut?.state === 'changed' ? 'Cut · changed after the lock, joins not checked' : cut?.state === 'rough' ? 'Rough cut' : 'Locked cut');

// The agents a chat can run on, by the names people know them by (the server's ENGINES map has the same).
export const ENGINES = { claude: 'Claude Code', codex: 'Codex', pi: 'pi' };
export const engineName = (e) => ENGINES[e || 'claude'] || e;

// ---------- this computer ----------
// The server says which system Video Octopus runs on and where home is (/api/status: platform, home); app.js passes the
// status on with setSystem. Until then, or with a server that doesn't say, the browser's own platform is used.
let SYS = { platform: '', home: '' };
export function setSystem(st) { SYS = { platform: String(st?.platform || ''), home: String(st?.home || '') }; }
const system = () => {
  const p = (SYS.platform || navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
  return p === 'darwin' || p.startsWith('mac') ? 'mac' : p.startsWith('win') ? 'windows' : 'other';
};
// Keyboard shortcuts: ⌘ on a Mac, Ctrl elsewhere (the keyboard in front of the browser).
export const isMac = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
// The file manager's name for "Show in …": Finder on a Mac, File Explorer on Windows. short: for a small button.
export function fileManager(short = false) {
  const s = system();
  return s === 'mac' ? 'Finder' : s === 'windows' ? (short ? 'Explorer' : 'File Explorer') : short ? 'Folder' : 'the file manager';
}
// A path to show, with the home folder as ~: the server's home when it says, else /Users/<name>, /home/<name> or
// C:\Users\<name>.
export function tilde(p) {
  p = String(p ?? '');
  const home = SYS.home.replace(/[\\/]+$/, '');
  if (home) {
    const win = /^[a-z]:\\/i.test(home), head = p.slice(0, home.length);
    const under = (win ? head.toLowerCase() === home.toLowerCase() : head === home) && (p.length === home.length || /[\\/]/.test(p[home.length]));
    return under ? `~${p.slice(home.length)}` : p;
  }
  return p.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[a-z]:[\\/]Users[\\/][^\\/]+)(?=$|[\\/])/i, '~');
}

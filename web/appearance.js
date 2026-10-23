// Settings › General › Appearance: how Video Octopus itself looks (design V2, 23 Oct 2026).
//   theme   light | dark | system — <html data-theme="light|dark">, Match system resolved through
//           prefers-color-scheme and followed live;
//   accent  orange | blue | green | violet — <html data-accent>;
//   sidebar icons | labels — <html data-rail>, the rail's width (web/shell.js).
// The video's own look is Settings › Editing & sound › Video defaults, which this never touches.
//
// The choice lives in settings (appearance.*, read from /api/status on every page) and is cached in localStorage
// (studio.theme), which the small script at the top of index.html reads before the stylesheets paint, so a reload
// never flashes the other theme. An older browser cache (studio.look, from the ten looks) is mapped once.
import { api, toast } from './ui.js';
import { THEMES, ACCENTS, SIDEBARS, GROUND, themeOfLook } from './theme-map.js';
import { icon } from './icons.js';

const KEY = 'studio.theme';
const OLD_KEY = 'studio.look';
const root = document.documentElement;
const media = (() => { try { return matchMedia('(prefers-color-scheme: dark)'); } catch { return null; } })();

let current = { theme: 'system', accent: 'orange', sidebar: 'labels' };
const listeners = new Set();
export const onAppearance = (fn) => (listeners.add(fn), () => listeners.delete(fn));
export const currentAppearance = () => ({ ...current, resolved: resolvedTheme() });

const resolvedTheme = (theme = current.theme) => {
  if (theme === 'light' || theme === 'dark') return theme;
  return media?.matches ? 'dark' : 'light';
};

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (c && typeof c === 'object') return c;
    const old = JSON.parse(localStorage.getItem(OLD_KEY) || 'null');
    if (old && typeof old === 'object') return { theme: themeOfLook(old.look) };
  } catch {}
  return {};
}
function writeCache() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...current, resolved: resolvedTheme() }));
    localStorage.removeItem(OLD_KEY);
  } catch {}
}

const valid = (a = {}) => ({
  theme: THEMES.includes(a.theme) ? a.theme : current.theme,
  accent: ACCENTS.includes(a.accent) ? a.accent : current.accent,
  sidebar: SIDEBARS.includes(a.sidebar) ? a.sidebar : current.sidebar,
});

// Put an appearance on the page: the attributes, the cache and the browser's theme colour. Listeners hear about a
// change of the resolved theme or the accent (the canvases and the Cut Editor repaint).
export function applyAppearance(a = {}) {
  const before = `${resolvedTheme()}/${current.accent}/${current.sidebar}`;
  current = valid(a);
  const resolved = resolvedTheme();
  root.dataset.theme = resolved;
  root.dataset.accent = current.accent;
  root.dataset.rail = current.sidebar;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', GROUND[resolved]);
  writeCache();
  const after = `${resolved}/${current.accent}/${current.sidebar}`;
  if (after !== before || root.dataset.theme !== resolved) notify();
  return currentAppearance();
}
function notify() {
  const now = currentAppearance();
  for (const fn of listeners) { try { fn(now); } catch {} }
}

// A change from the page: shown at once, then saved. A failed save puts the previous one back.
export async function saveAppearance(patch) {
  const prev = { ...current };
  applyAppearance({ ...current, ...patch });
  try {
    await api('/api/app/settings', { section: 'appearance', values: patch });
    return true;
  } catch (e) {
    applyAppearance(prev);
    toast(e.message);
    return false;
  }
}

// The theme switch in page headers and the editor's top bar (§3): Light and Dark, the resolved one pressed. A click
// sets the theme explicitly, which leaves Match system.
export function themeSwitch() {
  const box = document.createElement('div');
  box.className = 'theme-switch';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Theme');
  box.innerHTML = `<button type="button" data-theme-pick="light" aria-label="Light" title="Light">${icon('sun')}</button>`
    + `<button type="button" data-theme-pick="dark" aria-label="Dark" title="Dark">${icon('moon')}</button>`;
  const paint = () => {
    const resolved = resolvedTheme();
    for (const b of box.querySelectorAll('button')) {
      const on = b.dataset.themePick === resolved;
      b.setAttribute('aria-pressed', String(on));
      b.title = current.theme === 'system' && on ? `${b.getAttribute('aria-label')} (matching your system)` : b.getAttribute('aria-label');
    }
  };
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-pick]');
    if (b) saveAppearance({ theme: b.dataset.themePick });
  });
  paint();
  // Once taken off the page, the switch stops listening (noticed on the next change).
  let shown = false;
  const off = onAppearance(() => {
    if (box.isConnected) { shown = true; paint(); } else if (shown) off();
  });
  return box;
}

// Match system follows the computer's light or dark setting while the page is open.
media?.addEventListener?.('change', () => { if (current.theme === 'system') applyAppearance(current); });

// Another Video Octopus tab changed the appearance: follow it.
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  const c = readCache();
  if (c.theme !== current.theme || c.accent !== current.accent || c.sidebar !== current.sidebar) applyAppearance(c);
});

// ---- The Cut Editor in the Cut tab follows the theme ----
// The Cut tab frames the Cut Editor (web/cut-editor/, ?theme=studio); it gets the theme's colours and radii from here,
// resolved to plain rgba() so its waveform canvas can use them too: in the frame's address at load (#look=, so it
// paints in the theme at once) and in a studio:look message on every change (web/cutpanel.js).
const CUT_COLOURS = {
  bg: 'var(--bg)', panel: 'var(--panel)', panel2: 'var(--panel-2)', panel3: 'var(--panel-3)', line: 'var(--line)', line2: 'var(--line-2)',
  text: 'var(--text)', text2: 'var(--text-2)', muted: 'var(--muted)', faint: 'var(--faint)', textHi: 'var(--text-hi)',
  accent: 'var(--accent)', accentHi: 'var(--accent-hi)', accentInk: 'var(--accent-ink)', accentText: 'var(--accent-text)', accentSoft: 'var(--accent-soft)',
  sel: 'var(--sel)', selSoft: 'var(--sel-soft)', selInk: 'var(--sel-ink)', selText: 'var(--sel-text)',
  ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', okInk: 'var(--ok-ink)', warnInk: 'var(--warn-ink)', badInk: 'var(--bad-ink)',
  wave: 'var(--tl-wave)', playhead: 'var(--playhead)', check: 'var(--check)', pop: 'var(--pop-bg)',
};
const rgba = (c) => {
  const m = /^rgba?\(([^)]+)\)$/.exec(c) || /^color\(srgb ([^)]+)\)$/.exec(c);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number), k = c.startsWith('color(') ? 255 : 1;
  if (p.length < 3 || p.some((x) => !Number.isFinite(x))) return null;
  const [r, g, b] = p.slice(0, 3).map((x) => Math.round(Math.max(0, Math.min(255, x * k))));
  return `rgba(${r}, ${g}, ${b}, ${+(p[3] ?? 1).toFixed(3)})`;
};
export function cutLook() {
  const id = resolvedTheme();
  if (!document.body) return { id };
  const probe = document.createElement('i');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  document.body.append(probe);
  const c = {};
  for (const [k, v] of Object.entries(CUT_COLOURS)) { probe.style.color = v; c[k] = rgba(getComputedStyle(probe).color) || ''; }
  probe.remove();
  const cs = getComputedStyle(root), tok = (k) => cs.getPropertyValue(k).trim();
  return {
    id, dark: id === 'dark', c, font: tok('--font'), mono: tok('--mono'),
    ctl: tok('--ctl-radius'), card: tok('--r-l'), clear: false, f: [],
  };
}
// What the Cut tab adds to the Cut Editor's address: &look=<theme>, and the colours after # (never sent to a server).
export function cutLookParams() {
  const l = cutLook();
  return `&look=${encodeURIComponent(l.id)}${l.c ? `#look=${encodeURIComponent(JSON.stringify(l))}` : ''}`;
}

// Until /api/status answers, the page keeps what index.html's early script set from the cache.
current = valid(readCache());

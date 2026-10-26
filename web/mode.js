// The editor mode on the page (Settings › General › Editor mode, setting editor.mode): the one gate every hidden
// surface asks. Simple is the default for everyone; Advanced shows the whole app as it was (beta.23). Hide, never
// delete: nothing here changes data, and the server keeps every route.
//
// app.js sets it from /api/status (editor.mode) on every loadStatus, and Settings sets it after a save. It also puts
// <html data-mode="simple|advanced"> on the page, for CSS that hides an Advanced-only control.
//   import { isAdvanced } from './mode.js';  if (isAdvanced()) { …the Advanced-only surface… }
import { EDITOR_MODES, DEFAULT_MODE } from './simple.js';

let mode = DEFAULT_MODE;
const listeners = new Set();

export const editorMode = () => mode;
export const isAdvanced = () => mode === 'advanced';
export const onEditorMode = (fn) => (listeners.add(fn), () => listeners.delete(fn));

// Set the mode (an unknown value is Simple). Listeners hear about a change only.
export function setEditorMode(next) {
  const m = EDITOR_MODES.includes(next) ? next : DEFAULT_MODE;
  if (typeof document !== 'undefined') document.documentElement.dataset.mode = m;
  if (m === mode) return m;
  mode = m;
  for (const fn of listeners) { try { fn(m); } catch (e) { console.error(e); } }
  return m;
}

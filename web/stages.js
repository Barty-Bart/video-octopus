// The editor's stage bar is its navigation (ADDENDUM-stage-bar.md, 24 Oct 2026): clicking a stage opens that stage's
// workspace. This module holds the plain rules, with no DOM, so they can be tested on their own
// (test/stage-bar.test.mjs):
// - which pane each stage opens (Record and Build share the canvas, Plan and Polish share Scenes, the UI-only Publish
//   stage holds Renders and Post in one pane);
// - the stages a project shows (its pipeline's, plus Publish);
// - the project address with the stage in it (#/p/<id>?stage=cut) and the old ?tab= addresses;
// - where a project opens: ?stage=, else ?tab=, else the stage last used in it, else its old remembered tab, else the
//   stage of the next step.

// Every stage, in order. Package is optional and only shows when the format has a package step.
export const STAGE_ORDER = ['Package', 'Record', 'Cut', 'Plan', 'Build', 'Polish', 'Publish'];

// The pane a stage opens.
export const STAGE_PANE = {
  Package: 'packaging',
  Record: 'canvas',
  Cut: 'cut',
  Plan: 'scenes',
  Build: 'canvas',
  Polish: 'scenes',
  Publish: 'publish',
};

// The workspace toolbar's words for each pane: its name and one line on what it is.
export const PANE_WORDS = {
  packaging: { name: 'Packaging', about: 'thumbnail ideas with Codex, any time' },
  canvas: { name: 'Canvas', about: 'your video: layout, camera, screen and the timeline' },
  cut: { name: 'Cut', about: 'the cut, word by word' },
  scenes: { name: 'Scenes', about: 'Claude’s plan scene by scene; review and leave notes' },
  publish: { name: 'Publish', about: 'finished videos, then the title, description and captions' },
};

// The old tabs and the pane each one lives in now (Renders and Post are sections of Publish).
export const OLD_TABS = ['packaging', 'canvas', 'scenes', 'cut', 'renders', 'post'];
export function paneOfTab(tab) {
  if (tab === 'renders' || tab === 'post') return 'publish';
  return Object.values(STAGE_PANE).includes(tab) ? tab : null;
}

// An old tab → its stage. The canvas is Build once there is a take, Record before.
export function stageOfTab(tab, { hasTake = true } = {}) {
  switch (tab) {
    case 'packaging': return 'Package';
    case 'canvas': return hasTake ? 'Build' : 'Record';
    case 'scenes': return 'Plan';
    case 'cut': return 'Cut';
    case 'renders':
    case 'post':
    case 'publish': return 'Publish';
    default: return null;
  }
}

export const stageSlug = (name) => String(name || '').toLowerCase();

// 'cut' → 'Cut', among the stage names given (null when it isn't one of them).
export function stageFromSlug(slug, names = STAGE_ORDER) {
  const s = String(slug || '').trim().toLowerCase();
  return names.find((n) => n.toLowerCase() === s) || null;
}

// The stages a project shows: its pipeline's (the server leaves Package out when the format has no package step), then
// Publish. A project without a format (no pipeline yet) shows every stage, without steps, so each pane stays reachable.
export function stagesOf(pipeline) {
  const own = Array.isArray(pipeline?.stages) ? pipeline.stages : null;
  const list = own
    ? own.filter((st) => STAGE_PANE[st.name] && st.name !== 'Publish').map((st) => ({ ...st, steps: st.steps || [] }))
    : STAGE_ORDER.filter((n) => n !== 'Publish').map((name) => ({ name, steps: [], title: '', what: '' }));
  list.push({ name: 'Publish', steps: [], ui: true, title: 'Export and post', what: 'Your renders, then the title, description and captions.' });
  return list;
}

// A project address: '#/p/<id>?stage=cut' → { id, query }. Not a project address → null.
export function parseProjectHash(hash) {
  const m = /^#\/p\/([^?]+)(?:\?(.*))?$/.exec(String(hash || ''));
  if (!m) return null;
  let id = m[1];
  try { id = decodeURIComponent(m[1]); } catch {}
  return { id, query: new URLSearchParams(m[2] || '') };
}

// The same address with the stage in it (any old ?tab= goes; other query keys stay).
export function stageHash(id, stage, query = null) {
  const q = new URLSearchParams(query || '');
  q.delete('tab');
  if (stage) q.set('stage', stageSlug(stage));
  const text = q.toString();
  return `#/p/${encodeURIComponent(id)}${text ? `?${text}` : ''}`;
}

// Where a project opens, in order:
//   query ?stage=<slug>, then the old ?tab=<tab>, then `remembered` (the stage last used in this project), then
//   `legacyTab` (the tab the old tab row remembered), then the stage of the next step (`next`), then Publish when every
//   step is done, else the first stage. `names` are the stages the project shows; one it doesn't show is passed over.
export function landingStage({ query = null, remembered = null, legacyTab = null, next = null, allDone = false, names = STAGE_ORDER, hasTake = true } = {}) {
  const q = query instanceof URLSearchParams ? query : new URLSearchParams(query || '');
  const has = (n) => (n && names.includes(n) ? n : null);
  return has(stageFromSlug(q.get('stage'), names))
    || has(stageOfTab(q.get('tab'), { hasTake }))
    || has(stageFromSlug(remembered, names))
    || has(stageOfTab(legacyTab, { hasTake }))
    || has(next)
    || (allDone ? has('Publish') : null)
    || has(hasTake ? 'Build' : 'Record')
    || names[0]
    || 'Record';
}

// The stage last used in a project, kept in localStorage (storage passed in, so the tests can give their own).
export const stageKey = (id) => `studio.stage.${id}`;
export const legacyTabKey = (id) => `studio.tab.${id}`;
export function rememberStage(storage, id, stage) {
  try { storage?.setItem(stageKey(id), stageSlug(stage)); } catch {}
}
export function recallStage(storage, id) {
  try { return storage?.getItem(stageKey(id)) || null; } catch { return null; }
}
// The old tab row kept its tab in sessionStorage (and some builds in localStorage): read either, once.
export function recallLegacyTab(storages, id) {
  for (const s of storages || []) {
    try {
      const v = s?.getItem(legacyTabKey(id));
      if (v && OLD_TABS.includes(v)) return v;
    } catch {}
  }
  return null;
}

// The stage a pane switch lands on: the hinted stage when it opens that pane, else the current stage when it already
// shows that pane (Build stays Build when something opens the canvas), else the pane's own stage.
export function stageForPane(tab, { current = null, hint = null, hasTake = true, names = STAGE_ORDER } = {}) {
  const pane = paneOfTab(tab);
  if (!pane) return current;
  if (hint && names.includes(hint) && STAGE_PANE[hint] === pane) return hint;
  if (current && STAGE_PANE[current] === pane) return current;
  const own = stageOfTab(tab, { hasTake });
  if (own && names.includes(own)) return own;
  return names.find((n) => STAGE_PANE[n] === pane) || current;
}

// The first scene with notes still open (not resolved), in the scenes' order: where Polish opens Scenes.
export function firstNotedScene(data) {
  const scenes = data?.scenes || [], notes = data?.notes || [];
  const noted = new Set(notes.filter((n) => n && n.scene && n.kind !== 'change' && n.status !== 'resolved').map((n) => n.scene));
  return scenes.find((s) => noted.has(s.id))?.id || null;
}

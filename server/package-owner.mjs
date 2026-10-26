// Whose change is it? The change package (server/cutsync.mjs) is only for the creator's own edits in the window: the
// blocks and the canvas look they changed since Claude last got them. Claude's own work applies directly (it shows in
// the chat with Undo, server/turns.mjs), and so does what Video Octopus writes by itself (settling rule blocks after a
// read, server/blocks.mjs). The project's file watcher (index.mjs watchProject) and the turn's end ask this module.
//
// - A window route stamps the project (touched): saving the layout, the blocks, shots, an import… Read-only and
//   bookkeeping routes (the rail's "seen", the tabs' badges) are not on the list, so they never make Claude's write look
//   like the creator's.
// - claudeWrites(id): Claude is working, or its turn ended a moment ago (its last write reaches the watcher ~0.7 s later),
//   and the window saved nothing in the last 3 s.
// - onDocFiles: blocks.json / project.json changed and Claude wrote it: it becomes the package's starting point.
// - afterTurn: a turn ended (a step, a chat reply, Save changes → Claude): settle the blocks once more, then everything
//   Claude wrote is the new starting point. A change the creator made in the window just now still goes in first.
// - serverWrite: Video Octopus is about to write a window file itself (a settle): whatever the creator changed and the
//   watcher hasn't seen yet goes in the package first; the write itself never does.
import { markPackageBase, syncDocItems } from './cutsync.mjs';

// POST routes of a project that save something the creator changed in the window (index.mjs stamps them).
export const UI_ROUTES = ['/layout', '/blocks', '/shots', '/zooms', '/upload', '/drop', '/final', '/type', '/rename', '/import', '/take-upload',
  '/media-use', '/media-layer', '/media-remove', '/media-restore'];
export const UI_QUIET_MS = 3000;   // the window saved within this long: the change is the creator's
export const TURN_TAIL_MS = 2000;  // a write this soon after Claude's turn ended is still Claude's (watcher debounce 0.7 s)

export function makePackageOwner({ busy = () => false, now = () => Date.now(), note = () => {}, settle = () => {} } = {}) {
  const touchedAt = new Map(), endedAt = new Map();
  const uiRecent = (id) => now() - (touchedAt.get(id) || 0) <= UI_QUIET_MS;
  const claudeWrites = (id) => (busy(id) || now() - (endedAt.get(id) || -Infinity) <= TURN_TAIL_MS) && !uiRecent(id);
  // The creator's changes the watcher hasn't put in the package yet: there now, with a line in the chat.
  const syncMine = (id, dir) => { for (const n of syncDocItems(dir) || []) note(id, n); };
  return {
    touch(id) { touchedAt.set(id, now()); },
    touched: (id) => touchedAt.get(id) || 0,
    uiRecent, claudeWrites,
    // The watcher saw blocks.json or project.json change. true: it was Claude's (the base moved along with it).
    onDocFiles(id, dir) {
      if (!claudeWrites(id)) return false;
      markPackageBase(dir, { keepOpen: true });
      return true;
    },
    afterTurn(id, dir) {
      endedAt.set(id, now());
      if (uiRecent(id)) syncMine(id, dir);
      try { settle(dir); } catch (e) { console.error('settle after the turn:', e.message); }
      markPackageBase(dir, { keepOpen: true });
    },
    serverWrite(id, dir, write) {
      if (claudeWrites(id)) markPackageBase(dir, { keepOpen: true });
      else syncMine(id, dir);
      const r = write();
      markPackageBase(dir, { keepOpen: true });
      return r;
    },
  };
}

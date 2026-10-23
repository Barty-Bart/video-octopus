// The system prompt Video Octopus appends for Claude Code and pi goes to them as a file, not on the command line:
// Windows caps a whole command line at 32,767 characters, and a project chat's context alone is about 40 KB.
// Claude Code reads --append-system-prompt-file <file>; pi's --append-system-prompt reads a file when given its path.
// (Codex gets its instructions over app-server JSON-RPC on stdin, so it needs neither.)
//
// One file per agent process, in the app's own local folder (never the studio or a shared temp folder), readable only
// by this user. It holds exactly the text that used to be an argument: the context and settings brief (key names, never
// key values). The file lives as long as its process, because pi reads it again when it reloads its resources, and is
// removed when the process ends; files left by a crashed server are removed the next time one is written.
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LOCAL_DIR } from './util.mjs';

export const PROMPT_DIR = join(LOCAL_DIR, 'agent-prompts');
const live = new Set();
let swept = false;

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// Files named for a server process that no longer runs. Another server sharing this local folder keeps its own.
function sweep() {
  if (swept) return;
  swept = true;
  let names = [];
  try { names = readdirSync(PROMPT_DIR); } catch { return; }
  for (const name of names) {
    const pid = Number(/^(\d+)-/.exec(name)?.[1]);
    if (pid && pid !== process.pid && alive(pid)) continue;
    try { rmSync(join(PROMPT_DIR, name), { force: true }); } catch {}
  }
}

// Writes `text` for one agent process: { path, remove() }. remove() is safe to call more than once.
export function writePromptFile(engine, text) {
  mkdirSync(PROMPT_DIR, { recursive: true, mode: 0o700 });
  sweep();
  const path = join(PROMPT_DIR, `${process.pid}-${engine}-${randomUUID()}.md`);
  writeFileSync(path, text, { mode: 0o600 });
  live.add(path);
  return {
    path,
    remove() {
      if (!live.delete(path)) return;
      try { rmSync(path, { force: true }); } catch {}
    },
  };
}

// The server is exiting: its agents go with it, so their prompt files do too.
process.once('exit', () => {
  for (const path of live) { try { rmSync(path, { force: true }); } catch {} }
  live.clear();
});

// Explicitly imported Video Octopus logs only. No provider memory/session directories.
import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { safeFile } from './learning-store.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
export function appHistoryPreview(store, logRoot, chat) {
  const binding = store.chat(chat);
  if (!binding) throw Error('Open and use this chat before importing its history.');
  const names = existsSync(logRoot) ? readdirSync(logRoot).filter(n => n === `${chat}.jsonl` || (n.startsWith(`${chat}--`) && /^[\w.-]+\.jsonl$/.test(n))).sort() : [];
  let size = 0; const events = [], hashes = [];
  for (const name of names) {
    const file = safeFile(logRoot, name), st = lstatSync(file);
    size += st.size;
    if (!st.isFile() || size > 5e6) throw Error('Import is limited to 5 MB of app history per chat.');
    const raw = readFileSync(file, 'utf8'); hashes.push(hash(raw));
    for (const line of raw.split('\n').filter(Boolean)) {
      const e = JSON.parse(line);
      if (!['user', 'text', 'tool_result'].includes(e.t) || e.brief || typeof e.text !== 'string' || !e.text.trim()) continue;
      // Same original event keeps the same identity when moved into an archive or imported again.
      events.push({ ...e, eventId: typeof e.eventId === 'string' && e.eventId.length <= 128 ? e.eventId : hash(chat + '\n' + line), conversation: e.conversation || name });
      if (events.length > 10000) throw Error('Import is limited to 10,000 messages.');
    }
  }
  return { chat, scope: binding.scope, files: names.length, count: events.length, sample: events.slice(0, 3).map(e => ({ role: e.t, text: e.text.slice(0, 300) })), token: hash(JSON.stringify({ chat, scope: binding.scope, names, hashes })), events };
}
export function importAppHistory(store, logRoot, chat, token) {
  const p = appHistoryPreview(store, logRoot, chat);
  if (p.token !== token) throw Error('History changed. Preview it again before import.');
  const backup = store.backup();
  // Importing historical assistant answers must never generate proposals as a side effect.
  for (const event of p.events) store.capture(chat, event, { proposals: false });
  return { imported: p.count, backup: backup.id };
}

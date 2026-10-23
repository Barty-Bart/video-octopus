// Video Octopus's extension for pi (pi.dev), loaded by Video Octopus with `pi -e` every time it starts pi: nothing for the creator
// to install or manage. It does two things, from environment variables Video Octopus sets (server/pi.mjs):
//  1. Approvals. pi runs tools without asking; this asks Video Octopus first (as an extension UI select whose title starts
//     with STUDIO_APPROVAL and a JSON payload), so the creator gets Video Octopus's usual Allow / Always / Deny card.
//     STUDIO_PI_MODE is Video Octopus's permission mode: manual asks before every command and file change; acceptEdits and
//     auto let file changes inside STUDIO_PI_ROOT (a project chat's own folder, else the studio) and the temporary
//     folder through, and auto also plain read-only commands;
//     bypassPermissions never asks. pi's own looking tools (read, grep, find, ls) never ask; a tool from another
//     extension asks like a command. A relative path is one in pi's working folder (a project's folder for a project
//     chat; STUDIO_PI_CWD), read the way pi's own tools read it (~, a leading @, file:// URLs).
//  2. "Video Octopus endpoint": any OpenAI-compatible server (OpenRouter, LM Studio, Ollama, vLLM, a company gateway…) as
//     a pi provider called "studio", when STUDIO_PI_BASE_URL is set; the key comes in as STUDIO_PI_API_KEY.
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODE = process.env.STUDIO_PI_MODE || 'auto';
const ROOT = process.env.STUDIO_PI_ROOT ? resolve(process.env.STUDIO_PI_ROOT) : null;
const WIN = process.platform === 'win32';
const LOOKING = new Set(['read', 'grep', 'find', 'ls']); // pi's tools that only look

// Commands that only look: one, or a chain of them joined by &&, ||, ;, |, & or a new line (no redirects, no command
// substitution), and none with an option that makes it write a file or run another program.
const LOOK = /^(ls|cat|head|tail|wc|grep|rg|find|pwd|echo|which|file|stat|du|df|ffprobe|date|tree|cd|sort|uniq|jq)(?=\s|$)/;
const shortOpt = (w, letters) => /^-[^-]/.test(w) && [...w.slice(1)].some((ch) => letters.includes(ch));
// uniq [OPTION]... [INPUT [OUTPUT]]: a second plain word is the file it writes (-f, -s and -w take a number).
const uniqOutput = (w) => { let plain = 0; for (let i = 0; i < w.length; i++) { if (/^-[fsw]$/.test(w[i])) i++; else if (!w[i].startsWith('-') || w[i] === '-') plain++; } return plain > 1; };
// Per command, from its words after the name: true when it would write or run something.
const WRITES = {
  sort: (w) => w.some((x) => shortOpt(x, 'o') || /^--(o|co)/.test(x)),  // -o/--output FILE, --compress-program PROG
  tree: (w) => w.some((x) => shortOpt(x, 'oR')),                          // -o FILE; -R writes 00Tree.html files
  find: (w) => w.some((x) => /^-(fprint0?|fprintf|fls|exec|execdir|ok|okdir|delete)$/.test(x)),
  uniq: uniqOutput,
  rg: (w) => w.some((x) => /^--pre(=|$)/.test(x)),                      // --pre COMMAND runs it on every file
  file: (w) => w.some((x) => shortOpt(x, 'C') || /^--co/.test(x)),       // -C/--compile writes a .mgc file
  ffprobe: (w) => w.some((x) => x === '-o' || x === '-report'),         // -o FILE; -report writes a log file
};
// Exported for Video Octopus itself (server/readonly.mjs: the Video Octopus assistant answers these without a card too).
export const readOnly = (raw) => {
  // Throwing output away (2>/dev/null) or joining it (2>&1) is still only looking.
  const cmd = raw.replace(/\d?>\s*\/dev\/null(?![^\s;&|])/g, '').replace(/\d?>&\d(?![^\s;&|])/g, '');
  if (/[`<>]|\$\(/.test(cmd)) return false;
  return cmd.split(/&&|\|\||[;&|\r\n]/).every((part) => {
    const p = part.trim();
    if (!p) return true;
    const m = LOOK.exec(p);
    if (!m) return false;
    if (!WRITES[m[1]]) return true;
    // $… and {…} can spell any option (${X:-delete}, -{delete,true}), and a wildcard in an option can match one.
    if (/[${}]/.test(p)) return false;
    const words = p.replace(/['"\\]/g, '').split(/\s+/).slice(1);
    return !words.some((x) => x.startsWith('-') && /[*?[]/.test(x)) && !WRITES[m[1]](words);
  });
};

// A path the way pi's own tools read it (utils/paths.js: odd spaces, a leading @, ~, file:// URLs, /c/… on
// Windows), relative to pi's working folder.
function fullPath(p, cwd) {
  let s = String(p || '').replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/^@/, '');
  if (WIN && s.startsWith('/') && !s.startsWith('//') && !s.includes('\\')) {
    const m = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(s);
    if (m) s = `${m[1].toUpperCase()}:\\${(m[2] || '').replaceAll('/', '\\')}`;
  }
  if (s === '~') s = homedir();
  else if (s.startsWith('~/') || (WIN && s.startsWith('~\\'))) s = join(homedir(), s.slice(2));
  else if (/^file:\/\//.test(s)) { try { s = fileURLToPath(s); } catch {} }
  return isAbsolute(s) ? resolve(s) : resolve(cwd, s);
}
// Inside the studio, with symlinks followed (on the longest part of the path that exists) and, on Windows, without
// letter case: a link in the studio that points out of it doesn't count.
function realPlace(p) {
  const rest = [];
  for (let head = p; ; head = dirname(head)) {
    try { return join(realpathSync.native(head), ...rest); } catch {}
    if (dirname(head) === head) return p;
    rest.unshift(basename(head));
  }
}
const fold = (s) => (WIN ? s.toLowerCase() : s);
const within = (root, abs) => {
  const r = fold(realPlace(root)), q = fold(realPlace(abs));
  return q === r || q.startsWith(r.endsWith(sep) ? r : r + sep);
};
// STUDIO_PI_ROOT is the project's folder for a project chat (the same boundary as Claude Code's outside-project check,
// server/outside-hook.mjs), the studio otherwise. Temporary files don't count there either.
const inside = (abs) => Boolean(ROOT && abs && (within(ROOT, abs) || within(tmpdir(), abs)));

export default function (pi) {
  const base = process.env.STUDIO_PI_BASE_URL;
  if (base && process.env.STUDIO_PI_MODEL) {
    pi.registerProvider('studio', {
      name: 'Video Octopus endpoint',
      baseUrl: base,
      apiKey: '$STUDIO_PI_API_KEY',
      authHeader: true,
      api: 'openai-completions',
      models: [{
        id: process.env.STUDIO_PI_MODEL,
        name: process.env.STUDIO_PI_MODEL,
        input: process.env.STUDIO_PI_VISION === '1' ? ['text', 'image'] : ['text'],
        contextWindow: Number(process.env.STUDIO_PI_CONTEXT) || 128000,
        maxTokens: 16384,
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    });
  }

  pi.on('tool_call', async (event, ctx) => {
    if (MODE === 'bypassPermissions') return undefined;
    const name = event.toolName, input = event.input || {};
    if (LOOKING.has(name)) return undefined; // reading, searching, listing
    const isEdit = name === 'write' || name === 'edit', isCmd = name === 'bash' || name === 'powershell';
    const command = String(input.command || '').trim();
    const file = isEdit ? fullPath(input.path, ctx?.cwd || process.env.STUDIO_PI_CWD || process.cwd()) : null;
    if (isEdit && MODE !== 'manual' && inside(file)) return undefined;
    if (name === 'bash' && MODE === 'auto' && readOnly(command)) return undefined;
    if (!ctx.hasUI) return { block: true, reason: 'Video Octopus could not ask the creator about this step.' };
    // PowerShell (pi on Windows) asks as a command; Video Octopus never offers "Always" for it.
    const ask = isCmd ? { tool: 'Bash', input: { command, ...(name === 'powershell' ? { shell: 'powershell' } : {}) } }
      : isEdit ? { tool: name === 'write' ? 'Write' : 'Edit', input: { file_path: file } }
        : { tool: name, input };
    const choice = await ctx.ui.select(`STUDIO_APPROVAL ${JSON.stringify(ask)}`, ['Allow', 'Always', 'Deny']);
    if (choice === 'Allow' || choice === 'Always') return undefined;
    return { block: true, reason: 'The creator said no to this step in Video Octopus.' };
  });
}

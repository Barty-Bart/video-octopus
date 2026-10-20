// Routes for the onboarding screen (Setup): the brand kit (server/brand.mjs), skills from GitHub (server/skills-gh.mjs),
// and the computer scan's own parts: every agent that's here (Claude Code, Codex, LM Studio, Ollama, pi) with what each
// needs, Connect (the creator's click, after a confirmation on the page), the few installs and downloads Setup runs
// itself after an OK (ffmpeg with Homebrew or winget, a model with `lms get` or `ollama pull`), and whether the local
// model server a chat runs on is up (the chat's banner). Nothing here installs, downloads, signs in or switches agents
// unless the page asks, and the page only asks after a click. Answers before /api/app/* in general (setup.mjs reads
// every POST body as JSON, and uploads stream). Returns true when it answered.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { brandView, brandUpload, brandRemove, serveBrandFile, writeBrand } from './brand.mjs';
import { recommendedView, repoView, installSkills } from './skills-gh.mjs';
import { settings, studioTool, childPathEnv, IS_WIN, IS_MAC } from './util.mjs';
import { section, saveSection } from './settings.mjs';
import { claudeInfo } from './claude.mjs';
import { codexInfo } from './codex.mjs';
import { piInfo } from './pi.mjs';
import { sourceCheck, CC_SOURCES, MIN_CONTEXT } from './claude-source.mjs';
import { engineName, localDown, localUrl, forgetLocal } from './engines.mjs';
import { ffmpegInstaller } from './setup.mjs';

const kfmt = (n) => `${Math.round(n / 1024)}K`;
const shell = IS_WIN ? 'PowerShell' : 'Terminal';
// Its command line, for `lms get` / `ollama pull` (LM Studio puts lms in ~/.lmstudio/bin).
function localCli(id) {
  const name = id === 'lmstudio' ? 'lms' : 'ollama', found = studioTool(name);
  if (existsSync(found)) return found;
  const more = id === 'lmstudio' ? [join(homedir(), '.lmstudio', 'bin', IS_WIN ? 'lms.exe' : 'lms')]
    : IS_MAC ? ['/Applications/Ollama.app/Contents/Resources/ollama'] : [];
  return more.find((p) => existsSync(p)) || null;
}
const appThere = (id) => Boolean(localCli(id)) || (id === 'lmstudio' ? existsSync(join(homedir(), '.lmstudio')) || (IS_MAC && existsSync('/Applications/LM Studio.app'))
  : IS_MAC && existsSync('/Applications/Ollama.app'));

// A local server (LM Studio or Ollama), checked with Claude Code's own model-source check (claude-source.mjs), plus
// what a model needs to run Video Octopus's chats: a context of 32K or more where the server says what's loaded.
async function localRow(id) {
  const name = CC_SOURCES[id].short, url = localUrl(id);
  const r = await sourceCheck({ id, label: name, url, model: '', context: 0, local: true });
  const base = { id, name, local: true, url, models: r.models || [], version: r.version || null, messagesApi: Boolean(r.messagesApi), cli: Boolean(localCli(id)),
    install: { url: id === 'lmstudio' ? 'https://lmstudio.ai' : 'https://ollama.com/download' } };
  if (!r.running) {
    return appThere(id)
      ? { ...base, state: 'action', problem: 'off', detail: `${name} · server off`, how: id === 'lmstudio' ? 'Start LM Studio → Developer → Start server, then press Retry.' : 'Start Ollama (the app, or ollama serve in Terminal), then press Retry.' }
      : { ...base, state: 'missing', detail: `${name} isn't on this computer`, how: `Get ${name} from ${base.install.url}, then press Scan again.` };
  }
  if (!r.messagesApi) return { ...base, state: 'action', problem: 'old', detail: `${name}${r.version ? ` ${r.version}` : ''} · too old for Claude Code`,
    how: `Update ${name}, or use it with Codex or pi.`, viaOnly: ['codex'] };
  if (!r.models.length) return { ...base, state: 'action', problem: 'nomodel', detail: `${name}${r.version ? ` ${r.version}` : ''} · running, no model downloaded`,
    how: `Download a model in ${name}, or type its name below and press Download (${id === 'lmstudio' ? 'lms get' : 'ollama pull'}).` };
  // LM Studio says what's loaded and with which context; Ollama's /api/ps does for the models in memory.
  const small = id === 'lmstudio' ? r.models.filter((m) => m.loaded && m.context && m.context < MIN_CONTEXT) : await ollamaSmall(url);
  if (small.length) return { ...base, state: 'action', problem: 'context', detail: `${name} · ${small[0].id} is loaded with a ${kfmt(small[0].context)} context`,
    how: `Claude Code needs a context of ${kfmt(MIN_CONTEXT)} or more. ${id === 'lmstudio' ? `In LM Studio, load the model with Context Length ${MIN_CONTEXT} or more (Developer → the model's settings).` : `Start Ollama with OLLAMA_CONTEXT_LENGTH=${MIN_CONTEXT} (or set the model's num_ctx to ${MIN_CONTEXT}).`}` };
  return { ...base, state: 'ok', detail: `${name}${r.version ? ` ${r.version}` : ''} · running · ${r.models.length} model${r.models.length > 1 ? 's' : ''}` };
}
async function ollamaSmall(url) {
  try {
    const r = await fetch(`${url}/api/ps`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return (j.models || []).filter((m) => Number(m.context_length) && m.context_length < MIN_CONTEXT).map((m) => ({ id: m.name || m.model, context: m.context_length }));
  } catch { return []; }
}

// Every agent, in this order: Claude Code (recommended), Codex (the fallback), LM Studio, Ollama, pi. state ok | action |
// missing, a line of detail, and what the row offers: Connect when it's ready, how to fix or install it otherwise.
// `connected` is what the creator connected (nothing on a first run until they click; an install set up before keeps
// its agent).
export async function scanAgents() {
  const [cl, cx, p, lms, oll] = await Promise.all([claudeInfo(true), codexInfo(true), piInfo(true), localRow('lmstudio'), localRow('ollama')]);
  const claude = !cl.installed ? { state: 'missing', detail: cl.error || 'Claude Code isn\'t on this computer', how: cl.error ? 'Fix or remove claudePath in Video Octopus\'s local/settings.json.' : `Install it in ${shell}: ${cl.install}. Then run claude once and sign in with your Claude account.`, install: { cmd: cl.install, url: 'https://claude.com/claude-code' } }
    : !cl.signedIn ? { state: 'action', detail: `Claude Code ${cl.version} · not signed in`, how: `Open ${shell}, run claude and sign in with your Claude account, then press Scan again. Video Octopus uses that sign-in and never sees it.` }
    : { state: 'ok', detail: `Claude Code ${cl.version} · signed in${cl.plan ? ` · ${cl.plan}` : ''}` };
  const codex = !cx.installed ? { state: 'missing', detail: cx.error || 'Codex isn\'t on this computer', how: `Install it in ${shell}: ${cx.install}. Then run codex login.`, install: { cmd: cx.install, url: 'https://developers.openai.com/codex/cli' } }
    : !cx.signedIn ? { state: 'action', detail: `Codex ${cx.version} · not signed in`, how: `Open ${shell}, run codex login and sign in, then press Scan again.` }
    : { state: 'ok', detail: `Codex ${cx.version} · signed in${cx.plan ? ` · ${cx.plan}` : ''}` };
  const pi = !p.installed ? { state: 'missing', detail: p.error || 'pi isn\'t on this computer', how: `Install it in ${shell}: ${p.install}, and set up a provider in it.`, install: { cmd: p.install, url: 'https://pi.dev' } }
    : { state: 'ok', detail: `pi ${p.version} · uses the providers set up in pi` };
  // A local server runs behind Claude Code (through its Messages API) or Codex: which of the two can take it here.
  const via = (row) => (row.viaOnly || ['claude', 'codex']).filter((a) => (a === 'claude' ? cl.installed && row.messagesApi : cx.installed));
  const agents = [
    { id: 'claude', name: 'Claude Code', recommended: true, ...claude },
    { id: 'codex', name: 'Codex', fallback: true, ...codex },
    { ...lms, via: via(lms) },
    { ...oll, via: via(oll) },
    { id: 'pi', name: 'pi', ...pi },
  ];
  return { agents, connected: connected(), engine: engineName() };
}

// What the chats run on now, as one of the rows: only once the creator connected something (or set it up before).
export function connected() {
  const s = settings(), st = section('setup', s), c = section('claude', s);
  if (!st.agent && !st.done) return null;
  const e = engineName();
  if (e === 'claude') return ['lmstudio', 'ollama'].includes(c.ccSource) ? { id: c.ccSource, via: 'claude', model: c.ccModel } : c.ccSource === 'provider' ? { id: 'provider', via: 'claude' } : { id: 'claude' };
  if (e === 'codex') return ['lmstudio', 'ollama'].includes(c.codexProvider) ? { id: c.codexProvider, via: 'codex', model: c.codexModel } : { id: 'codex' };
  return { id: 'pi' };
}

// Connect: the creator clicked it and said yes on the page. A local server goes behind Claude Code (its model source)
// or Codex (its provider), with the model picked.
export function connect({ agent, via, model, confirmed } = {}) {
  if (confirmed !== true) throw new Error('Connect needs the creator\'s yes.');
  const m = String(model || '').trim().slice(0, 200);
  if (agent === 'claude') saveSection('claude', { engine: 'claude', ccSource: 'plan' });
  else if (agent === 'codex') saveSection('claude', { engine: 'codex', codexProvider: 'chatgpt' });
  else if (agent === 'pi') saveSection('claude', { engine: 'pi' });
  else if (agent === 'lmstudio' || agent === 'ollama') {
    if (!m) throw new Error('Pick the model to use.');
    const url = localUrl(agent) === CC_SOURCES[agent].url ? '' : localUrl(agent);
    if (via === 'codex') saveSection('claude', { engine: 'codex', codexProvider: agent, codexModel: m });
    else if (via === 'claude') saveSection('claude', { engine: 'claude', ccSource: agent, ccModel: m, ccUrl: url });
    else throw new Error('Pick Claude Code or Codex to run it.');
  } else throw new Error('Unknown agent.');
  saveSection('setup', { agent });
  forgetLocal();
  return connected();
}

// ---- the installs and downloads Setup runs itself, each after an OK on the page: one at a time per kind ----
const jobs = new Map(); // id -> { state, cmd, tail, code }
export const actionState = (id) => { const j = jobs.get(id); return j ? { id, state: j.state, cmd: j.cmd, tail: j.tail, code: j.code } : { id, state: 'idle' }; };
const MODEL = /^[\w][\w.:/@-]{0,199}$/;
export async function startAction({ action, model, confirmed } = {}) {
  if (confirmed !== true) throw new Error('This needs the creator\'s OK.');
  let bin, args, cmd;
  if (action === 'ffmpeg') {
    const i = ffmpegInstaller();
    if (!i) throw new Error('There\'s no one-command install for ffmpeg here: use the manual link.');
    ({ bin, args, cmd } = i);
  } else if (action === 'lms-get' || action === 'ollama-pull') {
    const id = action === 'lms-get' ? 'lmstudio' : 'ollama', cli = localCli(id), m = String(model || '').trim();
    if (!MODEL.test(m)) throw new Error('Type the model\'s name.');
    if (!cli) throw new Error(`${CC_SOURCES[id].short}'s command line isn't on this computer.`);
    bin = cli; args = id === 'lmstudio' ? ['get', m, '--yes'] : ['pull', m]; cmd = `${id === 'lmstudio' ? 'lms' : 'ollama'} ${args.join(' ')}`;
  } else throw new Error('Unknown action.');
  if (jobs.get(action)?.state === 'running') return actionState(action);
  const j = { state: 'running', cmd, tail: '', code: null };
  jobs.set(action, j);
  const p = spawn(bin, args, { env: await childPathEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const keep = (d) => { j.tail = (j.tail + String(d)).replace(/\r/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).slice(-4).join('\n'); };
  p.stdout.on('data', keep); p.stderr.on('data', keep);
  p.on('error', (e) => { j.state = 'error'; j.tail = e.message; });
  p.on('close', (code) => { j.code = code; if (j.state === 'running') j.state = code === 0 ? 'done' : 'error'; if (action === 'ffmpeg') ffmpegSeen = null; });
  return actionState(action);
}

// ffmpeg here? (Export stays off until it is.) Asked again every half minute, and after an install.
let ffmpegSeen = null;
export async function ffmpegReady() {
  if (ffmpegSeen && Date.now() - ffmpegSeen.at < 30000) return ffmpegSeen.ok;
  const env = await childPathEnv();
  const ok = await new Promise((done) => execFile(studioTool('ffmpeg'), ['-version'], { timeout: 8000, env }, (err) => done(!err)));
  ffmpegSeen = { ok, at: Date.now() };
  return ok;
}

export async function onboardingRoute(req, res, url, { send, body }) {
  const p = url.pathname;
  if (!/^\/api\/app\/(brand|skills|scan)(\/|$)/.test(p)) return false;
  const post = req.method === 'POST';
  const q = (k) => url.searchParams.get(k) || '';
  try {
    if (p === '/api/app/brand' && !post) return send(res, 200, brandView()), true;
    // The file itself is the body (streamed to disk); kind, name and an optional note ride in the query.
    if (p === '/api/app/brand/upload' && post) return send(res, 200, { ...(await brandUpload(req, { kind: q('kind'), name: q('name'), note: q('note') })), view: brandView() }), true;
    if (p === '/api/app/brand/file' && !post) return serveBrandFile(req, res, q('f')), true;
    if (p === '/api/app/brand/remove' && post) { const b = await body(req); return send(res, 200, { ...brandRemove(String(b.file || '')), view: brandView() }), true; }
    // Write BRAND.md now (after the answers or the colours changed).
    if (p === '/api/app/brand/write' && post) { await body(req); return send(res, 200, { ...writeBrand(), view: brandView() }), true; }
    if (p === '/api/app/skills/recommended' && !post) return send(res, 200, recommendedView()), true;
    if (p === '/api/app/skills/repo' && !post) return send(res, 200, await repoView(q('repo'))), true;
    if (p === '/api/app/skills/install' && post) { const b = await body(req); return send(res, 200, await installSkills(String(b.repo || ''), b.skills)), true; }
    // The computer scan: agents, Connect, the installs and downloads after an OK, the local server under the chats.
    if (p === '/api/app/scan/agents' && !post) return send(res, 200, await scanAgents()), true;
    if (p === '/api/app/scan/connect' && post) { const b = await body(req); return send(res, 200, { connected: connect(b) }), true; }
    if (p === '/api/app/scan/action' && post) { const b = await body(req); return send(res, 200, await startAction(b)), true; }
    if (p === '/api/app/scan/action' && !post) return send(res, 200, actionState(q('id'))), true;
    if (p === '/api/app/scan/local' && !post) return send(res, 200, { down: await localDown() }), true;
  } catch (e) { return send(res, e.status || 400, { error: e.message }), true; }
  return false;
}

// Which agent runs Video Octopus's chats: Claude Code (the creator's Claude plan), Codex (a ChatGPT plan, or a local model in
// LM Studio or Ollama) or pi (any provider pi knows, or any OpenAI-compatible endpoint, such as OpenRouter). Settings →
// Agent & model picks it (stored in the settings section "claude"); every chat (projects, the Video Octopus assistant, the
// library's, scheduled runs) is made here, so the rest of Video Octopus never asks which one it is.
import { ChatSession, claudeInfo, ENGINES } from './claude.mjs';
import { CodexSession, codexInfo } from './codex.mjs';
import { PiSession, piInfo, piModels } from './pi.mjs';
import { section } from './settings.mjs';
import { settings } from './util.mjs';
import { ccSource, sourceCheck, CC_SOURCES } from './claude-source.mjs';

export { ENGINES }; // { id: name } of the three agents (defined in claude.mjs, which can't import this file)
export const engineName = () => (ENGINES[section('claude').engine] ? section('claude').engine : 'claude');
const CLASS = { claude: ChatSession, codex: CodexSession, pi: PiSession };
export const makeChat = (id, context) => guardLocal(new CLASS[engineName()](id, context));

// A local server's address: the default, or lmstudioUrl / ollamaUrl in local/settings.json (another port, or a test).
export const localUrl = (id) => String(settings()[`${id}Url`] || CC_SOURCES[id].url).replace(/\/+$/, '');

// The local model server the chats run on (Claude Code's model source, or Codex's provider): is it up? Down, a chat's
// message still goes (nothing switches by itself), and the chat shows a banner: "LM Studio isn't running. Start it, or
// switch this chat to Claude Code." Asked at most every few seconds.
let localSeen = null;
export const forgetLocal = () => { localSeen = null; };
export async function localDown() {
  const c = section('claude'), e = engineName();
  const id = e === 'claude' && ['lmstudio', 'ollama'].includes(c.ccSource) ? c.ccSource : e === 'codex' && ['lmstudio', 'ollama'].includes(c.codexProvider) ? c.codexProvider : null;
  if (!id) return null;
  const url = e === 'claude' && c.ccUrl ? c.ccUrl.replace(/\/+$/, '') : localUrl(id);
  if (localSeen && localSeen.key === `${id} ${url}` && Date.now() - localSeen.at < 5000) return localSeen.down;
  const r = await sourceCheck({ id, label: CC_SOURCES[id].short, url, model: '', context: 0, local: true });
  const name = CC_SOURCES[id].short;
  const down = r.running ? null : { id, name, text: `${name} isn't running. Start it, or switch this chat to Claude Code.` };
  localSeen = { key: `${id} ${url}`, at: Date.now(), down };
  return down;
}
export function guardLocal(chat) {
  const send = chat.send.bind(chat);
  chat.send = async (text, o) => {
    const down = await localDown().catch(() => null);
    if (down) chat.emit({ t: 'local-down', ...down });
    return send(text, o);
  };
  return chat;
}

// A chat made before the engine (or Claude Code's model source) changed in Settings: true when it should be replaced
// (and it isn't working). A Claude Code chat knows its source once it has started.
export const staleChat = (chat) => Boolean(chat && !chat.busy && (chat.engine !== engineName()
  || (chat.engine === 'claude' && chat.source && chat.source !== ccSource().id)));
// A saved session (state.json) that another agent, or Claude Code on another model source, started: not this chat's to
// carry on, so it goes to the earlier sessions.
export const foreignSession = (st = {}, engine = engineName()) => Boolean(st.sessionId)
  && ((st.engine || 'claude') !== engine || (engine === 'claude' && (st.source || 'plan') !== ccSource().id));

// `source`: also ask Claude Code's model source what it is and which models it has (claude-source.mjs: read-only lists).
export async function enginesView(refresh = false, { models = false, source = false } = {}) {
  const [claude, codex, pi] = await Promise.all([claudeInfo(refresh), codexInfo(refresh), piInfo(refresh)]);
  const c = section('claude'), src = ccSource();
  return { engine: engineName(), label: ENGINES[engineName()], claude, codex, pi, codexProvider: c.codexProvider, codexModel: c.codexModel,
    ccSource: { ...src, sources: Object.fromEntries(Object.entries(CC_SOURCES).map(([k, v]) => [k, { label: v.label, short: v.short, url: v.url || '' }])) },
    ...(source ? { ccCheck: await sourceCheck(src) } : {}),
    ...(models && pi.installed ? { piModels: await piModels() } : {}) };
}
// For /api/status: the agent that runs the chats now, as the top bar's chip, Home's sidebar card and the Projects notice
// describe it (web/app.js agentView). name and version; installed, else install (the command) or error (a wrong path
// in settings); signedIn true or false where a sign-in is needed, null where it isn't (pi, a local model); login, the
// command that signs in; source, where the model comes from, and model, the one picked ('' = the agent's default);
// planUsage, whether it reports plan usage for the meter (only Claude Code on the Claude plan does).
const CODEX_SOURCES = { chatgpt: 'ChatGPT plan', lmstudio: 'LM Studio (local)', ollama: 'Ollama (local)' };
export async function agentStatus(refresh = false) {
  const engine = engineName(), c = section('claude');
  const found = (x) => ({ installed: Boolean(x.installed), version: x.version || '', install: x.install || '', error: x.error || '' });
  if (engine === 'codex') {
    const x = await codexInfo(refresh), local = c.codexProvider !== 'chatgpt';
    return { engine, name: ENGINES.codex, ...found(x), signedIn: local ? null : Boolean(x.signedIn), login: 'codex login',
      plan: x.plan || null, source: CODEX_SOURCES[c.codexProvider] || c.codexProvider, model: c.codexModel || '', needsModel: false, planUsage: false };
  }
  if (engine === 'pi') {
    const x = await piInfo(refresh), endpoint = c.piSource === 'endpoint';
    return { engine, name: ENGINES.pi, ...found(x), signedIn: null, login: '', plan: null,
      source: endpoint ? 'OpenAI-compatible endpoint' : "pi's own providers", model: c.piModel || '', needsModel: endpoint, planUsage: false };
  }
  const x = await claudeInfo(refresh), ms = modelSourceView();
  return { engine, name: ENGINES.claude, ...found(x), signedIn: ms ? null : Boolean(x.signedIn), login: 'claude', plan: x.plan || null,
    source: ms ? ms.label : CC_SOURCES.plan.label, model: ms?.model || '', needsModel: Boolean(ms), planUsage: !ms };
}

// For /api/status and the top bar: Claude Code on something other than the plan ({ id, label, model }), else null.
export function modelSourceView() {
  if (engineName() !== 'claude') return null;
  const src = ccSource();
  return src.id === 'plan' ? null : { id: src.id, label: src.label, model: src.model };
}

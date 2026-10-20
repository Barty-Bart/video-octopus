// Which agent runs Video Octopus's chats: Claude Code (the creator's Claude plan), Codex (a ChatGPT plan, or a local model in
// LM Studio or Ollama) or pi (any provider pi knows, or any OpenAI-compatible endpoint, such as OpenRouter). Settings →
// Agent & model picks it (stored in the settings section "claude"); every chat (projects, the Video Octopus assistant, the
// library's, scheduled runs) is made here, so the rest of Video Octopus never asks which one it is.
import { ChatSession, claudeInfo, ENGINES } from './claude.mjs';
import { CodexSession, codexInfo } from './codex.mjs';
import { PiSession, piInfo, piModels } from './pi.mjs';
import { section } from './settings.mjs';
import { ccSource, sourceCheck, CC_SOURCES } from './claude-source.mjs';

export { ENGINES }; // { id: name } of the three agents (defined in claude.mjs, which can't import this file)
export const engineName = () => (ENGINES[section('claude').engine] ? section('claude').engine : 'claude');
const CLASS = { claude: ChatSession, codex: CodexSession, pi: PiSession };
export const makeChat = (id, context) => new CLASS[engineName()](id, context);

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
// For /api/status and the top bar: Claude Code on something other than the plan ({ id, label, model }), else null.
export function modelSourceView() {
  if (engineName() !== 'claude') return null;
  const src = ccSource();
  return src.id === 'plan' ? null : { id: src.id, label: src.label, model: src.model };
}

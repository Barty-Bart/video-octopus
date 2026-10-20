// Claude Code with other models (PLAN §11, option 1). Claude Code talks to any server that speaks Anthropic's Messages
// API, so Settings → Agent & model → Claude Code has a "Model source": your Claude plan (the default: Claude Code as it
// is), a local model in Ollama (0.14 or newer) or LM Studio (0.4.1 or newer), or another provider (a URL, a model and a
// key in the key store, e.g. OpenRouter or a LiteLLM gateway). For anything but the plan, Video Octopus starts Claude Code with
// ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and the model in ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL,
// and keeps every Anthropic credential of the creator's away from that server:
// - Claude Code sends ANTHROPIC_AUTH_TOKEN as "Authorization: Bearer" and, besides it, an API key as "X-Api-Key": the
//   ANTHROPIC_API_KEY variable, else an apiKeyHelper or the key a Console /login saved. So both are set to the other
//   server's own token (a placeholder for a local server), and with a token set Claude Code never uses the plan's login.
// - Inherited variables that carry Anthropic credentials or point Claude Code elsewhere are dropped, and so is any
//   variable holding an Anthropic key (sk-ant-…).
// - Claude Code's own settings files can set variables too, and those beat the environment; what Video Octopus passes with
//   --settings beats them. So the endpoint, the model and (for a local server, where it's no secret) the token go in
//   --settings as well. A provider's key never goes on the command line (other programs can read that), so when a
//   settings file sets ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN, Video Octopus refuses to start rather than risk it.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { settings, readJSON, expandHome, tildePath } from './util.mjs';
import { section } from './settings.mjs';
import { readKey } from './keychain.mjs';

// The key a provider needs, in the key store like the others (Settings shows "•••• set ✓ · Replace · Remove").
export const PROVIDER_KEY = 'ANTHROPIC_COMPATIBLE_API_KEY';
// [label in Settings, short name for chips and session lists, default URL, the token a local server accepts]
export const CC_SOURCES = {
  plan: { label: 'Your Claude plan', short: 'Claude plan' },
  ollama: { label: 'Ollama (local)', short: 'Ollama', url: 'http://127.0.0.1:11434', token: 'ollama', local: true },
  lmstudio: { label: 'LM Studio (local)', short: 'LM Studio', url: 'http://127.0.0.1:1234', token: 'lmstudio', local: true },
  provider: { label: 'Another provider', short: 'Provider' },
};
// Claude Code needs a big context for Video Octopus's jobs (its own prompt and tools take a good part of it).
export const MIN_CONTEXT = 32768;
const MODEL_VARS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];
// Inherited variables Claude Code reads for credentials, headers or another endpoint or cloud: never passed on when
// Claude Code talks to a server that isn't Anthropic's. Also those a Claude Code host (the desktop app, a remote session)
// sets for its children, under which Claude Code may ignore the token and use the host's sign-in: they're there when
// Video Octopus itself was started from such a session.
const DROP = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_UNIX_SOCKET', 'ANTHROPIC_PROFILE',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_GATEWAY', ...MODEL_VARS,
  'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_OAUTH_SCOPES', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_ORGANIZATION_UUID', 'CLAUDE_CODE_USER_EMAIL']);
const ANTHROPIC_SECRET = /^\s*sk-ant-/i;

// The model source picked in Settings: { id, label, url, model, context, local }.
export function ccSource(s = settings()) {
  const c = section('claude', s);
  const id = CC_SOURCES[c.ccSource] ? c.ccSource : 'plan';
  const d = CC_SOURCES[id];
  return { id, label: d.short, url: String(c.ccUrl || d.url || '').trim().replace(/\/+$/, ''), model: String(c.ccModel || '').trim(),
    context: Number(c.ccContext) || (d.local ? MIN_CONTEXT : 0), local: Boolean(d.local) };
}
export const onPlan = (s = settings()) => ccSource(s).id === 'plan';

// Claude Code's settings files (yours, and the studio's, which is the chats' working folder) that set a credential
// variable: Video Octopus couldn't keep those away from a provider. Names only; Video Octopus never reads the values.
export function settingsCredentials(cwd = settings().studio) {
  const home = process.env.CLAUDE_CONFIG_DIR ? expandHome(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude');
  const files = [join(home, 'settings.json'), ...(cwd ? [join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')] : [])];
  const out = [];
  for (const f of files) {
    const env = readJSON(f, null)?.env;
    if (!env || typeof env !== 'object') continue;
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) if (env[k]) out.push(`${k} in ${tildePath(f)}`);
  }
  return out;
}

// Why Claude Code can't start on this source yet, in plain words (null when it can).
export function sourceProblem(src, { conflicts = [] } = {}) {
  if (src.id === 'plan') return null;
  if (!/^https?:\/\/[^\s/]+/i.test(src.url)) return src.id === 'provider' ? 'Give the provider\'s URL in Settings → Agent & model (for example https://openrouter.ai/api).' : `The ${src.label} URL isn't a web address (it starts with http://).`;
  if (!src.model) return `Pick the model Claude Code should use${src.local ? ` in ${src.label}` : ''} in Settings → Agent & model.`;
  if (src.id === 'provider' && conflicts.length) return `Your Claude Code settings set ${conflicts.join(' and ')}, which would win over the provider's key and be sent to ${new URL(src.url).host}. Remove it there, or use your Claude plan.`;
  return null;
}

// What Video Octopus adds when it starts Claude Code for a source: the environment and extra arguments. `env` is the full
// environment Video Octopus would pass (its own plus the saved keys); `key` is the provider's key. Pure, so the smoke test
// checks exactly what Claude Code gets.
export function claudeLaunch(src, env, { key = null, conflicts = [] } = {}) {
  if (src.id === 'plan') return { env, args: [] };
  const problem = sourceProblem(src, { conflicts });
  if (problem) throw new Error(problem);
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!DROP.has(k.toUpperCase()) && !ANTHROPIC_SECRET.test(String(v ?? ''))) out[k] = v;
  // Something non-empty in both places, so Claude Code neither signs in with the plan nor falls back to a key of its own.
  const token = src.local ? CC_SOURCES[src.id].token : key || 'no-key';
  const vars = { ANTHROPIC_BASE_URL: src.url, ...Object.fromEntries(MODEL_VARS.map((k) => [k, src.model])),
    // Claude Code assumes a 200K window for a model it doesn't know; this one compacts in time.
    ...(src.context ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(src.context), CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(src.context) } : {}) };
  const flag = { ...vars, CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_CUSTOM_HEADERS: '', ...(src.local ? { ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_API_KEY: token } : {}) };
  return { env: { ...out, ...vars, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_API_KEY: token }, args: ['--settings', JSON.stringify({ env: flag }), '--model', src.model] };
}

// For ChatSession.start(): the picked source, its key from the key store when it needs one, and the launch.
export async function claudeLaunchNow(env, cwd) {
  const src = ccSource();
  if (src.id === 'plan') return { src, env, args: [] };
  const key = src.id === 'provider' ? await readKey(PROVIDER_KEY).catch(() => null) : null;
  return { src, ...claudeLaunch(src, env, { key, conflicts: src.id === 'provider' ? settingsCredentials(cwd) : [] }) };
}

// A line for the chat's system prompt, so the agent knows what it runs on (never the key).
export const sourceBrief = (src) => (src.id === 'plan' ? '' : `- You (Claude Code) are running on ${src.model} through ${src.label} (${src.url}), not on Anthropic's Claude models. Keep each step small and check your work: some tools and long jobs may be harder for this model.`);

// ---- what's there: Settings asks before the creator picks a model ----
const vnum = (v) => String(v || '0').split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
const atLeast = (v, min) => { const a = vnum(v), b = vnum(min); for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); return true; };
const kfmt = (n) => (n >= 1000 ? `${Math.round(n / 1024)}K` : String(n));

// Asks the server what it is and which models it has: read-only lists (Ollama /api/version and /api/tags, LM Studio
// /api/v1/models or /v1/models, a provider's /v1/models with its key). Never a chat.
// → { ok, running, messagesApi, version, models: [{ id, label, context, tools, vision }], note }
export async function sourceCheck(src = ccSource()) {
  if (src.id === 'plan') return { ok: true, running: true, messagesApi: true, models: [] };
  if (!/^https?:\/\//i.test(src.url)) return { ok: false, running: false, unset: true, models: [], note: sourceProblem(src) };
  const get = async (path, headers = {}) => {
    const r = await fetch(src.url + path, { headers, signal: AbortSignal.timeout(4000), redirect: 'error' });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const host = (() => { try { return new URL(src.url).host; } catch { return src.url; } })();
  try {
    if (src.id === 'ollama') {
      const [v, t] = await Promise.all([get('/api/version'), get('/api/tags')]);
      const version = v.json?.version || '';
      const models = (t.json?.models || []).map((m) => ({ id: m.name || m.model, label: [m.name || m.model, m.details?.parameter_size].filter(Boolean).join(' · ') }));
      const messagesApi = Boolean(version) && atLeast(version, '0.14.0');
      return { ok: messagesApi, running: true, messagesApi, version, models,
        note: messagesApi ? `Ollama ${version} speaks Anthropic's Messages API. Give it a context of ${kfmt(MIN_CONTEXT)} or more (OLLAMA_CONTEXT_LENGTH, or the model's num_ctx): its default is smaller.`
          : `Ollama ${version || '(version unknown)'} is too old for Claude Code: its Anthropic Messages API came in 0.14. Update Ollama.` };
    }
    if (src.id === 'lmstudio') {
      // LM Studio 0.4's own API lists context, tool use and vision; the Messages API (/v1/messages) came in 0.4.1.
      const n = await get('/api/v1/models');
      if (n.status === 200 && Array.isArray(n.json?.models)) {
        const models = n.json.models.filter((m) => m.type === 'llm' || m.type === 'vlm').map((m) => {
          const loaded = m.loaded_instances?.[0]?.config?.context_length;
          return { id: m.key, context: loaded || m.max_context_length || null, loaded: Boolean(m.loaded_instances?.length), tools: Boolean(m.capabilities?.trained_for_tool_use), vision: Boolean(m.capabilities?.vision),
            label: [m.display_name || m.key, m.params_string, m.max_context_length && `${kfmt(loaded || m.max_context_length)} context${loaded ? ' (loaded)' : ''}`, m.capabilities?.trained_for_tool_use ? 'tools ✓' : 'not trained for tools', m.capabilities?.vision && 'sees images'].filter(Boolean).join(' · ') };
        });
        return { ok: true, running: true, messagesApi: true, models,
          note: `LM Studio speaks Anthropic's Messages API (/v1/messages, LM Studio 0.4.1 or newer). Load the model with a context length of ${kfmt(MIN_CONTEXT)} or more.` };
      }
      const o = await get('/v1/models');
      if (o.status === 200) return { ok: false, running: true, messagesApi: false, models: [],
        note: 'This LM Studio is older than 0.4: it has no Anthropic Messages API (/v1/messages), which Claude Code needs. Update LM Studio, or use Codex or pi with it.' };
      return { ok: false, running: true, messagesApi: false, models: [], note: `Something answers at ${host}, but it isn't LM Studio's server (HTTP ${o.status}).` };
    }
    // Another provider: its model list, with its own key only.
    const key = await readKey(PROVIDER_KEY).catch(() => null);
    const r = await get('/v1/models', key ? { 'x-api-key': key, Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' } : { 'anthropic-version': '2023-06-01' });
    if (r.status === 401 || r.status === 403) return { ok: false, running: true, models: [], note: `${host} didn't accept ${key ? 'the key' : 'a request without a key'} (HTTP ${r.status}).` };
    const list = Array.isArray(r.json?.data) ? r.json.data : Array.isArray(r.json?.models) ? r.json.models : [];
    const models = list.map((m) => ({ id: m.id || m.name, label: [m.display_name || m.name || m.id, m.context_length && `${kfmt(m.context_length)} context`].filter(Boolean).join(' · '), context: m.context_length || null })).filter((m) => m.id).slice(0, 400);
    return { ok: true, running: true, models, note: r.status === 200 ? `${host} answered with ${models.length} model${models.length === 1 ? '' : 's'}.` : `${host} has no model list (HTTP ${r.status}); type the model id.` };
  } catch (e) {
    const what = src.id === 'ollama' ? 'Start Ollama (the app, or ollama serve) and try again.' : src.id === 'lmstudio' ? 'Start LM Studio\'s server (Developer → Start server, or lms server start) and try again.' : 'Check the URL.';
    return { ok: false, running: false, models: [], note: `Nothing answers at ${host} (${e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || e.message}). ${what}` };
  }
}

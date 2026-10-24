// The chat panel's Model and Effort pickers (next to its permission mode), per agent, per project, with studio-wide
// defaults in Settings › Agent & model. They apply from the next message.
//
// How each agent takes them (checked against the installed CLIs' own help, not guessed):
// - Claude Code (`claude --help`): `--model <model>` (an alias such as opus or sonnet, or a full name) and
//   `--effort <level>` (low, medium, high, xhigh, max). Both are launch flags, so a change restarts the chat's process
//   once it's idle; the next message reopens the same conversation with them (--resume). Only on the Claude plan: another
//   model source names its own model (claude-source.mjs).
// - Codex (app-server protocol, `codex app-server generate-json-schema`): turn/start takes `model` and `effort` (a
//   ReasoningEffort string, "for this turn and subsequent turns"), so they go with every message and nothing restarts.
//   thread/start takes the model too. The models offered are the ones Codex lists in its own model cache.
// - pi (`pi --help`): `--model <pattern>` ("provider/id") and `--thinking <level>` (off, minimal, low, medium, high,
//   xhigh, max). Launch flags, like Claude Code's. Not with an OpenAI-compatible endpoint (its model is set in Settings).
//
// Stored: the project's choice in local/state.json (projects[id].agentChoice[engine] = { model, effort }); a field left
// out follows the studio default (settings: top-level `model` for Claude, claude.codexModel / piModel, and
// claude.claudeEffort / codexEffort / piThinking). '' passes nothing: the agent's own default.
// Everything is checked here, on the server, against an allow-list (efforts) or a strict pattern (models: no spaces, no
// leading "-", so nothing can be read as another flag), when saved and again when used.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { settings, state, setProjectState } from './util.mjs';

export const ENGINE_IDS = ['claude', 'codex', 'pi'];
export const EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
};
const MODEL_RE = {
  claude: /^[A-Za-z0-9][\w.-]{0,79}(\[1m\])?$/,
  codex: /^[A-Za-z0-9][\w.:/-]{0,99}$/,
  pi: /^[A-Za-z0-9][\w.:/@+-]{0,149}$/,
};
export const validModel = (engine, m) => typeof m === 'string' && Boolean(MODEL_RE[engine]?.test(m));
export const validEffort = (engine, e) => typeof e === 'string' && (EFFORTS[engine] || []).includes(e);

// The Claude models offered (Settings › Agent & model has the same, plus any name typed in).
export const CLAUDE_MODELS = [['opus', 'Opus'], ['opus[1m]', 'Opus · 1M context'], ['sonnet', 'Sonnet'], ['sonnet[1m]', 'Sonnet · 1M context'],
  ['claude-fable-5-1', 'Fable'], ['haiku', 'Haiku']];
export const EFFORT_WORDS = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };

// Throws in plain words for anything odd; returns the cleaned { model, effort } ('' = the agent's default; undefined =
// follow the studio default).
export function cleanChoice(engine, c = {}) {
  if (!ENGINE_IDS.includes(engine)) throw new Error('Unknown agent.');
  const out = {};
  for (const k of ['model', 'effort']) {
    if (!(k in c) || c[k] === null) continue;
    const v = String(c[k]).trim();
    if (v === 'studio') continue; // "Default": follow Settings
    if (v && k === 'model' && !validModel(engine, v)) throw new Error('That model name has characters Video Octopus doesn’t pass on.');
    if (v && k === 'effort' && !validEffort(engine, v)) throw new Error(`Effort is one of: ${EFFORTS[engine].join(', ')}.`);
    out[k] = v;
  }
  return out;
}

// The studio defaults (Settings), checked the same way.
export function studioChoice(engine, s = settings()) {
  const c = s.claude || {};
  const pick = { claude: [s.model, c.claudeEffort], codex: [c.codexModel, c.codexEffort], pi: [c.piModel, c.piThinking] }[engine] || [];
  return { model: validModel(engine, pick[0]) ? pick[0] : '', effort: validEffort(engine, pick[1]) ? pick[1] : '' };
}

// What a chat runs with: the project's own choice over the studio default. id null: the studio default alone.
export function agentChoice(id, engine, s = settings()) {
  const def = studioChoice(engine, s);
  const own = id ? state().projects?.[id]?.agentChoice?.[engine] || {} : {};
  const model = typeof own.model === 'string' && (own.model === '' || validModel(engine, own.model)) ? own.model : def.model;
  const effort = typeof own.effort === 'string' && (own.effort === '' || validEffort(engine, own.effort)) ? own.effort : def.effort;
  return { model, effort };
}

// Saves a project's choice (only the fields given; 'studio' = follow Settings again). Returns what it runs with now.
export function setAgentChoice(id, engine, patch) {
  const clean = cleanChoice(engine, patch);
  const all = { ...(state().projects?.[id]?.agentChoice || {}) };
  const mine = { ...(all[engine] || {}) };
  for (const k of ['model', 'effort']) {
    if (!(k in patch)) continue;
    if (k in clean) mine[k] = clean[k]; else delete mine[k];
  }
  all[engine] = mine;
  setProjectState(id, { agentChoice: all });
  return agentChoice(id, engine);
}

// ---- what each agent gets ----
// Claude Code: launch flags, on the Claude plan only.
export function claudeArgs({ model, effort } = {}, source = 'plan') {
  if (source !== 'plan') return [];
  return [...(validModel('claude', model) ? ['--model', model] : []), ...(validEffort('claude', effort) ? ['--effort', effort] : [])];
}
// Codex: turn/start's (and thread/start's) fields.
export function codexParams({ model, effort } = {}) {
  return { ...(validModel('codex', model) ? { model } : {}), ...(validEffort('codex', effort) ? { effort } : {}) };
}
// pi: launch flags; with an endpoint the model is Settings' own.
export function piArgs({ model, effort } = {}, { endpoint = false } = {}) {
  return [...(!endpoint && validModel('pi', model) ? ['--model', model] : []), ...(validEffort('pi', effort) ? ['--thinking', effort] : [])];
}

// Codex's own list of models, from its model cache ($CODEX_HOME or ~/.codex): only names, visibility and efforts are read.
export function codexModels(home = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  let j = null;
  try { j = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8')); } catch { return []; }
  return (Array.isArray(j?.models) ? j.models : [])
    .filter((m) => m && m.visibility !== 'hide' && validModel('codex', m.slug || ''))
    .slice(0, 40)
    .map((m) => ({ id: m.slug, label: String(m.display_name || m.slug).slice(0, 60),
      efforts: (m.supported_reasoning_levels || []).map((x) => x?.effort || x).filter((e) => validEffort('codex', e)) }));
}

// ---- what the chat panel's pickers show ----
const AGENT = { claude: 'Claude Code', codex: 'Codex', pi: 'pi' };
const EFFORT_LABEL = { claude: 'Effort', codex: 'Reasoning', pi: 'Thinking' };
// ctx: { source (Claude Code's model source), local (Codex on LM Studio or Ollama), endpoint (pi on an endpoint),
// models: [{ id, label, efforts? }] (Codex's cache, pi's list) }. Options are [value, label]; 'studio' follows Settings.
export function choiceView(id, engine, { source = 'plan', local = false, endpoint = false, models = [] } = {}) {
  const def = studioChoice(engine), now = agentChoice(id, engine);
  const own = (id && state().projects?.[id]?.agentChoice?.[engine]) || {};
  const agent = AGENT[engine];
  const list = engine === 'claude' ? CLAUDE_MODELS : models.map((m) => [m.id, m.label || m.id]);
  const name = (m) => list.find(([k]) => k === m)?.[1] || m;
  const modelOff = engine === 'claude' && source !== 'plan' ? 'The model comes from the model source in Settings › Agent & model.'
    : engine === 'pi' && endpoint ? 'The endpoint’s model is set in Settings › Agent & model.'
      : engine === 'codex' && local ? 'The local model is set in Settings › Agent & model.' : '';
  const modelOpts = modelOff ? [] : [
    ['studio', def.model ? `Default · ${name(def.model)}` : 'Default'],
    ...(def.model ? [['', `${agent}’s own default`]] : []),
    ...list,
    ...(now.model && !list.some(([k]) => k === now.model) ? [[now.model, now.model]] : []),
  ];
  // Codex: the efforts the picked model lists (all of them when unknown); none for a local model.
  const known = engine === 'codex' ? models.find((m) => m.id === now.model)?.efforts : null;
  const efforts = engine === 'codex' && local ? [] : known?.length ? EFFORTS[engine].filter((e) => known.includes(e)) : EFFORTS[engine];
  const effortOpts = efforts.length ? [
    ['studio', def.effort ? `Default · ${EFFORT_WORDS[def.effort]}` : 'Default'],
    ...(def.effort ? [['', `${agent}’s own default`]] : []),
    ...efforts.map((e) => [e, EFFORT_WORDS[e]]),
  ] : [];
  return {
    engine, agent, effortLabel: EFFORT_LABEL[engine], now,
    model: 'model' in own ? own.model : 'studio', effort: 'effort' in own ? own.effort : 'studio',
    models: modelOpts, efforts: effortOpts, modelNote: modelOff,
    // Claude Code and pi take them when the chat's process starts: it restarts once it's idle.
    applies: engine === 'codex' ? 'Applies from your next message.' : 'Applies from your next message (the chat reopens with it).',
  };
}

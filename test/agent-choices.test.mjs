// The chat panel's Model and Effort pickers (server/agent-choices.mjs): what is allowed (an allow-list for efforts, a
// strict pattern for models, so nothing odd reaches a command line), a project's pick over the studio default, and
// what each agent gets: Claude Code's --model / --effort (plan only), Codex's turn/start model and effort (none of the
// effort for a local model), pi's --model / --thinking (no model with an endpoint). Plus Settings' validation, the
// pickers' options, Codex's model cache, and the adapters using them. A throwaway settings folder; nothing is run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'vo-agent-choice-'));
process.env.STUDIO_LOCAL_DIR = join(tmp, 'local');
mkdirSync(process.env.STUDIO_LOCAL_DIR, { recursive: true });
const writeSettings = (v) => writeFileSync(join(process.env.STUDIO_LOCAL_DIR, 'settings.json'), JSON.stringify({ studio: join(tmp, 'studio'), ...v }));
writeSettings({ model: 'sonnet', claude: { claudeEffort: 'high', codexModel: 'gpt-6-sol', codexEffort: 'low', piModel: 'anthropic/claude-x', piThinking: 'medium' } });
mkdirSync(join(tmp, 'studio'), { recursive: true });

let A, settingsMod;
before(async () => {
  A = await import('../server/agent-choices.mjs');
  settingsMod = await import('../server/settings.mjs');
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test('models: a strict pattern; efforts: each CLI’s own list', () => {
  for (const m of ['opus', 'opus[1m]', 'sonnet[1m]', 'claude-opus-5-5', 'claude-fable-5-1', 'haiku']) assert.ok(A.validModel('claude', m), m);
  for (const m of ['', '-x', '--dangerously-skip-permissions', 'opus --effort max', 'a b', '$(rm -rf ~)', 'op;us', 'opus\n', 'x'.repeat(90), '[1m]']) assert.equal(A.validModel('claude', m), false, JSON.stringify(m));
  for (const m of ['gpt-6-sol', 'gpt-oss:20b', 'gpt-5.6-luna']) assert.ok(A.validModel('codex', m), m);
  for (const m of ['anthropic/claude-sonnet-5', 'openrouter/qwen/qwen3:free', 'google/gemini-3.0-pro']) assert.ok(A.validModel('pi', m), m);
  assert.equal(A.validModel('pi', '-m evil'), false);
  assert.deepEqual(A.EFFORTS.claude, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(A.EFFORTS.pi, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(A.validEffort('codex', 'xhigh'));
  assert.equal(A.validEffort('claude', 'ultra'), false, 'not one of Claude Code’s');
  assert.equal(A.validEffort('claude', 'high; rm'), false);
  assert.throws(() => A.cleanChoice('claude', { effort: 'turbo' }), /Effort is one of/);
  assert.throws(() => A.cleanChoice('claude', { model: 'opus && ls' }), /characters/);
  assert.throws(() => A.cleanChoice('gemini', {}), /Unknown agent/);
  assert.deepEqual(A.cleanChoice('claude', { model: 'studio', effort: '' }), { effort: '' }, "'studio' follows Settings, '' passes nothing");
});

test('a project’s pick over the studio default; Default goes back to Settings', () => {
  assert.deepEqual(A.agentChoice('p1', 'claude'), { model: 'sonnet', effort: 'high' }, 'the studio default');
  assert.deepEqual(A.setAgentChoice('p1', 'claude', { model: 'opus' }), { model: 'opus', effort: 'high' });
  assert.deepEqual(A.setAgentChoice('p1', 'claude', { effort: '' }), { model: 'opus', effort: '' }, "'' is the agent's own default");
  assert.deepEqual(A.agentChoice('p2', 'claude'), { model: 'sonnet', effort: 'high' }, 'another video is not changed');
  const st = JSON.parse(readFileSync(join(process.env.STUDIO_LOCAL_DIR, 'state.json'), 'utf8'));
  assert.deepEqual(st.projects.p1.agentChoice.claude, { model: 'opus', effort: '' }, 'stored per project in local/state.json');
  assert.deepEqual(A.setAgentChoice('p1', 'claude', { model: 'studio', effort: 'studio' }), { model: 'sonnet', effort: 'high' });
  assert.throws(() => A.setAgentChoice('p1', 'codex', { effort: 'warp' }));
  assert.deepEqual(A.agentChoice('p1', 'codex'), { model: 'gpt-6-sol', effort: 'low' });
});

test('Claude Code: --model and --effort, on the Claude plan only, never an odd value', () => {
  assert.deepEqual(A.claudeArgs({ model: 'opus[1m]', effort: 'max' }), ['--model', 'opus[1m]', '--effort', 'max']);
  assert.deepEqual(A.claudeArgs({ model: '', effort: '' }), [], 'Default passes nothing');
  assert.deepEqual(A.claudeArgs({ model: 'opus', effort: 'high' }, 'ollama'), [], 'another model source names its own model');
  assert.deepEqual(A.claudeArgs({ model: '--x', effort: 'ultra' }), []);
});

test('Codex: turn/start’s model and effort; pi: --model and --thinking', () => {
  assert.deepEqual(A.codexParams({ model: 'gpt-6-sol', effort: 'xhigh' }), { model: 'gpt-6-sol', effort: 'xhigh' });
  assert.deepEqual(A.codexParams({ model: '', effort: 'nope' }), {});
  assert.deepEqual(A.piArgs({ model: 'anthropic/claude-x', effort: 'low' }), ['--model', 'anthropic/claude-x', '--thinking', 'low']);
  assert.deepEqual(A.piArgs({ model: 'anthropic/claude-x', effort: 'off' }, { endpoint: true }), ['--thinking', 'off'], 'an endpoint keeps Settings’ model');
});

test('the adapters use them: Claude Code’s launch flags, Codex per turn (no effort for a local model), pi’s flags', async () => {
  const claude = readFileSync(new URL('../server/claude.mjs', import.meta.url), 'utf8');
  assert.match(claude, /args\.push\(\.\.\.claudeArgs\(this\.choice\(\), this\.source\)\)/);
  assert.doesNotMatch(claude, /args\.push\('--model', s\.model\)/, 'the old Settings-only model flag is gone');
  const pi = readFileSync(new URL('../server/pi.mjs', import.meta.url), 'utf8');
  assert.match(pi, /piArgs\(pick\)/);
  const codex = readFileSync(new URL('../server/codex.mjs', import.meta.url), 'utf8');
  assert.match(codex, /'turn\/start', \{ threadId: this\.threadId, input, \.\.\.this\.turnChoice\(\) \}/);
  const { CodexSession } = await import('../server/codex.mjs');
  const s = new CodexSession('p3', () => '');
  s.agentChoice = () => ({ model: 'gpt-5.6-luna', effort: 'high' });
  assert.deepEqual(s.turnChoice(), { model: 'gpt-5.6-luna', effort: 'high' });
  writeSettings({ claude: { codexProvider: 'ollama' } });
  assert.deepEqual(s.turnChoice(), { model: 'gpt-5.6-luna' }, 'reasoning effort is the ChatGPT models’ own');
  writeSettings({ model: 'sonnet', claude: { claudeEffort: 'high', codexModel: 'gpt-6-sol', codexEffort: 'low', piModel: 'anthropic/claude-x', piThinking: 'medium' } });
  const idx = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
  assert.match(idx, /chat\.agentChoice = \(\) => agentChoice\(id, chat\.engine\)/, 'a project’s chat runs with its own pick');
  assert.match(idx, /engine !== 'codex'\) restartWhenIdle\(c\)/, 'Claude Code and pi reopen with it once idle');
});

test('Settings: the studio defaults are checked the same way', () => {
  assert.throws(() => settingsMod.saveSection('claude', { claudeEffort: 'turbo' }), /Unknown choice/);
  assert.throws(() => settingsMod.saveSection('claude', { model: 'opus --x' }), /Bad model name/);
  assert.throws(() => settingsMod.saveSection('claude', { codexModel: 'gpt; rm' }), /Bad model name/);
  settingsMod.saveSection('claude', { claudeEffort: 'medium', codexEffort: 'ultra', piThinking: 'off', model: 'opus' });
  assert.deepEqual(A.studioChoice('claude'), { model: 'opus', effort: 'medium' });
  assert.deepEqual(A.studioChoice('codex'), { model: 'gpt-6-sol', effort: 'ultra' });
  assert.equal(A.studioChoice('pi').effort, 'off');
});

test('the pickers’ options: Default first, the agent’s own when Settings has one, hidden where the agent can’t use them', () => {
  const v = A.choiceView('p4', 'claude', { source: 'plan' });
  assert.equal(v.model, 'studio');
  assert.deepEqual(v.models[0], ['studio', 'Default · Opus']);
  assert.deepEqual(v.models[1], ['', 'Claude Code’s own default']);
  assert.ok(v.models.some(([k]) => k === 'opus[1m]'));
  assert.deepEqual(v.efforts.map(([k]) => k), ['studio', '', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(v.effortLabel, 'Effort');
  const other = A.choiceView('p4', 'claude', { source: 'lmstudio' });
  assert.deepEqual(other.models, []);
  assert.match(other.modelNote, /model source/);
  const cx = A.choiceView('p4', 'codex', { models: [{ id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: ['low', 'high'] }] });
  assert.equal(cx.effortLabel, 'Reasoning');
  assert.deepEqual(cx.efforts.map(([k]) => k), ['studio', '', 'low', 'high'], 'the efforts the picked model lists');
  assert.deepEqual(A.choiceView('p4', 'codex', { local: true }).efforts, [], 'none for a local model');
  assert.deepEqual(A.choiceView('p4', 'pi', { endpoint: true }).models, []);
});

test('Codex’s model cache: names, visibility and efforts only; hidden and odd names left out', () => {
  const home = join(tmp, 'codex-home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'gpt-6-sol', display_name: 'GPT-6 Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }, { effort: 'bogus' }] },
    { slug: 'secret-model', visibility: 'hide' },
    { slug: '--evil', visibility: 'list' },
  ] }));
  assert.deepEqual(A.codexModels(home), [{ id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: ['low', 'max'] }]);
  assert.deepEqual(A.codexModels(join(tmp, 'nowhere')), []);
});

test('the web side: the pickers sit with the permission mode; waiting for you is impossible to miss', () => {
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(app, /id="chatCtl"[\s\S]{0,300}id="mode"/, 'mode in the controls row');
  assert.match(app, /agentPickers\(id\)/);
  assert.match(app, /wait-banner/);
  assert.match(app, /Waiting for you/);
  assert.match(app, /Always for \$\{esc\(ev\.always\)\}/);
  const att = readFileSync(new URL('../web/attention.js', import.meta.url), 'utf8');
  assert.match(att, /● Waiting for you/);
  assert.match(att, /new Notification\(/);
  assert.match(att, /Notification\.requestPermission/);
  assert.match(att, /vo\.notify\.asked/, 'asked once');
  const lib = readFileSync(new URL('../web/library.js', import.meta.url), 'utf8');
  assert.match(lib, /waiting\(\{ chat: '_library'/);
});

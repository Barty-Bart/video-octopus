// Codex (OpenAI's coding agent) as the chat behind a project, the Video Octopus assistant or a scheduled run: the creator's
// own install and sign-in (a ChatGPT plan), or a local model through LM Studio or Ollama. It speaks Codex's app-server
// protocol (JSON-RPC over stdio: initialize, thread/start or thread/resume, turn/start; item notifications; approval
// requests) and turns it into the same chat events as Claude Code (claude.mjs), so the panel, sessions, approval
// cards, the context meter and Compact work the same. Codex keeps the conversation itself (~/.codex); Video Octopus keeps
// its own copy for the panel and the thread id to resume it.
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { ChatSession, userEvent, stoppedEvent, shownPath } from './claude.mjs';
import { settings, state, setProjectState, shellPath, childPathEnv, expandHome, npmProgram, startError, IS_WIN } from './util.mjs';
import { childEnv, settingsBrief, section } from './settings.mjs';
import { logUse, setPlanUsage } from './usage.mjs';
import { activeSkillRoot } from './managed-skills.mjs';
import { assertNotUpdating } from './maintenance.mjs';
import { codexImage, isUsageLimitError, usageLimitText } from './images.mjs';
import { codexParams } from './agent-choices.mjs';

// ---- find Codex and its sign-in ----
const run = (bin, args, env, ms = 10000) => new Promise((done) => {
  execFile(bin, args, { timeout: ms, env }, (err, stdout, stderr) => done({ err, out: `${stdout || ''}${stderr || ''}` }));
});
let found = null;
export async function codexInfo(refresh = false) {
  if (found && !refresh) return found;
  const PATH = await shellPath();
  const env = await childPathEnv();
  const names = IS_WIN ? ['codex.exe', 'codex.cmd'] : ['codex'];
  let bin = settings().codexPath ? expandHome(settings().codexPath) : null;
  if (bin && !existsSync(bin)) return (found = { installed: false, error: `Video Octopus's local/settings.json says Codex is at ${bin} (codexPath), and there's nothing there.` });
  if (!bin) {
    for (const dir of PATH.split(delimiter)) { const n = names.find((x) => existsSync(join(dir, x))); if (n) { bin = join(dir, n); break; } }
  }
  if (!bin) return (found = { installed: false, install: 'npm install -g @openai/codex' });
  // An npm install on Windows is a .cmd shim: run the package's script with Node (util.mjs).
  const { exec, pre } = npmProgram(bin, '@openai/codex');
  const version = ((await run(exec, [...pre, '--version'], env)).out.match(/\d+\.\d+\.\d+/) || [''])[0];
  const st = (await run(exec, [...pre, 'login', 'status'], env)).out;
  const signedIn = /logged in/i.test(st) && !/not logged in/i.test(st);
  const plan = /chatgpt/i.test(st) ? 'ChatGPT plan' : /api key/i.test(st) ? 'API key' : null;
  return (found = { installed: true, bin, exec, pre, version, signedIn, plan });
}

// Video Octopus's permission modes as Codex's approval policy and sandbox.
const POLICY = {
  manual: ['untrusted', 'read-only'],             // ask before changes: every change and untrusted command asks
  acceptEdits: ['on-request', 'workspace-write'], // file edits in the studio are fine
  auto: ['on-request', 'workspace-write'],        // safe steps run, the rest asks
  bypassPermissions: ['never', 'danger-full-access'],
};
const PROVIDERS = { chatgpt: null, lmstudio: 'lmstudio', ollama: 'ollama' };

// Scheduled runs: nobody watches them, and Codex runs MCP tools and web searches without asking, so Video Octopus can't refuse
// them by the run's mode. A run's thread starts with them off (thread/start's config overrides, like codex -c): web
// search disabled, every MCP server in Codex's config disabled by name (config/read lists them), and Codex's apps
// (connectors), plugins (which bring MCP servers of their own) and browser and computer use off. Should one still turn
// up in a run, Video Octopus stops the turn (RUN_REFUSED, onNote). The creator's own Codex hooks and Codex's built-in
// memories stay out too: they would bring personal context from outside the studio into the thread.
// The Packaging chat uses the same overrides (isolatedThread), without the run's stop.
export const runThreadConfig = (mcpServers = []) => ({
  web_search: 'disabled',
  'features.apps': false, 'features.plugins': false, 'features.browser_use': false, 'features.computer_use': false, 'features.in_app_browser': false,
  'features.hooks': false, 'features.memories': false,
  // A name that can't be a dotted key stays on, and the stop below covers it.
  ...Object.fromEntries(mcpServers.filter((n) => /^[\w-]+$/.test(n)).map((n) => [`mcp_servers.${n}.enabled`, false])),
});
const RUN_REFUSED = { mcpToolCall: 'an MCP tool', webSearch: 'web search', dynamicToolCall: 'a tool from outside Codex', imageGeneration: 'image generation' };
const short = (s, n = 90) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const file2 = (p) => String(p || '').split(/[\\/]/).slice(-2).join('/');
// Codex runs commands through a login shell: "/bin/zsh -lc 'touch a.txt'". The card, the tool line and the
// "Always for …" key use the command inside.
const unwrap = (cmd) => { const m = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(String(cmd || '').trim()); return m ? m[2] : String(cmd || ''); };

// Which provider a Codex chat runs on: a thread or a running chat from another one is not continued (engines.mjs).
export const codexSource = (c = section('claude')) => c.codexProvider || 'chatgpt';

export class CodexSession extends ChatSession {
  constructor(id, context) {
    super(id, context);
    this.engine = 'codex';
    this.seq = 0;
    this.calls = new Map();   // our request id -> { done, fail }
    this.items = new Map();   // item id -> the files a change touches (for approval cards)
    this.changes = new Map(); // item id -> its changes ({ path, kind, diff }), for the request's Details
    this.threadId = null;
    this.turnId = null;
  }

  // turn/start's model and effort: a local model (LM Studio, Ollama) takes the model only; reasoning effort is the
  // ChatGPT models' own.
  turnChoice() {
    const p = codexParams(this.choice());
    if (PROVIDERS[section('claude').codexProvider]) delete p.effort;
    return p;
  }

  call(method, params) {
    return new Promise((done, fail) => {
      const id = ++this.seq;
      this.calls.set(id, { done, fail });
      this.write({ id, method, params });
    });
  }
  notify(method, params) { this.write(params === undefined ? { method } : { method, params }); }

  async start() {
    assertNotUpdating();
    const skillRoot = this.skillRoot();
    const info = await codexInfo();
    if (!info.installed) throw new Error(info.error || 'Codex is not installed on this computer (npm install -g @openai/codex), or pick another agent in Settings → Agent & model.');
    const s = settings(), c = section('claude', s), provider = PROVIDERS[c.codexProvider] ?? null;
    if (!provider && !info.signedIn) throw new Error('Codex is installed but not signed in: run codex login in a terminal, then try again.');
    const extra = await childEnv();
    const env = await childPathEnv(extra);
    const cwd = this.cwd?.() || s.studio;
    this.stderr = '';
    this.buf = '';
    const proc = this.proc = spawn(info.exec, [...info.pre, 'app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.heard = false;
    this.junk = '';
    this.guardStdin(proc);
    proc.stdout.on('data', (d) => this.onData(d));
    proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    // It couldn't start at all (no program at that path): the calls waiting on it fail with that, so the chat says so.
    proc.on('error', (e) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.setBusy(false);
      this.pending.clear();
      for (const k of this.calls.values()) k.fail(new Error(startError('Codex', info.bin, e)));
      this.calls.clear();
    });
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = null;
      const wasBusy = this.busy;
      this.setBusy(false);
      this.pending.clear();
      const ev = stoppedEvent('Codex', code ?? signal, `${this.stderr}\n${this.junk || ''}`, { early: !this.heard, signIn: 'codex login' });
      for (const k of this.calls.values()) k.fail(Object.assign(new Error(ev.text), { told: Boolean((code || signal) && wasBusy) }));
      this.calls.clear();
      if ((code || signal) && wasBusy) this.emit(ev);
    });
    await this.call('initialize', { clientInfo: { name: 'studio', title: 'Video Octopus', version: '1' }, capabilities: null });
    this.notify('initialized');
    // The studio's skills (its .claude/skills) next to Codex's own.
    if (skillRoot) {
      try { await this.call('skills/extraRoots/set', { extraRoots: [skillRoot] }); }
      catch { this.kill(); throw new Error('This Codex install could not load the studio’s active skills. Update Codex before starting this chat.'); }
    }
    const params = await this.threadParams(cwd, extra);
    const st = state().projects[this.id] || {};
    // A thread from another provider (ChatGPT, LM Studio, Ollama) isn't this one's to continue. Older saves have no source.
    this.source = codexSource(c);
    const otherSource = st.engine === 'codex' && st.source && st.source !== this.source;
    const saved = st.engine === 'codex' && !otherSource ? st.sessionId : null;
    if (otherSource) this.emit({ t: 'note', text: 'Codex now uses another provider, so this is a fresh chat.' });
    let r = saved ? await this.call('thread/resume', { threadId: saved, ...params }).catch(() => null) : null;
    if (saved && !r) this.emit({ t: 'note', text: 'The old Codex chat could not be reopened, so this is a fresh one.' });
    this.resumed = Boolean(r);
    if (!r) r = await this.call('thread/start', params);
    this.threadId = r.thread.id;
    setProjectState(this.id, { sessionId: this.threadId, engine: 'codex', source: this.source, model: r.model || this.turnChoice().model || null });
    this.emit({ t: 'session', id: this.threadId, model: r.model || this.turnChoice().model || 'codex' });
  }

  // thread/start's (and thread/resume's) parameters: the folder, Video Octopus's permission mode as Codex's approval policy and
  // sandbox, the instructions, the model, and for a scheduled run the config overrides that turn off what asks nobody.
  async threadParams(cwd, extra = {}) {
    const s = settings(), c = section('claude', s), provider = PROVIDERS[c.codexProvider] ?? null;
    const [approvalPolicy, sandbox] = POLICY[this.mode?.() || s.permissionMode] || POLICY.auto;
    return {
      cwd, approvalPolicy, sandbox,
      developerInstructions: [this.currentContext(), settingsBrief(extra,{profileScoped:Boolean(this.profileScoped||this.projectScope?.())})].filter(Boolean).join('\n'),
      ...(this.turnChoice().model ? { model: this.turnChoice().model } : {}),
      ...(provider ? { modelProvider: provider } : {}),
      ...(this.isRun() || this.isolatedThread ? { config: await this.runConfig(cwd) } : {}),
    };
  }

  // A scheduled run's config overrides (runThreadConfig), with the MCP servers Codex's config has for this folder.
  async runConfig(cwd) {
    let names = [];
    try { names = Object.keys((await this.call('config/read', { cwd }))?.config?.mcp_servers || {}); } catch {} // an older Codex: the stop covers it
    return runThreadConfig(names);
  }

  // One JSON-RPC message: a reply to our call, a request from Codex, or a notification.
  handle(m) {
    if (m.id != null && !m.method) {
      const k = this.calls.get(m.id);
      if (!k) return;
      this.calls.delete(m.id);
      if (m.error) k.fail(new Error(m.error.message || 'Codex error')); else k.done(m.result);
      return;
    }
    if (m.id != null && m.method) return this.onRequest(m);
    if (m.method) this.onNote(m.method, m.params || {});
  }

  onNote(method, p) {
    const it = p.item;
    switch (method) {
      case 'turn/started': this.turnId = p.turn?.id || null; break;
      case 'item/started':
        if (!it) break;
        if (this.isRun() && RUN_REFUSED[it.type]) {
          // A run's thread has these off; if one turns up anyway, the turn stops and the run says what it tried.
          const summary = short(it.type === 'mcpToolCall' ? `${it.server} ${it.tool}` : it.query || it.action?.query || it.tool || '');
          this.emit({ t: 'refused', tool: RUN_REFUSED[it.type], summary });
          this.emit({ t: 'note', text: `Video Octopus stopped this run: it tried to use ${RUN_REFUSED[it.type]}, which scheduled runs can't, because nobody is watching.` });
          if (this.turnId) this.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
          break;
        }
        if (it.type === 'commandExecution') this.emit({ t: 'tool', id: it.id, name: 'Bash', summary: short(unwrap(it.command)) });
        else if (it.type === 'fileChange') {
          const paths = (it.changes || []).map((x) => x.path);
          this.items.set(it.id, paths);
          this.changes.set(it.id, it.changes || []);
          this.emit({ t: 'tool', id: it.id, name: 'Edit', summary: short(paths.map(file2).join(', ')) });
        } else if (it.type === 'mcpToolCall') this.emit({ t: 'tool', id: it.id, name: `${it.server} ${it.tool}`, summary: short(JSON.stringify(it.arguments ?? '')) });
        else if (it.type === 'webSearch') this.emit({ t: 'tool', id: it.id, name: 'WebSearch', summary: short(it.query || it.action?.query || '') });
        else if (it.type === 'imageView') this.emit({ t: 'tool', id: it.id, name: 'View image', summary: file2(it.path) });
        else if (it.type === 'imageGeneration') this.emit({ t: 'tool', id: it.id, name: 'Image', summary: 'Image generation' });
        break;
      case 'item/completed':
        if (!it) break;
        if (it.type === 'agentMessage' && String(it.text || '').trim()) this.emit({ t: 'text', text: it.text });
        else if (it.type === 'commandExecution') this.emit({ t: 'tool_result', id: it.id, text: String(it.aggregatedOutput || '').slice(0, 1500), error: it.exitCode != null && it.exitCode !== 0 });
        else if (it.type === 'fileChange') { this.changes.delete(it.id); this.emit({ t: 'tool_result', id: it.id, text: (it.changes || []).map((x) => `${x.kind?.type || x.kind || 'change'} ${shownPath(x.path, this.shownRoot())}`).join('\n'), error: it.status === 'failed' }); }
        else if (it.type === 'mcpToolCall') this.emit({ t: 'tool_result', id: it.id, text: JSON.stringify(it.error || it.result || '').slice(0, 1500), error: Boolean(it.error) });
        else if (it.type === 'imageGeneration') this.imageDone(it);
        break;
      case 'thread/tokenUsage/updated': {
        // How full the context is: what the last call sent plus what it wrote.
        const u = p.tokenUsage?.last;
        if (!u) break;
        this.ctx = { ...(this.ctx || {}), window: p.tokenUsage.modelContextWindow || this.ctx?.window || 200000 };
        this.setContext((u.inputTokens || 0) + (u.outputTokens || 0));
        break;
      }
      case 'account/rateLimits/updated': {
        // The plan's limits, for the same meter Claude's fill: a window of 5 h or less, and the weekly one.
        const r = p.rateLimits || {}, out = { engine: 'codex', fiveHour: null, sevenDay: null, at: Date.now() };
        for (const w of [r.primary, r.secondary]) if (w) out[w.windowDurationMins <= 300 ? 'fiveHour' : 'sevenDay'] = w.usedPercent == null ? null : w.usedPercent / 100;
        setPlanUsage(out);
        this.emit({ t: 'usage', ...out });
        break;
      }
      case 'thread/compacted':
        this.emit({ t: 'note', text: 'Compacted: Codex keeps a summary of what came before.' });
        if (this.compacting) { this.compacting = false; this.setBusy(false); }
        break;
      case 'turn/completed': {
        const t = p.turn || {};
        this.turnId = null;
        this.setBusy(false);
        logUse('agent.turn', { ...this.usageScope(), engine: 'codex' });
        if (t.status === 'failed') this.emit({ t: 'error', text: isUsageLimitError(t.error) ? usageLimitText(null) : `Codex: ${t.error?.message || 'the turn failed.'}` });
        // A turn that ran into the plan's limit (its image, or the turn itself) ends "stopped: limit reached", not "done".
        const limit = this.turnLimit || (t.status === 'failed' && isUsageLimitError(t.error));
        this.turnLimit = false;
        this.emit({ t: 'result', ok: t.status === 'completed', seconds: Math.round((t.durationMs || 0) / 1000), ...(limit ? { why: 'limit' } : {}) });
        this.onTurnEnd?.(t);
        break;
      }
      case 'error':
        if (isUsageLimitError(p.error)) { this.turnLimit = true; this.onUsageLimit?.(p.error); }
        this.emit({ t: 'error', text: isUsageLimitError(p.error) ? usageLimitText(null) : `Codex: ${p.error?.message || p.message || 'error'}` });
        break;
      default: break;
    }
  }

  // An image Codex made (its imageGeneration item, read by images.mjs codexImage). A chat that keeps images (the Packaging
  // chat, server/packaging.mjs) sets onImage to store it; any other chat only says one was made.
  imageDone(it) {
    const image = codexImage(it);
    if (image.failure?.kind === 'usage-limit') { this.turnLimit = true; this.onUsageLimit?.(image.failure); }
    this.emit({ t: 'tool_result', id: it.id, text: image.failure ? image.failure.message : 'Image ready.', error: Boolean(image.failure) });
    if (this.onImage) {
      // Called now (not later), so work it queues runs before anything the turn's end queues.
      const kept = (() => { try { return this.onImage(image); } catch (e) { return Promise.reject(e); } })();
      Promise.resolve(kept).catch((e) => this.emit({ t: 'error', text: `Video Octopus could not keep the image: ${e.message}` }));
    } else if (image.failure) this.emit({ t: 'error', text: image.failure.message });
  }

  // Requests from Codex: approvals become Video Octopus's permission cards (the same shape as Claude Code's, so scheduled
  // runs answer them by their mode), questions become question cards, anything else is refused.
  onRequest(m) {
    const p = m.params || {}, id = String(m.id);
    const reply = (result) => this.write({ id: m.id, result });
    let request = null;
    if (m.method === 'item/commandExecution/requestApproval' || m.method === 'execCommandApproval') {
      const cmd = unwrap(Array.isArray(p.command) ? p.command.join(' ') : p.command || '');
      request = { tool_name: 'Bash', input: { command: cmd, description: p.reason || '' } };
    } else if (m.method === 'item/fileChange/requestApproval' || m.method === 'applyPatchApproval') {
      // Every file of the patch is checked (Always, a run's scope), and a request to write anywhere in a folder
      // (grantRoot) is checked as that folder.
      const paths = this.items.get(p.itemId) || Object.keys(p.fileChanges || {});
      request = { tool_name: 'Edit', input: { file_path: paths[0] || p.grantRoot || '', file_paths: paths, ...(p.grantRoot ? { grant_root: p.grantRoot } : {}) } };
    } else if (m.method === 'item/permissions/requestApproval') {
      request = { tool_name: 'Permissions', input: { reason: p.reason || '' } };
    } else if (m.method === 'item/tool/requestUserInput') {
      this.pending.set(id, { request: { tool_name: 'AskUserQuestion', input: {} }, rpc: m });
      this.emit({ t: 'question', id, questions: (p.questions || []).map((q) => ({ question: q.question, header: q.header, multiSelect: false,
        options: (q.options || []).map((o) => ({ label: o.label, description: o.description || '' })) })) });
      return;
    } else {
      this.write({ id: m.id, error: { code: -32601, message: `Video Octopus doesn't handle ${m.method}.` } });
      return;
    }
    const ak = this.alwaysFor(request);
    if (ak && this.always.has(ak.key)) return reply(this.decision(m.method, true, false)); // allowed for this session already
    if (this.autoAllow?.(request)) return reply(this.decision(m.method, true, false)); // a command that only looks (the Video Octopus assistant)
    this.pending.set(id, { request, rpc: m });
    this.emit({ t: 'permission', id, tool: request.tool_name === 'Edit' ? 'file changes' : request.tool_name === 'Bash' ? 'a command' : 'more permissions',
      always: ak?.label || null,
      summary: request.tool_name === 'Bash' ? short(request.input.command) : request.tool_name === 'Edit' ? short((request.input.file_paths || []).map(file2).join(', ')) : short(p.reason),
      ...this.requestView(request, p), description: p.reason || '' });
  }

  // A request's Details: the command, or the files a change touches from the project's folder ("work/blocks.json") with
  // its diff, or what more Codex asks for, as plain lines. Nothing empty (permissionView in claude.mjs does the same).
  requestView(request, p = {}) {
    const root = this.shownRoot();
    if (request.tool_name === 'Bash') return { detail: String(request.input.command || '').slice(0, 2000) };
    if (request.tool_name === 'Edit') {
      const changes = this.changes.get(p.itemId) || [];
      const paths = request.input.file_paths?.length ? request.input.file_paths : [request.input.file_path].filter(Boolean);
      const kind = (x) => ({ add: 'new', delete: 'delete', update: '' })[x?.kind?.type || x?.kind] ?? '';
      const file = [...paths.map((f) => { const k = kind(changes.find((x) => x.path === f)); return `${shownPath(f, root)}${k ? ` (${k})` : ''}`; }),
        p.grantRoot && `and writing anywhere in ${shownPath(p.grantRoot, root)} for the rest of this chat`].filter(Boolean).join('\n');
      const diff = changes.map((x) => String(x.diff || '').split('\n').filter((l) => !/^(---|\+\+\+|diff |index )/.test(l)).slice(0, 60).join('\n').trim())
        .filter(Boolean).join('\n…\n').slice(0, 4000);
      return { ...(file ? { file } : {}), ...(diff ? { diff } : {}) };
    }
    const lines = Object.entries(p.permissions || {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
    return lines ? { detail: lines.slice(0, 1500) } : {};
  }

  decision(method, allow, always) {
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') return { decision: allow ? (always ? 'approved_for_session' : 'approved') : 'denied' };
    return { decision: allow ? (always ? 'acceptForSession' : 'accept') : 'decline' };
  }

  answer(requestId, { allow, message, answers, always }) {
    const req = this.pending.get(requestId);
    if (!req) return false;
    this.pending.delete(requestId);
    const m = req.rpc;
    // "Always" counts only when Video Octopus itself offers it for this request (alwaysFor: never in the assistant or a
    // run, never for a compound command or a wider sandbox), whatever the page sent.
    const ak = allow && always ? this.alwaysFor(req.request) : null;
    if (ak) this.always.add(ak.key);
    if (m.method === 'item/tool/requestUserInput') {
      // Video Octopus answers by question text; Codex wants them by question id.
      const out = {};
      for (const q of m.params?.questions || []) if (answers?.[q.question] != null) out[q.id] = { answers: String(answers[q.question]).split(', ').filter(Boolean) };
      this.write({ id: m.id, result: { answers: out } });
    } else if (m.method === 'item/permissions/requestApproval') {
      if (allow) this.write({ id: m.id, result: { permissions: m.params?.permissions || {}, scope: ak ? 'session' : 'turn' } });
      else this.write({ id: m.id, error: { code: -32000, message: message || 'The creator said no.' } });
    } else this.write({ id: m.id, result: this.decision(m.method, Boolean(allow), Boolean(ak)) });
    this.emit({ t: 'permission_done', id: requestId, outcome: answers ? 'answered' : ak ? 'always' : allow ? 'allowed' : 'denied', always: ak?.label });
    return true;
  }

  // images: absolute paths of pictures to attach to this message (turn/start's localImage input), e.g. a Packaging
  // card to refine or the creator's photos.
  async send(text, { echo = true, brief = null, images = [] } = {}) {
    assertNotUpdating();
    this.skillRoot();
    this.lastSend = text;
    this.lastBrief = brief;
    this.lastImages = images;
    this.setBusy(true);
    if (!this.proc) {
      // A start failure goes back to the caller (the route answers with the error, as for Claude Code).
      try { await this.start(); } catch (e) { this.kill(); this.setBusy(false); throw e; }
    }
    if (echo) this.emit(userEvent(text, brief));
    this.setBusy(true);
    try {
      const input = [{ type: 'text', text: this.withContextUpdate(text), text_elements: [] }, ...images.map((path) => ({ type: 'localImage', path }))];
      // The model and reasoning effort picked for this chat go with every turn (turn/start's model and effort: "for this
      // turn and subsequent turns"), so a change applies from the next message without a restart.
      await this.call('turn/start', { threadId: this.threadId, input, ...this.turnChoice() });
    } catch (e) { this.setBusy(false); if (!e.told) this.emit({ t: 'error', text: `Codex: ${e.message}`, retry: true }); }
  }

  stop() {
    if (!this.proc || !this.busy) return false;
    if (this.turnId) this.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
    return true;
  }

  async compact() {
    if (this.busy) throw new Error('Codex is working: wait for it to finish, then compact.');
    if (!this.history().some((e) => e.t === 'user')) throw new Error('Nothing to compact yet.');
    this.memoryCheckpoint('before-compaction');
    if (!this.proc) await this.start();
    this.emit({ t: 'note', text: 'Compacting this chat: Codex keeps a summary and frees room.' });
    this.compacting = true;
    this.setBusy(true);
    logUse('compact', { ...this.usageScope(), engine: 'codex' });
    this.call('thread/compact/start', { threadId: this.threadId }).catch((e) => { this.compacting = false; this.setBusy(false); this.emit({ t: 'error', text: `Codex: ${e.message}` }); });
  }
}

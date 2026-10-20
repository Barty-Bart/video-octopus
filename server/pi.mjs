// pi (pi.dev, an open-source coding agent) as the chat behind a project, the Video Octopus assistant or a scheduled run:
// with the providers the creator set up in pi (any API key, a local server, their own), or "Video Octopus endpoint", any
// OpenAI-compatible URL picked in Settings (OpenRouter, LM Studio, Ollama…). It speaks pi's RPC mode (JSONL over
// stdin/stdout: prompt, abort, compact, get_state, get_session_stats; session events; extension UI requests) and turns
// it into the same chat events as Claude Code (claude.mjs). Video Octopus's own pi extension (core/pi/octopus-extension.js,
// passed with -e on every start, nothing to install) asks before commands and file changes, so approvals come back as
// Video Octopus's cards, and registers the endpoint. pi keeps the conversation (its session file); Video Octopus keeps its own copy
// and the session file's path to resume it.
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { ChatSession, userEvent } from './claude.mjs';
import { settings, state, setProjectState, shellPath, childPathEnv, expandHome, npmProgram, startError, IS_WIN, APP_DIR } from './util.mjs';
import { childEnv, settingsBrief, section } from './settings.mjs';
import { logUse } from './usage.mjs';
import { activeSkillRoot } from './managed-skills.mjs';
import { assertNotUpdating } from './maintenance.mjs';

const EXTENSION = join(APP_DIR, 'core', 'pi', 'octopus-extension.js');
const run = (bin, args, env, ms = 15000) => new Promise((done) => {
  execFile(bin, args, { timeout: ms, env, maxBuffer: 4e6 }, (err, stdout, stderr) => done({ err, out: String(stdout || ''), errOut: String(stderr || '') }));
});

// ---- find pi, and the models it knows ----
let found = null;
export async function piInfo(refresh = false) {
  if (found && !refresh) return found;
  const PATH = await shellPath();
  const env = await childPathEnv();
  const names = IS_WIN ? ['pi.exe', 'pi.cmd'] : ['pi'];
  let bin = settings().piPath ? expandHome(settings().piPath) : null;
  if (bin && !existsSync(bin)) return (found = { installed: false, error: `Video Octopus's local/settings.json says pi is at ${bin} (piPath), and there's nothing there.` });
  if (!bin) {
    for (const dir of PATH.split(delimiter)) { const n = names.find((x) => existsSync(join(dir, x))); if (n) { bin = join(dir, n); break; } }
  }
  if (!bin) return (found = { installed: false, install: 'npm install -g @earendil-works/pi-coding-agent' });
  // An npm install on Windows is a .cmd shim: run the package's script with Node (util.mjs), at every start.
  const { exec, pre } = npmProgram(bin, '@earendil-works/pi-coding-agent');
  const version = ((await run(exec, [...pre, '--version'], env)).out.match(/\d+\.\d+\.\d+/) || [''])[0];
  return (found = { installed: true, bin, exec, pre, version });
}

// `pi --list-models`: a table of provider, model, context, max-out, thinking, images.
export async function piModels() {
  const info = await piInfo();
  if (!info.installed) return [];
  const r = await run(info.exec, [...info.pre, '--list-models', '--offline'], await childPathEnv(), 30000);
  return r.out.split('\n').slice(1).map((l) => l.trim().split(/\s{2,}/)).filter((c) => c.length >= 6 && c[0] !== 'provider')
    .map(([provider, model, context, , thinking, images]) => ({ provider, model, context, thinking: thinking === 'yes', images: images === 'yes' }));
}

const TOOL = { bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit', grep: 'Grep', find: 'Glob', ls: 'LS' };
const short = (s, n = 90) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const file2 = (p) => String(p || '').split(/[\\/]/).slice(-2).join('/');
const textOf = (content) => (Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('') : String(content ?? ''));

export class PiSession extends ChatSession {
  constructor(id, context) {
    super(id, context);
    this.engine = 'pi';
    this.seq = 0;
    this.calls = new Map(); // our command id -> { done, fail }
    this.turnStart = 0;
  }

  call(type, params = {}) {
    return new Promise((done, fail) => {
      const id = `s${++this.seq}`;
      this.calls.set(id, { done, fail });
      this.write({ id, type, ...params });
    });
  }

  async start() {
    assertNotUpdating();
    const skillRoot = activeSkillRoot({ studio: settings().studio });
    const info = await piInfo();
    if (!info.installed) throw new Error(info.error || `pi is not installed on this computer (${info.install}), or pick another agent in Settings → Agent & model.`);
    const s = settings(), c = section('claude', s), extra = await childEnv();
    const endpoint = c.piSource === 'endpoint';
    if (endpoint && (!c.piBaseUrl || !c.piModel)) throw new Error('Settings → Agent & model: give the endpoint a URL and a model first.');
    const cwd = this.cwd?.() || s.studio;
    const st = state().projects[this.id] || {};
    const saved = st.engine === 'pi' && st.sessionId && existsSync(st.sessionId) ? st.sessionId : null;
    const skills = skillRoot ? ['--skill', skillRoot] : [];
    const model = endpoint ? ['--provider', 'studio', '--model', c.piModel] : c.piModel ? ['--model', c.piModel] : [];
    const args = ['--mode', 'rpc', '-e', EXTENSION, ...skills, ...model,
      '--append-system-prompt', [this.currentContext(), settingsBrief(extra)].filter(Boolean).join('\n'),
      ...(saved ? ['--session', saved] : [])];
    this.resumed = Boolean(saved);
    const env = await childPathEnv({
      ...extra,
      STUDIO_PI_MODE: this.mode?.() || s.permissionMode || 'auto',
      // The studio is "inside" (file changes there don't ask in Auto); pi runs in `cwd` (a project's folder for a
      // project chat), which is what a relative path in a tool call means.
      STUDIO_PI_ROOT: s.studio || cwd,
      STUDIO_PI_CWD: cwd,
      ...(endpoint ? { STUDIO_PI_BASE_URL: c.piBaseUrl, STUDIO_PI_MODEL: c.piModel, STUDIO_PI_API_KEY: extra.OPENAI_COMPATIBLE_API_KEY || 'none',
        STUDIO_PI_VISION: c.piVision ? '1' : '0', STUDIO_PI_CONTEXT: String(c.piContext || 128000) } : {}),
    });
    this.stderr = '';
    this.buf = '';
    const proc = this.proc = spawn(info.exec, [...info.pre, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdout.on('data', (d) => this.onData(d));
    proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    // It couldn't start at all (no program at that path): the calls waiting on it fail with that, so the chat says so.
    proc.on('error', (e) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.setBusy(false);
      this.pending.clear();
      for (const k of this.calls.values()) k.fail(new Error(startError('pi', info.bin, e)));
      this.calls.clear();
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      const wasBusy = this.busy;
      this.setBusy(false);
      this.pending.clear();
      for (const k of this.calls.values()) k.fail(new Error('pi stopped.'));
      this.calls.clear();
      if (code && (wasBusy || !this.started)) this.emit({ t: 'error', text: `pi stopped (exit ${code}). ${this.stderr.trim().split('\n').slice(-2).join(' ')}` });
    });
    const state0 = await this.call('get_state');
    this.started = true;
    if (state0?.sessionFile) setProjectState(this.id, { sessionId: state0.sessionFile, engine: 'pi', model: state0?.model?.id || c.piModel || null });
    if (state0?.model?.contextWindow) this.ctx = { ...(this.ctx || {}), window: state0.model.contextWindow };
    this.emit({ t: 'session', id: state0?.sessionId || '', model: state0?.model?.id || c.piModel || 'pi' });
  }

  // One JSONL record: a reply to our command, a session event, or an extension UI request.
  handle(m) {
    if (m.type === 'response') {
      const k = m.id && this.calls.get(m.id);
      if (!k) return;
      this.calls.delete(m.id);
      if (m.success === false) k.fail(new Error(m.error || `pi: ${m.command} failed`)); else k.done(m.data);
      return;
    }
    if (m.type === 'extension_ui_request') return this.onUi(m);
    this.onEvent(m);
  }

  onEvent(e) {
    switch (e.type) {
      case 'message_end': {
        const msg = e.message || {};
        if (msg.role === 'assistant') {
          const text = textOf(msg.content);
          if (text.trim()) this.emit({ t: 'text', text });
          if (msg.stopReason === 'error' && msg.errorMessage) this.emit({ t: 'error', text: `pi: ${msg.errorMessage}` });
        }
        break;
      }
      case 'tool_execution_start': {
        const a = e.args || {};
        this.emit({ t: 'tool', id: e.toolCallId, name: TOOL[e.toolName] || e.toolName, summary: short(a.command || (a.path ? file2(a.path) : '') || a.pattern || JSON.stringify(a)) });
        break;
      }
      case 'tool_execution_end':
        this.emit({ t: 'tool_result', id: e.toolCallId, text: textOf(e.result?.content).slice(0, 1500), error: Boolean(e.isError) });
        break;
      case 'compaction_start': this.emit({ t: 'status', text: 'Compacting the chat…' }); break;
      case 'compaction_end': {
        const r = e.result, k = (n) => `${Math.round((n || 0) / 1000)}k`;
        if (r) {
          this.emit({ t: 'note', text: `${e.reason === 'manual' ? 'Compacted' : 'pi compacted this chat by itself'}: ${k(r.tokensBefore)} → ${k(r.estimatedTokensAfter)} tokens. pi keeps a summary of what came before.` });
          this.setContext(r.estimatedTokensAfter);
        } else if (e.errorMessage) this.emit({ t: 'error', text: `pi couldn't compact: ${e.errorMessage}` });
        break;
      }
      case 'auto_retry_end': if (e.success === false) this.emit({ t: 'error', text: `pi: ${e.finalError || 'the model kept failing'}` }); break;
      case 'extension_error': this.emit({ t: 'note', text: `pi extension error (${e.event}): ${e.error}` }); break;
      case 'agent_settled': {
        // The run is over (pi won't continue by itself): the turn's result, then how full the context is.
        this.setBusy(false);
        logUse('agent.turn', { ...this.usageScope(), engine: 'pi' });
        this.emit({ t: 'result', ok: !e.aborted, seconds: Math.round((Date.now() - this.turnStart) / 1000) });
        this.call('get_session_stats').then((d) => {
          const u = d?.contextUsage;
          if (u?.tokens != null) { this.ctx = { ...(this.ctx || {}), window: u.contextWindow || this.ctx?.window || 128000 }; this.setContext(u.tokens); }
        }).catch(() => {});
        break;
      }
      default: break;
    }
  }

  // Video Octopus's extension asks before commands, file changes and any tool that isn't one of pi's own looking tools (a
  // select titled STUDIO_APPROVAL {…}): a permission card, or an answer straight away when "Always for …" already
  // covers it. Other dialogs get cancelled; notices become notes.
  onUi(m) {
    const reply = (fields) => this.write({ type: 'extension_ui_response', id: m.id, ...fields });
    if (m.method === 'notify') { if (m.notifyType === 'warning' || m.notifyType === 'error') this.emit({ t: 'note', text: `pi: ${m.message}` }); return; }
    if (!['select', 'confirm', 'input', 'editor'].includes(m.method)) return;
    const head = /^STUDIO_APPROVAL (\{[\s\S]*\})$/.exec(String(m.title || ''));
    if (!head) return reply({ cancelled: true });
    let ask;
    try { ask = JSON.parse(head[1]); } catch { return reply({ value: 'Deny' }); }
    const request = { tool_name: ask.tool, input: ask.input || {} };
    const ak = this.alwaysFor(request);
    if (ak && this.always.has(ak.key)) return reply({ value: 'Allow' }); // allowed for this session already
    if (this.autoAllow?.(request)) return reply({ value: 'Allow' }); // a command that only looks (the Video Octopus assistant)
    this.pending.set(m.id, { request, rpc: m });
    const kind = ask.tool === 'Bash' ? 'command' : ['Write', 'Edit'].includes(ask.tool) ? 'edit' : 'other';
    this.emit({ t: 'permission', id: m.id, tool: kind === 'command' ? 'a command' : kind === 'edit' ? 'file changes' : String(ask.tool), always: ak?.label || null,
      summary: kind === 'command' ? short(ask.input.command) : kind === 'edit' ? file2(ask.input.file_path) : short(JSON.stringify(ask.input)),
      detail: kind === 'command' ? String(ask.input.command || '').slice(0, 2000) : kind === 'edit' ? String(ask.input.file_path || '') : JSON.stringify(ask.input, null, 1).slice(0, 1500),
      description: ask.input.shell === 'powershell' ? 'A PowerShell command' : '' });
  }

  answer(requestId, { allow, answers, always }) {
    const req = this.pending.get(requestId);
    if (!req) return false;
    this.pending.delete(requestId);
    const ak = allow && always ? this.alwaysFor(req.request) : null;
    if (ak) this.always.add(ak.key);
    this.write({ type: 'extension_ui_response', id: req.rpc.id, value: allow ? (always ? 'Always' : 'Allow') : 'Deny' });
    this.emit({ t: 'permission_done', id: requestId, outcome: answers ? 'answered' : ak ? 'always' : allow ? 'allowed' : 'denied', always: ak?.label });
    return true;
  }

  async send(text, { echo = true, brief = null } = {}) {
    assertNotUpdating();
    activeSkillRoot({ studio: settings().studio });
    this.lastSend = text;
    this.setBusy(true);
    if (!this.proc) {
      try { await this.start(); } catch (e) { this.emit({ t: 'error', text: e.message }); this.kill(); return; }
    }
    if (echo) this.emit(userEvent(text, brief));
    this.setBusy(true);
    this.turnStart = Date.now();
    try { await this.call('prompt', { message: this.withContextUpdate(text) }); }
    catch (e) { this.setBusy(false); this.emit({ t: 'error', text: `pi: ${e.message}` }); }
  }

  stop() {
    if (!this.proc || !this.busy) return false;
    this.call('abort').catch(() => {});
    return true;
  }

  async compact() {
    if (this.busy) throw new Error('pi is working: wait for it to finish, then compact.');
    if (!this.history().some((e) => e.t === 'user')) throw new Error('Nothing to compact yet.');
    if (!this.proc) await this.start();
    this.emit({ t: 'note', text: 'Compacting this chat: pi keeps a summary and frees room.' });
    this.setBusy(true);
    logUse('compact', { ...this.usageScope(), engine: 'pi' });
    this.call('compact').then(() => this.setBusy(false)).catch((e) => { this.setBusy(false); this.emit({ t: 'error', text: `pi: ${e.message}` }); });
  }
}

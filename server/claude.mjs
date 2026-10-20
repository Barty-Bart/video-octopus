// Runs the creator's own Claude Code (their install, their sign-in) as the chat behind each project.
// One long-running `claude --print` per project, talking stream-json both ways; permission questions
// come back over stdio so the app can show Allow / Deny. The app never reads or stores the login.
import { spawn, execFile } from 'node:child_process';
import { existsSync, appendFileSync, readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, delimiter, relative, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { settings, state, setProjectState, shellPath, childPathEnv, inside, expandHome, npmProgram, startError, IS_WIN, LOCAL_DIR, APP_DIR } from './util.mjs';
import { OUTSIDE_REASON } from './outside-hook.mjs';
import { logUse, setPlanUsage } from './usage.mjs';
import { childEnv, settingsBrief, section } from './settings.mjs';
import { ccSource, claudeLaunchNow, sourceBrief, CC_SOURCES } from './claude-source.mjs';
import { activeSkillRoot, skillSelectionBrief } from './managed-skills.mjs';
import { skillPreferencesBrief } from './skill-preferences.mjs';
import { assertNotUpdating } from './maintenance.mjs';

// Tools that can't work inside an app chat (no terminal, no claude.ai, nothing after the turn ends).
const NOT_IN_CHAT = ['ListAgents', 'SendMessage', 'PushNotification', 'CronCreate', 'CronDelete', 'CronList',
  'ScheduleWakeup', 'Monitor', 'Workflow', 'DesignSync', 'ReportFindings', 'Artifact', 'ArtifactComments',
  'ArtifactData', 'RemoteTrigger', 'EnterWorktree', 'ExitWorktree'];

const run = (bin, args, env, ms = 8000) => new Promise((done) => {
  execFile(bin, args, { timeout: ms, env }, (err, stdout, stderr) => done({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

// The agents Video Octopus can run, by the id Settings stores. engines.mjs hands this out to the rest of Video Octopus; it lives here
// because engines.mjs imports this file (and codex.mjs and pi.mjs build on ChatSession), so importing it from there
// would be a cycle.
export const ENGINES = { claude: 'Claude Code', codex: 'Codex', pi: 'pi' };

// ---- find Claude Code and its sign-in ----
let found = null;

export async function claudeInfo(refresh = false) {
  if (found && !refresh) return found;
  const PATH = await shellPath();
  const env = await childPathEnv();
  let bin = settings().claudePath ? expandHome(settings().claudePath) : null;
  if (bin && !existsSync(bin)) return (found = { installed: false, error: `Video Octopus's local/settings.json says Claude Code is at ${bin} (claudePath), and there's nothing there.` });
  const names = IS_WIN ? ['claude.exe', 'claude.cmd'] : ['claude'];
  if (!bin) {
    for (const dir of PATH.split(delimiter)) { const n = names.find((x) => existsSync(join(dir, x))); if (n) { bin = join(dir, n); break; } }
  }
  if (!bin) {
    const places = IS_WIN
      ? [join(homedir(), '.local', 'bin', 'claude.exe'), join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'claude.cmd')]
      : [join(homedir(), '.local/bin/claude'), join(homedir(), '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
    bin = places.find((p) => existsSync(p)) || null;
  }
  // The official installers (Claude Code's own setup page).
  if (!bin) return (found = { installed: false, install: IS_WIN ? 'irm https://claude.ai/install.ps1 | iex (in PowerShell)' : 'curl -fsSL https://claude.ai/install.sh | bash' });
  // An npm install on Windows is a .cmd shim: run the package's script with Node (util.mjs).
  const { exec, pre } = npmProgram(bin, '@anthropic-ai/claude-code');
  const version = (await run(exec, [...pre, '--version'], env)).stdout.trim().split(' ')[0];
  // `claude auth status` says how Claude Code is signed in, without the app touching the login itself.
  const auth = await run(exec, [...pre, 'auth', 'status'], env);
  let signedIn = false, plan = null;
  try {
    const a = JSON.parse(auth.stdout);
    signedIn = Boolean(a.loggedIn ?? a.authMethod);
    const plans = { max: 'Max plan', pro: 'Pro plan', team: 'Team plan', enterprise: 'Enterprise plan' };
    plan = a.authMethod === 'claude.ai' ? (plans[a.subscriptionType] || 'Claude subscription') : a.authMethod === 'api_key' ? 'API key' : a.authMethod || null;
  } catch {}
  return (found = { installed: true, bin, exec, pre, version, signedIn, plan });
}

// ---- one chat session per project ----
const CHAT_DIR = join(LOCAL_DIR, 'chats');
mkdirSync(CHAT_DIR, { recursive: true });

// What gets saved to the chat log (so the panel can be rebuilt after a restart).
const KEEP = new Set(['user', 'text', 'tool', 'tool_result', 'permission', 'permission_done', 'question', 'result', 'error', 'note', 'marker', 'refused', 'proposals']);

// The tools that change files, and the files one request changes: a Codex patch can touch several (file_paths),
// Claude Code's and pi's requests one (file_path). Approvals and scheduled runs check every one of them.
export const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
export const editPaths = (input = {}) => (Array.isArray(input.file_paths) && input.file_paths.length ? input.file_paths : [input.file_path || input.notebook_path]).map((p) => String(p || ''));

// "Always for this session" on a permission card: the kind of step the creator doesn't want to be asked about again
// until the session ends (+ New session, another one continued, Video Octopus restarting). A command by its program (a
// compound or redirected command is asked every time), a file change by the folder it's in (inside the studio only).
// The Video Octopus assistant and scheduled runs don't offer it: the assistant always asks, runs answer by their mode.
function alwaysKey(tool, input = {}, root = '') {
  if (tool === 'Bash') {
    const cmd = String(input.command || '').trim();
    // PowerShell (pi on Windows) runs "(…)" inside a command's arguments: asked every time.
    if (!cmd || input.shell === 'powershell' || /[;&|`$<>\n]/.test(cmd)) return null;
    // A program by its plain name only: "/tmp/x/ffmpeg" or "./tool" are asked every time.
    const prog = cmd.split(/\s+/)[0];
    return /^[\w.+-]{1,40}$/.test(prog) ? { key: `Bash:${prog}`, label: `${prog} commands` } : null;
  }
  if (EDIT_TOOLS.includes(tool)) {
    // Every file of the change must get the same key; a request for a whole folder (Codex's grant_root) never does.
    if (input.grant_root) return null;
    const keys = editPaths(input).map((p) => editKey(p, root));
    return keys[0] && keys.every((k) => k?.key === keys[0].key) ? keys[0] : null;
  }
  return null;
}
function editKey(p, root) {
  const abs = root && p ? inside(root, p) : null; // ".." or a link can't leave the studio
  if (!abs) return null;
  const dir = dirname(relative(resolve(root), abs));
  if (!dir || dir === '.') return null;
  const shown = dir.split(/[\\/]/).slice(-2).join('/');
  return { key: `Edit:${dir}`, label: `changes in ${shown}/` };
}

// The context window until Claude Code reports its own: 1M for a model picked with [1m] (opus[1m], sonnet[1m]), else 200K.
const defaultWindow = () => (/\[1m\]/i.test(settings().model || '') ? 1000000 : 200000);

export class ChatSession {
  constructor(id, context) {
    this.id = id;
    this.context = context;       // () => system-prompt text for this project
    this.proc = null;
    this.busy = false;
    this.pending = new Map();     // request_id -> control_request
    this.listeners = new Set();
    this.log = join(CHAT_DIR, `${id}.jsonl`);
    this.buf = '';
    this.stderr = '';
    this.triedFresh = false;
    this.ctx = state().projects[id]?.context || null; // { tokens, window } of the last turn
    this.always = new Set();      // "Always for this session" keys (alwaysKey)
    this.engine = 'claude';       // which agent runs this chat (codex.mjs is the other); a saved session belongs to one
  }
  isRun() { return this.id.startsWith('_run_'); } // a scheduled run: nobody watches it (schedules.mjs answers for it)
  offersAlways() { return this.id !== '_studio' && !this.isRun(); }
  alwaysFor(r) { return this.offersAlways() ? alwaysKey(r.tool_name, r.input, this.cwd?.() || settings().studio) : null; }

  history() {
    try { return readFileSync(this.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  }

  emit(ev) {
    ev.ts = ev.ts || Date.now();
    if (KEEP.has(ev.t)) appendFileSync(this.log, JSON.stringify(ev) + '\n');
    for (const fn of this.listeners) fn(ev);
  }

  async start() {
    assertNotUpdating();
    activeSkillRoot({ studio: settings().studio });
    const info = await claudeInfo();
    if (!info.installed) throw new Error(info.error || 'Claude Code is not installed on this computer.');
    const s = settings();
    const st0 = state().projects[this.id] || {};
    // Saved API keys (the system key store) and the engines picked in Settings reach Claude and its skills as env vars.
    const extra = await childEnv();
    // The model source (claude-source.mjs): the plan as it is, or another server with its own endpoint, model and
    // token, and none of the creator's Anthropic credentials. Throws in plain words when it isn't set up yet.
    const launch = await claudeLaunchNow(await childPathEnv(extra), this.cwd?.() || s.studio);
    this.source = launch.src.id;
    // A Codex thread isn't Claude's to resume, nor a session that ran on another model source.
    const sessionId = (st0.engine || 'claude') === 'claude' && (st0.source || 'plan') === this.source ? st0.sessionId : null;
    const mode = this.mode?.() || s.permissionMode || 'manual';
    const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompt-tool', 'stdio', '--permission-mode', mode,
      '--append-system-prompt', [this.currentContext(), settingsBrief(extra), sourceBrief(launch.src)].filter(Boolean).join('\n'),
      '--disallowedTools', NOT_IN_CHAT.join(',')];
    if (sessionId) args.push('--resume', sessionId);
    this.resumed = Boolean(sessionId);
    if (s.model && this.source === 'plan') args.push('--model', s.model);
    args.push(...launch.args);
    // Clean chats (Settings → Agent & model; on by default, and always with another model source): only the studio's own
    // skills and settings. No claude.ai connectors or MCP servers (their tool lists alone were ~30k tokens at the start of
    // a chat), no user-level plugins, hooks or skills, no Claude Code built-in skills. Behind another model source Claude
    // Code sends every tool in full (no tool search), so with a creator's connectors that would be ~500k tokens.
    const lean = this.source !== 'plan' || section('claude', s).lean !== false;
    if (lean) args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'project,local');
    let env = lean ? { ...launch.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' } : launch.env;
    // Auto ("safe steps"): Claude Code's own classifier decides what runs without asking. A project chat adds one check
    // of Video Octopus's own: a change outside the project's folder (a file tool's path, or a command's redirect, copy, move or
    // delete target) comes back as an Allow / Deny card (server/outside-hook.mjs, a PreToolUse hook in --settings).
    // Project files never ask. What a script writes can't be known before it runs, so that stays the classifier's call.
    const guard = mode === 'auto' ? this.guard?.() : null;
    if (guard) {
      withSettings(args, { hooks: { PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: `"${process.execPath}" "${OUTSIDE_HOOK}"`, timeout: 15 }] }] } });
      env = { ...env, STUDIO_GUARD_DIR: guard, STUDIO_GUARD_STUDIO: s.studio || '' };
    }
    this.lean = lean;
    this.stderr = '';
    this.proc = spawn(info.exec || info.bin, [...(info.pre || []), ...args], { cwd: this.cwd?.() || s.studio, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const proc = this.proc;
    proc.stdout.on('data', (d) => this.onData(d));
    proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    // It couldn't start at all (no program at that path): say so in the chat instead of crashing the server.
    proc.on('error', (e) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.setBusy(false);
      this.pending.clear();
      this.emit({ t: 'error', text: startError('Claude Code', info.bin, e) });
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      const wasBusy = this.busy;
      this.setBusy(false);
      this.pending.clear();
      // A saved session that Claude Code can't find any more: start a fresh one once.
      if (code && sessionId && /no conversation found|session.*not found/i.test(this.stderr) && !this.triedFresh) {
        this.triedFresh = true;
        setProjectState(this.id, { sessionId: null });
        this.emit({ t: 'note', text: 'The old chat could not be reopened, so this is a fresh one.' });
        if (this.lastSend) this.send(this.lastSend, { echo: false });
        return;
      }
      if (code && wasBusy) this.emit({ t: 'error', text: `Claude stopped (exit ${code}). ${this.stderr.trim().split('\n').slice(-2).join(' ')}` });
    });
  }

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      this.handle(j);
    }
  }

  handle(j) {
    if (j.type === 'system' && j.subtype === 'init') {
      setProjectState(this.id, { sessionId: j.session_id, engine: 'claude', model: j.model || null, source: this.source || 'plan' });
      this.triedFresh = false;
      this.emit({ t: 'session', id: j.session_id, model: j.model });
    } else if (j.type === 'system' && j.subtype === 'task_summary' && j.detail) {
      this.emit({ t: 'status', text: j.detail });
    } else if (j.type === 'system' && j.subtype === 'status' && j.status === 'compacting') {
      this.emit({ t: 'status', text: 'Compacting the chat…' });
    } else if (j.type === 'system' && j.subtype === 'compact_boundary') {
      // Claude Code compacted (asked for, or by itself near the limit): the chat now holds a summary.
      const m = j.compact_metadata || {}, k = (n) => `${Math.round((n || 0) / 1000)}k`;
      this.setContext(m.post_tokens);
      this.emit({ t: 'note', text: `${m.trigger === 'auto' ? 'Claude compacted this chat by itself' : 'Compacted'}: ${k(m.pre_tokens)} → ${k(m.post_tokens)} tokens. Claude keeps a summary of what came before.` });
    } else if (j.type === 'assistant') {
      // How full the context is: what this call sent plus what it wrote.
      const u = j.message?.usage;
      const used = u ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0) : 0;
      if (used) this.ctx = { ...(this.ctx || {}), tokens: used };
      for (const b of j.message?.content || []) {
        // Stopped mid-sentence (Stop sends an interrupt, and Claude Code then hands over what it had written so far):
        // only its whole sentences stay, so the chat never keeps a fragment like "You".
        const text = b.type === 'text' && this.stopping ? wholeSentences(b.text) : b.text;
        if (b.type === 'text' && text.trim()) this.emit({ t: 'text', text });
        if (b.type === 'tool_use') this.emit({ t: 'tool', id: b.id, name: b.name, summary: toolSummary(b.name, b.input) });
      }
    } else if (j.type === 'user' && Array.isArray(j.message?.content)) {
      for (const b of j.message.content) {
        if (b.type !== 'tool_result') continue;
        const text = Array.isArray(b.content) ? b.content.map((c) => c.text || '').join('\n') : String(b.content ?? '');
        this.emit({ t: 'tool_result', id: b.tool_use_id, text: text.slice(0, 1500), error: Boolean(b.is_error) });
      }
    } else if (j.type === 'control_request' && j.request?.subtype === 'can_use_tool') {
      this.pending.set(j.request_id, j);
      const r = j.request;
      if (r.tool_name === 'AskUserQuestion') {
        this.emit({ t: 'question', id: j.request_id, questions: (r.input?.questions || []).map((q) => ({
          question: q.question, header: q.header, multiSelect: Boolean(q.multiSelect),
          options: (q.options || []).map((o) => ({ label: o.label, description: o.description || '' })) })) });
      } else {
        const ak = this.alwaysFor(r);
        // Asked for nothing: a command that only looks, in a chat that answers those itself (the Video Octopus assistant).
        if (this.autoAllow?.(r)) {
          this.pending.delete(j.request_id);
          this.write({ type: 'control_response', response: { subtype: 'success', request_id: j.request_id, response: { behavior: 'allow', updatedInput: r.input } } });
        } else if (ak && this.always.has(ak.key)) {
          // Allowed for this session already: answer without asking.
          this.pending.delete(j.request_id);
          this.write({ type: 'control_response', response: { subtype: 'success', request_id: j.request_id, response: { behavior: 'allow', updatedInput: r.input } } });
        } else {
          // reason: why it asks, when Video Octopus's own check raised it (a change outside the project in Auto, outside-hook.mjs).
          const reason = String(r.decision_reason || '').startsWith(OUTSIDE_REASON) ? String(r.decision_reason) : '';
          this.emit({ t: 'permission', id: j.request_id, tool: r.display_name || r.tool_name, always: ak?.label || null,
            summary: toolSummary(r.tool_name, r.input), detail: permissionDetail(r.tool_name, r.input), description: r.description || '', ...(reason ? { reason } : {}) });
        }
      }
    } else if (j.type === 'control_cancel_request') {
      this.pending.delete(j.request_id);
      this.emit({ t: 'permission_done', id: j.request_id, outcome: 'withdrawn' });
    } else if (j.type === 'rate_limit_event' && j.rate_limit_info && (this.source || 'plan') === 'plan') {
      // The plan's limits (another model source has none of the plan's to report).
      const w = j.rate_limit_info.unifiedWindows || {};
      const u = { fiveHour: w.five_hour?.utilization ?? null, sevenDay: w.seven_day?.utilization ?? null, at: Date.now() };
      setPlanUsage(u);
      this.emit({ t: 'usage', fiveHour: u.fiveHour, sevenDay: u.sevenDay });
    } else if (j.type === 'result') {
      this.stopping = false;
      const win = Object.values(j.modelUsage || {}).map((m) => m?.contextWindow).find(Boolean);
      if (win) this.ctx = { ...(this.ctx || {}), window: win };
      if (this.ctx?.tokens) this.setContext(this.ctx.tokens);
      this.setBusy(false);
      logUse('agent.turn', { ...this.usageScope(), engine: 'claude' });
      this.emit({ t: 'result', ok: j.subtype === 'success' && !j.is_error, seconds: Math.round((j.duration_ms || 0) / 1000) });
    }
  }

  setContext(tokens) {
    this.ctx = { tokens: tokens || 0, window: this.ctx?.window || defaultWindow(), at: Date.now() };
    setProjectState(this.id, { context: this.ctx });
    this.emit({ t: 'context', tokens: this.ctx.tokens, window: this.ctx.window });
  }
  // For the usage log: which chat replied (the Video Octopus assistant, a scheduled run or a project), never what it said.
  usageScope() { return this.id === '_studio' ? { scope: 'studio' } : this.id.startsWith('_run_') ? { scope: 'schedule' } : { scope: 'project', project: this.id }; }
  contextEvent() { return this.ctx?.tokens ? { t: 'context', tokens: this.ctx.tokens, window: this.ctx.window || defaultWindow() } : null; }

  // ---- sessions: one log per conversation; earlier ones stay listed and can be continued ----
  get sessionsFile() { return join(CHAT_DIR, `${this.id}.sessions.json`); }
  readSessions() { try { const j = JSON.parse(readFileSync(this.sessionsFile, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } }
  writeSessions(list) { writeFileSync(this.sessionsFile, JSON.stringify(list.slice(0, 200), null, 1)); }
  summarize(hist) {
    const users = hist.filter((e) => e.t === 'user');
    return { title: sessionTitle(hist), started: hist[0]?.ts || null, last: hist.at(-1)?.ts || null, messages: users.length };
  }
  sessions() {
    return { current: { ...this.summarize(this.history()), context: this.contextEvent() }, earlier: this.readSessions(), busy: this.busy };
  }
  // Put the current conversation in the list (if it has anything in it) and clear the way for another.
  archive() {
    const hist = this.history();
    if (hist.some((e) => e.t === 'user')) {
      const log = `${this.id}--${Date.now()}.jsonl`;
      renameSync(this.log, join(CHAT_DIR, log));
      const st = state().projects[this.id] || {};
      const engine = st.engine || this.engine;
      this.writeSessions([{ log, engine, model: st.model || null, ...(engine === 'claude' ? { source: st.source || 'plan' } : {}), sessionId: st.sessionId || null, contextHash: st.contextHash || null, context: this.ctx || null, ...this.summarize(hist) }, ...this.readSessions()]);
    } else if (existsSync(this.log)) writeFileSync(this.log, '');
  }
  newSession() {
    if (this.busy) throw new Error('Claude is working: stop it or wait, then start a new session.');
    this.kill();
    this.archive();
    this.ctx = null;
    this.always.clear();
    setProjectState(this.id, { sessionId: null, model: null, context: null, contextHash: null });
    logUse('session.new', this.usageScope());
    this.replay();
  }
  openSession(log) {
    if (this.busy) throw new Error('Claude is working: stop it or wait first.');
    const list = this.readSessions(), e = list.find((x) => x.log === log);
    if (e && (e.engine || 'claude') !== this.engine) throw new Error(`That session was with ${ENGINES[e.engine || 'claude'] || e.engine}: switch to it in Settings → Agent & model to continue it.`);
    if (e && this.engine === 'claude' && (e.source || 'plan') !== ccSource().id) throw new Error(`That session ran on ${CC_SOURCES[e.source || 'plan']?.short || e.source}: pick that model source in Settings → Agent & model to continue it.`);
    if (!e || !existsSync(join(CHAT_DIR, e.log))) throw new Error('That session is gone.');
    this.kill();
    this.archive();
    renameSync(join(CHAT_DIR, e.log), this.log);
    this.writeSessions(this.readSessions().filter((x) => x.log !== log));
    this.ctx = e.context || null;
    this.always.clear();
    setProjectState(this.id, { sessionId: e.sessionId || null, engine: e.engine || this.engine, model: e.model || null, source: e.source || null, context: this.ctx, contextHash: e.contextHash || null });
    this.replay();
  }
  // Every open panel redraws from the log: a reset, then the conversation as history.
  replay() {
    const out = (ev) => { for (const fn of this.listeners) fn(ev); };
    out({ t: 'reset' });
    for (const ev of forReplay(this.history())) out({ ...ev, replay: true, ...((ev.t === 'permission' || ev.t === 'question') ? { expired: true } : {}) });
    out({ t: 'busy', busy: false });
    const c = this.contextEvent();
    if (c) out(c);
  }
  // Compact: Claude Code summarises the conversation so far and carries on from the summary (it also does this by
  // itself near the limit). Sent as the /compact command, without the project's instructions wrapped around it.
  async compact() {
    if (this.busy) throw new Error('Claude is working: wait for it to finish, then compact.');
    if (!this.history().some((e) => e.t === 'user')) throw new Error('Nothing to compact yet.');
    if (!this.proc) await this.start();
    this.emit({ t: 'note', text: 'Compacting this chat: Claude keeps a summary and frees room.' });
    this.setBusy(true);
    logUse('compact', this.usageScope());
    this.write({ type: 'user', message: { role: 'user', content: '/compact' } });
  }

  setBusy(b) {
    if (this.busy === b) return;
    this.busy = b;
    this.emit({ t: 'busy', busy: b });
  }

  write(obj) {
    if (this.proc?.stdin.writable) this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  // brief: { name, step? } when Video Octopus wrote the message (a step's brief, the change package…): the chat shows it as
  // one compact line ("▶ Clean up") with the text folded away, and names the session after it.
  async send(text, { echo = true, brief = null } = {}) {
    assertNotUpdating();
    activeSkillRoot({ studio: settings().studio });
    this.lastSend = text;
    this.setBusy(true); // startup/auth discovery also counts as work; updates must not interrupt it
    try { if (!this.proc) await this.start(); } catch (e) { this.setBusy(false); throw e; }
    if (echo) this.emit(userEvent(text, brief));
    this.setBusy(true);
    this.write({ type: 'user', message: { role: 'user', content: this.withContextUpdate(text) } });
  }

  // All harnesses use the same current technical availability and creator preferences.
  // Read on demand: edits and deletions are picked up next turn, without a restart.
  currentContext() {
    const studio = settings().studio;
    return [this.context(), skillSelectionBrief({ studio }), skillPreferencesBrief({ studio })].filter(Boolean).join('\n\n');
  }

  // Claude Code keeps a resumed chat's first system prompt (a new --append-system-prompt isn't applied on
  // --resume), so when the project's instructions changed since the chat began (a style picked, new app
  // features), the current ones ride along once with the next message.
  withContextUpdate(raw) {
    // What Video Octopus did meanwhile that Claude should know (Undo put files back), once, ahead of the message.
    const notes = (this.studioNotes || []).splice(0);
    const text = notes.length ? `[Video Octopus: ${notes.join(' ')}]\n\n${raw}` : raw;
    const ctx = this.currentContext(), hash = createHash('sha1').update(ctx).digest('hex').slice(0, 16);
    const seen = state().projects[this.id]?.contextHash;
    if (seen === hash) return text;
    setProjectState(this.id, { contextHash: hash });
    if (!seen && !this.resumed) return text; // a new chat has them as its system prompt
    this.emit({ t: 'note', text: 'Video Octopus sent the assistant the project\'s updated instructions and preferences with this message.' });
    return `[Video Octopus: the app's instructions for this project changed since this chat began. They now read:]\n${ctx}\n[End of the updated instructions.]\n\n${text}`;
  }
  addStudioNote(text) { (this.studioNotes ||= []).push(text); }

  answer(requestId, { allow, message, answers, always }) {
    const req = this.pending.get(requestId);
    if (!req) return false;
    this.pending.delete(requestId);
    const ak = allow && always ? this.alwaysFor(req.request) : null;
    if (ak) this.always.add(ak.key);
    let response;
    if (answers) {
      response = { behavior: 'allow', updatedInput: { ...req.request.input, answers } };
    } else if (allow) {
      response = { behavior: 'allow', updatedInput: req.request.input };
    } else {
      response = { behavior: 'deny', message: message || 'The editor said no to this step.' };
    }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.emit({ t: 'permission_done', id: requestId, outcome: answers ? 'answered' : ak ? 'always' : allow ? 'allowed' : 'denied', always: ak?.label });
    return true;
  }

  stop() {
    if (!this.proc || !this.busy) return false;
    this.stopping = true;
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
    return true;
  }

  // New permission mode or model: end the process; the next message reopens the same chat with it.
  restart() {
    if (this.proc && !this.busy) { const p = this.proc; this.proc = null; p.kill(); }
  }

  kill() { if (this.proc) { const p = this.proc; this.proc = null; p.kill(); } }

  openRequests() {
    return [...this.pending.keys()];
  }
}

const OUTSIDE_HOOK = join(APP_DIR, 'server', 'outside-hook.mjs');
// Add settings to Claude Code's arguments: into the --settings a model source already passes (claude-source.mjs), else
// as its own (only one --settings counts).
function withSettings(args, extra) {
  const i = args.indexOf('--settings');
  if (i < 0) { args.push('--settings', JSON.stringify(extra)); return; }
  let cur = {};
  try { cur = JSON.parse(args[i + 1]); } catch {}
  args[i + 1] = JSON.stringify({ ...cur, ...extra, hooks: { ...(cur.hooks || {}), ...(extra.hooks || {}) } });
}

// A user message in the log. Video Octopus's own messages (a step's brief, the change package…) carry brief {name, step?}: the
// chat shows them as one line, "▶ Clean up", with what Video Octopus asked folded away.
export function userEvent(text, brief) {
  const b = brief?.name ? { name: String(brief.name).slice(0, 60), ...(brief.step ? { step: String(brief.step) } : {}) } : null;
  return { t: 'user', text, ...(b ? { brief: b } : {}) };
}
// The brief a user message in a log is, if Video Octopus wrote it. Older logs have no brief on it, but a step's brief always
// came right after the step's start marker ("Clean up · started 14:32"), and Video Octopus's other messages start the same way.
const OLD_BRIEFS = [[/^Here is my change package for this video from Video Octopus:/, 'Save changes → Claude'], [/^Write the post kit for this /, 'Write the post', 'post-kit'],
  [/^Make a new background for this project's canvas, in code:/, 'Generate a background'], [/^Make the elements of \S+ movable in Video Octopus\./, 'Set up the scene kit']];
export function briefOf(hist, i) {
  const e = hist[i];
  if (e?.t !== 'user') return null;
  if (e.brief?.name) return e.brief;
  const m = hist[i - 1];
  if (m?.t === 'marker' && !m.done && m.text && Math.abs((e.ts || 0) - (m.ts || 0)) < 2000) return { name: m.text };
  const o = OLD_BRIEFS.find(([re]) => re.test(String(e.text || '')));
  return o ? { name: o[1], ...(o[2] ? { step: o[2] } : {}) } : null;
}
// A saved log as the page draws it: Video Octopus's messages carry their brief (an older log's start marker folds into the
// brief that follows it, which takes the marker's time).
export function forReplay(hist) {
  const out = [];
  for (let i = 0; i < hist.length; i++) {
    const e = hist[i], next = hist[i + 1];
    if (e.t === 'marker' && !e.done && next?.t === 'user' && !next.brief && briefOf(hist, i + 1)?.name === e.text) continue;
    if (e.t === 'user' && !e.brief) {
      const b = briefOf(hist, i), m = hist[i - 1];
      if (b) { out.push({ ...e, brief: b, ...(m?.t === 'marker' && !m.done && m.text === b.name ? { ts: m.ts } : {}) }); continue; }
    }
    out.push(e);
  }
  return out;
}
// A session is named after its first message: the step's name for a brief, else what the creator wrote (a slash
// command only when there's nothing else).
// What a stopped reply had finished: up to its last sentence end or paragraph break ('' when it had none, "You").
export function wholeSentences(text) {
  const t = String(text || '').trimEnd();
  if (/[.!?…:)\]"”’`]$/.test(t)) return t;
  let cut = -1;
  for (const m of t.matchAll(/(?<=[\p{L})"”’])[.!?…](["”’)\]]*)(?=\s)|\n/gu)) cut = m.index + m[0].length;
  return cut > 0 ? t.slice(0, cut).trimEnd() : '';
}

// A session that ran several steps says where it got to: "Clean up → Write the post" (its first and its latest step).
export function sessionTitle(hist) {
  const one = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  for (let i = 0; i < hist.length; i++) {
    if (hist[i].t !== 'user') continue;
    const b = briefOf(hist, i);
    if (b) {
      let last = b.name;
      for (let k = i + 1; k < hist.length; k++) { const x = hist[k].t === 'user' ? briefOf(hist, k) : null; if (x?.name) last = x.name; }
      return last !== b.name ? `${b.name} → ${last}` : b.name;
    }
    if (!String(hist[i].text || '').startsWith('/')) return one(hist[i].text);
  }
  const u = hist.find((e) => e.t === 'user');
  return u ? one(u.text) : 'Empty chat';
}

function toolSummary(name, input = {}) {
  const short = (s, n = 90) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const file = (p) => String(p || '').split('/').slice(-2).join('/');
  switch (name) {
    case 'Bash': return short(input.description || input.command);
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return file(input.file_path || input.notebook_path);
    case 'Skill': return short(input.skill || input.command);
    case 'Grep': case 'Glob': return short(input.pattern);
    case 'WebSearch': return short(input.query);
    case 'WebFetch': return short(input.url);
    case 'Task': case 'Agent': return short(input.description || input.prompt);
    default: return short(Object.values(input).find((v) => typeof v === 'string') || '');
  }
}

function permissionDetail(name, input = {}) {
  if (name === 'Bash') return String(input.command || '').slice(0, 2000);
  if (name === 'Write') return `${input.file_path}\n\n${String(input.content || '').slice(0, 1200)}`;
  if (name === 'Edit') return `${input.file_path}\n\n- ${String(input.old_string || '').slice(0, 600)}\n+ ${String(input.new_string || '').slice(0, 600)}`;
  return JSON.stringify(input, null, 1).slice(0, 1500);
}

// A stand-in for Claude Code in Video Octopus's chat test (test/chat.e2e.mjs). It speaks Claude Code's stream-json both ways,
// runs the PreToolUse hooks Video Octopus passes in --settings the way Claude Code does (so Video Octopus's own outside-the-project
// check really runs), asks permission over stdio as Claude Code does (manual mode: commands and file changes; auto: only
// what a hook asks about), and plays a few scripted turns chosen by words in the message. It never calls a model.
//   FAKE_CLAUDE_LOG=<file>: one JSON line per start and per tool call (what was asked, what Video Octopus answered).
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (argv[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })); process.exit(0); }
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const sys = arg('--append-system-prompt') || '';
const mode = arg('--permission-mode') || 'manual';
const settings = (() => { try { return JSON.parse(arg('--settings') || '{}'); } catch { return {}; } })();
const cwd = process.cwd();
const projectRel = /Project folder: (\S+) \(/.exec(sys)?.[1] || null;
const project = projectRel ? join(cwd, projectRel) : null;
const APP = /node "([^"]+)[\\/]bin[\\/]studio\.mjs"/.exec(sys)?.[1] || resolve(dirname(new URL(import.meta.url).pathname), '..');
const log = (o) => { if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ at: Date.now(), ...o }) + '\n'); };
log({ start: true, mode, hooks: Boolean(settings.hooks), project: projectRel, resume: arg('--resume') });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const session = arg('--resume') || randomUUID();
const waiting = new Map();
let inited = false;

function ask(tool, input, reason) {
  const id = randomUUID();
  out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, display_name: tool, input, description: input.description || '', ...(reason ? { decision_reason: reason } : {}) } });
  return new Promise((r) => waiting.set(id, r));
}
// Claude Code's PreToolUse hooks: each matching command gets the call as JSON on stdin; "ask" means a permission prompt.
async function hookSays(tool, input) {
  for (const entry of settings.hooks?.PreToolUse || []) {
    if (entry.matcher && !new RegExp(`^(${entry.matcher})$`).test(tool)) continue;
    for (const hk of entry.hooks || []) {
      const said = await new Promise((done) => {
        const p = spawn(hk.command, { shell: true, cwd, env: process.env });
        let o = '';
        p.stdout.on('data', (d) => { o += d; });
        p.on('close', () => done(o));
        p.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd, session_id: session }));
      });
      try { const j = JSON.parse(said); if (j.hookSpecificOutput?.permissionDecision === 'ask') return j.hookSpecificOutput.permissionDecisionReason || 'ask'; } catch {}
    }
  }
  return null;
}
async function tool(name, input, effect = () => 'ok') {
  const id = `toolu_${randomUUID().slice(0, 12)}`;
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const reason = await hookSays(name, input);
  const asks = reason || mode === 'manual' || (mode === 'acceptEdits' && name === 'Bash');
  const behavior = asks ? (await ask(name, input, reason)).behavior : 'allow';
  log({ tool: name, input, reason, asked: Boolean(asks), behavior });
  const ok = behavior === 'allow';
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: ok ? String(effect() ?? 'ok') : 'The user said no.', is_error: !ok } ] } });
  return ok;
}
const say = (text) => out({ type: 'assistant', message: { content: [{ type: 'text', text }], usage: { input_tokens: 1200, output_tokens: 40 } } });

async function turn(text) {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-fake-1' }); }
  out({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.31 }, seven_day: { utilization: 0.12 } } } });
  const t0 = Date.now();
  const P = (rel) => join(project || cwd, rel);
  if (/Prepare this recording/.test(text)) {
    // Clean up's result appears early (joins.json), then Claude keeps going for a while before its turn ends.
    mkdirSync(P('work'), { recursive: true });
    await tool('Write', { file_path: P('work/joins.json') }, () => { writeFileSync(P('work/joins.json'), JSON.stringify({ summary: { joins: 2, likely_clipped: 0, check: 1 }, joins: [] })); return 'written'; });
    say('The cuts and the join check are written. Checking the last join by ear now.');
    await sleep(Number(process.env.FAKE_CLAUDE_LINGER || 3000));
    say('Clean up is done: 2 cuts made and 2 joins checked; one join is worth a listen.');
  } else if (/^Lock the cut/m.test(text)) {
    await sleep(600);
    say('I haven\'t locked the cut yet, because one join still sounds clipped at 0:42.1. Should I move that edge for you?\n\nThe rest of the joins are clean.');
  } else if (/MOVE-BLOCKS/.test(text)) {
    await tool('Edit', { file_path: P('work/blocks.json'), old_string: '"label": "Intro"', new_string: '"label": "Opening"' }, () => {
      const f = P('work/blocks.json'); writeFileSync(f, readFileSync(f, 'utf8').replace('"label": "Intro"', '"label": "Opening"')); return 'edited';
    });
    say('I renamed the Intro section to Opening in work/blocks.json.');
  } else if (/PROPOSE-LOOKS/.test(text)) {
    // Proposals, as the project instructions ask: a shot and two zooms, by claude, status proposed.
    await tool('Write', { file_path: P('work/shots.json') }, () => {
      writeFileSync(P('work/shots.json'), JSON.stringify({ v: 1, shots: [{ id: 's1', start: 0 }, { id: 'c1', start: 1.5, name: 'Demo', look: { preset: 'screen' }, in: { type: 'slide', dir: 'left', dur: 0.5 }, by: 'claude', status: 'proposed' }] }));
      return 'written';
    });
    await tool('Write', { file_path: P('work/zooms.json') }, () => {
      writeFileSync(P('work/zooms.json'), JSON.stringify({ v: 2, items: [{ target: 'screen', a: 0.3, b: 0.8, c: 1.0, d: 1.4, box: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, by: 'claude', status: 'proposed' },
        { target: 'camera', a: 1.6, b: 2.0, c: 2.4, d: 2.8, amount: 1.1, by: 'claude', status: 'proposed' }] }));
      return 'written';
    });
    say('Shots · 1 shot added, 2 zooms added. They wait dashed on the timeline: Keep it or No thanks on each.');
  } else if (/WRITE-OUTSIDE/.test(text)) {
    const ok = await tool('Bash', { command: `cd ${projectRel} && echo "- a line from the test project" >> ../../notes/log.md`, description: 'Log this use in the studio notes' }, () => {
      mkdirSync(join(cwd, 'notes'), { recursive: true }); appendFileSync(join(cwd, 'notes', 'log.md'), '- a line from the test project\n'); return '';
    });
    say(ok ? 'I logged it in notes/log.md (outside this project, as the studio\'s instructions ask).' : 'Fine, I left the notes alone.');
  } else if (/which project/i.test(text)) {
    await tool('Bash', { command: `node "${APP}/bin/octopus.mjs" projects list; ls -t sessions; ls -td projects/*/`, description: 'List projects and the newest sessions' });
    await tool('Bash', { command: `cat "${APP}/README.md" | head -5 && grep -c Video Octopus "${APP}/README.md"`, description: 'Read the README' });
    const set = await tool('Bash', { command: `node "${APP}/bin/octopus.mjs" settings set editing.trimLens on`, description: 'Turn on the trim lens' });
    say(set ? 'You edited Chat e2e last, and the trim lens is on now.' : 'You edited Chat e2e last. I left the trim lens as it was.');
  } else if (/LONG-REPLY-(\d+)/.test(text)) {
    const n = Number(/LONG-REPLY-(\d+)/.exec(text)[1]);
    for (let i = 1; i <= n; i++) {
      await sleep(250);
      say(`Part ${i} of ${n}. ${'This line is long enough to fill some of the chat column with words, so the list grows. '.repeat(3)}`);
    }
  } else {
    await sleep(200);
    say('OK.');
  }
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - t0, modelUsage: { 'claude-fake-1': { contextWindow: 200000 } } });
}

// Turns one at a time, in the order they came; permission answers whenever they come.
let queue = Promise.resolve(), buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'control_response') { const r = j.response?.response || {}; waiting.get(j.response?.request_id)?.(r); waiting.delete(j.response?.request_id); }
    else if (j.type === 'user') {
      const c = j.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('\n') : '';
      log({ user: text.slice(0, 200) });
      queue = queue.then(() => turn(text)).catch((e) => log({ error: e.message }));
    }
  }
});
process.stdin.on('end', () => queue.then(() => process.exit(0)));

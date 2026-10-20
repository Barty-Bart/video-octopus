// CI-only provider checks. Run sequentially while the app uses disposable settings.
// No agent prompt, login, install, model download, inference or real MCP request.
// STUDIO_LOCAL_DIR must match the environment of the already-running app.
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const agentIds = ['claude', 'codex', 'lmstudio', 'ollama', 'pi'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rows = (scan) => (scan.agents || []).map((a) => ({
  id: a.id, state: a.state, problem: a.problem || null,
  local: Boolean(a.local), modelCount: (a.models || []).length,
  messagesApi: Boolean(a.messagesApi), via: a.via || [],
}));
const connection = (c) => c ? {
  id: c.id, via: c.via || null, model: c.model || null,
} : null;
const message = (e) => String(e?.message || e).slice(0, 500);

export async function checkProviders({ repo, baseUrl, evidenceDir, record }) {
  const origin = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
      || origin.username || origin.password) {
    await record('providers: loopback target', 'blocked',
      'Provider checks only support an unauthenticated loopback test app.');
    return;
  }
  await mkdir(evidenceDir, { recursive: true });
  const save = (name, data) => writeFile(join(evidenceDir, name),
    JSON.stringify(data, null, 2) + '\n');
  const api = async (path, body) => {
    const response = await fetch(new URL(path, origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : {
        'Content-Type': 'application/json', 'X-Studio': '1',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json };
  };
  const scan = async () => {
    const r = await api('/api/app/scan/agents');
    if (r.status !== 200 || !Array.isArray(r.json.agents))
      throw new Error(`Agent scan returned HTTP ${r.status} or no agent list.`);
    return r.json;
  };
  let baseline;
  try {
    baseline = await scan();
    const view = { kind: 'actual fresh-runner discovery; no mocks yet',
      platform: process.platform, agents: rows(baseline),
      connected: connection(baseline.connected), engine: baseline.engine };
    await save('provider-baseline.json', view);
    await record('providers: fresh-runner baseline',
      same(baseline.agents.map((a) => a.id), agentIds) ? 'pass' : 'fail', view);
    for (const a of baseline.agents.filter((a) => ['claude', 'codex', 'pi'].includes(a.id))) {
      await record(`providers: actual ${a.id} availability`, 'info', {
        state: a.state, usableInferenceVerified: false,
        note: a.state === 'ok'
          ? 'Discovery reports ready; no authenticated inference tested.'
          : 'This runner has not demonstrated a usable agent; no install or login attempted.',
      });
    }
  } catch (e) {
    await record('providers: fresh-runner baseline', 'fail', message(e));
    return;
  }

  // Do not guess the live server's settings path or mutate a developer install.
  if (process.env.CI !== 'true' || !process.env.STUDIO_LOCAL_DIR) {
    await record('providers: isolated settings required', 'blocked',
      'Set CI=true and STUDIO_LOCAL_DIR to the running app’s disposable settings directory.');
    return;
  }
  const settingsPath = join(resolve(process.env.STUDIO_LOCAL_DIR), 'settings.json');
  let original;
  try { original = await readFile(settingsPath); }
  catch (e) {
    if (e.code !== 'ENOENT') {
      await record('providers: read isolated settings', 'blocked', message(e));
      return;
    }
    original = null;
  }
  let saved;
  try { saved = original ? JSON.parse(original.toString('utf8')) : {}; }
  catch {
    await record('providers: settings baseline', 'fail', 'Settings JSON is invalid; left untouched.');
    return;
  }
  const requests = [];
  let scenario = 'ready';
  const fixture = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    requests.push({ method: req.method, path, scenario });
    res.setHeader('Content-Type', 'application/json');
    let body;
    if (req.method === 'GET' && path === '/lm/api/v1/models') {
      body = { models: scenario === 'empty' ? [] : [{
        type: 'llm', key: 'fixture-lm', display_name: 'Mock metadata model',
        max_context_length: 65536,
        loaded_instances: [{ config: { context_length: scenario === 'small' ? 4096 : 32768 } }],
        capabilities: { trained_for_tool_use: true, vision: false },
      }] };
    } else if (req.method === 'GET' && path === '/oll/api/version') {
      body = { version: scenario === 'old' ? '0.13.0' : '0.14.0' };
    } else if (req.method === 'GET' && path === '/oll/api/tags') {
      body = { models: scenario === 'empty' ? [] : [{
        name: 'fixture-oll:latest', details: { parameter_size: 'fixture' },
      }] };
    } else if (req.method === 'GET' && path === '/oll/api/ps') {
      body = { models: [{ name: 'fixture-oll:latest',
        context_length: scenario === 'small' ? 4096 : 32768 }] };
    } else {
      res.statusCode = 405;
      body = { error: 'Metadata fixture only; generation and all other calls are forbidden.' };
    }
    res.end(JSON.stringify(body));
  });
  let listening = false;
  try {
    // Confirmation must fail before any setting is changed.
    const denied = await api('/api/app/scan/connect', { agent: 'pi' });
    const afterDenied = await readFile(settingsPath).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    const unchanged = original === null ? afterDenied === null
      : afterDenied !== null && original.equals(afterDenied);
    await record('providers: missing confirmation rejected',
      denied.status === 400 && /yes|confirm/i.test(denied.json.error || '') && unchanged
        ? 'pass' : 'fail', { http: denied.status, settingsUnchanged: unchanged });
    if (!unchanged) throw new Error('Unconfirmed connect changed settings; fixtures aborted.');

    await new Promise((done, fail) => {
      fixture.once('error', fail);
      fixture.listen(0, '127.0.0.1', done);
    });
    listening = true;
    const mockUrl = `http://127.0.0.1:${fixture.address().port}`;
    await mkdir(resolve(process.env.STUDIO_LOCAL_DIR), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({
      ...saved, lmstudioUrl: `${mockUrl}/lm`, ollamaUrl: `${mockUrl}/oll`,
    }, null, 2) + '\n');
    const fixtureResults = [];
    for (const [name, expected] of [
      ['ready', { lmstudio: 'ok', ollama: 'ok' }],
      ['small', { lmstudio: 'context', ollama: 'context' }],
      ['empty', { lmstudio: 'nomodel', ollama: 'nomodel' }],
      ['old', { lmstudio: 'ok', ollama: 'old' }],
    ]) {
      scenario = name;
      const actual = await scan();
      const local = actual.agents.filter((a) => a.local);
      const ok = Object.entries(expected).every(([id, want]) => {
        const a = local.find((a) => a.id === id);
        return want === 'ok' ? a?.state === 'ok' : a?.problem === want;
      });
      const result = { kind: 'localhost metadata mock', scenario: name,
        agents: rows({ agents: local }), expected, inferenceTested: false };
      fixtureResults.push(result);
      await record(`providers: mock metadata ${name}`, ok ? 'pass' : 'fail', result);
    }
    scenario = 'ready';
    for (const [agent, via, model] of [
      ['lmstudio', 'claude', 'fixture-lm'],
      ['ollama', 'codex', 'fixture-oll:latest'],
    ]) {
      const r = await api('/api/app/scan/connect', { agent, via, model, confirmed: true });
      const current = JSON.parse(await readFile(settingsPath, 'utf8'));
      const c = current.claude || {};
      const routed = via === 'claude'
        ? c.engine === 'claude' && c.ccSource === agent && c.ccModel === model
        : c.engine === 'codex' && c.codexProvider === agent && c.codexModel === model;
      await record(`providers: mock ${agent} selection via ${via}`,
        r.status === 200 && routed && r.json.connected?.id === agent ? 'pass' : 'fail', {
          kind: 'settings-routing check only', http: r.status,
          selected: connection(r.json.connected), settingsMatch: routed,
          agentStarted: false, inferenceTested: false,
        });
    }
    const allowedPaths = new Set(['/lm/api/v1/models', '/oll/api/version', '/oll/api/tags', '/oll/api/ps']);
    const unexpected = requests.filter((r) => r.method !== 'GET' || !allowedPaths.has(r.path));
    await record('providers: fixtures received metadata only',
      unexpected.length ? 'fail' : 'pass', { count: requests.length, unexpected });
    await save('provider-metadata-fixtures.json', {
      repo: resolve(repo), fixtureResults, requests,
      limitations: 'Mocks validate discovery and selection logic, not CLI installation, login, inference, tool use, image input or MCP.',
    });
  } catch (e) {
    await record('providers: fixture checks', 'fail', message(e));
  } finally {
    try {
      if (original) await writeFile(settingsPath, original);
      else await rm(settingsPath, { force: true });
      const restored = await readFile(settingsPath).catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      const ok = original ? restored !== null && original.equals(restored) : restored === null;
      await record('providers: original settings restored', ok ? 'pass' : 'fail',
        { exactBytesRestored: ok });
    } catch (e) {
      await record('providers: original settings restored', 'fail', message(e));
    }
    if (listening) await new Promise((done) => {
      fixture.close(done);
      fixture.closeAllConnections();
    });
  }
}

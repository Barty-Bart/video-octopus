import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverPython, scanPython, describeEnvironment, probePython } from '../server/python-environments.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'octopus-python-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const py = p => { const file = join(home, p); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, ''); return file; };
  return { home, py, options: { home, path: '', env: {}, platform: 'linux' } };
}
test('discovers managed and chosen environments without crawling unrelated projects', t => {
  const { home, py, options } = fixture(t);
  const global = py('.local/bin/python3'), managed = py('.venvs/edit/bin/python'), project = py('Movies/work/.venv/bin/python');
  const normal = discoverPython(options).candidates.map(x => x.path);
  assert(normal.includes(global)); assert(normal.includes(managed)); assert(!normal.includes(project));
  assert(discoverPython({ ...options, extra: join(home, 'Movies/work') }).candidates.some(x => x.path === project));
  assert.throws(() => discoverPython({ ...options, extra: 'relative-folder' }), /absolute/);
});
test('preserves separate venvs sharing one interpreter and deduplicates bin aliases', { skip: process.platform === 'win32' }, t => {
  const { home, py, options } = fixture(t);
  const base = py('base/python3');
  for (const name of ['one', 'two']) {
    const dir = join(home, '.venvs', name, 'bin'); mkdirSync(dir, { recursive: true });
    symlinkSync(base, join(dir, 'python')); symlinkSync(base, join(dir, 'python3'));
  }
  assert.equal(discoverPython(options).candidates.filter(x => x.path.includes('/.venvs/')).length, 2);
});
test('Windows discovers Scripts venvs and user Python installs', t => {
  const { home, py, options } = fixture(t);
  const a = py('.venvs/edit/Scripts/python.exe'), b = py('AppData/Local/Programs/Python/Python312/python.exe');
  const found = discoverPython({ ...options, platform: 'win32' }).candidates.map(x => x.path);
  assert(found.includes(a)); assert(found.includes(b));
});
test('ranks usable packages above bare Python and prefers native MLX', async t => {
  const { py, options } = fixture(t);
  py('.venvs/bare/bin/python'); const best = py('.venvs/video/bin/python');
  const result = await scanPython(options, { arm64: true }, async path => ({ version: '3.12.1', arch: 'arm64', packages: path === best ? { numpy: '2', 'mlx-whisper': '1' } : {} }));
  assert.equal(result.recommended, best); assert.equal(result.environments[0].engine, 'mlx');
  assert.equal(result.environments[0].verified, false);
});
test('failed imports and unsupported Python cannot be called ready', () => {
  const item = { version: '3.12.1', arch: 'arm64', packages: { numpy: '2', 'mlx-whisper': '1', 'faster-whisper': '1', torch: '2', torchvision: '1', transformers: '5', Pillow: '12' } };
  assert.equal(describeEnvironment({ ...item, version: '3.9.6' }, { arm64: true }).transcription, false);
  const checked = describeEnvironment({ ...item, verification: { imports: { numpy: true, 'faster-whisper': true }, sam2: false } }, { arm64: true });
  assert.equal(checked.engine, 'faster-whisper'); assert.equal(checked.objectSeparation, false);
  assert.equal(describeEnvironment({ ...item, verification: { error: 'timeout' } }).transcription, false);
});
test('probe reports unavailable interpreter without leaking subprocess errors', async () => {
  const r = await probePython('/nonexistent/python'); assert.match(r.error, /could not complete/);
});
test('scan bounds candidate count and prioritizes explicit choice', t => {
  const { home, py, options } = fixture(t);
  for (let i = 0; i < 40; i++) py(`.venvs/${i}/bin/python`);
  const chosen = py('chosen/bin/python'); const r = discoverPython({ ...options, extra: join(home, 'chosen') });
  assert.equal(r.candidates.length, 32); assert.equal(r.truncated, true); assert(r.candidates.some(x => x.path === chosen));
});

test('selected Python reaches child tools and agent instructions without changing shell defaults', async t => {
  const { home, py } = fixture(t), executable = py('video-env/bin/python');
  const { execFileSync } = await import('node:child_process');
  const util = new URL('../server/util.mjs', import.meta.url).href;
  const settings = new URL('../server/settings.mjs', import.meta.url).href;
  const script = `import {saveSettings,childPathEnv,python} from ${JSON.stringify(util)};
    import {settingsBrief} from ${JSON.stringify(settings)};
    saveSettings({python:${JSON.stringify(executable)},studio:${JSON.stringify(home)}});
    const env=await childPathEnv();console.log(JSON.stringify({python:python(),selected:env.STUDIO_PYTHON,path:env.PATH,brief:settingsBrief()}));`;
  const value = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home, STUDIO_LOCAL_DIR: join(home, 'local') }, encoding: 'utf8' }));
  assert.equal(value.python, executable); assert.equal(value.selected, executable);
  assert(value.path.startsWith(join(home, 'video-env/bin'))); assert(value.brief.includes(executable));
});

test('a Windows interpreter path reaches the agent brief exactly as it is on disk, on every system', async t => {
  const { home } = fixture(t), executable = 'C:\\Users\\Creator Name\\.venvs\\video\\Scripts\\python.exe';
  const { execFileSync } = await import('node:child_process');
  const util = new URL('../server/util.mjs', import.meta.url).href;
  const settings = new URL('../server/settings.mjs', import.meta.url).href;
  const script = `import {saveSettings} from ${JSON.stringify(util)};
    import {settingsBrief} from ${JSON.stringify(settings)};
    saveSettings({python:${JSON.stringify(executable)},studio:${JSON.stringify(home)}});
    console.log(JSON.stringify(settingsBrief()));`;
  const brief = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home, STUDIO_LOCAL_DIR: join(home, 'local') }, encoding: 'utf8' }));
  assert(brief.includes(`Selected Python: "${executable}".`), brief);
  assert(!brief.includes('\\\\'), 'no doubled backslashes');
});

test('same base interpreter aliases deduplicate by environment prefix after discovery', async t => {
  const { home, py, options } = fixture(t);
  py('.local/bin/python3'); py('.local/share/uv/python/cpython/bin/python');
  const result = await scanPython(options, {}, async () => ({ version: '3.12.1', prefix: join(home, 'same-base'), packages: {} }));
  assert.equal(result.environments.length, 1);
});

test('global Python discovery includes packages installed for the user', async t => {
  const { home } = fixture(t);
  const { execFileSync } = await import('node:child_process');
  let info;
  const executable = process.platform === 'win32' ? 'python' : 'python3';
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  try { info = JSON.parse(execFileSync(executable, ['-E', '-c', 'import sys,site,json; print(json.dumps([sys.executable,site.getusersitepackages(),site.ENABLE_USER_SITE]))'], { env, encoding: 'utf8' })); }
  catch { t.skip('No global Python available for user-site test'); return; }
  if (!info[2] || !info[1].startsWith(home)) { t.skip('Host Python does not expose an isolated user site'); return; }
  mkdirSync(info[1], { recursive: true });
  writeFileSync(join(info[1], 'numpy.py'), '__version__="99.0"');
  const meta = join(info[1], 'numpy-99.0.dist-info'); mkdirSync(meta);
  writeFileSync(join(meta, 'METADATA'), 'Metadata-Version: 2.1\nName: numpy\nVersion: 99.0\n');
  const result = await probePython(info[0], { env });
  assert.equal(result.packages.numpy, '99.0');
});

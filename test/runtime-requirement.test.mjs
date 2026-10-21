// Launch only a disposable sentinel server: no real app, studio, browser, or network access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const app = fileURLToPath(new URL('../', import.meta.url));
const win = process.platform === 'win32';

test('Node requirement is enforced before the launcher can start the app', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'octopus-runtime-'));
  try {
    mkdirSync(join(root, 'server')); mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'home'));
    for (const f of ['start.sh', 'start.cmd', 'server/runtime-check.cjs']) copyFileSync(join(app, f), join(root, f));
    const preload = join(root, 'version-fixture.cjs'), marker = join(root, 'server-started'), opened = join(root, 'browser-opened');
    writeFileSync(preload, 'Object.defineProperty(process.versions, "node", { value: process.env.TEST_NODE_VERSION });\n');
    writeFileSync(join(root, 'server/index.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.TEST_RUNTIME_MARKER, "started"); process.exit(23);\n');
    if (!win) writeFileSync(join(root, 'bin/open'), '#!/bin/sh\nprintf opened > "$TEST_BROWSER_MARKER"\n', { mode: 0o755 });
    const envFor = (version) => ({ ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
      PATH: [join(root, 'bin'), dirname(process.execPath), ...(win ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'])].join(delimiter),
      NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, TEST_NODE_VERSION: version, TEST_RUNTIME_MARKER: marker, TEST_BROWSER_MARKER: opened,
      STUDIO_LOG: '', STUDIO_NO_OPEN: '1' });
    for (const [version, supported] of [['18.20.8', false], ['20.20.0', false], ['21.7.3', false], ['22.0.0', false], ['22.1.0', false], ['22.13.0', true], ['22.20.0', true], ['22.12.0', false], ['23.3.0', false], ['23.4.0', true], [process.versions.node, true]]) {
      await t.test(`preflight and launcher with Node ${version}`, () => {
        rmSync(marker, { force: true }); rmSync(opened, { force: true });
        const env = envFor(version);
        // An old runtime must stop before even scheduling a browser open. The POSIX launcher
        // resolves a harmless local open stand-in; Windows keeps browser opening disabled.
        if (!supported && !win) delete env.STUDIO_NO_OPEN;
        const preflight = spawnSync(process.execPath, ['server/runtime-check.cjs'], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
        assert.ifError(preflight.error);
        assert.equal(preflight.status, supported ? 0 : 1, preflight.stderr);
        assert.equal(existsSync(marker), false);
        if (supported) assert.equal(preflight.stderr, '');
        else assert.match(preflight.stderr, /needs Node\.js 22\.13 or newer \(found /);
        const launch = win
          ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start.cmd'], { cwd: root, env, encoding: 'utf8', timeout: 10000 })
          : spawnSync('/bin/bash', ['start.sh'], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
        assert.ifError(launch.error);
        assert.equal(launch.status, supported ? 23 : 1, launch.stderr || launch.stdout);
        assert.equal(existsSync(marker), supported, 'only a supported runtime may start the sentinel server');
        assert.equal(existsSync(opened), false, 'an unsupported runtime must never open the browser');
        assert.equal(existsSync(join(root, 'local')), false, 'preflight creates no installation or studio state');
      });
    }
    await t.test('npm and both launchers use the same preflight and declared minimum', () => {
      const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
      assert.equal(pkg.engines.node, '>=22.13.0 <23 || >=23.4.0');
      assert.equal(pkg.scripts.start, 'node server/runtime-check.cjs && node server/index.mjs');
      for (const f of ['start.sh', 'start.cmd']) {
        const source = readFileSync(join(app, f), 'utf8');
        assert.match(source, /Node\.js 22\.13 or newer/);
        assert(source.indexOf('runtime-check.cjs') < source.indexOf('STUDIO_SUPERVISED=1'));
      }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

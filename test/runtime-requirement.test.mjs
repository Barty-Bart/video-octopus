// Launch only a disposable sentinel server: no real app, studio, browser, or network access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const app = fileURLToPath(new URL('../', import.meta.url));
const win = process.platform === 'win32';
const require = createRequire(import.meta.url);

test('Node requirement is enforced before the launcher can start the app', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'octopus-runtime-'));
  try {
    mkdirSync(join(root, 'server')); mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'home'));
    for (const f of ['start.sh', 'start.cmd', 'server/runtime-check.cjs']) copyFileSync(join(app, f), join(root, f));
    const preload = join(root, 'version-fixture.cjs'), marker = join(root, 'server-started'), opened = join(root, 'browser-opened');
    // The fixture runtime: its reported version, and (TEST_NO_FTS5=1) a built-in SQLite without full-text search, as
    // on Node 23 and Node 22 before 22.16.
    writeFileSync(preload, [
      'Object.defineProperty(process.versions, "node", { value: process.env.TEST_NODE_VERSION });',
      'if (process.env.TEST_NO_FTS5 === "1") {',
      '  const Module = require("node:module"), load = Module._load;',
      '  Module._load = function (request, ...rest) {',
      '    const real = load.call(this, request, ...rest);',
      '    if (request !== "node:sqlite") return real;',
      '    class DatabaseSync extends real.DatabaseSync {',
      '      exec(sql) { if (/USING fts5/i.test(sql)) throw new Error("no such module: fts5"); return super.exec(sql); }',
      '    }',
      '    return { ...real, DatabaseSync };',
      '  };',
      '}',
    ].join('\n') + '\n');
    writeFileSync(join(root, 'server/index.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.TEST_RUNTIME_MARKER, "started"); process.exit(23);\n');
    if (!win) writeFileSync(join(root, 'bin/open'), '#!/bin/sh\nprintf opened > "$TEST_BROWSER_MARKER"\n', { mode: 0o755 });
    const envFor = (version, extra = {}) => ({ ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
      PATH: [join(root, 'bin'), dirname(process.execPath), ...(win ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'])].join(delimiter),
      NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, TEST_NODE_VERSION: version, TEST_RUNTIME_MARKER: marker, TEST_BROWSER_MARKER: opened,
      STUDIO_LOG: '', STUDIO_NO_OPEN: '1', ...extra });
    const versions = [
      ['18.20.8', false], ['20.20.0', false], ['21.7.3', false], ['22.0.0', false], ['22.12.0', false], ['22.13.0', false],
      ['22.15.1', false], ['22.16.0', true], ['22.20.0', true], ['22.23.4', true], ['23.3.0', false], ['23.4.0', false],
      ['23.11.1', false], ['24.0.0', true], ['24.22.1', true], ['25.2.0', true], ['26.12.1', true], [process.versions.node, true],
    ];
    for (const [version, supported] of versions) {
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
        else assert.match(preflight.stderr, /needs Node\.js 22\.16 or newer on Node 22, or Node\.js 24 or newer \(found /);
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
    await t.test('a Node without SQLite full-text search (FTS5) stops before the app starts, with which Node to install', () => {
      rmSync(marker, { force: true });
      const env = envFor(process.versions.node, { TEST_NO_FTS5: '1' });
      const preflight = spawnSync(process.execPath, ['server/runtime-check.cjs'], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
      assert.ifError(preflight.error);
      assert.equal(preflight.status, 1, preflight.stderr);
      assert.match(preflight.stderr, /needs SQLite full-text search \(FTS5\).*no such module: fts5.*Install Node\.js 24 LTS, or Node\.js 22\.16 or newer/);
      const launch = win
        ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start.cmd'], { cwd: root, env, encoding: 'utf8', timeout: 10000 })
        : spawnSync('/bin/bash', ['start.sh'], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
      assert.ifError(launch.error);
      assert.equal(launch.status, 1, launch.stderr || launch.stdout);
      assert.equal(existsSync(marker), false, 'the app must not start without FTS5');
    });
    await t.test('a supported Node below its line\'s security release only warns', () => {
      const { nodeSecurity, NODE_REQUIREMENT } = require(join(app, 'server/runtime-check.cjs'));
      assert.deepEqual(NODE_REQUIREMENT.patched, { 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' });
      for (const [version, current] of [['22.16.0', false], ['22.23.3', false], ['22.23.4', true], ['22.24.0', true], ['24.21.0', false],
        ['24.22.1', true], ['24.23.0', true], ['25.2.0', true], ['26.12.0', false], ['26.12.1', true]]) {
        const status = nodeSecurity(version);
        assert.equal(status.current, current, version);
        if (current) assert.equal(status.text, '');
        else assert.match(status.text, new RegExp(`Node\\.js ${version.replace(/\./g, '\\.')} is older than ${status.patched.replace(/\./g, '\\.')}.*still runs`));
      }
    });
    await t.test('npm and both launchers use the same preflight and declared minimum', () => {
      const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
      const { NODE_REQUIREMENT } = require(join(app, 'server/runtime-check.cjs'));
      assert.equal(pkg.engines.node, '>=22.16.0 <23 || >=24.0.0');
      assert.equal(pkg.engines.node, NODE_REQUIREMENT.engines, 'package.json engines follows the one threshold constant');
      assert.equal(pkg.scripts.start, 'node server/runtime-check.cjs && node server/index.mjs');
      for (const f of ['start.sh', 'start.cmd']) {
        const source = readFileSync(join(app, f), 'utf8');
        assert.match(source, /Node\.js 22\.16 or newer on Node 22, or Node\.js 24 or newer/);
        assert(source.indexOf('runtime-check.cjs') < source.indexOf('STUDIO_SUPERVISED=1'));
      }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

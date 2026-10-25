// The editor's way back to Projects (beta.22, Bart's report on beta.19: "no way back to the main menu").
// Root cause: a page that failed while loading (Settings while the server restarted, say) never returned its
// teardown, so its <body> classes stayed. `in-home` hides the editor's top bar (`body.in-home .bar`), so the next
// project opened with no logo, no name, no stage bar and nothing that leads home. The router now clears the page
// classes before every page, the editor drops the shell's classes itself, and its bar can't be hidden by them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeRouter, PAGE_CLASSES } from '../web/nav.js';

// Source text with LF endings, so the checks pass on a Windows (CRLF) checkout too.
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n?/g, '\n');

test('a page that fails while loading leaves no page class behind for the next one', async () => {
  const body = new Set();
  const errors = [];
  const pages = {
    // Settings: adds its classes first, then its data request fails (no teardown is ever returned).
    settings: async () => { body.add('in-home'); body.add('in-app-page'); throw new Error('Failed to fetch'); },
    // The editor, as before the fix: it only adds its own class.
    project: async () => { body.add('in-project'); return { teardown: () => body.delete('in-project') }; },
    home: async () => { body.add('in-home'); return { teardown: () => body.delete('in-home') }; },
  };
  let next = 'settings';
  const go = makeRouter((nav) => pages[next](nav), {
    onError: (e) => errors.push(e.message),
    reset: () => PAGE_CLASSES.forEach((c) => body.delete(c)),
  });
  await go();
  assert.deepEqual(errors, ['Failed to fetch']);
  next = 'project';
  await go();
  assert.deepEqual([...body], ['in-project'], 'the editor opens with its own class only: its top bar shows');
  next = 'home';
  await go();
  assert.deepEqual([...body], ['in-home']);
  assert.deepEqual(PAGE_CLASSES.slice().sort(), ['in-app-page', 'in-home', 'in-project']);
});

test('reset runs after the last page is torn down and before the next opens, also for a skipped navigation', async () => {
  const log = [];
  let n = 0;
  const go = makeRouter(async () => { const i = ++n; log.push(`open ${i}`); return { teardown: () => log.push(`teardown ${i}`) }; }, { reset: () => log.push('reset') });
  await go();
  await go();
  assert.deepEqual(log, ['reset', 'open 1', 'teardown 1', 'reset', 'open 2']);
  // Without a reset option the router behaves as before.
  const plain = makeRouter(async () => null);
  await plain();
});

test('the app wires the reset, and the editor owns its classes and its bar', () => {
  const app = src('web/app.js'), css = src('web/style.css'), html = src('web/index.html');
  assert.match(app, /makeRouter\([\s\S]*?\{ reset: \(\) => document\.body\.classList\.remove\(\.\.\.PAGE_CLASSES\) \}\)/);
  const open = app.slice(app.indexOf('async function openProject('));
  assert.match(open.slice(0, 600), /classList\.remove\('in-home', 'in-app-page'\);\s*document\.body\.classList\.add\('in-project'\)/);
  // A left-over shell class can't hide the editor's bar any more.
  assert.doesNotMatch(css, /^body\.in-home \.bar \{ display: none/m);
  assert.match(css, /^body\.in-home:not\(\.in-project\) \.bar \{ display: none; \}/m);
  assert.match(css, /@media \(min-width: 981px\) \{ body\.in-project main \{ height: calc\(100% - 56px\); \} \}/);
  // The way back: the bar's brand is a link to Projects that says so ("‹ Projects"), not the logo alone.
  const brand = /<a class="brand" href="#\/"[^>]*>[\s\S]*?<\/a>/.exec(html.slice(html.indexOf('<header class="bar">')))?.[0] || '';
  assert.match(brand, /aria-label="Video Octopus: back to Projects"/);
  assert.match(brand, /<span class="brand-home"[^>]*>[\s\S]*Projects<\/span>/);
  assert.doesNotMatch(css, /body\.in-project \.bar \.brand \{ font-size: 0/);
  assert.match(css, /body\.in-project \.bar \.brand-home \{ display: inline-flex;/);
});

test('the stage bar folds by the CSS breakpoint, not innerWidth (an overflowing phone page widens innerWidth)', () => {
  const rail = readFileSync(new URL('../web/rail.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(rail, /const narrow = matchMedia\('\(max-width: 760px\)'\)\.matches;/);
  assert.doesNotMatch(rail, /innerWidth <= 760/);
});

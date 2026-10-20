// End-to-end test of Home's New project dialog, in headless Chromium: the newest take no project uses yet is picked
// (not "Record a new take now"), each take says when, how long, how big and which project uses it, and More takes…
// opens every other take in the same scrolling list.
//   STUDIO_URL=http://127.0.0.1:4853 NP_FREE=<take id> NP_USED=<take id> NP_PROJECT=<its project's name> node test/newproject.e2e.mjs
// Video Octopus must run on a throwaway studio with at least six takes (the smoke test makes them). Nothing is created:
// the dialog is closed with Cancel, and the page's chat and step requests are aborted. Prints one line.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = (process.env.STUDIO_URL || 'http://127.0.0.1:4853').replace(/\/$/, '');
const FREE = process.env.NP_FREE, USED = process.env.NP_USED, PROJECT = process.env.NP_PROJECT, IDS = new Set((process.env.NP_IDS || '').split(',').filter(Boolean));
const must = (c, m) => { if (!c) throw new Error(m); };
await fetch(`${BASE}/api/app/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify({ section: 'help', values: { stepsIntro: 'dismissed' } }) }).catch(() => {});
const takes = await (await fetch(`${BASE}/api/takes`)).json();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route('**/*', (route) => {
    const r = route.request(), u = r.url();
    if (r.method() === 'POST' && /\/(chat|step|send|ask|skill|apply-notes|assistant)(\?|\/|$)/.test(u)) return route.abort();
    return route.continue();
  });
  await page.goto(`${BASE}/`);
  await page.click('#newBtn');
  await page.waitForSelector('.dialog.np');
  const checked = await page.$eval('.dialog.np input[name=ptake]:checked', (x) => x.value);
  must(checked === FREE, `picked ${checked}, not the newest unused take ${FREE}`);
  const rowSub = (v) => page.$eval(`.dialog.np input[name=ptake][value="${v}"]`, (x) => x.closest('label').querySelector('small').textContent);
  const usedSub = await rowSub(USED), freeSub = await rowSub(FREE);
  must(/\b\d+:\d\d\b/.test(freeSub) && /not in a project yet/.test(freeSub), `the unused take's line: ${freeSub}`);
  must(usedSub.includes(`“${PROJECT}”`), `the used take's line doesn't name its project: ${usedSub}`);
  const shown = await page.$$eval('.dialog.np .np-takes > label input[name=ptake]', (xs) => xs.map((x) => x.value));
  must(await page.isVisible('#npMore') && !(await page.isVisible('#npAll')), 'no More takes… (or the rest already open)');
  await page.click('#npMore');
  must(await page.isVisible('#npAll') && !(await page.isVisible('#npMore')), 'More takes… did not open the rest');
  const all = await page.$$eval('#npAll input[name=ptake]', (xs) => xs.map((x) => ({ v: x.value, sub: x.closest('label').querySelector('small').textContent })));
  const every = new Set([...shown, ...all.map((x) => x.v)]);
  must(takes.every((t) => every.has(t.id)), `missing takes: ${takes.filter((t) => !every.has(t.id)).map((t) => t.id)}`);
  must(all.every((x) => /(not in a project yet|in “|in a project)/.test(x.sub)) && all.filter((x) => IDS.has(x.v)).every((x) => /\b\d+:\d\d\b/.test(x.sub)), `a take without its length or project: ${JSON.stringify(all)}`);
  await page.click(`#npAll input[value="${all.at(-1).v}"]`);
  must((await page.$eval('.dialog.np input[name=ptake]:checked', (x) => x.value)) === all.at(-1).v, 'an older take could not be picked');
  await page.click('#cancel');
  console.log(`[new project e2e] picked ${FREE} (newest unused), ${shown.length} rows + More takes… ${all.length}, lengths and projects on each`);
} finally { await browser.close(); }

// Skills from GitHub: Setup's "Which motion graphics skills do you want?" and the Skills page's "Add skills from
// GitHub". Video Octopus downloads a public repo as a tarball (codeload.github.com; `git clone --depth 1` when the download
// fails and git is there), finds its skills (folders with a SKILL.md: skills/<name>/, .claude/skills/<name>/ or
// <name>/ at the top) and copies the chosen ones into the studio's .claude/skills/. It never overwrites a skill that
// is already there (it says so instead), writes only plain files and folders (no links, nothing outside the skill's
// folder), and records each install in <studio>/.studio/skills.json (repo, branch, commit, date) for later updates.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { settings, readJSON, writeJSON, inside } from './util.mjs';

// The recommended set, shown without a download (the one-liners follow the repo's README). The repo's
// object-separation skill isn't offered: object separation is a core skill now, in every studio from the starter.
export const RECOMMENDED = {
  repo: 'Barty-Bart/motion-graphics', ref: 'main', url: 'https://github.com/Barty-Bart/motion-graphics', license: 'MIT',
  about: 'Motion-graphics skills for Claude Code and Codex',
  skills: [
    { name: 'motion-broll', about: 'Motion-graphic B-roll from your video and transcript, timed to your words.' },
    { name: 'explainer-default', about: 'A clean 45–90 s product demo: the product’s own UI rebuilt and filmed up close as it’s used.' },
    { name: 'explainer-engaging', about: 'A 10–30 s one-take story: one element travels through the product’s workflow.' },
    { name: 'explainer-high-energy', about: 'A 12–20 s hype promo: beat-locked kinetic type and shape transitions.' },
    { name: 'sound-effects', about: 'A measured sound pass: real effects on the beat, from a bundled CC0 library.' },
  ],
};

// What a motion-graphics skill is good for, for the build steps' note (stepPrompt in studio.mjs).
const MOTION_USE = {
  'motion-broll': 'graphics over the talking head, timed to the words',
  'explainer-default': 'a calm product demo or walkthrough insert',
  'explainer-engaging': 'a short one-take product story',
  'explainer-high-energy': 'a fast promo or launch sting',
  'sound-effects': 'the sound pass once the picture is done',
};

const LIMITS = { download: 150e6, unpacked: 600e6, entries: 30000, skillBytes: 250e6, skillFiles: 6000 };
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const skillsDir = (studio = settings().studio) => join(studio, '.claude', 'skills');

// "owner/repo", "https://github.com/owner/repo", ".../tree/<branch>" or "owner/repo#branch" → { owner, repo, ref }.
export function parseRepo(input) {
  let s = String(input || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  let ref = null;
  const hash = s.indexOf('#');
  if (hash > 0) { ref = s.slice(hash + 1); s = s.slice(0, hash); }
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/|github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})(?:\/tree\/([^?#]+))?$/.exec(s);
  if (!m || m[2] === '.' || m[2] === '..') throw new Error('Give a GitHub repo as owner/name or its github.com link.');
  ref = ref || m[3] || null;
  if (ref && (!/^[\w./-]{1,100}$/.test(ref) || ref.split('/').includes('..'))) throw new Error('That branch name looks wrong.');
  return { owner: m[1], repo: m[2], ref, id: `${m[1]}/${m[2]}` };
}

// ---- tar.gz, read in memory: ustar, pax (x/g) and GNU long names; only files and folders are ever written ----
const str = (b, o, n) => { const s = b.subarray(o, o + n); const z = s.indexOf(0); return (z < 0 ? s : s.subarray(0, z)).toString('utf8'); };
const octal = (b, o, n) => {
  if (b[o] & 0x80) throw new Error('A file in the download is too big.'); // base-256 sizes: far past any skill
  const t = str(b, o, n).replace(/[^0-7]/g, '');
  return t ? parseInt(t, 8) : 0;
};
function pax(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(data.subarray(i, sp).toString(), 10);
    if (!(len > 0)) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

export function readTarGz(buf) {
  const tar = gunzipSync(buf, { maxOutputLength: LIMITS.unpacked });
  const entries = [];
  let off = 0, next = {}, global = {};
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h, 148, 8)) throw new Error('The download is not a valid tar file.');
    const type = h[156];
    const ustar = str(h, 257, 6).startsWith('ustar');
    const size = next.size != null ? Number(next.size) : octal(h, 124, 12);
    if (!Number.isFinite(size) || size < 0 || off + 512 + size > tar.length) throw new Error('The download is cut short.');
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 0x78) { next = { ...next, ...pax(data) }; continue; }             // x: for the next entry
    if (type === 0x67) { global = { ...global, ...pax(data) }; continue; }         // g: for all (GitHub: the commit)
    if (type === 0x4c) { next.path = str(data, 0, data.length); continue; }        // L: GNU long name
    if (type === 0x4b) { next.linkpath = str(data, 0, data.length); continue; }    // K: GNU long link
    const name = next.path ?? (ustar && str(h, 345, 155) ? `${str(h, 345, 155)}/${str(h, 0, 100)}` : str(h, 0, 100));
    const kind = type === 0 || type === 0x30 || type === 0x37 ? (name.endsWith('/') ? 'dir' : 'file') : type === 0x35 ? 'dir'
      : type === 0x32 ? 'symlink' : type === 0x31 ? 'hardlink' : 'other';
    entries.push({ path: name, kind, mode: octal(h, 100, 8), data: kind === 'file' ? data : null });
    next = {};
    if (entries.length > LIMITS.entries) throw new Error('The download has too many files.');
  }
  return { entries, commit: /^[0-9a-f]{40}$/.test(global.comment || '') ? global.comment : null };
}

// A folder (a git clone) as the same entries; links and .git are left out.
export function readDirEntries(root) {
  const entries = [];
  let bytes = 0;
  const walk = (dir, rel) => {
    for (const n of readdirSync(dir)) {
      if (n === '.git') continue;
      const p = join(dir, n), r = rel ? `${rel}/${n}` : n, st = lstatSync(p);
      if (st.isSymbolicLink()) { entries.push({ path: r, kind: 'symlink' }); continue; }
      if (st.isDirectory()) { entries.push({ path: `${r}/`, kind: 'dir' }); walk(p, r); continue; }
      if (!st.isFile()) { entries.push({ path: r, kind: 'other' }); continue; }
      if ((bytes += st.size) > LIMITS.unpacked) throw new Error('The repo is too big.');
      entries.push({ path: r, kind: 'file', mode: st.mode & 0o777, data: readFileSync(p) });
      if (entries.length > LIMITS.entries) throw new Error('The repo has too many files.');
    }
  };
  walk(root, '');
  return { entries, commit: null };
}

// A path from the download as safe parts, or null: no absolute paths, drive letters, backslashes, NULs or "..".
export function safeParts(p) {
  const s = String(p || '');
  if (!s || s.includes('\0') || s.includes('\\') || s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null;
  const parts = s.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.some((x) => x === '..' || x.length > 255)) return null;
  return parts;
}

// Drop the top folder GitHub's tarball wraps everything in (<repo>-<branch>/).
function unwrap(entries) {
  const firsts = new Set(entries.map((e) => String(e.path).split('/')[0]));
  if (firsts.size !== 1) return entries;
  const top = [...firsts][0];
  const wrapped = entries.every((e) => e.path === top || e.path === `${top}/` || e.path.startsWith(`${top}/`)) && entries.some((e) => e.path.startsWith(`${top}/`) && e.path.length > top.length + 1);
  return wrapped ? entries.map((e) => ({ ...e, path: e.path.slice(top.length + 1) })).filter((e) => e.path) : entries;
}

const frontMatter = (text) => {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''))?.[1] || '';
  const field = (k) => {
    const m = new RegExp(`^[ \\t]*${k}:[ \\t]*(.*)$`, 'm').exec(fm);
    if (!m) return '';
    let v = m[1].trim();
    if (/^[>|][+-]?$/.test(v)) { // a folded block: the indented lines under it
      const rest = fm.slice(m.index + m[0].length).split(/\r?\n/);
      v = rest.slice(1).filter((l, i, a) => /^\s+\S/.test(l) && a.slice(0, i).every((x) => /^\s+\S/.test(x))).map((l) => l.trim()).join(' ');
    }
    return v.replace(/^["']|["']$/g, '');
  };
  return { name: field('name'), description: field('description'), stage: field('stage') };
};

// The skills in a download: folders holding a SKILL.md, at most three levels down, not inside another skill.
export function findSkills(entries) {
  const list = unwrap(entries);
  const homes = list.filter((e) => e.kind === 'file').map((e) => ({ e, parts: safeParts(e.path) }))
    .filter((x) => x.parts && x.parts.at(-1) === 'SKILL.md' && x.parts.length >= 2 && x.parts.length <= 4)
    .sort((a, b) => a.parts.length - b.parts.length);
  const skills = [];
  for (const { e, parts } of homes) {
    const folder = parts.slice(0, -1).join('/');
    if (skills.some((s) => folder.startsWith(`${s.folder}/`))) continue;
    const name = parts.at(-2);
    if (!NAME.test(name) || skills.some((s) => s.name === name)) continue;
    const fm = frontMatter(e.data.toString('utf8'));
    skills.push({ name, folder, description: fm.description.split(/(?<=\.)\s/)[0].slice(0, 200), stage: fm.stage });
  }
  return { list, skills: skills.sort((a, b) => a.name.localeCompare(b.name)) };
}

// ---- getting a repo: a test folder of tarballs (STUDIO_SKILLS_FIXTURES), else GitHub, else git ----
const cache = new Map(); // "owner/repo@ref" -> { at, got }
async function download(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120000), headers: { 'User-Agent': 'Video Octopus' } });
  if (r.status === 404) { const e = new Error('GitHub has no such public repo or branch.'); e.notFound = true; throw e; }
  if (!r.ok) throw new Error(`GitHub answered HTTP ${r.status}.`);
  if (Number(r.headers.get('content-length')) > LIMITS.download) throw new Error('That repo is too big to download here.');
  const chunks = [];
  let n = 0;
  for await (const c of r.body) { n += c.length; if (n > LIMITS.download) throw new Error('That repo is too big to download here.'); chunks.push(c); }
  return Buffer.concat(chunks);
}

const run = (bin, args, opts) => new Promise((done, fail) => execFile(bin, args, { timeout: 180000, ...opts }, (err, out, errOut) => (err ? fail(new Error(String(errOut || err.message).trim().split('\n').pop())) : done(out))));
async function gitClone(r) {
  const tmp = mkdtempSync(join(tmpdir(), 'studio-skills-'));
  try {
    await run('git', ['-c', 'protocol.file.allow=never', 'clone', '--depth', '1', '--no-tags', '--single-branch',
      ...(r.ref ? ['--branch', r.ref] : []), `https://github.com/${r.owner}/${r.repo}.git`, join(tmp, 'repo')],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' } });
    return readDirEntries(join(tmp, 'repo'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

export async function fetchRepo(input, { fresh = false } = {}) {
  const r = typeof input === 'string' ? parseRepo(input) : input;
  const key = `${r.id}@${r.ref || 'HEAD'}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 10 * 60e3) return hit.got;
  let got;
  const fixtures = process.env.STUDIO_SKILLS_FIXTURES;
  if (fixtures) {
    const f = join(resolve(fixtures), `${r.owner}__${r.repo}.tar.gz`);
    if (!existsSync(f)) throw new Error('GitHub has no such public repo or branch.');
    got = { ...readTarGz(readFileSync(f)), via: 'fixture' };
  } else {
    const url = `https://codeload.github.com/${r.owner}/${r.repo}/tar.gz/${r.ref ? `refs/heads/${r.ref}` : 'HEAD'}`;
    try { got = { ...readTarGz(await download(url)), via: 'download' }; }
    catch (e) {
      if (e.notFound) throw e;
      try { got = { ...(await gitClone(r)), via: 'git' }; }
      catch (g) { throw new Error(`Couldn't get ${r.id}: ${e.message}${/ENOENT|not found/i.test(g.message) ? '' : ` (git clone: ${g.message})`}`); }
    }
  }
  got = { ...got, ...findSkills(got.entries), repo: r };
  cache.set(key, { at: Date.now(), got });
  return got;
}

// ---- what's in the studio ----
export function installedSkills(studio = settings().studio) {
  let names = [];
  try { names = readdirSync(skillsDir(studio)).filter((n) => !n.startsWith('.')); } catch { return []; }
  return names.flatMap((n) => {
    let text = '';
    try { text = readFileSync(join(skillsDir(studio), n, 'SKILL.md'), 'utf8'); } catch { return []; }
    const fm = frontMatter(text);
    return [{ name: n, description: fm.description, stage: fm.stage }];
  });
}
const has = (studio, name) => { try { lstatSync(join(skillsDir(studio), name)); return true; } catch { return false; } };

// For the Setup step and the Skills page: the repo's skills with "already in your studio" flags.
export async function repoView(input) {
  const studio = settings().studio;
  const r = parseRepo(input || RECOMMENDED.repo);
  const rec = r.id.toLowerCase() === RECOMMENDED.repo.toLowerCase();
  const ref = r.ref || (rec ? RECOMMENDED.ref : null);
  const got = await fetchRepo({ ...r, ref });
  const about = rec ? Object.fromEntries(RECOMMENDED.skills.map((s) => [s.name, s.about])) : {};
  return { repo: r.id, ref, recommended: rec, commit: got.commit, url: `https://github.com/${r.id}`, ...(rec ? { license: RECOMMENDED.license, about: RECOMMENDED.about } : {}),
    skills: got.skills.map((s) => ({ name: s.name, description: about[s.name] || s.description, installed: Boolean(studio) && has(studio, s.name) })) };
}

// The recommended set without downloading anything (Setup draws it straight away).
export function recommendedView() {
  const studio = settings().studio;
  const ok = Boolean(studio) && existsSync(studio);
  return { ...RECOMMENDED, recommended: true, studio: ok, skills: RECOMMENDED.skills.map((s) => ({ ...s, description: s.about, installed: ok && has(studio, s.name) })) };
}

// Copy the chosen skills of a repo into <studio>/.claude/skills. Returns { installed, skipped, missing, refused }.
export async function installSkills(input, names, { studio = settings().studio } = {}) {
  if (!studio || !existsSync(studio)) throw new Error('Create your studio first: skills go into its .claude/skills folder.');
  const r = parseRepo(input || RECOMMENDED.repo);
  const rec = r.id.toLowerCase() === RECOMMENDED.repo.toLowerCase();
  const ref = r.ref || (rec ? RECOMMENDED.ref : null);
  const want = [...new Set((Array.isArray(names) ? names : []).map(String))];
  if (!want.length) throw new Error('Pick at least one skill.');
  const got = await fetchRepo({ ...r, ref });
  const dest = skillsDir(studio);
  mkdirSync(dest, { recursive: true });
  const out = { repo: r.id, ref, commit: got.commit, via: got.via, installed: [], skipped: [], missing: [], refused: 0 };
  const record = readJSON(join(studio, '.studio', 'skills.json'), {}) || {};
  record.skills = record.skills || {};
  for (const name of want) {
    const sk = got.skills.find((s) => s.name === name);
    if (!sk || !NAME.test(name)) { out.missing.push(name); continue; }
    if (has(studio, name)) { out.skipped.push({ name, why: 'already in your studio: kept as it is' }); continue; }
    const tmp = join(dest, `.${name}.installing-${randomBytes(4).toString('hex')}`);
    const prefix = `${sk.folder}/`;
    let files = 0, bytes = 0;
    try {
      mkdirSync(tmp);
      for (const e of got.list) {
        if (!String(e.path).startsWith(prefix)) continue;
        const parts = safeParts(String(e.path).slice(prefix.length));
        if (e.kind !== 'file' && e.kind !== 'dir') { out.refused++; continue; } // links, devices: never written
        if (!parts) { if (String(e.path).slice(prefix.length).replace(/\/$/, '')) out.refused++; continue; }
        const target = join(tmp, ...parts);
        if (!inside(tmp, target)) { out.refused++; continue; }
        if (e.kind === 'dir') { mkdirSync(target, { recursive: true }); continue; }
        if (++files > LIMITS.skillFiles || (bytes += e.data.length) > LIMITS.skillBytes) throw new Error(`${name} is too big to install here.`);
        mkdirSync(join(target, '..'), { recursive: true });
        try { writeFileSync(target, e.data, { flag: 'wx' }); } catch (err) { if (err.code === 'EEXIST') { out.refused++; continue; } throw err; }
        if (e.mode & 0o111) { try { chmodSync(target, 0o755); } catch {} }
      }
      if (!existsSync(join(tmp, 'SKILL.md'))) throw new Error(`${name} has no SKILL.md.`);
      if (has(studio, name)) { rmSync(tmp, { recursive: true, force: true }); out.skipped.push({ name, why: 'already in your studio: kept as it is' }); continue; }
      renameSync(tmp, join(dest, name));
    } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
    record.skills[name] = { repo: r.id, ref: ref || 'default branch', commit: got.commit, files, at: new Date().toISOString() };
    out.installed.push({ name, files });
  }
  if (out.installed.length) writeJSON(join(studio, '.studio', 'skills.json'), record);
  return out;
}

// The note a build step gets (stepPrompt, for steps with "motion" in core/pipelines.json): the studio's
// motion-graphics skills and what each is for, or what to do when there are none yet.
export function motionNote(kind, studio = settings().studio) {
  const all = installedSkills(studio);
  const mine = all.filter((s) => s.name !== 'object-separation' && (MOTION_USE[s.name] || /^(motion|sound)$/i.test(s.stage) || /explainer|motion|b-?roll|sound-effects/i.test(s.name)));
  const studioRel = (p) => relative(studio, p).split('\\').join('/');
  // Object separation is a core skill (the starter's), not a motion-graphics one: one line of its own when it's there.
  const sep = all.some((s) => s.name === 'object-separation')
    ? ' The object-separation skill (core) cuts the speaker or a product out of the background, for text or graphics behind them, a new background or a highlight; plan or use it where a scene needs that.' : '';
  if (mine.length) {
    const list = mine.map((s) => `${s.name} (${MOTION_USE[s.name] || s.description.split(/(?<=\.)\s/)[0].replace(/\.$/, '') || 'motion graphics'})`).join('; ');
    return kind === 'plan'
      ? `\nMotion-graphics skills in this studio (${studioRel(skillsDir(studio))}/): ${list}. Name the one that builds each scene in its "skills" column; leave it empty where a scene is built by hand.${sep}`
      : `\nMotion-graphics skills in this studio (${studioRel(skillsDir(studio))}/): ${list}. Use the one each scene in the production sheet names, or the one that fits, and follow its own steps, with the colours and fonts from BRAND.md (and STYLE.md). Build by hand only what none of them covers.${sep}`;
  }
  return kind === 'plan'
    ? `\nThis studio has no motion-graphics skills yet: plan scenes Claude can build by hand (HTML or canvas scenes, cards, titles, layouts), and mention that motion-graphics skills can be added from Setup or Home → Skills → Add skills from GitHub.${sep}`
    : `\nThis studio has no motion-graphics skills yet. Build the graphics by hand from the production sheet: HTML or canvas scenes drawn as a pure function of time, rendered frame by frame on this computer (a headless browser) and put together with ffmpeg, in the colours and fonts from BRAND.md. Then tell me once that motion-graphics skills can be added from Setup (Motion skills) or Home → Skills → Add skills from GitHub; the recommended set is ${RECOMMENDED.url} (${RECOMMENDED.skills.map((s) => s.name).join(', ')}).${sep}`;
}

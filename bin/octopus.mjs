#!/usr/bin/env node
// studio: act on the running Video Octopus from a terminal, or from the Video Octopus assistant (Claude runs it through Bash, so
// every change still comes back to the creator as an Allow card). It talks to the app's own local API, so the
// pages update as it works. Finds Video Octopus through STUDIO_URL (set in every chat Video Octopus starts) or local/server.json.
//   node bin/octopus.mjs help
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = process.env.STUDIO_LOCAL_DIR ? resolve(process.env.STUDIO_LOCAL_DIR) : join(APP, 'local');
const BASE = (process.env.STUDIO_URL || (() => { try { return JSON.parse(readFileSync(join(LOCAL, 'server.json'), 'utf8')).url; } catch { return 'http://127.0.0.1:4800'; } })()).replace(/\/$/, '');

const HELP = `octopus: act on the running Video Octopus (${BASE})

  octopus projects                         list projects (id, name, type, next step)
  octopus projects new "<name>" [--type tutorial|short|explainer] [--style S]   (type: tutorial when left out)
  octopus projects rename <id> "<name>"    the name Video Octopus shows (the folder keeps its name)
  octopus projects open <id>               print the project's address in Video Octopus
  octopus projects archive <id>            move it aside into <projects>/_archive/ (hidden from Home, nothing deleted)
  octopus projects archived                the archived projects
  octopus projects restore <id>            bring an archived project back
  octopus music <project> calm|bright|warm [--gain dB]   a music bed made on this computer, under the whole video
  octopus music <project> --resource <id> [--gain dB]    the creator's own music from Resources, under the whole video
  octopus music <project> off              take the music away
  octopus settings [section]               show settings (all sections, or one)
  octopus settings set <section>.<key> <value>   e.g. octopus settings set editing.trimLens on
  octopus schedules                        list scheduled runs
  octopus schedules add --name N --cron "0 20 * * 0" [--skill S] [--prompt P]
                       [--scope changed|all|untranscribed|new-takes|studio|project:<id>] [--mode report|ask|change] [--off]
  octopus schedules edit <id> [same options as add]
  octopus schedules run|stop|on|off|delete <id>
  octopus schedules runs <id>              the latest runs and their summaries
  octopus memory search "<query>" --chat <id>   search this chat scope; read-only recall
  octopus library [section]                what's in the library (or one section)
  octopus library sounds                   SQLite sound catalog, status and exact audio paths
  octopus library inbox                    pieces waiting in the Library inbox
  octopus library accept <piece> --kind <section> [--note "..."]
  octopus library aside <piece>            take a piece out of the inbox (kept in inbox/.aside)
  octopus library add <file> --kind <section> [--note "..."]   copy a file from the studio into the library
  studio dashboard [--range week|month|all]
  studio skills                           the studio's skills
  octopus python suggestions               places the assistant reported for Setup's Python environments
  octopus python suggest <path>            report a Python, environment or project folder you found (read-only search):
                                           Setup's next scan shows it; the creator selects it with Use this
  octopus models [whisper|mlx|sam2]        the models Setup knows: where each comes from, which are downloaded
  octopus models download <whisper|mlx|parakeet|sam2> <size>   Setup's own Download (the same one, with its progress there
                                           too), followed to the end. Only after the creator said yes.

  Add --json to any command for the raw answer.`;

// ---- arguments: positional words, --flag value, --flag (true) ----
const argv = process.argv.slice(2), pos = [], opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2), v = argv[i + 1]; if (v == null || v.startsWith('--')) opt[k] = true; else { opt[k] = v; i++; } }
  else pos.push(a);
}
const json = Boolean(opt.json);

async function api(path, data) {
  let r;
  try {
    r = await fetch(BASE + path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify(data) });
  } catch { throw new Error(`Video Octopus isn't answering at ${BASE}. Is it open? (STUDIO_URL sets another address.)`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const out = (x, text) => console.log(json ? JSON.stringify(x, null, 2) : text());
const when = (t) => (t ? new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const table = (rows) => {
  if (!rows.length) return '(none)';
  const w = rows[0].map((_, i) => Math.min(48, Math.max(...rows.map((r) => String(r[i] ?? '').length))));
  return rows.map((r) => r.map((c, i) => String(c ?? '').slice(0, 48).padEnd(w[i])).join('  ').trimEnd()).join('\n');
};
const value = (v) => (v === 'on' || v === 'true' ? true : v === 'off' || v === 'false' ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : /^[[{]/.test(v) ? JSON.parse(v) : v);
const schedFields = () => Object.fromEntries([['name', opt.name], ['cron', opt.cron], ['skill', opt.skill], ['prompt', opt.prompt], ['scope', opt.scope], ['mode', opt.mode]].filter(([, v]) => typeof v === 'string'));

const [area = 'help', verb, ...rest] = pos;
const cmds = {
  // Simple mode's music (no Music button: the project's chat does it): the bed or the creator's file is made or copied
  // under the video (POST /simple-music), placed as one project sound cue at the cut's start, replacing the last one.
  async music() {
    const pid = verb, what = rest[0];
    if (!pid || (!what && typeof opt.resource !== 'string')) throw new Error('octopus music <project> calm|bright|warm|off  (or --resource <id>)');
    const base = `/api/projects/${encodeURIComponent(pid)}`;
    const P = await api(base);
    const cur = P.simpleTools?.music;
    if (cur?.cue) await api(`${base}/sfx`, { op: 'remove', id: cur.cue }).catch(() => {});
    if (what === 'off') { await api(`${base}/simple-tools`, { music: null }); return out({ ok: true }, () => 'No music under the video now.'); }
    const BEDS = { calm: 'Calm pad', bright: 'Bright pulse', warm: 'Warm drone' };
    const gain = Number.isFinite(Number(opt.gain)) ? Number(opt.gain) : -6;
    let made;
    if (typeof opt.resource === 'string') made = await api(`${base}/simple-music`, { resource: opt.resource });
    else if (BEDS[what]) made = { ...(await api(`${base}/simple-music`, { bed: what, seconds: Math.ceil(P.export?.duration || 60) })), label: BEDS[what] };
    else throw new Error('Pick calm, bright or warm, or --resource <id>.');
    const take = await api(`${base}/cut-take`).catch(() => null);
    const at = take?.segments?.[0]?.[0] || 0, label = made.label || made.file.split('/').pop();
    const cue = await api(`${base}/sfx`, { op: 'add', file: made.file, from: 'project', t: at, gain, label: `Music: ${label}` });
    await api(`${base}/simple-tools`, { music: { cue: cue.id, file: made.file, label, gain, ...(BEDS[what] ? { bed: what } : made.resource ? { resource: made.resource } : {}) } });
    return out({ ...made, cue: cue.id }, () => `Music under the video: ${label} (${gain} dB), from ${made.file}.`);
  },
  async memory() {
    if (verb !== 'search' || !rest[0] || typeof opt.chat !== 'string') throw Error('octopus memory search "<query>" --chat <id>');
    const r = await api(`/api/memory/recall?chat=${encodeURIComponent(opt.chat)}&q=${encodeURIComponent(rest.join(' '))}`);
    return out(r, () => JSON.stringify(r, null, 2));
  },
  async projects() {
    if (!verb || verb === 'list') {
      const list = await api('/api/projects');
      return out(list, () => table([['ID', 'NAME', 'TYPE', 'NEXT'], ...list.map((p) => [p.id, p.name, p.type || (p.app ? '' : 'earlier edit'), p.next || ''])]));
    }
    if (verb === 'new') {
      if (!rest[0]) throw new Error('octopus projects new "<name>" [--type T]');
      const r = await api('/api/projects', { name: rest[0], type: typeof opt.type === 'string' ? opt.type : 'tutorial', style: opt.style });
      return out(r, () => `Made ${r.id}. Open it: ${BASE}/#/p/${encodeURIComponent(r.id)}`);
    }
    if (verb === 'rename') {
      if (!rest[0] || !rest[1]) throw new Error('studio projects rename <id> "<name>"');
      const r = await api(`/api/projects/${encodeURIComponent(rest[0])}/rename`, { name: rest[1] });
      return out(r, () => `${r.id} is now called "${r.name}".`);
    }
    if (verb === 'archive') {
      if (!rest[0]) throw new Error('studio projects archive <id>');
      const r = await api(`/api/projects/${encodeURIComponent(rest[0])}/archive`, {});
      return out(r, () => `Archived: moved to ${r.archived}. Nothing was deleted; studio projects restore ${rest[0]} brings it back.`);
    }
    if (verb === 'archived') {
      const r = await api('/api/app/archive', { op: 'list' });
      return out(r, () => (r.archived.length ? r.archived.join('\n') : 'No archived projects.'));
    }
    if (verb === 'restore') {
      if (!rest[0]) throw new Error('studio projects restore <id>');
      const r = await api('/api/app/archive', { op: 'restore', id: rest[0] });
      return out(r, () => `${r.restored} is back on Home.`);
    }
    if (verb === 'open') { if (!rest[0]) throw new Error('studio projects open <id>'); return out({ url: `${BASE}/#/p/${encodeURIComponent(rest[0])}` }, () => `${BASE}/#/p/${encodeURIComponent(rest[0])}`); }
    throw new Error(`Unknown: projects ${verb}. Try studio help.`);
  },
  async settings() {
    if (verb === 'set') {
      const [key, v] = rest, m = /^([\w-]+)\.([\w.-]+)$/.exec(key || '');
      if (!m || v == null) throw new Error('studio settings set <section>.<key> <value>');
      await api('/api/app/settings', { section: m[1], values: { [m[2]]: value(v) } });
      const s = await api('/api/app/settings'), now = s.values?.[m[1]]?.[m[2]];
      if (now === undefined) throw new Error(`No setting "${key}". studio settings ${m[1]} shows what's there.`);
      return out(s.values[m[1]], () => `${key} = ${JSON.stringify(now)}`);
    }
    const s = await api('/api/app/settings');
    const values = s.values || s;
    const pick = verb ? { [verb]: values[verb] } : values;
    if (verb && values[verb] === undefined) throw new Error(`No settings section "${verb}". Sections: ${Object.keys(values).join(', ')}`);
    return out(pick, () => Object.entries(pick).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n'));
  },
  async schedules() {
    if (!verb || verb === 'list') {
      const v = await api('/api/app/schedules');
      return out(v.schedules, () => table([['ID', 'NAME', 'WHEN', 'ON', 'CHANGES', 'NEXT', 'LAST'], ...v.schedules.map((s) => [s.id, s.name, s.when, s.scopeLabel, s.modeLabel, s.enabled ? when(s.next) : 'off', s.last ? `${when(s.last.startedAt)} ${s.last.status}` : 'never'])]));
    }
    if (verb === 'add') {
      const r = await api('/api/app/schedules', { op: 'save', schedule: { ...schedFields(), enabled: !opt.off } });
      const s = r.schedules.find((x) => x.id === r.saved);
      return out(s, () => `Added ${s.id}: "${s.name}", ${s.when} (${s.cron}), ${s.scopeLabel.toLowerCase()}, ${s.modeLabel.toLowerCase()}${s.enabled ? `. Next run ${when(s.next)}.` : '. Off.'}`);
    }
    const id = rest[0];
    if (!id) throw new Error(`studio schedules ${verb} <id>`);
    if (verb === 'edit') {
      const r = await api('/api/app/schedules', { op: 'save', schedule: { id, ...schedFields(), ...(opt.off ? { enabled: false } : opt.on ? { enabled: true } : {}) } });
      const s = r.schedules.find((x) => x.id === id);
      return out(s, () => `Saved ${s.id}: "${s.name}", ${s.when}, ${s.scopeLabel.toLowerCase()}, ${s.modeLabel.toLowerCase()}.`);
    }
    if (verb === 'runs') {
      const { runs } = await api(`/api/app/schedules/runs?id=${encodeURIComponent(id)}`);
      return out(runs, () => runs.map((r) => `${when(r.startedAt)}  ${r.status}${r.inbox?.length ? `  ${r.inbox.length} file(s) in the inbox` : ''}\n  ${(r.summary || '').split('\n').filter((l) => l.trim()).slice(0, 3).join('\n  ')}`).join('\n\n') || '(no runs yet)');
    }
    const ops = { run: { op: 'run' }, stop: { op: 'stop' }, on: { op: 'enable', enabled: true }, off: { op: 'enable', enabled: false }, delete: { op: 'delete' } };
    if (!ops[verb]) throw new Error(`Unknown: schedules ${verb}. Try studio help.`);
    const r = await api('/api/app/schedules', { ...ops[verb], id });
    return out(r, () => ({ run: 'Running now (or queued behind another run).', stop: 'Stopping.', on: 'On.', off: 'Off.', delete: 'Deleted.' })[verb]);
  },
  async library() {
    if(verb==='sounds'){const r=await api('/api/library/sound-catalog');return out(r,()=>JSON.stringify(r,null,2));}
    if (verb === 'inbox') {
      const r = await api('/api/library/inbox');
      return out(r, () => (r.items.length ? r.items.map((i) => `${i.id}\n  ${i.summary || i.files.join(', ')}\n  suggested section: ${i.kind}${i.from ? ` · from ${i.from}` : ''}`).join('\n\n') : 'The inbox is empty.'));
    }
    if (verb === 'accept') {
      if (!rest[0] || typeof opt.kind !== 'string') throw new Error('studio library accept <piece> --kind <section>');
      const r = await api('/api/library/inbox/accept', { id: rest[0], kind: opt.kind, note: typeof opt.note === 'string' ? opt.note : undefined });
      return out(r, () => `Added to the library: ${(r.files || [r.file]).join(', ')}`);
    }
    if (verb === 'add') {
      if (!rest[0] || typeof opt.kind !== 'string') throw new Error('studio library add <file> --kind <section> [--note "..."]');
      const r = await api('/api/library/add', { file: resolve(rest[0]), kind: opt.kind, note: typeof opt.note === 'string' ? opt.note : undefined });
      return out(r, () => `Added to the library: ${r.file}`);
    }
    if (verb === 'aside') {
      if (!rest[0]) throw new Error('studio library aside <piece>');
      const r = await api('/api/library/inbox/aside', { id: rest[0] });
      return out(r, () => `Out of the inbox (kept in ${r.moved}).`);
    }
    const L = await api('/api/library');
    const kinds = verb ? L.kinds.filter((k) => k.key === verb || k.label.toLowerCase() === verb.toLowerCase()) : L.kinds;
    if (verb && !kinds.length) throw new Error(`No section "${verb}". Sections: ${L.kinds.map((k) => k.key).join(', ')}`);
    return out(verb ? kinds[0] : L, () => `${L.dir}\n\n${kinds.map((k) => `${k.label} (${k.key}): ${k.items.length}${k.items.length ? `\n${k.items.slice(0, verb ? 200 : 8).map((i) => `  ${i.name}${i.note ? ` · ${i.note}` : ''}`).join('\n')}${!verb && k.items.length > 8 ? `\n  … ${k.items.length - 8} more` : ''}` : ''}`).join('\n')}`);
  },
  async dashboard() {
    const d = await api(`/api/app/dashboard?range=${['week', 'month', 'all'].includes(opt.range) ? opt.range : 'all'}`);
    const T = d.totals;
    return out(d, () => [
      `Videos finished ${T.finished} · projects ${T.projects} (${T.studio} in Video Octopus) · speech transcribed ${(T.speechSecs / 3600).toFixed(1)} h`,
      `Renders ${T.renders} (${T.rendersInRange} in range) · recordings ${T.recordings} · notes sent to Claude ${T.sent} · scenes approved ${T.approved}`,
      d.features.length ? `Used most: ${d.features.map((f) => `${f.label} ${f.n}`).join(', ')}` : 'Nothing logged yet.',
    ].join('\n'));
  },
  async skills() {
    const list = await api('/api/skills');
    return out(list, () => list.map((s) => `/${s.name}  ${(s.description || '').slice(0, 100)}`).join('\n') || '(no skills)');
  },
  // The models' rows in Setup (Whisper, MLX Whisper, SAM 2.1): their sources and what's downloaded, and Setup's own
  // Download, followed until it's done (so a skill and Setup never fetch the same model twice).
  async models() {
    const FAM = { whisper: 'whisper', 'faster-whisper': 'whisper', mlx: 'mlx', parakeet: 'parakeet', sam2: 'sam2', sam: 'sam2', objsep: 'sam2' };
    if (verb === 'download') {
      const fam = FAM[rest[0]], size = rest[1];
      if (!fam || !size) throw new Error('octopus models download <whisper|mlx|parakeet|sam2> <size>');
      let d = await api(`/api/app/setup/${fam}/download`, { size });
      let last = '';
      while (d.state === 'downloading') {
        const line = d.total ? `${size}: ${Math.floor(d.got / 1e6)} of ${Math.round(d.total / 1e6)} MB` : `${size}: starting`;
        if (!json && line !== last) { console.log(line); last = line; }
        await new Promise((r) => setTimeout(r, 2000));
        d = await api(`/api/app/setup/${fam}`);
      }
      if (d.state !== 'done') throw new Error(d.error || `The download ended: ${d.state}.`);
      return out(d, () => `${size} is downloaded (${Math.round(d.total / 1e6)} MB, in ${d.cache}).`);
    }
    const s = await api('/api/app/settings');
    const wf = s.whisperEngine === 'mlx' ? 'mlx' : 'whisper';
    const rows = [[wf, s.whisperSources], ['sam2', s.sam2?.sources]].filter(([, v]) => v);
    const have = { [wf]: s.downloaded || [], sam2: s.sam2?.have || [] };
    const pick = verb ? rows.filter(([k]) => k === FAM[verb]) : rows;
    return out(Object.fromEntries(pick), () => pick.map(([k, src]) => `${k}:\n${Object.entries(src).map(([id, x]) => `  ${id}${have[k].includes(id) ? ' (downloaded)' : ''}  ${x.line}`).join('\n')}`).join('\n\n'));
  },
  async python() {
    if (verb === 'suggest') {
      if (!rest[0]) throw new Error('octopus python suggest <absolute path>');
      const r = await api('/api/app/setup/environments/suggest', { path: rest[0] });
      return out(r, () => `Reported ${rest[0]}. ${r.next}`);
    }
    const r = await api('/api/app/setup/environments/suggestions');
    return out(r, () => r.suggestions.join('\n') || '(none)');
  },
  async help() { console.log(HELP); },
};

try {
  if (!cmds[area]) { console.log(HELP); process.exitCode = 2; }
  else await cmds[area]();
} catch (e) {
  console.error(`studio: ${e.message}`);
  process.exitCode = 1;
}

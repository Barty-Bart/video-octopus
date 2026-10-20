// Built blocks in the Export panel's "What goes in" (server/built.mjs): a row per block Claude built (the Intro), saying
// whether Export → Video plays its render there or the canvas, with the switch between the two, and the choice the
// export is sent with ({ built: { <block id>: false } } = the canvas). The choice is remembered per project and render.
import { esc } from './ui.js';

const KEY = (id) => `studio.export.built.${id}`;
const read = (id) => { try { return JSON.parse(localStorage.getItem(KEY(id)) || '{}') || {}; } catch { return {}; } };
const write = (id, v) => { try { localStorage.setItem(KEY(id), JSON.stringify(v)); } catch {} };
const name = (f) => String(f || '').replace(/^renders\//, '');
const short = (f, project) => { const n = name(f); return project && n.startsWith(`${project}_`) ? n.slice(project.length + 1) : n; };
const clk = (t) => { t = Math.max(0, t || 0); return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };

export function makeExportBuilt(project) {
  // { <block id>: <render file> } for the renders switched to the canvas: a new render of that block goes in again.
  let canvasFor = read(project);
  const off = (b) => canvasFor[b.id] === b.file;
  return {
    // The rows (dt/dd pairs) for the panel's facts list.
    html(list) {
      return (list || []).map((b) => {
        const file = esc(short(b.file, project)), cues = b.cues ? ` · ${b.cues} sound cue${b.cues > 1 ? 's' : ''} ${b.usable && !off(b) ? 'with it' : 'left out with it'}` : '';
        if (!b.usable) return `<dt>${esc(b.label)}</dt><dd class="plain ex-built">The canvas<div class="sub">${esc(b.stepName)}'s ${file} isn't in: ${esc(b.why)}${cues}</div></dd>`;
        if (off(b)) return `<dt>${esc(b.label)}</dt><dd class="plain ex-built">The canvas<div class="sub">You left out ${esc(b.stepName)}'s ${file}${cues}</div>
          <button type="button" class="btn ghost small" data-built="${esc(b.id)}" data-on="1">Use ${file}</button></dd>`;
        const span = b.sheet ? `${clk(b.sheet[0])}–${clk(b.sheet[1])}` : '';
        return `<dt>${esc(b.label)}</dt><dd class="plain ex-built">From ${esc(b.stepName)}, ${file} <span class="ok" aria-label="ready">✓</span>
          <div class="sub">${span}${b.partial ? ` · ${esc(b.why)}` : ''}${cues}${b.oldLook ? ` · <span class="warn">built before the look change (${esc(b.oldLook)}): Save changes → Claude builds it again</span>` : ''}</div>
          <button type="button" class="btn ghost small" data-built="${esc(b.id)}" data-on="0">Use the canvas instead</button></dd>`;
      }).join('');
    },
    wire(box, list, redraw) {
      box.querySelectorAll('[data-built]').forEach((btn) => (btn.onclick = () => {
        const b = (list || []).find((x) => x.id === btn.dataset.built);
        if (!b) return;
        if (btn.dataset.on === '1') delete canvasFor[b.id]; else canvasFor[b.id] = b.file;
        write(project, canvasFor);
        redraw();
      }));
    },
    // What the export is sent with: the built blocks switched to the canvas.
    choice(list) { return Object.fromEntries((list || []).filter((b) => b.usable && off(b)).map((b) => [b.id, false])); },
    // The sound cues that stay out with them (their graphics aren't in the picture), for the panel's Sound line.
    cuesOut(list) { return (list || []).filter((b) => !b.usable || off(b)).reduce((t, b) => t + (b.cues || 0), 0); },
  };
}

// The Renders tab: renders grouped by what they are (server listRenders' kind/group: a Build step's videos such as
// "Intro builds", "Video exports", other videos). The picked render's own group comes first as its versions.
export function renderGroups(renders, sel) {
  const groups = new Map();
  for (const r of renders) {
    if (r === sel) continue;
    const g = r.group || 'Other videos';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const mine = sel?.group || 'Other videos';
  return [...groups.entries()].sort((a, b) => (a[0] === mine ? -1 : b[0] === mine ? 1 : 0)).map(([g, list]) => ({ group: g, own: g === mine, list }));
}

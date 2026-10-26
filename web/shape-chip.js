// The editor's shape chip in Simple mode (V1 spec §3, Decision 5): "▭ YouTube · 16:9 ▾" in the top bar, in place of
// Advanced's style picker. It opens a small menu under itself (no centred dialog): YouTube video · 16:9 and Reel or
// Short · 9:16. Picking one calls POST /api/project-context/<id>/shape, which re-pins the project to the built-in
// style's format for that shape (server/profiles.mjs switchProjectShape). Until a Build step has run that just happens;
// after one the server answers needsConfirm and the menu asks in place ("Switch anyway"). Audio only has no chip.
import { esc, h, toast } from './ui.js';
import { icon } from './icons.js';
import { SHAPES, SWITCHABLE, shapeOfType } from './simple.js';

async function post(id, body) {
  const r = await fetch(`/api/project-context/${encodeURIComponent(id)}/shape`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 409 && j.needsConfirm) return { needsConfirm: true, error: j.error };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ctx: { id, getP, onChanged(result) }. Returns { el, update(), destroy() }, or null for an Audio only video.
export function makeShapeChip({ id, getP, onChanged }) {
  if (shapeOfType(getP().type) === 'audio') return null;
  const el = h(`<div class="sp shape-chip">
    <button type="button" class="sp-btn shape-btn" aria-haspopup="true" aria-expanded="false"></button>
    <div class="sp-pop shape-pop" role="group" aria-label="Shape of this video" hidden></div>
  </div>`);
  const btn = el.querySelector('.shape-btn'), pop = el.querySelector('.shape-pop');
  let busy = false, asking = null;
  const now = () => shapeOfType(getP().type);
  const paint = () => {
    const s = SHAPES[now()];
    btn.innerHTML = `<span class="sp-orient ${s.key === 'reel' ? 'tall' : 'wide'}" aria-hidden="true"></span><span class="sp-main">${esc(s.chip)}</span><span class="sp-caret">${icon('chevron', 14)}</span>`;
    btn.setAttribute('aria-label', `Shape: ${s.name}, ${s.aspect}. Change the shape`);
    btn.title = 'The shape of this video';
  };
  const drawMenu = () => {
    const cur = now();
    pop.innerHTML = `<p class="sp-hint">${asking ? esc(asking.error) : 'The shape of this video.'}</p>
      ${SWITCHABLE.map((k) => `<button type="button" role="menuitemradio" class="sp-opt" data-shape="${k}" aria-checked="${k === cur}">
        <span class="sp-orient ${k === 'reel' ? 'tall' : 'wide'}" aria-hidden="true"></span><span class="sp-opt-t">${esc(SHAPES[k].name)} · ${esc(SHAPES[k].aspect)}</span>${k === cur ? icon('check', 14) : ''}</button>`).join('')}
      ${asking ? `<div class="shape-ask"><button type="button" class="btn small dark" data-a="yes">Switch to ${esc(SHAPES[asking.shape].name)}</button><button type="button" class="btn small ghost" data-a="no">Keep it</button></div>` : ''}`;
  };
  const outside = (e) => { if (!el.contains(e.target)) close(); };
  function open() {
    asking = null;
    drawMenu();
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    pop.style.left = '';
    const box = pop.getBoundingClientRect();
    const shift = Math.min(0, innerWidth - 8 - box.right) || Math.max(0, 8 - box.left);
    if (shift) pop.style.left = `${shift}px`;
    document.addEventListener('pointerdown', outside, true);
    pop.querySelector('[aria-checked="true"]')?.focus();
  }
  function close(focus = false) {
    if (pop.hidden) return;
    pop.hidden = true;
    asking = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (focus) btn.focus();
  }
  async function choose(shape, confirm = false) {
    if (busy) return;
    if (shape === now()) return close(true);
    busy = true;
    try {
      const r = await post(id, { shape, ...(confirm ? { confirm: true } : {}) });
      if (r.needsConfirm) { asking = { shape, error: r.error }; drawMenu(); pop.querySelector('[data-a=yes]')?.focus(); return; }
      close(true);
      toast(`This video is now a ${SHAPES[shape].name} (${SHAPES[shape].aspect}).`);
      await onChanged?.(r);
    } catch (e) {
      toast(e.message);
    } finally {
      busy = false;
    }
  }
  btn.onclick = () => (pop.hidden ? open() : close());
  pop.addEventListener('click', (e) => {
    const o = e.target.closest('[data-shape]');
    if (o) return choose(o.dataset.shape);
    const a = e.target.closest('[data-a]');
    if (a?.dataset.a === 'yes' && asking) return choose(asking.shape, true);
    if (a?.dataset.a === 'no') close(true);
  });
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
    const list = [...pop.querySelectorAll('button')], i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
  });
  paint();
  return { el, update: paint, destroy: () => close() };
}

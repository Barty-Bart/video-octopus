// Compare with the previous render. The
// version before plays in step with the one you're watching, at the same moment: under a before/after line you drag
// (before on the left, now on the right), or full frame while you hold C in Scenes.
import { h, esc } from './ui.js';

const verOf = (f) => Number(/_v(\d+)\.\w+$/i.exec(f || '')?.[1] ?? NaN);
const stemOf = (f) => String(f || '').replace(/^renders\//, '').replace(/_v\d+\.\w+$/i, '');
export const versionName = (f) => (Number.isFinite(verOf(f)) ? `v${verOf(f)}` : String(f || '').replace(/^renders\//, ''));
// The render before this one: the same name with the next lower version (…_v3 for …_v4), else the next older file.
export function previousOf(list, file) {
  const me = list.find((r) => r.file === file);
  if (!me) return null;
  const v = verOf(file), same = list.filter((r) => r !== me && stemOf(r.file) === stemOf(file) && Number.isFinite(verOf(r.file)) && verOf(r.file) < v);
  if (same.length) return same.sort((a, b) => verOf(b.file) - verOf(a.file))[0];
  return list.filter((r) => r !== me && r.at < me.at && stemOf(r.file) === stemOf(file)).sort((a, b) => b.at - a.at)[0] || null;
}

// box: the element the main video fills (position: relative); main() → that <video>; keep: px left uncovered at the
// bottom (the main video's own controls).
export function makeCompare(box, { main, keep = 0 }) {
  const el = h(`<div class="cmp" hidden><video class="cmp-v" muted preload="auto" playsinline></video>
    <div class="cmp-line" role="slider" tabindex="0" aria-label="Before and after: drag, or use the arrow keys" aria-valuemin="0" aria-valuemax="100"><i></i></div>
    <span class="cmp-tag l"></span><span class="cmp-tag r"></span></div>`);
  box.append(el);
  const v = el.querySelector('video'), line = el.querySelector('.cmp-line');
  let mode = null, split = 0.5, url = null, raf = 0, dead = false;
  function paint() {
    el.hidden = !mode;
    el.classList.toggle('full', mode === 'full');
    v.style.clipPath = mode === 'split' ? `inset(0 ${(100 - split * 100).toFixed(2)}% ${keep}px 0)` : keep ? `inset(0 0 ${keep}px 0)` : '';
    line.style.bottom = `${keep}px`;
    line.style.left = `${(split * 100).toFixed(2)}%`;
    line.setAttribute('aria-valuenow', String(Math.round(split * 100)));
  }
  // Keep the version before at the main video's moment, playing when it plays (until it's off or destroyed).
  function tick() {
    if (dead || !mode) return;
    raf = requestAnimationFrame(tick);
    const m = main();
    if (!m || !v.getAttribute('src') || v.readyState < 1) return;
    const d = Math.abs(v.currentTime - m.currentTime);
    if (m.paused) { if (!v.paused) v.pause(); if (d > 0.02) v.currentTime = m.currentTime; }
    else { if (v.paused) v.play().catch(() => {}); if (d > 0.15) v.currentTime = m.currentTime; if (v.playbackRate !== m.playbackRate) v.playbackRate = m.playbackRate; }
  }
  line.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    try { line.setPointerCapture(e.pointerId); } catch {}
    const at = (ev) => { const r = box.getBoundingClientRect(); split = Math.max(0.02, Math.min(0.98, (ev.clientX - r.left) / r.width)); paint(); };
    const up = () => { line.removeEventListener('pointermove', at); line.removeEventListener('pointerup', up); };
    line.addEventListener('pointermove', at); line.addEventListener('pointerup', up);
  });
  line.addEventListener('click', (e) => e.stopPropagation());
  line.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault(); e.stopPropagation();
    split = Math.max(0.02, Math.min(0.98, split + (e.key === 'ArrowLeft' ? -0.05 : 0.05))); paint();
  });
  return {
    // m: 'split' | 'full' | null; prev: the url of the version before; names: [before, now] for the tags.
    set(m, prev, names = []) {
      mode = m && prev ? m : null;
      if (mode && prev !== url) { url = prev; v.src = prev; v.addEventListener('loadedmetadata', () => { const mm = main(); if (mm) v.currentTime = mm.currentTime; }, { once: true }); }
      el.querySelector('.cmp-tag.l').innerHTML = `${esc(names[0] || 'Before')}<small>before</small>`;
      el.querySelector('.cmp-tag.r').innerHTML = `${esc(names[1] || 'Now')}<small>now</small>`;
      cancelAnimationFrame(raf);
      if (mode && !dead) tick(); else { v.pause(); }
      paint();
    },
    mode: () => mode,
    destroy() { dead = true; cancelAnimationFrame(raf); v.pause(); v.removeAttribute('src'); v.load(); el.remove(); },
  };
}

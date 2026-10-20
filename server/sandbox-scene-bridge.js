// Executed only inside the opaque rendering document, before generated code. No editor/API bridge.
(() => {
  // Opaque documents need anonymous CORS images for canvas pixels to remain readable.
  const NativeImage = window.Image;
  window.Image = class extends NativeImage { constructor(...args) { super(...args); this.crossOrigin = 'anonymous'; } };
  const create = document.createElement.bind(document);
  document.createElement = function (name, ...args) { const el = create(name, ...args); if (['img', 'script'].includes(String(name).toLowerCase())) el.crossOrigin = 'anonymous'; return el; };
  addEventListener('message', async (e) => {
    if (e.source !== parent || parent === window || e.data?.type !== 'studio:seek') return;
    // Supersedes the old kit's same-origin listener without replacing the creator's kit file.
    e.stopImmediatePropagation();
    const m = e.data;
    if (typeof m.req !== 'string' || m.req.length > 100 || !Number.isFinite(m.t)) return;
    let error = null;
    try { await window.ready; await document.fonts?.ready; } catch {}
    const S = window.Octopus;
    if (S) {
      if (m.overrides) S.overrides = m.overrides;
      S.measuring = Boolean(m.measure); S.noKeys = Boolean(m.noKeys); S.hidden = Array.isArray(m.hidden) ? m.hidden : null;
    }
    try { await window.seek(m.t, m.layer == null ? undefined : m.layer); } catch (err) { error = String(err?.message || err); }
    if (S) { S.measuring = false; S.noKeys = false; }
    parent.postMessage({ type: 'studio:drawn', req: m.req, t: m.t, layer: m.layer, scene: S?.scene, hits: S?.hits || [], error,
      layers: S?.layers || [null], kit: S?.kit || 0, size: [document.documentElement.scrollWidth, document.documentElement.scrollHeight] }, '*');
  }, true);
})();

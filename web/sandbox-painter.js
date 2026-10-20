// The app owns this iframe and channel; generated modules only receive frame requests in an opaque realm.
export async function sandboxURL(src, kind) {
  const r = await fetch('/api/sandbox', { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ src, kind }) });
  const result = await r.json();
  if (!r.ok || !result.url) throw new Error(result.error || 'The rendering sandbox could not open.');
  return result.url;
}

export async function codePainter(src) {
  const url = await sandboxURL(src, 'background');
  const frame = document.createElement('iframe');
  frame.sandbox = 'allow-scripts'; frame.referrerPolicy = 'no-referrer'; frame.title = 'Background renderer';
  Object.assign(frame.style, { position: 'fixed', left: '-10000px', top: '0', width: '1px', height: '1px', border: '0', pointerEvents: 'none' });
  const channel = new MessageChannel(), waiting = new Map();
  let dead = false, connected = false, bitmap = null, prepared = '', sequence = 0, latest = null, pending = false, name = '';
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const readyTimer = setTimeout(() => readyReject(new Error('The background did not load in 15 seconds.')), 15000);
  const dispose = () => {
    if (dead) return;
    dead = true; clearTimeout(readyTimer); readyReject(new Error('Background closed.'));
    for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(new Error('Background closed.')); }
    waiting.clear(); bitmap?.close(); channel.port1.close(); frame.remove();
  };
  channel.port1.onmessage = ({ data: m }) => {
    if (dead) { m?.bitmap?.close?.(); return; }
    if (m?.type === 'ready') { name = String(m.name || '').slice(0, 100); clearTimeout(readyTimer); readyResolve(); return; }
    if (m?.type === 'error' && !m.req) { clearTimeout(readyTimer); readyReject(new Error(String(m.error).slice(0, 400))); return; }
    const w = waiting.get(m?.req);
    if (!w) { m?.bitmap?.close?.(); return; }
    waiting.delete(m.req); clearTimeout(w.timer);
    if (m.type !== 'frame' || !(m.bitmap instanceof ImageBitmap) || m.bitmap.width !== w.W || m.bitmap.height !== w.H) {
      m.bitmap?.close?.(); w.reject(new Error(String(m.error || 'Invalid background frame.').slice(0, 400))); return;
    }
    bitmap?.close(); bitmap = m.bitmap; prepared = w.key; w.resolve();
  };
  channel.port1.start();
  frame.onload = () => {
    if (dead) return;
    if (connected) { dispose(); return; } // Navigation destroys the renderer; never transfer a second port.
    connected = true; frame.contentWindow.postMessage({ type: 'studio:background-connect' }, '*', [channel.port2]);
  };
  frame.src = url; document.body.append(frame);
  try { await ready; } catch (e) { dispose(); throw e; }
  const key = (t, W, H) => `${W}:${H}:${t}`;
  let chain = Promise.resolve();
  const prepare = (t, W, H) => {
    if (dead) return Promise.reject(new Error('Background closed.'));
    if (!Number.isFinite(t) || !Number.isInteger(W) || !Number.isInteger(H) || W < 1 || H < 1 || W > 8192 || H > 8192 || W * H > 33554432) return Promise.reject(new Error('Invalid background dimensions or time.'));
    const wanted = key(t, W, H);
    // Serialise exact export requests; a frame is never painted while a newer request overtakes it.
    const job = chain.then(() => {
      if (dead) throw new Error('Background closed.');
      if (prepared === wanted) return;
      return new Promise((resolve, reject) => {
        const req = ++sequence;
        const timer = setTimeout(() => { waiting.delete(req); reject(new Error('The background frame took longer than 15 seconds.')); }, 15000);
        waiting.set(req, { W, H, key: wanted, timer, resolve, reject });
        channel.port1.postMessage({ type: 'frame', req, W, H, t });
      });
    });
    chain = job.catch(() => {}); return job;
  };
  const pump = () => {
    if (pending || dead || !latest) return;
    const { t, W, H } = latest; latest = null; pending = true;
    prepare(t, W, H).catch(() => {}).finally(() => { pending = false; pump(); });
  };
  return { kind: 'code', animated: true, name, prepare,
    paint(g, W, H, t) {
      g.fillStyle = '#1a1a1c'; g.fillRect(0, 0, W, H);
      if (bitmap) g.drawImage(bitmap, 0, 0, W, H);
      if (prepared !== key(t, W, H)) { latest = { t, W, H }; pump(); }
    }, dispose };
}

// One of the export's background workers (see web/bg-render.html): paints frames k, k+n, k+2n… of an
// animated background with web/look.js and posts each one to the server as a PNG, in order per worker.
import { painterFor } from './look.js';

onmessage = async ({ data: { token, job, k, n } }) => {
  try {
    const p = await painterFor(job.bg, { url: () => job.src });
    const c = new OffscreenCanvas(job.W, job.H), g = c.getContext('2d');
    for (let f = k; f < job.frames; f += n) {
      p.paint(g, job.W, job.H, f / job.fps);
      const png = await c.convertToBlob({ type: 'image/png' });
      const r = await fetch(`/api/bgjob/${token}/frame?n=${f}`, { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'image/png' }, body: png });
      if (!r.ok) throw new Error(`frame ${f}: HTTP ${r.status}`);
    }
    postMessage({ done: true });
  } catch (e) {
    postMessage({ error: String(e.message || e) });
  }
};

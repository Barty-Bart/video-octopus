// The only channel carries frame dimensions/time and transferable pixels. The host retains job/API tokens.
addEventListener('message', function connect(e) {
  if (e.source !== parent || e.data?.type !== 'studio:background-connect' || !e.ports[0]) return;
  removeEventListener('message', connect);
  const port = e.ports[0];
  const post = port.postMessage.bind(port);
  const loaded = import(OCTOPUS_MODULE).then((mod) => {
    const def = mod.default || mod;
    if (typeof def.draw !== 'function') throw new Error('The background has no draw(g, W, H, t).');
    post({ type: 'ready', name: String(def.name || '').slice(0, 100) });
    return def;
  }).catch((e) => { post({ type: 'error', error: String(e?.message || e).slice(0, 400) }); throw e; });
  let chain = Promise.resolve();
  port.onmessage = ({ data: m }) => {
    if (m?.type !== 'frame' || !Number.isInteger(m.W) || !Number.isInteger(m.H) || m.W < 1 || m.H < 1 || m.W > 8192 || m.H > 8192 || m.W * m.H > 33554432 || !Number.isFinite(m.t)) return;
    chain = chain.then(async () => {
      const def = await loaded, c = new OffscreenCanvas(m.W, m.H), g = c.getContext('2d');
      g.fillStyle = '#1a1a1c'; g.fillRect(0, 0, m.W, m.H);
      await def.draw(g, m.W, m.H, m.t);
      const bitmap = c.transferToImageBitmap();
      post({ type: 'frame', req: m.req, bitmap }, [bitmap]);
    }).catch((e) => post({ type: 'error', req: m.req, error: String(e?.message || e).slice(0, 400) }));
  };
  port.start();
});

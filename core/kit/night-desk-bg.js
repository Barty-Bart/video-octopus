/* Night Desk backgrounds: two backgrounds that sit on the Night Desk grid:
     "stars" (M1)  even star field drifting right, two depths, one shooting star every 4 s
     "led"   (D2)  a dot on every grid corner with a slow diagonal brightness wave, orange at the peak
   Pure functions of time t (seconds), so they work inside our seek(t) renderer (frame-exact, no clocks, no randomness at draw time).

   Use in a scene:
     <div class="nd-bg"><canvas id="bg"></canvas></div>   (CSS below gives the colour and the grid)
     NightDesk.draw(ctx, W, H, t, 'stars' | 'led')        call from seek(t) after sizing the canvas to the frame
*/
(function (root) {
  const ORANGE = '255,90,31', CREAM = '240,236,228';
  const CELL = 0.044; // grid cell = 4.4% of frame width (matches the CSS grid)

  // even star field: jittered grid, fixed seed, so every render is identical
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const STARS = [];
  for (let r = 0; r < 17; r++) for (let c = 0; c < 30; c++)
    STARS.push({ x: (c + .12 + .76 * rnd()) / 30, y: (r + .12 + .76 * rnd()) / 17, near: rnd() < .28, ph: rnd() * 6.283, acc: rnd() < .08 });

  function stars(g, W, H, t) {
    const u = W / 100;
    for (const p of STARS) {
      const sp = p.near ? .012 : .006;                  // constant drift right; near layer twice as fast
      const x = ((p.x + t * sp) % 1) * W, y = p.y * H, tw = .55 + .45 * Math.sin(t * 1.6 + p.ph);
      g.globalAlpha = (p.near ? .75 : .35) * tw; g.fillStyle = p.acc ? '#FF9A6B' : '#F0ECE4';
      g.beginPath(); g.arc(x, y, (p.near ? .16 : .09) * u, 0, 6.283); g.fill();
    }
    g.globalAlpha = 1;
    const P = 4, k = Math.floor(t / P), f = (t % P) / .9;  // shooting star every 4 s, fixed angle, start steps across the frame
    if (f < 1) {
      const sx = ((k * .29) % .7 + .05) * W, sy = (.08 + (k % 3) * .1) * H, len = 14 * u, dx = Math.cos(.42), dy = Math.sin(.42);
      const hx = sx + f * 28 * u * dx, hy = sy + f * 28 * u * dy;
      const gr = g.createLinearGradient(hx - len * dx, hy - len * dy, hx, hy);
      gr.addColorStop(0, `rgba(${CREAM},0)`); gr.addColorStop(1, `rgba(${CREAM},.9)`);
      g.globalAlpha = 1 - f * .6; g.strokeStyle = gr; g.lineWidth = .18 * u; g.lineCap = 'round';
      g.beginPath(); g.moveTo(hx - len * dx, hy - len * dy); g.lineTo(hx, hy); g.stroke(); g.globalAlpha = 1;
    }
  }

  function led(g, W, H, t) {
    const cell = W * CELL, r = W * .0016;
    for (let y = cell; y < H; y += cell) for (let x = cell; x < W; x += cell) {
      const ph = (x / W * 1.4 - y / H * .7) - t * .12;      // wave rolls diagonally, one steady direction
      const w = Math.pow(Math.max(0, Math.sin(ph * 6.283)), 3);
      g.fillStyle = w > .55 ? `rgba(${ORANGE},${.16 + .6 * w})` : `rgba(${CREAM},${.16 + .6 * w})`;
      g.beginPath(); g.arc(x, y, r * (1 + w * .8), 0, 6.283); g.fill();
    }
  }

  const NightDesk = {
    css: `.nd-bg{position:absolute;inset:0;background:#17171A;background-image:linear-gradient(rgba(240,236,228,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(240,236,228,.045) 1px,transparent 1px);background-size:4.4vw 4.4vw} /* square cells, 4.4% of frame width; assumes the scene fills the viewport, as in our renders */
.nd-bg canvas{position:absolute;inset:0;width:100%;height:100%}`,
    draw(g, W, H, t, kind = 'stars') { g.clearRect(0, 0, W, H); (kind === 'led' ? led : stars)(g, W, H, t); }
  };
  root.NightDesk = NightDesk;
})(typeof window !== 'undefined' ? window : globalThis);

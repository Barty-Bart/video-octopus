// AudioWorklet for the built-in recorder's mic-only take: the mic's samples as they are (32-bit float,
// interleaved), posted about ten times a second. No encoder anywhere: Video Octopus writes them into a 24-bit WAV.
class StudioPcm extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options.processorOptions?.channels || 1;
    this.on = false;
    this.parts = [];
    this.frames = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') this.on = true;
      if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
    };
  }

  process(inputs) {
    if (!this.on) return true;
    const input = inputs[0] || [], n = input[0]?.length || 128, ch = this.channels;
    const out = new Float32Array(n * ch);
    // No input for a moment (the mic is starting up): silence, so the take keeps its timing.
    if (input.length) for (let c = 0; c < ch; c++) { const src = input[Math.min(c, input.length - 1)]; for (let i = 0; i < n; i++) out[i * ch + c] = src[i]; }
    this.parts.push(out);
    this.frames += n;
    if (this.frames >= sampleRate / 10) this.flush();
    return true;
  }

  flush() {
    if (!this.parts.length) return;
    const all = new Float32Array(this.parts.reduce((s, p) => s + p.length, 0));
    let at = 0;
    for (const p of this.parts) { all.set(p, at); at += p.length; }
    this.parts = []; this.frames = 0;
    this.port.postMessage({ pcm: all }, [all.buffer]);
  }
}
registerProcessor('studio-pcm', StudioPcm);

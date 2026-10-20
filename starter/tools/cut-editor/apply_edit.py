"""Apply a cut-editor save to an edit: render the new rough cut and move every time in the graphics to match.

  python apply_edit.py OLD_EDL.json NEW_EDL.json SOURCE.mp4 OUT.mp4 [--retime scene.html compose.py r.cjs ...]

- Renders OUT.mp4 from NEW_EDL (frame-accurate, 10 ms audio fades at each join; source untouched).
- --retime: rewrites decimal time literals (>= --min, default 2.0 s) in the given files from the old edited
  timeline to the new one, via source time. A time that falls in newly cut material moves to the next kept moment.
  Integers and small decimals are left alone, so check the diff (copies are saved as *.bak).
"""
import argparse, json, os, re, shutil, subprocess, sys, wave
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('old'); ap.add_argument('new'); ap.add_argument('source'); ap.add_argument('out')
ap.add_argument('--retime', nargs='*', default=[]); ap.add_argument('--min', type=float, default=2.0)
ap.add_argument('--fps', type=float, default=30.0)
a = ap.parse_args()
FPS = a.fps
old = json.load(open(a.old, encoding='utf-8'))['segments_sec']; new = json.load(open(a.new, encoding='utf-8'))['segments_sec']
FFMPEG = os.environ.get('FFMPEG') or shutil.which('ffmpeg') or 'ffmpeg'   # $FFMPEG wins when it is set

def to_src(segs, t):
    d = 0
    for s, e in segs:
        if d <= t <= d + (e - s) + 1e-6: return s + (t - d)
        d += e - s
    return segs[-1][1]
def from_src(segs, x):
    d = 0
    for s, e in segs:
        if x < s - 1e-6: return d
        if x <= e + 1e-6: return d + (x - s)
        d += e - s
    return d
mapt = lambda t: from_src(new, to_src(old, t))

# ---- render
F = [(int(round(s * FPS)), int(round(e * FPS))) for s, e in new]
F = [(s, e) for s, e in F if e - s >= 2]
SR = 48000
raw = subprocess.run([FFMPEG, '-v', 'error', '-i', a.source, '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
src = np.frombuffer(raw, np.float32).reshape(-1, 2)
nf = int(SR * .01); ramp = (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, nf)))[:, None]
parts = []
for k, (f0, f1) in enumerate(F):
    x = src[int(f0 * SR / FPS):int(f1 * SR / FPS)].copy()
    if k: x[:nf] *= ramp
    if k < len(F) - 1: x[-nf:] *= ramp[::-1]
    parts.append(x)
mix = np.vstack(parts)
wav = a.out.rsplit('.', 1)[0] + '.wav'
with wave.open(wav, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(mix, -1, 1) * 32767).astype('<i2').tobytes())
graph = ''.join(f"[0:v]trim=start_frame={s}:end_frame={e},setpts=PTS-STARTPTS[v{i}];" for i, (s, e) in enumerate(F))
graph += ''.join(f"[v{i}]" for i in range(len(F))) + f"concat=n={len(F)}:v=1:a=0[v]"
gp = a.out + '.graph.txt'; open(gp, 'w', encoding='utf-8').write(graph)
subprocess.run([FFMPEG, '-v', 'error', '-y', '-i', a.source, '-i', wav, '-filter_complex_script', gp, '-map', '[v]', '-map', '1:a',
                '-r', str(int(FPS)), '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
                '-movflags', '+faststart', a.out], check=True)
print(f'wrote {a.out}: {sum(e - s for s, e in F) / FPS:.2f}s ({len(F)} segments)')

# ---- retime graphics
num = re.compile(r'(?<![\w.])\d+\.\d+(?![\w.])')
for p in a.retime:
    s = open(p, encoding='utf-8', newline='').read(); shutil.copy(p, p + '.bak')
    n = [0]
    def sub(m):
        v = float(m.group(0))
        if v < a.min or v > sum(e - s_ for s_, e in old) + 5: return m.group(0)
        nv = mapt(v)
        if abs(nv - v) > 1e-3: n[0] += 1
        return f'{nv:.2f}'
    open(p, 'w', encoding='utf-8', newline='').write(num.sub(sub, s))
    print(f'retimed {n[0]} times in {p} (backup {p}.bak)')

#!/usr/bin/env python3
"""refine_words.py - snap Whisper word times onto the real sound.

Whisper's word times drift 0.1-0.3 s and sometimes give a word zero length ("So" 132.70-132.70), so word bubbles
in the Cut Editor sit over the wrong sound. This keeps Whisper's words and order, and moves every edge onto the audio:
  - phrase edges (silence before/after) go to where the voice really starts / stops (20 ms RMS vs the local peak)
  - boundaries between words inside a phrase go to the best energy dip near Whisper's guess (dynamic programming,
    so boundaries stay in order, every word keeps >= 60 ms)
No model, no download: numpy + ffmpeg only.

  python3 refine_words.py AUDIO words.json --out words_refined.json [--report]
"""
import argparse, json, os, subprocess
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("audio"); ap.add_argument("words"); ap.add_argument("--out", required=True)
ap.add_argument("--ffmpeg", default=os.environ.get("FFMPEG") or "ffmpeg"); ap.add_argument("--search", type=float, default=0.30)
ap.add_argument("--report", action="store_true")
a = ap.parse_args()

SR, HOP = 16000, 160                                   # 10 ms frames
x = np.frombuffer(subprocess.run([a.ffmpeg, "-v", "error", "-i", a.audio, "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
                                 capture_output=True).stdout, np.int16).astype(np.float32) / 32768
n = len(x) // HOP
rms = np.sqrt(np.convolve((x[:n * HOP] ** 2).reshape(n, HOP).mean(1), np.ones(2) / 2, "same")) + 1e-6
db = 20 * np.log10(rms)
dbs = np.convolve(db, np.ones(3) / 3, "same")          # 30 ms smoothing for dips
FPS = SR / HOP
W = [list(w) for w in json.load(open(a.words, encoding="utf-8"))]
fr = lambda t: int(round(t * FPS))

# phrases: runs of words with < 0.25 s between Whisper's end and next start
phr, cur = [], [0]
for i in range(1, len(W)):
    if W[i][0] - W[i - 1][1] >= 0.25: phr.append(cur); cur = [i]
    else: cur.append(i)
phr.append(cur)

def onset(t, lo, hi, peak):                            # first frame in [lo,hi] louder than peak-28 dB, scanning from t backwards
    thr = peak - 28
    f = fr(t)
    while f > fr(lo) and dbs[f - 1] > thr: f -= 1      # walk back while still voiced
    if dbs[f] <= thr:                                  # Whisper start was in silence: walk forward to the voice
        while f < fr(hi) and dbs[f] <= thr: f += 1
    return f / FPS

def offset(t, lo, hi, peak):
    thr = peak - 28
    f = fr(t)
    while f < fr(hi) and dbs[f + 1] > thr: f += 1
    if dbs[f] <= thr:
        while f > fr(lo) and dbs[f] <= thr: f -= 1
    return f / FPS

moved = []
for p in phr:
    lo = max(0.0, W[p[0]][0] - 0.5) if p[0] == 0 else max(W[p[0] - 1][1], W[p[0]][0] - 0.5)
    hi = W[p[-1]][1] + 0.5 if p[-1] == len(W) - 1 else min(W[p[-1] + 1][0], W[p[-1]][1] + 0.5)
    hi = min(hi, (n - 2) / FPS)
    peak = float(dbs[fr(lo):fr(hi) + 1].max())
    s = onset(W[p[0]][0], lo, W[p[0]][1] + 0.3, peak)
    e = offset(W[p[-1]][1], W[p[-1]][0] - 0.3, hi, peak)
    if e - s < 0.06 * len(p): s, e = W[p[0]][0], W[p[-1]][1]
    k = len(p) - 1
    bounds = []
    if k:
        guess = [(W[p[j]][1] + W[p[j + 1]][0]) / 2 for j in range(k)]
        # candidates: local minima of dbs inside the phrase
        F0, F1 = fr(s) + 6, fr(e) - 6
        cand = [f for f in range(F0 + 1, F1) if dbs[f] <= dbs[f - 1] and dbs[f] <= dbs[f + 1]]
        if len(cand) >= k:
            ct = np.array(cand) / FPS
            depth = np.array([dbs[f] for f in cand]) - peak          # negative = deeper
            INF = 1e9
            # cost[j][c] = best cost placing boundary j at candidate c
            cost = np.full((k, len(cand)), INF); back = np.zeros((k, len(cand)), int)
            for j in range(k):
                dist = np.abs(ct - guess[j])
                local = np.where(dist <= a.search, (dist / 0.1) ** 2 + depth / 6.0, INF)
                if j == 0:
                    cost[0] = np.where(ct - s >= 0.06, local, INF)
                else:
                    best, arg, barg = INF, -1, -1
                    for c in range(len(cand)):
                        # best previous candidate at least 60 ms earlier
                        while arg + 1 < c and ct[c] - ct[arg + 1] >= 0.06:
                            arg += 1
                            if cost[j - 1][arg] < best: best, barg = cost[j - 1][arg], arg
                        if best < INF: cost[j][c] = local[c] + best; back[j][c] = barg
                    cost[j] = np.where(ct <= e - 0.06, cost[j], INF)
            c = int(np.argmin(cost[k - 1]))
            if cost[k - 1][c] < INF:
                idx = [c]
                for j in range(k - 1, 0, -1): idx.append(back[j][idx[-1]])
                bounds = [float(ct[i]) for i in idx[::-1]]
        if not bounds:                                               # fallback: keep Whisper's boundaries, clipped
            bounds = [min(max(g, s + 0.06 * (j + 1)), e - 0.06 * (k - j)) for j, g in enumerate(guess)]
    edges = [s] + bounds + [e]
    for j, i in enumerate(p):
        old = W[i][:2]
        W[i][0], W[i][1] = round(edges[j], 3), round(edges[j + 1], 3)
        moved.append(abs(W[i][0] - old[0]))

json.dump(W, open(a.out, "w", encoding="utf-8"), ensure_ascii=False)
m = np.array(moved)
print(f"{len(W)} words in {len(phr)} phrases; start moved: median {np.median(m)*1000:.0f} ms, "
      f"90% {np.percentile(m,90)*1000:.0f} ms, max {m.max()*1000:.0f} ms -> {a.out}")

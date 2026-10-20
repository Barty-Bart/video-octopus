#!/usr/bin/env python3
"""seam_audit.py - the checks Claude runs on every cut before handing it back.
join_check.py listens to each join for clipped words; this looks at the cut as a whole:

  1. scraps     kept pieces shorter than --scrap s that hold no words, or only a word or two that is said again
                within 15 s (a stray fragment of another take spliced in, e.g. "...our ✂memory,✂ so the upgraded,✂ Now...")
  2. repeats    the same 3+ word phrase spoken twice within --window s on the EDITED timeline (retakes that survived,
                "now our next step is... now our next step is...")
  3. pauses     silences inside the kept audio longer than --max-pause s, measured from the audio energy, not the
                transcript (Whisper often stretches a word over a pause)

  python3 seam_audit.py AUDIO.wav --edl work/edl_manual.json --words work/words.json [--out work/seam_audit.json]
Prints a short report, worst first, with edited-timeline times; writes the full list as JSON.
"""
import argparse, json, os, re, subprocess, sys
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("audio"); ap.add_argument("--edl", required=True); ap.add_argument("--words", required=True)
ap.add_argument("--out", default=None); ap.add_argument("--scrap", type=float, default=0.8)
ap.add_argument("--window", type=float, default=60.0); ap.add_argument("--max-pause", type=float, default=0.45)
ap.add_argument("--ffmpeg", default=os.environ.get("FFMPEG") or "ffmpeg")
a = ap.parse_args()

segs = sorted(json.load(open(a.edl, encoding="utf-8"))["segments_sec"])
W = json.load(open(a.words, encoding="utf-8"))
st, acc = [], 0.0
for s0, s1 in segs:
    st.append(acc); acc += s1 - s0


def ed(t):
    for i, (s0, s1) in enumerate(segs):
        if s0 <= t <= s1: return st[i] + t - s0
    return None


def fmt(e):
    return f"{int(e // 60)}:{e % 60:05.2f}"


norm = lambda w: re.sub(r"[^a-z0-9']", "", w.lower())
kw = []                                       # kept words with edited times
for w0, w1, w in W:
    m = ed((w0 + w1) / 2)
    if m is not None: kw.append((m, w0, w1, norm(w), w))
kw.sort()
issues = []

# 1. scraps
for i, (s0, s1) in enumerate(segs):
    if s1 - s0 >= a.scrap: continue
    inside = [k for k in kw if s0 <= (k[1] + k[2]) / 2 < s1]
    e = st[i]
    if not inside:
        issues.append({"kind": "scrap", "at": e, "sev": 0.6, "src": [s0, s1], "why": f"{s1 - s0:.2f}s kept piece with no words"})
        continue
    later = [k[3] for k in kw if e + (s1 - s0) < k[0] < e + 15]
    dup = [k[4] for k in inside if k[3] and k[3] in later]
    if dup and len(inside) <= 3:
        issues.append({"kind": "scrap", "at": e, "sev": 0.9, "src": [s0, s1],
                       "why": f"{s1 - s0:.2f}s fragment \"{' '.join(k[4] for k in inside)}\" — \"{dup[0]}\" is said again within 15 s (stray piece of another take?)"})

# 2. repeats (3-gram, then grow)
toks = [(k[0], k[3], k[4]) for k in kw if k[3]]
seen = {}
for i in range(len(toks) - 2):
    g = tuple(t[1] for t in toks[i:i + 3])
    seen.setdefault(g, []).append(i)
reported = set()
for g, idx in seen.items():
    for x, y in zip(idx, idx[1:]):
        if toks[y][0] - toks[x][0] > a.window or x in reported: continue
        n = 3
        while y + n < len(toks) and x + n < y and toks[x + n][1] == toks[y + n][1]: n += 1
        if n < 4: continue                                # 3-word matches are mostly stock phrases
        if any(k in reported for k in range(y, y + n)): continue
        reported.update(range(x, x + n)); reported.update(range(y, y + n))
        issues.append({"kind": "repeat", "at": toks[x][0], "sev": 0.5 + min(0.4, n * 0.05),
                       "why": f"\"{' '.join(t[2] for t in toks[x:x + n])}\" at {fmt(toks[x][0])} and again at {fmt(toks[y][0])} — keep one take?"})

# 3. pauses from the audio energy (20 ms frames)
raw = subprocess.run([a.ffmpeg, "-v", "error", "-i", a.audio, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], capture_output=True).stdout
x = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
fr = 320
for i, (s0, s1) in enumerate(segs):
    seg = x[int(s0 * 16000):int(s1 * 16000)]
    if len(seg) < fr * 3: continue
    e = 20 * np.log10(np.sqrt((seg[:len(seg) // fr * fr].reshape(-1, fr) ** 2).mean(1)) + 1e-9)
    thr = max(-50.0, np.percentile(e, 90) - 32)          # relative to this piece's speech level
    quiet = e < thr
    run = 0
    for j, q in enumerate(np.append(quiet, False)):
        if q: run += 1; continue
        if run * 0.02 > a.max_pause:
            t0 = s0 + (j - run) * 0.02
            issues.append({"kind": "pause", "at": st[i] + (j - run) * 0.02, "sev": min(0.8, 0.3 + run * 0.02 / 3), "src": [round(t0, 3), round(t0 + run * 0.02, 3)],
                           "why": f"{run * 0.02:.2f}s of silence inside kept audio"})
        run = 0

issues.sort(key=lambda d: -d["sev"])
counts = {k: sum(1 for d in issues if d["kind"] == k) for k in ("scrap", "repeat", "pause")}
print(f"seam audit: {len(segs)} pieces, {acc / 60:.1f} min · {counts['scrap']} scraps, {counts['repeat']} repeats, {counts['pause']} long pauses")
for d in issues[:25]:
    print(f"  {d['kind']:7s} {fmt(d['at'])}  {d['why']}")
if a.out: json.dump({"edl": a.edl, "issues": issues, "summary": counts}, open(a.out, "w", encoding="utf-8"), indent=1)

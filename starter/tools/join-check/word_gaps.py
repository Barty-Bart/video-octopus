#!/usr/bin/env python3
"""word_gaps.py - word-gap shortening, decided by a voice detector instead of loudness.

The waveform alone can't tell the voice from a mouse click, a mic bump or room noise, and Whisper often stretches a
word over a pause. This runs Silero VAD (the voice-activity model bundled with faster-whisper) on the cut AS PLAYED and
finds every stretch with no voice. Any gap longer than --max (default 0.2 s) is shortened to --max by removing the middle
of the gap, so a little air stays on both sides and word endings/breaths into the next word aren't touched.

  python3 word_gaps.py AUDIO_OR_VIDEO --edl work/edl_manual_r.json [--max 0.2] [--out work/word_gaps.json]
         [--proposed work/edl_gaps_proposed.json] [--demo DIR --demo-at 13:00 --demo-len 60]
Nothing is applied: it writes a report + a proposed EDL; --demo writes before.mp4 / after.mp4 of one stretch to listen to.
"""
import argparse, json, os, subprocess, sys
import numpy as np
from faster_whisper.vad import VadOptions, get_speech_timestamps

ap = argparse.ArgumentParser()
ap.add_argument("media"); ap.add_argument("--edl", required=True)
ap.add_argument("--max", type=float, default=0.2, help="longest gap to keep (s)")
ap.add_argument("--min-cut", type=float, default=0.08, help="ignore savings smaller than this (s)")
ap.add_argument("--quiet-db", type=float, default=20.0, help="skip a gap if anything in the part to remove is louder than (speech level - this) dB")
ap.add_argument("--min-piece", type=float, default=0.06, help="drop leftover pieces shorter than this (s)")
ap.add_argument("--threshold", type=float, default=0.5, help="VAD speech probability threshold")
ap.add_argument("--out", default=None); ap.add_argument("--proposed", default=None)
ap.add_argument("--demo", default=None); ap.add_argument("--demo-at", default="0:00"); ap.add_argument("--demo-len", type=float, default=60)
ap.add_argument("--ffmpeg", default=os.environ.get("FFMPEG") or "ffmpeg")
a = ap.parse_args()
SR = 16000

segs = [list(s) for s in json.load(open(a.edl, encoding="utf-8"))["segments_sec"]]          # play order as saved
raw = subprocess.run([a.ffmpeg, "-v", "error", "-i", a.media, "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"], capture_output=True).stdout
x = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
played = np.concatenate([x[int(s0 * SR):int(s1 * SR)] for s0, s1 in segs])
starts = np.cumsum([0] + [int(s1 * SR) - int(s0 * SR) for s0, s1 in segs])  # sample offset of each piece in the played audio

PAD = 0.04                                                    # VAD pads each speech region by this much; gap lengths below add it back
opt = VadOptions(threshold=a.threshold, min_silence_duration_ms=int(max(60, (a.max - 2 * PAD) * 1000 * 0.75)), speech_pad_ms=int(PAD * 1000), min_speech_duration_ms=120)
speech = get_speech_timestamps(played, opt)
gaps = []                                                    # silences between voice, in played samples
prev = 0
for sp in speech:
    if sp["start"] - prev > 0: gaps.append((prev, sp["start"]))
    prev = sp["end"]
if len(played) - prev > 0: gaps.append((prev, len(played)))

def to_src(p):                                               # played sample -> (piece index, source seconds)
    i = int(np.searchsorted(starts, p, side="right") - 1); i = min(i, len(segs) - 1)
    return i, segs[i][0] + (p - starts[i]) / SR

cuts = []                                                    # source ranges to remove, possibly split across a join
frdb = lambda s: 20 * np.log10(np.sqrt((s[:len(s) // 320 * 320].reshape(-1, 320) ** 2).mean(1)) + 1e-9) if len(s) >= 320 else np.array([-120.0])
SPEECH = np.percentile(frdb(played), 90); skipped = 0
for g0, g1 in gaps:
    keep = int(max(0.0, a.max / 2 - PAD) * SR)                 # leaves max/2 of real silence on each side
    if (g1 - g0) / SR + 2 * PAD - a.max >= a.min_cut and frdb(played[g0 + keep:g1 - keep]).max() > SPEECH - a.quiet_db:
        skipped += 1; continue                               # something audible in there (click, breath into a word): leave it
    ck = int(0.03 * SR)
    if (g1 - g0) / SR + 2 * PAD - a.max >= a.min_cut and max(frdb(played[g0 + keep - ck:g0 + keep]).max(), frdb(played[g1 - keep:g1 - keep + ck]).max()) > SPEECH - a.quiet_db - 5:
        skipped += 1; continue                               # the cut points themselves must sit in silence too
    L = (g1 - g0) / SR + 2 * PAD                             # real silence length
    if L - a.max < a.min_cut: continue
    c0, c1 = g0 + keep, g1 - keep
    i0, t0 = to_src(c0); i1, t1 = to_src(c1)
    if i0 == i1: cuts.append({"piece": i0, "src": [round(t0, 3), round(t1, 3)], "gap": round(L, 3), "at": round(g0 / SR, 2)})
    else:                                                    # gap crosses a join: trim the end of the left piece and the start of the right one
        cuts.append({"piece": i0, "src": [round(t0, 3), round(segs[i0][1], 3)], "gap": round(L, 3), "at": round(g0 / SR, 2), "join": True})
        for k in range(i0 + 1, i1): cuts.append({"piece": k, "src": list(segs[k]), "gap": round(L, 3), "at": round(g0 / SR, 2), "join": True})
        cuts.append({"piece": i1, "src": [round(segs[i1][0], 3), round(t1, 3)], "gap": round(L, 3), "at": round(g0 / SR, 2), "join": True})

new = []                                                     # proposed EDL: each piece minus its cuts, play order kept
for i, (s0, s1) in enumerate(segs):
    cur = s0
    for c in sorted((c for c in cuts if c["piece"] == i), key=lambda c: c["src"][0]):
        if c["src"][0] - cur > 0.02: new.append([round(cur, 3), c["src"][0]])
        cur = max(cur, c["src"][1])
    if s1 - cur > 0.02: new.append([round(cur, 3), s1])
new = [p for p in new if p[1] - p[0] >= a.min_piece]

fmt = lambda s: f"{int(s // 60)}:{s % 60:04.1f}"
before, after = len(played) / SR, sum(b - a_ for a_, b in new)
long = sorted({(c["at"], c["gap"]) for c in cuts}, key=lambda z: -z[1])
hist = {k: sum(1 for _, g in long if lo <= g < hi) for k, lo, hi in (("0.2-0.4 s", 0, .4), ("0.4-0.7 s", .4, .7), ("0.7-1.0 s", .7, 1), ("1 s+", 1, 99))}
print(f"voice detector: {len(speech)} speech regions · {len(long)} gaps shortened (skipped {skipped} with sound in them) · {before / 60:.2f} -> {after / 60:.2f} min (saves {before - after:.0f} s)")
print("  gap sizes:", ", ".join(f"{k}: {v}" for k, v in hist.items()))
print("  longest:", ", ".join(f"{fmt(t)} ({g:.2f}s)" for t, g in long[:8]))
if a.out: json.dump({"edl": a.edl, "max": a.max, "cuts": cuts, "before_s": before, "after_s": after}, open(a.out, "w"), indent=1)
if a.proposed: json.dump({"segments_sec": new, "source": a.edl, "note": f"word gaps capped at {a.max}s by voice detector (proposed, not applied)"}, open(a.proposed, "w"), indent=0)

if a.demo:                                                   # same stretch before/after, from the cut as played
    import os; os.makedirs(a.demo, exist_ok=True)
    m, s = a.demo_at.split(":"); T0 = int(m) * 60 + float(s); T1 = T0 + a.demo_len
    def pieces(E, t0, t1):
        out, acc = [], 0.0
        for s0, s1 in E:
            d = s1 - s0; lo, hi = max(t0, acc), min(t1, acc + d)
            if hi > lo: out.append((s0 + lo - acc, s0 + hi - acc))
            acc += d
        return out
    src_before = pieces(segs, T0, T1)
    span = (src_before[0][0], src_before[-1][1])             # the same source material after shortening
    src_after = [(max(p0, span[0]), min(p1, span[1])) for p0, p1 in new if p1 > span[0] and p0 < span[1]]
    off = max(0.0, span[0] - 1.0)
    for name, P in (("before", src_before), ("after", src_after)):
        fc = "".join(f"[0:v]trim={p0 - off:.3f}:{p1 - off:.3f},setpts=PTS-STARTPTS[v{k}];[0:a]atrim={p0 - off:.3f}:{p1 - off:.3f},asetpts=PTS-STARTPTS,"
                     f"afade=t=in:d=0.006,afade=t=out:st={max(0, p1 - p0 - 0.006):.3f}:d=0.006[a{k}];" for k, (p0, p1) in enumerate(P))
        fc += "".join(f"[v{k}][a{k}]" for k in range(len(P))) + f"concat=n={len(P)}:v=1:a=1[v][a]"
        subprocess.run([a.ffmpeg, "-v", "error", "-y", "-ss", f"{off:.3f}", "-t", f"{span[1] - off + 1:.3f}", "-i", a.media, "-filter_complex", fc,
                        "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-c:a", "aac", f"{a.demo}/{name}.mp4"], check=True)
    print(f"demo: {a.demo}/before.mp4 ({sum(q - p for p, q in src_before):.1f} s) and after.mp4 ({sum(q - p for p, q in src_after):.1f} s)")

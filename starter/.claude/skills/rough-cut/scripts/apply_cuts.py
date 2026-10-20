#!/usr/bin/env python3
"""apply_cuts.py: cut the video by an approved cuts.json (frame-accurate re-encode, soft audio joins).

  python3 apply_cuts.py VIDEO work/cuts.json --out work/rough.mp4
        [--decisions work/decisions.json] [--reject 3,7] [--accept 12]
        [--words WORDS.json] [--crossfade-frames 0] [--punch 0] [--fade-ms 10] [--crf 18]

- Items marked "cut" are applied unless rejected; "ask" items only when accepted.
  --decisions takes the JSON from the review page's "Copy decisions" button ({"reject": [...], "accept": [...]}).
- Every cut edge sits on the video frame grid at the quietest 20 ms nearby, with a short fade each side,
  so joins do not click. The source file is never modified.
- --crossfade-frames 2-4 blends the picture across each join; --punch 1.05 alternates a small zoom at
  each join instead (hides the jump on a talking head). Use one or the other.
Also writes, next to --out:
  rough_words.json  kept words on the new timeline (cut words removed)
  rough_map.json    old -> new time mapping (kept segments)
  rough_cuts.txt    the cut list as source timecodes (for a manual edit in any editor)
"""
import argparse, json, subprocess, sys, tempfile, wave
from fractions import Fraction
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cutlib import (FFMPEG, Energy, TimeMap, build_plan, decide, probe, read_audio, remap_words,  # noqa: E402
                    segments_from_cuts)


def ids(s):
    return [int(x) for x in str(s).replace(" ", "").split(",") if x] if s else []


def tc(t):
    m, s = divmod(t, 60)
    return f"{int(m):02d}:{s:06.3f}"


def write_wav(path, x, sr):
    y = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(y.shape[1]); w.setsampwidth(2); w.setframerate(sr); w.writeframes(y.tobytes())


def cut_audio(src, segs, rate, sr, fade_ms):
    """concatenate kept sample ranges, raised-cosine fade out/in at every join"""
    nf = max(1, int(sr * fade_ms / 1000))
    ramp = (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, nf)))[:, None].astype(np.float32)
    parts = []
    for k, (f0, f1) in enumerate(segs):
        a, b = int(round(f0 * sr / rate)), int(round(f1 * sr / rate))
        x = src[a:min(b, len(src))].copy()
        if len(x) < b - a:                       # audio shorter than video: pad with silence
            x = np.vstack([x, np.zeros((b - a - len(x), src.shape[1]), np.float32)])
        n = min(nf, len(x) // 2)
        if k > 0 and n:
            x[:n] *= ramp[:n]
        if k < len(segs) - 1 and n:
            x[-n:] *= ramp[:n][::-1]
        parts.append(x)
    return np.vstack(parts), list(np.cumsum([len(x) for x in parts])[:-1].astype(int).tolist())


def video_select(src, wav, segs, out, fps, crf, preset):
    expr = "+".join(f"between(n,{a},{b - 1})" for a, b in segs)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(f"[0:v]select='{expr}',setpts=N/FRAME_RATE/TB[v]")
        graph = f.name
    cmd = [FFMPEG, "-v", "error", "-y", "-i", str(src), "-i", str(wav), "-filter_complex_script", graph,
           "-map", "[v]", "-map", "1:a", "-r", str(fps), "-c:v", "libx264", "-crf", str(crf), "-preset", preset,
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)]
    subprocess.run(cmd, check=True)


def video_pipe(src, wav, segs, out, fps, W, H, crf, preset, xf, punch, focus):
    """frame-by-frame path for crossfades / punch-ins (decodes the source once, in order)"""
    import cv2
    plan = []                                   # per output frame: (src_frame, seg_index, partner_frame, partner_seg, w_partner)
    for k, (a, b) in enumerate(segs):
        for f in range(a, b):
            plan.append([f, k, None, None, 0.0])
    if xf > 0:
        pos = 0
        for k in range(len(segs) - 1):
            pos += segs[k][1] - segs[k][0]
            a_end, b0 = segs[k][1], segs[k + 1][0]
            k1 = (xf + 1) // 2                   # frames of the join taken from the end of A
            for p in range(xf):
                w = (p + 1) / (xf + 1)            # weight of the incoming shot B
                o = pos - k1 + p                 # output index
                if not (0 <= o < len(plan)):
                    continue
                if p < k1:                        # A frame, blend in B's frame from just before its start
                    plan[o][2], plan[o][3], plan[o][4] = b0 - (k1 - p), k + 1, w
                else:                             # B frame, blend in A's continuation (what was cut)
                    plan[o][2], plan[o][3], plan[o][4] = a_end + (p - k1), k, 1 - w
    need = {}
    for r in plan:
        for f in (r[0], r[2]):
            if f is not None:
                need[f] = need.get(f, 0) + 1
    fx, fy = focus if focus else (W / 2, H * 0.42)

    def scaled(img, seg):
        if not punch or seg % 2 == 0:
            return img
        M = np.float32([[punch, 0, fx - punch * fx], [0, punch, fy - punch * fy]])
        return cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)

    dec = subprocess.Popen([FFMPEG, "-v", "error", "-i", str(src), "-map", "0:v:0", "-f", "rawvideo",
                            "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    enc = subprocess.Popen([FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                            "-r", str(fps), "-i", "-", "-i", str(wav), "-map", "0:v", "-map", "1:a",
                            "-c:v", "libx264", "-crf", str(crf), "-preset", preset, "-pix_fmt", "yuv420p",
                            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)], stdin=subprocess.PIPE)
    cache, nxt, fsize, n = {}, 0, W * H * 3, 0
    last = None
    while nxt < len(plan):
        buf = dec.stdout.read(fsize)
        if len(buf) < fsize:
            break
        if n in need:
            cache[n] = np.frombuffer(buf, np.uint8).reshape(H, W, 3)
            last = cache[n]
        n += 1
        while nxt < len(plan):
            f, k, pf, pk, w = plan[nxt]
            if f not in cache or (pf is not None and pf not in cache):
                break
            img = scaled(cache[f], k)
            if pf is not None:
                img = cv2.addWeighted(img, 1 - w, scaled(cache[pf], pk), w, 0)
            enc.stdin.write(np.ascontiguousarray(img).tobytes())
            for g in (f, pf):
                if g is not None:
                    need[g] -= 1
                    if need[g] == 0:
                        cache.pop(g, None)
            nxt += 1
    while nxt < len(plan) and last is not None:   # source ran short of its frame count: hold the last frame
        enc.stdin.write(last.tobytes()); nxt += 1
    enc.stdin.close(); enc.wait()
    dec.kill(); dec.stdout.close(); dec.wait()     # the tail of the source after the last kept frame is not needed
    if enc.returncode:
        sys.exit("encoding failed")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("cuts")
    ap.add_argument("--out", default="work/rough.mp4")
    ap.add_argument("--decisions", default=None, help="JSON from the review page: {\"reject\": [..], \"accept\": [..]}")
    ap.add_argument("--reject", default="", help="ids of default cuts to skip, e.g. 3,7")
    ap.add_argument("--accept", default="", help="ids of 'ask' items to apply, e.g. 12")
    ap.add_argument("--words", default=None, help="words.json to remap (default: the one cuts.json was made from)")
    ap.add_argument("--crossfade-frames", type=int, default=0)
    ap.add_argument("--punch", type=float, default=0.0, help="e.g. 1.05: zoom every other segment by 5%% to hide jump cuts")
    ap.add_argument("--focus", default=None, help="punch-in centre x,y in pixels (default: centre, upper third)")
    ap.add_argument("--fade-ms", type=float, default=10.0)
    ap.add_argument("--crf", type=int, default=18)
    ap.add_argument("--preset", default="medium")
    ap.add_argument("--dry-run", action="store_true", help="print the kept segments only")
    a = ap.parse_args()

    data = json.load(open(a.cuts, encoding="utf-8"))
    src = Path(a.video)
    if src.resolve() == Path(a.out).resolve():
        sys.exit("--out must not be the source video")
    rej, acc = ids(a.reject), ids(a.accept)
    if a.decisions:
        d = json.load(open(a.decisions, encoding="utf-8"))
        rej += [int(x) for x in d.get("reject", [])]
        acc += [int(x) for x in d.get("accept", [])]
    known = {it["id"] for it in data["items"]}
    bad = [x for x in rej + acc if x not in known]
    if bad:
        sys.exit(f"unknown cut ids: {bad}")
    accepted = decide(data, rej, acc)

    info = probe(src)
    if not info["fps"]:
        sys.exit("no video stream found (audio-only rough cuts: convert to a video with a still frame first)")
    fps = info["fps"]
    nframes = info["nb_frames"] or int(round(info["duration"] * float(fps)))
    en = Energy(read_audio(src, 16000, 1))
    cuts = build_plan(data, accepted, en, fps, refine=True)
    segs, rate = segments_from_cuts(cuts, data["duration"], fps, nframes)
    tm = TimeMap(segs, rate)
    by = {}
    for it in data["items"]:
        if it["id"] in accepted:
            by[it["reason"]] = by.get(it["reason"], 0) + 1
    print(f"applying {len(accepted)} cuts ({', '.join(f'{v} {k}' for k, v in sorted(by.items()))}); "
          f"rejected {len(rej)}, accepted asks {len(acc)}")
    print(f"{len(segs)} kept segments: {info['duration']:.2f}s -> {tm.total:.2f}s (-{info['duration'] - tm.total:.2f}s)")
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"# kept segments of {src.name} (source timecodes, mm:ss.sss); fps {fps}"]
    lines += [f"{tc(s)}  ->  {tc(e)}   ({e - s:.2f}s)  at {tc(d)} in the rough cut" for s, e, d in tm.rows]
    (out.parent / "rough_cuts.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    if a.dry_run:
        print("\n".join(lines))
        return

    # audio: full rate, all channels
    sr, ch = info["sr"] or 48000, info["channels"] or 2
    full = read_audio(src, sr, ch) if info["sr"] else np.zeros((int(info["duration"] * sr), ch), np.float32)
    audio, joins = cut_audio(full, segs, rate, sr, a.fade_ms)
    tmp = Path(tempfile.mkdtemp())
    wav = tmp / "rough.wav"
    write_wav(wav, audio, sr)

    focus = tuple(float(v) for v in a.focus.split(",")) if a.focus else None
    if a.crossfade_frames or a.punch:
        video_pipe(src, wav, segs, out, fps, info["width"], info["height"], a.crf, a.preset,
                   a.crossfade_frames, a.punch, focus)
    else:
        video_select(src, wav, segs, out, fps, a.crf, a.preset)

    # remapped words + map for the next skills
    words_path = a.words or data.get("words")
    if words_path and Path(words_path).exists():
        words = json.load(open(words_path, encoding="utf-8"))
        rw = remap_words(words, tm)
        json.dump(rw, open(out.parent / "rough_words.json", "w", encoding="utf-8"), ensure_ascii=False)
        print(f"rough_words.json: {len(rw)} of {len(words)} words kept")
    m = tm.to_json(info["duration"], fps)
    m["source"] = str(src.resolve())
    m["applied"] = sorted(accepted)
    m["join_samples"] = joins          # where the joins fall in the rough-cut audio
    m["sample_rate"] = sr
    json.dump(m, open(out.parent / "rough_map.json", "w", encoding="utf-8"), indent=1)
    got = probe(out)
    print(f"wrote {out} ({got['duration']:.2f}s), rough_map.json, rough_cuts.txt")


if __name__ == "__main__":
    main()

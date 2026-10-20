#!/usr/bin/env python3
"""join_check.py: listen to every join of a cut before graphics are timed to it.

  python3 join_check.py SOURCE.mp4 (--map work/rough_map.json | --edl work/edl.json)
          [--words work/tr/words.json] [--out work/joins] [--recheck] [--fix-out work/edl_fixed.json]

SOURCE is the untouched recording. The cut is given either as the rough-cut skill's rough_map.json
(segments[].src) or as an EDL {"segments_sec": [[start, end], ...]} (Cut Editor / apply_edit.py).
Words are source-time [start, end, word] (the transcript the cut was made from).

For each join it measures both edges:
  - a kept word that runs past the cut (its end or start is chopped off)
  - voice still loud right at the edge, with more voice in the removed audio next to it
  - optional (--recheck, needs faster-whisper): re-transcribes 1 s either side of the join and
    compares it with the words that should be there
and suggests a fix: move the edge outwards to the first quiet point (max 200 ms, never into another word).
It also catches the opposite: a leftover tail. A removed word whose sound runs on past the cut into what is kept
(Whisper often ends a word before its sound does, so a word deleted on its word times leaves "...cally" in): voice
at the edge on the removed side, a voiced run from the edge into the kept part, then quiet before the next kept word.
Its fix moves the edge inwards, to the quiet point after the leftover (never into the next word): "trim_ms".

Writes  <out>.json  every join, worst first (the Cut Editor reads it with --joins and marks them)
        <out>.html  the listening page: each join as it sounds now and with the fix, side by side
        --fix-out   the cut with the suggested fixes applied to "likely clipped" joins (an EDL that
                    the Cut Editor opens and apply_edit.py renders). The input cut is never changed.
"""
import argparse, base64, html, io, json, os, re, shutil, subprocess, sys, wave
from pathlib import Path

import numpy as np

SR = 16000
HOP, WIN = 0.010, 0.020
MAX_FIX = 0.20      # never move an edge more than this
PAD = 0.03          # leave this much air outside the quiet point
SLIVER = 0.12       # a kept piece shorter than this is almost always a leftover from cutting
FFMPEG = os.environ.get("FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"   # $FFMPEG wins when it is set


def read_audio(path):
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).copy()


class Level:
    """RMS level (dB) of 20 ms windows every 10 ms."""
    def __init__(self, x):
        hop, win = int(SR * HOP), int(SR * WIN)
        n = max(1, (len(x) - win) // hop + 1)
        idx = np.minimum(np.arange(win)[None, :] + hop * np.arange(n)[:, None], len(x) - 1)
        self.db = 20 * np.log10(np.sqrt(np.mean(x[idx].astype(np.float64) ** 2, axis=1)) + 1e-9)
        self.floor = float(np.percentile(self.db, 10))
        voiced = self.db[self.db > self.floor + 15]
        self.speech = float(np.percentile(voiced, 70)) if len(voiced) else self.floor + 30
        # relative to speech, not the floor: digital silence in a file drags the floor far down
        self.quiet = max(self.floor + 6, self.speech - 25)

    def i(self, t):
        return int(np.clip(round((t - WIN / 2) / HOP), 0, len(self.db) - 1))

    def peak(self, a, b):
        i0, i1 = self.i(min(a, b)), self.i(max(a, b))
        return float(self.db[i0:i1 + 1].max())

    def loud(self, db):
        """0 at quiet, 1 at normal speech level"""
        return float(np.clip((db - self.quiet) / max(1.0, self.speech - 6 - self.quiet), 0, 1))


def load_cut(a):
    if a.map:
        m = json.load(open(a.map, encoding="utf-8"))
        return [tuple(s["src"]) for s in m["segments"]]
    return [tuple(s) for s in json.load(open(a.edl, encoding="utf-8"))["segments_sec"]]


def words_near(words, t, before, after):
    return [w for w in words if w[1] > t - before and w[0] < t + after]


TAIL_MIN = 0.03     # a voiced leftover shorter than this is just the word dying away
TAIL_BAD = 0.06     # from this long it is a syllable: likely clipped


def check_tail(lv, words, t, side, removed):
    """A removed word still sounding at the edge and on into the kept part. side 'in': the kept part starts at t
    (removed audio before it); 'out': it ends at t. removed = (start, end) of the removed audio. Returns
    (leftover seconds, how far to move the edge inwards, the word) or None."""
    s = +1 if side == "in" else -1                          # inwards: into the kept part
    r0, r1 = removed
    gone = [w for w in words if r0 < (w[0] + w[1]) / 2 < r1 and (w[1] > t - 0.4 if side == "in" else w[0] < t + 0.4)]
    if not gone or lv.peak(t - s * 0.03, t) < lv.quiet:   # no removed word near, or it was quiet at the cut
        return None
    word = (max(gone, key=lambda w: w[1]) if side == "in" else min(gone, key=lambda w: w[0]))[2]
    kept = [w for w in words if ((w[0] + w[1]) / 2 > t if side == "in" else (w[0] + w[1]) / 2 < t)]
    room = (min(w[0] for w in kept) - t if side == "in" else t - max(w[1] for w in kept)) if kept else 0.5
    limit = room - 0.02                                     # never into the next kept word
    if limit < TAIL_MIN:
        return None
    k = 0
    while k * HOP < limit:
        tt = t + s * k * HOP
        if all(lv.db[lv.i(tt + s * m * HOP)] < lv.quiet for m in range(3)):   # quiet for 30 ms: the leftover ends
            break
        k += 1
    run = k * HOP
    if run < TAIL_MIN or run >= limit:                      # nothing left over, or the voice runs into the next word
        return None
    return run, min(run + PAD, limit), word


def check_edge(lv, words, t, side, limit, removed=None):
    """side 'out' = end of a kept segment at t (removed audio follows), 'in' = start (removed audio precedes).
    limit = how far the edge may move outwards (toward the neighbouring kept segment); removed = (start, end) of
    the removed audio, for the leftover-tail check."""
    s = +1 if side == "out" else -1                         # outward direction
    inside = lv.peak(t - s * 0.03, t)                       # last/first 30 ms of what is kept
    outside = lv.peak(t, t + s * 0.06)                      # the 60 ms that was removed next to it
    chopped, word = 0.0, None
    for w in words:
        if side == "out" and w[0] < t - 0.015 and w[1] > t + 0.015 and (w[0] + w[1]) / 2 < t + 0.02:
            if w[1] - t > chopped: chopped, word = w[1] - t, w[2]
        if side == "in" and w[0] < t - 0.015 and w[1] > t + 0.015 and (w[0] + w[1]) / 2 > t - 0.02:
            if t - w[0] > chopped: chopped, word = t - w[0], w[2]
    edge = lv.loud(inside)
    cont = lv.loud(outside)
    score = 0.6 * min(1.0, chopped / 0.08) + 0.4 * edge * (0.5 + 0.5 * cont)
    # suggested fix: first quiet point outwards, never past the next word that is not the chopped one
    stop = min(MAX_FIX, max(0.0, limit))
    for w in words:                                         # the next removed word outwards is a hard stop
        if side == "out" and w[0] > t + 0.01:
            stop = min(stop, max(0.0, w[0] - t - 0.01))
        if side == "in" and w[1] < t - 0.01:
            stop = min(stop, max(0.0, t - w[1] - 0.01))
        # a removed word that starts (or ends) right at the cut: the fix would bring it back
        if side == "out" and w[0] >= t - 0.015 and (w[0] + w[1]) / 2 > t:
            stop = min(stop, max(0.0, w[0] - t - 0.01))
        if side == "in" and w[1] <= t + 0.015 and (w[0] + w[1]) / 2 < t:
            stop = min(stop, max(0.0, t - w[1] - 0.01))
    need = 0.0
    if score >= 0.3:
        need = stop
        for k in range(int(stop / HOP) + 1):
            tt = t + s * k * HOP
            if lv.db[lv.i(tt)] < lv.quiet and k * HOP >= chopped:
                need = min(stop, k * HOP + PAD)
                break
    why = []
    if chopped > 0.01:
        why.append(f'"{word}" {"ends" if side == "out" else "starts"} {chopped * 1000:.0f} ms '
                   f'{"after" if side == "out" else "before"} the cut')
    tail = check_tail(lv, words, t, side, removed) if removed and chopped <= 0.01 else None
    trim = 0.0
    if tail:
        run, trim, tw = tail
        score = max(score, (0.6 + 0.4 * min(1.0, run / 0.15)) if run >= TAIL_BAD else 0.45)
        need = 0.0
        why.append(f'"{tw}" (cut) {"goes on" if side == "in" else "starts"} {run * 1000:.0f} ms '
                   f'{"after" if side == "in" else "before"} the cut: a leftover of it plays')
        word = tw
    elif edge > 0.6:
        why.append("voice still loud at the edge" + (" and keeps going in the removed audio" if cont > 0.5 else ""))
    return {"score": round(score, 3), "chopped_ms": round(chopped * 1000), "word": word,
            "edge_level": round(edge, 2), "fix_ms": round(need * 1000), "trim_ms": round(trim * 1000),
            "tail_ms": round(tail[0] * 1000) if tail else 0, "why": why}


def snippet(x, segs, k, fix=None, ctx=1.0):
    """audio of the join between segs[k] and segs[k+1] as it plays in the cut, 10 ms fades
    (fix: seconds the end moves later and the start earlier; negative = inwards, a leftover trimmed)"""
    (a0, e), (s, b1) = segs[k], segs[k + 1]
    if fix:
        e, s = e + fix[0], s - fix[1]
    p1 = x[int(max(a0, e - ctx) * SR):int(e * SR)].copy()
    p2 = x[int(s * SR):int(min(b1, s + ctx) * SR)].copy()
    nf = int(SR * 0.01)
    ramp = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, nf))
    if len(p1) > nf: p1[-nf:] *= ramp[::-1]
    if len(p2) > nf: p2[:nf] *= ramp
    return np.concatenate([p1, p2]), len(p1) / SR


def wav_b64(y):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(y, -1, 1) * 32767).astype("<i2").tobytes())
    return base64.b64encode(buf.getvalue()).decode()


def norm_words(s):
    return re.findall(r"[a-z0-9']+", s.lower())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--map", help="rough_map.json from the rough-cut skill")
    g.add_argument("--edl", help='EDL json {"segments_sec": [[s, e], ...]} (Cut Editor / apply_edit.py)')
    ap.add_argument("--words", help="source-time words.json [[start, end, word], ...]")
    ap.add_argument("--audio", help="separate voice recording to listen to instead of the video's own audio")
    ap.add_argument("--offset", type=float, default=0.0,
                    help="with --audio: video time = audio time + OFFSET (e.g. the sync offset of a separate recorder)")
    ap.add_argument("--out", default="work/joins")
    ap.add_argument("--recheck", action="store_true", help="re-transcribe each join with faster-whisper")
    ap.add_argument("--model", default="small.en")
    ap.add_argument("--lang", default=None, help="language for --recheck (default: en for .en models, else detect)")
    ap.add_argument("--fix-out", help="write the cut with the fixes applied to likely-clipped joins")
    ap.add_argument("--play-order", action="store_true", help="keep the EDL in its own (play) order instead of sorting by source time; use for render EDLs with moved sections")
    a = ap.parse_args()

    segs = load_cut(a) if a.play_order else sorted(load_cut(a))
    slivers = [s for s in segs if s[1] - s[0] < SLIVER]       # leftovers from cutting: listed, then judged without
    segs = [s for s in segs if s[1] - s[0] >= SLIVER]
    words = json.load(open(a.words, encoding="utf-8")) if a.words else []
    x = read_audio(a.audio or a.source)
    if a.audio and a.offset:                      # put the recorder audio on the video's timeline
        n = int(round(abs(a.offset) * SR))
        x = np.concatenate([np.zeros(n, np.float32), x]) if a.offset > 0 else x[n:]
    lv = Level(x)
    model = None
    if a.recheck:
        try:
            from faster_whisper import WhisperModel
            model = WhisperModel(a.model, device="cpu", compute_type="int8")
        except Exception as e:  # noqa: BLE001
            print(f"--recheck skipped: faster-whisper not available ({e})")

    joins, dst = [], 0.0
    for k in range(len(segs) - 1):
        (a0, e), (s, b1) = segs[k], segs[k + 1]
        dst += e - a0
        gap = s - e                                   # removed audio between the two edges
        out = check_edge(lv, words, e, "out", gap / 2 if gap > 0 else 0, (e, s) if gap > 0 else None)
        inn = check_edge(lv, words, s, "in", gap / 2 if gap > 0 else 0, (e, s) if gap > 0 else None)
        score = max(out["score"], inn["score"])
        j = {"k": k, "dst": round(dst, 3), "src_out": round(e, 3), "src_in": round(s, 3),
             "removed_s": round(gap, 3), "out": out, "in": inn, "score": round(score, 3)}
        if model is not None:
            y, _ = snippet(x, segs, k)
            segs_txt, _ = model.transcribe(y, language=a.lang or ("en" if a.model.endswith(".en") else None),
                                          beam_size=1, vad_filter=False)
            heard = " ".join(t.text for t in segs_txt).strip()
            want = " ".join(w[2] for w in words_near(words, e, 1.0, 0) if (w[0] + w[1]) / 2 < e) + " " + \
                   " ".join(w[2] for w in words_near(words, s, 0, 1.0) if (w[0] + w[1]) / 2 > s)
            hw, ww = norm_words(heard), norm_words(want)
            common = len(set(hw) & set(ww)) / max(1, len(set(ww)))
            j["heard"], j["expected"], j["match"] = heard, want.strip(), round(common, 2)
            if ww and common < 0.7:
                j["score"] = round(min(1.0, j["score"] + 0.3 * (0.7 - common) / 0.7 + 0.15), 3)
        j["status"] = "likely clipped" if j["score"] >= 0.6 else "check" if j["score"] >= 0.3 else "ok"
        j["fix_ms"] = [out["fix_ms"], inn["fix_ms"]]
        j["trim_ms"] = [out["trim_ms"], inn["trim_ms"]]   # a leftover tail: the edges move inwards by these
        joins.append(j)

    order = sorted(joins, key=lambda j: -j["score"])
    for r, j in enumerate(order, 1):
        j["rank"] = r
    n_bad = sum(j["status"] == "likely clipped" for j in joins)
    n_chk = sum(j["status"] == "check" for j in joins)
    outp = Path(a.out)
    outp.parent.mkdir(parents=True, exist_ok=True)
    json.dump({"source": str(Path(a.source).resolve()), "cut": a.map or a.edl, "joins": order,
               "slivers": [[round(s, 3), round(e, 3)] for s, e in slivers],
               "summary": {"joins": len(joins), "likely_clipped": n_bad, "check": n_chk, "slivers": len(slivers)}},
              open(outp.with_suffix(".json"), "w", encoding="utf-8"), indent=1)

    # listening page: flagged joins first, then the rest collapsed
    def tc(t):
        m, sec = divmod(t, 60)
        return f"{int(m)}:{sec:05.2f}"
    rows = []
    for j in order:
        k = j["k"]
        y0, mark = snippet(x, segs, k)
        fx = [j["fix_ms"][0] - j["trim_ms"][0], j["fix_ms"][1] - j["trim_ms"][1]]   # ms outwards (negative: inwards)
        fix = (fx[0] / 1000, fx[1] / 1000) if any(fx) else None
        players = f'<div><span class="lab">Now</span><audio controls preload="none" src="data:audio/wav;base64,{wav_b64(y0)}"></audio></div>'
        if fix and j["status"] != "ok":
            y1, _ = snippet(x, segs, k, fix)
            players += (f'<div><span class="lab">Fixed</span><audio controls preload="none" '
                        f'src="data:audio/wav;base64,{wav_b64(y1)}"></audio>'
                        f'<span class="fx">end {fx[0]:+d} ms · start {-fx[1]:+d} ms</span></div>')
        why = "; ".join(j["out"]["why"] + j["in"]["why"]) or "clean"
        before = " ".join(w[2] for w in words_near(words, j["src_out"], 1.2, 0) if (w[0] + w[1]) / 2 < j["src_out"])
        after = " ".join(w[2] for w in words_near(words, j["src_in"], 0, 1.2) if (w[0] + w[1]) / 2 > j["src_in"])
        heard = f'<div class="heard">Heard: “{html.escape(j["heard"])}”</div>' if "heard" in j else ""
        cls = {"likely clipped": "bad", "check": "chk", "ok": "ok"}[j["status"]]
        rows.append(f'<details class="j {cls}" {"open" if cls != "ok" else ""}><summary><b>#{j["rank"]}</b>'
                    f'<span class="st">{j["status"]}</span><span class="t">{tc(j["dst"])} in the cut</span>'
                    f'<span class="why">{html.escape(why)}</span></summary>'
                    f'<p class="ctx">…{html.escape(before)} <span class="bar">|</span> {html.escape(after)}…</p>{heard}'
                    f'<div class="pl">{players}</div><p class="meta">source {tc(j["src_out"])} → {tc(j["src_in"])} · '
                    f'removed {j["removed_s"]:.2f} s · score {j["score"]:.2f}</p></details>')
    sliver_note = (f'<p class="j chk">{len(slivers)} leftover sliver{"s" if len(slivers) != 1 else ""} '
                   f'(kept pieces under {SLIVER * 1000:.0f} ms that would play as a blip) at source '
                   + ", ".join(tc(s) for s, _ in slivers) + '. They are left out of this check and of the fixed cut; '
                   'remove them in the Cut Editor too.</p>') if slivers else ""
    page = f"""<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Join check</title>
<style>:root{{--bg:#141412;--p:#1d1d1a;--fg:#ecebe6;--dim:#8d8b84;--line:#2e2e2a;--bad:#f85149;--chk:#e0a84a;--ok:#5fbf86;--acc:#ff5a1f}}
body{{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,system-ui,sans-serif;padding:24px 20px 60px}}
main{{max-width:860px;margin:0 auto;display:grid;gap:10px}}h1{{font-size:24px;margin:0}}.sum{{color:var(--dim)}}
.j{{background:var(--p);border:1px solid var(--line);border-left:4px solid var(--ok);border-radius:8px;padding:10px 14px}}
.j.bad{{border-left-color:var(--bad)}}.j.chk{{border-left-color:var(--chk)}}
summary{{display:flex;gap:12px;flex-wrap:wrap;align-items:baseline;cursor:pointer}}.st{{font:12px ui-monospace,Menlo,monospace;text-transform:uppercase;letter-spacing:.05em}}
.bad .st{{color:var(--bad)}}.chk .st{{color:var(--chk)}}.ok .st{{color:var(--ok)}}.t{{font-variant-numeric:tabular-nums;color:var(--dim)}}.why{{flex:1 1 260px}}
.ctx{{margin:10px 0 4px}}.bar{{color:var(--acc);font-weight:700}}.heard{{color:var(--dim);font-size:14px}}
.pl{{display:grid;gap:6px;margin:8px 0}}.pl div{{display:flex;gap:10px;align-items:center;flex-wrap:wrap}}.lab{{width:44px;color:var(--dim);font-size:13px}}audio{{height:32px;max-width:100%}}
.fx{{font:12px ui-monospace,Menlo,monospace;color:var(--dim)}}.meta{{margin:0;color:var(--dim);font:12px ui-monospace,Menlo,monospace}}</style>
<main><h1>Join check</h1><p class="sum">{len(joins)} joins · <b style="color:var(--bad)">{n_bad} likely clipped</b> · <b style="color:var(--chk)">{n_chk} to check</b> · worst first. The bar | is where the cut lands. Each clip plays 1 s either side of the join.</p>
{sliver_note}{''.join(rows)}</main>"""
    outp.with_suffix(".html").write_text(page, encoding="utf-8")

    if a.fix_out:
        fixed = [list(s) for s in segs]
        for j in joins:
            if j["status"] == "likely clipped":
                fixed[j["k"]][1] = round(fixed[j["k"]][1] + (j["fix_ms"][0] - j["trim_ms"][0]) / 1000, 3)
                fixed[j["k"] + 1][0] = round(fixed[j["k"] + 1][0] - (j["fix_ms"][1] - j["trim_ms"][1]) / 1000, 3)
        json.dump({"segments_sec": fixed, "from": a.map or a.edl,
                   "note": f"join_check: fixes on likely-clipped joins; {len(slivers)} slivers under {SLIVER} s removed"},
                  open(a.fix_out, "w", encoding="utf-8"), indent=1)

    print(f"{len(joins)} joins: {n_bad} likely clipped, {n_chk} to check -> {outp.with_suffix('.html')}")
    if slivers:
        print(f"{len(slivers)} leftover slivers (< {SLIVER * 1000:.0f} ms) left out: " + ", ".join(tc(s) for s, _ in slivers))
    for j in order[:8]:
        if j["status"] != "ok":
            print(f'  #{j["rank"]} {j["status"]:<14} at {tc(j["dst"])}  {"; ".join(j["out"]["why"] + j["in"]["why"])}')


if __name__ == "__main__":
    main()

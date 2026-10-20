#!/usr/bin/env python3
"""find_cuts.py: propose rough-cut edits (fillers, long pauses, stutters, retakes) from word times + audio.

  python3 find_cuts.py WORDS.json VIDEO --out work/cuts.json
        [--lang en] [--max-gap 0.4] [--keep-gap 0.3] [--keep-edge 0.3]
        [--fillers um,uh,...] [--soft like,"you know"] [--keep like,ah] [--fillers-file my_lang.json]
        [--no-retakes] [--retake-window 30] [--no-sounds]

Writes cuts.json:
  {"source", "words", "duration", "fps", "settings",
   "units": [[start, end, text, kind, word_index]],   # words plus untranscribed sounds found in the audio
   "items": [{"id", "reason": filler|silence|stutter|retake, "start", "end", "text", "confidence",
              "action": "cut"|"ask", "units": [...], "saved", "note"}]}
"cut" items are applied unless the creator vetoes them; "ask" items only if the creator accepts them.
Prints seconds saved per reason (the estimate uses the same plan apply_cuts.py uses).
"""
import argparse, json, re, sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cutlib import LANGS, TERMINAL, Energy, norm, probe, read_audio, plan_seconds, default_accepted  # noqa: E402


def csv(s):
    return [x.strip().lower() for x in s.split(",") if x.strip()] if s else []


def load_lang(a):
    L = json.loads(json.dumps(LANGS.get(a.lang, LANGS["en"])))
    if a.lang not in LANGS:
        print(f"note: no built-in filler list for '{a.lang}', using English; pass --fillers-file for yours")
    if a.fillers_file:
        extra = json.load(open(a.fillers_file, encoding="utf-8"))
        for k, v in extra.items():
            L[k] = L.get(k, []) + [x for x in v if x not in L.get(k, [])]
    if a.fillers:
        L["hard"] = [re.escape(x) for x in csv(a.fillers)]
        L["maybe"] = []
    if a.soft is not None:
        L["soft"] = csv(a.soft)
    keep = set(csv(a.keep))
    L["hard"] = [p for p in L["hard"] if not any(re.fullmatch(p, k) for k in keep)]
    L["maybe"] = [p for p in L["maybe"] if not any(re.fullmatch(p, k) for k in keep)]
    L["soft"] = [x for x in L["soft"] if x not in keep]
    return L


def is_like(a, b):
    """fuzzy token match for retakes: same word, or a contraction/inflection of it ('your' / 'you're')"""
    if a == b:
        return True
    if min(len(a), len(b)) >= 3 and (a.startswith(b) or b.startswith(a)) and abs(len(a) - len(b)) <= 2:
        return True
    return False


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("words")
    ap.add_argument("video")
    ap.add_argument("--out", default="work/cuts.json")
    ap.add_argument("--lang", default="en")
    ap.add_argument("--max-gap", type=float, default=0.4, help="pauses longer than this are shortened")
    ap.add_argument("--keep-gap", type=float, default=0.3, help="what a shortened pause keeps (0.25-0.4 sounds natural)")
    ap.add_argument("--keep-edge", type=float, default=0.3, help="silence kept before the first and after the last word")
    ap.add_argument("--lead-share", type=float, default=0.6, help="share of the kept pause placed after the previous word")
    ap.add_argument("--fillers", default=None, help="comma list replacing the hard filler list, e.g. um,uh,erm")
    ap.add_argument("--soft", default=None, help="comma list of words/phrases flagged only when clearly filler (always 'ask')")
    ap.add_argument("--keep", default="", help="comma list never to flag, e.g. like,ah")
    ap.add_argument("--fillers-file", default=None, help="JSON with hard/maybe/soft/cues/doubles lists to add")
    ap.add_argument("--retakes", action=argparse.BooleanOptionalAction, default=True)
    ap.add_argument("--retake-window", type=float, default=30.0)
    ap.add_argument("--retake-min-words", type=int, default=3)
    ap.add_argument("--extra-words", default=None,
                    help="words.json from a second pass transcribed with a filler prompt; only its fillers that fall "
                         "between the main transcript's words are added")
    ap.add_argument("--sounds", action=argparse.BooleanOptionalAction, default=True,
                    help="look for voiced sounds between words that the transcript left out (um/uh Whisper skipped)")
    a = ap.parse_args()
    L = load_lang(a)
    hard = [re.compile(p + r"$") for p in L["hard"]]
    maybe = [re.compile(p + r"$") for p in L["maybe"]]
    cues = [re.compile(r"\b" + p + r"\b") for p in L["cues"]]
    doubles = set(L["doubles"])

    words = [[float(s), float(e), str(w)] for s, e, w in json.load(open(a.words, encoding="utf-8"))]
    words.sort(key=lambda w: w[0])
    if a.extra_words:
        added = 0
        for s0, e0, w0 in json.load(open(a.extra_words, encoding="utf-8")):
            t = norm(w0)
            if not t or not any(p.match(t) for p in hard + maybe):
                continue
            if float(e0) - float(s0) < 0.08:
                continue                                   # no real length: Whisper had no timing for it
            if any(min(e0, e) - max(s0, s) > 0.3 * (e0 - s0) for s, e, _ in words):
                continue                                   # overlaps a real word: not a separate filler
            if any(abs(s - s0) < 0.6 and any(p.match(norm(w)) for p in hard + maybe) for s, e, w in words):
                continue                                   # the main transcript already has this filler
            words.append([float(s0), float(e0), str(w0)])
            added += 1
        words.sort(key=lambda w: w[0])
        print(f"extra words: added {added} fillers from {a.extra_words}")
    info = probe(a.video)
    D = info["duration"]
    en = Energy(read_audio(a.video, 16000, 1))
    in_words = np.concatenate([en.span(s, e)[1] for s, e, _ in words]) if words else en.db
    speech = float(np.median(in_words)) if len(in_words) else en.floor + 30
    thr = en.floor + 0.35 * (speech - en.floor)        # "voiced" threshold
    print(f"audio: noise floor {en.floor:.0f} dB, speech {speech:.0f} dB, voiced above {thr:.0f} dB")

    # ---- units: words (edges snapped to the audio) plus untranscribed sounds
    units = []   # [s, e, text, kind, word_idx]
    for wi, (s, e, w) in enumerate(words):
        units.append([s, e, w, "word", wi])
    # voiced runs over the whole file; silences shorter than 120 ms inside a run are closed (stop consonants)
    v = en.db > thr
    runs, k = [], 0
    while k < len(v):
        if v[k]:
            j = k
            while j < len(v) and v[j]:
                j += 1
            if runs and en.t[k] - runs[-1][1] < 0.12:
                runs[-1][1] = en.t[j - 1] + 0.01
            else:
                runs.append([en.t[k] - 0.01, en.t[j - 1] + 0.01])
            k = j
        else:
            k += 1
    rs = np.array([r[0] for r in runs]) if runs else np.zeros(0)
    re_ = np.array([r[1] for r in runs]) if runs else np.zeros(0)

    # snap word edges to the audio: Whisper's word times are often 0.1-0.3 s off, and a cut placed on them
    # clips the end of a word ("work-" instead of "works")
    orig = [(u[0], u[1]) for u in units]
    for k, u in enumerate(units):
        lo = orig[k - 1][1] if k > 0 else 0.0
        hi = orig[k + 1][0] if k + 1 < len(units) else D
        inside = np.where((re_ > u[0]) & (rs < u[1]))[0]
        if len(inside) == 0:
            continue
        r0, r1 = inside[0], inside[-1]
        s0 = max(rs[r0], u[0] - 0.25, lo)
        e0 = min(re_[r1], u[1] + 0.4, hi)
        if e0 - s0 >= 0.04:
            u[0], u[1] = float(s0), float(e0)
    for k in range(1, len(units)):          # keep order, no overlaps
        if units[k][0] < units[k - 1][1]:
            m = (units[k][0] + units[k - 1][1]) / 2
            units[k - 1][1] = max(units[k - 1][0], m)
            units[k][0] = min(units[k][1], m)
    warnings = []
    cov = [(u[0] - 0.3, u[1] + 0.3) for u in units]
    hole_s = None
    for r0, r1 in runs + [[D + 1, D + 1]]:
        covered = any(c0 <= r0 and r1 <= c1 for c0, c1 in cov) or any(min(r1, c1) - max(r0, c0) > 0 for c0, c1 in cov)
        if not covered and r0 <= D:
            hole_s = hole_s or [r0, r1, 0.0]
            hole_s[1] = r1
            hole_s[2] += r1 - r0
        else:
            if hole_s and hole_s[2] > 1.5:
                warnings.append(f"speech-like audio with no transcript from {hole_s[0]:.1f}s to {hole_s[1]:.1f}s: "
                                "the transcript has a hole (Whisper sometimes skips a whole window, more often with a "
                                "filler prompt). Re-transcribe without --prompt and pass the filler pass as --extra-words.")
            hole_s = None
    for w_ in warnings:
        print("WARNING:", w_)
    if a.sounds:
        # voiced sounds the transcript left out: Whisper often drops um/uh (see SKILL.md)
        extra = []
        bounds = [(0.0, 0.0)] + [(u[0], u[1]) for u in units] + [(D, D)]
        for (_, pe), (ns, _) in zip(bounds, bounds[1:]):
            for r0, r1 in runs:
                if r0 >= pe + 0.08 and r1 <= ns - 0.08 and 0.12 <= r1 - r0 <= 1.2:
                    _, db = en.span(r0, r1)
                    if len(db) and db.max() > thr + 6:
                        extra.append([float(r0), float(r1), "[sound]", "sound", None])
        units = sorted(units + extra, key=lambda u: u[0])
    for u in units:
        u[0], u[1] = round(u[0], 3), round(u[1], 3)
    N = len(units)
    toks = [norm(u[2]) if u[3] == "word" else "" for u in units]
    items = []

    def add(reason, uidx, conf, note, text=None, gap=None, start=None, end=None):
        conf = round(float(min(max(conf, 0.0), 1.0)), 2)
        it = {"id": 0, "reason": reason,
              "start": round(start if start is not None else units[uidx[0]][0], 3),
              "end": round(end if end is not None else units[uidx[-1]][1], 3),
              "text": text if text is not None else " ".join(units[i][2] for i in uidx),
              "confidence": conf, "action": "cut" if conf >= 0.75 else "ask", "units": list(uidx), "note": note}
        if gap is not None:
            it["gap"] = list(gap)
        items.append(it)

    def gap_before(i):
        return units[i][0] - units[i - 1][1] if i > 0 else 9.0

    def gap_after(i):
        return units[i + 1][0] - units[i][1] if i + 1 < N else 9.0

    # ---- fillers
    for i, u in enumerate(units):
        if u[3] == "sound":
            add("filler", [i], 0.45, "voiced sound between words that the transcript skipped (um/uh, a breath, a click). Listen.",
                text=f"[sound {u[1] - u[0]:.1f}s]")
            continue
        t = toks[i]
        if not t:
            continue
        if any(p.match(t) for p in hard):
            add("filler", [i], 0.9, "hesitation sound")
        elif any(p.match(t) for p in maybe):
            isolated = (u[2][-1:] in ",.…" or gap_after(i) > 0.15 or gap_before(i) > 0.25) and u[1] - u[0] < 0.7
            add("filler", [i], 0.8 if isolated else 0.5, "hesitation sound" if isolated else "may be a real 'ah' (e.g. 'ah, I see')")
    # soft fillers (phrases): only flagged when set off by a comma or a pause, never cut without approval
    soft = sorted([s.split() for s in L["soft"]], key=len, reverse=True)
    likes_ok_before = {"looks", "look", "looked", "feel", "feels", "felt", "seem", "seems", "sounds", "sound",
                       "something", "would", "i", "you", "we", "they", "he", "she", "do", "dont", "didnt", "just", "really",
                       "more", "much", "not", "is", "was", "be", "what"}
    know_ok_after = {"how", "what", "that", "the", "why", "where", "when", "if", "who", "it", "this", "about", "a", "him", "her", "them"}
    taken = {i for it in items for i in it["units"]}
    i = 0
    while i < N:
        hit = None
        for ph in soft:
            n = len(ph)
            if i + n <= N and [toks[i + k] for k in range(n)] == ph and not taken & set(range(i, i + n)):
                prev_t = toks[i - 1] if i > 0 else ""
                nxt = toks[i + n] if i + n < N else ""
                comma_after = units[i + n - 1][2][-1:] in ",…" or gap_after(i + n - 1) > 0.3
                comma_before = (i > 0 and units[i - 1][2][-1:] in ",.?!…") or gap_before(i) > 0.3
                if not (comma_after or comma_before):
                    continue
                if ph == ["like"] and not (comma_after and (comma_before or prev_t not in likes_ok_before)):
                    continue
                if ph == ["you", "know"] and nxt in know_ok_after and not comma_after:
                    continue
                hit = n
                break
        if hit:
            add("filler", list(range(i, i + hit)), 0.5, f"'{' '.join(toks[i:i + hit])}' looks like a filler here, but it can be meaningful")
            i += hit
        else:
            i += 1

    # ---- stutters: a word or short phrase said twice in a row ("I I think", "so the, so the")
    filler_units = {i for it in items if it["reason"] == "filler" for i in it["units"]}
    content = [i for i in range(N) if toks[i] and i not in filler_units]
    k = 0
    while k < len(content):
        found = False
        for n in (4, 3, 2, 1):
            if k + 2 * n > len(content):
                continue
            A, B = content[k:k + n], content[k + n:k + 2 * n]
            if [toks[x] for x in A] != [toks[x] for x in B]:
                continue
            if units[B[0]][0] - units[A[-1]][1] > (0.5 if n == 1 else 1.0):
                continue
            if units[A[-1]][2][-1:] in TERMINAL:      # "...is lighting. Lighting makes..." is not a stutter
                continue
            if any(units[x][3] != "word" for x in range(A[0], B[-1] + 1) if x not in filler_units):
                continue
            if n == 1:
                conf = 0.4 if toks[A[0]] in doubles else 0.8
                note = "may be said twice on purpose ('very very', 'that that')" if conf < 0.75 else "repeated word"
            else:
                conf, note = 0.85, "repeated phrase (false start)"
            add("stutter", list(range(A[0], B[0])), conf, note, text=" ".join(units[x][2] for x in A))
            k += n
            found = True
            break
        if not found:
            # cut-off word: "th- the", "micro- microphone"
            i = content[k]
            if units[i][2].endswith("-") and k + 1 < len(content) and toks[content[k + 1]].startswith(toks[i][:2]):
                add("stutter", [i], 0.8, "cut-off word")
            k += 1

    # ---- retakes: a later span restarts an earlier span's opening within the window; keep the last take
    if a.retakes:
        def clause_start(i):
            j = content.index(i)
            if j == 0:
                return True
            p = content[j - 1]
            return units[p][2][-1:] in TERMINAL + ",;:" or units[i][0] - units[p][1] >= 0.35 or any(
                units[x][3] != "word" or x in filler_units for x in range(p + 1, i))
        pairs = []
        for ci, i in enumerate(content):
            if not clause_start(i):
                continue
            best = None
            for cj in range(ci + 2, len(content)):
                j = content[cj]
                if units[j][0] - units[i][0] > a.retake_window:
                    break
                if not clause_start(j):
                    continue
                m = 0
                while ci + m < cj and cj + m < len(content) and is_like(toks[content[ci + m]], toks[content[cj + m]]):
                    m += 1
                if m >= a.retake_min_words and (best is None or m >= best[2]):
                    best = (ci, cj, m)
            if best:
                pairs.append(best)
        # chain attempts (1st -> 2nd -> 3rd) and merge overlaps, always ending at the start of the LAST take
        spans = []
        for ci, cj, m in sorted(pairs):
            for sp in spans:
                if sp[0] <= ci < sp[1] or ci == sp[1]:
                    if cj > sp[1]:
                        sp[1], sp[2] = cj, max(sp[2], m)
                    break
            else:
                spans.append([ci, cj, m])
        for ci, cj, m in spans:
            i, j = content[ci], content[cj]
            uidx = list(range(i, j))
            span_text = " ".join(units[x][2] for x in uidx)
            low = " ".join(toks[x] for x in uidx if toks[x])
            # how many content words the first attempt got through before its sentence ended, vs the last take
            def sent_len(c0, c_end):
                n = 0
                for c in range(c0, c_end):
                    n += 1
                    if units[content[c]][2][-1:] in TERMINAL:
                        break
                return n
            first_len = sent_len(ci, cj)
            last_len = sent_len(cj, len(content))
            conf = 0.45 + 0.08 * min(m - a.retake_min_words, 3)
            reasons = [f"{m} words repeat"]
            if any(c.search(low) for c in cues):
                conf += 0.3
                reasons.append("restart phrase")
            if first_len < last_len:
                conf += 0.15
                reasons.append("first attempt stops early")
            if cj - ci > 40:
                conf -= 0.25
                reasons.append("long span: check")
            last_take = " ".join(units[content[c]][2] for c in range(cj, min(cj + 8, len(content))))
            add("retake", uidx, conf,
                f"keeps the later take at {units[j][0]:.1f}s: \"{last_take}...\" ({', '.join(reasons)})", text=span_text)

    # ---- silences: every gap longer than max_gap (between units, plus the head and tail)
    def sil(g, s, e, where):
        add("silence", [], 1.0, f"pause {e - s:.1f}s {where}", text=f"[pause {e - s:.1f}s]", gap=g, start=s, end=e)
    if N:
        if units[0][0] > a.keep_edge + 0.05:
            sil((-1, 0), 0.0, units[0][0], "before the first word")
        for i in range(N - 1):
            s, e = units[i][1], units[i + 1][0]
            if e - s > a.max_gap:
                sil((i, i + 1), s, e, "")
        if D - units[-1][1] > a.keep_edge + 0.05:
            sil((N - 1, N), units[-1][1], D, "after the last word")

    items.sort(key=lambda it: (it["start"], it["reason"] != "retake"))
    for n, it in enumerate(items, 1):
        it["id"] = n
    data = {"version": 1, "source": str(Path(a.video).resolve()), "words": str(Path(a.words).resolve()),
            "duration": round(D, 4), "fps": str(info["fps"]) if info["fps"] else None,
            "settings": {"lang": a.lang, "max_gap": a.max_gap, "keep_gap": a.keep_gap, "keep_edge": a.keep_edge,
                         "lead_share": a.lead_share, "voiced_db": round(thr, 1)},
            "warnings": warnings, "units": units, "items": items}

    # ---- estimates: seconds saved per item and per reason, from the same plan apply_cuts uses
    fps = info["fps"]
    acc = default_accepted(data)
    base = plan_seconds(data, acc, fps=fps)
    for it in items:
        if it["id"] in acc:
            it["saved"] = round(plan_seconds(data, acc - {it["id"]}, fps=fps) - base, 2)
        else:
            it["saved"] = round(base - plan_seconds(data, acc | {it["id"]}, fps=fps), 2)
    per, prev, so_far = {}, D, set()
    for r in ("silence", "filler", "stutter", "retake"):
        so_far |= {it["id"] for it in items if it["reason"] == r and it["id"] in acc}
        now = plan_seconds(data, so_far, fps=fps)
        per[r] = prev - now
        prev = now
    data["estimate"] = {"before": round(D, 2), "after": round(base, 2), "saved_by_reason": {k: round(v, 2) for k, v in per.items()}}

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    json.dump(data, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    asks = [it for it in items if it["action"] == "ask"]
    print(f"{len(items)} proposed cuts ({len(items) - len(asks)} cut by default, {len(asks)} need the creator's call)")
    for r in ("filler", "silence", "stutter", "retake"):
        n = sum(1 for it in items if it["reason"] == r)
        na = sum(1 for it in asks if it["reason"] == r)
        print(f"  {r:8s} {n:3d} items ({na} ask)   saves {per[r]:6.1f}s by default")
    print(f"  duration {D:.1f}s -> about {base:.1f}s (-{D - base:.1f}s, {100 * (D - base) / D:.0f}%) before the 'ask' items")
    for it in asks:
        print(f"  ask #{it['id']} {it['reason']} {it['start']:.2f}s \"{it['text'][:60]}\" ({it['note'][:70]})")
    print("wrote", out)


if __name__ == "__main__":
    main()

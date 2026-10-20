"""cutlib.py: shared helpers for the rough-cut scripts (probe, audio, energy, the cut plan, time remapping).

The plan is the one place that turns "which cuts are accepted" into exact kept segments, so
find_cuts.py (its estimates), review_cuts.py (its numbers) and apply_cuts.py (the real cut) agree.
"""
import json, os, re, shutil, subprocess
from fractions import Fraction

import numpy as np

# ffmpeg / ffprobe: $FFMPEG / $FFPROBE when set, else the PATH (works the same on Mac, Windows and Linux)
FFMPEG = os.environ.get("FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = os.environ.get("FFPROBE") or shutil.which("ffprobe") or "ffprobe"

# ---------------------------------------------------------------- language lists
# hard: whole-token regexes that are always fillers (cut by default)
# maybe: tokens that are usually fillers when they stand alone (cut by default only when isolated)
# soft: words/phrases that are fillers only in some uses ("like", "you know"); never cut without approval
# cues: phrases a speaker says before restarting ("let me start that again"), they raise retake confidence
# doubles: words that are legitimately said twice in a row ("that that", "very very"), only flagged
# Add a language by copying the "en" block, or pass --fillers-file with the same keys.
LANGS = {
    "en": {
        "hard": [r"u+m+", r"u+h+m*", r"e+r+m+", r"e+r+", r"h+m+", r"m+h*m+", r"mm+"],
        "maybe": [r"a+h+", r"e+h+"],
        "soft": ["like", "you know", "i mean", "sort of", "kind of", "basically", "you see"],
        "cues": [r"let me (start|try|say|do|redo) (that|this|it)( one more time| again| over)?",
                 r"(start|try) (that|this|it) again", r"one more time", r"take two", r"scratch that",
                 r"let me rephrase", r"start over", r"from the top", r"sorry", r"no wait", r"let me restart"],
        "doubles": ["that", "had", "very", "no", "yes", "yeah", "bye", "so", "really", "many", "ha", "go", "far",
                    "more", "is", "do", "well", "okay", "ok", "right", "now", "again", "much", "long", "hey"],
    },
    # starter lists for other languages: check them with a native speaker before trusting them
    "de": {"hard": [r"ä+h+m*", r"e+h+m*", r"h+m+", r"m+h*m+"], "maybe": [r"a+h+"],
           "soft": ["also", "halt", "sozusagen", "quasi", "irgendwie"],
           "cues": [r"nochmal", r"noch einmal", r"von vorne", r"sorry"], "doubles": ["das", "ja", "nein", "sehr"]},
    "es": {"hard": [r"e+m+", r"e+h+", r"m+h*m+"], "maybe": [r"a+h+"],
           "soft": ["o sea", "bueno", "pues", "este", "sabes"],
           "cues": [r"otra vez", r"de nuevo", r"perd[oó]n", r"vuelvo a empezar"], "doubles": ["que", "s[ií]", "no", "muy"]},
    "fr": {"hard": [r"e+u+h+", r"e+u+", r"h+m+", r"m+h*m+", r"b+e+h+"], "maybe": [r"a+h+"],
           "soft": ["genre", "en fait", "du coup", "tu vois", "quoi"],
           "cues": [r"je recommence", r"encore une fois", r"pardon"], "doubles": ["que", "oui", "non", "très", "tr[eè]s"]},
    "pl": {"hard": [r"y+m+", r"y+", r"e+m+", r"e+h*", r"h+m+", r"m+h*m+"], "maybe": [r"a+h+"],
           "soft": ["no", "jakby", "w sensie", "wiesz", "po prostu", "znaczy"],
           "cues": [r"jeszcze raz", r"od nowa", r"od pocz[aą]tku", r"sorry", r"przepraszam"],
           "doubles": ["no", "tak", "nie", "bardzo"]},
}

TERMINAL = ".?!…"


def norm(tok):
    """lower-case, no punctuation (keeps inner apostrophes/hyphens out too): 'You're,' -> 'youre'"""
    return re.sub(r"[^\w]", "", tok.lower(), flags=re.UNICODE)


# ---------------------------------------------------------------- media
def probe(path):
    out = subprocess.run([FFPROBE, "-v", "error", "-show_entries",
                          "stream=codec_type,r_frame_rate,avg_frame_rate,nb_frames,width,height,sample_rate,channels:format=duration",
                          "-of", "json", str(path)], capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    info = {"duration": float(j["format"]["duration"]), "fps": None, "width": None, "height": None,
            "nb_frames": None, "sr": None, "channels": None}
    for s in j.get("streams", []):
        if s["codec_type"] == "video" and info["fps"] is None:
            r = s.get("r_frame_rate") or s.get("avg_frame_rate")
            info["fps"] = Fraction(r) if r and r != "0/0" else None
            info["width"], info["height"] = s.get("width"), s.get("height")
            if s.get("nb_frames", "N/A") not in (None, "N/A"):
                info["nb_frames"] = int(s["nb_frames"])
        elif s["codec_type"] == "audio" and info["sr"] is None:
            info["sr"], info["channels"] = int(s["sample_rate"]), int(s["channels"])
    return info


def read_audio(path, sr=16000, channels=1):
    """Decode the first audio stream to float32 [n, channels] with ffmpeg (no PyAV needed)."""
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", str(path), "-map", "0:a:0", "-vn", "-ac", str(channels),
                          "-ar", str(sr), "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, channels)


class Energy:
    """RMS level in dB of 20 ms windows every 10 ms. at(t) = level of the 20 ms window centred on t."""
    HOP, WIN = 0.010, 0.020

    def __init__(self, mono16k, sr=16000):
        x = mono16k.reshape(-1).astype(np.float64)
        hop, win = int(sr * self.HOP), int(sr * self.WIN)
        n = max(1, (len(x) - win) // hop + 1)
        idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
        idx = np.minimum(idx, len(x) - 1)
        rms = np.sqrt(np.mean(x[idx] ** 2, axis=1) + 1e-12)
        self.db = 20 * np.log10(rms + 1e-9)
        self.t = np.arange(n) * self.HOP + self.WIN / 2        # window centres
        self.floor = float(np.percentile(self.db, 10))

    def at(self, t):
        i = np.clip(np.round((np.asarray(t) - self.WIN / 2) / self.HOP).astype(int), 0, len(self.db) - 1)
        return self.db[i]

    def span(self, a, b):
        i0, i1 = np.searchsorted(self.t, [a, b])
        return self.t[i0:i1], self.db[i0:i1]


# ---------------------------------------------------------------- the plan
def build_plan(data, accepted, energy=None, fps=None, refine=True):
    """Return the list of cut regions [(start, end)] in seconds for a set of accepted item ids.

    data: the cuts.json dict (units, items, settings, duration).
    Rules: units (words and sounds) removed by accepted items disappear; the gap they leave, and any
    accepted silence, closes up to keep_gap; each cut edge moves to the quietest 20 ms window on the
    video frame grid near its target, never into a kept word.
    """
    st = data["settings"]
    units, items, D = data["units"], data["items"], data["duration"]
    keep, edge = st["keep_gap"], st["keep_edge"]
    removed, silence_ok = set(), set()
    for it in items:
        if it["id"] not in accepted:
            continue
        if it["reason"] == "silence":
            silence_ok.add(tuple(it["gap"]))
        else:
            removed.update(it["units"])
    sil_len = {tuple(it["gap"]): it["end"] - it["start"] for it in items if it["reason"] == "silence"}
    kept = [i for i in range(len(units)) if i not in removed]
    cuts = []

    def pick(nominal, lo, hi):
        """quietest frame-grid point in [lo, hi], slightly preferring the nominal point"""
        if not refine or energy is None or hi <= lo:
            return min(max(nominal, lo), hi) if hi >= lo else nominal
        step = float(1 / fps) if fps else 0.01
        k0, k1 = int(np.ceil(lo / step)), int(np.floor(hi / step))
        if k1 < k0:
            return nominal
        ts = np.arange(k0, k1 + 1) * step
        score = energy.at(ts) + 25.0 * np.abs(ts - nominal)   # 1 dB per 40 ms off target
        return float(ts[int(np.argmin(score))])

    if not kept:
        return [(0.0, D)]
    # head
    first = units[kept[0]]
    if (kept[0] > 0 or (-1, 0) in silence_ok) and first[0] > edge + 0.05:
        nominal = first[0] - edge
        e = pick(nominal, max(0.0, nominal - 0.12), first[0] - 0.02)
        if e > 0.05:
            cuts.append((0.0, e))
    # gaps between kept units
    for p, n in zip(kept, kept[1:]):
        a, b = units[p][1], units[n][0]
        L = b - a
        if L <= 0:
            if n - p > 1:   # removed units sit between overlapping timestamps: cut them out at the quietest point
                lo = min(units[k][0] for k in range(p + 1, n))
                hi = max(units[k][1] for k in range(p + 1, n))
                s = pick(lo, lo - 0.06, lo + 0.06)
                e = pick(hi, hi - 0.06, hi + 0.06)
                if e - s > 0.03:
                    cuts.append((s, e))
            continue
        subgaps = [(k, k + 1) for k in range(p, n)]
        merged = n - p > 1
        if merged:
            # close up to a natural gap: never longer than the longest pause that was already there
            # ("very very" -> "very" keeps its tight gap; "work. Um, the" -> keep_gap)
            longest = max(units[k + 1][0] - units[k][1] for k in range(p, n))
            target = min(keep, max(longest, 0.06))
            for g in subgaps:
                if g not in silence_ok and g in sil_len:   # creator vetoed shortening this pause
                    target = max(target, sil_len[g])
        elif (p, n) in silence_ok and L > st["max_gap"]:
            target = keep
        else:
            continue
        target = min(target, L)
        if L - target < 0.04:
            continue
        lead = target * st["lead_share"]
        s = pick(a + lead, a - 0.03, min(a + lead + 0.10, b - 0.04))
        e = pick(b - (target - lead), max(b - (target - lead) - 0.10, s + 0.04), b + 0.03)
        if e - s > 0.03:
            cuts.append((s, e))
    # tail
    last = units[kept[-1]]
    if (kept[-1] < len(units) - 1 or (len(units) - 1, len(units)) in silence_ok) and D - last[1] > edge + 0.05:
        nominal = last[1] + edge
        s = pick(nominal, last[1] + 0.02, min(nominal + 0.12, D))
        if D - s > 0.05:
            cuts.append((s, D))
    return cuts


def segments_from_cuts(cuts, D, fps, nframes=None):
    """Kept segments as frame ranges [(f0, f1)) on the video frame grid (or 1 ms grid without video)."""
    rate = float(fps) if fps else 1000.0
    N = nframes or int(round(D * rate))
    keep, pos = [], 0
    for s, e in sorted(cuts):
        f0, f1 = int(round(s * rate)), int(round(e * rate))
        f0, f1 = max(f0, pos), min(max(f1, f0), N)
        if f0 > pos:
            keep.append([pos, f0])
        pos = max(pos, f1)
    if pos < N:
        keep.append([pos, N])
    keep = [k for k in keep if k[1] - k[0] >= 2]          # no 1-frame slivers
    out = []
    for k in keep:                                        # merge touching
        if out and out[-1][1] == k[0]:
            out[-1][1] = k[1]
        else:
            out.append(k)
    return out, rate


def kept_duration(segs, rate):
    return sum(b - a for a, b in segs) / rate


def plan_seconds(data, accepted, energy=None, fps=None, refine=False):
    cuts = build_plan(data, accepted, energy, fps, refine)
    segs, rate = segments_from_cuts(cuts, data["duration"], fps)
    return kept_duration(segs, rate)


def default_accepted(data):
    return {it["id"] for it in data["items"] if it["action"] == "cut"}


def decide(data, reject=(), accept=()):
    acc = default_accepted(data)
    acc -= set(reject)
    acc |= set(accept)
    return acc


# ---------------------------------------------------------------- remapping
class TimeMap:
    def __init__(self, segs, rate):
        self.rows, pos = [], 0
        for a, b in segs:
            self.rows.append((a / rate, b / rate, pos / rate))
            pos += b - a
        self.total = pos / rate

    def map(self, t):
        """source time -> rough-cut time; a time inside a cut snaps to the next kept moment"""
        for s, e, d in self.rows:
            if t < s:
                return d
            if t <= e:
                return d + (t - s)
        return self.total

    def seg_of(self, t):
        for k, (s, e, d) in enumerate(self.rows):
            if s <= t <= e:
                return k
        return None

    def to_json(self, src_duration, fps):
        return {"fps": str(fps) if fps else None, "src_duration": round(src_duration, 4),
                "dst_duration": round(self.total, 4),
                "segments": [{"src": [round(s, 4), round(e, 4)], "dst": [round(d, 4), round(d + e - s, 4)]}
                             for s, e, d in self.rows],
                "how": "dst = segment.dst[0] + (src - segment.src[0]) for the segment whose src range holds the time; "
                       "times inside a cut belong to no segment"}


def remap_words(words, tm):
    out = []
    for s, e, w in words:
        mid = (s + e) / 2
        k = tm.seg_of(mid)
        if k is None:
            continue                     # the word was cut
        a, b, d = tm.rows[k]
        s2, e2 = max(s, a), min(e, b)    # clamp to its kept segment
        out.append([round(d + s2 - a, 3), round(d + e2 - a, 3), w])
    return out

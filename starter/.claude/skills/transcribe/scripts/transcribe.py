#!/usr/bin/env python3
"""transcribe.py: on-device transcription with word timestamps (faster-whisper, or MLX Whisper on Apple Silicon).

  python3 transcribe.py VIDEO_OR_AUDIO [--engine auto|mlx|faster-whisper] [--model small.en|auto] [--lang en] [--out DIR] [--device auto|cpu|cuda]
                        [--srt-max-chars 42] [--prompt "names, jargon"] [--start S --end E]
                        [--fill-out DIR] [--threads N]

Writes into DIR (default: next to the input, <name>_transcript/):
  words.json   [[start, end, "word"], ...]   exact word times, used by the other video skills
  words.txt    "0.42:Hello 0.61:world ..."    the same on one line
  <name>.srt   subtitle file, cues of up to ~42 characters / 2 lines, split on pauses and punctuation
  <name>.txt   plain transcript
--fill-out DIR also runs the rough-cut skill's filler pass (a prompt full of fillers, so Whisper writes them down)
right after the plain one, with the model already loaded, and writes the same files into DIR. One run, one model in
memory: much faster than two transcriptions side by side, which fight over the same cores.
--model auto: the best model for a verbatim transcript already on this computer (medium.en for English, else
large-v3, medium, ...). A prompt (--prompt, the filler pass) reaches every 30 s window, not only the first.
CPU threads: the performance cores on Apple Silicon (int8 Whisper on the efficiency cores slows the rest down).
--engine: mlx runs MLX Whisper (mlx-community's models) on an Apple Silicon Mac's GPU; faster-whisper runs Systran's
models on the CPU (int8) or an NVIDIA card. auto (or $STUDIO_TRANSCRIBE_ENGINE, which Video Octopus sets): MLX where
mlx_whisper imports on a native arm64 Python, else faster-whisper. Both write the same files. With --model auto and
no model of the chosen build downloaded, a downloaded model of the other build is used rather than fetching one.
The model downloads once (to the Hugging Face cache) and then works offline.
"""
import argparse, json, os, platform, shutil, subprocess, sys, tempfile, time
from pathlib import Path


def fmt(t):
    h, r = divmod(max(t, 0), 3600); m, s = divmod(r, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{int(round((s % 1) * 1000)) % 1000:03d}"


# The rough-cut skill's filler pass: a prompt full of fillers makes Whisper write them down.
FILL_PROMPT = "Umm, uh, so, like, you know, I, I mean, hmm, er, the, the..."


def hub_dir():
    return Path(os.environ.get("HF_HUB_CACHE") or Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface") / "hub")


ALIASES = {"turbo": "large-v3-turbo", "large": "large-v3"}


def fw_cached(model):
    """a faster-whisper model with its weights in the Hugging Face cache"""
    m = ALIASES.get(model, model)
    repo = (f"models--Systran--faster-distil-whisper-{m[7:]}" if m.startswith("distil-")
            else "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo" if m == "large-v3-turbo"
            else f"models--Systran--faster-whisper-{m}")
    return any((d / "model.bin").exists() for d in (hub_dir() / repo / "snapshots").glob("*"))


def mlx_repo(model):
    """mlx-community's conversion of a Whisper size (the repos Video Octopus's Setup downloads)"""
    m = ALIASES.get(model, model)
    return "mlx-community/distil-whisper-large-v3" if m == "distil-large-v3" else f"mlx-community/whisper-{m}-mlx"


def mlx_cached(model):
    d = hub_dir() / ("models--" + mlx_repo(model).replace("/", "--")) / "snapshots"
    return any((s / "config.json").exists() and any(s.glob("weights.*")) for s in d.glob("*"))


def mlx_ok():
    """MLX Whisper runs here: an Apple Silicon Mac, a native arm64 Python, mlx_whisper installed"""
    if sys.platform != "darwin" or platform.machine() != "arm64":
        return False
    try:
        import mlx_whisper  # noqa: F401
        return True
    except Exception:
        return False


ORDER = {"en": ["medium.en", "large-v3", "medium", "small.en", "small", "base.en", "tiny.en"],
         "other": ["large-v3", "medium", "small", "base", "tiny"]}


def pick_model(want, lang, cached=fw_cached):
    """--model auto: the best model for a verbatim transcript (ums, repeats and all) already downloaded."""
    if want != "auto":
        return ALIASES.get(want, want)
    english = lang in (None, "en")
    for m in ORDER["en" if english else "other"]:
        if cached(m):
            return m
    return "medium.en" if english else "medium"   # not downloaded: the first run fetches it (ask first)


def pick_engine(want, model, lang):
    """the Whisper build and model: MLX where it runs, else faster-whisper; --model auto stays with what's downloaded"""
    engine = want if want in ("mlx", "faster-whisper") else ("mlx" if mlx_ok() else "faster-whisper")
    if engine == "mlx" and not mlx_ok():
        print("MLX Whisper can't run here (it needs an Apple Silicon Mac, a native arm64 Python and mlx-whisper): faster-whisper instead")
        engine = "faster-whisper"
    if model == "auto":
        order = ORDER["en" if lang in (None, "en") else "other"]
        mine, theirs = (mlx_cached, fw_cached) if engine == "mlx" else (fw_cached, mlx_cached)
        switch = "faster-whisper" if engine == "mlx" else "mlx" if mlx_ok() else None
        other = [m for m in order if theirs(m)]
        if switch and other and not any(mine(m) for m in order):
            print(f"no {engine} model downloaded, but a {switch} one is: {switch} with {other[0]}")
            return switch, other[0]
    return engine, pick_model(model, lang, mlx_cached if engine == "mlx" else fw_cached)


def perf_cores():
    """Apple Silicon: the performance cores (int8 Whisper on the efficiency cores only slows the others down)"""
    if sys.platform == "darwin":
        try:
            n = int(subprocess.run(["/usr/sbin/sysctl", "-n", "hw.perflevel0.physicalcpu"], capture_output=True,
                                   text=True, timeout=5).stdout.strip())
            if n > 0:
                return n
        except Exception:
            pass
    return max(1, (os.cpu_count() or 2) - 1)


def pick_device(want):
    if want != "auto":
        return want
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda"
    except Exception:
        pass
    return "cpu"   # faster-whisper has no Metal backend; on Apple Silicon the CPU path is fast (int8)


FFMPEG = os.environ.get("FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"   # $FFMPEG wins when it is set


def to_wav(src, start=None, end=None):
    tmp = Path(tempfile.mkdtemp()) / "audio.wav"
    cmd = [FFMPEG, "-v", "error", "-y"]
    if start is not None:
        cmd += ["-ss", str(start)]
    if end is not None:
        cmd += ["-to", str(end)]
    cmd += ["-i", str(src), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(tmp)]
    subprocess.run(cmd, check=True)
    return tmp


def cues(words, max_chars, max_gap=0.6, max_dur=6.0):
    """Group words into subtitle cues: break on a long pause, end of sentence, length or duration."""
    out, cur = [], []
    for w in words:
        if cur:
            text = " ".join(x[2] for x in cur + [w])
            gap = w[0] - cur[-1][1]
            if gap > max_gap or len(text) > max_chars * 2 or w[1] - cur[0][0] > max_dur \
                    or (cur[-1][2][-1:] in ".?!" and len(" ".join(x[2] for x in cur)) > 12):
                out.append(cur); cur = []
        cur.append(w)
    if cur:
        out.append(cur)
    lines = []
    for c in out:
        text = " ".join(x[2] for x in c)
        if len(text) > max_chars:   # split into two balanced lines
            best, cut = 1e9, 1
            for i in range(1, len(c)):
                a, b = " ".join(x[2] for x in c[:i]), " ".join(x[2] for x in c[i:])
                if abs(len(a) - len(b)) < best:
                    best, cut = abs(len(a) - len(b)), i
            text = " ".join(x[2] for x in c[:cut]) + "\n" + " ".join(x[2] for x in c[cut:])
        lines.append((c[0][0], c[-1][1], text))
    return lines


def fw_pass(model, audio, lang, prompt):
    # The prompt goes in as hotwords, which every 30 s window gets; an initial_prompt only reaches the first one when
    # each window is decoded on its own (condition_on_previous_text=False): a filler prompt stopped working after 30 s.
    segs, info = model.transcribe(audio, language=lang, word_timestamps=True, vad_filter=True,
                                  hotwords=prompt, condition_on_previous_text=False)
    out = []
    for s in segs:
        out.append((s.start, s.end, s.text, [(w.start, w.end, w.word) for w in (s.words or [])]))
        print(f"\r  {s.end:7.1f}s transcribed", end="", flush=True)
    print()
    return out, info.language, info.language_probability


def mlx_pass(repo, audio, lang, prompt):
    # MLX Whisper has no hotwords: the prompt goes in as initial_prompt (with each window decoded on its own, the first
    # window gets it). Word times come from its cross-attention alignment, like faster-whisper's.
    import mlx_whisper
    r = mlx_whisper.transcribe(audio, path_or_hf_repo=repo, word_timestamps=True, language=lang, initial_prompt=prompt,
                               condition_on_previous_text=False, verbose=None)
    out = []
    for s in r.get("segments", []):
        out.append((s["start"], s["end"], s["text"], [(w["start"], w["end"], w["word"]) for w in s.get("words", [])]))
        print(f"\r  {s['end']:7.1f}s transcribed", end="", flush=True)
    print()
    return out, r.get("language") or lang or "?", 1.0


def collect(segs, off):
    words, text = [], []
    for start, end, t, ws in segs:
        if len(ws) >= 2 and (ws[-1][1] - ws[0][0]) / len(ws) < 0.06:
            continue   # squeezed into a few ms: a Whisper hallucination ("Thank you for watching!")
        text.append(t.strip())
        for w0, w1, w in ws:
            words.append([round(w0 + off, 3), round(w1 + off, 3), w.strip()])
    return [w for w in words if w[2]], text


def write_out(out, stem, words, text, max_chars):
    out.mkdir(parents=True, exist_ok=True)
    json.dump(words, open(out / "words.json", "w", encoding="utf-8"), ensure_ascii=False)
    (out / "words.txt").write_text(" ".join(f"{w[0]:.2f}:{w[2]}" for w in words) + "\n", encoding="utf-8")
    (out / f"{stem}.txt").write_text(" ".join(text) + "\n", encoding="utf-8")
    srt = [f"{i}\n{fmt(s)} --> {fmt(e)}\n{t}\n" for i, (s, e, t) in enumerate(cues(words, max_chars), 1)]
    (out / f"{stem}.srt").write_text("\n".join(srt), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("--engine", default=os.environ.get("STUDIO_TRANSCRIBE_ENGINE") or "auto", help="auto, mlx (Apple Silicon) or faster-whisper")
    ap.add_argument("--model", default="small.en", help="tiny, base, small, medium, large-v3, distil-large-v3 "
                    "(.en = English only), or auto: the best verbatim model already downloaded")
    ap.add_argument("--lang", default=None, help="language code, e.g. en, pl, pt (auto-detect if omitted; .en models are English)")
    ap.add_argument("--out", default=None)
    ap.add_argument("--fill-out", default=None, help="also run the rough-cut filler pass into this folder (same model, one after the other)")
    ap.add_argument("--fill-prompt", default=FILL_PROMPT, help="the filler pass's prompt (--prompt's names are added to it)")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--threads", type=int, default=0, help="CPU threads for faster-whisper (default: the performance cores)")
    ap.add_argument("--srt-max-chars", type=int, default=42)
    ap.add_argument("--prompt", default=None, help="names and jargon to spell correctly")
    ap.add_argument("--start", type=float, default=None)
    ap.add_argument("--end", type=float, default=None)
    a = ap.parse_args()

    src = Path(a.input)
    out = Path(a.out) if a.out else src.with_name(src.stem + "_transcript")
    out.mkdir(parents=True, exist_ok=True)
    engine, model_name = pick_engine(a.engine, a.model, a.lang)
    lang = a.lang or ("en" if model_name.endswith(".en") else None)
    t0 = time.time()
    if engine == "mlx":
        repo = mlx_repo(model_name)
        print(f"model {model_name} on MLX Whisper ({repo}, the Mac's GPU){'' if mlx_cached(model_name) else '; first run downloads the model'}")
        run = lambda audio, prompt: mlx_pass(repo, audio, lang, prompt)  # noqa: E731
    else:
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            sys.exit("faster-whisper is not installed. Run: python3 -m pip install faster-whisper (or install the studio's requirements.txt into its .venv)")
        dev = pick_device(a.device)
        ctype = "float16" if dev == "cuda" else "int8"
        threads = a.threads or perf_cores()
        print(f"model {model_name} on faster-whisper, {dev} ({ctype}, {threads} threads){'' if fw_cached(model_name) else '; first run downloads the model'}")
        model = WhisperModel(model_name, device=dev, compute_type=ctype, cpu_threads=threads)
        run = lambda audio, prompt: fw_pass(model, audio, lang, prompt)  # noqa: E731
    wav = to_wav(src, a.start, a.end)
    import wave, numpy as np   # decode ourselves with ffmpeg: avoids PyAV version problems
    with wave.open(str(wav)) as wf:
        audio = np.frombuffer(wf.readframes(wf.getnframes()), np.int16).astype(np.float32) / 32768
    off = a.start or 0.0
    passes = [(out, a.prompt)]
    if a.fill_out:
        passes.append((Path(a.fill_out), f"{a.prompt}. {a.fill_prompt}" if a.prompt else a.fill_prompt))
    for i, (dest, prompt) in enumerate(passes):
        t1 = time.time()
        segs, language, prob = run(audio, prompt)
        words, text = collect(segs, off)
        write_out(dest, src.stem, words, text, a.srt_max_chars)
        dur = (words[-1][1] - words[0][0]) if words else 0
        took = time.time() - (t0 if i == 0 else t1)
        print(f"{'filler pass: ' if i else ''}language {language} ({prob:.2f}), {len(words)} words, "
              f"{dur:.0f}s of speech in {took:.0f}s ({dur / took if took else 0:.1f}x real time)")
        print("wrote", dest)
    if a.fill_out:
        print(f"both passes in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()

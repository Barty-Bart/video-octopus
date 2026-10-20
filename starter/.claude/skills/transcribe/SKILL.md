---
name: transcribe
description: Transcribe raw footage on the user's own computer with a local Whisper model and get an SRT plus exact word timestamps (words.json). Checks the machine first and recommends the right model size. Use when someone has a video or audio file with no transcript, needs subtitles/SRT, or another video skill needs word times.
---

# Transcribe (on-device)

Turn any video or audio into:
- `words.json`: `[[start, end, "word"], ...]`, exact word times. **Every other video skill keys its timing to these.**
- `words.txt`: the same on one line (`0.42:Hello 0.61:world`), for tools that want plain text.
- `<name>.srt`: subtitles, cues up to about 42 characters on two lines, split on pauses and sentence ends.
- `<name>.txt`: the plain transcript.

It runs locally with faster-whisper. Nothing is uploaded. The model downloads once and then works offline.

The scripts are in this skill's folder. Commands below run from the project folder (`projects/<name>/`), where the studio is `../..`.

## 0. Video Octopus's settings

When Video Octopus started this chat, its Transcription settings are in the environment:
- `STUDIO_TRANSCRIBE=local`: this skill, on this computer. `STUDIO_TRANSCRIBE_MODEL`, `STUDIO_TRANSCRIBE_LANGUAGE` and `STUDIO_TRANSCRIBE_VOCAB` (when set) are the `--model`, `--lang` and `--prompt` to use. No model set: `--model auto`.
- `STUDIO_TRANSCRIBE=deepgram|assemblyai|openai|elevenlabs`: the creator picked a cloud service and saved its key. Transcribe through that provider's API with the key in the environment, and write the same files this skill writes (`words.json` as `[[start, end, word], ...]`, the SRT, the text). A cloud service picked without its key saved comes through as `local`: Video Octopus says so to the creator.
- Video Octopus's step briefs (Clean up, Transcribe) also spell out how, from the same settings.

## 1. Check the computer (first time)

```bash
python3 ../../.claude/skills/transcribe/scripts/hwcheck.py
```

Tell the user the summary in plain words (computer, RAM, GPU, tier) and the recommended model:

| Tier | Typical machine | Model | Speed (rough) |
|---|---|---|---|
| strong | NVIDIA 8 GB+, or Apple Silicon with 32 GB+ | `large-v3` (or `distil-large-v3`, faster, English) | faster than real time |
| ok | Apple Silicon 16 GB, NVIDIA under 8 GB | `medium` / `medium.en` | about real time |
| weak | 8 GB laptop, no GPU | `small` / `small.en` (`base` if very slow) | slower than real time, but works |
| cloud-sandbox | a hosted workspace with no GPU | `small.en` | fine for short clips |

`.en` models are English-only and more accurate for English. For any other language, or mixed languages, use the plain model and pass `--lang` (or leave it out to auto-detect).

## 2. Ask before downloading anything

Models already downloaded are in the Hugging Face cache (`~/.cache/huggingface/hub`: `models--Systran--faster-whisper-*` for faster-whisper, `models--mlx-community--whisper-*` for MLX Whisper); use one of those if it fits. Otherwise ask one short question: "Can I download a local transcription model (`<model>`, about <size>) and run it on this computer? Nothing leaves your machine." Sizes: tiny 75 MB, base 145 MB, small 480 MB, medium 1.5 GB, large-v3 3 GB, distil-large-v3 1.5 GB. On a yes, in Video Octopus use its own Download (the one in Setup's Transcription model row, with its progress there): `node "$STUDIO_OCTOPUS" models download whisper <model>` (or `mlx <model>` for MLX Whisper).

Also ask, in the same question if you can:
- the language (or "auto"),
- names, brands or jargon that must be spelled right (they go in `--prompt`).

If they say no, offer the alternatives: an SRT they already have (from their editor, YouTube Video Octopus or a captions tool), or a cloud service set in Video Octopus's Settings → Transcription.

## MLX Whisper or faster-whisper

- **MLX Whisper** (`--engine mlx`): on an Apple Silicon Mac it runs on the GPU, with mlx-community's models. It needs a native arm64 Python and `mlx-whisper` (in `requirements.txt`, Apple Silicon only).
- **faster-whisper** (`--engine faster-whisper`): Systran's models on the CPU (int8) or an NVIDIA card (CUDA).
- Video Octopus passes its pick in `STUDIO_TRANSCRIBE_ENGINE` (Settings → Transcription → the Whisper build); `--engine auto` picks MLX where it runs. Without mlx-whisper the script says so and uses faster-whisper. Both write the same `words.json`, SRT and text, so the rough cut and join check work the same.

## 3. Install (once)

Needs Python 3.9+, `faster-whisper` and ffmpeg on the PATH (`hwcheck.py` says if something is missing). Prefer the studio's own venv, so nothing is installed system-wide:

```bash
# Mac / Linux, from the studio folder
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
# Windows (PowerShell), from the studio folder
py -3 -m venv .venv; .venv\Scripts\pip install -r requirements.txt
```

ffmpeg: macOS `brew install ffmpeg`, Windows `winget install Gyan.FFmpeg`. Ask before installing anything. With the venv, run the scripts with `.venv/bin/python` (Windows `.venv\Scripts\python.exe`) instead of `python3`.

## 4. Transcribe

```bash
python3 ../../.claude/skills/transcribe/scripts/transcribe.py source/VIDEO.mp4 --model medium.en --out work/tr \
        --prompt "Claude, SAM 2, Resolve"
```

- In a studio project, write into `work/tr/` (`--out work/tr`): Video Octopus reads `work/tr/words.json`. Without `--out` the files go to `<name>_transcript/` next to the input.
- `--model auto` picks the best model for a verbatim transcript (ums and repeats kept, which the rough cut needs) already downloaded: `medium.en` for English, then `large-v3`, `medium`, `small.en`… It never downloads one.
- For a rough cut, add `--fill-out work/tr_fill`: the same run then does the rough-cut skill's filler pass (a prompt full of fillers) into `work/tr_fill/`, with the model already loaded. **Never run two transcriptions side by side**: they fight over the same cores (a 2:43 take on an Apple Silicon Mac: 4.4 min side by side, 1.5 min in one run).
- `--prompt` (and the filler pass's prompt) reaches every 30 s window: the script passes it as faster-whisper's `hotwords`. (An `initial_prompt` with `condition_on_previous_text=False` only reaches the first 30 s.)
- On Apple Silicon it uses the performance cores only (`--threads` to change it); the efficiency cores slow int8 Whisper down.
- `--start` / `--end` (seconds) transcribe one part; times in the output stay on the original timeline.
- Long video on a weak machine: test the first 60 seconds (`--end 60`) to measure speed, tell the user the estimate, then run the whole thing.
- NVIDIA GPUs are used automatically. Apple Silicon runs on the CPU in int8, which is still fast.
- ffmpeg is found on the PATH, or set `FFMPEG` to its full path.

## 5. Check and deliver

- Read the `.txt` once. Fix obvious misspellings of names in all four files (keep the times). If a word is wrong everywhere, re-run with it in `--prompt` instead.
- Whisper sometimes invents a closing line in silence ("Thank you for watching!"). The script drops lines squeezed into a few milliseconds; still glance at the last cue.
- Tell the user where the files are and what each is for: the SRT for their editor or YouTube, `words.json` for the other skills.
- Add one line to the project's `WORKLOG.md` ("Transcribed source/X.mp4 with medium.en: 1,240 words → work/tr/").

## Words to video beats

Other skills turn `words.json` into timing: put each on-screen change on the start time of the word that triggers it (clip-local time = word time − clip start). For a beat that should land "on" a word, start the motion about 0.1 s before the word, so it arrives as the word is heard.

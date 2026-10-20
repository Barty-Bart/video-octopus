---
name: join-check
description: Listen to every join of a cut and catch clipped words (half-word cuts) before any graphics are timed to the cut. Ranks joins worst first, with each one playable as it sounds now and with a suggested fix, and writes a fixed cut. Use right after rough-cut or a save in the Cut tab, before production-sheet, motion or zooms, and whenever the creator says a word sounds chopped, a cut is "clicky" or "eats a word".
---

# Join check

**Why:** cut points come from word timings, which can be a few hundredths of a second off. A cut that lands inside a word chops its start or end ("tes" for "test"). Once motion is timed to a cut, fixing it means retiming everything, so joins get checked and the cut gets locked **before** any graphics.

## Where it sits in the edit

`transcribe` → `rough-cut` (its apply step already snaps each edge to the quietest 20 ms) → **join-check** → fix in the Cut tab → **lock the cut** → production-sheet, zooms, motion, B-roll.

After the cut is locked, don't change it casually. If it must change, move the graphics with `tools/cut/apply_edit.py --retime` (or `rough_map.json`), then run join-check again on the new cut.

## Run it

The scripts are in the studio's `tools/join-check/`. From the project folder (`projects/<name>/`: source untouched in `source/`, everything new in `work/`):

```bash
# after rough-cut (uses its map and the transcript the cut was made from)
python3 ../../tools/join-check/join_check.py source/raw.mp4 \
        --map work/rough_map.json --words work/tr/words.json --out work/joins --fix-out work/edl_fixed.json

# after a save in the Cut tab (EDL in source seconds)
python3 ../../tools/join-check/join_check.py source/raw.mp4 \
        --edl work/edl_manual.json --words work/tr/words.json --out work/joins --fix-out work/edl_fixed.json
```

Use the studio's `.venv` Python if there is one (`../../.venv/bin/python`, Windows `..\..\.venv\Scripts\python.exe`); it needs numpy and ffmpeg (from the PATH, or `FFMPEG` when set). Words: the source-time transcript the cut was made from (`work/tr/words.json`, or `work/words_refined.json` / `work/editor_words.json` when the project has them).

If the voice was recorded separately (a recorder synced to the camera), add `--audio work/voice.wav --offset S` where video time = audio time + S, so the check listens to the clean voice. Add `--recheck` to also re-transcribe 1 s either side of each join with faster-whisper and compare with the words that should be there. Slower; use it on final cuts and on anything the first pass marks "check".

Outputs:
- `work/joins.html`: the listening page. Each join shows the words around it with a bar where the cut lands, why it was flagged, and two players: **Now** and **Fixed**.
- `work/joins.json`: every join with its score, worst first. Video Octopus's Cut tab reads it and marks the joins on the waveform.
- `work/edl_fixed.json`: the cut with the suggested fixes applied to "likely clipped" joins only. The input cut is never changed.

## What it flags

| Status | Meaning |
|---|---|
| likely clipped | a kept word runs past the cut; voice is loud right at the edge and keeps going in the removed audio; or a leftover: a cut word still sounding past the cut, into what's kept (a word deleted on its word times often leaves its tail, "…cally") |
| check | something is borderline; listen to it |
| ok | clean |

Leftover slivers (kept pieces under 0.12 s, usually a stray frame or two left by cutting) are listed separately at the top of the page and left out of the check and of the fixed cut.

A fix moves the edge outwards to the first quiet point plus about 30 ms of air: at most 200 ms, and never into another word. A leftover's fix moves the edge inwards instead, past the leftover to the quiet point after it, never into the next kept word (`trim_ms` in `joins.json`).

## Then

1. Tell the creator in plain words: how many joins, how many likely clipped, and the worst two or three with their times.
2. Fix them:
   - **In Video Octopus:** `work/edl_fixed.json` is the cut Video Octopus uses from then on (the Cut tab opens it until the creator saves their own, and the export plays the newer of the two), so its fixes are applied: say so, don't call them pending. `rough.mp4` isn't re-rendered for it, and doesn't need to be. The Cut tab opens the creator's last save (`work/edl_manual.json`), or the fixed cut before there is one, with the flagged joins marked on the waveform (red likely clipped, amber check). **N** jumps to the next flagged join and plays it; the creator nudges an edge if needed, and the tab saves `work/edl_manual.json` by itself. Don't start your own editor or server; point them to the Cut tab.
   - Or render the fixed cut straight away with `../../tools/cut/apply_edit.py`.
3. Run join-check once more on the saved cut. When nothing is "likely clipped", the cut is locked: write "Cut locked (join-check: N joins, 0 clipped)" in `WORKLOG.md`, then start graphics.

## Rules

- Never apply a fix the creator hasn't heard if it changes the meaning (a fix that brings back part of a cut filler or retake is their call).
- Re-check after every recut.
- The check runs on the source audio, so it works on any cut, from any tool.

## Hand-back checks: run every time you return a cut
Any time the cut changes (your fixes, a retake pass, a gap pass, a merge with the creator's save) and before saying it's ready:
1. `join_check.py ... --fix-out` and apply the fixes; repeat until "likely clipped" stops dropping. Report what's left.
2. `python3 ../../tools/join-check/seam_audit.py AUDIO --edl EDL --words WORDS --out work/seam_audit.json`: scraps (short fragments of another take spliced in, e.g. "our ✂memory, ✂so the upgraded, ✂Now"), repeated phrases (retakes that survived), long pauses. Remove obvious scraps; list repeats for the creator; never cut a retake they haven't seen unless it's a clear restart.
3. Don't trust the transcript for pauses: Whisper stretches words over silence. Don't cut pauses measured from raw audio energy without re-running join_check: doing that on a long main body once clipped two dozen word endings and had to be reverted. For tightening word gaps, `word_gaps.py` proposes a cut from a voice detector (nothing applied; it writes a proposed EDL to review).
4. When the creator is editing in the Cut tab at the same time, apply changes on top of their latest save and tell them to reload; the editor refuses stale saves (version check).

## Other helpers in `tools/join-check/`
- `refine_words.py AUDIO words.json --out work/words_refined.json`: snaps Whisper's word edges onto the real sound (no model, numpy + ffmpeg), so words sit over the right part of the waveform in the Cut tab. Video Octopus prefers `work/words_refined.json` when it exists.
- `word_gaps.py AUDIO --edl EDL --max 0.2 --proposed work/edl_gaps_proposed.json`: shortens every voiceless gap longer than `--max`, decided by faster-whisper's voice detector. Writes a proposal only.

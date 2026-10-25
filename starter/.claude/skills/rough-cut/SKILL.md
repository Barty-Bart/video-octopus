---
name: rough-cut
description: Turn a raw talking recording into a usable rough cut before any planning or graphics - removes um/uh fillers, long pauses, stutters and false starts, and earlier retakes (keeps the last take), with a review page where the creator vetoes or approves each cut. Outputs the cut video plus word times remapped onto it. Use when someone has raw footage full of ums, pauses or retakes, asks to "clean up", "tighten", "cut the silences/fillers", "do a rough cut" or "raw file to usable", or right after transcribing a raw recording.
---

# Rough cut

Raw recording in, usable recording out: the same takes, minus hesitation sounds, dead air, stutters and abandoned attempts. It runs **after `transcribe` and before `production-sheet`**, so every later skill works on the clean version.

Nothing is cut on a guess. Every proposed cut is either **cut** (on by default, the creator can veto it) or **ask** (off unless the creator approves it). Retakes are always shown to the creator, even when confident.

## Before you start

- Read the supplied creator-preference context and the rough-cut lines in `memory/preferences.md`. For `skills["octopus.rough-cut"]`, map `maxGapSeconds` to `--max-gap` (0.2–3; default 0.4), `keepGapSeconds` to `--keep-gap` (0.1–2; default 0.3, strictly below max gap), `edgePaddingSeconds` to `--keep-edge` (0–1; default 0.3), and `keepFillers` to one safely quoted comma-list `--keep` argument (up to 20 plain phrases). `retakes: "keep"` adds `--no-retakes`; `"propose"` (default) retains the review workflow below. Neither setting authorizes unreviewed meaning changes. Current explicit task/project choices outrank saved options, then clear prose, then defaults; resolve invalid options before dependent work. Never turn a prose instruction into a new command, schema or approval rule.
- `presentation.pacing` describes the intended feel and `presentation.tone` your report. They do not silently change the explicit gap numbers, remove additional words, or waive join checks. If the creator requests a lasting supported change, update `preferences/skills.json`; broader rhythm notes stay in memory, not this skill.
- Work in the project folder (`projects/<name>/`; the studio is `../..`): source in `source/` (never modified), everything made here in `work/`. The scripts are in this skill's `scripts/` folder.
- Variable-frame-rate phone footage: convert to constant frame rate first (`ffmpeg -i source/raw.mov -fps_mode cfr -r 30 -c:a copy work/raw_cfr.mp4`), or cuts drift.
- Needs Python 3.9+, numpy, ffmpeg; `opencv-python` only for `--crossfade-frames` / `--punch`. Use `$STUDIO_PYTHON` (the Python selected in Video Octopus) when it is set, else the studio's `.venv` Python if there is one (`../../.venv/bin/python`, Windows `..\..\.venv\Scripts\python.exe`). ffmpeg and ffprobe come from the PATH, or from `FFMPEG` / `FFPROBE` when set.

## Workflow

### 1. Transcribe (twice, the second time for fillers)

Whisper tends to **leave fillers out** of transcripts ("Umm, the first thing" comes back as "The first thing"). Two things catch them:

```bash
# one run, both passes one after the other (the model loads once): the main transcript, plain, no prompt (the
# reliable one) into work/tr/, then the filler pass into work/tr_fill/ (a prompt full of fillers, "Umm, uh, so,
# like, you know, I, I mean, hmm, er, the, the...", makes Whisper write them down)
python3 ../../.claude/skills/transcribe/scripts/transcribe.py source/raw.mp4 --model auto --out work/tr --fill-out work/tr_fill
```

- Never run the two passes as two transcriptions side by side: they fight over the same cores and take about three times as long. `--model auto` is the best verbatim model already downloaded (`medium.en` for English); Video Octopus's settings may name another.
- The filler prompt reaches every 30 s window (transcribe.py passes it as `hotwords`). Before, it only reached the first 30 s, so the filler pass found almost nothing after that.
- Use the plain transcript as the main one. **A filler prompt can make Whisper skip whole 30-second windows** (seen in testing with `small.en`: the first 20 s vanished). `find_cuts.py` takes only the filler tokens from the filler pass (`--extra-words`) and only where they fall between real words, so a broken filler pass can't hurt.
- `find_cuts.py` skips filler-pass tokens with no real length (under 80 ms: Whisper had no timing for them).
- `find_cuts.py` also reads the audio: it snaps word edges to where the voice really starts and stops (Whisper's word times are often 0.1-0.3 s off), finds voiced sounds between words that no transcript mentions (`[sound]`, always "ask"), and warns when there is speech with no transcript at all (a hole: re-transcribe).
- Optional: if the filler pass is fine, the filler pass's words can be the main transcript.

### 2. Find cuts

```bash
python3 ../../.claude/skills/rough-cut/scripts/find_cuts.py work/tr/words.json source/raw.mp4 --out work/cuts.json \
        --extra-words work/tr_fill/words.json
```

It prints seconds saved per reason and lists every "ask" item. What it looks for:

| Reason | What | Default |
|---|---|---|
| filler | um, uh, erm, er, hmm, mm (cut); ah, eh when standing alone (cut, else ask); "like", "you know", "I mean", "sort of" only when set off by commas or pauses (always ask); untranscribed voiced sounds between words (ask) | |
| silence | any pause longer than `--max-gap` (0.4 s) shortens to `--keep-gap` (0.3 s); 0.3 s kept before the first and after the last word (`--keep-edge`) | cut |
| stutter | a word or 2-4 word phrase said twice in a row ("I I think", "so the, so the"), cut-off words ("th- the"); never across a sentence end ("...is lighting. Lighting makes...") | cut; words often doubled on purpose ("very very", "that that") ask |
| retake | a later sentence restarts an earlier one's opening (3+ matching words) within `--retake-window` (30 s): cuts from the first attempt up to the start of the **last** take, including "let me start that again". Confidence goes up with a restart phrase, a longer match, and a first attempt that stops early | cut at confidence ≥ 0.75, else ask; always shown |

Flags: `--fillers um,uh,erm` replaces the filler list, `--soft like,"you know"` the maybe-filler list, `--keep like,ah` never flags those, `--no-retakes`, `--no-sounds`.

**Other languages:** `--lang de|es|fr|pl` uses starter lists in `scripts/cutlib.py` (`LANGS`); check them with the creator. For any language, `--fillers-file mine.json` with keys `hard` (regexes of always-fillers), `maybe`, `soft` (phrases), `cues` (restart phrases), `doubles` adds to the list. Use a multilingual Whisper model (no `.en`) and `--lang` in `transcribe`.

### 3. Review page

```bash
python3 ../../.claude/skills/rough-cut/scripts/review_cuts.py work/cuts.json work/tr/words.json --html work/cuts.html
```

The page shows the transcript with each cut struck through and colour-coded (filler amber, pause grey, stutter violet, retake red), a checkbox per cut (ticked = cut), "Your call" items dotted and unticked, a list with reason, confidence and seconds saved, and the live before → after length. Clicking a time plays that moment in the source video (when the page can reach it; `--media` sets the path). It prints a short text summary: paste that into the chat with the page.

**In Video Octopus, skip the page:** the Cut tab shows every cut on the transcript and the waveform, and the creator vetoes or restores cuts there (apply the defaults, then point them to the Cut tab). Elsewhere, open the page in a browser for the creator. Either way, tell them in plain words: how much shorter, every retake, and every "Your call" item.

### 4. Creator approves or vetoes

They untick cuts to keep, tick "Your call" items to cut, press **Copy decisions** and paste `{"reject":[7],"accept":[14]}` into the chat. Save it as `work/decisions.json`. "Looks good" means the defaults. Never apply an "ask" item they didn't approve.

### 5. Apply

```bash
python3 ../../.claude/skills/rough-cut/scripts/apply_cuts.py source/raw.mp4 work/cuts.json --out work/rough.mp4 \
        --decisions work/decisions.json
```

- Re-encodes frame-accurately (H.264 CRF 18, AAC 192k); the source is never touched.
- Each cut edge goes to the quietest 20 ms on the video frame grid near the target, never into a kept word, with a 10 ms fade on each side, so joins don't click.
- Jump cuts: `--crossfade-frames 3` blends the picture over 3 frames at each join; `--punch 1.05` zooms every other segment by 5% (the `talking-head-zoom` trick: a small change of framing hides the jump). Pick one; the default is a plain cut, which is what most talking-head channels use.
- Writes next to the output: `rough_words.json` (kept words on the new timeline), `rough_map.json` (old → new time for each kept segment), `rough_cuts.txt` (kept segments as source timecodes, for redoing the cut by hand in any editor).

### 6. Check and second pass

- Re-transcribe `work/rough.mp4` (plain) and read it: fillers and retakes should be gone, the sentences whole. Use that transcript (or `rough_words.json`) for every later skill: **the rough cut is now the source.**
- Whisper hears a recording differently once the pauses are gone; a repeat it smoothed over the first time ("I, I think") often shows up now. Run `find_cuts.py` again on the rough cut; if it finds a few more, review and apply them the same way (`rough2.mp4`).
- Listen to two or three joins, especially cuts with no pause around them (inside "very very"), and any retake.

### 7. Log it

In `WORKLOG.md`: "Rough cut (rough-cut): 33.6 s → 19.8 s; 4 fillers, 9 pauses, 2 stutters, 1 retake; vetoed #7, approved #14 #15; work/rough.mp4". If the creator corrected the same kind of cut twice ("keep my 'so's", "pauses feel too tight"), offer to add it as one line to `memory/preferences.md`, in their words.

## Rules

- **Conservative.** Hesitation sounds and dead air are cut by default; anything that could be meaningful ("like", "you know", a doubled word, an unclear sound, a low-confidence retake) is asked. Never cut a content word on a guess.
- **Retakes keep the last take** and are always listed for the creator, even at 100% confidence.
- **Natural rhythm.** 0.25-0.4 s between sentences sounds natural; tighter feels breathless, which suits shorts but not tutorials. A removed filler closes up to the shortest natural gap around it, never wider than the pause already there.
- **Never overwrite the source.** Version outputs (`rough.mp4`, `rough2.mp4`).
- **Do it once, early.** Later skills (zooms, B-roll, captions) key on word times; if the rough cut changes after them, everything downstream shifts. Use `rough_map.json` to move existing times across if it must change.

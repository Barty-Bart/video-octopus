@AGENTS.md

# This studio

This folder is a video studio: the projects, notes, skills and tools Claude uses to edit the creator's videos. Video Octopus (the app) starts Claude with this folder as its working folder, so every chat reads this file, the skills in `.claude/skills/` and the notes in `memory/`. The app lives elsewhere and its updates never change this folder: it belongs to the creator.

## Folders
- `projects/<name>/`: one folder per video.
  - `source/`: the recordings. **Never change, move or re-encode these files.**
  - `work/`: everything made along the way (transcripts, cuts, the production sheet, scene files, check stills).
  - `renders/`: videos to watch, with version numbers (`<project>_intro_v2.mp4`); never overwrite a render.
  - `WORKLOG.md`: one line per step done. `project.json`: Video Octopus's settings for the project (its format, blocks, canvas layout).
- `recordings/`: recorder takes Video Octopus lists under Recordings.
- `BRAND.md` (who the creator is, what they make, tone, colours, fonts, the brand files in `library/brand/`; Video Octopus's Setup writes it) and `STYLE.md` (the fuller style guide, when there is one): the studio's own style. **Read them before planning or building anything.**
- `memory/`: what you know about the creator. `preferences.md` (how they want edits done) and `style.md` (brand and style). **Read both before any edit**; they win over the defaults in the skills.
- `library/`: reusable things for every project (brand files, backgrounds, sounds, styles, components, B-roll, stills, resources). See `library/README.md`.
- `.claude/skills/`: one skill per step (below), plus `object-separation` (a person or an object cut out of the background, on this computer: masks in a project's `work/objsep/<name>/`; its model is picked and downloaded in Video Octopus's Setup, never by the skill). `tools/`: join check (`tools/join-check/`) and `tools/cut/apply_edit.py` (render a saved cut, re-time graphics), used by the skills. The Cut Editor is built into Video Octopus's Cut tab.
- `.studio/`: Video Octopus's files about this studio. `formats.json` adds or changes formats and Short styles (merged over the app's own); `starter.json` records what the starter put here.

## The order of work
1. **Transcribe** (`transcribe`) → `work/tr/words.json` + SRT.
2. **Rough cut** (`rough-cut`) → `work/rough.mp4`, `work/rough_map.json`, `work/rough_words.json`.
3. **Join check** (`join-check`) → `work/joins.json`, `work/edl_fixed.json`.
   Video Octopus's **Prepare** step runs 1–3 in one go and only stops when it needs the creator.
4. **Fix in the Cut tab**: the creator restores or removes cuts and nudges joins in Video Octopus's Cut Editor; it saves `work/edl_manual.json`. Don't start your own editor or review pages; point them to the Cut tab.
5. **Lock the cut**: join check on the saved cut, fix what's clipped, then write "Cut locked (join-check: N joins, 0 clipped)" in `WORKLOG.md`.
6. **Plan scenes** (`production-sheet`) → `work/production.json`, approved by the creator before anything is built.
7. **Edit**: build the scenes, zooms (`talking-head-zoom`), graphics, B-roll and sound from the sheet, into `renders/`, with the motion-graphics skills in `.claude/skills/` where one fits, and `object-separation` for anything behind or around the speaker or a product (text behind them, a new background, a highlight).
8. **Review**: the creator leaves notes per scene in Video Octopus's Scenes tab (`work/notes.json`); work through them, re-render, reply on each note.
9. **Export** from Video Octopus.

**Graphics are only timed to a locked cut.** If the cut changes after that, move every time across to the new cut (`tools/cut/apply_edit.py --retime`, or the cut maps) and run join check again.

## Rules
- **Render on this computer.** ffmpeg, Playwright, transcription and any models run locally; nothing is uploaded unless the creator asks. Use the cores you have and run renders in parallel where you can.
- **Keep the voice dominant.** Sound effects and music sit well under the speech; leave a sound out rather than use a bad one.
- **Show short snippets first** (a few seconds, or check stills) before rendering a whole video. When the direction is open, offer 2–3 variations to pick from.
- **Don't make things up**: real names, prices, features and links only; mark anything unconfirmed, and label planned things "in development".
- Graphics complement what's said instead of repeating it. A brand's own material uses that brand's font and colours.
- Log each step in the project's `WORKLOG.md` (one line: what, the numbers, the output file).
- "Our style" or "house style" in a brief means `BRAND.md`, `STYLE.md`, `memory/style.md`, `memory/preferences.md` and the look of the projects the creator approved.

## Remembering
- When the creator states a lasting preference ("pauses feel too tight", "never a zoom on the outro"), add **one line to `memory/preferences.md`, in their words** (dated). Brand and style facts (fonts, colours, logo, the look) go in `memory/style.md`. Always write them to these files, not only to your own memory: the files travel with the studio and every session reads them.
- Don't add guesses, and don't remove lines unless the creator says so. Unsure where it goes: `memory/preferences.md`.
- Reusable pieces (a sound, a background, a card, a component) go into `library/`, with one line in that folder's `INDEX.md` (what it is, where it came from, licence, date).

## Running the scripts
- Commands in the skills run from the project folder (`projects/<name>/`), so the studio is `../..`.
- Python: the studio's `.venv` when it has one (`.venv/bin/python` on Mac and Linux, `.venv\Scripts\python.exe` on Windows), else `python3` (Windows: `py -3` or `python`). `requirements.txt` lists what the skills need; ask before installing anything.
- ffmpeg and ffprobe come from the PATH, or from `FFMPEG` / `FFPROBE` when set. For H.264 use `h264_videotoolbox` on a Mac and `libx264` elsewhere.

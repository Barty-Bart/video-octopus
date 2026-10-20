# Cut Editor

A local, transcript-based editor for a talking-head take: the transcript on one side, the waveform with every word above its sound underneath, and the video. Cut by deleting words or by dragging an exact range on the waveform; playback skips the cuts; saving writes the kept segments into the project, and Claude renders from them.

**In Video Octopus** this is the **Cut** tab: Video Octopus starts `server.py` on the project's newest words, cut and join files and shows the page inside the app with `?autosave=1` (it saves about a second after each change and tells Video Octopus through `postMessage`). You don't need to run anything by hand.

## Run it on its own
From the project folder (`projects/<name>/`):
```
python3 ../../tools/cut-editor/server.py --video source/raw.mp4 --words work/tr/words.json \
        --edl work/edl_fixed.json --out work/edl_manual.json --joins work/joins.json --port 8792
```
then open http://127.0.0.1:8792. Opened on its own, it saves only on **Save** / ⌘S (Ctrl+S on Windows).

- `--words`: `[[start, end, word], ...]` in source seconds (the transcribe skill's `words.json`, or `work/words_refined.json`).
- `--edl`: `{"segments_sec": [[start, end], ...]}`, the kept parts in source seconds (the rough cut's segments, or join-check's `edl_fixed.json`). The page opens on `--out` instead if it exists, so work carries over.
- `--joins`: `joins.json` from `tools/join-check/join_check.py`; flagged joins are marked on the waveform and **N** jumps to the next one.
- Needs Python 3.9+ with numpy, and ffmpeg / ffprobe (from the PATH, or `FFMPEG` / `FFPROBE`). Binds to 127.0.0.1 and serves the video with Range requests so seeking works. Nothing is uploaded.
- Apply a save to an edit: `python3 ../../tools/cut-editor/apply_edit.py OLD_EDL NEW_EDL SOURCE.mp4 OUT.mp4 --retime scene.html ...` renders the new cut and moves every decimal time in the listed graphics files to the new timeline (backups `*.bak`; check the diff).

## Using it
- **Collapse cuts** (on by default, key C): the waveform shows the edited timeline only, cut parts hidden and kept audio joined up; thin red lines mark the joins. Turn it off to see the whole take and restore or drag edges.
- **Word bubbles** (collapsed mode): every kept word is a bubble above the waveform. Drag a bubble ◀ to erase what comes before it, ▶ to open hidden audio before it.
- Select ranges by dragging on the waveform or the transcript, then Delete. `/` splits at the playhead.
- **Trimming at a cut:** grab the red line itself (left half = the part before, right half = the part after) and pull. "Highlight first" shows what you trim in red and what you bring back in blue, and closes the trim when you let go. "Fine-trim pop-up": click a cut without dragging for a close-up of just that cut (←/→ and ⇧←/→ nudge a frame, Esc closes). Video Octopus passes these from Settings → Editing as `?trim=hl,lens`.
- **Scrub while trimming:** while you drag an edge the picture follows it, a corner inset shows the other side of the join, and a short blip of sound plays (**Scrub sound** in the header turns it off).
- **Deleting words** cuts to a safe edge: each side goes to the quietest moment between the deleted word and its neighbour (Whisper often ends a word before its sound does, so cutting on its word times would leave the tail in, "…cally"), or with no gap there, the quietest point near the word's edge. With **Snap cuts to silence** off, cuts land exactly where you put them.
- **The cut opens exactly as its file has it**, however short a cut is (a 2-frame cut stays), so a save changes only what you changed.
- **Tidy** (Edit menu, only when you ask, undoable): drops wordless slivers under 0.3 s and closes micro-cuts under 0.08 s.
- Speed 1–3× (keys 1–3), timecoded comments (M, saved to `editor_notes.json` next to `--out`).
- Saves are versioned: a save made on an older version of the file is refused, so two editors (or the editor and Claude) can't overwrite each other.

Keys: Space play/pause (cuts skipped) · click a word = jump · drag words or waveform = select · Delete cut · R restore · J hear the nearest join · N next flagged join · ⌘Z undo · ⌘S save · ←/→ one frame · ⌘+scroll zoom.

## For Video Octopus
Every save posts `{type: 'studio:cut-saved', base, segments, length}` to the parent window (the cut as the editor opened it, and now), and the editor accepts `{type: 'studio:cut-goto', t}` (edited seconds) to centre on the nearest cut. Keep both when you change the page.

**Video Octopus's look** (`index.html?theme=studio&studio=<Video Octopus's address>`, which Video Octopus's Cut tab passes): the page then loads `studio.css` and `studio.js` from this folder (`server.py` serves them) and nothing else changes for the page on its own. In that look:
- Video Octopus's light colours and its Geist font (read from Video Octopus's `/fonts/`), and a tidier header: lengths and playhead, Undo, **Edit** (Cut selection, Restore, Hear join, Tidy), **Options** (source, Speed, the toggles), **?** (the keys), autosave and Save. Every feature is still there.
- The transcript shows a time at the start of each paragraph, "pause 2.7 s" chips where the cut removes half a second or more of a pause, ▼ marks at the joins `--joins` flags, and amber words for the parts Video Octopus says still need your ear.
- The page talks to Video Octopus's Cut inspector: it posts `studio:cut-ready`, `studio:cut-state` (`segments`, `length`, `duration`, `sel`: the selection's words, length and whether it is kept or cut) and `studio:cut-flushed`; it takes `studio:cut-review` (the amber parts) and `studio:cut-do` with `op` `cut-sel`, `restore-sel`, `play-sel`, `play` (`a`, `b`, `pad`, `raw` = as recorded), `select`, `keep` / `cut` (`ranges`, one undo step) and `save` (save now). Every one is the page's own edit, so undo, autosave and the change package work as usual. Messages are only taken from the parent window.
- Video Octopus's look (Settings → Appearance): Video Octopus adds `&look=<id>` and, for any look but Edit Bay, the look's colours (`rgba()`), radii and fonts after `#look=`, then posts `studio:look` with the same whenever it changes (only taken from Video Octopus's address). The page's colours, the waveform's and the fine trim's follow it (the fonts come from Video Octopus's `/fonts/`); with no look, or Edit Bay, it keeps the light colours above, exactly as before.

Keep `index.html` under 64 KB: Video Octopus checks the editor is up by loading the page, and older Studios crash on a bigger one (that is why Video Octopus's look lives in its own two files).

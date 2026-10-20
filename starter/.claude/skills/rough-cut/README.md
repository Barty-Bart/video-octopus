# rough-cut

Raw recording to usable recording. Claude finds the ums and uhs, long pauses, stutters ("I I think", "so the, so the") and retakes (you restart a sentence: it keeps your last take), and shows them on a review page: your transcript with every cut struck through and colour-coded, a tick box per cut, and the new length. Untick what should stay, tick the "Your call" items you want gone, press **Copy decisions**, paste it into the chat. Claude then cuts the video, with joins placed in silence so they don't click, and hands every later skill the word times on the new timeline.

**Use it:** in Video Octopus it's part of the Prepare step (or Rough cut in the step rail's ⋯ menu). In Claude Code, right after transcribing, ask for "a rough cut" or "cut the ums and pauses".

**Nothing is cut on a guess:** fillers and dead air are cut by default; anything that might be meaningful ("like", "very very", an unclear sound, an unsure retake) waits for your yes. Your source file is never changed. Your preferences ("keep my 'so's", "longer pauses") go in the studio's `memory/preferences.md`.

**Requirements:** Python 3.9+, numpy, ffmpeg, and a transcript from the `transcribe` skill. `opencv-python` only for crossfades or punch-ins at cuts.

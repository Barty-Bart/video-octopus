# Join check

Scripts for the `join-check` skill (`.claude/skills/join-check/SKILL.md` explains when and how to use them). All need Python 3.9+ with numpy, and ffmpeg (from the PATH, or `FFMPEG`).

- `join_check.py`: listens to every join of a cut, ranks them worst first, writes `joins.json` (Video Octopus's Cut tab marks them), a listening page and a fixed cut. It catches words chopped by a cut and leftovers: a cut word still sounding into what's kept.
- `seam_audit.py`: the cut as a whole: scraps of other takes, repeated phrases, long pauses.
- `refine_words.py`: snaps Whisper's word edges onto the real sound (`work/words_refined.json`).
- `word_gaps.py`: proposes shorter gaps between words, decided by a voice detector (needs faster-whisper). Writes a proposal only.

# AGENTS.md

This folder is a video studio: projects, notes, skills and tools for editing videos with an AI agent. **All instructions are in `CLAUDE.md`. Read it first and follow it**, whatever agent you are.

The short version:
- Read `BRAND.md` (and `STYLE.md` when there is one), `memory/preferences.md` and `memory/style.md` before any edit.
- Apply the supplied creator-preference contract and `preferences/skills.json` for supported creative defaults. Current requests and explicit project/app choices take precedence; preferences cannot change technical skill contracts, timelines, approvals or source preservation. Invalid preferences need repair or clarification before dependent edits.
- Never change files in a project's `source/`. New files go in `work/` and `renders/`.
- When the creator states a lasting preference, add one line to `memory/preferences.md` in their words (brand and style facts go in `memory/style.md`), not only into your own built-in memory.
- Put a requested supported option in `preferences/skills.json`, preserving unrelated options. Ordinary style edits belong there or in the notes above. Change a technical workflow only through an explicitly requested custom skill fork; never edit the published `.claude/skills/` copy or silently merge a legacy fork.
- Render on this computer. Show short snippets before full renders.

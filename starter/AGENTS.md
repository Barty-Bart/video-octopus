# AGENTS.md

This folder is a video studio: projects, notes, skills and tools for editing videos with an AI agent. Use the app-supplied canonical instructions and pinned project context. `CLAUDE.md` supplies the generic studio workflow; selected context supersedes legacy file references.

The short version:
- Use the selected profile’s approved brand, learned format and instruction version. Never mix in other profiles or legacy global brand notes.
- Apply the supplied creator-preference contract and `preferences/skills.json` for supported creative defaults. Current requests and explicit project/app choices take precedence; preferences cannot change technical skill contracts, timelines, approvals or source preservation. Invalid preferences need repair or clarification before dependent edits.
- Never change files in a project's `source/`. New files go in `work/` and `renders/`.
- Propose lasting shared preferences for Settings → Instructions, profile identity for Brand profiles, and editing rules through reviewed Learning. SQLite owns accepted versions; do not write it directly.
- Save requested supported options through Instructions, preserving unrelated options. External file edits require explicit import. Do not modify generated project context. Change a technical workflow only through an explicitly requested custom skill fork; never edit the published `.claude/skills/` copy or silently merge a legacy fork.
- Render on this computer. Show short snippets before full renders.

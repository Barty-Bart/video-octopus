# Learning and local SQLite storage

Introduced in v0.1.0-beta.2. It uses Node's built-in SQLite:
Node 22.13+ on the 22.x line or 23.4+ (Node 24 recommended). No database server,
package installer or hosted service is required. See the
[Node 22.13 release note](https://nodejs.org/en/blog/release/v22.13.0).

## Where things live

New studios default to local application data: `~/Library/Application Support/Video Octopus/Studio`
on macOS, `%LOCALAPPDATA%/Video Octopus/Studio` on Windows, and
`$XDG_DATA_HOME/video-octopus/studio` (normally `~/.local/share/...`) on Linux.
Users can choose another location. Existing studios stay in place.

`<studio>/.studio/studio.sqlite` is authoritative for:

- Skill content, content hashes, ownership/selection and retained skill versions.
- Creator profiles, their versioned brands, uploaded image/font bytes and format definitions.
- Shared instruction documents and supported preferences, including retained versions.
- Brand research sessions, evidence and reviewed approvals.
- Learning sessions, references, review revisions and approvals.
- Approved rules, workflow skill content, reusable asset bytes and version history.
- Project pins for brand, instructions, selected skill snapshots and learned formats, plus scene-plan approval tokens.

Video/audio, intake originals, extracted frames and editor working documents remain
ordinary files. Existing project/timeline JSON interfaces and technical application
settings are not wholesale converted into database blobs in this change.
The app manages their locations; users do not need to organize skill folders.

Agent tools still require files. `.claude/skills/`, `skills/custom/`,
`skills/overrides/` and approved learning-package folders are projections/working
copies. SQLite retains their accepted content. Do not treat generated JSON manager
state as authoritative. Missing skill publications regenerate on startup; changed
working files require explicit **Refresh / import file edits** or **Rebuild agent files**.
Rebuild retains displaced files in the publication backup. Explicit import can also
record intentional deletions/disabled choices; review them in the Skills screen.

## Skills and app updates

**Core**, **Customized core** and **Personal** distinguish ownership in Skills.
Read/edit a core skill to create a saved customized version. Personal skills can
be created in the app or imported through the existing GitHub installer. Learned
workflows are personal skills with an exact learning-version applicability rule.
Each skill card has a short explanation stored in its SQLite snapshot. Read/edit lets you change the explanation separately from the workflow: explanation-only edits retain Core ownership. Personal explanations survive sync and restore with skill history. Existing skills receive a local summary without model calls.

Core updates retain personal content and the existing API compatibility gates.
All three agent adapters use a checked publication. New projects receive selected
skills from their pinned snapshot; unscoped chats use the active studio publication.

First migration applies the existing conservative ownership rules to legacy files,
then atomically records accepted state and deduplicated content in SQLite.
The filesystem journal backs up displaced roots. SQLite is the commit point:
interruption before its transaction commits rolls publication back; interruption
afterwards completes bookkeeping. Skill history can restore a database snapshot;
restored choices remain held until the creator resumes updates. Power-loss testing
and large-library performance remain unverified.

No updater automatically merges Markdown. An external edit cannot silently replace
canonical content during startup. A missing/corrupt database is not reconstructed
from generated state once the studio has migrated; use a database backup.

## Learning workflow

1. Choose a channel/brand/series profile and a format in Learning. Profiles are
   shared with Brand settings and New video. Each profile's formats learn
   separately, even if two channels both have a format called Shorts.
2. Click **Learn this format** to open an examples-first workspace. Drop videos,
   images or other supported files, paste URLs (one per line) and click Add links,
   or add written observations. Guidance is optional. New sessions automatically
   discover supported patterns across scripting, pacing, visuals, captions, sound
   and knowledge; earlier sessions keep their chosen scope. Study settings holds
   the optional name and depth. Settings save when adding examples or starting
   learning, or with Save study settings. Uploads are copied, limited to 512 MB
   each and 20 references per session; original files are untouched. Successful
   batch items remain if a later item fails.
3. Optionally extract local video frames. Overview samples up to about 30 frames
   per video. Detailed extraction uses up to four frames/second, at most five
   minutes per video and 2,400 frames per session. Coverage receipts identify
   unexamined spans; resumptions reuse completed references. Nothing downloads or
   selects a model. Links and transcription are handled by the chosen agent/tools.
4. Click **Learn from these examples** with the configured Claude Code, Codex or Pi adapter. A separate
   chat uses manual permissions and a session working directory. References are
   evidence, not instructions. This is **not an OS filesystem sandbox**: permissions
   and review still matter. The agent must report inaccessible sources and gaps;
   images alone cannot establish timing or sound. This discovers patterns in
   supplied references, not an automatic search for reference videos. Provider
   access and study quality need real-user testing.
5. Review `work/proposal.json`: each rule needs a stable ID, selected focus area,
   confidence and an observation citing an actual session reference. Keep, edit or
   discard each rule. Review the workflow and linked reusable assets too. This
   checks structure and source identity, not the truth of the model's conclusions.
6. Approval activates a new format version. Stale proposals, session revisions or
   competing active-version changes are rejected. Unrelated rules survive;
   discarded replacements preserve their prior rule. Removing an existing rule is
   explicit. Assets are a reviewed replacement collection, or inherited when empty.
7. Start a project with an idea, script or footage/narration. The project pins the
   exact approved version. New approvals and format rollback do not change it.
   Use the existing script editor, prompter and recorder. A project upgrade shows
   the old/new rules and requires a deliberate save.
8. For learned projects, the step rail requires a locked cut before planning/building
   and explicit approval of the current scene plan before Build. Changing the plan,
   cut or learned version invalidates that approval. Full-build preference still
   preserves checkpoints. Free-form agent chat is governed by its instructions and
   permissions; these UI gates are not an agent execution sandbox.
9. Use **Learn from this project** for a structured recap and another reviewed
   learning version. No weekly schedule is enabled.

One active package per profile/format is supported. Named sibling style variants,
weekly rollups, timed overlays and After Effects export remain later work.
Faceless workflows use imported/recorded narration; no TTS provider is selected.

## Profiles, presets and reusing formats

A profile is a channel, brand or series. A format is a repeatable video style
with its own approved guide and learning history. For example, one channel can
have long-form explainers and Shorts, while a second channel has its own formats.
**Video setup** selects one of the existing workflow presets (on-camera long-form,
voiceover long-form, Short/Reel or product explainer). **Your format name** is a
custom label; several formats can use the same preset and learn different styles.

**Copy an existing format** starts a new format in the selected profile from a
reviewed approved version. It copies rules, workflow, reusable assets and personal
skill selections, and records the source profile/format/version. It does not copy
profile brand settings or draft sessions. Evidence remains linked to the retained
original study. Check the guide and assets for channel-specific text or logos.
The new format begins at version 1 and learns independently; changing either copy
does not change the other or existing pinned projects. Stale source-version reviews
are rejected. This is an independent copy, not a live-linked shared format.

Personal skills are studio-wide and can be selected by formats across profiles
through **Format skills**. Learned packages keep their exact-version applicability;
copy a format to reuse its complete approved package. Source media stay in place.

## Brand profiles, instructions and New video

**Brand profiles** owns identity, audience, voice, colours, fonts, guidance and uploaded
brand assets. A profile can have several learned formats. Each format can select
additional enabled personal skills in Learning → Format skills; enabled compatible
core skills are included automatically. The approved learned package is selected
separately and supplies its rules, workflow and reusable assets.

Setup and Settings share the same optional profile onboarding. Enter a brand manually
or give a public website to a dedicated research session using the configured agent.
Review the proposed fields and source observations, edit them, then approve. Approval
writes a new immutable brand version only to that profile. Missing browsing tools must
be reported, not replaced with invented evidence. This uses normal agent permissions,
not an OS or network sandbox. Website quality and real-provider behaviour need live
validation; automated tests use a fake agent and synthetic observations.

**Instructions** edits and versions shared `CLAUDE.md`, `AGENTS.md`, `PROMPT.md`,
`INSTRUCTIONS.md`, existing `memory/*.md` and `preferences/skills.json` in SQLite.
First migration imports these known files once and retains the originals. Existing
`BRAND.md`/`STYLE.md` become one “Imported studio” profile, never every profile.
Legacy library assets remain in place: upload the desired images/fonts to the correct
profile explicitly. A missing canonical database cannot be replaced by generated files.
External instruction edits require explicit import; rebuilding preserves displaced
edits under `.studio/instruction-recovery/`. Keep brand-specific prose in its profile.

**New video** lets you choose a profile and approved learned format, or no brand and
no learned format. It previews the selection, validates compatible enabled skills,
and pins exact brand, instruction, skill and learned versions. Generated files under
`<project>/.octopus/context/` give the agent its selected context. Brand palettes are
available to the editor; instructions/format guidance inform the agent's planning.
This does not automatically render or redesign a video. Explicit project choices
still win. **Video defaults** retains background and framing controls; brand colours
and font guidance now live in Brand profiles.

Later profile edits apply to new videos, preserving existing project pins. A deliberate
learned-format upgrade retains the project's brand and instructions while selecting
the upgraded format and its current skills. Generated context edits stop use until
restored explicitly; displaced files are retained. Old projects without a context pin
remain legacy projects; no bulk migration or inferred profile assignment occurs.

## Backups and recovery

Storage provides a consistent SQLite backup (`VACUUM INTO`) plus approved package
projections. The database includes approved skills, guides, brand assets, brand/instruction histories
and project context pins.
It does **not** back up large media or draft intake: copy those files separately for
machine-loss recovery. A backup is stored under `.studio/learning-backups/<id>/`.

Full restore verifies integrity and a review token, blocks while work is active,
keeps the displaced database, and rebuilds agent skill files. It refuses a backup
that lacks versions or context records pinned by current projects, or predates
canonical profile/instruction storage after migration. It does not roll back media or editor
files. Format history can instead change the active version for future projects;
skill history can restore a prior skill snapshot. Neither rolls back application code.

Approved package files can be regenerated from SQLite; externally edited copies are
retained separately. Skills saved through the editor are versioned in SQLite.
Raw database edits are unsupported. Back up before moving storage, and move the
whole studio, not just the generated skill folders.

## Verification

Run `node --test test/*.test.mjs` for isolated storage/manager/adapter checks.
`node test/learning-integration.mjs` starts and stops a disposable runtime with fake
agent executables and blocked remote Node networking. Set `OCTOPUS_TEST_FFMPEG` and
`OCTOPUS_TEST_FFPROBE` to installed binaries to include synthetic frame extraction.
`OCTOPUS_TEST_AGENT=1` also exercises learning, brand research and project context through the actual adapter with a synthetic agent that writes proposals; the copied credential module is stubbed.
`--serve` leaves that fixture running for manual browser checks; it never selects
a real creator studio. Set `OCTOPUS_TEST_PORT` if the default fixture port is occupied.

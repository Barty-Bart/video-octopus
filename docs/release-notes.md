# v0.1.0-beta.9

- Video formats is three panes: channels, their formats, and a format home with New video and tabs for Skill, Examples, Insights, Videos and History. Channels and formats can be renamed, have their setup changed and be archived or restored.
- Each format has one generated skill (rules, workflow, examples with notes and key frames, assets, insights and the videos made with it), rebuilt from SQLite. New videos keep the version they started with; Claude, Codex and pi load the pinned copy.
- Talk to this format: one conversation panel for studying new examples (paste links or drop files) and for plain-language changes such as "use blue instead of red". Conversations continue after a version is saved. Every change is a draft marked New, Changed or Removed and is saved as the next version only after review. Rules can also be edited directly.
- Draft evidence is checked: studied examples, the creator's own chat message, or a direct edit. New per-version `learned-*` skills are no longer published; existing ones are left in place.
- Reliability: request bodies are decoded whole (no split characters) and too-large or malformed requests return 413/400 instead of saving nothing; settings and other app state are written atomically, and a damaged file is set aside rather than replaced with defaults.
- The status chip, sidebar card and Projects notice describe the selected agent (Claude Code, Codex or pi). Unit tests run in GitHub Actions on macOS and Windows with Node 22.13 and 24.

See [formats and storage](learning-and-storage.md) and [format research](format-research.md). Verified with 232 unit tests, an isolated format-skill runtime (study → v1 → chat edit → v2 with an older project still pinned to v1) and disposable browser checks. Real-provider studies, real file drag-and-drop and Windows execution of these changes remain unverified. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.8

- Video formats shows all saved formats grouped by profile, remembers the last selection and keeps direct links to the selected format or study.
- Saved video formats are immediately available in New video, even before optional brand setup or example studies. Choosing a format selects its video setup automatically.
- Format cards show Ready to use and provide a New video action. Only reviewed style guides are included; later brand or guide additions leave existing videos unchanged.
- Setup offers an explicit Check my computer action, bounded Python environment discovery and recommendations based on installed packages and hardware.
- Check an existing project or environment location, verify its library imports, then explicitly select it for local Python work. Python presence and missing libraries are reported separately.
- No automatic package installation, model download, provider change or creator-folder relocation.

See [computer checks](onboarding-scan.md) and [formats and storage](learning-and-storage.md). Verified with 205 tests, disposable API/fake-agent runs and browser creation. Native Windows environment execution and real-provider output remain unverified for these changes. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.7

- Scoped SQLite memories, review inbox, source quotes, revisions, explicit replacement, expiry and forgetting.
- Remember this and Review lessons in chats; local correction checkpoints before compaction and after export.
- Bounded shared agent context and generated MEMORY.md, plus scoped FTS history search and a read-only recall command.
- Explicit previewed app-history import, migration backups and restore exclusions that preserve forgotten sources.
- Memory failures leave ordinary chat and compaction usable. No background model jobs or automatic skill changes.

See [workflow and limits](memories.md). This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.6

- Video formats separates Research a format, Study examples and viewing an
  approved guide. Start a conversation without adding references first.
- Review the assistant's suggested example links before adding them to a study.
  Existing evidence review and guide approval remain required.
- Rejected chat messages return to the composer with a persistent error, so
  text is available to retry. New studies retain a reloadable URL.
- Usage meters now show timestamped, provider-specific agent reports, support
  current Claude rate-limit events, hide unknown/stale percentages and discard
  old readings on server restart. They are explicitly marked as not live.

See [research, conversations and usage](format-research.md). No studio folders,
media paths, schema identifiers or existing guides are moved by this update.
Verification uses synthetic references and fake agents; actual provider search,
website access and live account usage are not established by these checks.

---

# v0.1.0-beta.5

- Video formats replaces the Learning label. Study examples opens a study;
  its reviewed result is an Approved guide. Existing URLs and database IDs stay valid.
- Library sounds now use a SQLite catalog for descriptions, source/licence notes,
  tags, revisions and approval history. Edit details and search tags in Library.
- Migration backs up the database and legacy metadata before import. Audio paths
  and existing project cues stay intact. Approval keeps candidate files in place;
  discarded candidates remain recoverable on disk and in catalog history.
- Agents receive exact audio paths through the catalog API/CLI and generated
  snapshot. Legacy styles remain usable by old projects; new studies go to Video
  formats, with an option to reuse old style notes as examples.

See [storage and update rules](storage-updates.md) for backup scope and recovery.
Verification: 180 isolated tests, 19 disposable runtime groups and browser checks
for format studies, metadata editing/search, audio serving and legacy note reuse.
Synthetic media/fake agents only; real provider search and listening quality are
not proven by these checks. Audio needs its own backup alongside SQLite.

---

# v0.1.0-beta.4

- Learn this format now opens an examples-first workspace immediately. Drop
  videos/images or other supported files, add several URLs, or add written examples.
- New sessions discover relevant patterns automatically. Guidance is optional;
  study name and inspection depth are tucked into Study settings. Existing
  sessions retain their selected focus.
- Show the channel/brand/series and format together, so two channels can each
  have a Shorts format with different learning histories and styles.
- Preserve guidance and successful uploads when another file in a batch fails.
  Study settings are stored in SQLite with revision and running-state checks.

Verified on macOS: 172 isolated tests, 16 fake-agent runtime groups, and browser
checks covering file drops, bulk links, partial failures and Learn → review →
approve. Real provider access and the quality of learned conclusions still need
creator testing. This discovers patterns in supplied examples; it does not
search the web automatically for reference videos.

---

# v0.1.0-beta.3

- Clear the Updates “New” badge when no app update is available. Skill review
  notices remain inside Updates and no longer count as new app versions.
- Explain profiles and formats with channel examples and useful placeholders.
  “Video setup” selects the starting workflow; the format name is your own label.
- Copy an approved format into another profile after reviewing its guide. The
  copy gets independent learning history, retains source provenance and uses
  the destination profile's brand. Personal skill selections can be shared.

Verified on macOS: 170 isolated tests, 16 fake-agent runtime groups, and browser
checks of profile creation, setup presets, reviewed copy and badge clearing.
No packages/models are installed; Python/SAM discovery remains a follow-up.

---

# v0.1.0-beta.2

Adds Learning, profile-specific brands and SQLite-backed skills/instructions.
Choose a profile and approved learned format in New video to include their brand,
instructions, core workflows and selected personal skills. Existing videos retain
their saved versions when a brand or learned format changes.

## Included

- Reference studies with optional local frame extraction, evidence review,
  approved format versions and reusable workflow skills/assets.
- Profile brand onboarding from a website, using the selected agent, with review
  before approval. Multiple learned formats can belong to one profile.
- Editable skill explanations, Core/Customized core/Personal ownership, retained
  versions, shared instructions and database backup/recovery.
- New studio storage in OS application data. Existing studio paths, recordings
  and editor files stay in place; accepted skill data migrates to SQLite.

## Updating

Requires Node 22.13+ on 22.x or 23.4+ (Node 24 recommended). No npm install or
separate database service is required. Back up your studio before updating.
Settings → Updates → Check for updates offers the update for Git installations.
If your installed updater reports changed runtime requirements, stop the app,
run `git pull --ff-only` in its checkout, and start it again with `./start.sh`
(macOS) or `start.cmd` (Windows). Do not delete local settings or the studio.

Incomplete onboarding remains incomplete after the update. Open Setup to revisit
it, or use Settings → Brand profiles and Learning from an existing setup.
An update does not reset your database or settings.

## Verified and remaining limits

On macOS with Node 24.21.0: 167 isolated tests and 14 runtime integration groups
passed, including synthetic frame extraction, fake-agent brand/learning approval,
project context pins, backup/restore and origin rejection. This does not establish
real-provider study quality or new native Windows/Linux storage behavior.

Existing Python environments in other studios and standalone SAM checkpoint files
are not automatically discovered. This update does not fix that detection gap or
install packages/models. After Effects export and timed overlays remain deferred.
See [learning and storage](learning-and-storage.md) for migration and recovery details.

---

# v0.1.0-beta.1

Initial source prerelease of Video Octopus, a local browser video editor using a
separately installed Claude Code, Codex or Pi agent. macOS has the broadest test
coverage; Windows is experimental with startup and affected exports verified on
a native hosted runner. This release includes no AI subscription or model.

## Included

- Browser screen/camera/microphone recording, teleprompter, transcript cuts,
  ordered blocks, shots, zooms, scenes, backgrounds and media/text/layer exports.
- Six generic feature skills, managed core updates, validated creator
  preferences and preserved custom forks. New app skills arrive with app updates;
  modified personal skills remain available without automatic text merging.
- Opaque generated-visual sandboxes with scoped local assets and guarded app
  APIs; local scene kits, overrides/keyframes and exact export timing retained.
- Correct Windows software-decoding arguments for plain, shot and layer exports.
- Node 22.2+ preflight checks and explicit prerequisite messages before launch.

## Install and update

Follow the [README](../README.md). Use a current Node 22 LTS or Node 24 release,
Chrome/Edge, FFmpeg/ffprobe and your separately configured agent. No app `npm
install` is required. Python packages and model weights are separate requirements
for local transcription and object separation.

Keep the app checkout and studio separate. Existing Git users can update with
`git pull --ff-only` and restart. This release raises the declared Node minimum;
older copies may require that manual update before one-button updates resume.
Never discard a creator's studio or ignored `local/` settings/chat folder when
replacing a ZIP installation. Review migrated customized skills in Settings.

## Evidence and limits

See [verification](managed-skills-verification.md) for exact revisions, commands,
platform coverage and test receipts. Tests use synthetic media, disposable
studios and fake agents where stated. Successful metadata/routing checks do not
prove real provider authentication, model obedience or editing quality.

Physical recording devices, all Windows/Linux workflows, SAM/MLX inference,
power-loss durability and external-editor timeline imports remain outside the
recorded coverage. Layer exports and timeline XML have documented fidelity
limits. Generated visuals require local assets; arbitrary network access and
workers are blocked.

See [asset provenance](asset-provenance.md) for appearance previews and font
notices. No top-level application licence is supplied. Optional external skill
packs have their own content and terms and are installed only when selected.

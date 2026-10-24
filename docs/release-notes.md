# v0.1.0-beta.15

- **My styles is flat.** Each style is one kind of video (for example "Faceless reel" or "YouTube tutorial") shown as a card you click straight into. A style's page has one row of tabs: Skill (rules and Talk to this style, with skills, files, insights, history and videos alongside), Examples, Brand, People & places, and Memories.
- **Brand kits.** Brand, website research, assets, people & places and memories live in brand kits, shown in a bar above the styles and at My styles › Brand kits. A style uses one kit; **Change kit** moves it to another (or to No brand) while videos already made keep what they were pinned to, and the style's conversations follow the new kit's memories. A kit still used by styles can't be archived.
- **New style** asks what kind of video it is and which kit to use; New video and the editor's style picker show the same flat list. Styles without a brand use a hidden built-in "No brand" kit.
- **Old links keep working,** including beta.14's style addresses and every earlier channel link.
- Under the hood nothing moved: styles are formats and kits are the existing profiles.

Verified with 334 unit tests on Node 24.22.1 and 22.22.1, the format-skill and learning runtimes, and 233 disposable browser checks (light and dark at 1440, 980 and 375 px). Not run: e2e suites, Windows UI. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.14

- **Themes.** Appearance is now Light, Dark or Match system, with four accent colours (orange, blue, green, violet), replacing the ten looks. Your previous look is mapped automatically on first start (light looks → Light, dark looks → Dark, the default → Match system) and a one-time note says so. A light/dark switch sits in page headers. Unused looks and font families were removed.
- **Sidebar.** A slimmer rail you can collapse to icons (remembered), with Projects, Recordings, My styles and Tools; **Ask Claude** is a rail button (⌘J) instead of the floating pill.
- **Projects home.** A Continue banner with a real frame from your latest video and its next step, a "waiting for you" strip, and large thumbnail tiles you can filter by style.
- **Styles.** What were channels are now called styles throughout the app (My styles, each with Formats · Brand · Memories). Old links keep working. Styles can have a short description.
- **New video opens straight away** as "Untitled video" with your last style and format, and asks how to start: Record now, Drop footage, or Idea & thumbnail first (Packaging). Switch style or format from the editor's top bar (after Build, only formats with the same video setup). Claude names the video once you describe it, or your Packaging working title does; a name you set yourself is never replaced.
- **Settings** in six groups (General, Agent, Recording, Editing & sound, Export, Storage) with search; old settings links land in the right place.

Verified with 327 unit tests on Node 24.22.1 and 22.22.1, the format-skill and learning runtimes, and disposable browser checks in light, dark and system at 1440, 980 and 375 px. Not run: e2e suites, Windows UI, real-provider naming. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.13

- **Packaging (first version).** An optional **Package** stage comes first on each video's rail and never blocks the rest. Its Packaging tab has a Codex chat (on your ChatGPT plan) that knows the video's memories and resources.
  - **Generate** asks Codex for one image with six thumbnail ideas in a 3 × 2 grid and cuts it into six cards; the reply's lines name them.
  - **Refine** turns a card into a 1280 × 720 thumbnail.
  - The board lets you star ideas, pick up to three winners and one main thumbnail (which completes the Package stage), and upload old thumbnails.
  - A working title fills the Post tab's YouTube title only when it is empty.
  - Titles and hooks are shown as coming soon.
- **Resources.** Photos, logos, colours and notes at All channels, Channel or This video, managed in the channel's Brand tab and in Packaging. Each photo says who is in it; photos of someone else are never sent to an image model. Resources are live: new ones reach videos already in progress.
- **Isolation.** The Packaging chat runs read-only in the video folder with only the studio's context: your own Codex hooks and memories, MCP servers, plugins and web search are switched off for it (scheduled Codex runs now switch off hooks and memories too). Read-only commands don't ask; anything else still does.
- **Limits.** If Codex's image allowance runs out, Packaging says so and shows when it resets.
- **Groundwork.** One shared scope ladder (All channels › Channel › Format › Video) for memories and resources; brand assets moved into the file store (backed up first, verified, resumable); Storage and restore count Packaging and resource images as in use.

Verified with 302 unit tests on Node 24.22.1 and 22.22.1 and a fake Codex app-server, plus one real Codex test on a ChatGPT plan (2 generations: a 2048 × 768 sheet cut into six cards, and a refined 1280 × 720 thumbnail; usage meter and `resetsAt` as expected). Not yet verified with a real photo of a person as a likeness reference. Requires Codex signed in with a ChatGPT plan. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.12

- **Pinned format skills hold.** A video's pinned copy of its format skill now has its own name (`format-…-v<N>`), and every studio format skill is switched off in pinned project chats and scheduled runs, so a newer approved version can't replace the one a video started with. Existing pinned projects get the renamed copy on their next chat; any older copy is kept aside, never deleted. Verified with a real Claude Code run as well as Codex and pi test adapters.
- **Workflow check.** When a draft changes or removes a rule but keeps the old workflow, the review shows a warning with the lines that still mention the old behaviour. The format conversation is also asked to update the workflow itself.
- **Only your own skills are listed.** Format conversations and brand research are told only about the format skills they can actually use.
- **Brand tab.** Approving, saving or restoring a brand updates the tab, the channel avatar and the sidebar at once, and the research status updates while it runs.
- **Phones.** The floating Ask Claude button no longer covers dialog buttons or chat send buttons.

Verified with 289 unit tests on Node 24.22.1 and 22.22.1, the format-skill (14 checks) and learning runtimes, disposable browser checks, and a real Claude Code check that a video pinned to v2 loads only v2 after v3 is approved. Codex and pi are verified with test adapters only. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.11

- **New layout.** A grouped sidebar: New video; Make (Projects, Recordings); My style (All channels and one row per channel, with a dot when memories await review); Assets (Library); Automation (Skills, Scheduled); Settings. On narrow windows the sidebar becomes a drawer.
- **Channel hub.** Each channel has Formats (its formats, format home, skill and Talk to this format), Brand (its brand profile) and Memories tabs. All channels lists every channel, the studio instructions and Everything memories. Projects can be filtered by channel and show their channel and format; New video can start from a channel.
- **Skills** is a list with on/off switches and a detail panel. **Settings** gains Usage (formerly Dashboard) and Storage & backups; Brand profiles and Instructions moved to the channel hub and All channels.
- **Old links keep working.** Earlier addresses for Video formats, Memories, Storage, Dashboard and Settings › Brand/Instructions redirect to their new places.
- **Memory levels.** Memories have two visible levels, This channel and Everything; the channel wins on the same topic. Lessons the agent proposes go to the chat's channel by default, and you choose "Keep for" when approving or in Remember this. Older video- or format-level memories keep working and can be moved to their channel. A channel's memories never reach another channel.
- Styling of the new screens uses theme tokens only (checked by a test) and works across all looks.

Verified with 282 unit tests on Node 24.22.1 and 22.22.1, the format-skill and learning runtimes, route-redirect tests, and disposable browser checks at desktop, 980 px and 375 px in several looks. Not verified: brand research inside the Brand tab, real-provider runs, Windows UI. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.10

- **Skill files.** A format's skill can hold real files: assets (backgrounds, icons, images, motion files) and knowledge (product sheets, specs, price lists) with an index in SKILL.md. Files live once in a content-addressed store in the studio (`.studio/files/`); SQLite keeps their records; skill folders get copy-on-write copies. Up to 300 files per skill, 1 GB each. A Files tab stages additions and removals into the next reviewed version. Storage lists unused files, deletes them on request (never one a version uses) and backs the file store up to a folder.
- **Migration.** Existing studios move asset and key-frame bytes out of SQLite automatically after a database backup; it resumes after interruption and is safe to repeat. An older app version cannot read migrated skill files without restoring that pre-migration backup. Back up the database and the file store together.
- **Runtime.** Requires Node 22.16+ on 22.x or 24+ (Node 23 and 22.13–22.15 lack the SQLite full-text search memories use). Startup checks it and explains what to install. Setup and Updates warn (without blocking) when Node is older than the October 2026 security releases (22.23.4 / 24.22.1) or FFmpeg is older than 8.1.2, because the app processes downloaded example videos.
- **Agent context.** Claude and pi receive the app's system prompt through a file, keeping command lines short on Windows. Scheduled runs on a pinned project use its pinned brand, format and skills. Agents are told their real working folder. Format conversations see only their own format skill and brand research none. Install-wide brand lines no longer contradict channel profiles; Settings says Instructions apply to new videos.
- **Projects.** A format upgrade into another channel is refused before anything is saved, and projects broken by it earlier get Repair project setup. Upgrades keep the project's brand and memories and show the change. Archived project ids are never reused, so a new project with an old name starts clean.
- **Reliability.** A hand-edited generated skill is restored with the edit kept aside instead of blocking chats; rebuilds skipped while an agent was busy run when it is idle. Codex and pi start failures are reported as errors; switching provider starts a fresh session; pi's Auto mode writes only inside the project. On Windows the selected Python path reaches agents correctly. On Windows, archiving or restoring a project waits for its agent process to exit and briefly retries the folder move instead of failing with EBUSY.

Verified with 267 unit tests on Node 24.22.1 and 22.22.1, isolated format-skill (13 checks) and learning runtimes, a before/after agent-context probe for every fixed defect, and disposable browser checks. Real-provider runs (including Claude honouring `claudeMdExcludes`/`skillOverrides`) and Windows execution are verified only by the CI matrix where covered. This is a source update on main; the downloadable tagged prerelease remains separate.

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

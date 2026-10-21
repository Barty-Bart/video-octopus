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

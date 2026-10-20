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

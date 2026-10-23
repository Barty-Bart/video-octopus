# Stable names, creator files and storage updates

## Display terminology

`web/terms.js` defines Video formats (the section), Study examples (the action),
Example studies (history), Approved guide (the result) and Format assistant.
Navigation, primary workflow labels and the agent's format context use these names.
A wording change does not rename database tables, skill IDs, project keys or URLs.
`/api/learning`, `sessions`, `versions` and existing project pins remain compatible; old
`#/learning` links redirect to the channel hub's Formats tab (`legacyRoute()` in `web/nav.js`). Update surrounding explanatory copy and current docs when terms change;
retain dated release notes as historical evidence.

New studies belong in Video formats. Library shows retained legacy style notes
for older projects; Use notes as an example copies the notes into a new study for
a selected profile/format. It does not auto-approve a guide, copy reference media,
rewrite an old style or retarget existing projects. Legacy style APIs and project
style bindings remain supported for compatibility.

## Update contract

1. App source/core skills and creator studios have separate ownership. Ordinary
   app updates must not relocate media, rename creator folders or rewrite projects.
2. Core skill IDs remain stable. Ship core instructions and API code together;
   increment their API epoch only when the executable contract breaks. Preserve
   personal edits as forks. Never use a display-label change to trigger migration.
3. Storage changes need an explicit component schema version, automatic backup
   before migration, transactional metadata writes and repeatable startup. Keep
   originals and fail closed on unknown future versions. No automatic guessing by
   an agent, model downloads or new providers to complete a migration.
4. Test an existing studio fixture as well as a new one: stable IDs, file paths and
   project references, creator metadata retention, interruption/failure handling,
   backup/restore and older URLs. Document what has and has not been tested.
5. For a genuinely incompatible change, provide a migration/recovery guide and a
   preview of the proposed changes. Preserve a recoverable copy first. Agents use
   documented app operations; they must not improvise SQL or reorganize folders.

These are maintenance requirements, not a promise that all future software
changes can be made without a migration. Current sound migration is additive.

## Sound catalog, schema 1

The shared `<studio>/.studio/studio.sqlite` stores `sound_assets`, `sound_history`,
`sound_libraries` and `sound_catalog_schema`. Each asset has a stable ID, relative
file path, description, source, licence notes, tags, revision and status
(`pending`, `approved` or `discarded`). History retains prior metadata. Licence
notes record provenance; the app does not independently verify usage rights.
Audio remains ordinary files in the configured library. Project placements still
use `work/sfx.json`; existing timeline/export paths and timing are unchanged.

First access backs up SQLite and legacy `sfx/INDEX.md` / `_new/candidates.json`
under `.studio/sound-migration-backups/<id>/`, including a recovery explanation.
Then it imports the existing library metadata without changing the source files
or moving audio. Existing normal-library audio is approved; `_new` audio awaits
review. Import is tracked separately for each configured library root. A custom
library folder is supported; symbolic links are rejected rather than followed.

Subsequent new files await review unless added explicitly through the app's Add
files/free-folder/save-to-library operations. For agent-created candidates,
`_new/candidates.json` is an intake channel. Incoming metadata can update only an
unreviewed candidate until the creator edits or approves it. Late/partial JSON
cannot overwrite reviewed metadata. Invalid intake reports a warning and keeps
existing catalog entries. Approving changes status in place: even an approved
file in `_new/` retains its original path. Discard hides a pending candidate but
keeps its audio and history. Missing media is marked missing, not removed from SQL.

Edit details in Library to update description, source/licence or tags. Existing
INDEX.md is retained provenance, not a writable mirror of the SQLite catalog.

## Agent access

- `GET /api/library/sound-catalog`, or `node <app>/bin/octopus.mjs library sounds --json`,
  returns status, revision, relative file, absolute path and missing-file state.
- `.studio/sound-catalog.json` is a generated snapshot, refreshed on catalog access
  and agent context creation. The API/CLI is preferred for a fresh view.
- Use only approved, non-missing sounds. New options go into `sfx/_new/` with
  incoming metadata; creators listen and approve through the app. Do not approve
  on the creator's behalf or edit SQL/INDEX.md as a substitute for catalog APIs.
- `POST /api/library/sound-edit` accepts `file`, `revision`, `note`, `source`,
  `licence` and `tags`. It cannot change approval status or move files.

## Backup and recovery

Storage → Back up local database includes sound metadata/history along with
skills, profile data and approved guides. It does **not** include audio. Back up
media separately. Restore previews include sound counts and reject a pre-catalog
backup once catalog migration is active; silently recreating from old INDEX.md
would lose creator edits and approval history. Future catalog versions are rejected.
Normal restore preserves the displaced database and SQLite sidecars. Catalog
snapshots regenerate on next access. Pre-migration backups are for deliberate
coordinated recovery with the app stopped, following their RECOVERY.md; do not
copy a database over a running app. No backups are automatically pruned.

# Bundled asset provenance

This inventory covers the application assets checked on 21 October 2026. It records where the assets came from; it does not grant a new licence to the application or to external content.

## Appearance previews (removed)

Until 23 October 2026 the application shipped ten JPEG screenshots of its own appearance settings in `web/looks/` for the
look picker. Design V2 replaced the ten looks with Light, Dark or Match system and an accent, and those screenshots and
the look picker were removed. Their creation record (synthetic media in a disposable project, SHA-256 per file) remains
in this file's Git history.

## Fonts

[`web/fonts/`](../web/fonts/) contains five WOFF2 files and one TTF file, all Geist and Geist Mono, with their notice:

| Font group | Notice |
| --- | --- |
| Geist and Geist Mono | [OFL-Geist.txt](../web/fonts/OFL-Geist.txt) |

The Geist notice includes a copyright header and the full SIL Open Font License 1.1 terms; it was completed on
21 October 2026 by retaining its existing copyright and appending the standard terms. Preserve it when distributing
those files. The twelve other families the old looks used (and their notices) were removed with the looks on
23 October 2026. The font notice applies to the font software; it does not select a licence for the application. This
inventory is not an independent audit of every upstream font release.

## Optional skills and user media

The six generic feature skills in [`starter/.claude/skills/`](../starter/.claude/skills/) are part of the starter. The recommended [`Barty-Bart/motion-graphics`](https://github.com/Barty-Bart/motion-graphics) repository is separate. Opening its recommendation in Setup does not install it; installation requires the **Install** action.

Installing an external skill copies its selected folder, including supporting code, sample assets and examples, into the user's studio. External repositories can include creator credits and real-project examples. Review their contents and applicable notices before installing or reusing them. Their code and asset licences are separate from this application's, and a repository-level licence label does not verify every bundled asset. A recommendation following a branch can change after review.

User recordings, projects, transcripts, style references and installed external skill packs are not bundled application assets. Keep them in the user's studio and out of application commits.

## Application licence

No top-level application licence has been selected. This provenance document does not change that decision and does not treat the optional skill repository's licence as the application's licence.

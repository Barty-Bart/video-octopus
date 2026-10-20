# Bundled asset provenance

This inventory covers the application assets checked on 21 October 2026. It records where the assets came from; it does not grant a new licence to the application or to external content.

## Appearance previews

The ten JPEGs in [`web/looks/`](../web/looks/) are screenshots of this application's appearance settings. They were created locally on 19 October 2026 using a disposable example project named **My first video**. They contain the app interface, an empty chat, and generated video test patterns. They contain no creator recording, face, private conversation, account page, or personal desktop capture.

The recorded creation process was:

1. Generate an eight-second screen track with FFmpeg `testsrc2=size=1920x1080:rate=30` and a camera track with `smptehdbars=size=1280x720:rate=30`. Both tracks used generated sine-wave audio. No camera or screen recording was an input.
2. Open the example project in the local application with Playwright Chromium at a 1440 × 900 viewport. Apply each appearance, seek both generated tracks to three seconds, and capture a PNG. The project-chat request was blocked during capture.
3. Convert each PNG with FFmpeg `scale=480:300:flags=lanczos` and JPEG quality `-q:v 3`.
4. Copy the ten resulting JPEGs into `web/looks/` for the appearance picker.

All ten current files were visually inspected and matched byte for byte against the saved neutral export and the files in the first reachable application commit, `6c0c139`. The historical conversion output also records the same individual byte sizes. This establishes the origin of these specific files; it is not a claim about a later replacement with the same filename.

| File | SHA-256 |
| --- | --- |
| `atelier.jpg` | `91f7826c14fb3585603846b46af5f514bedcafad30d2c51037d2629f194819f1` |
| `cinema.jpg` | `d80e37cff7e485482d5c8a6becace04f4494ea4df9172e602dd83441618bb6e7` |
| `clay.jpg` | `d56f05c69f98ebef81589d3787ab23eb92deb9331e5a26783385d996dbbca2c6` |
| `control.jpg` | `40eb4650fd078e5770508ca1f816296364088ede247881004dc0fe8c5b4c95f9` |
| `editbay.jpg` | `3b623bcbb535186b64c57b25c8bf5768397372f44e8de58e60b0b47a26484708` |
| `frost.jpg` | `40797d798d1d140d208f8d4f8bd0ac2f90410db2e108e044c556f92b96e513d2` |
| `night.jpg` | `346489d0635abb92aec9eb03ed630d46fae43517dfb8586222050af41e9a5805` |
| `paper.jpg` | `ec0ae211361f157a56dbf3bea3ef5cbf4009dd33131c5a349414f09ec2b7d2d9` |
| `split.jpg` | `406a2c2cfd6d438138ec05b18a7898bcc9b2c070af24ce4eeb1d2c7118c6adb7` |
| `swiss.jpg` | `b6ac5d86bf991a2882f02d6485997a28aac729cddf51b85cb8c9cb5acef54aa2` |

For future replacements, use a new disposable project with synthetic media, inspect the full captured interface, and update this inventory. Do not use a real creator project as the screenshot source.

## Fonts

[`web/fonts/`](../web/fonts/) contains 24 WOFF2 files and one TTF file. Each font group has a corresponding notice:

| Font group | Notice |
| --- | --- |
| Archivo | [OFL-Archivo.txt](../web/fonts/OFL-Archivo.txt) |
| Barlow Semi Condensed | [OFL-BarlowSemiCondensed.txt](../web/fonts/OFL-BarlowSemiCondensed.txt) |
| Bebas Neue | [OFL-BebasNeue.txt](../web/fonts/OFL-BebasNeue.txt) |
| DM Mono | [OFL-DMMono.txt](../web/fonts/OFL-DMMono.txt) |
| Figtree | [OFL-Figtree.txt](../web/fonts/OFL-Figtree.txt) |
| Geist and Geist Mono | [OFL-Geist.txt](../web/fonts/OFL-Geist.txt) |
| Hanken Grotesk | [OFL-HankenGrotesk.txt](../web/fonts/OFL-HankenGrotesk.txt) |
| IBM Plex Mono | [OFL-IBMPlexMono.txt](../web/fonts/OFL-IBMPlexMono.txt) |
| Instrument Serif | [OFL-InstrumentSerif.txt](../web/fonts/OFL-InstrumentSerif.txt) |
| JetBrains Mono | [OFL-JetBrainsMono.txt](../web/fonts/OFL-JetBrainsMono.txt) |
| Newsreader | [OFL-Newsreader.txt](../web/fonts/OFL-Newsreader.txt) |
| Sora | [OFL-Sora.txt](../web/fonts/OFL-Sora.txt) |
| Space Grotesk | [OFL-SpaceGrotesk.txt](../web/fonts/OFL-SpaceGrotesk.txt) |

The appearance stylesheet records its font sources as the Fontsource packages. All 13 notices include a copyright header and the full SIL Open Font License 1.1 terms. The Geist notice was completed on 21 October 2026 by retaining its existing copyright and appending the same standard terms already supplied with the other fonts. Preserve the corresponding font notices when distributing those files. The font notices apply to the font software; they do not select a licence for the application. This inventory is not an independent audit of every upstream font release.

## Optional skills and user media

The six generic feature skills in [`starter/.claude/skills/`](../starter/.claude/skills/) are part of the starter. The recommended [`Barty-Bart/motion-graphics`](https://github.com/Barty-Bart/motion-graphics) repository is separate. Opening its recommendation in Setup does not install it; installation requires the **Install** action.

Installing an external skill copies its selected folder, including supporting code, sample assets and examples, into the user's studio. External repositories can include creator credits and real-project examples. Review their contents and applicable notices before installing or reusing them. Their code and asset licences are separate from this application's, and a repository-level licence label does not verify every bundled asset. A recommendation following a branch can change after review.

User recordings, projects, transcripts, style references and installed external skill packs are not bundled application assets. Keep them in the user's studio and out of application commits.

## Application licence

No top-level application licence has been selected. This provenance document does not change that decision and does not treat the optional skill repository's licence as the application's licence.

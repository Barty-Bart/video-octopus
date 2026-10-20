# Isolated verification

This branch is unreleased. Verification on 21 October 2026 used macOS ARM64,
Node v24.21.0, cached Chromium 156 and disposable app/studio copies. The source
was the uncommitted implementation atop
`b7a733d68272089f24db0727d3f728c64f42b272`, with targeted reruns after fixes.
These are not results for remote main, the base commit alone, Windows or a clean
consumer-machine installation.

## Node and adapter tests

```sh
node --test test/*.test.mjs
```

**125 passed, zero failed/cancelled/skipped/todo**, exit 0, 8.964 seconds.
Seven test files cover:

- Managed-skill migration, preservation, forks/core selection, compatibility,
  collisions, comparison, restore and all eight simulated interruption points.
- Preference validation, defaults, diagnostics and bounded read-only context.
- Starter ownership: preferences, memory and brand/style files remain untouched.
- Maintenance and in-flight work protection.
- Actual Claude/Codex/pi adapter startup, running and resumed turns using fake
  CLIs: 72 internal assertions, 12 fake launches and 48 synthetic turns.
- Turn lifecycle: both user/busy event orders, exact Undo restoration, detecting
  new proposals, startup failure cleanup and silent turns.
- Text exports: eight tests cover read-only previews, TXT/Markdown/SRT/VTT output
  and successive version creation without replacing earlier files.

The adapter tests found stale context after compatible skill changes. The active
inventory and content fingerprint now refresh instructions on selection, editing
and disabling; unchanged refresh stays quiet. Browser testing also found that
early startup-busy events lost the before-turn snapshot when the user event
arrived. That snapshot now survives, restoring Undo/proposal tracking while
keeping startup protected from updates. A third regression showed that
transcript/subtitle previews wrote `work/shots.json`. Their timeline evaluation
is now read-only; the text-export tests verify that previews leave project files
unchanged and all four output formats preserve earlier export versions.

## Browser, update and restart tests

With an already installed Playwright package and Chromium executable:

```sh
PLAYWRIGHT_PATH=/path/to/playwright PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium node test/managed-skills.e2e.mjs
```

**11 scenario groups passed**, exit 0, 13.924 seconds. This uses production
studio creation, the real Settings UI, disposable local Git repositories and
the actual `start.sh` supervisor. It verifies byte preservation across compatible
and breaking releases, new core skills, three restarts, inactive fork edits,
compare/reselection, invalid preference repair, compatibility review, restore,
hold/resume and refusals for a dirty checkout, changed runtime requirements and
a failed local-origin fetch. Browser requests stay at the fixture origin.

Broader `test/smoke.mjs` coverage exercises onboarding, fake model-download
interruption/checksum/resume, optional skill archive validation, recording with
fake devices, teleprompter, Cut Editor, shots, zooms, preview/render pixel
comparisons, WAV/MP4/layer export, built-intro audio continuity, local updates and
restart. A separate recorder case exercises interrupted-recording recovery.
Actual offline faster-whisper transcription of synthetic speech passed with
cached tiny.en: 13 words in both speech and filler passes.

The complete run plus named follow-ups yielded **119 distinct smoke checks
passed, zero failed and one platform-specific face-finder check skipped**.
The unchanged chat browser suite passed **12/12** after the snapshot fix.
After the text-preview fix, **9/9 targeted actual video, layer and timeline export
checks passed again**. These are follow-up checks of affected paths, not nine
additional distinct checks added to the 119 above.
Follow-ups corrected dependency/browser fixture setup and retested changed
paths; this is not a claim that the initial full run passed without failures.

`SMOKE_PROGRESS=1` streams named results; `SMOKE_REPORT=/path/to/results.json`
saves structured output. `SMOKE_SKIP=<regex>` records exclusions explicitly;
`SMOKE_ONLY=<regex>` selects checks and must include prerequisite fixture checks.
Run the smoke suite in a disposable application copy with isolated HOME/config,
local settings, disabled schedules, fake agents and an empty test key-store
namespace. It is not a command to run against a creator's real studio. Its
default speech test can download tiny.en unless an offline cache is supplied.

## Failed security gate

```sh
PLAYWRIGHT_PATH=/path/to/playwright CHROMIUM_PATH=/path/to/chromium node test/security-boundaries.e2e.mjs
```

**Two isolation checks failed; exit 1.** Generated scene HTML and custom
background JavaScript each read another synthetic project, accessed the parent
app DOM and persisted a harmless app-setting change through real server routes.
The negative control without the app header returned 403. This demonstrates
that the ordinary API-origin/header check does not isolate executable project
content. The test adds a constructor export only in its disposable scene module;
the app server, API checks and background loader are unchanged.

Public release needs these executable paths isolated and reverified. These
tests do not clear generated-code export execution or all other API routes.

## Remaining limits

- Real provider sign-in/current vendor CLI compatibility and model obedience.
  Fake wire tests prove supplied context and publication, not those properties.
- Windows/Linux runtime and filesystem coverage; the earlier Windows MP4
  failure and unconditional macOS VideoToolbox decoder inputs remain unresolved.
- Exact minimum Node version: README, manifest and launcher requirements still
  differ. This pass used Node 24; older hosted tests used Node 22.
- Physical camera/microphone/screen recording, SAM segmentation, MLX inference
  and macOS Vision face detection. Fake transfers do not test model quality.
- Power-loss durability, external-editor timeline imports and external optional
  skill-pack content. Preview-asset provenance remains a separate release item.

No real studio, provider credential, paid call, package/model download, remote
CI upload, production Git push or publication was part of this verification.

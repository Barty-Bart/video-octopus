# Isolated verification

Verification for the v0.1.0-beta.1 source prerelease on 21 October 2026 used macOS ARM64,
Node v24.21.0, cached Chromium 156 and disposable app/studio copies. The source
was the uncommitted implementation atop
`b7a733d68272089f24db0727d3f728c64f42b272`, with targeted reruns after fixes.
These are not results for remote main, the base commit alone or a bare consumer
machine. Native Windows results are recorded separately below.

## Node and adapter tests

```sh
node --test test/*.test.mjs
```

**142 passed, zero failed/cancelled/skipped/todo**, exit 0 (9.234 seconds).
Nine test files cover:

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
- Runtime preflight and actual launcher behavior: ten checks reject unsupported
  versions before studio/browser startup and preserve supported-runtime exit codes.
- Platform decoder arguments and seven actual software-decoding/export cases on
  Mac. Windows/Linux no longer receive macOS-only VideoToolbox decode arguments;
  these Mac executions do not establish native Windows behavior.

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

The earlier complete run plus named follow-ups yielded **119 distinct smoke checks
passed, zero failed and one platform-specific face-finder check skipped**.
The unchanged chat browser suite passed **12/12** after the snapshot fix.
After the text-preview fix, **9/9 targeted actual video, layer and timeline export
checks passed again**. These are follow-up checks of affected paths, not nine
additional distinct checks added to the 119 above.
The post-isolation full run initially recorded 117 passes, two fixture failures and
one Mac Vision skip. Awaiting a fake-Claude stdout flush corrected truncated JSON
(4/4 targeted checks passed). Updating the Cut Editor assertion to identify the
exact app and sandbox listeners corrected its obsolete single-port expectation
(6/6 targeted checks passed). Production code did not change during these
follow-ups. Consolidation yields **119 distinct passes, zero remaining failures
and one Mac Vision skip**; this is a full run plus targeted follow-ups.
Follow-ups corrected dependency/browser fixture setup and retested changed
paths; this is not a claim that the initial full run passed without failures.

`SMOKE_PROGRESS=1` streams named results; `SMOKE_REPORT=/path/to/results.json`
saves structured output. `SMOKE_SKIP=<regex>` records exclusions explicitly;
`SMOKE_ONLY=<regex>` selects checks and must include prerequisite fixture checks.
Run the smoke suite in a disposable application copy with isolated HOME/config,
local settings, disabled schedules, fake agents and an empty test key-store
namespace. It is not a command to run against a creator's real studio. Its
default speech test can download tiny.en unless an offline cache is supplied.

## Generated visual isolation

```sh
PLAYWRIGHT_PATH=/path/to/playwright CHROMIUM_PATH=/path/to/chromium node test/security-boundaries.e2e.mjs
```

**11 app-preview checks passed**, including parent/API isolation, legacy scene
kit compatibility, creator overrides, exact background pixels, forged-reply
rejection, direct HTML/SVG navigation, module imports and self-navigation. The
test adds a constructor export only in its disposable scene module; it exercises
the actual application server and renderer paths.

```sh
CHROMIUM_PATH=/path/to/chromium FFMPEG_PATH=/path/to/ffmpeg FFPROBE_PATH=/path/to/ffprobe node test/generated-rendering.e2e.mjs
```

**Nine headless-rendering scenario groups passed**, exit 0, 4.738 seconds. Real
scene output preserves image/font loading, transparency, saved keyframes,
seeking, layers and element isolation. Real asynchronous background output
preserves requested frame order and exact decoded pixels. Synthetic outside
file, symlink, API, network and self-navigation probes failed safely. Successful
and failed exports terminated their child processes; fixtures were removed.
Background tests use the production renderer and routes behind a minimal trusted
host with the production frame policy; app-preview tests cover the full server.
An independent audit also passed **12 security checks**.

Generated HTML and background modules now execute in opaque sandboxes on a
separate local asset service. Their policy permits scoped local rendering assets
and blocks external network access, workers and privileged app access. Existing
scene kits and creator overrides work without rewriting project files. Required
remote images/fonts must be saved locally. This boundary does not sandbox agent
tools or third-party skills, and the checks are not an exhaustive browser audit.

The previous scene/background privilege failures were reproduced before the
fix. Rendering tests also found and fixed an FFmpeg process left waiting on an
open input pipe after export failure; the final suite verifies cleanup.

## Native Windows verification

The [hosted Windows run](https://github.com/Barty-Bart/video-octopus/actions/runs/39516163887)
passed on Windows 2025 x64, Node v22.23.3 and FFmpeg/ffprobe 9.0.2. Its commit is
`3226c14b0eadf8b7b3921cf641a6395c7fd731d3` on the private verification branch
`codex/release-blocker-fixes`. All 160 production files under `server/`, `web/`
and `core/` matched the locally verified source. The job completed in 71 seconds.

The README launcher, default studio creation, Edge onboarding, missing-agent
messages, Continue, app-offered winget FFmpeg installation, synthetic import,
WAV export and the original failing two-second 1080p H.264/AAC MP4 export passed.
Provider routing checks used localhost metadata fixtures; no agent was started.
The harness recorded 22 passing evidence rows and 11 informational rows.

`test/windows-export.test.mjs` also passed **7 tests, zero failures or skips** on
native Windows (17.664 seconds), including the original MP4, reordered blocks
and file insertion, shot seeking/crossfade and layer/presenter-matte output.
Decoded frames, audio, duration, alpha and unchanged synthetic sources were
checked. The earlier hosted Windows export failure is historical and repaired.

The runner already had Git, Edge, Python and winget; Node 22 was supplied and
FFmpeg was installed through the application's own action. Playwright was
installed outside the app as a test driver. No app npm install, real credentials,
model download, paid inference, artifact upload or cache was used. This is a
fresh hosted account, not a bare consumer Windows machine or full Windows feature
coverage. Main and repository visibility were unchanged.

## Remaining limits

- Real provider sign-in/current vendor CLI compatibility and model obedience.
  Fake wire tests prove supplied context and publication, not those properties.
- Full Windows feature/filesystem coverage and native Linux coverage. Windows
  installation and the affected exports passed; the complete Windows managed-skill
  update/restart workflow and Windows generated-rendering security suite were not run.
- The declared minimum is Node 22.2, required by the renderer’s `node:zlib` CRC32
  import. Runtime tests simulate version reporting for the gate; actual app
  coverage uses Node 24.21.0 on Mac and 22.23.3 on hosted Windows.
- Physical camera/microphone/screen recording, SAM segmentation, MLX inference
  and macOS Vision face detection. Fake transfers do not test model quality.
- Power-loss durability, external-editor timeline imports and external optional
  skill-pack content. Synthetic preview provenance is now recorded in [asset provenance](asset-provenance.md).

No real studio, provider credential, paid call, package/model download,
production Git push or publication was part of these local checks.

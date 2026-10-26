# Video Octopus

A local video editor with an AI assistant. Record or import footage, edit from the transcript, plan scenes, adjust layouts and zooms, and export from a browser. The app connects to a separately installed **Claude Code, Codex or Pi** agent; it does not include an AI subscription or a bundled language model.

**Early development — macOS first; Windows experimental.** Hosted Mac and Windows checks pass startup, FFmpeg installation and basic exports. The Windows MP4 decoder bug is fixed: the original failing fixture and seven export-regression tests now pass on native Windows. Windows coverage remains narrower than Mac coverage. See [tested coverage](#tested-coverage).

## Reviewed memories

Save useful preferences with **Remember this**, review proposed lessons, and reuse approved memories across the right profile, format or project. Chat history stays searchable locally. See [Memories](docs/memories.md) for scope, storage, forgetting and backup behavior.

## What is included

| Area | What ships |
| --- | --- |
| Recording | Screen, camera and microphone recording in Chrome or Edge; camera-only and mic-only takes; a script overlay/teleprompter. Screen capture does not include system audio. Browser and operating-system permissions are required. |
| Editing | A built-in transcript/waveform Cut tab, cut review and locking, ordered blocks, project folders and source media kept separately from generated work. AI-assisted cleanup uses the bundled skills below. |
| Scenes | Production-sheet scenes, timed comments, generated HTML scene previews, direct element overrides and keyframes for compatible scenes. The scene toolkit is included; the agent supplies the scene code. |
| Layouts and motion | Screen/camera layouts, PiP framing, backgrounds, per-shot looks, transitions, camera punch-ins and screen-region zooms. Proposed agent zooms can be kept or rejected. |
| Object separation / rotoscoping | A bundled SAM 2.1 skill and script that track a selected subject and produce frame masks and review outputs for compositing. This needs Python dependencies and a separately downloaded model; it is not a ready-to-run one-click model bundled with the app. |
| Exports | MP4; WAV, M4A/AAC and MP3; transcript text/Markdown; SRT/VTT and burned captions; layer exports and timeline XML. Tested platform coverage and limitations are listed below. |
| Packaging (preview) | An optional first stage for thumbnails: a Packaging tab with a Codex chat, **Generate** (six ideas in one image, cut into cards), refine one to 1280 × 720, star / winners (up to 3) / main thumbnail, old thumbnails, and resources (photos, logos, style notes) at All channels, a channel or one video. Image generation uses your own Codex sign-in with a ChatGPT plan and counts against that plan; no API key is used. Only synthetic, fake-Codex runs are tested so far. See [Packaging and resources](docs/learning-and-storage.md#packaging-and-resources). |
| Project formats | YouTube tutorial, faceless explainer, Short and product explainer; in Simple mode, Audio only (voice, podcast or narration: no scenes or build). |
| Simple and Advanced | **Settings › General › Editor mode.** Simple (the default, existing users included) shows Projects, Resources and Settings, and **+ New video ▾** makes a YouTube video (16:9), a Reel or Short (9:16) or an Audio only video on a built-in style; the editor's shape chip switches 16:9 ⇄ 9:16. Advanced shows everything (My styles, brand kits, skills, library, schedules, recordings). In Simple, a video's editor is Claude's step cards on the left (Record · Rough cut · Scenes · Build · Thumbnail · Download), the video with captions, a clickable transcript and an editable waveform on the right, four tools (Captions, Music, Text, Effects) and **Download** top right; Record is a script page with a full-window teleprompter. Switching only changes the setting: nothing is deleted or moved. |

> **v0.1.0-beta.23 — source update.** Setup finds Python environments in your project and app folders (and can ask your agent to look further), Parakeet transcription on Apple Silicon, and recordings you can edit straight away: keep originals or optimise for editing with a 720p copy, export always from the originals, and an offer to delete the copies after export. Includes beta.22's imported files in Recordings and the ‹ Projects way back, beta.21's flow changes, and everything before.

### Six bundled starter skills

First launch publishes these as managed defaults in your studio's `.claude/skills/`:

| Skill | Purpose | Additional requirements |
| --- | --- | --- |
| `transcribe` | Local word timestamps, transcript and subtitles using faster-whisper, MLX Whisper or Parakeet. | Python packages, FFmpeg and a Whisper or Parakeet model. MLX and Parakeet require Apple Silicon and native ARM64 Python. |
| `rough-cut` | Transcript-based cleanup and edit decisions for fillers, pauses and retakes. | Agent, Python/NumPy and FFmpeg; a transcript. |
| `join-check` | Find potentially clipped words at edit joins and propose repaired cut boundaries. | Python/NumPy and FFmpeg; optional Whisper rechecking. |
| `production-sheet` | Plan the video scene by scene and write the files shown in the Scenes tab. | Agent; source transcript and locked cut. |
| `talking-head-zoom` | Plan timed camera punch-ins and zoom-outs as editable proposals. | Agent and timed words; the app previews and exports the accepted zooms. |
| `object-separation` | Select and track a person or object with SAM 2.1, producing masks for graphics behind or around it. | Python/PyTorch, torchvision, Transformers, NumPy, Pillow, FFmpeg and a SAM 2.1 model. GPU support affects speed. |

These are general editing skills distributed with the app. Personal creator styles, campaign notes and private project libraries are not part of this starter.

Motion-graphics infrastructure is built in, but a specialized motion-design skill is **not** among the six bundled skills. Setup can optionally install selected skills from a GitHub repository. Installing a skill copies its folder, including any supporting code and example assets; it does not install every renderer, model or service that it might require. The recommended external pack is separate from the six bundled skills and includes authored examples. Review its content and terms before selecting Install.

## Start from source

Have these ready:

- Git (and repository access for private copies).
- Node.js **22.16 or newer on Node 22, or Node 24 or newer** (Node 24 LTS recommended). Node 23 is unsupported: its built-in SQLite lacks the full-text search (FTS5) that memories use. The launchers check the version and FTS5 before opening the app. Setup and Settings → General → Updates warn, without blocking, when Node is older than its line's latest security release (22.23.4 or 24.22.1 as of October 2026).
- Chrome or Edge for the browser UI and recording.
- For AI work, a separately installed agent and a usable model/provider. You can enter the editor without one.

On macOS, in Terminal:

```bash
git clone https://github.com/Barty-Bart/video-octopus.git
cd video-octopus
./start.sh
```

On Windows, in PowerShell (experimental):

```powershell
git clone https://github.com/Barty-Bart/video-octopus.git
cd video-octopus
.\start.cmd
```

If a browser does not open, go to <http://127.0.0.1:4800>. There is no application `npm install` step.

### First launch and dependencies

The app creates a studio in local application storage by default (for example, `~/Library/Application Support/Video Octopus/Studio` on Mac). Existing studios stay in place. The studio contains the SQLite skill/learning/profile database, project files, recordings and library assets. Skill folders are generated working copies for agents; manage accepted content and versions in Skills. See [storage details](docs/learning-and-storage.md).

Setup scans Claude Code, Codex, LM Studio, Ollama and Pi, and checks tools such as FFmpeg and Python. **Continue works even when dependencies or agents are missing**; this does not make their dependent features ready.

- **FFmpeg and ffprobe:** needed for media processing and export. Setup shows their version and warns, without blocking, below FFmpeg 8.1.2: Video Octopus runs FFmpeg on downloaded example videos, and older releases have known flaws that crafted media files can exploit. Setup offers `brew install ffmpeg` when Homebrew is available on Mac, or `winget install --id Gyan.FFmpeg -e` on Windows. Both app-offered installation paths succeeded in the hosted tests. A Mac without Homebrew needs the manual installation path.
- **Python and packages:** local transcription, cleanup tools and object separation need the packages listed in the studio's `requirements.txt`. Object separation requires Python 3.10 or newer. Setup reports missing packages; they are not bundled into the app or proven installed by the fresh-runner test.
- **Models:** Whisper and SAM 2.1 weights are separate downloads. The optional “Check my machine” step recommends models, and Setup provides download controls. A successful version or metadata check does not prove a model can complete an editing task.
- **Agents:** Claude Code normally uses its own sign-in; Codex can use its ChatGPT configuration or a supported local provider; Pi uses its configured provider/model or an OpenAI-compatible endpoint. A local model server alone is not an agent runtime: the selected Claude Code, Codex or Pi CLI must also be installed.

Setup's installation and agent-connection controls ask for confirmation; the model **Download** button starts the selected download directly. Skills instruct the agent to ask before installing or downloading. That instruction is not a runtime network restriction: the bundled Whisper script can fetch an uncached model, while the SAM script requires locally cached weights.

## Agents and skills

The shared studio skill directory is `.claude/skills/`, including when you select another agent:

- **Claude Code** runs in the project/studio context and discovers its project skills. “Clean chats” is on by default: it excludes global skills, plugins and MCP connectors. Turn it off in Settings when using the Claude plan if you intentionally need those integrations; alternate Claude model sources force clean mode.
- **Codex** runs through `codex app-server`. The app registers the studio skill directory through `skills/extraRoots/set`. A Codex installation that rejects registration now stops with an actionable error instead of silently starting without the studio skills.
- **Pi** runs in RPC mode with the studio skill directory passed through `--skill`, plus the app's approval extension. Pi integration is experimental. Tool use, vision and editing quality depend on the chosen model.

Each harness validates the same active studio publication before starting a turn. Separate defaults, editable sources and backups are never passed as extra skill roots. Global skills, project-local skills, plugins and MCP configuration belonging to each CLI are outside this manager; use distinct names there. Selecting an engine does not guarantee identical tools or connectors across engines. The app does not automatically migrate MCP configuration between Claude, Codex and Pi.

## Your studio and updates

Keep the application checkout separate from your studio. **Local browser, update, restart and fake-CLI integration tests pass; real providers and the complete Windows update/restart workflow remain unverified.**

```text
Application checkout/                 App-owned, updated together
  core/skills.json                     Skill IDs, versions and app API version
  starter/.claude/skills/              Core instructions and supporting files

Your studio/                          Creator-owned
  preferences/skills.json             Generated supported preference document
  .studio/studio.sqlite               Accepted skills, instructions, brands and learning
  skills/overrides/<stable-id>/        Saved custom versions of core skills
  skills/custom/<unique-name>/         Independent skills you add yourself
  .claude/skills/                      Active copies prepared for the agents
  .studio/skill-manager/               Selections, hashes and recovery backups
  projects/, recordings/, library/    Your videos and reusable assets
```

### Personalize the result with preferences

For everyday changes, save your shared preferences in My style → All channels → Instructions and your brand in each channel's Brand tab. Assistant-written file edits require an explicit import. The supported options in `preferences/skills.json` cover tone, pacing, captions, transcription hints, rough-cut pauses/fillers, review detail, B-roll density, zooms and object-separation preview colour. For example:

```json
{
  "schema": 1,
  "presentation": { "pacing": "calm" },
  "skills": {
    "octopus.rough-cut": {
      "maxGapSeconds": 0.6,
      "keepGapSeconds": 0.5,
      "keepFillers": ["like"]
    }
  }
}
```

See [supported preferences](docs/skill-preferences.md) for allowed values and precedence. Omitted options use core defaults. Existing studios do not need a new file until they customize an option; new studios receive an empty template. App updates and **Update starter files** never replace, recreate or stage replacements for your preferences, memory, `BRAND.md` or `STYLE.md`.

All three agents receive validated options. New videos pin the chosen profile's brand, shared instructions, learned format and selected skill versions; later edits apply to new videos. Legacy projects retain their previous behaviour. Invalid options are reported without rewriting the document. Preferences cannot redefine commands, schemas, timeline units or permissions. Agent instructions are not a sandbox or a guarantee of the model's output.

### Keep custom workflows separate

Add independent skills under `<studio>/skills/custom/<unique-name>/SKILL.md`, then **Settings → General → Updates → Refresh skills**. Use a distinct name, such as `my-channel-intro`, including in its frontmatter. The GitHub installer also uses this area and reserves core and existing personal names, even when disabled or inactive. App updates never fetch newer versions of external skill repositories automatically.

For a deeper change to a core workflow:

1. Select **Make a custom version…** in Settings → General → Updates. It copies the core into your editable `skills/overrides/<stable-id>/` folder and selects that copy.
2. Edit the displayed source folder, then **Refresh skills**. Avoid editing the generated `.claude/skills/` copies. Direct edits there are preserved, but conflicting edits to both copies require manual reconciliation.
3. Later, **Compare with core** shows differences. **Keep my version** acknowledges the available update without merging it. **Use latest core** selects the current core while retaining your custom source. **Use my custom version** selects the saved fork again.

Suppose a release adds captions and improves rough-cut. With preferences, you get both core updates while keeping your chosen pauses and style. With a custom rough-cut workflow, the new captions skill is added while your rough-cut source remains yours. No automatic merge, style extraction or silent replacement occurs.

A saved fork records its original core version separately from the latest available version. Legacy forks with no trustworthy baseline are labelled unknown. An unknown or changed **app API version** pauses that selected fork for review; unrelated compatible skills remain available. Compare and adapt its commands/formats, then choose **I reviewed compatibility…**, or select the latest core. Confirmation records your review; it does not test or repair the skill.

### Receive new features and skills

For an installation made with `git clone`:

1. Finish active agent work, uploads, exports and setup downloads. Save or dismiss unfinished recordings.
2. Open **Settings → General → Updates → Check for updates → Update app and skills**.
3. The supervised launcher pulls a fast-forward app update and restarts. Startup activates matching core skills before new agent work. Other launch methods show manual restart guidance. No conversation prompt or paid operation is automatically replayed.
4. Review any notices about custom versions, new requirements or conflicting names.

With automatic checks enabled, the app checks GitHub shortly after startup and periodically while open, at most once a day after a successful check. It shows an update badge. **Checking does not install the app update.** Core skills update automatically when the new app is activated; no separate skill installation or per-user manifest editing is needed.

The first upgrade from an older app without this updater uses its existing Update and Restart controls. A manual `git pull --ff-only` followed by a restart also activates matching skills. ZIP installations need manual app replacement; keep the ignored `local/` settings/chat folder and your separate studio. Tracked app edits, diverging commits or changed Node/package requirements stop the one-button updater. New skill requirements are notices; updates do not install packages or download models.

| What is installed | What an update does |
| --- | --- |
| Core skill | Selects the new matching core version. |
| Personal preferences | Leaves the files exactly as they are. |
| Selected custom version | Keeps its source and selection; pauses it if API compatibility is unknown or changed. |
| Saved but inactive custom version | Keeps it saved; does not silently select or update it. |
| Independent custom skill | Preserves it. New core-name collisions require review. |
| Proven unchanged legacy starter skill | Migrates it to managed core. |
| Edited or unproven legacy copy | Preserves it as a custom source; asks for compatibility review. |
| Disabled/deleted skill | Preserves the choice; updates do not resurrect it. |
| Removed core skill | Deactivates core; keeps any saved custom source. |

Skill changes use staged copies, a recovery journal and backups. **Restore backup** backs up the current choices and restores a previous skill snapshot, held until **Resume skill updates**. It does not restore app code. Incompatible or unknown core snapshots cannot be activated; incompatible forks stay saved but unavailable. First-migration originals may need manual recovery. Backups are not automatically pruned.

Existing `tools/` helpers use the older preserving updater: unchanged owned files update; edited helpers stay with incoming copies in `.studio/updates/`; deleted helpers stay deleted. Review helpers when a core update needs them. Studio instructions and library templates still have a separate optional **Update starter files** action.

### Release a new core skill

Ship the feature code, its `SKILL.md` and support files, and its `core/skills.json` entry together. Give each skill a permanent ID, unique discovery name, semantic version, source path, legacy aliases and readable dependencies. Keep IDs through renames; increase the skill version whenever its content changes. Reusing a version with different content is rejected.

Keep commands and project formats backward compatible. When a release breaks the skill-facing contract, increase the catalog's integer `apiVersion` and document the migration. This deliberately conservative gate affects custom forks; independent third-party skills do not have verified compatibility metadata. Version metadata cannot detect an undocumented breaking change or prove arbitrary instructions correct.

Keep personal material out of the application repository. Commit only generic templates and feature-supporting skills, never creator studios, recordings, reference studies, learned styles, preferences or manager state. See [design and recovery](docs/managed-skills.md), [preference reference](docs/skill-preferences.md), and [isolated verification](docs/managed-skills-verification.md).

## Data, network access and trust

Media, projects and generated work are stored in your studio. Application settings and chat logs live in the checkout's ignored `local/` directory. While a Claude Code or pi chat runs, its appended system prompt is a user-only file in `local/agent-prompts/` (Windows limits command lines to 32,767 characters); the file is removed when that agent process ends. Optional API keys saved through the app use macOS Keychain or Windows encryption tied to the signed-in user.

Local storage does **not** mean every operation is offline. The selected agent/provider can receive prompts, context and files it reads; cloud transcription sends audio to the selected service. Packaging sends its prompt and the pictures you mark for every thumbnail (never photos marked “Someone else”) to Codex, which generates images on your ChatGPT plan. Update checks and optional skill installation contact GitHub; model downloads contact Hugging Face or the selected model server. Agent tools and third-party skills can make other network requests.

Generated/imported scene HTML and custom background JavaScript run separately from the privileged editor, in opaque sandboxes with scoped local rendering assets. Their policy blocks external network access, workers and privileged app access; download required images, fonts and other assets into the project first. Existing scene kits, local assets, seeking and creator overrides remain supported. This visual-rendering boundary does not sandbox the agent or third-party skills.

## Tested coverage

On 21 October 2026, all nine Node test files passed: **142 tests, zero failures or skips**, including fake-CLI integration across Claude, Codex and pi, turn-lifecycle regressions, eight text-export tests, seven software-decoding/export tests and ten runtime/launcher checks. Generated visuals passed **11 app-preview security checks, nine headless-rendering scenario groups and 12 independent security checks**. Separate browser tests passed 11 managed-skill update/restart scenarios and 12 chat checks. The post-isolation full smoke run plus targeted fixture corrections passed 119 distinct checks, with zero remaining failures and one platform-specific Mac Vision skip. Actual offline transcription used cached tiny.en weights and synthetic speech. These results used Node v24.21.0 on macOS ARM64 with the uncommitted implementation atop `b7a733d68272089f24db0727d3f728c64f42b272`; see [commands, results and limits](docs/managed-skills-verification.md).

Testing fixed stale agent skill context, lost Undo/proposal snapshots, transcript/subtitle previews unexpectedly writing `work/shots.json`, generated-code access to app privileges, and failed background-export process cleanup. Text previews now use a read-only timeline and preserve earlier export versions. No real creator data, provider credentials, paid inference or physical recording was used. Real vendor CLI compatibility, SAM/MLX inference and native Windows behavior are not established by these Mac tests.

The [21 October native Windows verification](https://github.com/Barty-Bart/video-octopus/actions/runs/39516163887) passed on Windows 2025 x64, Node v22.23.3 and FFmpeg 9.0.2 at `3226c14b0eadf8b7b3921cf641a6395c7fd731d3` (`codex/release-blocker-fixes`). It passed first launch, studio creation, Edge onboarding, app-offered FFmpeg installation, synthetic import, WAV export and the original two-second 1080p H.264/AAC MP4 fixture. Seven regression tests also passed, including reordered blocks, file inserts, shot seeking/transitions and layer/alpha exports. All 160 production files under `server/`, `web/` and `core/` matched the locally verified source. The older failure below is historical.

The [20 October 2026 fresh-runner test](https://github.com/Barty-Bart/video-octopus/actions/runs/39393807261) used branch `codex/clean-install-check`, commit `71c0c1e049d28b7be978e7e22b666883f3dd2b09`. That commit adds only test files to application commit `aa305bc6dcb4703533de4ee63ed51b3480e7a36b`.

| Check | Hosted macOS 15 ARM64 | Hosted Windows 2025 x64 |
| --- | --- | --- |
| README launcher, default studio creation and setup UI | Passed | Passed |
| Missing-agent/dependency display and Continue without an agent | Passed | Passed |
| App-offered FFmpeg installation | Passed, Homebrew | Passed, winget |
| Synthetic media import and two-second WAV export | Passed | Passed |
| Two-second H.264/AAC MP4 export | Passed | **Failed: FFmpeg filtergraph error** |
| Local-provider metadata fixtures and settings routing | Passed with mocks | Passed with mocks |

These were fresh hosted accounts and checkouts with preinstalled Git, browsers, Python and package managers; Node 22 was supplied as a prerequisite. They were not bare consumer machines. Actual AI inference, CLI sign-in, model downloads, transcription, SAM processing and physical device recording were **not** exercised in this run. Metadata mocks do not establish real provider compatibility.

Other limitations: layer exports do not preserve every MP4 transition or animated zoom; timeline XML omits the app's visual styling, and import into external editing applications is unverified. End-to-end quality depends on the installed tools, models, agent and source media.

## Distribution status

No top-level application licence has been selected. [Asset provenance](docs/asset-provenance.md) records the bundled Geist font notice under `web/fonts/`; third-party models, dependencies and optional skills have separate terms. Do not infer that the whole application or every included asset has the same licence.

Automatic publishing, a managed cloud rendering service and a complete packaged installer are not shipped features.

## Video formats and local storage

Profiles now have versioned brands and optional website research with review before saving. Shared instructions live in SQLite. New video automatically loads the selected brand, approved format and relevant skills. Profiles and formats can learn from references, with evidence-backed proposals for your review. Approved versions stay pinned to their projects. Skills now live in a local SQLite database with Core, Customized core and Personal views, in-app editing, retained history and recovery. Agents receive generated skill files; video and audio stay as ordinary files. New studios default to local application storage, and existing studios stay in place. See [learning and storage](docs/learning-and-storage.md) for the workflow, migration and backup boundaries.

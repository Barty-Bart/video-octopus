# Video Octopus

A local video editor with an AI assistant. Record or import footage, edit from the transcript, plan scenes, adjust layouts and zooms, and export from a browser. The app connects to a separately installed **Claude Code, Codex or Pi** agent; it does not include an AI subscription or a bundled language model.

**Early development.** A fresh hosted Mac passed installation and a basic MP4 export. The same Windows test passed startup, FFmpeg installation and WAV export, but **MP4 export failed**. See [tested coverage](#tested-coverage) before relying on it for a production.

## What is included

| Area | What ships |
| --- | --- |
| Recording | Screen, camera and microphone recording in Chrome or Edge; camera-only and mic-only takes; a script overlay/teleprompter. Screen capture does not include system audio. Browser and operating-system permissions are required. |
| Editing | A built-in transcript/waveform Cut tab, cut review and locking, ordered blocks, project folders and source media kept separately from generated work. AI-assisted cleanup uses the bundled skills below. |
| Scenes | Production-sheet scenes, timed comments, generated HTML scene previews, direct element overrides and keyframes for compatible scenes. The scene toolkit is included; the agent supplies the scene code. |
| Layouts and motion | Screen/camera layouts, PiP framing, backgrounds, per-shot looks, transitions, camera punch-ins and screen-region zooms. Proposed agent zooms can be kept or rejected. |
| Object separation / rotoscoping | A bundled SAM 2.1 skill and script that track a selected subject and produce frame masks and review outputs for compositing. This needs Python dependencies and a separately downloaded model; it is not a ready-to-run one-click model bundled with the app. |
| Exports | MP4; WAV, M4A/AAC and MP3; transcript text/Markdown; SRT/VTT and burned captions; layer exports and timeline XML. Windows MP4 and other limitations are listed below. |
| Project formats | YouTube tutorial, faceless explainer, Short and product explainer. |

### Six bundled starter skills

First launch copies these into your studio's `.claude/skills/`:

| Skill | Purpose | Additional requirements |
| --- | --- | --- |
| `transcribe` | Local word timestamps, transcript and subtitles using faster-whisper or MLX Whisper. | Python packages, FFmpeg and a Whisper model. MLX requires Apple Silicon and native ARM64 Python. |
| `rough-cut` | Transcript-based cleanup and edit decisions for fillers, pauses and retakes. | Agent, Python/NumPy and FFmpeg; a transcript. |
| `join-check` | Find potentially clipped words at edit joins and propose repaired cut boundaries. | Python/NumPy and FFmpeg; optional Whisper rechecking. |
| `production-sheet` | Plan the video scene by scene and write the files shown in the Scenes tab. | Agent; source transcript and locked cut. |
| `talking-head-zoom` | Plan timed camera punch-ins and zoom-outs as editable proposals. | Agent and timed words; the app previews and exports the accepted zooms. |
| `object-separation` | Select and track a person or object with SAM 2.1, producing masks for graphics behind or around it. | Python/PyTorch, torchvision, Transformers, NumPy, Pillow, FFmpeg and a SAM 2.1 model. GPU support affects speed. |

These are general editing skills distributed with the app. Personal creator styles, campaign notes and private project libraries are not part of this starter.

Motion-graphics infrastructure is built in, but a specialized motion-design skill is **not** among the six bundled skills. Setup can optionally install selected skills from a GitHub repository. Installing a skill does not install every renderer, model or service that it might require. Review third-party code and its licence before use.

## Start from source

Have these ready:

- Git and access to this repository while it remains private.
- Node.js **22**, the version used for the fresh-runner tests. The launcher currently mentions 20+, but Node 20 compatibility has not been verified.
- Chrome or Edge for the browser UI and recording.
- For AI work, a separately installed agent and a usable model/provider. You can enter the editor without one.

On macOS, in Terminal:

```bash
git clone https://github.com/Barty-Bart/video-octopus.git
cd video-octopus
./start.sh
```

On Windows, in PowerShell:

```powershell
git clone https://github.com/Barty-Bart/video-octopus.git
cd video-octopus
.\start.cmd
```

If a browser does not open, go to <http://127.0.0.1:4800>. There is no application `npm install` step.

### First launch and dependencies

The app creates a studio outside the application checkout: `~/Video Octopus` on Mac or `%USERPROFILE%\Video Octopus` on Windows. It contains starter instructions, skills, tools, library folders, projects and recordings.

Setup scans Claude Code, Codex, LM Studio, Ollama and Pi, and checks tools such as FFmpeg and Python. **Continue works even when dependencies or agents are missing**; this does not make their dependent features ready.

- **FFmpeg and ffprobe:** needed for media processing and export. Setup offers `brew install ffmpeg` when Homebrew is available on Mac, or `winget install --id Gyan.FFmpeg -e` on Windows. Both app-offered installation paths succeeded in the hosted tests. A Mac without Homebrew needs the manual installation path.
- **Python and packages:** local transcription, cleanup tools and object separation need the packages listed in the studio's `requirements.txt`. Object separation requires Python 3.10 or newer. Setup reports missing packages; they are not bundled into the app or proven installed by the fresh-runner test.
- **Models:** Whisper and SAM 2.1 weights are separate downloads. The optional “Check my machine” step recommends models, and Setup provides download controls. A successful version or metadata check does not prove a model can complete an editing task.
- **Agents:** Claude Code normally uses its own sign-in; Codex can use its ChatGPT configuration or a supported local provider; Pi uses its configured provider/model or an OpenAI-compatible endpoint. A local model server alone is not an agent runtime: the selected Claude Code, Codex or Pi CLI must also be installed.

Setup's installation and agent-connection controls ask for confirmation; the model **Download** button starts the selected download directly. Skills instruct the agent to ask before installing or downloading. That instruction is not a runtime network restriction: the bundled Whisper script can fetch an uncached model, while the SAM script requires locally cached weights.

## Agents and skills

The shared studio skill directory is `.claude/skills/`, including when you select another agent:

- **Claude Code** runs in the project/studio context and discovers its project skills. “Clean chats” is on by default: it excludes global skills, plugins and MCP connectors. Turn it off in Settings when using the Claude plan if you intentionally need those integrations; alternate Claude model sources force clean mode.
- **Codex** runs through `codex app-server`. The app registers the studio skill directory through `skills/extraRoots/set`. Compatibility depends on the installed Codex version; registration errors are currently ignored.
- **Pi** runs in RPC mode with the studio skill directory passed through `--skill`, plus the app's approval extension. Pi integration is experimental. Tool use, vision and editing quality depend on the chosen model.

Selecting an engine does not guarantee identical tools or connectors across engines. The app does not automatically migrate MCP configuration between Claude, Codex and Pi.

## Your studio and updates

Keep the application checkout and your studio separate. Use the app repository for versioned application code and starter templates; keep custom skills, projects, recordings, brand files and preferences in the studio.

Add custom skills under unique names in `<studio>/.claude/skills/`. The GitHub skill installer refuses to overwrite an existing skill. You do not need to put personal skills into the application repository.

### Getting a new app version and its new skills

For an existing installation made with `git clone`:

1. Open **Settings → Updates → Check for updates**, then **Update now**. The app uses Git fetch and a fast-forward-only pull to update the application checkout.
2. Select **Restart Video Octopus** to run the new code. This button works when started through `start.sh` or `start.cmd`; otherwise restart it using the method you used to start it.
3. In **Settings → Updates → Starter files**, review the listed additions and changes, then select **Update starter files**. This separate action copies new bundled skills and other starter files into your existing studio.

No reinstall or manual manifest edit is needed. With the default update-check setting enabled, the app checks shortly after startup and periodically while open, at most once a day after a successful check. It shows a **New** badge; it does not automatically install the update or sync the starter. A manual `git pull --ff-only` in the application checkout is another way to fetch the code, but restart and starter sync are still separate.

The updater refuses tracked local changes or local commits that prevent a fast-forward update. Git can also refuse an update that would collide with an untracked file. A ZIP download cannot use the one-button Git update; Settings provides manual replacement instructions. Preserve its `local/` settings/chat folder and the separate studio.

Starter sync compares individual files with the hashes recorded in `<studio>/.studio/starter.json`:

| File state | What happens when you select Update starter files |
| --- | --- |
| New starter file, no file at that path | Added to the studio. |
| Existing starter file you have not changed | Updated in place. |
| File you customized, or a different user file at the same path | Your file stays; the incoming version goes under `.studio/updates/` for manual comparison. |
| File already identical to the incoming version | Recorded in the manifest without rewriting it. |
| Previously installed starter file you deleted | Stays deleted. |
| File removed from the new app starter | Its existing studio copy is not automatically removed. |
| Studio without `.studio/starter.json` | Left alone; there is no automatic adoption or migration. |

Collision and deletion handling is **per file, not per skill folder**. If a new bundled skill shares a name with your custom skill, missing files can be added inside that folder while your conflicting files stay. Similarly, a later release can introduce new filenames inside a skill folder you previously deleted. Use distinct names for personal skills. Projects, recordings and custom files outside the starter's file paths are not part of this sync.

For maintainers: add and commit each new bundled skill's `SKILL.md` and supporting files under `starter/.claude/skills/<skill-name>/`, then publish them on the branch your users follow. Adding those files is sufficient for starter discovery; there is no separate skill registry or mandatory `starter/VERSION` bump. Empty folders are not distributed by Git. Files placed elsewhere in the repository are not automatically copied as studio skills. The per-studio manifest is created and updated by the app.

This is the implemented behavior, not a proposed updater. The current design uses one shared skill directory with tracked starter ownership; it does not implement separate automatic “core” and “user” skill search paths. Optional skills installed from another GitHub repository use a separate installer that skips existing skill names; starter sync is not an updater for those external skills.

## Data, network access and trust

Media, projects and generated work are stored in your studio. Application settings and chat logs live in the checkout's ignored `local/` directory. Optional API keys saved through the app use macOS Keychain or Windows encryption tied to the signed-in user.

Local storage does **not** mean every operation is offline. The selected agent/provider can receive prompts, context and files it reads; cloud transcription sends audio to the selected service. Update checks and optional skill installation contact GitHub; model downloads contact Hugging Face or the selected model server. Agent tools, third-party skills and scene assets can make other network requests.

Generated/imported scene HTML and custom background JavaScript are executable code. Their current execution is not isolated from the privileged app origin. Only open trusted projects and skills; this version is not a hardened sandbox.

## Tested coverage

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

No top-level application licence has been selected. Bundled fonts include their own licence notices under `web/fonts/`; third-party models, dependencies and optional skills have separate terms. Do not infer that the whole application or every included asset has the same licence.

Automatic publishing, a managed cloud rendering service and a complete packaged installer are not shipped features.

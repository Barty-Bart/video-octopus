# Checking this computer

Setup starts with **Check my computer** and **Skip for now**. Opening this page
alone does not start its agent, tool or environment scans. The app's ordinary
status checks are separate. Clicking Check looks for installed agent tools and
available sign-in status, FFmpeg, local Python environments and hardware. It
neither connects a provider nor installs packages or downloads models.

## Existing Python environments

Python packages belong to an environment, not the computer as a whole. A bare
global Python can coexist with a fully provisioned video-project environment.
The environment list distinguishes package discovery from verified imports.

Discovery checks the configured interpreter, selected studio, active environment,
PATH, standard global locations, and common uv, pyenv, mise, venv and Conda
locations. It also looks for project and app environments (`findProjectEnvironments`
in `server/python-environments.mjs`): a `.venv`, `venv` or `env` folder, or a
folder with `pyvenv.cfg`, up to two folders deep in `~/Movies`, `~/Videos`,
`~/Developer`, `~/Projects`, `~/code`, `~/src`, `~/dev`, `~/Documents`,
`~/Downloads`, `~/Desktop` (and `~/source/repos` on Windows) and the studio's
parent folder, one folder deep in the home folder, and two deep in apps' data
(`~/Library/Application Support` on a Mac, `%LOCALAPPDATA%` and `%APPDATA%` on
Windows, `~/.local/share` on Linux). It reads directory listings breadth-first,
never follows symlinked folders, skips hidden folders, app bundles and media
libraries, node_modules and Apple's own Application Support folders, and stops at
1,500 folders, 2 seconds or 16 environments, whichever comes first. The scan's
status line names every root it read. macOS may ask once whether the app may read
Documents, Desktop or Downloads; declining skips them. An app's own environment
(OpenToolkit's is in `Application Support/Pico/Speech/venv`) is labelled and ranks
after a project's, because that app may change it. Project candidates come before
global ones, so the 32-interpreter cap drops bare global Pythons first. It lists
at most 32 interpreters and probes two at a time with a five-second limit per
metadata probe. Parent-directory aliases and matching reported environment
prefixes deduplicate; distinct venvs sharing one underlying Python stay separate.
It never crawls the whole disk.

When nothing found can transcribe, **Ask the assistant to look for it** sends the
selected agent a read-only search request (`web/python-search.js`): Spotlight,
`find` with exclusions and a time limit, apps' folders, conda/pyenv/uv, and the
Hugging Face cache. It must not install, download or change anything. It reports
places with `octopus python suggest <path>`, which only records the path in this
app's local settings (`pythonSuggestions`, at most 8); the page polls for those
for 20 minutes and scans again, listing them as "Found by the assistant".
Selecting one is still the creator's **Use this**.

Use **Existing environment or project folder** to enter an absolute path to a
Python executable, environment folder or project. For a project, only its `.venv`,
`venv` and `env` locations are checked. A chosen location takes priority over the
candidate limit. Custom environment-manager roots can be entered here too.

Recommendations require Python 3.10+ and prefer usable transcription plus editing
libraries, then object separation. Native Apple Silicon MLX is preferred when its
packages are available; otherwise faster-whisper is considered. parakeet-mlx
(Apple Silicon only) counts as a transcription engine too, and an environment with
more engines ranks higher. The best match is shown first with **Use this**. Hardware also
suggests a model size independently. Models and packages are separate checks.

**Verify** imports the installed modules and checks the SAM 2 video API. It runs
the chosen executable directly, ignoring PYTHONPATH and removing the current
directory from module lookup while retaining normal user-installed packages. Bytecode writing is disabled and Hugging Face/Transformers offline flags. No model is constructed.
Imports have a 60-second limit and can fail because of incompatible dependencies,
missing GPU access or a damaged environment. This is a compatibility check, not
an end-to-end transcription/render benchmark or an OS sandbox.

**Use this environment** requires confirmation and fresh metadata/import checks.
The path, preferred automatic transcription engine and whether it has Parakeet
(`pythonParakeet`, which makes Settings › Transcription offer Parakeet) are saved in
this app's local settings. Future agent turns receive STUDIO_PYTHON, the executable directory
on PATH, and an instruction to use that interpreter. Explicit transcription
engine and provider choices remain authoritative. Active agent work finishes
before its environment refreshes. No shell profile or other project's files are
modified. Keep a reused environment in place; later package changes can affect
both projects. A failed verification does not change the selected environment.

**Plan a dedicated environment** explicitly asks the selected agent for a setup
plan, using an ordinary agent turn. It must ask before creating a venv, installing
packages or downloading models. Skipping the scan never starts that agent turn.

## Verification

`node --test test/python-environments.test.mjs test/python-scan.test.mjs` covers bounded discovery (project/app depth, skipped folders, folder/time/environment caps), explicit
project selection, separate venv identity, Windows directory layouts, ranking,
unsupported versions/import failures, unavailable executables, alias deduplication
and propagation into child tools/agent instructions. Windows layouts are tested
with filesystem fixtures; native Windows runtime execution needs Windows QA.

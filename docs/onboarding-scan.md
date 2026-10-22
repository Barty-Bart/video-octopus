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
locations. It lists at most 32 interpreters and probes two at a time with a
five-second limit per metadata probe. Parent-directory aliases and matching
reported environment prefixes deduplicate; distinct venvs sharing one underlying
Python stay separate. It does not recursively crawl personal project folders.

Use **Existing environment or project folder** to enter an absolute path to a
Python executable, environment folder or project. For a project, only its `.venv`,
`venv` and `env` locations are checked. A chosen location takes priority over the
candidate limit. Custom environment-manager roots can be entered here too.

Recommendations require Python 3.10+ and prefer usable transcription plus editing
libraries, then object separation. Native Apple Silicon MLX is preferred when its
packages are available; otherwise faster-whisper is considered. Hardware also
suggests a model size independently. Models and packages are separate checks.

**Verify** imports the installed modules and checks the SAM 2 video API. It runs
the chosen executable directly, ignoring PYTHONPATH and removing the current
directory from module lookup while retaining normal user-installed packages. Bytecode writing is disabled and Hugging Face/Transformers offline flags. No model is constructed.
Imports have a 60-second limit and can fail because of incompatible dependencies,
missing GPU access or a damaged environment. This is a compatibility check, not
an end-to-end transcription/render benchmark or an OS sandbox.

**Use this environment** requires confirmation and fresh metadata/import checks.
The path and preferred automatic transcription engine are saved in this app's
local settings. Future agent turns receive STUDIO_PYTHON, the executable directory
on PATH, and an instruction to use that interpreter. Explicit transcription
engine and provider choices remain authoritative. Active agent work finishes
before its environment refreshes. No shell profile or other project's files are
modified. Keep a reused environment in place; later package changes can affect
both projects. A failed verification does not change the selected environment.

**Plan a dedicated environment** explicitly asks the selected agent for a setup
plan, using an ordinary agent turn. It must ask before creating a venv, installing
packages or downloading models. Skipping the scan never starts that agent turn.

## Verification

`node --test test/python-environments.test.mjs` covers bounded discovery, explicit
project selection, separate venv identity, Windows directory layouts, ranking,
unsupported versions/import failures, unavailable executables, alias deduplication
and propagation into child tools/agent instructions. Windows layouts are tested
with filesystem fixtures; native Windows runtime execution needs Windows QA.

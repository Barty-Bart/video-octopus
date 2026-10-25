// Setup › Python environments, without the page: which environment to offer first, whether to offer "Ask the
// assistant to look for it", and what that request says. No imports, so tests read it directly.

// The best match: the scan's recommendation (the highest-ranked one with transcription libraries), else none.
export function bestMatch(snapshot) {
  if (!snapshot?.recommended) return null;
  return (snapshot.environments || []).find((x) => x.path === snapshot.recommended && x.supported && x.transcription) || null;
}

// The assistant's search is offered only when the bounded scan found nothing that can transcribe here.
export function askAgentShown(snapshot) {
  return Boolean(snapshot && Array.isArray(snapshot.environments) && !bestMatch(snapshot));
}

// The libraries an environment has for Video Octopus, in words.
export function enginesText(item) {
  const names = { mlx: 'MLX Whisper', parakeet: 'Parakeet', 'faster-whisper': 'faster-whisper' };
  return (item?.engines || (item?.engine ? [item.engine] : [])).map((e) => names[e] || e).join(', ');
}

// The request to the creator's agent: a read-only search of the whole computer, a report, and the creator's own
// selection afterwards. `scope` is what the bounded scan already looked through.
export function pythonSearchBrief({ scope = '', cli = '"$STUDIO_OCTOPUS"' } = {}) {
  return [
    'Please look for a Python environment on this computer that Video Octopus can use for transcription.',
    `Video Octopus's own scan found none with the transcription libraries. It already looked through: ${scope || 'PATH, standard Python managers and common project folders'}`,
    'Look read-only: do not install, download, create, move, change or delete anything (no pip, no venv creation, no model downloads, no edits to any environment or app).',
    'What counts: a Python 3.10 or newer that has numpy plus at least one of mlx-whisper (mlx_whisper), parakeet-mlx (parakeet_mlx) or faster-whisper (faster_whisper).',
    'How to look, each with a time limit (about a minute each, for example `timeout 60` where available) and skipping caches, .Trash, node_modules, .git and system folders (/System, /Library/Caches, ~/Library/Caches, /private, /proc, C:\\Windows):',
    '- Spotlight on a Mac: mdfind "kMDItemFSName == pyvenv.cfg" and mdfind -name parakeet_mlx, mdfind -name mlx_whisper, mdfind -name faster_whisper;',
    '- find from the home folder (and other drives you see), for example: find ~ -maxdepth 7 \\( -name .Trash -o -name node_modules -o -name .git -o -name Caches -o -name .cache \\) -prune -o -name pyvenv.cfg -print; on Windows, the same idea with Get-ChildItem -Filter pyvenv.cfg -Recurse -Depth 6 -ErrorAction SilentlyContinue;',
    '- apps that bring their own Python for speech or transcription (OpenToolkit keeps one in ~/Library/Application Support/Pico/Speech/venv; MacWhisper, Dictate, Pinokio, ComfyUI, LM Studio-style tools and similar), in ~/Applications, /Applications, ~/Library/Application Support or %LOCALAPPDATA%;',
    '- conda, pyenv, uv, pipx and Homebrew Pythons;',
    '- the Hugging Face cache (~/.cache/huggingface/hub, or $HF_HUB_CACHE) for models already downloaded: models--mlx-community--parakeet-tdt-*, models--mlx-community--whisper-*, models--Systran--faster-whisper-*. Only list them.',
    'For each candidate, check it by running its own Python with -c to print its version and try importing numpy, mlx_whisper, parakeet_mlx and faster_whisper (imports only; never load a model).',
    `Then report what you found, best first: the path, Python version, which of those libraries import, and which downloaded models fit. For the best one (and any other good one), run node ${cli} python suggest "<absolute path to its python or its environment folder>", which only tells Video Octopus's Setup about it. Do not select it yourself: tell me to press Use this on it in Setup → Python environments, which checks its imports again and asks me to confirm.`,
    'If you find nothing suitable, say so in one line and tell me the choices: Check this location in Setup if I know where it is, or a dedicated environment (ask me before setting one up).',
  ].join('\n');
}

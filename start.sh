#!/usr/bin/env bash
# Start Video Octopus and open it in the browser (Mac and Linux; start.cmd on Windows).
# Video Octopus restarts itself here after an update (Settings → Updates → Restart): the server exits with code 75 and this
# loop starts it again. Any other exit (Ctrl+C, a crash) ends the loop.
#   STUDIO_NO_OPEN=1   don't open the browser (Open Video Octopus when I log in starts it this way)
#   STUDIO_LOG=<file>  append everything Video Octopus prints to that file
#   PORT=<n>           another port than 4800
set -uo pipefail
cd "$(dirname "$0")"
[ -n "${STUDIO_LOG:-}" ] && exec >>"$STUDIO_LOG" 2>&1

NODE="$(command -v node || true)"
for p in "$HOME/.local/opt/node/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -z "$NODE" ] && [ -x "$p" ] && NODE="$p"
done
if [ -z "$NODE" ]; then
  echo "Video Octopus needs Node.js 22.2 or newer: https://nodejs.org" >&2
  exit 1
fi
"$NODE" server/runtime-check.cjs || exit 1

PORT="${PORT:-4800}"
if [ "${STUDIO_NO_OPEN:-}" != "1" ]; then
  OPEN="$(command -v open || command -v xdg-open || true)"
  [ -n "$OPEN" ] && (sleep 1 && "$OPEN" "http://127.0.0.1:$PORT" >/dev/null 2>&1) &
fi

export STUDIO_SUPERVISED=1 # tells the server that Restart works here
while true; do
  "$NODE" server/index.mjs
  code=$?
  [ "$code" -eq 75 ] || exit "$code"
  echo "Restarting Video Octopus…"
done

#!/bin/sh
# Start the deck server in the background unless something already answers on
# its port. Run by the agent-deck:// URL handler (scripts/install-app.sh), which
# is what the installed app's "Launch backend" button opens.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${DECK_STATE_DIR:-$HOME/.agent-deck}"
# PATH and node as they were in the installing shell; apps launched from the
# Finder get a bare PATH with no node, claude, git or editor on it.
[ -f "$STATE/launcher.env" ] && . "$STATE/launcher.env"
PORT="${DECK_PORT:-7777}"

if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/api/health"; then exit 0; fi

mkdir -p "$STATE"
cd "$DIR" || exit 1
echo "--- $(date) launched by $(basename "$0")" >>"$STATE/server.log"
nohup "${NODE:-node}" server.mjs --port "$PORT" >>"$STATE/server.log" 2>&1 </dev/null &

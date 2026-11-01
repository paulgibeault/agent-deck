#!/bin/sh
# Bring the open-act SSH tunnel to the model host back up, and say what was wrong.
# Run it from a terminal, or from the deck's heal button (POST /api/tunnel/heal).
#
# The tunnel is the launchd agent org.open-act.tunnel (KeepAlive ssh -N with a
# LocalForward). It goes down for good when the agent is unloaded, or when a
# stray ssh holds the local port so the agent's ssh fails its forward. Neither
# heals by itself; this script fixes both. It cannot wake the model host: if
# it does not resolve or answer on SSH, it says so and exits 2.
#
# Exit: 0 healthy · 1 tunnel up, model server down · 2 model host unreachable · 3 tunnel still down
CONF="$HOME/.config/open-act/client.conf"
SSHCONF="$HOME/.ssh/open-act_config"
LABEL=org.open-act.tunnel
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/open-act-tunnel.log"
DOMAIN="gui/$(id -u)"

# Not sourced: values like "Qwen3.6 35B A3B (fast)" are not valid shell.
# A trailing "# comment" and surrounding quotes are dropped, as lib/llm.mjs does.
conf() { sed -n "s/^[[:space:]]*$1=//p" "$CONF" 2>/dev/null | tail -1 | sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/'; }
# The model host: client.conf's NODE_HOST, else the tunnel's own ssh alias. Only
# the reachability probe and the messages need it; the tunnel uses the alias.
HOST="$(conf NODE_HOST)"
[ -n "$HOST" ] || HOST="$(ssh -G -F "$SSHCONF" open-act-node 2>/dev/null | awk '/^hostname /{print $2}')"
NAMED="$HOST"; HOST="${HOST:-the model host}"
PORT="$(conf LOCAL_PORT)"; PORT="${PORT:-8080}"
SSHPORT="$(conf NODE_SSH_PORT)"; SSHPORT="${SSHPORT:-22}"
MODEL_PORT="$(conf MODEL_PORT)"

say() { printf '%s\n' "$*"; }
model_ok() { curl -s -o /dev/null --max-time 3 -w '%{http_code}' "http://127.0.0.1:$PORT/v1/models" | grep -q '^200$'; }
listening() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }
loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }
agent_pid() { launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '/^\tpid = /{print $3}'; }

if model_ok; then say "ok: tunnel to $HOST is up and the model answers on 127.0.0.1:$PORT"; exit 0; fi

# 1. Can we reach the model host at all? (Skipped when nothing names it.)
if [ -z "$NAMED" ]; then
  say "no NODE_HOST in $CONF and no open-act-node alias; skipping the reachability check"
elif ! nc -z -G 5 "$HOST" "$SSHPORT" >/dev/null 2>&1; then
  say "model host unreachable: $HOST does not answer on port $SSHPORT (asleep, off, or not on this network)."
  say "Wake it or check its network, then heal again."
  exit 2
fi
say "model host reachable: $HOST:$SSHPORT"

# 2. A stray ssh (e.g. a manual 'ssh -f -N open-act-node') holding the port
#    blocks the agent's forward. Remove ssh listeners that are not the agent's.
APID="$(agent_pid)"
for pid in $(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do
  [ "$pid" = "$APID" ] && continue
  if ps -o comm= -p "$pid" | grep -q 'ssh$'; then say "removing stray ssh $pid on port $PORT"; kill "$pid"; fi
done

# 3. Load the agent if it is not loaded; otherwise restart its ssh.
if loaded; then
  say "restarting $LABEL"
  launchctl kickstart -k "$DOMAIN/$LABEL"
else
  [ -f "$PLIST" ] || { say "no launch agent at $PLIST; starting a one-off tunnel instead"; ssh -F "$SSHCONF" -f -N open-act-node; }
  [ -f "$PLIST" ] && { say "loading $LABEL (it was not loaded, so KeepAlive could not revive it)"; launchctl bootstrap "$DOMAIN" "$PLIST"; }
fi

# 4. Wait for the forward, then for the model behind it.
i=0; while [ $i -lt 20 ] && ! listening; do sleep 0.5; i=$((i+1)); done
if ! listening; then
  say "tunnel still down: nothing listening on 127.0.0.1:$PORT. Last log lines:"
  tail -5 "$LOG" 2>/dev/null
  exit 3
fi
i=0; while [ $i -lt 10 ] && ! model_ok; do sleep 1; i=$((i+1)); done
if model_ok; then say "ok: tunnel up and the model answers on 127.0.0.1:$PORT"; exit 0; fi
say "tunnel up, but the model server on $HOST:${MODEL_PORT:-8080} is not answering. Start llama-server on $HOST."
exit 1

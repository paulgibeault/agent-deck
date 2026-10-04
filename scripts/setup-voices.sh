#!/bin/sh
# Install (or with --uninstall, remove) Kokoro voices for Read aloud: the
# kokoro-js package and its 82M model, generated on this machine. They go in
# the deck's state folder, not the repo, so agent-deck keeps no dependencies.
# The running server picks them up without a restart.
set -e
STATE="${DECK_STATE_DIR:-$HOME/.agent-deck}"
HOME_K="$STATE/kokoro"

if [ "$1" = --uninstall ]; then
  rm -rf "$HOME_K"
  echo "Removed Kokoro voices ($HOME_K). Restart the deck to free its memory."
  exit 0
fi

command -v npm >/dev/null || { echo "setup-voices: npm not found on PATH" >&2; exit 1; }

echo "Installing kokoro-js into $HOME_K"
mkdir -p "$HOME_K"
[ -f "$HOME_K/package.json" ] || printf '{ "name": "agent-deck-kokoro", "private": true, "type": "module" }\n' >"$HOME_K/package.json"
(cd "$HOME_K" && npm install --no-audit --no-fund --loglevel=error kokoro-js@^1.2)

echo "Downloading the model (about 330 MB, once) and checking it speaks"
OUT="$(cd "$HOME_K" && node --input-type=module -e "
  import { KokoroTTS } from 'kokoro-js';
  const t0 = performance.now();
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu' });
  const t1 = performance.now();
  const a = await tts.generate('Kokoro voices are ready.', { voice: 'af_heart' });
  const secs = (performance.now() - t1) / 1000, dur = a.audio.length / a.sampling_rate;
  console.log('Model ready in ' + ((t1 - t0) / 1000).toFixed(1) + 's; ' + dur.toFixed(1) + 's of speech took ' + secs.toFixed(2) + 's.');
" 2>&1)" || { echo "$OUT" >&2; echo "setup-voices: the model did not load" >&2; exit 1; }
echo "$OUT" | grep -v -i warning

echo
echo "Done. In the deck, open Read aloud settings (the speaker): the Kokoro voices"
echo "are at the top of Voice. Remove them with: npm run setup-voices -- --uninstall"

if [ "$(uname)" = Darwin ]; then
  cat <<'EOF'

Optional, also free: Apple's Premium voices, for the browser's Local voices.
  System Settings → Accessibility → Spoken Content → System voice →
  Manage Voices… → English → download e.g. Zoe (Premium) or Ava (Premium).
  Then quit and reopen the browser.
EOF
fi

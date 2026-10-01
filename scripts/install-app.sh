#!/bin/sh
# Install (or with --uninstall, remove) the macOS helper that handles
# agent-deck:// links, so the web app's "Launch backend" button can start the
# server. The helper is a tiny AppleScript applet in ~/Applications.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${DECK_STATE_DIR:-$HOME/.agent-deck}"
APP="$HOME/Applications/Agent Deck Launcher.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

if [ "$(uname)" != Darwin ]; then
  echo "install-app: the launcher is macOS only. Start the backend with: node $DIR/server.mjs" >&2
  exit 1
fi

if [ "$1" = --uninstall ]; then
  [ -d "$APP" ] && "$LSREGISTER" -u "$APP" 2>/dev/null || true
  rm -rf "$APP" "$STATE/launcher.env"
  echo "Removed $APP"
  exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "install-app: node not found on PATH" >&2; exit 1; fi

mkdir -p "$STATE" "$HOME/Applications"
{
  printf "export PATH='%s'\n" "$PATH"
  printf "NODE='%s'\n" "$NODE"
} >"$STATE/launcher.env"
chmod +x "$DIR/scripts/launch-backend.sh"

LAUNCH="/bin/sh $(printf %s "$DIR/scripts/launch-backend.sh" | sed "s/'/'\\\\''/g; s/^/'/; s/$/'/")"
rm -rf "$APP"
osacompile -o "$APP" \
  -e 'on open location theURL' \
  -e "  do shell script \"$LAUNCH\"" \
  -e 'end open location' \
  -e 'on run' \
  -e "  do shell script \"$LAUNCH\"" \
  -e 'end run' 2>"$STATE/osacompile.err" || { cat "$STATE/osacompile.err" >&2; exit 1; }
# osacompile signs the applet and says so on stderr; pass on anything else.
grep -v 'replacing existing signature' "$STATE/osacompile.err" >&2 || true
rm -f "$STATE/osacompile.err"

PL="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Delete :CFBundleIdentifier' "$PL" 2>/dev/null || true
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string dev.agent-deck.launcher' "$PL"
/usr/libexec/PlistBuddy -c 'Add :LSUIElement bool true' "$PL"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes array' \
  -c 'Add :CFBundleURLTypes:0 dict' \
  -c 'Add :CFBundleURLTypes:0:CFBundleURLName string agent-deck launcher' \
  -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array' \
  -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string agent-deck' "$PL"

# Give the helper the deck icon (best effort).
TMP="$(mktemp -d)"
if mkdir "$TMP/deck.iconset" && for s in 16 32 128 256 512; do
     sips -z $s $s "$DIR/public/icons/icon-512.png" --out "$TMP/deck.iconset/icon_${s}x${s}.png" >/dev/null &&
     sips -z $((s*2)) $((s*2)) "$DIR/public/icons/icon-512.png" --out "$TMP/deck.iconset/icon_${s}x${s}@2x.png" >/dev/null || exit 1
   done && iconutil -c icns -o "$APP/Contents/Resources/applet.icns" "$TMP/deck.iconset"; then :; fi
rm -rf "$TMP"

codesign --force --sign - "$APP" >/dev/null 2>&1 || true
"$LSREGISTER" -f "$APP"

echo "Installed $APP"
echo "agent-deck:// links now start the backend from $DIR (log: $STATE/server.log)."

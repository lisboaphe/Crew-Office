#!/bin/sh
# Crew Office installer for macOS and Linux.
#
#   sh install.sh CrewOffice-<version>.zip
#
# Installs for the current user into ~/.local/share/crew-office (Linux) or
# ~/Applications/CrewOffice (macOS), adds a `crew-office` command in ~/.local/bin, and on
# Linux a menu entry. Your offices (~/.roving-office) and keys (~/.crew-worker) stay put.
#
# The app's own updater (lib/crew/update.cjs) also runs this, with:
#
#   --target <dir>       the copy to replace
#   --wait-pid <pid>     wait for the running app to stop first
#   --relaunch           start the app afterwards, whether or not this worked
#   --app-args "<args>"  what to start it with

set -eu

ZIP=""
TARGET=""
WAIT_PID=""
RELAUNCH=0
APP_ARGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --wait-pid) WAIT_PID="$2"; shift 2 ;;
    --relaunch) RELAUNCH=1; shift ;;
    --app-args) APP_ARGS="$2"; shift 2 ;;
    *) ZIP="$1"; shift ;;
  esac
done
[ -n "$ZIP" ] || ZIP="$(dirname "$0")/app.zip"
if [ -z "$TARGET" ]; then
  case "$(uname -s)" in
    Darwin) TARGET="$HOME/Applications/CrewOffice" ;;
    *) TARGET="${XDG_DATA_HOME:-$HOME/.local/share}/crew-office" ;;
  esac
fi
TARGET="${TARGET%/}"
[ -n "$TARGET" ] || { echo "Refusing to install over the root folder."; exit 1; }
STAGE="$TARGET.new"
OLD="$TARGET.old"

start_app() {
  [ "$RELAUNCH" = 1 ] && [ -f "$TARGET/bin/crew-app.cjs" ] && command -v node >/dev/null 2>&1 || return 0
  # Split on purpose: APP_ARGS is a list of plain flags.
  # shellcheck disable=SC2086
  (cd "$TARGET" && nohup node "$TARGET/bin/crew-app.cjs" $APP_ARGS >/dev/null 2>&1 &)
}

# Every way out comes through here, so a failed update still brings the app back.
finish() {
  status=$?
  trap - EXIT
  set +e
  rm -rf "$STAGE"
  [ "$status" = 0 ] || echo "Crew Office was not updated: the installed copy is unchanged."
  start_app
  exit "$status"
}
trap finish EXIT

if [ -n "$WAIT_PID" ]; then
  # Renaming a folder in use succeeds here, unlike on Windows, so a server still running has to
  # be caught now. It would otherwise carry on from files that have been deleted.
  tries=0
  while kill -0 "$WAIT_PID" 2>/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -le 30 ] || { echo "The running app did not stop within 30 seconds."; exit 1; }
    sleep 1
  done
fi

command -v node >/dev/null 2>&1 || { echo "Crew Office needs Node.js 22.5 or newer: https://nodejs.org/en/download"; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' \
  || { echo "Node.js $(node --version) is too old; Crew Office needs 22.5 or newer."; exit 1; }
[ -f "$ZIP" ] || { echo "Cannot find the app package: $ZIP"; exit 1; }
if command -v unzip >/dev/null 2>&1; then UNZIP=unzip
elif command -v bsdtar >/dev/null 2>&1; then UNZIP=bsdtar
else echo "Crew Office needs unzip to install. Install it with your package manager and try again."; exit 1
fi

echo "Installing Crew Office to $TARGET"
# The new copy is built beside the old one and swapped in at the end, so a failure at any
# point leaves the installed app whole. Of the old copy only its .env settings are kept.
rm -rf "$STAGE" "$OLD"
mkdir -p "$STAGE"
if [ "$UNZIP" = unzip ]; then unzip -q "$ZIP" -d "$STAGE"; else bsdtar -xf "$ZIP" -C "$STAGE"; fi
[ -f "$STAGE/bin/crew-app.cjs" ] || { echo "The app package is not a Crew Office build: $ZIP"; exit 1; }
[ ! -f "$TARGET/.env" ] || cp "$TARGET/.env" "$STAGE/.env"
(cd "$STAGE" && npm install --omit=dev --no-audit --no-fund --loglevel=error) || echo "Skipped the Anthropic SDK; run npm install in $TARGET later if you use an Anthropic API key."

if [ -e "$TARGET" ]; then mv "$TARGET" "$OLD"; fi
if ! mv "$STAGE" "$TARGET"; then
  [ ! -e "$OLD" ] || mv "$OLD" "$TARGET"
  exit 1
fi
rm -rf "$OLD"

mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/crew-office" <<EOF
#!/bin/sh
exec node "$TARGET/bin/crew-app.cjs" "\$@"
EOF
cat > "$HOME/.local/bin/crew-office-worker" <<EOF
#!/bin/sh
exec node "$TARGET/bin/crew-worker.cjs" "\$@"
EOF
chmod +x "$HOME/.local/bin/crew-office" "$HOME/.local/bin/crew-office-worker"

if [ "$(uname -s)" != "Darwin" ]; then
  mkdir -p "$HOME/.local/share/applications"
  cat > "$HOME/.local/share/applications/crew-office.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Crew Office
Comment=Host or join a multiplayer AI office
Exec=$HOME/.local/bin/crew-office %u
Icon=$TARGET/assets/icon-192.png
Terminal=true
Categories=Office;Development;
MimeType=x-scheme-handler/crewoffice;
EOF
  command -v xdg-mime >/dev/null 2>&1 && xdg-mime default crew-office.desktop x-scheme-handler/crewoffice || true
fi

echo "Installed. Run: crew-office   (and crew-office-worker for your agents)"
echo "Uninstall: rm -rf \"$TARGET\" ~/.local/bin/crew-office ~/.local/bin/crew-office-worker ~/.local/share/applications/crew-office.desktop"

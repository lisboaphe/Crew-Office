#!/bin/sh
# Crew Office installer for macOS and Linux.
#
#   sh install.sh CrewOffice-<version>.zip
#
# Installs for the current user into ~/.local/share/crew-office (Linux) or
# ~/Applications/CrewOffice (macOS), adds a `crew-office` command in ~/.local/bin, and on
# Linux a menu entry. Your offices (~/.roving-office) and keys (~/.crew-worker) stay put.

set -eu
ZIP="${1:-$(dirname "$0")/app.zip}"
case "$(uname -s)" in
  Darwin) TARGET="$HOME/Applications/CrewOffice" ;;
  *) TARGET="${XDG_DATA_HOME:-$HOME/.local/share}/crew-office" ;;
esac

command -v node >/dev/null 2>&1 || { echo "Crew Office needs Node.js 22.5 or newer: https://nodejs.org/en/download"; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' \
  || { echo "Node.js $(node --version) is too old; Crew Office needs 22.5 or newer."; exit 1; }
[ -f "$ZIP" ] || { echo "Cannot find the app package: $ZIP"; exit 1; }

echo "Installing Crew Office to $TARGET"
KEEP=""
[ -f "$TARGET/.env" ] && KEEP="$(cat "$TARGET/.env")"
rm -rf "$TARGET" && mkdir -p "$TARGET"
unzip -q "$ZIP" -d "$TARGET"
[ -n "$KEEP" ] && printf '%s' "$KEEP" > "$TARGET/.env"
(cd "$TARGET" && npm install --omit=dev --no-audit --no-fund --loglevel=error) || echo "Skipped the Anthropic SDK; run npm install in $TARGET later if you use an Anthropic API key."

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
Exec=$HOME/.local/bin/crew-office
Icon=$TARGET/assets/icon-192.png
Terminal=true
Categories=Office;Development;
EOF
fi

echo "Installed. Run: crew-office   (and crew-office-worker for your agents)"
echo "Uninstall: rm -rf \"$TARGET\" ~/.local/bin/crew-office ~/.local/bin/crew-office-worker ~/.local/share/applications/crew-office.desktop"

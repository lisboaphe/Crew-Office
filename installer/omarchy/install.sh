#!/bin/bash
# Crew Office installer for Omarchy (and any other Arch Linux), run from a checkout.
#
#   bash installer/omarchy/install.sh              install, or update to this checkout
#   bash installer/omarchy/install.sh --uninstall  remove the app, keep your offices and keys
#
# Builds the app package and hands it to the generic Unix installer, then does what that one
# cannot assume: installs anything missing with pacman or mise, finds a mise-managed Node
# whatever PATH the app menu starts with, and opens the app without a terminal window.
# Installs for the current user only; sudo is asked for only if a package is missing.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
TARGET="$DATA/crew-office"
BIN="$HOME/.local/bin"
APPS="$HOME/.local/share/applications"
UNINSTALL="$BIN/crew-office-uninstall"

say() { printf '==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

node_is_new_enough() {
  command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)'
}

if [ "${1:-}" = "--uninstall" ]; then
  [ -x "$UNINSTALL" ] || die "Crew Office is not installed (no $UNINSTALL)."
  exec "$UNINSTALL"
fi
[ -z "${1:-}" ] || die "unknown option: $1 (the only option is --uninstall)"

[ "$(id -u)" -ne 0 ] || die "run this as your own user, not root; it installs into your home folder."
command -v pacman >/dev/null 2>&1 || die "this installer is for Arch Linux. Elsewhere use installer/unix/install.sh."
[ -f "$ROOT/installer/build.cjs" ] || die "run this from a Crew Office checkout."

# ---------- What the app needs ----------
missing=()
command -v git >/dev/null 2>&1 || missing+=(git)
command -v unzip >/dev/null 2>&1 || missing+=(unzip)
command -v bsdtar >/dev/null 2>&1 || missing+=(libarchive)
[ -x /usr/bin/chromium ] || [ -x /usr/bin/google-chrome ] || [ -x /usr/bin/microsoft-edge ] || missing+=(chromium)
if ! node_is_new_enough; then
  if command -v mise >/dev/null 2>&1; then
    say "Installing Node.js LTS with mise"
    mise use --global node@lts
    export PATH="$DATA/mise/shims:$PATH"
    hash -r
  else
    missing+=(nodejs npm)
  fi
fi
if [ "${#missing[@]}" -gt 0 ]; then
  say "Installing with pacman: ${missing[*]}"
  sudo pacman -S --needed --noconfirm "${missing[@]}"
  hash -r
fi
node_is_new_enough || die "Crew Office needs Node.js 22.5 or newer, and could not get it."

# ---------- The app ----------
# Stop any installed copy first, so it is not left serving files this is about to replace.
pkill -f "$TARGET/bin/crew-" 2>/dev/null || true

say "Building the app package"
(cd "$ROOT" && node installer/build.cjs)
VERSION="$(node -p "require('$ROOT/package.json').version")"
# Its own uninstall hint would miss crew-office-uninstall, so leave that line out.
sh "$ROOT/installer/unix/install.sh" "$ROOT/dist/CrewOffice-$VERSION.zip" | grep -v '^Uninstall:'

# ---------- Omarchy's side of it ----------
# A launcher started from the app menu can have a shorter PATH than a terminal, and on Omarchy
# Node normally comes from mise, so look in mise's shims as well.
write_launcher() {
  cat > "$BIN/$1" <<EOF
#!/bin/sh
command -v node >/dev/null 2>&1 || PATH="$DATA/mise/shims:\$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Crew Office cannot find Node.js 22.5 or newer." >&2
  command -v notify-send >/dev/null 2>&1 && notify-send "Crew Office" "Cannot find Node.js 22.5 or newer."
  exit 1
fi
exec node "$TARGET/bin/$2" "\$@"
EOF
  chmod +x "$BIN/$1"
}
write_launcher crew-office crew-app.cjs
write_launcher crew-office-worker crew-worker.cjs

# The app opens its own window and, if it fails to start, shows its log, so no terminal.
cat > "$APPS/crew-office.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Crew Office
Comment=Host or join a multiplayer AI office
Exec=$BIN/crew-office %u
Icon=$TARGET/assets/icon-192.png
Terminal=false
Categories=Office;Development;
MimeType=x-scheme-handler/crewoffice;
EOF
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" || true

cat > "$UNINSTALL" <<EOF
#!/bin/sh
# Removes Crew Office. Your offices (~/.roving-office) and keys (~/.crew-worker) stay put.
pkill -f "$TARGET/bin/crew-" 2>/dev/null
rm -rf "$TARGET"
rm -f "$BIN/crew-office" "$BIN/crew-office-worker" "$APPS/crew-office.desktop"
MIMEAPPS="\${XDG_CONFIG_HOME:-\$HOME/.config}/mimeapps.list"
[ -f "\$MIMEAPPS" ] && sed -i '/^x-scheme-handler\/crewoffice=/d' "\$MIMEAPPS"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS"
echo "Crew Office removed. Your offices and keys were kept: ~/.roving-office and ~/.crew-worker"
rm -f "$UNINSTALL"
EOF
chmod +x "$UNINSTALL"

say "Crew Office $VERSION is installed"
echo "  Start it:   Crew Office in the app menu, or: crew-office"
echo "  Only you:   crew-office --private   (the default also serves your network)"
echo "  Remove it:  crew-office-uninstall"
if systemctl is-enabled ufw >/dev/null 2>&1; then
  echo "  Friends:    the firewall (ufw) blocks them until you run: sudo ufw allow 8080/tcp"
fi

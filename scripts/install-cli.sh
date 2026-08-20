#!/usr/bin/env bash
# scripts/install-cli.sh — install just the `draft` CLI, no desktop app or repo clone.
#
#   curl -fsSL https://raw.githubusercontent.com/idodekerobo/draft/main/scripts/install-cli.sh | bash
#
# Installs to ~/.draft/bin/draft, same layout as the desktop app's installer
# (desktop/src/main/installer.ts), so `draft update` works either way.

set -euo pipefail

REPO="idodekerobo/draft"
DRAFT_BIN_DIR="$HOME/.draft/bin"
DRAFT_BIN_PATH="$DRAFT_BIN_DIR/draft"
SYSTEM_LINK="/usr/local/bin/draft"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[Draft]${NC} $1"; }
warn() { echo -e "${YELLOW}[Draft]${NC} $1"; }
err()  { echo -e "${RED}[Draft]${NC} $1" >&2; }

# ── 1. Resolve platform asset name ──────────────────────────────────────────
# Must match platformAssetName() in cli/src/commands/update.ts exactly.

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *) err "Unsupported OS: $OS. See https://github.com/$REPO/releases/latest for manual install."; exit 1 ;;
esac

case "$ARCH" in
  arm64|aarch64) PLATFORM_ARCH="arm64" ;;
  x86_64)        PLATFORM_ARCH="x64" ;;
  *) err "Unsupported architecture: $ARCH. See https://github.com/$REPO/releases/latest for manual install."; exit 1 ;;
esac

ASSET_NAME="stable-${PLATFORM}-${PLATFORM_ARCH}-draft-cli"
DOWNLOAD_URL="https://github.com/$REPO/releases/latest/download/$ASSET_NAME"

# ── 2. Download ──────────────────────────────────────────────────────────────

log "Downloading $ASSET_NAME..."
mkdir -p "$DRAFT_BIN_DIR"
TMP_FILE=$(mktemp "$DRAFT_BIN_DIR/.draft-install-XXXXXX")
trap 'rm -f "$TMP_FILE"' EXIT

if ! curl -fsSL "$DOWNLOAD_URL" -o "$TMP_FILE"; then
  err "Failed to download $DOWNLOAD_URL"
  err "Check https://github.com/$REPO/releases/latest for available assets."
  exit 1
fi
chmod +x "$TMP_FILE"
mv "$TMP_FILE" "$DRAFT_BIN_PATH"
trap - EXIT
log "  Installed: $DRAFT_BIN_PATH"

# ── 3. Put draft on PATH ──────────────────────────────────────────────────────

if mkdir -p /usr/local/bin 2>/dev/null && ln -sfn "$DRAFT_BIN_PATH" "$SYSTEM_LINK" 2>/dev/null; then
  log "  Linked: $SYSTEM_LINK -> $DRAFT_BIN_PATH"
else
  # No permission for /usr/local/bin — fall back to a shell profile PATH export.
  SHELL_NAME="$(basename "${SHELL:-/bin/zsh}")"
  if [ "$SHELL_NAME" = "zsh" ]; then PROFILE="$HOME/.zprofile"
  elif [ "$SHELL_NAME" = "bash" ]; then PROFILE="$HOME/.bash_profile"
  else PROFILE="$HOME/.profile"
  fi
  if ! grep -q ".draft/bin" "$PROFILE" 2>/dev/null; then
    echo "" >> "$PROFILE"
    echo 'export PATH="$HOME/.draft/bin:$PATH"  # added by Draft' >> "$PROFILE"
  fi
  warn "  Could not write $SYSTEM_LINK — added ~/.draft/bin to PATH via $PROFILE instead."
  warn "  Open a new terminal (or: source $PROFILE) before running draft."
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
log "Install complete."
echo ""
echo "  draft auth login     — sign in via device pairing"
echo "  draft --help          — see all commands"
echo "  draft update          — update to the latest release later"
echo ""

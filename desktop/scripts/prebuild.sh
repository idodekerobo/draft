#!/usr/bin/env bash
# desktop/scripts/prebuild.sh — prepare bundled assets before electrobun build
#
# What this does:
#   1. Copies background/ daemon scripts → desktop/assets/background/
#   2. Copies cli-agent-plugin/ → desktop/assets/plugin/
#   3. Compiles the draft CLI as a standalone binary → desktop/assets/bin/draft
#
# Run before every build. Idempotent — wipes and recreates assets/ each time.
# assets/ is gitignored (build artifact, not committed).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_DIR/.." && pwd)"
ASSETS_DIR="$DESKTOP_DIR/assets"

GREEN='\033[0;32m'
NC='\033[0m'
log() { echo -e "${GREEN}[prebuild]${NC} $1"; }

# ── Clean ──────────────────────────────────────────────────────────────────────

rm -rf "$ASSETS_DIR"
mkdir -p "$ASSETS_DIR/background" "$ASSETS_DIR/plugin" "$ASSETS_DIR/bin"

# ── 1. Copy daemon scripts ─────────────────────────────────────────────────────

log "Copying background/..."
cp -r "$REPO_ROOT/background/." "$ASSETS_DIR/background/"
log "  Done"

# ── 2. Copy plugin assets ──────────────────────────────────────────────────────

log "Copying cli-agent-plugin/..."
cp -r "$REPO_ROOT/cli-agent-plugin/." "$ASSETS_DIR/plugin/"
log "  Done"

# ── 3. Stage tmux static binary ───────────────────────────────────────────────
# Download a precompiled static macOS tmux binary and stage it for bundling.
# Pin a specific release + SHA256 checksum for reproducibility.
# For CI: set TMUX_DOWNLOAD_URL and TMUX_SHA256 in the environment.

TMUX_DEST="$ASSETS_DIR/bin/tmux"

# TODO(ci): Replace the dev fallback below with a self-hosted static build for production CI.
#   Build from source on a Mac (links only against system libs — no Homebrew dylib deps):
#     cd /tmp && curl -fsSL https://github.com/tmux/tmux/releases/download/3.5a/tmux-3.5a.tar.gz | tar xz
#     cd tmux-3.5a
#     ./configure --prefix=/tmp/tmux-out --enable-static \
#       CFLAGS="-I$(brew --prefix libevent)/include -I$(brew --prefix ncurses)/include" \
#       LDFLAGS="-L$(brew --prefix libevent)/lib -L$(brew --prefix ncurses)/lib"
#     make -j4 && make install
#     otool -L /tmp/tmux-out/bin/tmux  # verify: only /usr/lib/* and /System/* entries
#     shasum -a 256 /tmp/tmux-out/bin/tmux
#   Upload the binary to a GitHub Release on this repo (e.g. tag: build-deps-v1).
#   Then set TMUX_DOWNLOAD_URL + TMUX_SHA256 as CI secrets and hardcode defaults here.
if [ -n "${TMUX_DOWNLOAD_URL:-}" ]; then
  log "Downloading tmux from $TMUX_DOWNLOAD_URL"
  curl -fsSL "$TMUX_DOWNLOAD_URL" -o "$TMUX_DEST"
  if [ -n "${TMUX_SHA256:-}" ]; then
    echo "$TMUX_SHA256  $TMUX_DEST" | shasum -a 256 -c - || {
      echo "[prebuild] ERROR: tmux checksum mismatch" >&2; exit 1
    }
  fi
  chmod +x "$TMUX_DEST"
  log "  tmux downloaded: $TMUX_DEST"
else
  # Dev fallback: copy from build machine (requires tmux installed — e.g. brew install tmux)
  TMUX_BIN=$(command -v tmux 2>/dev/null || true)
  if [ -n "$TMUX_BIN" ]; then
    log "  Copying tmux from $TMUX_BIN (build-machine fallback)"
    cp "$TMUX_BIN" "$TMUX_DEST"
    chmod +x "$TMUX_DEST"
    log "  tmux staged: $TMUX_DEST"
  else
    log "  WARN: tmux not found on PATH — session monitoring will be unavailable in this build"
  fi
fi

# ── 4. Compile draft CLI binary ────────────────────────────────────────────────

log "Compiling draft CLI binary..."

# Detect host arch for the compile target
ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then
  BUN_TARGET="bun-darwin-arm64"
else
  BUN_TARGET="bun-darwin-x64"
fi

log "  Target: $BUN_TARGET"

bun build \
  --compile \
  --target="$BUN_TARGET" \
  --bytecode \
  --outfile "$ASSETS_DIR/bin/draft" \
  "$REPO_ROOT/cli/src/index.ts"

chmod +x "$ASSETS_DIR/bin/draft"
log "  Binary: assets/bin/draft"

# ── 5. Compile daemon binary ───────────────────────────────────────────────────

log "Compiling daemon binary..."

# Read PostHog key + host from build-config.json (absent for OSS builds → empty → no-op in daemon).
DRAFT_PH_KEY=$(python3 -c "import json; d=json.load(open('$DESKTOP_DIR/src/build-config.json')); print(d.get('posthog_key',''))" 2>/dev/null || echo "")
DRAFT_PH_HOST=$(python3 -c "import json; d=json.load(open('$DESKTOP_DIR/src/build-config.json')); print(d.get('api_host','https://us.i.posthog.com'))" 2>/dev/null || echo "https://us.i.posthog.com")

bun build \
  --compile \
  --target="$BUN_TARGET" \
  --bytecode \
  --define "process.env.DRAFT_PH_KEY=\"${DRAFT_PH_KEY}\"" \
  --define "process.env.DRAFT_PH_HOST=\"${DRAFT_PH_HOST}\"" \
  --outfile "$ASSETS_DIR/background/draft-background-bin" \
  "$REPO_ROOT/background/draft-background.ts"
chmod +x "$ASSETS_DIR/background/draft-background-bin"
log "  Binary: assets/background/draft-background-bin"

# ── 6. Generate app icon set ───────────────────────────────────────────────────

log "Generating icon.iconset..."
mkdir -p "$ASSETS_DIR/icon.iconset"

ICON_SRC="$REPO_ROOT/assets/icon.png"
ICONSET="$ASSETS_DIR/icon.iconset"

sips -z 16 16     "$ICON_SRC" --out "$ICONSET/icon_16x16.png"      > /dev/null
sips -z 32 32     "$ICON_SRC" --out "$ICONSET/icon_16x16@2x.png"   > /dev/null
sips -z 32 32     "$ICON_SRC" --out "$ICONSET/icon_32x32.png"      > /dev/null
sips -z 64 64     "$ICON_SRC" --out "$ICONSET/icon_32x32@2x.png"   > /dev/null
sips -z 128 128   "$ICON_SRC" --out "$ICONSET/icon_128x128.png"    > /dev/null
sips -z 256 256   "$ICON_SRC" --out "$ICONSET/icon_128x128@2x.png" > /dev/null
sips -z 256 256   "$ICON_SRC" --out "$ICONSET/icon_256x256.png"    > /dev/null
sips -z 512 512   "$ICON_SRC" --out "$ICONSET/icon_256x256@2x.png" > /dev/null
sips -z 512 512   "$ICON_SRC" --out "$ICONSET/icon_512x512.png"    > /dev/null

log "  Done ($(find "$ICONSET" -type f | wc -l | tr -d ' ') files)"

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
log "Assets ready in desktop/assets/"
echo "  background/  $(find "$ASSETS_DIR/background" -type f | wc -l | tr -d ' ') files"
echo "  plugin/      $(find "$ASSETS_DIR/plugin" -type f | wc -l | tr -d ' ') files"
echo "  bin/draft    $(du -sh "$ASSETS_DIR/bin/draft" | cut -f1)"
echo ""

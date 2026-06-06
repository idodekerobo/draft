#!/usr/bin/env bash
# install.sh — Draft CLI install script
#
# Usage (from repo root after cloning):
#   bash install.sh
#
# What this does:
#   1. Checks that bun is installed
#   2. Installs TypeScript dependencies for the CLI
#   3. Copies the `draft` wrapper script to ~/bin/ (or /usr/local/bin/)
#   4. Verifies `draft` is reachable in PATH
#   5. Installs shell tab completion (zsh or bash)
#   6. Runs `draft add claude-code` to install the plugin and daemon
#
# Safe to re-run — all steps are idempotent.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${GREEN}[Draft]${NC} $1"; }
warn() { echo -e "${YELLOW}[Draft]${NC} $1"; }
err()  { echo -e "${RED}[Draft]${NC} $1" >&2; }
bold() { echo -e "${BOLD}$1${NC}"; }

echo ""
bold "Draft — install"
echo "──────────────────────────────────────"
echo ""

# ── 1. Check bun ──────────────────────────────────────────────────────────────

if ! command -v bun &>/dev/null; then
    err "bun is required but not installed."
    echo "  Install it from: https://bun.sh"
    echo "  Then re-run: bash install.sh"
    exit 1
fi

log "bun $(bun --version) found"

# ── 2. Install CLI TypeScript dependencies ────────────────────────────────────

log "Installing CLI dependencies..."
bun install --cwd "$REPO_ROOT/cli" --silent
log "  Dependencies installed"

# ── 3. Copy draft wrapper to PATH ─────────────────────────────────────────────

INSTALL_DIR=""

# Find a writable directory already in PATH
for dir in "$HOME/bin" "$HOME/.local/bin" "/usr/local/bin"; do
    if [ -d "$dir" ]; then
        INSTALL_DIR="$dir"
        break
    fi
done

# ~/bin is the most common personal bin — create it if it doesn't exist
if [ -z "$INSTALL_DIR" ]; then
    INSTALL_DIR="$HOME/bin"
    mkdir -p "$INSTALL_DIR"
    warn "Created ~/bin — you may need to add it to your PATH:"
    warn "  echo 'export PATH=\"\$HOME/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
fi

cat > "$INSTALL_DIR/draft" << EOF
#!/usr/bin/env bash
exec bun run "$REPO_ROOT/cli/src/index.ts" "\$@"
EOF
chmod +x "$INSTALL_DIR/draft"
log "  draft wrapper installed to $INSTALL_DIR/draft"

# ── 4. Verify draft is reachable ──────────────────────────────────────────────

if ! command -v draft &>/dev/null; then
    warn "'draft' not found in PATH yet. You may need to:"
    warn "  export PATH=\"$INSTALL_DIR:\$PATH\""
    warn "  (Add that line to ~/.zshrc or ~/.bashrc to make it permanent)"
    echo ""
    warn "Then run: draft add claude-code"
    echo ""
    log "Install complete — PATH update required before first use."
    exit 0
fi

# ── 5. Install shell completions ──────────────────────────────────────────────
# Write completion script once to ~/.draft/completions/ and source from rc file.
# Fast shell startup (no bun on every new terminal). Idempotent on re-runs.

COMPLETIONS_DIR="$HOME/.draft/completions"
mkdir -p "$COMPLETIONS_DIR"

SHELL_NAME="$(basename "$SHELL")"

if [ "$SHELL_NAME" = "zsh" ]; then
    draft completion --zsh > "$COMPLETIONS_DIR/draft.zsh"
    RC_FILE="$HOME/.zshrc"
    SOURCE_LINE="source \"$COMPLETIONS_DIR/draft.zsh\""
elif [ "$SHELL_NAME" = "bash" ]; then
    draft completion > "$COMPLETIONS_DIR/draft.bash"
    RC_FILE="$HOME/.bashrc"
    SOURCE_LINE="source \"$COMPLETIONS_DIR/draft.bash\""
else
    RC_FILE=""
    SOURCE_LINE=""
fi

if [ -n "$RC_FILE" ] && [ -n "$SOURCE_LINE" ]; then
    if grep -q "draft/completions" "$RC_FILE" 2>/dev/null; then
        log "  Tab completion already configured in $RC_FILE"
    else
        echo "" >> "$RC_FILE"
        echo "# Draft tab completion (added by install.sh)" >> "$RC_FILE"
        echo "$SOURCE_LINE" >> "$RC_FILE"
        log "  Tab completion installed — open a new terminal or run: source $RC_FILE"
    fi
else
    warn "Unknown shell ($SHELL_NAME) — run 'draft completion --help' to set up tab completion manually"
fi

# ── 6. Install plugin + daemon ────────────────────────────────────────────────

echo ""
log "Running: draft add claude-code"
echo ""
draft add claude-code

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
bold "Install complete."
echo ""
echo "  draft status       — check daemon and integration health"
echo "  draft doctor       — diagnose any issues"
echo "  draft --help       — see all commands"
echo ""
echo "──────────────────────────────────────"
echo ""
echo "  Want the desktop app?"
echo "  Download Draft.app from GitHub Releases:"
echo "  https://github.com/idodekerobo/draft/releases/latest"
echo ""

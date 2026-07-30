#!/usr/bin/env bash
# desktop/scripts/prebuild.sh — prepare bundled assets before electrobun build
#
# What this does:
#   1. Copies background/ daemon scripts → desktop/assets/background/
#   2. Copies cli-agent-plugin/ → desktop/assets/plugin/
#   3. Builds tmux (and libevent) from source → desktop/assets/bin/tmux
#   4. Compiles the draft CLI as a standalone binary → desktop/assets/bin/draft
#   5. Compiles the daemon binary → desktop/assets/background/draft-background-bin
#   6. Stages the app icon set
#
# Run before every build. Idempotent — wipes and recreates assets/ each time.
# assets/ is gitignored (build artifact, not committed). The tmux build is cached
# under .build-cache/ (also gitignored) since it is the one slow step here.

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
# Runtime entrypoints are bundled below; never ship the monorepo dependency tree.
rm -rf "$ASSETS_DIR/background/node_modules"
log "  Done"

# Bundle entrypoints that run after installation, outside the monorepo. Raw
# TypeScript there cannot resolve workspace packages such as draft-core.
log "Bundling installed TypeScript runtime entrypoints..."
RUNTIME_MANIFEST="$ASSETS_DIR/background/.runtime-bundles"
: > "$RUNTIME_MANIFEST"

# Bundle every executable TS runtime currently present. This intentionally uses
# the source tree as the manifest so newly migrated pollers/synthesizers cannot
# be forgotten while type-only/helper modules remain ordinary bundle inputs.
{
  find "$REPO_ROOT/background/integrations" -type f \
    \( -name '*-poller.ts' -o -name '*-analyzer.ts' -o -name '*-scanner.ts' \
       -o -name 'slack-capture.ts' -o -name 'slack-rebuild.ts' -o -name 'slack-reconcile.ts' \)
  find "$REPO_ROOT/background/synthesizers" -maxdepth 1 -type f -name '*.ts' ! -name 'synthesis-runtime.ts'
  find "$REPO_ROOT/background/intelligence" -maxdepth 1 -type f -name '*.ts'
} | sort | while IFS= read -r runtime_source; do
    relative_path="${runtime_source#"$REPO_ROOT/background/"}"
    relative_output="${relative_path%.ts}.js"
    runtime_output="$ASSETS_DIR/background/$relative_output"
    mkdir -p "$(dirname "$runtime_output")"
    bun build --target=bun --outfile "$runtime_output" "$runtime_source"
    printf '%s\n' "$relative_output" >> "$RUNTIME_MANIFEST"
  done

# Do not ship tests or duplicate raw sources for manifest-listed entrypoints.
rm -rf "$ASSETS_DIR/background/__tests__"
while IFS= read -r relative_output; do
  [ -n "$relative_output" ] || continue
  rm -f "$ASSETS_DIR/background/${relative_output%.js}.ts"
done < "$RUNTIME_MANIFEST"

# Smoke-test the staged bundles from a HOME with no monorepo node_modules.
SMOKE_ROOT=$(mktemp -d)
SMOKE_HOME="$SMOKE_ROOT/home"
SMOKE_INSTALL="$SMOKE_ROOT/install/background"
mkdir -p "$SMOKE_HOME" "$SMOKE_INSTALL"
cp -R "$ASSETS_DIR/background/." "$SMOKE_INSTALL/"
trap 'rm -rf "$SMOKE_ROOT"' EXIT

# Bounded per-entrypoint window, no `timeout`/`gtimeout` dependency (poll + kill —
# portable across a clean macOS with no coreutils installed). Needed because some
# entrypoints (e.g. slack-capture.ts) are long-running daemons that reconnect
# forever and never exit on their own; only a startup-time module-resolution
# failure would surface this fast, so we only need to watch briefly, not wait
# for the process to finish.
SMOKE_TIMEOUT_S=8

while IFS= read -r relative_output; do
  [ -n "$relative_output" ] || continue
  runtime_entry="$SMOKE_INSTALL/$relative_output"
  smoke_log="$SMOKE_ROOT/smoke-output.log"
  : > "$smoke_log"
  HOME="$SMOKE_HOME" bun run "$runtime_entry" > "$smoke_log" 2>&1 &
  smoke_pid=$!
  elapsed_ticks=0
  max_ticks=$((SMOKE_TIMEOUT_S * 2))
  while kill -0 "$smoke_pid" 2>/dev/null && [ "$elapsed_ticks" -lt "$max_ticks" ]; do
    sleep 0.5
    elapsed_ticks=$((elapsed_ticks + 1))
  done
  if kill -0 "$smoke_pid" 2>/dev/null; then
    kill -9 "$smoke_pid" 2>/dev/null || true
  fi
  wait "$smoke_pid" 2>/dev/null || true
  smoke_output=$(cat "$smoke_log")
  if [[ "$smoke_output" == *"Cannot find module"* ]] \
     || [[ "$smoke_output" == *"Cannot find package"* ]] \
     || [[ "$smoke_output" == *"ModuleNotFound"* ]]; then
    echo "[prebuild] ERROR: runtime smoke test failed for $runtime_entry" >&2
    echo "$smoke_output" >&2
    exit 1
  fi
done < "$RUNTIME_MANIFEST"
rm -rf "$SMOKE_ROOT"
trap - EXIT
log "  Done"

# ── 2. Copy plugin assets ──────────────────────────────────────────────────────

log "Copying cli-agent-plugin/..."
cp -r "$REPO_ROOT/cli-agent-plugin/." "$ASSETS_DIR/plugin/"
log "  Done"

# ── 3. Build tmux from source ─────────────────────────────────────────────────
#
# This used to `cp $(which tmux)` from the build machine, which shipped a
# Homebrew binary to every user: it dynamically linked
# /opt/homebrew/opt/{libevent,ncurses,utf8proc}/lib/*.dylib — paths that exist
# only on the release builder's Mac — and carried a minos of 15.0. Since
# installer.ts copies the bundled tmux to ~/.draft/bin/tmux and the daemon puts
# ~/.draft/bin first on PATH, that binary also *shadowed* a user's own working
# `brew install tmux`. It could not load for virtually anyone.
#
# So we build tmux ourselves, against a from-source libevent and macOS's own
# system ncurses, at a fixed 14.0 deployment target. Notes on why it's shaped
# this way (each of these was tried and rejected):
#   - tmux's configure.ac hard-errors on `--enable-static` on macOS, so a fully
#     static binary is not achievable; linking only /usr/lib is the real goal.
#   - Homebrew's own .a archives are compiled at minos 15.0, and its static
#     ncurses has a hardcoded /opt/homebrew/Cellar terminfo path baked in —
#     invisible to otool -L, but broken at runtime on any other Mac.
#   - macOS has no system libevent, so that one genuinely must be built here.
#     macOS *does* ship ncurses in /usr/lib with terminfo in /usr/share/terminfo,
#     so we deliberately starve pkg-config (PKG_CONFIG_LIBDIR → an empty dir;
#     clearing PKG_CONFIG_PATH alone is not enough, pkg-config falls back to
#     compiled-in defaults that include /opt/homebrew) and let tmux's
#     AC_SEARCH_LIBS(setupterm) fallback find -lncurses on its own.
#   - --disable-utf8proc must be passed explicitly (configure errors if neither
#     --enable-utf8proc nor --disable-utf8proc is given on macOS). We accept
#     tmux's builtin width tables: the session adapter only greps for a marker
#     and stats the output file, so nothing in the parse is column-sensitive.
#
# The build is cached under .build-cache/ keyed on the full recipe, but a cache
# hit is still re-verified below before staging — the verification is the point.

TMUX_DEST="$ASSETS_DIR/bin/tmux"

TMUX_VERSION="3.5a"
TMUX_SHA256="16216bd0877170dfcc64157085ba9013610b12b082548c7c9542cc0103198951"
LIBEVENT_VERSION="2.1.12-stable"
LIBEVENT_SHA256="92e6de1be9ec176428fd2367677e61ceffc2ee1cb119035037a27d346b0403bb"
# Must stay >= the floor patched into the other bundled binaries by
# scripts/lib/patch-minos.ts, and <= libNativeWrapper.dylib's genuine 14.0.
MACOS_MIN="14.0"

TMUX_CACHE_DIR="$DESKTOP_DIR/.build-cache/tmux-${TMUX_VERSION}-libevent${LIBEVENT_VERSION}-min${MACOS_MIN}"
TMUX_CACHED="$TMUX_CACHE_DIR/tmux"

fatal() { echo "[prebuild] ERROR: $1" >&2; exit 1; }

# Every check that can fail on *this* machine for the same reason it would fail
# on a user's machine. Applied to freshly built and cached binaries alike.
verify_tmux() {
  local bin="$1"

  # 1. Linkage: only system libraries. This is what the old build got wrong.
  local bad_links
  bad_links=$(otool -L "$bin" | tail -n +2 | awk '{print $1}' \
    | grep -vE '^(/usr/lib/|/System/Library/)' || true)
  if [ -n "$bad_links" ]; then
    fatal "tmux links non-system libraries:"$'\n'"$bad_links"
  fi

  # 2. Deployment floor.
  local minos
  minos=$(otool -l "$bin" | awk '/LC_BUILD_VERSION/{f=1} f&&/^ *minos/{print $2; exit}')
  [ -n "$minos" ] || fatal "tmux has no LC_BUILD_VERSION minos"
  if [ "$(printf '%s\n%s\n' "$minos" "$MACOS_MIN" | sort -V | tail -1)" != "$MACOS_MIN" ]; then
    fatal "tmux minos $minos exceeds the $MACOS_MIN floor"
  fi

  # 3. Compiled-in Homebrew paths. otool -L cannot see these — this is the check
  #    that catches the hardcoded-terminfo-path class of bug.
  local brew_paths
  brew_paths=$(strings -a "$bin" | grep -E '/opt/homebrew|/Cellar/' || true)
  if [ -n "$brew_paths" ]; then
    fatal "tmux contains compiled-in Homebrew paths:"$'\n'"$brew_paths"
  fi

  # 4. It is the version we think it is.
  local reported
  reported=$("$bin" -V 2>&1 || true)
  [ "$reported" = "tmux $TMUX_VERSION" ] || fatal "tmux reports '$reported', expected 'tmux $TMUX_VERSION'"

  # 5. Functional smoke test in a scrubbed environment. `env -i` drops
  #    DYLD_LIBRARY_PATH and DYLD_FALLBACK_LIBRARY_PATH along with everything
  #    else — a clean PATH alone would not stop dyld from resolving Homebrew
  #    dylibs via the fallback path, letting a bad binary pass. TERM=screen is
  #    set explicitly so this exercises system terminfo only.
  local smoke_home smoke_out
  smoke_home=$(mktemp -d)
  smoke_out=$(env -i PATH=/usr/bin:/bin HOME="$smoke_home" TMUX_TMPDIR="$smoke_home" TERM=screen \
    "$bin" -L draft-prebuild-smoke new-session -d -s smoke 'echo tmux-smoke-ok; sleep 5' 2>&1) || {
      rm -rf "$smoke_home"; fatal "tmux smoke test: could not create a session:"$'\n'"$smoke_out"
    }
  sleep 1
  smoke_out=$(env -i PATH=/usr/bin:/bin HOME="$smoke_home" TMUX_TMPDIR="$smoke_home" TERM=screen \
    "$bin" -L draft-prebuild-smoke capture-pane -p -t smoke 2>&1) || true
  env -i PATH=/usr/bin:/bin HOME="$smoke_home" TMUX_TMPDIR="$smoke_home" TERM=screen \
    "$bin" -L draft-prebuild-smoke kill-server >/dev/null 2>&1 || true
  rm -rf "$smoke_home"
  case "$smoke_out" in
    *tmux-smoke-ok*) ;;
    *) fatal "tmux smoke test: capture-pane did not return the expected output:"$'\n'"$smoke_out" ;;
  esac
}

if [ -x "$TMUX_CACHED" ]; then
  log "Using cached tmux build ($TMUX_VERSION)"
else
  log "Building tmux $TMUX_VERSION from source (libevent $LIBEVENT_VERSION, macOS $MACOS_MIN floor)..."

  TMUX_WORK=$(mktemp -d)
  trap 'rm -rf "$TMUX_WORK"' EXIT

  export MACOSX_DEPLOYMENT_TARGET="$MACOS_MIN"
  TMUX_CC="clang -mmacosx-version-min=$MACOS_MIN"

  # ── libevent (static, ours) ──────────────────────────────────────────────────
  log "  Downloading libevent $LIBEVENT_VERSION..."
  curl -fsSL -o "$TMUX_WORK/libevent.tar.gz" \
    "https://github.com/libevent/libevent/releases/download/release-${LIBEVENT_VERSION}/libevent-${LIBEVENT_VERSION}.tar.gz"
  echo "$LIBEVENT_SHA256  $TMUX_WORK/libevent.tar.gz" | shasum -a 256 -c - >/dev/null \
    || fatal "libevent checksum mismatch"
  tar xzf "$TMUX_WORK/libevent.tar.gz" -C "$TMUX_WORK"

  log "  Building libevent..."
  (
    cd "$TMUX_WORK/libevent-${LIBEVENT_VERSION}"
    ./configure --prefix="$TMUX_WORK/libevent-out" \
      --disable-shared --enable-static --disable-openssl \
      --disable-libevent-regress --disable-samples --disable-debug-mode \
      CC="$TMUX_CC"
    make -j"$(sysctl -n hw.ncpu)"
    make install
  ) > "$TMUX_WORK/libevent-build.log" 2>&1 || {
    tail -40 "$TMUX_WORK/libevent-build.log" >&2
    fatal "libevent build failed (full log: $TMUX_WORK/libevent-build.log)"
  }

  # ── tmux ─────────────────────────────────────────────────────────────────────
  log "  Downloading tmux $TMUX_VERSION..."
  curl -fsSL -o "$TMUX_WORK/tmux.tar.gz" \
    "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz"
  echo "$TMUX_SHA256  $TMUX_WORK/tmux.tar.gz" | shasum -a 256 -c - >/dev/null \
    || fatal "tmux checksum mismatch"
  tar xzf "$TMUX_WORK/tmux.tar.gz" -C "$TMUX_WORK"

  log "  Building tmux..."
  mkdir -p "$TMUX_WORK/pkgconfig-empty"
  (
    cd "$TMUX_WORK/tmux-${TMUX_VERSION}"
    # Isolate pkg-config so Homebrew cannot leak back in, and hand configure the
    # libevent archive by absolute path so it never resolves -levent_core to a
    # Homebrew dylib. Setting both *_CFLAGS and *_LIBS makes PKG_CHECK_MODULES
    # skip its pkg-config probe entirely.
    export PKG_CONFIG_LIBDIR="$TMUX_WORK/pkgconfig-empty"
    export PKG_CONFIG_PATH=""
    export LIBEVENT_CORE_CFLAGS="-I$TMUX_WORK/libevent-out/include"
    export LIBEVENT_CORE_LIBS="$TMUX_WORK/libevent-out/lib/libevent_core.a"
    ./configure --prefix="$TMUX_WORK/tmux-out" --disable-utf8proc CC="$TMUX_CC"
    make -j"$(sysctl -n hw.ncpu)"
  ) > "$TMUX_WORK/tmux-build.log" 2>&1 || {
    tail -40 "$TMUX_WORK/tmux-build.log" >&2
    fatal "tmux build failed (full log: $TMUX_WORK/tmux-build.log)"
  }

  log "  Verifying built tmux..."
  verify_tmux "$TMUX_WORK/tmux-${TMUX_VERSION}/tmux"

  mkdir -p "$TMUX_CACHE_DIR"
  cp "$TMUX_WORK/tmux-${TMUX_VERSION}/tmux" "$TMUX_CACHED"
  chmod +x "$TMUX_CACHED"

  rm -rf "$TMUX_WORK"
  trap - EXIT
fi

# Re-verify even on a cache hit — a stale or tampered cache entry must never
# silently reintroduce the Homebrew-linked binary this whole section exists to
# prevent. If any check fails, the build fails.
log "  Verifying tmux before staging..."
verify_tmux "$TMUX_CACHED"

cp "$TMUX_CACHED" "$TMUX_DEST"
chmod +x "$TMUX_DEST"
log "  tmux staged: $TMUX_DEST"

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

# ── 6. Stage app icon set ──────────────────────────────────────────────────────

log "Staging icon.iconset from assets/AppIcon.iconset..."
cp -r "$REPO_ROOT/assets/AppIcon.iconset/." "$ASSETS_DIR/icon.iconset/"
log "  Done ($(find "$ASSETS_DIR/icon.iconset" -type f | wc -l | tr -d ' ') files)"

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
log "Assets ready in desktop/assets/"
echo "  background/  $(find "$ASSETS_DIR/background" -type f | wc -l | tr -d ' ') files"
echo "  plugin/      $(find "$ASSETS_DIR/plugin" -type f | wc -l | tr -d ' ') files"
echo "  bin/draft    $(du -sh "$ASSETS_DIR/bin/draft" | cut -f1)"
echo ""

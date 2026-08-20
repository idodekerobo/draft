.PHONY: run-local run-landing stop

# Starts web (3000), landing (3001), API (8787), and desktop in one foreground
# supervisor. Copy .env.example to the root .env.local before starting. Core/
# background are intentionally excluded. Stop all children with Ctrl-C.
run-local:
	@bash scripts/run-local.sh

run-landing:
	cd landing-page-app && npm run dev -- --port 3001

stop:
	-lsof -ti:3001 | xargs kill -9 2>/dev/null || true
	@echo "All services stopped."

# ── Dev CLI/Daemon Refresh ───────────────────────────────────────────────────
#
#   make dev-refresh
#     Compiles fresh `draft` CLI + daemon binaries and bundled runtime (pollers,
#     synthesizers, intelligence adapters) from current source via prebuild.sh,
#     then installs straight from that freshly-built desktop/assets/background/
#     tree — the same tree a real app bundle ships — to where the real,
#     globally-installed daemon/CLI run from (~/.draft/bin/draft,
#     ~/.draft/background/). Use this after changing background/ or cli/ code,
#     so `draft status`/`draft poll` and the auto-polling daemon loop reflect
#     your latest changes — `bun run dev` in desktop/ alone does NOT rebuild
#     either binary.
#
#     Deliberately does NOT install from the bare repo-root background/ dir:
#     that tree only has raw .ts sources (no bundled .js), so a plain
#     `bash background/install.sh` silently leaves any previously-installed
#     bundle in place — including a stale, pre-fix one — since
#     resolveRuntimeEntrypoint() prefers .js over .ts. Installing from
#     desktop/assets/background/ (always a full fresh rebuild — prebuild.sh
#     wipes and recreates it every run) avoids that trap entirely.

.PHONY: dev-refresh

dev-refresh:
	@echo "[dev-refresh] Compiling fresh CLI + daemon binaries + runtime bundles..."
	@bash desktop/scripts/prebuild.sh
	@echo "[dev-refresh] Deploying CLI binary..."
	@cp desktop/assets/bin/draft ~/.draft/bin/draft
	@echo "[dev-refresh] Installing daemon (binary + runtime bundles) from freshly built assets..."
	@bash desktop/assets/background/install.sh
	@echo ""
	@echo "[dev-refresh] Done. Verify with: draft status"
	@echo ""

# ── CLI Plugin ────────────────────────────────────────────────────────────────
#
# Two commands:
#
#   make cli-push
#     Syncs the plugin subtree to plugin-origin/main. No version changes.
#     Safe from any branch. Use during development to keep the plugin repo current.
#
#   make cli-release v=1.3.0 m="what changed"
#     Cuts a release: bumps versions, commits, pushes subtree, creates GitHub release.
#     Must be run from main after your PR is merged and pulled.
#
# PR-based workflow:
#   git push origin your-branch   # normal push
#   # open PR on GitHub, merge it
#   git checkout main && git pull
#   make cli-release v=1.3.0 m="..."
#
# Pre-flight for cli-release:
#   - Be on main with all changes merged and pulled
#   - Update CHANGELOG.md [Unreleased] section before running (auto-promoted to [v])
#   - gh CLI authenticated: gh auth status

CLI_PREFIX  = cli-agent-plugin
PLUGIN_REPO = idodekerobo/draft-cli-plugin

.PHONY: cli-push cli-release

cli-push:
	@echo "[cli-push] Pushing subtree to plugin-origin/main..."
	@git push plugin-origin $$(git subtree split --prefix=$(CLI_PREFIX) HEAD):main --force
	@echo "[cli-push] Done — plugin-origin/main is up to date."

# Push a branch to the plugin repo for beta testing.
# Never merge on the plugin repo side — changes flow from the monorepo only.
# Usage: make cli-push-branch b=cli-updates
cli-push-branch:
	@if [ -z "$(b)" ]; then \
		echo ""; \
		echo "Usage: make cli-push-branch b=<branch-name>"; \
		echo "Example: make cli-push-branch b=cli-updates"; \
		echo ""; \
		exit 1; \
	fi
	@echo "[cli-push-branch] Pushing subtree to plugin-origin/$(b)..."
	@git push plugin-origin $$(git subtree split --prefix=$(CLI_PREFIX) HEAD):refs/heads/$(b) --force
	@echo ""
	@echo "[cli-push-branch] Done. Beta install URLs:"
	@echo ""
	@echo "  Codex:"
	@echo "  curl -fsSL https://raw.githubusercontent.com/$(PLUGIN_REPO)/$(b)/scripts/codex-setup.sh | bash"
	@echo ""
	@echo "  Cursor:"
	@echo "  curl -fsSL https://raw.githubusercontent.com/$(PLUGIN_REPO)/$(b)/scripts/cursor-setup.sh | bash"
	@echo ""
	@echo "  Note: to install from this branch (not main), testers should set DRAFT_BRANCH=$(b)"
	@echo "  See README for full beta install instructions."
	@echo ""

# ── Desktop Release ───────────────────────────────────────────────────────────
#
#   make desktop-release v=1.0.0           # stable build → GitHub release
#   make desktop-release v=1.0.0 canary=1  # canary build → GitHub prerelease
#
#   Builds locally, signs, notarizes, tags, and uploads artifacts to GitHub —
#   the desktop .dmg plus (stable only) standalone `draft` CLI binaries.
#   Stable releases must be run from main. Canary can run from any branch.
#   gh CLI must be authenticated: gh auth status

DESKTOP_REPO = idodekerobo/draft

ifdef canary
_BUILD_CMD   = build:canary
_TAG         = v$(v)-canary
_GH_FLAGS    = --prerelease
else
_BUILD_CMD   = build:stable
_TAG         = v$(v)
_GH_FLAGS    =
endif

.PHONY: desktop-release

desktop-release:
	@if [ -z "$(v)" ]; then \
		echo ""; \
		echo "Usage: make desktop-release v=<version> [canary=1]"; \
		echo "  Stable:  make desktop-release v=1.0.0"; \
		echo "  Canary:  make desktop-release v=1.0.0 canary=1"; \
		echo ""; \
		exit 1; \
	fi
	@if [ -z "$(canary)" ]; then \
		BRANCH=$$(git rev-parse --abbrev-ref HEAD); \
		if [ "$$BRANCH" != "main" ]; then \
			echo ""; \
			echo "Error: stable release must run from main (on: $$BRANCH)."; \
			echo ""; \
			exit 1; \
		fi; \
	fi
	@# ── Guard: fail early if tag already exists ───────────────────────────────
	@if git tag | grep -q "^$(_TAG)$$"; then \
		echo ""; \
		echo "Error: tag $(_TAG) already exists. Bump the version number."; \
		echo ""; \
		exit 1; \
	fi
	@# ── Bump version in electrobun.config.ts ──────────────────────────────────
	@python3 -c "\
import re; \
from pathlib import Path; \
p = Path('desktop/electrobun.config.ts'); \
content = p.read_text(); \
result = re.sub(r'version: \"[^\"]+\"', 'version: \"$(v)\"', content, count=1); \
p.write_text(result)"
	@echo "  Bumped: electrobun.config.ts → $(v)"
	@# ── Commit version bump (stable only, skip if nothing changed) ─────────────
	@if [ -z "$(canary)" ]; then \
		git add desktop/electrobun.config.ts; \
		git diff --cached --quiet \
			&& echo "  Skipped: version already at $(v)" \
			|| git commit -m "chore: release desktop v$(v)"; \
		git push origin main; \
		echo "  Pushed: version bump → origin/main"; \
	fi
	@# ── Build ─────────────────────────────────────────────────────────────────
	@echo ""
	@echo "[desktop-release] Building $(_TAG)..."
	@echo ""
	@bun run --cwd desktop $(_BUILD_CMD)
	@# ── Cross-compile CLI binaries (stable only — canary is --prerelease, never fetched) ──
	@if [ -z "$(canary)" ]; then \
		echo ""; \
		echo "[desktop-release] Cross-compiling draft CLI binaries..."; \
		DRAFT_SUPABASE_URL=$$(python3 -c "import json; print(json.load(open('desktop/src/build-config.json')).get('supabase_url',''))"); \
		DRAFT_SUPABASE_PUBLISHABLE_KEY=$$(python3 -c "import json; print(json.load(open('desktop/src/build-config.json')).get('supabase_publishable_key',''))"); \
		DRAFT_SUPABASE_URL="$$DRAFT_SUPABASE_URL" DRAFT_SUPABASE_PUBLISHABLE_KEY="$$DRAFT_SUPABASE_PUBLISHABLE_KEY" DRAFT_CLI_VERSION="$(v)" \
			bun run cli/scripts/build-release.ts; \
	fi
	@# ── Tag + push ────────────────────────────────────────────────────────────
	@echo ""
	@echo "[desktop-release] Tagging $(_TAG) and pushing..."
	@git tag $(_TAG)
	@git push origin $(_TAG)
	@# ── GitHub release ────────────────────────────────────────────────────────
	@echo ""
	@echo "[desktop-release] Creating GitHub release and uploading artifacts..."
	@gh release create $(_TAG) \
		--repo $(DESKTOP_REPO) \
		--title "$(_TAG)" \
		--generate-notes \
		$(_GH_FLAGS) \
		desktop/artifacts/*
	@echo ""
	@echo "[desktop-release] Done. $(_TAG) is live."
	@echo "  https://github.com/$(DESKTOP_REPO)/releases/tag/$(_TAG)"
	@echo ""

cli-release:
	@if [ -z "$(v)" ] || [ -z "$(m)" ]; then \
		echo ""; \
		echo "Usage: make cli-release v=<version> m=\"<release notes>\""; \
		echo ""; \
		echo "  v   New version number (e.g. 1.3.0)"; \
		echo "  m   Release notes shown on the GitHub release page"; \
		echo ""; \
		echo "Example:"; \
		echo "  make cli-release v=1.3.0 m=\"adding self-update system\""; \
		echo ""; \
		exit 1; \
	fi
	@BRANCH=$$(git rev-parse --abbrev-ref HEAD); \
	if [ "$$BRANCH" != "main" ]; then \
		echo ""; \
		echo "Error: cli-release must run from main (currently on: $$BRANCH)."; \
		echo ""; \
		echo "Merge your branch first, then:"; \
		echo "  git checkout main && git pull && make cli-release v=$(v) m=\"$(m)\""; \
		echo ""; \
		exit 1; \
	fi
	@echo ""
	@echo "[cli-release] Releasing draft-cli-plugin v$(v)..."
	@echo ""
	@# ── 1. Bump VERSION ──────────────────────────────────────────────────────
	@printf "$(v)\n" > $(CLI_PREFIX)/VERSION
	@echo "  Bumped: VERSION → $(v)"
	@# ── 2. Bump plugin.json version ──────────────────────────────────────────
	@python3 -c "\
import json; \
p = '$(CLI_PREFIX)/.claude-plugin/plugin.json'; \
d = json.loads(open(p).read()); \
d['version'] = '$(v)'; \
open(p, 'w').write(json.dumps(d, indent=2) + '\n')"
	@echo "  Bumped: plugin.json → $(v)"
	@# ── 3. Promote CHANGELOG [Unreleased] → [v] ──────────────────────────────
	@python3 -c "\
import re; \
from datetime import date; \
from pathlib import Path; \
p = Path('$(CLI_PREFIX)/CHANGELOG.md'); \
content = p.read_text(); \
today = date.today().strftime('%Y-%m-%d'); \
v = '$(v)'; \
m = re.search(r'## \[Unreleased\]\n(.*?)\n---', content, re.DOTALL); \
body = m.group(1).strip() if m and m.group(1).strip() else ''; \
new_block = '## [Unreleased]\n\n---\n\n## [' + v + '] \u2014 ' + today + ('\n\n' + body if body else '') + '\n\n---'; \
result = re.sub(r'## \[Unreleased\]\n.*?\n---', new_block, content, count=1, flags=re.DOTALL); \
p.write_text(result); \
print('  Updated: CHANGELOG [Unreleased] \u2192 [' + v + '] \u2014 ' + today)" \
	2>/dev/null || echo "  Skipped: CHANGELOG (no [Unreleased] block found — update manually)"
	@# ── 4. Commit version bump ───────────────────────────────────────────────
	@git add $(CLI_PREFIX)/VERSION $(CLI_PREFIX)/.claude-plugin/plugin.json $(CLI_PREFIX)/CHANGELOG.md
	@git diff --cached --quiet \
		&& echo "  Skipped: version files already at $(v)" \
		|| git commit -m "chore: release cli-plugin v$(v)"
	@# ── 5. Push version bump commit to main ──────────────────────────────────
	@git push origin main
	@echo "  Pushed: version bump → origin/main"
	@# ── 6. Push subtree to plugin repo ───────────────────────────────────────
	@$(MAKE) --no-print-directory cli-push
	@# ── 7. Create GitHub release (also creates the tag) ──────────────────────
	@gh release create v$(v) \
		--repo $(PLUGIN_REPO) \
		--title "v$(v)" \
		--notes "$(m)"
	@echo ""
	@echo "[cli-release] Done. v$(v) is live."
	@echo "  https://github.com/$(PLUGIN_REPO)/releases/tag/v$(v)"
	@echo ""

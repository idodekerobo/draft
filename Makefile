run-landing:
	cd landing-page-app && npm run dev -- --port 3001

stop:
	-lsof -ti:3001 | xargs kill -9 2>/dev/null || true
	@echo "All services stopped."

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
#   make desktop-release v=1.0.0
#     Creates and pushes a v*.*.* tag → triggers the GitHub Actions release
#     workflow which builds Draft.app, packages a DMG, and creates a release.
#
#   Must be run from main after your PR is merged and pulled.
#   gh CLI must be authenticated: gh auth status

DESKTOP_REPO = idodekerobo/draft

.PHONY: desktop-release

desktop-release:
	@if [ -z "$(v)" ]; then \
		echo ""; \
		echo "Usage: make desktop-release v=<version>"; \
		echo "Example: make desktop-release v=1.0.0"; \
		echo ""; \
		exit 1; \
	fi
	@BRANCH=$$(git rev-parse --abbrev-ref HEAD); \
	if [ "$$BRANCH" != "main" ]; then \
		echo ""; \
		echo "Error: desktop-release must run from main (on: $$BRANCH)."; \
		echo ""; \
		exit 1; \
	fi
	@echo "[desktop-release] Tagging v$(v) and pushing..."
	@git tag v$(v)
	@git push origin v$(v)
	@echo ""
	@echo "[desktop-release] Tag pushed. GitHub Actions is building the release."
	@echo "  https://github.com/$(DESKTOP_REPO)/actions"
	@echo "  https://github.com/$(DESKTOP_REPO)/releases/tag/v$(v)"
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

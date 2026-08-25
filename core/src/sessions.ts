// core/src/sessions.ts — shared session-capture hook template and
// SessionEnd merge/remove logic for the CLI and desktop app, so the two
// installers can't drift.

import type { ClaudeSettings } from "./sync/claude-settings";

export const DRAFT_DIR = ".claude/draft";
export const CAPTURE_CONFIG_FILE = "config.json";
export const HOOK_SCRIPT_FILE = "capture-session.sh";
export const HOOK_COMMAND = `"\${CLAUDE_PROJECT_DIR}/${DRAFT_DIR}/${HOOK_SCRIPT_FILE}"`;

// Resolves the draft binary from fixed locations instead of relying on
// shell PATH inheritance. No network call; missing binary is a local
// diagnostic, never a blocked SessionEnd hook.
export function buildCaptureScript(): string {
  return `#!/usr/bin/env bash
# Installed by draft sessions enable -- do not edit by hand, re-run enable instead.
resolve_draft() {
  if [ -x "$HOME/.draft/bin/draft" ]; then echo "$HOME/.draft/bin/draft"; return; fi
  if [ -x "/usr/local/bin/draft" ]; then echo "/usr/local/bin/draft"; return; fi
  if [ -n "$DRAFT_BIN" ] && [ -x "$DRAFT_BIN" ]; then echo "$DRAFT_BIN"; return; fi
  echo ""
}
DRAFT="$(resolve_draft)"
if [ -z "$DRAFT" ]; then
  mkdir -p "$HOME/.draft/log" 2>/dev/null
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) draft binary not found (checked \\$HOME/.draft/bin/draft, /usr/local/bin/draft, \\$DRAFT_BIN)" >> "$HOME/.draft/log/sessions-ingest.log" 2>/dev/null
  exit 0
fi
"$DRAFT" sessions ingest >/dev/null 2>&1
exit 0
`;
}

export function hasSessionEndHook(settings: ClaudeSettings): boolean {
  return (settings.hooks?.SessionEnd ?? []).some((entry) => entry.hooks.some((h) => h.command === HOOK_COMMAND));
}

export function mergeSessionEndHook(settings: ClaudeSettings): ClaudeSettings {
  if (hasSessionEndHook(settings)) return settings;
  return {
    ...settings,
    hooks: {
      ...settings.hooks,
      SessionEnd: [...(settings.hooks?.SessionEnd ?? []), { hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 60 }] }],
    },
  };
}

export function removeSessionEndHook(settings: ClaudeSettings): ClaudeSettings {
  if (!hasSessionEndHook(settings)) return settings;
  const filtered = (settings.hooks?.SessionEnd ?? [])
    .map((entry) => ({ ...entry, hooks: entry.hooks.filter((h) => h.command !== HOOK_COMMAND) }))
    .filter((entry) => entry.hooks.length > 0);
  const nextHooks = { ...settings.hooks };
  if (filtered.length === 0) delete nextHooks.SessionEnd;
  else nextHooks.SessionEnd = filtered;
  return { ...settings, hooks: nextHooks };
}

// Checks the same three locations the hook script itself checks, so
// `sessions status` can report which one (if any) resolved.
export function resolveDraftBinaryPath(env: NodeJS.ProcessEnv, isExecutable: (path: string) => boolean): string | null {
  const home = env.HOME;
  if (home) {
    const homeBin = `${home}/.draft/bin/draft`;
    if (isExecutable(homeBin)) return homeBin;
  }
  if (isExecutable("/usr/local/bin/draft")) return "/usr/local/bin/draft";
  if (env.DRAFT_BIN && isExecutable(env.DRAFT_BIN)) return env.DRAFT_BIN;
  return null;
}

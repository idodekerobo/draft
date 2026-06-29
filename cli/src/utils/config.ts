// utils/config.ts — re-exports from draft-core/config + CLI-specific helpers
//
// All shared config logic lives in draft-core/config. This file re-exports
// everything so existing `import { ... } from "../utils/config.ts"` calls
// in CLI commands continue to work without changes.

import { join } from "path";
import { readFileSync } from "fs";

// ── Re-exports from shared core ────────────────────────────────────────────────
export {
  DRAFT_ROOT,
  WORKSPACES_DIR,
  BACKGROUND_DIR,
  ACTIVE_PROFILE_FILE,
  type Secrets,
  type SecretsResult,
  type Collaboration,
  type CollabResult,
  type Integrations,
  type IntegrationEntry,
  type IntegrationsResult,
  type InstalledTool,
  type ToolEntry,
  type DraftConfig,
  type DraftConfigResult,
  getActiveProfile,
  getWorkspacePath,
  readSecrets,
  readCollaboration,
  readIntegrations,
  writeIntegrations,
  readDraftConfig,
  writeDraftConfig,
  writeToolConfig,
  getInstalledTools,
  type LocalConfig,
  type LocalConfigResult,
  readLocalConfig,
  writeLocalConfig,
} from "draft-core/config";

// ── CLI-specific: repo root detection ─────────────────────────────────────────
// Walk up from this file's location until we find the repo root.
// Marker: the directory contains "cli-agent-plugin/".
// Not shared with desktop — desktop doesn't need to locate the plugin dir.

export function getRepoRoot(): string {
  // import.meta.dir resolves to cli/src/utils/ at runtime
  const parts = import.meta.dir.split("/");
  for (let i = parts.length; i > 0; i--) {
    const candidate = parts.slice(0, i).join("/");
    const marker = join(candidate, "cli-agent-plugin", "settings.json");
    try {
      readFileSync(marker, "utf8");
      return candidate;
    } catch {
      continue;
    }
  }
  // Fallback: assume we're being run from repo root
  return process.cwd();
}

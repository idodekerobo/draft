import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";

const CLAUDE_JSON_PATH = `${process.env.HOME}/.claude.json`;

/**
 * Marks onboarding done and the folder trusted, so the pane never stops on a dialog nobody sees.
 * Throws when the file exists but cannot be parsed, so a user's config is never overwritten.
 */
export function preTrustFolder(folderPath: string, claudeJsonPath = CLAUDE_JSON_PATH): void {
  const config: Record<string, unknown> = existsSync(claudeJsonPath)
    ? JSON.parse(readFileSync(claudeJsonPath, "utf8"))
    : {};

  const projects = (config.projects ?? {}) as Record<string, Record<string, unknown>>;
  config.hasCompletedOnboarding = true;
  config.projects = { ...projects, [folderPath]: { ...projects[folderPath], hasTrustDialogAccepted: true } };

  const tmpPath = `${claudeJsonPath}.draft-${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(config, null, 2));
  renameSync(tmpPath, claudeJsonPath);
}

// commands/sync.ts — canonical draft publish + draft load lifecycle

import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { capture } from "../utils/exec";
import {
  getActiveProfile,
  getWorkspacePath,
  readCollaboration,
} from "../utils/config";
import { green, red, yellow, dim, bold } from "../utils/output";
import {
  validateProfileAssets,
  type ProfileAssetResult,
} from "draft-core/sync/team-assets";
import {
  publishTeamContext,
  listUnpublishedContextPaths,
  PublishError,
} from "draft-core/sync/publish";
import {
  stageTeamContent,
  promoteStagedTeamContent,
  type StageErrorCode,
  type PromoteResult,
} from "draft-core/sync/team-load";

function mapErrorToMessage(error: StageErrorCode | Extract<PromoteResult, { ok: false }>["error"]): string {
  switch (error) {
    case "no_token": return "GitHub sign-in required. Reconnect GitHub for this team.";
    case "no_access": return "No access to the team repository. Ask your team to add you, then try again.";
    case "token_revoked": return "GitHub access was revoked. Reconnect GitHub for this team.";
    case "network": return "Network error while contacting GitHub.";
    case "rate_limited": return "GitHub rate-limited this request. Try again shortly.";
    case "archive_invalid": return "The team repository archive was invalid or unsafe to extract.";
    case "archive_too_large": return "The team repository archive exceeded the allowed size.";
    case "unpublished_local_changes": return "unpublished local context changes detected. Run `draft publish` before loading.";
    case "unpublished_team_assets": return "unpublished team asset changes detected. Run `draft publish` or explicitly rerun `draft load --discard-team-assets`.";
    case "local_asset_validation_failed": return "local team assets are invalid. Run `draft doctor` for details.";
    case "remote_asset_validation_failed": return "remote team assets are invalid.";
    case "clone_failed": return "Failed to clone the team repository.";
    case "workspace_changed": return "The active profile changed during load. Try again.";
    case "stage_not_found": return "The staged team content expired. Try again.";
    case "apply_failed": return "Failed to apply team content. Local state was restored.";
    default: return `Team load failed: ${error}`;
  }
}

interface SyncJsonResult {
  ok: boolean;
  profile: string;
  partial?: boolean;
  skipped?: boolean;
  reason?: string;
  installed?: { skills: string[]; mcps: string[] };
  removed?: { skills: string[]; mcps: string[] };
  missing_secrets?: Array<{ name: string; required_secrets: string[] }>;
  conflicts?: ProfileAssetResult["conflicts"];
  errors: string[];
}

function fail(message: string, json: boolean, code = 1): void {
  if (json) console.log(JSON.stringify({ ok: false, errors: [message] }));
  else console.error(red(message));
  process.exitCode = code;
}

function writeNotification(workspace: string, name: string, message: string): void {
  const path = join(workspace, "notifications", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, message.trimEnd() + "\n", "utf8");
}

function formatAssets(result: ProfileAssetResult): SyncJsonResult {
  return {
    ok: true,
    profile: result.profile,
    partial: result.conflicts.length > 0 || result.missingSecrets.length > 0 || result.errors.length > 0,
    installed: { skills: result.installedSkills, mcps: result.installedMcps },
    removed: { skills: result.removedSkills, mcps: result.removedMcps },
    missing_secrets: result.missingSecrets.map(({ name, requiredSecrets }) => ({
      name, required_secrets: requiredSecrets,
    })),
    conflicts: result.conflicts,
    errors: result.errors,
  };
}

function collectRepeatedFlag(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] !== undefined) out.push(args[++i]);
  }
  return out;
}

// ── publish ───────────────────────────────────────────────────────────────────

export async function runPublish(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const profile = getActiveProfile();
  const workspace = getWorkspacePath(profile);

  if (args.includes("--list-changed")) {
    const paths = listUnpublishedContextPaths(workspace);
    if (json) console.log(JSON.stringify({ ok: true, profile, paths }));
    else if (paths.length) console.log(paths.join("\n"));
    else console.log(dim("Nothing to publish."));
    return;
  }

  const paths = collectRepeatedFlag(args, "--path");

  const validation = validateProfileAssets(profile);
  if (!validation.ok) {
    fail(`Team assets are invalid: ${validation.errors.map((entry) => entry.message).join("; ")}`, json, 2);
    return;
  }
  const gh = await capture(["gh", "api", "user", "--jq", ".login"]);
  if (gh.exitCode !== 0 || !gh.stdout.trim()) {
    fail("GitHub CLI not authenticated. Run `gh auth login` first.", json, 3);
    return;
  }

  try {
    const result = await publishTeamContext(workspace, profile, paths.length ? { paths } : undefined);
    if (json) {
      console.log(JSON.stringify({ ok: true, profile, ...result, errors: [] }));
    } else if (!result.published) {
      console.log(dim("Nothing to publish."));
    } else {
      console.log(`${green("✓")} Published ${result.scoped ? `${bold(String(result.files.length))} file(s)` : "team context and assets"}${result.proposalsCleared ? ` with ${bold(String(result.proposalsCleared))} proposal(s)` : ""}.`);
    }
  } catch (error) {
    fail(error instanceof PublishError || error instanceof Error ? error.message : String(error), json, 3);
  }
}

// ── load ──────────────────────────────────────────────────────────────────────

export async function runLoad(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const sessionStart = args.includes("--session-start");
  const discard = args.includes("--discard-team-assets");
  const profile = getActiveProfile();
  const workspace = getWorkspacePath(profile);

  const finishFailure = (message: string, code = 1) => {
    if (sessionStart) {
      writeNotification(workspace, "load-team-warning.txt", `Team load skipped: ${message}`);
      if (json) console.log(JSON.stringify({ ok: true, profile, skipped: true, reason: message, errors: [] }));
      return;
    }
    fail(message, json, code);
  };

  if (sessionStart && discard) {
    finishFailure("--discard-team-assets is unavailable during SessionStart.");
    return;
  }

  // No team repo configured — nothing to load, so skip the guard checks below
  // and no-op silently rather than warning about "unpublished" changes.
  if (!readCollaboration(workspace).ok) {
    if (sessionStart) {
      if (json) console.log(JSON.stringify({ ok: true, profile, skipped: true, reason: "no-collaboration", errors: [] }));
      return;
    }
    fail("No team repo configured for this profile. Run /draft-setup-collab first.", json, 2);
    return;
  }

  const staged = await stageTeamContent({ workspace, profile, discardTeamAssets: discard });
  if (!staged.ok) {
    finishFailure(mapErrorToMessage(staged.error));
    return;
  }
  const promoted = await promoteStagedTeamContent(staged.staged.operationId);
  if (!promoted.ok) {
    finishFailure(mapErrorToMessage(promoted.error));
    return;
  }

  // Same fields, same message text, same session-start vs. interactive
  // branching as before the shared-loader migration.
  const output = formatAssets({
    profile,
    installedSkills: promoted.installedSkills,
    installedMcps: promoted.installedMcps,
    removedSkills: promoted.removedSkills,
    removedMcps: promoted.removedMcps,
    conflicts: promoted.conflicts,
    missingSecrets: promoted.missingSecrets,
    errors: [],
  });
  if (sessionStart) {
    const note = output.partial
      ? `Team context loaded with required actions: ${promoted.missingSecrets.length} MCP credential set(s) missing; ${promoted.conflicts.length} personal-name conflict(s).`
      : "Team context and assets refreshed from the shared repository.";
    writeNotification(workspace, output.partial ? "load-team-warning.txt" : "load-team-loaded.txt", note);
  }
  if (json) console.log(JSON.stringify(output));
  else {
    console.log(`${green("✓")} Team context and assets loaded.`);
    if (promoted.missingSecrets.length) console.log(`${yellow("⚠")} MCP credentials required: ${promoted.missingSecrets.map((entry) => entry.name).join(", ")}`);
    if (promoted.conflicts.length) console.log(`${yellow("⚠")} Personal assets preserved for ${promoted.conflicts.length} conflict(s).`);
  }
}

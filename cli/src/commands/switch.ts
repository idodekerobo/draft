// commands/switch.ts — draft switch <name>

import { existsSync } from "fs";
import { getActiveProfile, WORKSPACES_DIR } from "../utils/config";
import { green, red, yellow, dim, cyan } from "../utils/output";
import {
  installProfileAssets,
  switchProfileAssets,
  TeamAssetValidationError,
  type ProfileAssetResult,
} from "draft-core/sync/team-assets";

function jsonResult(result: ProfileAssetResult) {
  return {
    ok: true,
    profile: result.profile,
    partial: result.conflicts.length > 0 || result.missingSecrets.length > 0 || result.errors.length > 0,
    installed: { skills: result.installedSkills, mcps: result.installedMcps },
    removed: { skills: result.removedSkills, mcps: result.removedMcps },
    missing_secrets: result.missingSecrets.map((entry) => ({
      name: entry.name,
      required_secrets: entry.requiredSecrets,
    })),
    conflicts: result.conflicts.map(({ kind, name, reason }) => ({ kind, name, reason })),
    errors: result.errors,
  };
}

export async function runSwitch(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log("Usage: draft switch <profile-name> [--json]");
    console.log("Activates a named profile and swaps its team skills and MCP servers.");
    process.exit(0);
  }

  const json = args.includes("--json");
  const name = args.find((arg) => !arg.startsWith("-"));
  if (!name) {
    const current = getActiveProfile();
    if (json) {
      console.log(JSON.stringify({ ok: true, profile: current }));
      return;
    }
    console.log(`Active profile: ${dim(current)}`);
    console.log(`Usage: ${cyan("draft switch <profile-name>")}`);
    return;
  }

  const workspacePath = `${WORKSPACES_DIR}/${name}`;
  if (!existsSync(workspacePath)) {
    if (json) {
      console.log(JSON.stringify({ ok: false, profile: name, error: "profile-not-found" }));
      process.exitCode = 1;
      return;
    }
    console.error(red(`Profile '${name}' not found.`));
    console.error(`Run ${cyan("draft profiles")} to see available profiles.`);
    process.exitCode = 1;
    return;
  }

  const oldProfile = getActiveProfile();
  try {
    const result = oldProfile === name
      ? await installProfileAssets(name)
      : await switchProfileAssets(oldProfile, name);

    if (json) {
      console.log(JSON.stringify(jsonResult(result)));
      return;
    }

    console.log(`${green("✓")} Active profile set to ${dim(name)}.`);
    console.log(`${green("✓")} Installed ${result.installedSkills.length} team skill(s) and ${result.installedMcps.length} team MCP(s).`);
    if (result.missingSecrets.length > 0) {
      console.log(`${yellow("⚠")} ${result.missingSecrets.length} MCP(s) need credentials: ${result.missingSecrets.map((entry) => entry.name).join(", ")}`);
    }
    if (result.conflicts.length > 0) {
      console.log(`${yellow("⚠")} ${result.conflicts.length} team asset conflict(s); personal assets were preserved.`);
    }
    for (const error of result.errors) console.log(`${yellow("⚠")} ${error}`);
    console.log(dim("Restart active agent sessions to load the new profile."));
  } catch (error) {
    const details = error instanceof TeamAssetValidationError
      ? error.errors
      : [{ message: error instanceof Error ? error.message : String(error) }];
    if (json) {
      console.log(JSON.stringify({ ok: false, profile: name, errors: details }));
    } else {
      console.error(red(`Failed to switch to '${name}'.`));
      for (const detail of details) console.error(dim(detail.message));
    }
    process.exitCode = 1;
  }
}

// commands/switch.ts — draft switch <name>

import { existsSync, writeFileSync } from "fs";
import { getActiveProfile, WORKSPACES_DIR, ACTIVE_PROFILE_FILE } from "../utils/config";
import { green, red, dim, cyan } from "../utils/output";

export async function runSwitch(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log("Usage: draft switch <profile-name>");
    console.log("Activates a named profile. Takes effect on next session restart.");
    process.exit(0);
  }

  const name = args[0];
  if (!name) {
    const current = getActiveProfile();
    console.log(`Active profile: ${dim(current)}`);
    console.log(`Usage: ${cyan("draft switch <profile-name>")}`);
    process.exit(1);
  }

  const workspacePath = `${WORKSPACES_DIR}/${name}`;
  if (!existsSync(workspacePath)) {
    console.error(red(`Profile '${name}' not found.`));
    console.error(`Run ${cyan("draft profiles")} to see available profiles.`);
    process.exit(1);
  }

  writeFileSync(ACTIVE_PROFILE_FILE, name, "utf8");
  console.log(`${green("✓")} Active profile set to ${dim(name)}.`);
  console.log(dim("Takes effect on next session restart."));
}

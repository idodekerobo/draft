// commands/switch.ts — draft switch <name>

import { existsSync, writeFileSync } from "fs";
import { getActiveProfile } from "../utils/config.ts";
import { green, red, dim, cyan } from "../utils/output.ts";

const HOME = process.env.HOME!;
const DRAFT_GLOBAL = `${HOME}/.draft`;

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

  const workspacePath = `${DRAFT_GLOBAL}/workspaces/${name}`;
  if (!existsSync(workspacePath)) {
    console.error(red(`Profile '${name}' not found.`));
    console.error(`Run ${cyan("draft profiles")} to see available profiles.`);
    process.exit(1);
  }

  writeFileSync(`${DRAFT_GLOBAL}/active-profile`, name, "utf8");
  console.log(`${green("✓")} Active profile set to ${dim(name)}.`);
  console.log(dim("Takes effect on next session restart."));
}

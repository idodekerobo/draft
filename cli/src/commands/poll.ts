// commands/poll.ts — draft poll <integration>

import { existsSync } from "fs";
import { spawn } from "../utils/exec.ts";
import { getActiveProfile, getWorkspacePath } from "../utils/config.ts";
import { bold, dim, red, cyan, green } from "../utils/output.ts";

const HOME = process.env.HOME!;
const BACKGROUND = `${HOME}/.draft/background`;

type IntegrationConfig = {
  script: string;
  label: string;
  configCheck?: (workspace: string) => boolean;
};

const INTEGRATIONS: Record<string, IntegrationConfig> = {
  github: {
    script: `${BACKGROUND}/integrations/github/github-poller.sh`,
    label: "GitHub",
    configCheck: (workspace) => existsSync(`${workspace}/config/github.json`),
  },
  granola: {
    script: `${BACKGROUND}/integrations/granola/granola-poller.sh`,
    label: "Granola",
  },
  slack: {
    script: `${BACKGROUND}/integrations/slack/slack-analyzer.sh`,
    label: "Slack",
  },
};

export async function runPoll(args: string[]): Promise<void> {
  const integration = args[0];

  if (!integration || integration === "--help" || integration === "-h") {
    console.log(`Usage: ${cyan("draft poll <integration>")}`);
    console.log("");
    console.log("Trigger an on-demand poll for a connected integration:");
    console.log("");
    for (const [name, { label }] of Object.entries(INTEGRATIONS)) {
      console.log(`  ${cyan(name.padEnd(12))}Poll ${label} now`);
    }
    console.log("");
    console.log(`Example: ${dim("draft poll github")}`);
    process.exit(0);
  }

  const config = INTEGRATIONS[integration];
  if (!config) {
    console.error(red(`Unknown integration: ${integration}`));
    console.error(`Available: ${Object.keys(INTEGRATIONS).join(", ")}`);
    process.exit(1);
  }

  if (!existsSync(config.script)) {
    console.error(red(`Poller script not found: ${config.script}`));
    console.error(dim("Try reinstalling: draft add claude-code"));
    process.exit(3);
  }

  // Per-profile config check (GitHub requires github.json to exist)
  if (config.configCheck) {
    const profile = getActiveProfile();
    const workspace = getWorkspacePath(profile);
    if (!config.configCheck(workspace)) {
      console.error(red(`${config.label} is not configured for this profile.`));
      console.error(dim(`Run /draft:connect ${integration} in Claude Code to set it up.`));
      process.exit(2);
    }
  }

  console.log(`${bold("Draft")} polling ${config.label}...`);
  console.log("");

  const code = await spawn(["bash", config.script]);

  if (code === 0) {
    console.log("");
    console.log(`${green("✓")} Done. Run ${cyan("draft proposals")} to review any new context updates.`);
  }

  process.exit(code);
}

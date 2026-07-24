// commands/poll.ts — draft poll <integration>

import { spawn } from "../utils/exec.ts";
import { getActiveProfile, getWorkspacePath, readIntegrations } from "../utils/config.ts";
import { bold, dim, red, cyan, green } from "../utils/output.ts";
import { resolveRuntimeEntrypoint, runtimeCommand } from "draft-core/runtime";

const HOME = process.env.HOME!;
const BACKGROUND = `${HOME}/.draft/background`;

type IntegrationConfig = {
  entrypoint: string;
  label: string;
  configCheck?: (workspace: string) => boolean;
};

const INTEGRATIONS: Record<string, IntegrationConfig> = {
  github: {
    entrypoint: `${BACKGROUND}/integrations/github/github-poller`,
    label: "GitHub",
    configCheck: (workspace) => {
      const result = readIntegrations(workspace);
      return result.ok && (result.integrations.github?.connected ?? false);
    },
  },
  granola: {
    entrypoint: `${BACKGROUND}/integrations/granola/granola-poller`,
    label: "Granola",
  },
  fireflies: {
    entrypoint: `${BACKGROUND}/integrations/fireflies/fireflies-poller`,
    label: "Fireflies",
  },
  slack: {
    entrypoint: `${BACKGROUND}/integrations/slack/slack-analyzer`,
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

  const entrypoint = resolveRuntimeEntrypoint(config.entrypoint);
  if (!entrypoint) {
    console.error(red(`Poller script not found: ${config.entrypoint}.{js,ts,sh}`));
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

  const command = runtimeCommand(entrypoint);
  if (!command) {
    console.error(red("Bun runtime not found. Reinstall Draft or install Bun."));
    process.exit(3);
  }
  const code = await spawn(command);

  if (code === 0) {
    console.log("");
    console.log(`${green("✓")} Done. Run ${cyan("draft proposals")} to review any new context updates.`);
  }

  process.exit(code);
}

// commands/daemon.ts — start, stop, status, logs

import { spawn, capture } from "../utils/exec";
import { getActiveProfile, getWorkspacePath, readSecrets, BACKGROUND_DIR } from "../utils/config";
import { bold, dim, dot, green, red, yellow, cyan } from "../utils/output";
import { PLIST_LABEL, DAEMON_LOG, DAEMON_ERR_LOG, getDaemonStatus } from "draft-core/status";

// ── status ─────────────────────────────────────────────────────────────────────

export async function runStatus(_args: string[]): Promise<void> {
  // 1. Check LaunchAgent status
  const { state: daemonState, pid, lastExit, isRegistered } = await getDaemonStatus();
  const isRunning = daemonState === "running";

  // 2. Profile + workspace
  const profile = getActiveProfile();
  const workspace = getWorkspacePath(profile);

  // 3. Integration states from secrets.json
  const secretsResult = readSecrets(workspace);
  const secrets = secretsResult.ok ? secretsResult.secrets : {};

  // 4. Render
  console.log("");
  console.log(`  ${bold("Draft")} daemon`);
  console.log(`  ${"─".repeat(36)}`);
  console.log(`  ${dot(daemonState)}  Daemon        ${
    isRunning
      ? green("running") + dim(` (pid ${pid})`)
      : isRegistered
        ? yellow("degraded") + dim(` (last exit: ${lastExit ?? "?"})`)
        : red("stopped")
  }`);
  console.log(`  ${dot("unknown")}  Profile       ${dim(profile)}`);
  console.log("");
  console.log(`  ${bold("Integrations")}`);

  // Granola
  const granolaState = secrets.granola_mode === "mcp" || secrets.granola_mode === "api"
    ? "running" : "stopped";
  const granolaLabel = secrets.granola_mode
    ? `${green("connected")} ${dim(`(${secrets.granola_mode})`)}`
    : dim("not connected");
  console.log(`  ${dot(granolaState)}  Granola       ${granolaLabel}`);

  // Slack
  const slackState = (secrets.slack_bot_token && secrets.slack_app_token) ? "running" : "stopped";
  const slackLabel = slackState === "running" ? green("connected") : dim("not connected");
  console.log(`  ${dot(slackState)}  Slack         ${slackLabel}`);

  // GitHub
  const githubState = secrets.github_connected ? "running" : "stopped";
  const githubLabel = githubState === "running" ? green("connected") : dim("not connected");
  console.log(`  ${dot(githubState)}  GitHub        ${githubLabel}`);

  console.log("");

  if (!isRunning) {
    console.log(`  ${dim("Run")} ${cyan("draft start")} ${dim("to start the daemon.")}`);
    console.log("");
  }

  if (daemonState === "stopped" && !isRegistered) {
    console.log(`  ${dim("Daemon not installed. Run")} ${cyan("draft add claude-code")} ${dim("to install.")}`);
    console.log("");
  }
}

// ── start ──────────────────────────────────────────────────────────────────────

export async function runStart(_args: string[]): Promise<void> {
  const result = await capture(["bash", `${BACKGROUND_DIR}/start.sh`]);
  if (result.exitCode !== 0) {
    console.error(red("Failed to start daemon."));
    console.error(dim(result.stderr || result.stdout));
    process.exit(result.exitCode);
  }
  console.log(`  ${green("✓")} Daemon started.`);
}

// ── stop ───────────────────────────────────────────────────────────────────────

export async function runStop(_args: string[]): Promise<void> {
  const result = await capture(["bash", `${BACKGROUND_DIR}/stop.sh`]);
  if (result.exitCode !== 0) {
    console.error(red("Failed to stop daemon."));
    console.error(dim(result.stderr || result.stdout));
    process.exit(result.exitCode);
  }
  console.log(`  ${green("✓")} Daemon stopped. Run ${cyan("draft start")} to resume.`);
}

// ── logs ───────────────────────────────────────────────────────────────────────

export async function runLogs(args: string[]): Promise<void> {
  const follow = args.includes("--follow") || args.includes("-f");
  const errorsOnly = args.includes("--errors");

  if (args.includes("--help")) {
    console.log("Usage: draft logs [--follow] [--errors]");
    console.log("  --follow, -f   Stream logs live (Ctrl+C to stop)");
    console.log("  --errors       Show stderr log instead of stdout");
    process.exit(0);
  }

  const logFile = errorsOnly ? DAEMON_ERR_LOG : DAEMON_LOG;

  if (follow) {
    const code = await spawn(["tail", "-f", logFile]);
    process.exit(code);
  } else {
    const code = await spawn(["tail", "-50", logFile]);
    process.exit(code);
  }
}

// commands/daemon.ts — start, stop, status, logs

import { spawn, capture } from "../utils/exec.ts";
import { getActiveProfile, getWorkspacePath, readSecrets } from "../utils/config.ts";
import { bold, dim, dot, green, red, yellow, cyan } from "../utils/output.ts";

const HOME = process.env.HOME!;
const BACKGROUND = `${HOME}/.draft/background`;
const LOG_FILE = `${BACKGROUND}/logs/daemon.log`;
const ERR_LOG_FILE = `${BACKGROUND}/logs/daemon-error.log`;
const PLIST_LABEL = "com.draft.daemon";

// ── status ─────────────────────────────────────────────────────────────────────

export async function runStatus(_args: string[]): Promise<void> {
  // 1. Check LaunchAgent status
  const launchResult = await capture(["launchctl", "list", PLIST_LABEL]);
  const isRegistered = launchResult.exitCode === 0;

  let pid: string | null = null;
  let lastExit: string | null = null;
  if (isRegistered) {
    const pidMatch = launchResult.stdout.match(/"PID"\s*=\s*(\d+)/);
    const exitMatch = launchResult.stdout.match(/"LastExitStatus"\s*=\s*(\d+)/);
    pid = pidMatch?.[1] ?? null;
    lastExit = exitMatch?.[1] ?? null;
  }

  const isRunning = isRegistered && pid !== null;
  const daemonState = isRunning ? "running" : (isRegistered ? "degraded" : "stopped");

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
  const result = await capture(["bash", `${BACKGROUND}/start.sh`]);
  if (result.exitCode !== 0) {
    console.error(red("Failed to start daemon."));
    console.error(dim(result.stderr || result.stdout));
    process.exit(result.exitCode);
  }
  console.log(`  ${green("✓")} Daemon started.`);
}

// ── stop ───────────────────────────────────────────────────────────────────────

export async function runStop(_args: string[]): Promise<void> {
  const result = await capture(["bash", `${BACKGROUND}/stop.sh`]);
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

  const logFile = errorsOnly ? ERR_LOG_FILE : LOG_FILE;

  if (follow) {
    const code = await spawn(["tail", "-f", logFile]);
    process.exit(code);
  } else {
    const code = await spawn(["tail", "-50", logFile]);
    process.exit(code);
  }
}

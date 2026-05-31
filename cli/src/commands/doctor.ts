// commands/doctor — diagnose configuration and dependency issues
//
// Checks run in dependency order:
//   Group 1: Runtime deps (always)
//   Group 2: Daemon (after runtime)
//   Group 3: Config (after runtime)
//   Group 4: Integrations (SKIP if claude CLI failed in Group 1)

import { existsSync, statSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { capture } from "../utils/exec";
import { getActiveProfile, getWorkspacePath, readSecrets, DRAFT_ROOT, BACKGROUND_DIR } from "../utils/config";
import { readDraftConfig, writeDraftConfig } from "draft-core/config";
import { green, red, yellow, dim, bold, cyan } from "../utils/output";
import { PLIST_LABEL, PLIST_PATH } from "draft-core/status";

interface CheckResult {
  label: string;
  passed: boolean;
  detail?: string;
  fix?: string;
}

export async function runDoctor(_args: string[]): Promise<void> {
  console.log("");
  console.log(bold("draft doctor"));
  console.log(dim("─".repeat(40)));

  let claudeMissing = false;
  let allPassed = true;

  // ── Group 1: Runtime dependencies ─────────────────────────────────────────
  console.log(`\n${bold("Runtime dependencies")}`);

  const tmux = await checkCommand("tmux", ["tmux", "-V"]);
  if (!tmux.passed) tmux.fix = "brew install tmux";
  printCheck(tmux);

  const claudeCheck = await checkCommand("claude CLI", ["claude", "--version"]);
  if (!claudeCheck.passed) {
    claudeCheck.fix = "Install Claude Code: https://claude.ai/download";
    claudeMissing = true;
  }
  printCheck(claudeCheck);

  const bunCheck = await checkCommand("bun", ["bun", "--version"]);
  if (!bunCheck.passed) bunCheck.fix = "Install bun: https://bun.sh";
  printCheck(bunCheck);

  const ghCheck = await checkCommand("gh CLI", ["gh", "auth", "status"]);
  if (!ghCheck.passed) ghCheck.fix = "gh auth login";
  printCheck(ghCheck);

  if (!tmux.passed || !claudeCheck.passed || !bunCheck.passed) allPassed = false;

  // ── Group 2: Daemon ────────────────────────────────────────────────────────
  console.log(`\n${bold("Daemon")}`);

  const plistExists = checkFile("LaunchAgent plist", PLIST_PATH);
  if (!plistExists.passed) plistExists.fix = `Run: draft add claude-code`;
  printCheck(plistExists);

  const daemonRegistered = await checkLaunchctl("Daemon registered", PLIST_LABEL);
  if (!daemonRegistered.passed) daemonRegistered.fix = "Run: draft start";
  printCheck(daemonRegistered);

  let daemonRunning: CheckResult;
  if (daemonRegistered.passed) {
    const listResult = await capture(["launchctl", "list", PLIST_LABEL]);
    const hasPid = /\"PID\"\s*=\s*\d+/.test(listResult.stdout);
    daemonRunning = {
      label: "Daemon running",
      passed: hasPid,
      fix: hasPid ? undefined : "Run: draft start",
    };
  } else {
    daemonRunning = { label: "Daemon running", passed: false, detail: "skipped (not registered)", fix: "Run: draft start" };
  }
  printCheck(daemonRunning);

  const logsWritable = checkDir("Log files writable", `${BACKGROUND_DIR}/logs`);
  if (!logsWritable.passed) logsWritable.fix = `mkdir -p ${BACKGROUND_DIR}/logs`;
  printCheck(logsWritable);

  if (!plistExists.passed || !daemonRegistered.passed || !daemonRunning.passed) allPassed = false;

  // ── Group 3: Config ────────────────────────────────────────────────────────
  console.log(`\n${bold("Config")}`);

  const activeProfileFile = `${DRAFT_ROOT}/active-profile`;
  const profileReadable = checkFile("active-profile readable", activeProfileFile);
  printCheck(profileReadable);

  const profile = getActiveProfile();
  const workspace = getWorkspacePath(profile);
  const workspaceExists = checkDir(`Workspace (${profile})`, workspace);
  if (!workspaceExists.passed) workspaceExists.fix = `Run /draft:setup in Claude Code`;
  printCheck(workspaceExists);

  const secretsPath = join(workspace, "config", "secrets.json");
  let secretsValid: CheckResult;
  if (existsSync(secretsPath)) {
    const result = readSecrets(workspace);
    if (result.ok) {
      // Check permissions
      const mode = statSync(secretsPath).mode & 0o777;
      const isPrivate = mode === 0o600;
      secretsValid = {
        label: "secrets.json valid JSON",
        passed: true,
      };
      printCheck(secretsValid);

      const secretsPerms: CheckResult = {
        label: "secrets.json chmod 600",
        passed: isPrivate,
        detail: isPrivate ? undefined : `current: ${mode.toString(8)}`,
        fix: isPrivate ? undefined : `chmod 600 ${secretsPath}`,
      };
      printCheck(secretsPerms);
      if (!isPrivate) allPassed = false;
    } else {
      secretsValid = {
        label: "secrets.json valid JSON",
        passed: false,
        detail: result.reason === "malformed" ? "malformed JSON" : "could not read",
        fix: `Delete and re-run /draft:connect in Claude Code`,
      };
      printCheck(secretsValid);
      allPassed = false;
    }
  } else {
    // secrets.json is optional — only warn if some integrations appear misconfigured
    secretsValid = { label: "secrets.json", passed: true, detail: "not present (ok — no integrations configured)" };
    printCheck(secretsValid);
  }

  // ── Group 4: Integrations (skip if claude CLI missing) ─────────────────────
  console.log(`\n${bold("Integrations")}`);

  if (claudeMissing) {
    console.log(dim("  (skipped — Claude CLI not installed)"));
  } else {
    const secretsResult = readSecrets(workspace);
    const secrets = secretsResult.ok ? secretsResult.secrets : {};

    // Granola
    if (secrets.granola_mode === "mcp") {
      const mcpList = await capture(["claude", "mcp", "list"]);
      const granolaInMcp = mcpList.stdout.toLowerCase().includes("granola");
      const granolaCheck: CheckResult = {
        label: "Granola MCP registered",
        passed: granolaInMcp,
        fix: granolaInMcp ? undefined : "Run /draft:connect granola in Claude Code",
      };
      printCheck(granolaCheck);
      if (!granolaInMcp) allPassed = false;
    } else if (secrets.granola_mode === "api") {
      const hasToken = Boolean(secrets.granola_api_token);
      const granolaApiCheck: CheckResult = {
        label: "Granola API token",
        passed: hasToken,
        detail: "N/A (API mode — MCP check skipped)",
        fix: hasToken ? undefined : "Run /draft:connect granola in Claude Code",
      };
      printCheck(granolaApiCheck);
    } else {
      console.log(`  ${dim("◯")}  Granola       ${dim("not configured")}`);
    }

    // Slack
    const hasSlack = Boolean(secrets.slack_bot_token) && Boolean(secrets.slack_app_token);
    if (hasSlack) {
      // Check if capture process is running
      const pidFile = `${BACKGROUND_DIR}/integrations/slack/capture.pid`;
      let slackRunning = false;
      if (existsSync(pidFile)) {
        try {
          const pid = readFileSync(pidFile, "utf8").trim();
          const pidCheck = await capture(["kill", "-0", pid]);
          slackRunning = pidCheck.exitCode === 0;
        } catch {
          slackRunning = false;
        }
      }
      const slackCheck: CheckResult = {
        label: "Slack capture running",
        passed: slackRunning,
        fix: slackRunning ? undefined : (
          daemonRunning.passed
            ? "Slack tokens may be invalid — reconnect: run /draft:connect slack in Claude Code"
            : "Run: draft start (daemon manages Slack capture)"
        ),
      };
      printCheck(slackCheck);
    } else {
      console.log(`  ${dim("◯")}  Slack         ${dim("not configured")}`);
    }
  }

  // ── Group 5: Installed tools ───────────────────────────────────────────────
  console.log(`\n${bold("Installed tools")}`);

  // Auto-migrate: if config.json is missing, detect tools by filesystem markers.
  const HOME = process.env.HOME!;
  const CODEX_HOME = process.env.CODEX_HOME ?? `${HOME}/.codex`;
  const CURSOR_HOME = process.env.CURSOR_HOME ?? `${HOME}/.cursor`;

  const configResult = readDraftConfig();
  let config = configResult.ok ? configResult.config : null;

  if (!config) {
    // First doctor run after this version ships — write config.json from heuristics.
    const migrated: { [key: string]: { added_at: string } } = {};
    const agentsDir = `${HOME}/.claude/agents`;
    if (existsSync(agentsDir)) {
      try {
        const { readdirSync } = await import("fs");
        const entries = readdirSync(agentsDir) as string[];
        if (entries.some((f: string) => /^draft/.test(f))) {
          migrated["claude-code"] = { added_at: "migrated" };
        }
      } catch { /* ignore */ }
    }
    if (existsSync(`${CODEX_HOME}/hooks/draft/inject-context.sh`)) {
      migrated["codex"] = { added_at: "migrated" };
    }
    if (existsSync(`${CURSOR_HOME}/hooks/draft/cursor-session-start.sh`)) {
      migrated["cursor"] = { added_at: "migrated" };
    }
    if (Object.keys(migrated).length > 0) {
      const newConfig = { version: "1", tools: migrated as any };
      writeDraftConfig(newConfig);
      config = newConfig;
      console.log(dim(`  Auto-detected existing installs — wrote ~/.draft/config.json`));
    }
  }

  const TOOL_MARKERS: Record<string, string[]> = {
    "claude-code": [`${HOME}/.claude/agents`, `${HOME}/.claude/skills`],
    "codex":       [`${CODEX_HOME}/hooks/draft/inject-context.sh`],
    "cursor":      [`${CURSOR_HOME}/hooks/draft/cursor-session-start.sh`],
  };

  const tools = config ? Object.keys(config.tools ?? {}) : [];

  if (tools.length === 0) {
    console.log(dim("  No tools registered. Run `draft add <tool>` to install."));
  } else {
    for (const tool of tools) {
      const markers = TOOL_MARKERS[tool] ?? [];
      const allMarkersMissing = markers.length > 0 && !markers.some(existsSync);
      const toolCheck: CheckResult = {
        label: tool,
        passed: !allMarkersMissing,
        detail: allMarkersMissing ? "registered but marker files missing" : undefined,
        fix: allMarkersMissing ? `Run: draft add ${tool}` : undefined,
      };
      printCheck(toolCheck);
      if (!toolCheck.passed) allPassed = false;
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("");
  console.log(dim("─".repeat(40)));
  if (allPassed) {
    console.log(green("Everything looks good."));
  } else {
    console.log(yellow("Some checks failed. Fix the issues above and run `draft doctor` again."));
  }
  console.log("");
}

// ── Check helpers ──────────────────────────────────────────────────────────────

async function checkCommand(label: string, cmd: string[]): Promise<CheckResult> {
  const result = await capture(cmd, { timeoutMs: 5_000 });
  return {
    label,
    passed: result.exitCode === 0,
    detail: result.exitCode === 0 ? result.stdout.split("\n")[0] : undefined,
  };
}

function checkFile(label: string, filePath: string): CheckResult {
  return { label, passed: existsSync(filePath) };
}

function checkDir(label: string, dirPath: string): CheckResult {
  return { label, passed: existsSync(dirPath) };
}

async function checkLaunchctl(label: string, serviceLabel: string): Promise<CheckResult> {
  const result = await capture(["launchctl", "list", serviceLabel], { timeoutMs: 5_000 });
  return { label, passed: result.exitCode === 0 };
}

function printCheck(check: CheckResult): void {
  const icon = check.passed ? green("✓") : red("✗");
  const detail = check.detail ? dim(`  ${check.detail}`) : "";
  console.log(`  ${icon}  ${check.label.padEnd(30)}${detail}`);
  if (!check.passed && check.fix) {
    console.log(`     ${dim("→")} ${cyan(check.fix)}`);
  }
}

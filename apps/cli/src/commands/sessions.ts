// commands/sessions.ts — draft sessions enable|rotate|disable|status|ingest|list|read|search
// `ingest` is hook-only: installed as the project's Claude Code SessionEnd hook.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "fs";
import { randomUUID } from "crypto";
import { dirname, isAbsolute, join, resolve } from "path";
import {
  adminRevokeSessionIngestToken,
  connectIntegration,
  fetchSessionRead,
  fetchSessions,
  fetchSessionsSearch,
  mintSessionIngestToken,
  requireAccessToken,
  revokeSessionIngestTokenWithGrace,
  rotateSessionIngestToken,
} from "../cloud-client.ts";
import { getCliRuntimeConfig } from "../runtime-config.ts";
import { EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine } from "../utils/json-output.ts";
import { bold, cyan, dim, red } from "../utils/output.ts";
import {
  CAPTURE_CONFIG_FILE,
  CAPTURE_SCRIPT_VERSION,
  DRAFT_DIR,
  HOOK_SCRIPT_FILE,
  buildCaptureScript,
  hasSessionEndHook,
  mergeSessionEndHook,
  removeSessionEndHook,
  resolveDraftBinaryPath,
} from "draft-core/sessions";
import { mutateClaudeSettingsAtomic, readClaudeSettings, writeCaptureConfigAtomic } from "draft-core/sync/claude-settings";

const SUPPORTED_AGENTS = ["claude-code", "codex", "cursor", "openclaw", "hermes"] as const;
type Agent = (typeof SUPPORTED_AGENTS)[number];

const SETTINGS_FILE = ".claude/settings.json";
const INGEST_TOKEN_PREFIX = "draft_sit_";

interface SessionCaptureConfig {
  backendUrl: string;
  workspaceId: string;
  ingestToken: string;
  projectId: string;
  projectKey: string;
  allowedProviders: string[];
  credentialScope: string;
}

// A legacy (pre project-scoping) config only has these three fields.
type LegacyOrScopedConfig = Partial<SessionCaptureConfig> & { backendUrl?: string; workspaceId?: string; ingestToken?: string };

function isScopedConfig(config: LegacyOrScopedConfig): config is SessionCaptureConfig {
  if (!(config.backendUrl && config.workspaceId && config.ingestToken && config.projectId && config.projectKey)) return false;
  if ([config.backendUrl, config.workspaceId, config.ingestToken, config.projectId, config.projectKey].some((value) => value.includes("${"))) return false;
  try {
    const url = new URL(config.backendUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  } catch { return false; }
  return config.ingestToken.startsWith(INGEST_TOKEN_PREFIX) &&
    Array.isArray(config.allowedProviders) && config.allowedProviders.includes("claude-code-session");
}

function isAgent(value: string): value is Agent {
  return (SUPPORTED_AGENTS as readonly string[]).includes(value);
}

function fetchErrorPayload(code: string) {
  if (code === "not_authenticated") return errorPayload(code, "Not signed in.", "draft auth login");
  if (code === "no_workspace") return errorPayload(code, "No workspace yet — finish onboarding in the Draft app.");
  if (code === "invalid_ingest_token") return errorPayload(code, "This project's ingest token is no longer valid — run `draft sessions enable claude-code` again.");
  return errorPayload(code, "Could not reach the Draft backend right now. Retry shortly.");
}

function printFetchError(command: string, code: string, json: boolean): void {
  const payload = fetchErrorPayload(code);
  if (json) { printJsonLine(payload); return; }
  console.error(red(`${command}: ${payload.message}${payload.action ? ` Run \`${payload.action}\`.` : ""}`));
}

// ── shared path/config helpers ──────────────────────────────────────────

function resolveDir(rawDir: string | undefined): string {
  if (!rawDir) return process.cwd();
  return isAbsolute(rawDir) ? rawDir : resolve(process.cwd(), rawDir);
}

function configPath(dir: string): string {
  return join(dir, DRAFT_DIR, CAPTURE_CONFIG_FILE);
}

function hookScriptPath(dir: string): string {
  return join(dir, DRAFT_DIR, HOOK_SCRIPT_FILE);
}

function settingsPath(dir: string): string {
  return join(dir, SETTINGS_FILE);
}

function basenameOf(dir: string): string {
  const parts = dir.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

function readLocalConfig(dir: string): LegacyOrScopedConfig | null {
  const path = configPath(dir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LegacyOrScopedConfig;
  } catch {
    return null;
  }
}

function commitReminderLines(dir: string): string[] {
  return [
    "Review the diff and commit these files — Draft never commits on your behalf:",
    `  git -C ${dir} status`,
    `  git -C ${dir} add ${DRAFT_DIR} .claude/settings.json`,
    `  git -C ${dir} commit -m "Enable Draft session capture"`,
    "",
    dim(
      "Until this is committed and pushed, only sessions in this working copy are captured — every " +
        "other clone/pull gets no hook, no config, and no error; their sessions are silently never captured.",
    ),
  ];
}

// ── enable ───────────────────────────────────────────────────────────────

interface ParsedEnableArgs {
  agent?: Agent;
  dir?: string;
  json: boolean;
  error?: string;
}

function parseEnableArgs(args: string[]): ParsedEnableArgs {
  let dir: string | undefined;
  let json = false;
  let agent: Agent | undefined;
  let agentSeen = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") { json = true; continue; }
    if (arg === "--dir") {
      const value = args[++i];
      if (value === undefined) return { json, error: "--dir requires a value" };
      dir = value;
      continue;
    }
    if (arg.startsWith("--dir=")) { dir = arg.slice("--dir=".length); continue; }
    if (arg.startsWith("--")) return { dir, json, error: `unknown flag: ${arg}` };
    if (agentSeen) return { dir, json, error: `unexpected argument: ${arg}` };
    agentSeen = true;
    if (!isAgent(arg)) return { dir, json, error: `unknown agent: ${arg} (expected one of ${SUPPORTED_AGENTS.join(", ")})` };
    agent = arg;
  }

  if (!agent) return { dir, json, error: `missing agent — expected one of ${SUPPORTED_AGENTS.join(", ")}` };
  return { agent, dir, json };
}

// Writes config.json + the hook script + merges the SessionEnd hook. When
// `mintedCredentialId` is set, any failure here (ordinary exception or a
// malformed settings.json) revokes that just-minted credential — an
// unused ingest-only credential is low severity, but we don't leave one
// active if setup never completed.
async function writeCaptureFiles(
  dir: string,
  config: SessionCaptureConfig,
  mintedCredentialId: string | null,
): Promise<{ ok: true; hookChanged: boolean } | { ok: false; reason: "malformed_settings" | "exception"; message: string }> {
  try {
    await writeCaptureConfigAtomic(configPath(dir), config);
    writeFileSync(hookScriptPath(dir), buildCaptureScript(), { mode: 0o755 });
    chmodSync(hookScriptPath(dir), 0o755);

    const result = await mutateClaudeSettingsAtomic(settingsPath(dir), mergeSessionEndHook);
    if (!result.ok) {
      if (mintedCredentialId) await adminRevokeSessionIngestToken(mintedCredentialId).catch(() => {});
      return { ok: false, reason: "malformed_settings", message: `${settingsPath(dir)} is not valid JSON — fix it by hand, then re-run enable. Left unchanged.` };
    }
    return { ok: true, hookChanged: result.changed };
  } catch (err) {
    if (mintedCredentialId) await adminRevokeSessionIngestToken(mintedCredentialId).catch(() => {});
    return { ok: false, reason: "exception", message: err instanceof Error ? err.message : String(err) };
  }
}

function printSessionsEnableHelp(): void {
  console.log("Turn on session capture for this project.");
  console.log("");
  console.log(
    "Mints a project-and-provider-scoped ingest credential, writes it to\n" +
      ".claude/draft/config.json, and installs a SessionEnd hook in\n" +
      ".claude/settings.json that uploads each finished session.",
  );
  console.log("");
  console.log(`Usage: ${cyan("draft sessions enable")} <TOOL> [OPTIONS]`);
  console.log("");
  console.log("Arguments:");
  console.log("  <TOOL>");
  console.log("          Agent tool to capture sessions for. Only claude-code has an");
  console.log("          install path today; other values are accepted by shared config");
  console.log("          but not yet wired up.");
  console.log("");
  console.log(`          [possible values: ${SUPPORTED_AGENTS.join(", ")}]`);
  console.log("");
  console.log("Options:");
  console.log("      --dir <PATH>");
  console.log("          Project directory to configure [default: current directory]");
  console.log("");
  console.log("      --json");
  console.log("          Machine-readable output");
  console.log("");
  console.log("  -h, --help");
  console.log("          Print help");
  console.log("");
  console.log(bold("About the credential:"));
  console.log(
    "  The minted credential is ingest-only — it can submit sessions but cannot\n" +
      "  read, list, or search them. It's written to a file meant to be committed\n" +
      "  to git (.claude/draft/config.json), so anyone with repo access can use it\n" +
      "  to submit sessions for this project; that's expected, not a leak. It\n" +
      "  cannot act outside this one project and this one tool.",
  );
  console.log("");
  console.log(
    "  Until you commit and push .claude/draft/ and .claude/settings.json,\n" +
      "  capture only works in this working copy — every other clone silently\n" +
      "  gets no capture.",
  );
  console.log("");
  console.log(
    `  Use ${cyan("draft sessions rotate")} to replace the credential (old one keeps\n` +
      `  working for a short grace window), or ${cyan("draft sessions disable")} to\n` +
      "  revoke it.",
  );
}

function printSessionsHelp(): void {
  console.log("Capture, list, and search coding-agent sessions.");
  console.log("");
  console.log(`Usage: ${cyan("draft sessions")} <COMMAND> [ARGS]`);
  console.log("");
  console.log("Commands:");
  const cmds: [string, string][] = [
    ["enable <tool> [--dir <path>] [--json]", "Turn on session capture for this project (claude-code only today)"],
    ["rotate [--dir <path>] [--json]", "Replace this project's ingest credential (short grace window)"],
    ["disable [--dir <path>] [--json]", "Turn off capture and revoke this project's credential (grace window, not instant)"],
    ["status [--dir <path>] [--json]", "Show this project's session-capture health"],
    ["list [--provider <p>] [--user <email>] [--since <ISO>]", "List captured sessions"],
    ["read <id> [--summary|--transcript]", "Print one session's summary or transcript"],
    ["search \"<pattern>\"", "Search session summaries by keyword"],
  ];
  for (const [cmd, desc] of cmds) {
    console.log(`  ${cyan(cmd.padEnd(56))}${desc}`);
  }
  console.log("");
  console.log(`Run ${cyan("draft sessions enable --help")} for details on the credential enable mints.`);
}

export async function runSessionsEnable(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    printSessionsEnableHelp();
    return EXIT_SUCCESS;
  }
  const parsed = parseEnableArgs(args);
  if (parsed.error) {
    if (parsed.json) printJsonLine(errorPayload("invalid_usage", parsed.error));
    else {
      console.error(red(`draft sessions enable: ${parsed.error}`));
      console.error(`Usage: draft sessions enable <${SUPPORTED_AGENTS.join("|")}> [--dir <path>] [--json]`);
    }
    return EXIT_USAGE_ERROR;
  }
  const { agent, json } = parsed;

  if (agent !== "claude-code") {
    const message = `${agent} session capture is not yet supported — only claude-code has an install path today.`;
    if (json) printJsonLine(errorPayload("unsupported_agent", message));
    else console.error(red(`draft sessions enable: ${message}`));
    return EXIT_OPERATIONAL_ERROR;
  }

  const dir = resolveDir(parsed.dir);
  if (!existsSync(dir)) {
    const message = `directory not found: ${dir}`;
    if (json) printJsonLine(errorPayload("directory_not_found", message));
    else console.error(red(`draft sessions enable: ${message}`));
    return EXIT_OPERATIONAL_ERROR;
  }

  // Validate settings.json before minting anything — a malformed file
  // means we refuse up front rather than orphaning a freshly minted
  // credential.
  const settingsCheck = readClaudeSettings(settingsPath(dir));
  if (!settingsCheck.ok) {
    const message = `${settingsPath(dir)} is not valid JSON — fix it by hand, then re-run enable. Left unchanged.`;
    if (json) printJsonLine(errorPayload("malformed_settings", message));
    else console.error(red(`draft sessions enable: ${message}`));
    return EXIT_OPERATIONAL_ERROR;
  }

  const existing = readLocalConfig(dir);

  const connected = await connectIntegration({ provider: "claude_session" });
  if (!connected.ok) {
    printFetchError("draft sessions enable", connected.code, json);
    return EXIT_OPERATIONAL_ERROR;
  }

  let config: SessionCaptureConfig;
  let mintedCredentialId: string | null = null;
  if (existing && isScopedConfig(existing)) {
    // Idempotent: a valid scoped credential already exists for this project.
    config = existing;
  } else {
    const projectKey = randomUUID();
    const minted = await mintSessionIngestToken({ label: basenameOf(dir), projectKey, allowedProviders: ["claude-code-session"] });
    if (!minted.ok) {
      printFetchError("draft sessions enable", minted.code, json);
      return EXIT_OPERATIONAL_ERROR;
    }
    mintedCredentialId = minted.value.id;
    config = {
      backendUrl: getCliRuntimeConfig().apiBaseUrl,
      workspaceId: minted.value.workspaceId,
      ingestToken: minted.value.token,
      projectId: minted.value.sessionProjectId,
      projectKey,
      allowedProviders: ["claude-code-session"],
      credentialScope: minted.value.credentialScope,
    };
  }

  // Runs unconditionally so a repeated `enable` also repairs a hook the
  // user deleted, even when the credential itself was already valid.
  mkdirSync(dirname(configPath(dir)), { recursive: true });
  const written = await writeCaptureFiles(dir, config, mintedCredentialId);
  if (!written.ok) {
    if (json) printJsonLine(errorPayload(written.reason, written.message));
    else console.error(red(`draft sessions enable: ${written.message}`));
    return EXIT_OPERATIONAL_ERROR;
  }
  const hookChanged = written.hookChanged;

  if (json) {
    printJsonLine({
      status: "ok",
      dir,
      configPath: configPath(dir),
      hookChanged,
      credentialScope: config.credentialScope,
      commitRequired: true,
      uncommittedConsequence:
        "Only sessions in this working copy are captured until config and hook are committed and pushed; other clones silently get no capture.",
    });
    return EXIT_SUCCESS;
  }

  console.log(`${dim("✓")} Wrote ${configPath(dir)}`);
  console.log(`${dim("✓")} Wrote ${hookScriptPath(dir)}`);
  console.log(`${dim("✓")} ${hookChanged ? "Added" : "Already had"} the SessionEnd hook in ${settingsPath(dir)}`);
  console.log("");
  console.log(`${config.credentialScope} — anyone with access to this repo can use it to submit sessions (it cannot read them).`);
  console.log("");
  for (const line of commitReminderLines(dir)) console.log(line);
  return EXIT_SUCCESS;
}

// ── rotate ───────────────────────────────────────────────────────────────

export async function runSessionsRotate(args: string[]): Promise<number> {
  const json = args.includes("--json");
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir") dir = args[++i];
    else if (args[i]?.startsWith("--dir=")) dir = args[i]!.slice("--dir=".length);
    else if (args[i] !== "--json") {
      const message = `unknown argument: ${args[i]}`;
      if (json) printJsonLine(errorPayload("invalid_usage", message));
      else console.error(red(`draft sessions rotate: ${message}`));
      return EXIT_USAGE_ERROR;
    }
  }

  const resolvedDir = resolveDir(dir);
  const existing = readLocalConfig(resolvedDir);
  if (!existing || !isScopedConfig(existing)) {
    const message = `no project ingest credential found at ${configPath(resolvedDir)} — run \`draft sessions enable claude-code\` first.`;
    if (json) printJsonLine(errorPayload("not_enabled", message));
    else console.error(red(`draft sessions rotate: ${message}`));
    return EXIT_OPERATIONAL_ERROR;
  }

  const rotated = await rotateSessionIngestToken(existing.ingestToken);
  if (!rotated.ok) {
    printFetchError("draft sessions rotate", rotated.code, json);
    return EXIT_OPERATIONAL_ERROR;
  }

  const nextConfig: SessionCaptureConfig = { ...existing, ingestToken: rotated.value.token };
  try {
    await writeCaptureConfigAtomic(configPath(resolvedDir), nextConfig);
  } catch (err) {
    await adminRevokeSessionIngestToken(rotated.value.id).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    if (json) printJsonLine(errorPayload("setup_failed", message));
    else console.error(red(`draft sessions rotate: ${message}`));
    return EXIT_OPERATIONAL_ERROR;
  }

  if (json) {
    printJsonLine({ status: "ok", dir: resolvedDir, configPath: configPath(resolvedDir), commitRequired: true });
    return EXIT_SUCCESS;
  }
  console.log(`${dim("✓")} Rotated the ingest credential and wrote ${configPath(resolvedDir)}`);
  console.log(dim("The old credential keeps working for a short grace window, then stops."));
  console.log("");
  for (const line of commitReminderLines(resolvedDir)) console.log(line);
  return EXIT_SUCCESS;
}

// ── disable ──────────────────────────────────────────────────────────────

export async function runSessionsDisable(args: string[]): Promise<number> {
  const json = args.includes("--json");
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir") dir = args[++i];
    else if (args[i]?.startsWith("--dir=")) dir = args[i]!.slice("--dir=".length);
    else if (args[i] !== "--json") {
      const message = `unknown argument: ${args[i]}`;
      if (json) printJsonLine(errorPayload("invalid_usage", message));
      else console.error(red(`draft sessions disable: ${message}`));
      return EXIT_USAGE_ERROR;
    }
  }

  const resolvedDir = resolveDir(dir);
  const existing = readLocalConfig(resolvedDir);

  let revoked = false;
  if (existing?.ingestToken) {
    const result = await revokeSessionIngestTokenWithGrace(existing.ingestToken);
    revoked = result.ok;
  }

  const settingsResult = await mutateClaudeSettingsAtomic(settingsPath(resolvedDir), removeSessionEndHook);
  if (!settingsResult.ok) {
    const message = `${settingsPath(resolvedDir)} is not valid JSON — fix it by hand. The hook was left in place; the credential was still revoked.`;
    if (json) printJsonLine(errorPayload("malformed_settings", message));
    else console.error(red(`draft sessions disable: ${message}`));
    return EXIT_OPERATIONAL_ERROR;
  }

  const configExisted = existsSync(configPath(resolvedDir));
  if (configExisted) writeFileSync(configPath(resolvedDir), "{}\n");

  if (json) {
    printJsonLine({ status: "ok", dir: resolvedDir, hookRemoved: settingsResult.changed, configExisted, revoked });
    return EXIT_SUCCESS;
  }
  console.log(`${dim("✓")} ${settingsResult.changed ? "Removed" : "No"} SessionEnd hook in ${settingsPath(resolvedDir)}`);
  console.log(
    revoked
      ? dim("The ingest credential will stop working after a short grace window.")
      : dim("No active local credential to revoke."),
  );
  return EXIT_SUCCESS;
}

// ── status ───────────────────────────────────────────────────────────────

function isExecutable(path: string): boolean {
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function readInstalledScriptVersion(dir: string): number | null {
  try {
    const match = readFileSync(hookScriptPath(dir), "utf8").match(/^# draft-capture-script-version: (\d+)$/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export async function runSessionsStatus(args: string[]): Promise<number> {
  const json = args.includes("--json");
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir") dir = args[++i];
    else if (args[i]?.startsWith("--dir=")) dir = args[i]!.slice("--dir=".length);
  }

  const resolvedDir = resolveDir(dir);
  const settingsResult = readClaudeSettings(settingsPath(resolvedDir));
  const hookInstalled = settingsResult.ok && hasSessionEndHook(settingsResult.settings);
  const settingsMalformed = !settingsResult.ok;

  const rawConfig = readLocalConfig(resolvedDir);
  const configExists = existsSync(configPath(resolvedDir));
  const configValid = !!rawConfig && !!rawConfig.backendUrl && !!rawConfig.workspaceId && !!rawConfig.ingestToken;
  const projectScoped = !!rawConfig && isScopedConfig(rawConfig);
  const credentialFormatValid = !!rawConfig?.ingestToken?.startsWith(INGEST_TOKEN_PREFIX);
  const draftBinaryPath = resolveDraftBinaryPath(process.env, isExecutable);
  const lastEvent = readLastIngestEvent(resolvedDir);
  const scriptVersion = readInstalledScriptVersion(resolvedDir);
  const scriptCurrent = scriptVersion === CAPTURE_SCRIPT_VERSION;

  if (json) {
    printJsonLine({
      dir: resolvedDir,
      hookInstalled,
      settingsMalformed,
      configExists,
      configValid,
      projectScoped,
      projectId: projectScoped ? (rawConfig as SessionCaptureConfig).projectId : null,
      credentialFormatValid,
      draftBinaryPath,
      captureScriptVersion: scriptVersion,
      captureScriptCurrent: scriptCurrent,
      lastIngestAttempt: lastEvent,
    });
    return EXIT_SUCCESS;
  }

  console.log(`dir: ${resolvedDir}`);
  console.log(`SessionEnd hook: ${hookInstalled ? "installed" : "not installed"}${settingsMalformed ? " (settings.json is malformed — can't tell)" : ""}`);
  console.log(`config: ${configExists ? (configValid ? "present, valid" : "present, invalid") : "missing"}`);
  console.log(`project scope: ${projectScoped ? "project-scoped" : configExists ? "legacy (workspace-scoped)" : "n/a"}`);
  console.log(`credential shape: ${credentialFormatValid ? "looks valid" : "missing or malformed"}`);
  console.log(`draft binary: ${draftBinaryPath ?? "not found on any resolved path"}`);
  console.log(
    `capture script: ${
      scriptCurrent
        ? `v${scriptVersion} (current)`
        : `${scriptVersion === null ? "unversioned or missing" : `v${scriptVersion}`} (outdated) — run \`draft sessions enable claude-code\` to update it`
    }`,
  );
  console.log(`last ingest attempt: ${lastEvent ? `${lastEvent.status} at ${lastEvent.ts}${lastEvent.detail ? ` (${lastEvent.detail})` : ""}` : "none recorded"}`);
  return EXIT_SUCCESS;
}

// ── ingest (hook-only) ──────────────────────────────────────────────────

function findConfigUpward(startDir: string): { path: string; dir: string; config: SessionCaptureConfig | LegacyOrScopedConfig } | null {
  let dir = startDir;
  for (;;) {
    const candidate = configPath(dir);
    if (existsSync(candidate)) {
      try {
        const config = JSON.parse(readFileSync(candidate, "utf8")) as LegacyOrScopedConfig;
        if (config.backendUrl && config.workspaceId && config.ingestToken) return { path: candidate, dir, config };
      } catch {
        // fall through — try CLAUDE_PROJECT_DIR below
      }
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

interface IngestLogEntry {
  ts: string;
  status: "success" | "failure" | "skipped";
  dir: string;
  sessionId?: string;
  detail?: string;
}

function ingestLogPath(): string {
  return join(process.env.HOME ?? "/tmp", ".draft", "log", "sessions-ingest.log");
}

function logIngestEvent(entry: Omit<IngestLogEntry, "ts">): void {
  try {
    const logDir = dirname(ingestLogPath());
    mkdirSync(logDir, { recursive: true });
    writeFileSync(ingestLogPath(), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { flag: "a" });
  } catch {
    // best-effort logging only
  }
}

function readLastIngestEvent(dir: string): IngestLogEntry | null {
  try {
    if (!existsSync(ingestLogPath())) return null;
    const lines = readFileSync(ingestLogPath(), "utf8").trim().split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]!) as IngestLogEntry;
        if (entry.dir === dir) return entry;
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function gitConfigValue(cwd: string, key: string): string | null {
  try {
    const result = Bun.spawnSync(["git", "-C", cwd, "config", "--get", key]);
    if (result.exitCode !== 0) return null;
    const value = result.stdout.toString("utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

const UPLOAD_TIMEOUT_MS = 20_000;
const REPORT_TIMEOUT_MS = 5_000;
const USER_TOKEN_TIMEOUT_MS = 5_000;
const DEFAULT_REPORT_BACKEND = "https://api.draftai.us";

// Resolves null on timeout. Clears its timer so a settled call can't hold the process open.
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function hasPlaceholder(config: LegacyOrScopedConfig): boolean {
  return [config.backendUrl, config.workspaceId, config.ingestToken, config.projectId, config.projectKey].some(
    (value) => typeof value === "string" && value.includes("${"),
  );
}

// Best-effort and time-capped: lands in the backend's errors table, never throws.
async function reportCaptureFailure(config: LegacyOrScopedConfig, code: string, reason: string, hookReason?: string): Promise<void> {
  try {
    const usable = !!config.backendUrl && /^https?:\/\//.test(config.backendUrl) && !config.backendUrl.includes("${");
    const base = usable ? config.backendUrl!.replace(/\/+$/, "") : DEFAULT_REPORT_BACKEND;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.ingestToken?.startsWith(INGEST_TOKEN_PREFIX)) headers.Authorization = `Bearer ${config.ingestToken}`;
    await fetch(`${base}/sessions/ingest-errors`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      body: JSON.stringify({
        code,
        reason: reason.slice(0, 200),
        scriptVersion: "cli",
        os: process.platform,
        hookReason,
        workspaceId: config.workspaceId,
      }),
    });
  } catch {
    // reporting must never affect the hook
  }
}

/** Hook-only. Never blocks Claude Code: always exits 0, logging failures instead of surfacing them. */
export async function runSessionsIngest(): Promise<number> {
  let hookInput: { session_id?: string; transcript_path?: string; cwd?: string; reason?: string };
  try {
    const raw = await new Response(Bun.stdin.stream()).text();
    hookInput = JSON.parse(raw);
  } catch {
    logIngestEvent({ status: "skipped", dir: process.cwd(), detail: "malformed-hook-input" });
    return EXIT_SUCCESS;
  }

  const cwd = hookInput.cwd ?? process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? cwd;
  const resolved = findConfigUpward(projectDir) ?? findConfigUpward(cwd);
  if (!resolved) {
    logIngestEvent({ status: "skipped", dir: projectDir, detail: "missing-project-config" });
    return EXIT_SUCCESS;
  }

  if (hasPlaceholder(resolved.config)) {
    logIngestEvent({ status: "skipped", dir: resolved.dir, sessionId: hookInput.session_id, detail: "placeholder-config" });
    await reportCaptureFailure(resolved.config, "placeholder-config", "config.json holds a placeholder value", hookInput.reason);
    return EXIT_SUCCESS;
  }

  if (!hookInput.session_id || !hookInput.transcript_path || !existsSync(hookInput.transcript_path)) {
    logIngestEvent({ status: "skipped", dir: resolved.dir, sessionId: hookInput.session_id, detail: "missing-transcript" });
    await reportCaptureFailure(resolved.config, "missing-transcript", "hook input had no readable transcript", hookInput.reason);
    return EXIT_SUCCESS;
  }

  const gitEmail = gitConfigValue(cwd, "user.email");
  if (!gitEmail) {
    logIngestEvent({ status: "skipped", dir: resolved.dir, sessionId: hookInput.session_id, detail: "missing-git-email" });
    await reportCaptureFailure(resolved.config, "missing-git-email", "git user.email is not set", hookInput.reason);
    return EXIT_SUCCESS;
  }
  const displayName = gitConfigValue(cwd, "user.name");

  let transcript: string;
  try {
    transcript = readFileSync(hookInput.transcript_path, "utf8");
  } catch {
    logIngestEvent({ status: "skipped", dir: resolved.dir, sessionId: hookInput.session_id, detail: "unreadable-transcript" });
    return EXIT_SUCCESS;
  }

  const query = new URLSearchParams({
    sessionId: hookInput.session_id,
    gitEmail,
    displayName: displayName ?? "",
    cwd,
    status: hookInput.reason ?? "unknown",
    source: "claude-code-session",
  });

  const headers: Record<string, string> = { Authorization: `Bearer ${resolved.config.ingestToken}` };
  // Linking the session to a signed-in user is optional: any failure or slow
  // refresh falls back to the git-email contributor.
  try {
    const tokenResult = await withTimeout(requireAccessToken(), USER_TOKEN_TIMEOUT_MS);
    if (tokenResult?.ok) headers["X-Draft-User-Token"] = tokenResult.token;
  } catch {
    // no user token
  }

  try {
    const response = await fetch(`${resolved.config.backendUrl}/sessions/ingest?${query.toString()}`, {
      method: "POST",
      headers,
      body: transcript,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (response.ok) {
      logIngestEvent({ status: "success", dir: resolved.dir, sessionId: hookInput.session_id });
      return EXIT_SUCCESS;
    }
    const body = await response.text().catch(() => "");
    if (response.status === 403 && body.includes("session_tracking_disabled")) {
      logIngestEvent({ status: "skipped", dir: resolved.dir, sessionId: hookInput.session_id, detail: "session_tracking_disabled" });
      return EXIT_SUCCESS;
    }
    logIngestEvent({ status: "failure", dir: resolved.dir, sessionId: hookInput.session_id, detail: `status=${response.status}` });
    await reportCaptureFailure(resolved.config, `http-${response.status}`, body, hookInput.reason);
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    const message = err instanceof Error ? err.message : String(err);
    logIngestEvent({ status: "failure", dir: resolved.dir, sessionId: hookInput.session_id, detail: message });
    await reportCaptureFailure(resolved.config, timedOut ? "upload-timeout" : "upload-failed", message, hookInput.reason);
  }
  return EXIT_SUCCESS;
}

// ── list ─────────────────────────────────────────────────────────────────

export async function runSessionsList(args: string[]): Promise<number> {
  const json = args.includes("--json");
  let provider: string | undefined;
  let user: string | undefined;
  let since: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") continue;
    if (arg === "--provider") { provider = args[++i]; continue; }
    if (arg === "--user") { user = args[++i]; continue; }
    if (arg === "--since") { since = args[++i]; continue; }
    if (arg?.startsWith("--")) {
      const message = `unknown flag: ${arg}`;
      if (json) printJsonLine(errorPayload("invalid_usage", message));
      else console.error(red(`draft sessions list: ${message}`));
      return EXIT_USAGE_ERROR;
    }
  }

  const result = await fetchSessions({ provider, user, since });
  if (!result.ok) {
    printFetchError("draft sessions list", result.code, json);
    return EXIT_OPERATIONAL_ERROR;
  }

  if (json) {
    printJsonLine({ sessions: result.value });
    return EXIT_SUCCESS;
  }

  if (result.value.length === 0) {
    console.log("No sessions found.");
    return EXIT_SUCCESS;
  }
  for (const session of result.value) {
    const who = session.verified ? session.display ?? "verified" : `${session.display ?? "unknown"} (unverified)`;
    console.log(`${session.id}  ${session.started_at}  ${session.provider}  ${who}  ${session.project ?? "-"}  summary:${session.summary_status}`);
  }
  return EXIT_SUCCESS;
}

// ── read ─────────────────────────────────────────────────────────────────

export async function runSessionsRead(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const wantsTranscript = args.includes("--transcript");
  const wantsSummary = args.includes("--summary");

  let grep: string | undefined;
  let context: number | undefined;
  let maxBytes: number | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json" || arg === "--transcript" || arg === "--summary") continue;
    if (arg === "--grep") { grep = args[++i]; continue; }
    if (arg === "--context") { context = Number.parseInt(args[++i] ?? "", 10); continue; }
    if (arg === "--max-bytes") { maxBytes = Number.parseInt(args[++i] ?? "", 10); continue; }
    if (arg?.startsWith("--")) {
      const message = `unknown flag: ${arg}`;
      if (json) printJsonLine(errorPayload("invalid_usage", message));
      else console.error(red(`draft sessions read: ${message}`));
      return EXIT_USAGE_ERROR;
    }
    positional.push(arg!);
  }

  if (wantsTranscript && wantsSummary) {
    const message = "--summary and --transcript are mutually exclusive";
    if (json) printJsonLine(errorPayload("invalid_usage", message));
    else console.error(red(`draft sessions read: ${message}`));
    return EXIT_USAGE_ERROR;
  }
  if (positional.length !== 1) {
    const message = "expected exactly one session id";
    if (json) printJsonLine(errorPayload("invalid_usage", message));
    else console.error(red(`draft sessions read: ${message}`));
    return EXIT_USAGE_ERROR;
  }
  if (!wantsTranscript && (grep !== undefined || context !== undefined || maxBytes !== undefined)) {
    const message = "--grep, --context, and --max-bytes only apply with --transcript";
    if (json) printJsonLine(errorPayload("invalid_usage", message));
    else console.error(red(`draft sessions read: ${message}`));
    return EXIT_USAGE_ERROR;
  }
  if (context !== undefined && grep === undefined) {
    const message = "--context requires --grep";
    if (json) printJsonLine(errorPayload("invalid_usage", message));
    else console.error(red(`draft sessions read: ${message}`));
    return EXIT_USAGE_ERROR;
  }

  const mode = wantsTranscript ? "transcript" : "summary";
  const result = await fetchSessionRead(positional[0]!, mode, { grep, context, maxBytes });
  if (!result.ok) {
    printFetchError("draft sessions read", result.code, json);
    return EXIT_OPERATIONAL_ERROR;
  }

  if (json) {
    printJsonLine(result.value.kind === "transcript"
      ? { messages: result.value.messages, windows: result.value.windows, truncated_bytes: result.value.truncated_bytes }
      : { summary: result.value.summary, occurred_at: result.value.occurred_at });
    return EXIT_SUCCESS;
  }

  if (result.value.kind === "transcript") {
    for (const message of result.value.messages) console.log(`[${message.role}] ${message.content}`);
    if (result.value.truncated_bytes) console.log(dim(`(truncated ${result.value.truncated_bytes} bytes)`));
    return EXIT_SUCCESS;
  }
  console.log(result.value.summary ?? "(no summary yet)");
  return EXIT_SUCCESS;
}

// ── search ───────────────────────────────────────────────────────────────

export async function runSessionsSearch(args: string[]): Promise<number> {
  const json = args.includes("--json");
  let provider: string | undefined;
  let user: string | undefined;
  let since: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") continue;
    if (arg === "--provider") { provider = args[++i]; continue; }
    if (arg === "--user") { user = args[++i]; continue; }
    if (arg === "--since") { since = args[++i]; continue; }
    if (arg?.startsWith("--")) {
      const message = `unknown flag: ${arg}`;
      if (json) printJsonLine(errorPayload("invalid_usage", message));
      else console.error(red(`draft sessions search: ${message}`));
      return EXIT_USAGE_ERROR;
    }
    positional.push(arg!);
  }

  if (positional.length !== 1) {
    const message = "expected exactly one search pattern";
    if (json) printJsonLine(errorPayload("invalid_usage", message));
    else console.error(red(`draft sessions search: ${message}`));
    return EXIT_USAGE_ERROR;
  }

  const result = await fetchSessionsSearch({ q: positional[0]!, provider, user, since });
  if (!result.ok) {
    printFetchError("draft sessions search", result.code, json);
    return EXIT_OPERATIONAL_ERROR;
  }

  if (json) {
    printJsonLine({ sessions: result.value });
    return EXIT_SUCCESS;
  }

  if (result.value.length === 0) {
    console.log("No matching sessions found.");
    return EXIT_SUCCESS;
  }
  for (const session of result.value) {
    const who = session.verified ? session.display ?? "verified" : `${session.display ?? "unknown"} (unverified)`;
    console.log(`${session.session_id}  ${session.occurred_at}  ${session.provider ?? "-"}  ${who}`);
    console.log(`  ${session.snippet.replace(/\n/g, " ")}`);
  }
  return EXIT_SUCCESS;
}

// ── dispatch ─────────────────────────────────────────────────────────────

export async function runSessions(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "-h") {
    printSessionsHelp();
    return EXIT_SUCCESS;
  }
  switch (sub) {
    case "enable": return runSessionsEnable(rest);
    case "rotate": return runSessionsRotate(rest);
    case "disable": return runSessionsDisable(rest);
    case "status": return runSessionsStatus(rest);
    case "ingest": return runSessionsIngest();
    case "list": return runSessionsList(rest);
    case "read": return runSessionsRead(rest);
    case "search": return runSessionsSearch(rest);
    default:
      console.error(red(`draft sessions: unknown subcommand${sub ? ` "${sub}"` : ""}. Use enable, rotate, disable, status, list, read, or search.`));
      return EXIT_USAGE_ERROR;
  }
}

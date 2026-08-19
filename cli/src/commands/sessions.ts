// commands/sessions.ts — draft sessions enable|disable|status|ingest|list|read
//
// enable/disable/status/list/read are the documented surface. `ingest` is
// hook-only: installed as a project's Claude Code SessionEnd hook by
// `enable`, reads hook JSON from stdin, and never blocks Claude Code (always
// exits 0, logging failures to a local file instead).

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import {
  fetchSessionRead,
  fetchSessions,
  mintSessionIngestToken,
  requireAccessToken,
} from "../cloud-client.ts";
import { getCliRuntimeConfig } from "../runtime-config.ts";
import { EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine } from "../utils/json-output.ts";
import { dim, red } from "../utils/output.ts";

const SUPPORTED_AGENTS = ["claude-code", "codex", "cursor", "openclaw", "hermes"] as const;
type Agent = (typeof SUPPORTED_AGENTS)[number];

const DRAFT_DIR = ".claude/draft";
const CONFIG_FILE = "config.json";
const HOOK_SCRIPT = "capture-session.sh";
const SETTINGS_FILE = ".claude/settings.json";

interface SessionCaptureConfig {
  backendUrl: string;
  workspaceId: string;
  ingestToken: string;
}

function isAgent(value: string): value is Agent {
  return (SUPPORTED_AGENTS as readonly string[]).includes(value);
}

function fetchErrorPayload(code: string) {
  if (code === "not_authenticated") return errorPayload(code, "Not signed in.", "draft auth login");
  if (code === "no_workspace") return errorPayload(code, "No workspace yet — finish onboarding in the Draft app.");
  return errorPayload(code, "Could not reach the Draft backend right now. Retry shortly.");
}

function printFetchError(command: string, code: string, json: boolean): void {
  const payload = fetchErrorPayload(code);
  if (json) { printJsonLine(payload); return; }
  console.error(red(`${command}: ${payload.message}${payload.action ? ` Run \`${payload.action}\`.` : ""}`));
}

// ── enable/disable/status shared helpers ────────────────────────────────

const HOOK_COMMAND = `"\${CLAUDE_PROJECT_DIR}/${DRAFT_DIR}/${HOOK_SCRIPT}"`;

const CAPTURE_SCRIPT = `#!/usr/bin/env bash
# Installed by \`draft sessions enable\` — do not edit by hand, re-run enable instead.
# Claude Code SessionEnd hook: hands the raw hook JSON (on stdin) to
# \`draft sessions ingest\`, which resolves this project's config, reads the
# transcript off disk, and posts it to the Draft backend. Never blocks
# Claude Code: always exits 0, whatever happens upstream.
draft sessions ingest >/dev/null 2>&1
exit 0
`;

function resolveDir(rawDir: string | undefined): string {
  if (!rawDir) return process.cwd();
  return isAbsolute(rawDir) ? rawDir : resolve(process.cwd(), rawDir);
}

function configPath(dir: string): string {
  return join(dir, DRAFT_DIR, CONFIG_FILE);
}

function hookScriptPath(dir: string): string {
  return join(dir, DRAFT_DIR, HOOK_SCRIPT);
}

function settingsPath(dir: string): string {
  return join(dir, SETTINGS_FILE);
}

interface ClaudeSettings {
  hooks?: {
    SessionEnd?: Array<{ hooks: Array<{ type: string; command: string; timeout?: number }> }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ClaudeSettings;
  } catch {
    return {};
  }
}

function hasSessionEndHook(settings: ClaudeSettings): boolean {
  return (settings.hooks?.SessionEnd ?? []).some((entry) =>
    entry.hooks.some((h) => h.command === HOOK_COMMAND),
  );
}

/** Idempotent: returns false if settings.json already has the hook, matching add.ts's no-op convention. */
function mergeSessionEndHook(dir: string): boolean {
  const path = settingsPath(dir);
  const settings = readSettings(path);
  if (hasSessionEndHook(settings)) return false;

  settings.hooks ??= {};
  settings.hooks.SessionEnd ??= [];
  settings.hooks.SessionEnd.push({ hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 60 }] });

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

/** Idempotent: returns false if settings.json had no matching hook to remove. */
function removeSessionEndHook(dir: string): boolean {
  const path = settingsPath(dir);
  const settings = readSettings(path);
  if (!hasSessionEndHook(settings)) return false;

  settings.hooks!.SessionEnd = (settings.hooks!.SessionEnd ?? [])
    .map((entry) => ({ ...entry, hooks: entry.hooks.filter((h) => h.command !== HOOK_COMMAND) }))
    .filter((entry) => entry.hooks.length > 0);
  if (settings.hooks!.SessionEnd.length === 0) delete settings.hooks!.SessionEnd;

  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
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

export async function runSessionsEnable(args: string[]): Promise<number> {
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

  const minted = await mintSessionIngestToken(basenameOf(dir));
  if (!minted.ok) {
    printFetchError("draft sessions enable", minted.code, json);
    return EXIT_OPERATIONAL_ERROR;
  }

  const config: SessionCaptureConfig = {
    backendUrl: getCliRuntimeConfig().apiBaseUrl,
    workspaceId: minted.value.workspaceId,
    ingestToken: minted.value.token,
  };

  mkdirSync(dirname(configPath(dir)), { recursive: true });
  writeFileSync(configPath(dir), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(hookScriptPath(dir), CAPTURE_SCRIPT, { mode: 0o755 });
  chmodSync(hookScriptPath(dir), 0o755);
  const hookChanged = mergeSessionEndHook(dir);

  if (json) {
    printJsonLine({ status: "ok", dir, configPath: configPath(dir), hookChanged });
    return EXIT_SUCCESS;
  }

  console.log(`${dim("✓")} Wrote ${configPath(dir)}`);
  console.log(`${dim("✓")} Wrote ${hookScriptPath(dir)}`);
  console.log(`${dim("✓")} ${hookChanged ? "Added" : "Already had"} the SessionEnd hook in ${settingsPath(dir)}`);
  console.log("");
  console.log("Review the diff and commit these files — Draft never commits on your behalf:");
  console.log(`  git -C ${dir} status`);
  console.log(`  git -C ${dir} add ${DRAFT_DIR} .claude/settings.json`);
  console.log(`  git -C ${dir} commit -m "Enable Draft session capture"`);
  return EXIT_SUCCESS;
}

function basenameOf(dir: string): string {
  const parts = dir.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? dir;
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
  const hookRemoved = removeSessionEndHook(resolvedDir);
  const configExisted = existsSync(configPath(resolvedDir));
  if (configExisted) writeFileSync(configPath(resolvedDir), "{}\n");

  if (json) {
    printJsonLine({ status: "ok", dir: resolvedDir, hookRemoved, configExisted });
    return EXIT_SUCCESS;
  }
  console.log(`${dim("✓")} ${hookRemoved ? "Removed" : "No"} SessionEnd hook in ${settingsPath(resolvedDir)}`);
  console.log(dim("The ingest token stays active server-side — revoking it isn't wired up here yet."));
  return EXIT_SUCCESS;
}

// ── status ───────────────────────────────────────────────────────────────

export async function runSessionsStatus(args: string[]): Promise<number> {
  const json = args.includes("--json");
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir") dir = args[++i];
    else if (args[i]?.startsWith("--dir=")) dir = args[i]!.slice("--dir=".length);
  }

  const resolvedDir = resolveDir(dir);
  const configExists = existsSync(configPath(resolvedDir));
  const hookInstalled = hasSessionEndHook(readSettings(settingsPath(resolvedDir)));

  if (json) {
    printJsonLine({ dir: resolvedDir, configExists, hookInstalled });
    return EXIT_SUCCESS;
  }
  console.log(`dir: ${resolvedDir}`);
  console.log(`config: ${configExists ? "present" : "missing"}`);
  console.log(`SessionEnd hook: ${hookInstalled ? "installed" : "not installed"}`);
  return EXIT_SUCCESS;
}

// ── ingest (hook-only) ──────────────────────────────────────────────────

function findConfigUpward(startDir: string): { path: string; config: SessionCaptureConfig } | null {
  let dir = startDir;
  for (;;) {
    const candidate = configPath(dir);
    if (existsSync(candidate)) {
      try {
        const config = JSON.parse(readFileSync(candidate, "utf8")) as SessionCaptureConfig;
        if (config.backendUrl && config.workspaceId && config.ingestToken) return { path: candidate, config };
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

function logIngestFailure(reason: string): void {
  try {
    const logDir = join(process.env.HOME ?? "/tmp", ".draft", "log");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "sessions-ingest.log"), `${new Date().toISOString()} ${reason}\n`, { flag: "a" });
  } catch {
    // best-effort logging only
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

/** Hook-only. Never blocks Claude Code: always exits 0, logging failures instead of surfacing them. */
export async function runSessionsIngest(): Promise<number> {
  let hookInput: { session_id?: string; transcript_path?: string; cwd?: string; reason?: string };
  try {
    const raw = await new Response(Bun.stdin.stream()).text();
    hookInput = JSON.parse(raw);
  } catch {
    logIngestFailure("skipped malformed-hook-input");
    return EXIT_SUCCESS;
  }

  const cwd = hookInput.cwd ?? process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? cwd;
  const resolved = findConfigUpward(projectDir) ?? findConfigUpward(cwd);
  if (!resolved) {
    logIngestFailure("skipped missing-project-config");
    return EXIT_SUCCESS;
  }

  if (!hookInput.session_id || !hookInput.transcript_path || !existsSync(hookInput.transcript_path)) {
    logIngestFailure(`${hookInput.session_id ?? "unknown"} skipped missing-transcript`);
    return EXIT_SUCCESS;
  }

  const gitEmail = gitConfigValue(cwd, "user.email");
  if (!gitEmail) {
    logIngestFailure(`${hookInput.session_id} skipped missing-git-email`);
    return EXIT_SUCCESS;
  }
  const displayName = gitConfigValue(cwd, "user.name");

  let transcript: string;
  try {
    transcript = readFileSync(hookInput.transcript_path, "utf8");
  } catch {
    logIngestFailure(`${hookInput.session_id} skipped unreadable-transcript`);
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
  const tokenResult = await requireAccessToken();
  if (tokenResult.ok) headers["X-Draft-User-Token"] = tokenResult.token;

  try {
    const response = await fetch(`${resolved.config.backendUrl}/sessions/ingest?${query.toString()}`, {
      method: "POST",
      headers,
      body: transcript,
    });
    logIngestFailure(`${hookInput.session_id} ${response.ok ? "ok" : `failed status=${response.status}`}`);
  } catch (err) {
    logIngestFailure(`${hookInput.session_id} failed ${err instanceof Error ? err.message : String(err)}`);
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
  const positional = args.filter((a) => !a.startsWith("--"));

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

  const mode = wantsTranscript ? "transcript" : "summary";
  const result = await fetchSessionRead(positional[0]!, mode);
  if (!result.ok) {
    printFetchError("draft sessions read", result.code, json);
    return EXIT_OPERATIONAL_ERROR;
  }

  if (json) {
    printJsonLine(result.value.kind === "transcript" ? { messages: result.value.messages } : { summary: result.value.summary, occurred_at: result.value.occurred_at });
    return EXIT_SUCCESS;
  }

  if (result.value.kind === "transcript") {
    for (const message of result.value.messages) console.log(`[${message.role}] ${message.content}`);
    return EXIT_SUCCESS;
  }
  console.log(result.value.summary ?? "(no summary yet)");
  return EXIT_SUCCESS;
}

// ── dispatch ─────────────────────────────────────────────────────────────

export async function runSessions(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "enable": return runSessionsEnable(rest);
    case "disable": return runSessionsDisable(rest);
    case "status": return runSessionsStatus(rest);
    case "ingest": return runSessionsIngest();
    case "list": return runSessionsList(rest);
    case "read": return runSessionsRead(rest);
    default:
      console.error(red(`draft sessions: unknown subcommand${sub ? ` "${sub}"` : ""}. Use enable, disable, status, list, or read.`));
      return EXIT_USAGE_ERROR;
  }
}

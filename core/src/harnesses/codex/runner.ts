import { chownSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { RunnerManifest } from "../../run-manifest";
import type { RunnerSide } from "../types";

const AGENT_UID = 1000;
const AGENT_GID = 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CODEX_HOME = "/home/agent/.codex";
const CODEX_AUTH_FILE = `${CODEX_HOME}/auth.json`;
const CODEX_CONFIG_FILE = `${CODEX_HOME}/config.toml`;
const CODEX_WORK_DIR = "/home/agent/work";

/** Draft's tool server for a Codex run. The bearer token comes from the environment, never from this file. */
export function codexConfigToml(options: { mcpUrl: string | null; webSearch: boolean }): string {
  // A top-level key must come before any table.
  return [...(options.webSearch ? ['web_search = "live"'] : []), ...(options.mcpUrl ? [codexMcpConfigToml(options.mcpUrl)] : [])].join("\n");
}

export function codexMcpConfigToml(mcpUrl: string): string {
  return [
    "[mcp_servers.draft]",
    `url = ${JSON.stringify(mcpUrl)}`,
    'bearer_token_env_var = "DRAFT_RUN_TOKEN"',
    "required = true",
    'default_tools_approval_mode = "approve"',
    "",
  ].join("\n");
}

export function sanitizedCodexEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const allowed: Record<string, string> = {
    HOME: "/home/agent",
    USER: "agent",
    LOGNAME: "agent",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: env.LANG || "C.UTF-8",
    CODEX_HOME,
  };
  if (env.TZ) allowed.TZ = env.TZ;
  if (env.DRAFT_RUN_TOKEN) allowed.DRAFT_RUN_TOKEN = env.DRAFT_RUN_TOKEN;
  return allowed;
}

/** The ids of the `agent` user. The base image gives id 1000 to `node`, so `agent` is 1001. Null when it is not listed. */
export function parseAgentIds(passwd: string): { uid: number; gid: number } | null {
  const fields = passwd.split("\n").find((line) => line.startsWith("agent:"))?.split(":");
  const uid = Number(fields?.[2]);
  const gid = Number(fields?.[3]);
  return fields && Number.isInteger(uid) && Number.isInteger(gid) ? { uid, gid } : null;
}

/** Puts the workspace's login where Codex reads it, for the agent user alone. */
export function prepareCodexHome(authJson: string, mcpUrl: string | null = null, nativeTools: string[] | null = null): void {
  const { uid, gid } = parseAgentIds(readFileSync("/etc/passwd", "utf8")) ?? { uid: AGENT_UID, gid: AGENT_GID };
  mkdirSync(CODEX_HOME, { recursive: true, mode: 0o700 });
  chownSync(CODEX_HOME, uid, gid);
  writeFileSync(CODEX_AUTH_FILE, authJson, { mode: 0o600 });
  chownSync(CODEX_AUTH_FILE, uid, gid);
  const webSearch = nativeTools?.includes("web_search") ?? false;
  if (mcpUrl || webSearch) {
    writeFileSync(CODEX_CONFIG_FILE, codexConfigToml({ mcpUrl, webSearch }), { mode: 0o600 });
    chownSync(CODEX_CONFIG_FILE, uid, gid);
  }
  mkdirSync(CODEX_WORK_DIR, { recursive: true, mode: 0o700 });
  chownSync(CODEX_WORK_DIR, uid, gid);
}

/** The login file after the run. Codex rewrites it when it refreshes the login, and the backend keeps the new one. */
export function readCodexAuth(): string | undefined {
  try {
    const text = readFileSync(CODEX_AUTH_FILE, "utf8");
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Codex reads the prompt from stdin. It may write inside its work folder only, and keeps no session on disk. */
export function codexArgs(manifest: RunnerManifest): string[] {
  if (manifest.harness !== "codex") throw new Error("codexArgs needs a Codex manifest");
  return ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", ...(manifest.model ? ["-m", manifest.model] : []), "-"];
}

/** The end of a `codex exec --json` run: a finished turn is a result, a failed turn is an error result. */
export function parseCodexResultLine(raw: string): { is_error: boolean; subtype: string } | null {
  if (!raw.includes('"type":"turn.completed"') && !raw.includes('"type":"turn.failed"')) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return null;
    if (parsed.type === "turn.completed") return { is_error: false, subtype: "turn.completed" };
    if (parsed.type === "turn.failed") return { is_error: true, subtype: "turn.failed" };
  } catch { /* a partial line is not the result */ }
  return null;
}

export const codexRunner: RunnerSide = {
  command: (manifest, prompt, _schemaText, env) => ({
    argv: ["codex", ...codexArgs(manifest)],
    stdin: prompt,
    cwd: CODEX_WORK_DIR,
    env: sanitizedCodexEnv(env),
  }),
  prepare: (manifest: RunnerManifest, env) => {
    if (!env.CODEX_AUTH_JSON) throw new Error("CODEX_AUTH_JSON is required");
    prepareCodexHome(env.CODEX_AUTH_JSON, manifest.tools.draftMcpUrl, manifest.tools.native);
  },
  logNames: { started: "codex_started", finished: "codex_finished" },
  startedFields: () => ({ sandbox: "workspace-write" }),
  failureCodes: { error: "codex_error", exit: "codex_exit" },
  resultOfLine: parseCodexResultLine,
  refreshedLogin: readCodexAuth,
  structured: null,
};

import { CLOUD_NATIVE_TOOLS } from "draft-core/agent-run";
import { getHarness, isKnownModel, type HarnessId } from "draft-core/harnesses";

export const ROUTINE_RUN_ID_PREFIX = "routine:";
const ROUTINE_HOST_PREFIX = "fly:";
export const ROUTINE_HOST_NAME = "Draft cloud";
export const ROUTINE_RUN_TIMEOUT_SECONDS = 15 * 60;
export const ROUTINE_STALE_AFTER_MS = 20 * 60 * 1_000;

const TITLE_MAX_CHARS = 120;
const PROMPT_MAX_CHARS = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a person lets a routine use beyond its defaults. */
export interface RoutineEnvironmentConfig {
  /** Built-in tools of the routine's harness, from the cloud list. */
  nativeTools: string[];
  /** Remote MCP servers the person connected, and which of their tools the routine may call. */
  mcpServers: Array<{ connectionId: string; tools: "all" | string[] }>;
}

/** What `scheduled_tasks.config_json` holds for an agent routine. */
export interface AgentRoutineConfig {
  title: string;
  prompt: string;
  harness: HarnessId;
  model: string | null;
  environment?: RoutineEnvironmentConfig;
}

export type AgentRoutineConfigResult = { ok: true; config: AgentRoutineConfig } | { ok: false; field: "title" | "prompt" | "harness" | "model" | "environment" | "body" };

const MAX_MCP_SERVERS = 10;
const MAX_TOOLS_PER_SERVER = 50;

/** Checks an environment against what a cloud run may be given. Null means it is not valid. */
export function validateRoutineEnvironment(value: unknown, harness: HarnessId): RoutineEnvironmentConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { nativeTools = [], mcpServers = [] } = value as Record<string, unknown>;
  if (!Array.isArray(nativeTools) || !Array.isArray(mcpServers) || mcpServers.length > MAX_MCP_SERVERS) return null;

  const allowedNative = CLOUD_NATIVE_TOOLS[harness] as ReadonlyArray<string>;
  if (!nativeTools.every((tool) => typeof tool === "string" && allowedNative.includes(tool))) return null;

  const servers: RoutineEnvironmentConfig["mcpServers"] = [];
  for (const server of mcpServers) {
    if (!server || typeof server !== "object") return null;
    const { connectionId, tools } = server as Record<string, unknown>;
    if (typeof connectionId !== "string" || !UUID.test(connectionId)) return null;
    if (tools !== "all" && !(Array.isArray(tools) && tools.length <= MAX_TOOLS_PER_SERVER && tools.every((tool) => typeof tool === "string" && tool.length > 0))) return null;
    servers.push({ connectionId, tools: tools === "all" ? "all" : [...new Set(tools as string[])] });
  }
  return { nativeTools: [...new Set(nativeTools as string[])], mcpServers: servers };
}

/** Checks field by field so a caller can say which one is wrong. */
export function validateAgentRoutineConfig(value: unknown): AgentRoutineConfigResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, field: "body" };
  const { title, prompt, harness, model, environment } = value as Record<string, unknown>;
  if (typeof title !== "string" || !title.trim() || title.trim().length > TITLE_MAX_CHARS) return { ok: false, field: "title" };
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > PROMPT_MAX_CHARS) return { ok: false, field: "prompt" };
  const definition = typeof harness === "string" ? getHarness(harness) : null;
  const harnessId = definition?.id as HarnessId;
  if (!definition || definition.routineModes.length === 0) return { ok: false, field: "harness" };
  if (model !== null && (typeof model !== "string" || !isKnownModel(definition.id, model))) return { ok: false, field: "model" };
  let validEnvironment: RoutineEnvironmentConfig | undefined;
  if (environment !== undefined && environment !== null) {
    const checked = validateRoutineEnvironment(environment, harnessId);
    if (!checked) return { ok: false, field: "environment" };
    validEnvironment = checked;
  }
  return { ok: true, config: { title: title.trim(), prompt, harness: harnessId, model, ...(validEnvironment ? { environment: validEnvironment } : {}) } };
}

export function parseAgentRoutineConfig(value: unknown): AgentRoutineConfig | null {
  const result = validateAgentRoutineConfig(value);
  return result.ok ? result.config : null;
}

export const routineRunId = (sessionId: string): string => `${ROUTINE_RUN_ID_PREFIX}${sessionId}`;
export const routineHostMachineId = (sessionId: string): string => `${ROUTINE_HOST_PREFIX}${sessionId}`;

export function parseRoutineSessionId(runId: string): string | null {
  if (!runId.startsWith(ROUTINE_RUN_ID_PREFIX)) return null;
  const id = runId.slice(ROUTINE_RUN_ID_PREFIX.length);
  return UUID.test(id) ? id : null;
}

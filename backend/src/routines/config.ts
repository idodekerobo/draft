import { isKnownModelAlias } from "draft-core/live-sessions";

export const ROUTINE_RUN_ID_PREFIX = "routine:";
const ROUTINE_HOST_PREFIX = "fly:";
export const ROUTINE_HOST_NAME = "Draft cloud";
export const ROUTINE_RUN_TIMEOUT_SECONDS = 15 * 60;
export const ROUTINE_STALE_AFTER_MS = 20 * 60 * 1_000;

const TITLE_MAX_CHARS = 120;
const PROMPT_MAX_CHARS = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What `scheduled_tasks.config_json` holds for an agent routine. */
export interface AgentRoutineConfig {
  title: string;
  prompt: string;
  harness: "claude";
  model: string | null;
}

export type AgentRoutineConfigResult = { ok: true; config: AgentRoutineConfig } | { ok: false; field: "title" | "prompt" | "harness" | "model" | "body" };

/** Checks field by field so a caller can say which one is wrong. */
export function validateAgentRoutineConfig(value: unknown): AgentRoutineConfigResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, field: "body" };
  const { title, prompt, harness, model } = value as Record<string, unknown>;
  if (typeof title !== "string" || !title.trim() || title.trim().length > TITLE_MAX_CHARS) return { ok: false, field: "title" };
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > PROMPT_MAX_CHARS) return { ok: false, field: "prompt" };
  if (harness !== "claude") return { ok: false, field: "harness" };
  if (model !== null && (typeof model !== "string" || !isKnownModelAlias(model))) return { ok: false, field: "model" };
  return { ok: true, config: { title: title.trim(), prompt, harness, model } };
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

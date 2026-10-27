import { isKnownModelAlias } from "draft-core/live-sessions";

export const ROUTINE_RUN_ID_PREFIX = "routine:";
export const ROUTINE_HOST_PREFIX = "fly:";
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

export function parseAgentRoutineConfig(value: unknown): AgentRoutineConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { title, prompt, harness, model } = value as Record<string, unknown>;
  if (typeof title !== "string" || !title.trim() || title.trim().length > TITLE_MAX_CHARS) return null;
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > PROMPT_MAX_CHARS) return null;
  if (harness !== "claude") return null;
  if (model !== null && (typeof model !== "string" || !isKnownModelAlias(model))) return null;
  return { title: title.trim(), prompt, harness, model };
}

export const routineRunId = (sessionId: string): string => `${ROUTINE_RUN_ID_PREFIX}${sessionId}`;
export const routineHostMachineId = (sessionId: string): string => `${ROUTINE_HOST_PREFIX}${sessionId}`;

export function parseRoutineSessionId(runId: string): string | null {
  if (!runId.startsWith(ROUTINE_RUN_ID_PREFIX)) return null;
  const id = runId.slice(ROUTINE_RUN_ID_PREFIX.length);
  return UUID.test(id) ? id : null;
}

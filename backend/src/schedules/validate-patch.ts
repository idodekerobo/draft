import { PRESETS, WEEKDAYS, type Preset, type ScheduleInput, type Weekday } from "../scheduling/presets";
import { validateAgentRoutineConfig, type AgentRoutineConfig } from "../routines/config";
import type { RoutineEditability } from "../scheduling/routine-registry";

const SCHEDULE_FIELDS = ["preset", "time", "weekday", "timezone"] as const;
const AGENT_FIELDS = ["title", "prompt", "harness", "model"] as const;
const ALLOWED_FIELDS = new Set<string>(["enabled", ...SCHEDULE_FIELDS, ...AGENT_FIELDS]);
const MAX_STRING_LENGTH = 64;

export interface SchedulePatch {
  enabled?: boolean;
  schedule?: ScheduleInput;
  /** The whole routine config after the change. Set only when an agent field was sent. */
  agent?: AgentRoutineConfig;
}

export type PatchValidation =
  | { ok: true; patch: SchedulePatch }
  | { ok: false; error: "invalid_body" | "field_not_editable"; field?: string };

/** The harness changes the model list, so a changed harness with no model drops the old model. */
function mergeAgentConfig(current: AgentRoutineConfig, record: Record<string, unknown>) {
  const merged: Record<string, unknown> = { ...current };
  for (const field of AGENT_FIELDS) if (record[field] !== undefined) merged[field] = record[field];
  if (record.harness !== undefined && record.harness !== current.harness && record.model === undefined) merged.model = null;
  return validateAgentRoutineConfig(merged);
}

function isShortString(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_STRING_LENGTH;
}

/** `agentConfig` is the stored config of an agent routine, and null for any other routine. */
export function validatePatch(body: unknown, editable: RoutineEditability, agentConfig: AgentRoutineConfig | null = null): PatchValidation {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "invalid_body" };
  }
  const record = body as Record<string, unknown>;

  const unknownKey = Object.keys(record).find((key) => !ALLOWED_FIELDS.has(key));
  if (unknownKey) return { ok: false, error: "invalid_body", field: unknownKey };

  if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
    return { ok: false, error: "invalid_body", field: "enabled" };
  }
  const patch: SchedulePatch = {};
  if (record.enabled !== undefined) patch.enabled = record.enabled as boolean;

  const sentScheduleFields = SCHEDULE_FIELDS.filter((field) => record[field] !== undefined);
  if (sentScheduleFields.length > 0) {
    if (editable !== "full") {
      return { ok: false, error: "field_not_editable", field: sentScheduleFields[0] };
    }
    for (const field of sentScheduleFields) {
      if (!isShortString(record[field])) return { ok: false, error: "invalid_body", field };
    }
    if (!PRESETS.includes(record.preset as Preset)) {
      return { ok: false, error: "invalid_body", field: "preset" };
    }
    if (record.weekday !== undefined && !WEEKDAYS.includes(record.weekday as Weekday)) {
      return { ok: false, error: "invalid_body", field: "weekday" };
    }
    patch.schedule = {
      preset: record.preset as Preset,
      time: record.time as string | undefined,
      weekday: record.weekday as Weekday | undefined,
      timezone: record.timezone as string | undefined,
    };
  }

  const sentAgentFields = AGENT_FIELDS.filter((field) => record[field] !== undefined);
  if (sentAgentFields.length > 0) {
    if (!agentConfig || editable !== "full") return { ok: false, error: "field_not_editable", field: sentAgentFields[0] };
    const merged = mergeAgentConfig(agentConfig, record);
    if (!merged.ok) return { ok: false, error: "invalid_body", field: merged.field };
    patch.agent = merged.config;
  }

  if (patch.enabled === undefined && patch.schedule === undefined && patch.agent === undefined) {
    return { ok: false, error: "invalid_body" };
  }
  return { ok: true, patch };
}

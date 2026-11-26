import { type BuiltInRoutineConfig } from "./built-in-config";
import { validateAgentRoutineConfig, type AgentRoutineConfig } from "./config";
import { stepPermissionsFit } from "./check-step-permissions";
import { defaultRoutineBuiltInTools } from "draft-core/routines";
import type { RoutineEditability } from "../scheduling/routine-registry";
import { RoutinePatch, RoutineWhen } from "draft-core/routines";

const AGENT_FIELDS = ["title", "prompt", "harness", "model", "reasoningEffort", "canNotify", "canReadGmail", "postChannels", "github", "builtInTools", "steps"] as const;
/** Sending null for one of these turns that ability off. */
const CLEARABLE_FIELDS = new Set<string>(["postChannels", "github", "reasoningEffort", "steps"]);
const ALLOWED_FIELDS = new Set<string>(["enabled", "when", ...AGENT_FIELDS]);

export interface SchedulePatch {
  builtIn?: BuiltInRoutineConfig;
  enabled?: boolean;
  /** A rule sets the schedule and triggers it names. A once sets its one time. */
  when?: RoutineWhen;
  /** The whole routine config after the change. Set only when an agent field was sent. */
  agent?: AgentRoutineConfig;
}

export type PatchValidation =
  | { ok: true; patch: SchedulePatch }
  | { ok: false; error: "invalid_body" | "field_not_editable"; field?: string };

/** The harness changes the model list, so a changed harness with no model drops the old model. */
function mergeAgentConfig(current: AgentRoutineConfig, record: Record<string, unknown>) {
  const merged: Record<string, unknown> = { ...current };
  for (const field of AGENT_FIELDS) {
    if (record[field] === null && CLEARABLE_FIELDS.has(field)) delete merged[field];
    else if (record[field] !== undefined) merged[field] = record[field];
  }
  if (record.harness !== undefined && record.harness !== current.harness && record.model === undefined) merged.model = null;
  // Each harness has its own built-in tools, so a new harness with no list starts with all of its own.
  if (record.harness !== undefined && record.harness !== current.harness && record.builtInTools === undefined) merged.builtInTools = defaultRoutineBuiltInTools(record.harness as string);
  // A step's model belongs to the harness it was written for, so a new harness resets every step to the default.
  if (record.harness !== undefined && record.harness !== current.harness && record.steps === undefined && current.steps) {
    merged.steps = current.steps.map((step) => ({ ...step, model: null }));
  }
  // The model decides which efforts are valid, so a changed harness or model drops the old effort unless a new one comes with it.
  const modelChanged = merged.harness !== current.harness || merged.model !== current.model;
  if (modelChanged && record.reasoningEffort === undefined) delete merged.reasoningEffort;
  return validateAgentRoutineConfig(merged);
}

/** `agentConfig` is the stored config of an agent routine, and null for any other routine. */
export function validatePatch(body: unknown, editable: RoutineEditability, agentConfig: AgentRoutineConfig | null = null, builtInConfig?: BuiltInRoutineConfig): PatchValidation {
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

  if (record.when !== undefined) {
    if (editable !== "full") return { ok: false, error: "field_not_editable", field: "when" };
    const when = RoutineWhen.safeParse(record.when);
    if (!when.success) return { ok: false, error: "invalid_body", field: "when" };
    // Built-in routines keep their schedule and do not accept event triggers.
    if (!("in" in when.data) && !("at" in when.data) && !agentConfig) {
      if (when.data.events !== undefined) return { ok: false, error: "field_not_editable", field: "events" };
      if (when.data.schedule === null) return { ok: false, error: "field_not_editable", field: "schedule" };
    }
    patch.when = when.data;
  }

  const sentAgentFields = AGENT_FIELDS.filter((field) => record[field] !== undefined);
  if (sentAgentFields.length > 0 && builtInConfig) {
    if (editable !== "full") return { ok: false, error: "field_not_editable", field: sentAgentFields[0] };
    const forbidden = sentAgentFields.find((field) => !["prompt", "harness", "model", "reasoningEffort"].includes(field));
    if (forbidden) return { ok: false, error: "field_not_editable", field: forbidden };
    const checked = mergeAgentConfig({ ...builtInConfig, title: "Built-in routine" }, record);
    if (!checked.ok) return { ok: false, error: "invalid_body", field: checked.field };
    const { prompt, harness, model, reasoningEffort } = checked.config;
    patch.builtIn = { prompt, harness, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
  } else if (sentAgentFields.length > 0) {
    if (!agentConfig || editable !== "full") return { ok: false, error: "field_not_editable", field: sentAgentFields[0] };
    const checked = RoutinePatch.safeParse(Object.fromEntries(sentAgentFields.map((field) => [field, record[field]])));
    if (!checked.success) return { ok: false, error: "invalid_body", field: String(checked.error.issues[0]?.path[0] ?? sentAgentFields[0]) };
    const merged = mergeAgentConfig(agentConfig, record);
    if (!merged.ok) return { ok: false, error: "invalid_body", field: merged.field };
    if (!stepPermissionsFit(merged.config)) return { ok: false, error: "invalid_body", field: "steps" };
    patch.agent = merged.config;
  }

  if (patch.enabled === undefined && patch.when === undefined && patch.agent === undefined && patch.builtIn === undefined) {
    return { ok: false, error: "invalid_body" };
  }
  return { ok: true, patch };
}

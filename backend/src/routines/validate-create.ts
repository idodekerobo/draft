import { RoutineInput, defaultRoutineBuiltInTools, type RoutineEventName, type RoutineWhen } from "draft-core/routines";
import { validateAgentRoutineConfig, type AgentRoutineConfig } from "./config";

export type CreateValidation =
  | { ok: true; config: AgentRoutineConfig; when: RoutineWhen; enabled?: boolean }
  | { ok: false; field: string };

/** Body for POST /workspaces/:id/schedules: an agent routine and when it runs. */
export function validateCreate(body: unknown): CreateValidation {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, field: "body" };

  const parsed = RoutineInput.safeParse({ model: null, ...body });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.code === "unrecognized_keys" ? (issue.keys[0] ?? "body") : String(issue?.path[0] ?? "body");
    return { ok: false, field };
  }
  const { when, enabled, harness, ...routine } = parsed.data;
  // The run path fills in the harness before it calls this, so a missing one means a person left it out.
  if (!harness) return { ok: false, field: "harness" };

  // A new routine that names no built-in tools gets every one its harness offers.
  const builtInTools = routine.builtInTools ?? defaultRoutineBuiltInTools(harness);
  const checked = validateAgentRoutineConfig({ ...routine, builtInTools, harness, ...triggerFields(when) });
  if (!checked.ok) return { ok: false, field: checked.field };
  return { ok: true, config: checked.config, when, ...(enabled !== undefined ? { enabled } : {}) };
}

/** A once has no triggers. A rule with no schedule is off, so only its triggers and Run now start it. */
function triggerFields(when: RoutineWhen): { events?: RoutineEventName[]; onSchedule?: false } {
  if ("in" in when || "at" in when) return {};
  return { events: when.events, ...(when.schedule == null ? { onSchedule: false as const } : {}) };
}

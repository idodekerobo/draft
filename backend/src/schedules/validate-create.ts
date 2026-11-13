import { PRESETS, WEEKDAYS, type Preset, type ScheduleInput, type Weekday } from "../scheduling/presets";
import { validateAgentRoutineConfig, type AgentRoutineConfig } from "../routines/config";
import { RoutineInput } from "draft-core/routines";

const MAX_STRING_LENGTH = 64;

export type CreateValidation =
  | { ok: true; config: AgentRoutineConfig; schedule: ScheduleInput; enabled?: boolean }
  | { ok: false; field: string };

/** Body for POST /workspaces/:id/schedules: an agent routine and when it runs. */
export function validateCreate(body: unknown): CreateValidation {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, field: "body" };
  const record = body as Record<string, unknown>;

  const scheduleRecord = record.schedule && typeof record.schedule === "object" ? record.schedule as Record<string, unknown> : { preset: record.preset, time: record.time, weekday: record.weekday, timezone: record.timezone };
  const { preset: _preset, time: _time, weekday: _weekday, timezone: _timezone, ...configFields } = record;
  const shared = RoutineInput.safeParse({ ...configFields, model: record.model ?? null, schedule: scheduleRecord });
  if (!shared.success) {
    const issue = shared.error.issues[0];
    const field = issue?.path[0] === "schedule" ? String(issue.path[1] ?? "schedule") : String(issue?.path[0] ?? "body");
    return { ok: false, field };
  }
  const { schedule: _schedule, enabled: _enabled, ...routineInput } = shared.data;
  const checked = validateAgentRoutineConfig(routineInput);
  if (!checked.ok) return checked;
  const { config } = checked;

  for (const field of ["time", "weekday", "timezone"] as const) {
    const value = scheduleRecord[field];
    if (value !== undefined && (typeof value !== "string" || value.length > MAX_STRING_LENGTH)) return { ok: false, field };
  }
  if (!PRESETS.includes(scheduleRecord.preset as Preset)) return { ok: false, field: "preset" };
  if (scheduleRecord.weekday !== undefined && !WEEKDAYS.includes(scheduleRecord.weekday as Weekday)) return { ok: false, field: "weekday" };

  return {
    ok: true,
    config,
    ...(shared.data.enabled !== undefined ? { enabled: shared.data.enabled } : {}),
    schedule: {
      preset: scheduleRecord.preset as Preset,
      time: scheduleRecord.time as string | undefined,
      weekday: scheduleRecord.weekday as Weekday | undefined,
      timezone: scheduleRecord.timezone as string | undefined,
    },
  };
}

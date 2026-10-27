import { PRESETS, WEEKDAYS, type Preset, type ScheduleInput, type Weekday } from "../scheduling/presets";
import { parseAgentRoutineConfig, type AgentRoutineConfig } from "../routines/config";

const MAX_STRING_LENGTH = 64;

export type CreateValidation =
  | { ok: true; config: AgentRoutineConfig; schedule: ScheduleInput }
  | { ok: false; field: string };

/** Body for POST /workspaces/:id/schedules: an agent routine and when it runs. */
export function validateCreate(body: unknown): CreateValidation {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, field: "body" };
  const record = body as Record<string, unknown>;

  const config = parseAgentRoutineConfig({
    title: record.title,
    prompt: record.prompt,
    harness: record.harness,
    model: record.model ?? null,
  });
  if (!config) {
    const field = (["title", "prompt", "harness", "model"] as const).find(
      (name) => parseAgentRoutineConfig({ title: "t", prompt: "p", harness: "claude", model: null, [name]: record[name] ?? null }) === null,
    );
    return { ok: false, field: field ?? "body" };
  }

  for (const field of ["time", "weekday", "timezone"] as const) {
    const value = record[field];
    if (value !== undefined && (typeof value !== "string" || value.length > MAX_STRING_LENGTH)) return { ok: false, field };
  }
  if (!PRESETS.includes(record.preset as Preset)) return { ok: false, field: "preset" };
  if (record.weekday !== undefined && !WEEKDAYS.includes(record.weekday as Weekday)) return { ok: false, field: "weekday" };

  return {
    ok: true,
    config,
    schedule: {
      preset: record.preset as Preset,
      time: record.time as string | undefined,
      weekday: record.weekday as Weekday | undefined,
      timezone: record.timezone as string | undefined,
    },
  };
}

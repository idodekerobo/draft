import { PRESETS, WEEKDAYS, type Preset, type ScheduleInput, type Weekday } from "../scheduling/presets";
import type { RoutineEditability } from "../scheduling/routine-registry";

const SCHEDULE_FIELDS = ["preset", "time", "weekday", "timezone"] as const;
const ALLOWED_FIELDS = new Set<string>(["enabled", ...SCHEDULE_FIELDS]);
const MAX_STRING_LENGTH = 64;

export interface SchedulePatch {
  enabled?: boolean;
  schedule?: ScheduleInput;
}

export type PatchValidation =
  | { ok: true; patch: SchedulePatch }
  | { ok: false; error: "invalid_body" | "field_not_editable"; field?: string };

function isShortString(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_STRING_LENGTH;
}

export function validatePatch(body: unknown, editable: RoutineEditability): PatchValidation {
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

  if (patch.enabled === undefined && patch.schedule === undefined) {
    return { ok: false, error: "invalid_body" };
  }
  return { ok: true, patch };
}

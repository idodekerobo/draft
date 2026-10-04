import type { Routine, RoutinePreset, RoutineWeekday } from "./types";

export type RoutineFilter = "all" | "active" | "paused";

const WEEKDAY_INDEX: Record<RoutineWeekday, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DEFAULT_HOURS = [0, 4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 22];

export function filterRoutines(routines: Routine[], filter: RoutineFilter, search: string): Routine[] {
  const query = search.trim().toLowerCase();
  return routines.filter((routine) => {
    if (filter === "active" && !routine.enabled) return false;
    if (filter === "paused" && routine.enabled) return false;
    if (!query) return true;
    return [routine.title, routine.routineDescription, routine.connectionLabel ?? ""].some((text) =>
      text.toLowerCase().includes(query),
    );
  });
}

export function countRoutines(routines: Routine[]): Record<RoutineFilter, number> {
  const active = routines.filter((routine) => routine.enabled).length;
  return { all: routines.length, active, paused: routines.length - active };
}

export function formatRelative(iso: string, now: Date = new Date()): string {
  const diffMs = new Date(iso).getTime() - now.getTime();
  const minutes = Math.round(Math.abs(diffMs) / 60_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const sign = diffMs < 0 ? -1 : 1;
  if (minutes < 1) return formatter.format(0, "minute");
  if (minutes < 60) return formatter.format(sign * minutes, "minute");
  if (minutes < 60 * 24) return formatter.format(sign * Math.round(minutes / 60), "hour");
  return formatter.format(sign * Math.round(minutes / (60 * 24)), "day");
}

export function formatAbsolute(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(iso));
}

/** Hourly runs are the one preset that can burn through quota quickly. */
export function isHeavyCadence(preset: RoutinePreset): boolean {
  return preset === "hourly";
}

function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(instant));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

function localInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(year, month, day, hour, minute);
  const first = guess - offsetMs(guess, timeZone);
  return guess - offsetMs(first, timeZone);
}

/** Next run implied by an edit, so the dialog can preview it before saving. */
export function previewNextRun(
  input: { preset: Exclude<RoutinePreset, "custom">; time: string; weekday: RoutineWeekday; timezone: string },
  now: Date = new Date(),
): Date {
  const nowMs = now.getTime();
  if (input.preset === "hourly") return new Date((Math.floor(nowMs / 3_600_000) + 1) * 3_600_000);

  const timeZone = input.preset === "draft_default" ? "UTC" : input.timezone;
  const hours = input.preset === "draft_default" ? DEFAULT_HOURS : [Number(input.time.slice(0, 2))];
  const minute = input.preset === "draft_default" ? 0 : Number(input.time.slice(3, 5));

  const today = new Date(nowMs + offsetMs(nowMs, timeZone));
  for (let dayOffset = 0; dayOffset < 9; dayOffset++) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + dayOffset));
    const weekday = day.getUTCDay();
    if (input.preset === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    if (input.preset === "weekly" && weekday !== WEEKDAY_INDEX[input.weekday]) continue;
    for (const hour of hours) {
      const instant = localInstant(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute, timeZone);
      if (instant > nowMs) return new Date(instant);
    }
  }
  return new Date(nowMs);
}

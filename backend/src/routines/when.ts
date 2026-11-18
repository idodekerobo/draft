import { CronExpressionParser } from "cron-parser";
import { ROUTINE_DURATION, ROUTINE_ONCE_MAX_DAYS, type RoutineEventName, type RoutineWhen } from "draft-core/routines";
import { buildSchedule, isValidTimezone } from "../scheduling/presets";

const UNIT_SECONDS = { m: 60, h: 3600, d: 86400 } as const;
const DAY_MS = 86_400_000;
// Hourly is the fastest preset, so a custom cron may not fire more often than that.
/** The shortest gap allowed between runs of a routine that a run created. */
export const MIN_RUN_MADE_CRON_GAP_SECONDS = 3600;

export type ResolvedWhen =
  | { kind: "once"; runAt: Date; timezone: string }
  | { kind: "rule"; schedule: { cron: string; timezone: string } | null | undefined; events: RoutineEventName[] | undefined };

export interface WhenRefusal {
  ok: false;
  code: "too_far_ahead" | "in_the_past" | "invalid_schedule";
  message: string;
  field: string;
}

/** Turns a when into a concrete time or a cron. `now` is injected so the rules stay testable. */
export function resolveWhen(when: RoutineWhen, now: Date, timezone = "UTC"): { ok: true; value: ResolvedWhen } | WhenRefusal {
  if ("in" in when) {
    const match = ROUTINE_DURATION.exec(when.in);
    if (!match) return refuse("invalid_schedule", "in", "Use a number and a unit: m, h or d, such as 2h.");
    const seconds = Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS];
    return checkOnce(new Date(now.getTime() + seconds * 1000), now, "in", timezone);
  }
  if ("at" in when) {
    const runAt = new Date(when.at);
    if (Number.isNaN(runAt.getTime())) return refuse("invalid_schedule", "at", "Use an ISO 8601 time with an offset.");
    return checkOnce(runAt, now, "at", timezone);
  }

  const { schedule, events } = when;
  if (schedule === undefined || schedule === null) return { ok: true, value: { kind: "rule", schedule, events } };
  const resolved = "cron" in schedule ? resolveCron(schedule.cron, schedule.timezone, now) : resolvePreset(schedule, now);
  if (!resolved.ok) return resolved;
  return { ok: true, value: { kind: "rule", schedule: resolved.value, events } };
}

function refuse(code: WhenRefusal["code"], field: string, message: string): WhenRefusal {
  return { ok: false, code, field, message };
}

function checkOnce(runAt: Date, now: Date, field: string, timezone: string): { ok: true; value: ResolvedWhen } | WhenRefusal {
  if (runAt.getTime() <= now.getTime()) {
    return refuse("in_the_past", field, `That time has already passed (${runAt.toISOString()}). Use a future time.`);
  }
  if (runAt.getTime() - now.getTime() > ROUTINE_ONCE_MAX_DAYS * DAY_MS) {
    return refuse("too_far_ahead", field, `A routine can be set at most ${ROUTINE_ONCE_MAX_DAYS} days ahead. You asked for ${runAt.toISOString()}.`);
  }
  return { ok: true, value: { kind: "once", runAt, timezone } };
}

function resolvePreset(schedule: Parameters<typeof buildSchedule>[0], now: Date): { ok: true; value: { cron: string; timezone: string } } | WhenRefusal {
  const built = buildSchedule(schedule);
  if (!built.ok) return refuse("invalid_schedule", built.field, built.message);
  return checkCron(built.cron, built.timezone, now);
}

function resolveCron(cron: string, timezone: string, now: Date): { ok: true; value: { cron: string; timezone: string } } | WhenRefusal {
  if (!isValidTimezone(timezone)) return refuse("invalid_schedule", "timezone", "Unknown timezone");
  return checkCron(cron, timezone, now);
}

function checkCron(cron: string, timezone: string, now: Date): { ok: true; value: { cron: string; timezone: string } } | WhenRefusal {
  // People may set any valid cron. The hourly floor applies only to routines that runs create.
  try {
    minCronGapSeconds(cron, timezone, now);
  } catch {
    return refuse("invalid_schedule", "cron", "That cron expression is not valid, or never runs.");
  }
  return { ok: true, value: { cron, timezone } };
}

/** The shortest gap, in seconds, between the next `samples` occurrences. Throws when the cron is not valid. */
export function minCronGapSeconds(cron: string, timezone: string, from: Date, samples = 24): number {
  const interval = CronExpressionParser.parse(cron, { currentDate: from, tz: timezone });
  let previous = interval.next().toDate().getTime();
  let shortest = Infinity;
  for (let index = 1; index < samples; index += 1) {
    const current = interval.next().toDate().getTime();
    shortest = Math.min(shortest, (current - previous) / 1000);
    previous = current;
  }
  return shortest;
}

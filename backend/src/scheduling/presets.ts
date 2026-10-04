export const PRESETS = ["draft_default", "hourly", "daily", "weekdays", "weekly"] as const;
export type Preset = (typeof PRESETS)[number];
export type ParsedPreset = Preset | "custom";

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const DRAFT_DEFAULT_CRON = "0 0,4,8,9-18,22 * * *";
export const DRAFT_DEFAULT_TIMEZONE = "UTC";

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface ScheduleInput {
  preset: Preset;
  time?: string;
  weekday?: Weekday;
  timezone?: string;
}

export type BuildResult =
  | { ok: true; cron: string; timezone: string }
  | { ok: false; field: "preset" | "time" | "weekday" | "timezone"; message: string };

export interface ParsedSchedule {
  preset: ParsedPreset;
  time: string | null;
  weekday: Weekday | null;
  timezone: string;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function isValidTime(time: string): boolean {
  return TIME_PATTERN.test(time);
}

export function buildSchedule(input: ScheduleInput): BuildResult {
  if (!PRESETS.includes(input.preset)) {
    return { ok: false, field: "preset", message: "Unknown preset" };
  }
  if (input.preset === "draft_default") {
    return { ok: true, cron: DRAFT_DEFAULT_CRON, timezone: DRAFT_DEFAULT_TIMEZONE };
  }

  const timezone = input.timezone ?? DRAFT_DEFAULT_TIMEZONE;
  if (!isValidTimezone(timezone)) {
    return { ok: false, field: "timezone", message: "Unknown timezone" };
  }
  if (input.preset === "hourly") {
    return { ok: true, cron: "0 * * * *", timezone };
  }

  const match = input.time === undefined ? null : TIME_PATTERN.exec(input.time);
  if (!match) {
    return { ok: false, field: "time", message: "Time must be HH:MM" };
  }
  const minute = Number(match[2]);
  const hour = Number(match[1]);

  if (input.preset === "daily") return { ok: true, cron: `${minute} ${hour} * * *`, timezone };
  if (input.preset === "weekdays") return { ok: true, cron: `${minute} ${hour} * * 1-5`, timezone };

  const weekdayIndex = input.weekday === undefined ? -1 : WEEKDAYS.indexOf(input.weekday);
  if (weekdayIndex < 0) {
    return { ok: false, field: "weekday", message: "Weekday is required for weekly" };
  }
  return { ok: true, cron: `${minute} ${hour} * * ${weekdayIndex}`, timezone };
}

// Six-field cron has a leading seconds field; only a fixed "0" maps to a preset.
function normalizeFields(cron: string): string[] | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length === 6 && fields[0] === "0") return fields.slice(1);
  return fields.length === 5 ? fields : null;
}

function isInt(value: string, min: number, max: number): boolean {
  return /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max;
}

export function parseSchedule(cron: string, timezone: string): ParsedSchedule {
  const custom: ParsedSchedule = { preset: "custom", time: null, weekday: null, timezone };
  const fields = normalizeFields(cron);
  if (!fields) return custom;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  if (fields.join(" ") === DRAFT_DEFAULT_CRON && timezone === DRAFT_DEFAULT_TIMEZONE) {
    return { preset: "draft_default", time: null, weekday: null, timezone };
  }
  if (dayOfMonth !== "*" || month !== "*" || minute === undefined) return custom;

  if (minute === "0" && hour === "*" && dayOfWeek === "*") {
    return { preset: "hourly", time: null, weekday: null, timezone };
  }
  if (!isInt(minute, 0, 59) || hour === undefined || !isInt(hour, 0, 23)) return custom;

  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (dayOfWeek === "*") return { preset: "daily", time, weekday: null, timezone };
  if (dayOfWeek === "1-5") return { preset: "weekdays", time, weekday: null, timezone };
  if (dayOfWeek !== undefined && isInt(dayOfWeek, 0, 7)) {
    const weekday = WEEKDAYS[Number(dayOfWeek) % 7] ?? null;
    return { preset: "weekly", time, weekday, timezone };
  }
  return custom;
}

const WEEKDAY_NAMES: Record<Weekday, string> = {
  sun: "Sunday",
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
};

function clock(time: string | null): string {
  const [hour = 0, minute = 0] = (time ?? "00:00").split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

/** Cadence only; the timezone is shown separately. */
export function describeSchedule(parsed: ParsedSchedule): string {
  switch (parsed.preset) {
    case "draft_default":
      return "Hourly, 9 AM–6 PM; every ~4h overnight";
    case "hourly":
      return "Every hour";
    case "daily":
      return `Daily at ${clock(parsed.time)}`;
    case "weekdays":
      return `Weekdays at ${clock(parsed.time)}`;
    case "weekly":
      return `${WEEKDAY_NAMES[parsed.weekday ?? "mon"]}s at ${clock(parsed.time)}`;
    case "custom":
      return "Custom schedule";
  }
}

export function describeInterval(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "Every hour" : `Every ${hours} hours`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
}

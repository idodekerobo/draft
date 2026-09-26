export type MemoryPeriodKind = "day" | "week" | "month";

export interface ResolvedMemoryPeriod {
  kind: MemoryPeriodKind;
  id: string;
  path: string;
  start: string;
  end: string;
}

const DAY_ALIASES = new Set(["today", "yesterday"]);
const WEEK_ALIASES = new Set(["this-week", "last-week"]);
const MONTH_ALIASES = new Set(["this-month", "last-month"]);

// A bare YYYY-MM-DD is always a day id. A week is identified by its Monday's
// date too, so it needs the "week-" prefix to disambiguate from a day id of
// the same shape -- see the memory-dimension plan for why week numbers
// (Wnn) were rejected in favor of Monday-anchored dates.
const DAY_ID_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_ID_PATTERN = /^week-(\d{4}-\d{2}-\d{2})$/;
const MONTH_ID_PATTERN = /^\d{4}-\d{2}$/;

interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number;
}

function formatId(date: CalendarDate): string {
  return `${date.year.toString().padStart(4, "0")}-${date.month.toString().padStart(2, "0")}-${date.day.toString().padStart(2, "0")}`;
}

function toUtcMillis(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

function fromUtcMillis(ms: number): CalendarDate {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function addDays(date: CalendarDate, days: number): CalendarDate {
  return fromUtcMillis(toUtcMillis(date) + days * 86_400_000);
}

/** 0 = Monday ... 6 = Sunday (unlike Date#getDay, which is 0 = Sunday). */
function isoWeekday(date: CalendarDate): number {
  const jsDay = new Date(toUtcMillis(date)).getUTCDay();
  return (jsDay + 6) % 7;
}

function mondayOf(date: CalendarDate): CalendarDate {
  return addDays(date, -isoWeekday(date));
}

function addMonths(date: CalendarDate, months: number): CalendarDate {
  const total = date.year * 12 + (date.month - 1) + months;
  return { year: Math.floor(total / 12), month: (total % 12) + 1, day: 1 };
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "Today" as a wall-clock calendar date in the given IANA timezone. */
function todayInTimezone(now: Date, timezone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function parseDayId(id: string): CalendarDate {
  const match = DAY_ID_PATTERN.exec(id);
  if (!match) throw new Error(`invalid day id: ${id}`);
  const [year, month, day] = id.split("-").map(Number);
  return { year, month, day };
}

function dayPeriod(date: CalendarDate): ResolvedMemoryPeriod {
  const id = formatId(date);
  return { kind: "day", id, path: `memory/days/${id}.md`, start: id, end: id };
}

function weekPeriod(monday: CalendarDate): ResolvedMemoryPeriod {
  const id = formatId(monday);
  const sunday = addDays(monday, 6);
  return { kind: "week", id, path: `memory/weeks/${id}.md`, start: id, end: formatId(sunday) };
}

function monthPeriod(year: number, month: number): ResolvedMemoryPeriod {
  const id = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}`;
  const start = `${id}-01`;
  const end = `${id}-${lastDayOfMonth(year, month).toString().padStart(2, "0")}`;
  return { kind: "month", id, path: `memory/months/${id}.md`, start, end };
}

/**
 * Resolves an alias ("today", "this-week", ...) or an explicit period id
 * to its canonical memory document path. Pure and deterministic given
 * `now` and `timezone` -- both CLI (over HTTP) and MCP (in-process) call
 * this same function so alias resolution can never drift between them.
 */
export function resolveMemoryPeriod(
  input: string,
  timezone: string,
  now: Date = new Date(),
): ResolvedMemoryPeriod {
  const today = todayInTimezone(now, timezone);

  if (DAY_ALIASES.has(input)) {
    return dayPeriod(input === "today" ? today : addDays(today, -1));
  }
  if (WEEK_ALIASES.has(input)) {
    const monday = mondayOf(today);
    return weekPeriod(input === "this-week" ? monday : addDays(monday, -7));
  }
  if (MONTH_ALIASES.has(input)) {
    const current = { year: today.year, month: today.month, day: 1 };
    const target = input === "this-month" ? current : addMonths(current, -1);
    return monthPeriod(target.year, target.month);
  }

  const weekMatch = WEEK_ID_PATTERN.exec(input);
  if (weekMatch) {
    const monday = parseDayId(weekMatch[1]);
    if (isoWeekday(monday) !== 0) {
      throw new Error(`week id must be a Monday: ${input}`);
    }
    return weekPeriod(monday);
  }

  if (DAY_ID_PATTERN.test(input)) {
    return dayPeriod(parseDayId(input));
  }

  if (MONTH_ID_PATTERN.test(input)) {
    const [year, month] = input.split("-").map(Number);
    if (month < 1 || month > 12) throw new Error(`invalid month id: ${input}`);
    return monthPeriod(year, month);
  }

  throw new Error(
    `unrecognized period: ${input} (expected today/yesterday/this-week/last-week/this-month/last-month, YYYY-MM-DD, week-YYYY-MM-DD, or YYYY-MM)`,
  );
}

export const MEMORY_INDEX_PATH = "memory/index.md";

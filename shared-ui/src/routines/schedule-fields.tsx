"use client";

import type { ReactNode } from "react";
import { Select } from "../controls/Select";
import type { RoutinePreset, RoutineWeekday } from "./types";

type EditablePreset = Exclude<RoutinePreset, "custom">;

export const PRESET_LABELS: Record<RoutinePreset, string> = {
  draft_default: "Draft default (daytime + overnight)",
  hourly: "Every hour",
  daily: "Every day",
  weekdays: "Weekdays",
  weekly: "Every week",
  custom: "Custom (current schedule)",
};
export const SELECTABLE: EditablePreset[] = ["hourly", "daily", "weekdays", "weekly"];
export const WEEKDAYS: Array<[RoutineWeekday, string]> = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
];

export function timezoneOptions(current: string): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  return [...new Set(["UTC", current, ...supported])];
}

export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Whether a frequency is set at a time of day. */
export const presetUsesTime = (preset: RoutinePreset): boolean => preset === "daily" || preset === "weekdays" || preset === "weekly";

export interface ScheduleValue {
  preset: Exclude<EditablePreset, "draft_default">;
  time: string;
  weekday: RoutineWeekday;
  timezone: string;
}

/** "Runs weekdays at 09:00" for the preview column. */
export function scheduleSentence(value: { preset: RoutinePreset; time: string; weekday: RoutineWeekday }): string {
  const at = value.time ? ` at ${value.time}` : "";
  if (value.preset === "draft_default") return "Runs on Draft’s default schedule";
  if (value.preset === "custom") return "Runs on a custom schedule";
  if (value.preset === "hourly") return "Runs every hour";
  if (value.preset === "daily") return `Runs every day${at}`;
  if (value.preset === "weekdays") return `Runs on weekdays${at}`;
  const day = WEEKDAYS.find(([key]) => key === value.weekday)?.[1] ?? "week";
  return `Runs every ${day}${at}`;
}

/** Frequency, time, timezone and day for a schedule a person is building from nothing. */
export function ScheduleFields({ value, onChange, disabled, fieldError, zones }: {
  value: ScheduleValue;
  onChange: (value: ScheduleValue) => void;
  disabled?: boolean;
  fieldError: (field: string) => ReactNode;
  zones: string[];
}) {
  const usesTime = presetUsesTime(value.preset);
  return (
    <div className="ui-routines__fields">
      <div className="ui-routines__field">
        Frequency
        <Select
          label="Frequency"
          value={value.preset}
          disabled={disabled}
          options={SELECTABLE.filter((option) => option !== "draft_default").map((option) => ({ value: option as ScheduleValue["preset"], label: PRESET_LABELS[option] }))}
          onChange={(preset) => onChange({ ...value, preset })}
        />
        {fieldError("preset")}
      </div>

      {usesTime && (
        <label className="ui-routines__field">
          Time
          <input type="time" value={value.time} required disabled={disabled} onChange={(event) => onChange({ ...value, time: event.target.value })} />
          {fieldError("time")}
        </label>
      )}

      <div className="ui-routines__field">
        Timezone
        <Select label="Timezone" value={value.timezone} disabled={disabled} searchable options={zones.map((zone) => ({ value: zone, label: zone }))} onChange={(timezone) => onChange({ ...value, timezone })} />
        {fieldError("timezone")}
      </div>

      {value.preset === "weekly" && (
        <div className="ui-routines__field ui-routines__field--wide">
          Day
          <Select label="Day" value={value.weekday} disabled={disabled} options={WEEKDAYS.map(([day, label]) => ({ value: day, label }))} onChange={(weekday: RoutineWeekday) => onChange({ ...value, weekday })} />
          {fieldError("weekday")}
        </div>
      )}
    </div>
  );
}

"use client";

import type { ReactNode } from "react";
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
      <label className="ui-routines__field">
        Frequency
        <select value={value.preset} disabled={disabled} onChange={(event) => onChange({ ...value, preset: event.target.value as ScheduleValue["preset"] })}>
          {SELECTABLE.map((option) => (
            <option key={option} value={option}>{PRESET_LABELS[option]}</option>
          ))}
        </select>
        {fieldError("preset")}
      </label>

      {usesTime && (
        <label className="ui-routines__field">
          Time
          <input type="time" value={value.time} required disabled={disabled} onChange={(event) => onChange({ ...value, time: event.target.value })} />
          {fieldError("time")}
        </label>
      )}

      <label className="ui-routines__field">
        Timezone
        <select value={value.timezone} disabled={disabled} onChange={(event) => onChange({ ...value, timezone: event.target.value })}>
          {zones.map((zone) => (
            <option key={zone} value={zone}>{zone}</option>
          ))}
        </select>
        {fieldError("timezone")}
      </label>

      {value.preset === "weekly" && (
        <label className="ui-routines__field ui-routines__field--wide">
          Day
          <select value={value.weekday} disabled={disabled} onChange={(event) => onChange({ ...value, weekday: event.target.value as RoutineWeekday })}>
            {WEEKDAYS.map(([day, label]) => (
              <option key={day} value={day}>{label}</option>
            ))}
          </select>
          {fieldError("weekday")}
        </label>
      )}
    </div>
  );
}

"use client";

import { TriangleAlert } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Dialog } from "./Dialog";
import { formatAbsolute, isHeavyCadence, previewNextRun } from "./format";
import type { Routine, RoutinePatch, RoutinePreset, RoutineWeekday } from "./types";

type EditablePreset = Exclude<RoutinePreset, "custom">;

const PRESET_LABELS: Record<RoutinePreset, string> = {
  draft_default: "Draft default",
  hourly: "Every hour",
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  custom: "Custom (current schedule)",
};
const SELECTABLE: EditablePreset[] = ["draft_default", "hourly", "daily", "weekdays", "weekly"];
const WEEKDAYS: Array<[RoutineWeekday, string]> = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
];

function timezoneOptions(current: string): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  return [...new Set(["UTC", current, ...supported])];
}

function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function RoutineDetails({ routine, canEdit, onClose, onSave }: {
  routine: Routine;
  canEdit: boolean;
  onClose: () => void;
  onSave: (patch: RoutinePatch) => Promise<void>;
}) {
  const ids = useId();
  const editable = canEdit && routine.editable === "full";
  const [preset, setPreset] = useState<RoutinePreset>(routine.preset);
  const [time, setTime] = useState(routine.time ?? "09:00");
  const [weekday, setWeekday] = useState<RoutineWeekday>(routine.weekday ?? "mon");
  const [timezone, setTimezone] = useState(
    routine.preset === "draft_default" || routine.preset === "custom" ? browserTimezone() : routine.timezone,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);

  const usesTime = preset === "daily" || preset === "weekdays" || preset === "weekly";
  const usesTimezone = usesTime || preset === "hourly";
  const effectiveTimezone = preset === "draft_default" ? "UTC" : timezone;
  const zones = useMemo(() => timezoneOptions(timezone), [timezone]);

  const dirty =
    preset !== routine.preset ||
    (usesTime && time !== routine.time) ||
    (preset === "weekly" && weekday !== routine.weekday) ||
    (usesTimezone && timezone !== routine.timezone);
  const canSave = editable && preset !== "custom" && dirty && (!usesTime || time !== "") && !saving;

  const nextRun =
    preset === "custom"
      ? null
      : previewNextRun({ preset, time: time || "00:00", weekday, timezone: effectiveTimezone });

  async function save() {
    if (preset === "custom") return;
    setSaving(true);
    setError(null);
    const patch: RoutinePatch = {
      preset,
      ...(usesTime ? { time } : {}),
      ...(preset === "weekly" ? { weekday } : {}),
      ...(usesTimezone ? { timezone } : {}),
    };
    try {
      await onSave(patch);
    } catch (caught) {
      const failure = caught as Error & { field?: string };
      setError({ field: failure.field, message: failure.message || "Could not save this schedule." });
      setSaving(false);
    }
  }

  const fieldError = (field: string) =>
    error?.field === field ? (
      <span className="ui-error" id={`${ids}-${field}-error`} role="alert">{error.message}</span>
    ) : null;

  return (
    <Dialog title={routine.title} titleId={`${ids}-title`} onClose={onClose}>
      <p className="ui-routines__explainer">{routine.routineDescription}</p>
      {routine.connectionLabel && <p className="ui-muted">Connection: {routine.connectionLabel}</p>}
      <p className="ui-muted">Current schedule: {routine.scheduleDescription}</p>

      {routine.editable === "toggle_only" && (
        <p className="ui-muted">
          This schedule is managed for you. Use the switch in the list to pause or resume it.
        </p>
      )}
      {!canEdit && <p className="ui-muted">You have view-only access to routines.</p>}

      {routine.editable === "full" && (
        <form
          className="ui-routines__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) void save();
          }}
        >
          <label className="ui-routines__field">
            <span>Frequency</span>
            <select
              className="ui-input"
              value={preset}
              disabled={!editable || saving}
              onChange={(event) => {
                setPreset(event.target.value as RoutinePreset);
                setError(null);
              }}
            >
              {routine.preset === "custom" && <option value="custom">{PRESET_LABELS.custom}</option>}
              {SELECTABLE.map((option) => (
                <option key={option} value={option}>{PRESET_LABELS[option]}</option>
              ))}
            </select>
            {fieldError("preset")}
          </label>

          {preset === "weekly" && (
            <label className="ui-routines__field">
              <span>Day</span>
              <select
                className="ui-input"
                value={weekday}
                disabled={!editable || saving}
                onChange={(event) => setWeekday(event.target.value as RoutineWeekday)}
              >
                {WEEKDAYS.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              {fieldError("weekday")}
            </label>
          )}

          {usesTime && (
            <label className="ui-routines__field">
              <span>Time</span>
              <input
                className="ui-input"
                type="time"
                value={time}
                required
                disabled={!editable || saving}
                onChange={(event) => setTime(event.target.value)}
              />
              {fieldError("time")}
            </label>
          )}

          {usesTimezone && (
            <label className="ui-routines__field">
              <span>Timezone</span>
              <select
                className="ui-input"
                value={timezone}
                disabled={!editable || saving}
                onChange={(event) => setTimezone(event.target.value)}
              >
                {zones.map((zone) => (
                  <option key={zone} value={zone}>{zone}</option>
                ))}
              </select>
              {fieldError("timezone")}
            </label>
          )}

          {preset === "draft_default" && (
            <p className="ui-muted">
              Runs at 00:00, 04:00, 08:00, hourly from 09:00 to 18:00, and 22:00. Timezone is fixed to UTC.
            </p>
          )}

          {isHeavyCadence(preset) && (
            <p className="ui-routines__warning" role="note">
              <TriangleAlert size={16} aria-hidden />
              <span>Frequent checks can use more of your Claude quota. A run still starts only when there is new material.</span>
            </p>
          )}

          {nextRun && (
            <p className="ui-routines__preview">
              {dirty ? "Next run after saving: " : "Next run: "}
              <strong>{formatAbsolute(nextRun.toISOString(), effectiveTimezone)}</strong>
            </p>
          )}

          {error && !error.field && <p className="ui-error" role="alert">{error.message}</p>}

          {editable && (
            <div className="ui-routines__actions">
              <button type="button" className="ui-btn" onClick={onClose} disabled={saving}>Cancel</button>
              <button type="submit" className="ui-btn ui-btn--primary" disabled={!canSave}>
                {saving ? "Saving…" : "Save schedule"}
              </button>
            </div>
          )}
        </form>
      )}

      {routine.updatedByName && <p className="ui-muted ui-routines__changed">Last changed by {routine.updatedByName}</p>}
    </Dialog>
  );
}

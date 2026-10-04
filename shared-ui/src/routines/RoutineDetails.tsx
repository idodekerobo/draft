"use client";

import { useId, useMemo, useState } from "react";
import { Dialog } from "./Dialog";
import { RoutineError } from "./errors";
import { formatAbsolute, isHeavyCadence, previewNextRun, zoneLabel } from "./format";
import type { Routine, RoutinePatch, RoutinePreset, RoutineWeekday } from "./types";

type EditablePreset = Exclude<RoutinePreset, "custom">;

const PRESET_LABELS: Record<RoutinePreset, string> = {
  draft_default: "Draft default (daytime + overnight)",
  hourly: "Every hour",
  daily: "Every day",
  weekdays: "Weekdays",
  weekly: "Every week",
  custom: "Custom (current schedule)",
};
const SELECTABLE: EditablePreset[] = ["hourly", "daily", "weekdays", "weekly"];
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
  const titleId = `${ids}-title`;
  const editable = canEdit && routine.editable === "full";
  const isSynthesis = routine.taskType === "synthesize_workspace";
  const [preset, setPreset] = useState<RoutinePreset>(routine.preset);
  const [time, setTime] = useState(routine.time ?? "09:00");
  const [weekday, setWeekday] = useState<RoutineWeekday>(routine.weekday ?? "mon");
  const [timezone, setTimezone] = useState(
    routine.preset === "draft_default" || routine.preset === "custom" ? browserTimezone() : routine.timezone,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);

  const usesTime = preset === "daily" || preset === "weekdays" || preset === "weekly";
  const isDefault = preset === "draft_default";
  const effectiveTimezone = isDefault ? "UTC" : timezone;
  const zones = useMemo(() => timezoneOptions(timezone), [timezone]);
  const dirty =
    preset !== routine.preset ||
    (usesTime && time !== routine.time) ||
    (preset === "weekly" && weekday !== routine.weekday) ||
    (!isDefault && timezone !== routine.timezone);
  const canSave = editable && preset !== "custom" && dirty && (!usesTime || time !== "") && !saving;
  const noun = isSynthesis ? "run" : "check";

  const nextRun =
    preset === "custom" || !routine.enabled
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
      ...(!isDefault ? { timezone } : {}),
    };
    try {
      await onSave(patch);
    } catch (caught) {
      setError(
        caught instanceof RoutineError
          ? { field: caught.field, message: caught.message }
          : { message: "Could not save this schedule. Try again." },
      );
      setSaving(false);
    }
  }

  const fieldError = (field: string) =>
    error?.field === field ? <span className="ui-routines__error" role="alert">{error.message}</span> : null;

  return (
    <Dialog titleId={titleId} onClose={onClose} busy={saving}>
      <header className="ui-dialog__header">
        <h2 id={titleId}>{routine.title}</h2>
        <button type="button" className="ui-routines__btn" aria-label="Close routine details" disabled={saving} onClick={onClose}>
          Close
        </button>
      </header>
      <p className="ui-dialog__description">{routine.routineDescription}</p>

      {routine.editable === "toggle_only" ? (
        <div className="ui-dialog__info">
          {routine.connectionLabel && <p>{routine.connectionLabel}</p>}
          <p>
            Checks {routine.scheduleDescription.replace(/^Every/, "every")} ({zoneLabel(routine.timezone)}). Timing is
            managed by Draft. Pause or resume this routine using its toggle in the list.
          </p>
        </div>
      ) : (
        <form
          className="ui-routines__editor"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) void save();
          }}
        >
          <div className="ui-routines__fields">
            <label className="ui-routines__field">
              Frequency
              <select
                value={preset}
                disabled={!editable || saving}
                onChange={(event) => {
                  setPreset(event.target.value as RoutinePreset);
                  setError(null);
                }}
              >
                {routine.preset === "custom" && <option value="custom">{PRESET_LABELS.custom}</option>}
                {(isSynthesis || routine.preset === "draft_default") && (
                  <option value="draft_default">{PRESET_LABELS.draft_default}</option>
                )}
                {SELECTABLE.map((option) => (
                  <option key={option} value={option}>{PRESET_LABELS[option]}</option>
                ))}
              </select>
              {fieldError("preset")}
            </label>

            {usesTime && (
              <label className="ui-routines__field">
                Time
                <input type="time" value={time} required disabled={!editable || saving} onChange={(event) => setTime(event.target.value)} />
                {fieldError("time")}
              </label>
            )}

            <label className="ui-routines__field">
              Timezone
              <select
                value={effectiveTimezone}
                disabled={!editable || saving || isDefault}
                onChange={(event) => setTimezone(event.target.value)}
              >
                {zones.map((zone) => (
                  <option key={zone} value={zone}>{zone}</option>
                ))}
              </select>
              {fieldError("timezone")}
            </label>

            {preset === "weekly" && (
              <label className="ui-routines__field ui-routines__field--wide">
                Day
                <select value={weekday} disabled={!editable || saving} onChange={(event) => setWeekday(event.target.value as RoutineWeekday)}>
                  {WEEKDAYS.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                {fieldError("weekday")}
              </label>
            )}
          </div>

          {(isDefault || isHeavyCadence(preset)) && (
            <p className="ui-routines__notice" role="status">
              {isDefault
                ? "Default checks use UTC: 00:00, 04:00, 08:00, hourly 09:00–18:00, and 22:00."
                : "Frequent checks may increase processing usage. Draft processes only new material."}
            </p>
          )}
          <p className="ui-routines__note">
            {routine.enabled
              ? nextRun && `Next ${noun}: ${formatAbsolute(nextRun.toISOString(), effectiveTimezone)}`
              : "This routine is paused. Your changes apply when it’s resumed."}
          </p>

          <div className="ui-routines__actions">
            <span className="ui-routines__secondary">
              {editable ? "Applies to your whole workspace." : "You have view-only access to routines."}
            </span>
            {editable && (
              <>
                <button type="button" className="ui-routines__btn" onClick={onClose} disabled={saving}>Cancel</button>
                <button type="submit" className="ui-routines__btn ui-routines__btn--primary" disabled={!canSave}>
                  {saving ? "Saving…" : "Save changes"}
                </button>
              </>
            )}
          </div>
          {error && !error.field && <p className="ui-routines__error" role="alert">{error.message}</p>}
        </form>
      )}

      {routine.updatedByName && <p className="ui-routines__secondary ui-dialog__changed">Last changed by {routine.updatedByName}.</p>}
    </Dialog>
  );
}

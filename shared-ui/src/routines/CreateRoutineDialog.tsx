"use client";

import { DEFAULT_HARNESS_ID, HARNESSES, getHarness, modelLabel, type HarnessId } from "draft-core/harnesses";
import { useId, useMemo, useState } from "react";
import { SectionedPicker } from "../controls/SectionedPicker";
import { Dialog } from "./Dialog";
import { RoutineError } from "./errors";
import { formatAbsolute, isHeavyCadence, previewNextRun } from "./format";
import { ScheduleFields, browserTimezone, presetUsesTime, timezoneOptions, type ScheduleValue } from "./schedule-fields";
import type { CreateRoutineInput } from "./types";

/** Asks for what the routine does, the agent that runs it, and when. Nothing is saved until Create. */
export function CreateRoutineDialog({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (input: CreateRoutineInput) => Promise<void>;
}) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [harness, setHarness] = useState<HarnessId>(DEFAULT_HARNESS_ID);
  const [model, setModel] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ScheduleValue>(() => ({ preset: "daily", time: "09:00", weekday: "mon", timezone: browserTimezone() }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);

  const usesTime = presetUsesTime(schedule.preset);
  const zones = useMemo(() => timezoneOptions(schedule.timezone), [schedule.timezone]);
  const canCreate = title.trim() !== "" && prompt.trim() !== "" && (!usesTime || schedule.time !== "") && !saving;
  const nextRun = previewNextRun({ ...schedule, time: schedule.time || "00:00" });
  const routineHarnesses = HARNESSES.filter((option) => option.routineModes.length > 0);
  const models = getHarness(harness)?.models ?? [];

  async function create() {
    setSaving(true);
    setError(null);
    try {
      await onCreate({
        title: title.trim(),
        prompt: prompt.trim(),
        harness,
        model,
        preset: schedule.preset,
        ...(usesTime ? { time: schedule.time } : {}),
        ...(schedule.preset === "weekly" ? { weekday: schedule.weekday } : {}),
        timezone: schedule.timezone,
      });
    } catch (caught) {
      setError(
        caught instanceof RoutineError
          ? { field: caught.field, message: caught.message }
          : { message: "Could not create this routine. Try again." },
      );
      setSaving(false);
    }
  }

  const fieldError = (field: string) =>
    error?.field === field ? <span className="ui-routines__error" role="alert">{error.message}</span> : null;

  return (
    <Dialog titleId={titleId} onClose={onClose} busy={saving}>
      <header className="ui-dialog__header">
        <h2 id={titleId}>New routine</h2>
        <button type="button" className="ui-routines__btn" aria-label="Close new routine" disabled={saving} onClick={onClose}>Close</button>
      </header>
      <p className="ui-dialog__description">
        An agent runs on this schedule and reads your company brain to answer your request. It cannot change anything.
      </p>

      <form
        className="ui-routines__editor"
        onSubmit={(event) => {
          event.preventDefault();
          if (canCreate) void create();
        }}
      >
        <div className="ui-routines__fields">
          <label className="ui-routines__field ui-routines__field--wide">
            Name
            <input type="text" value={title} maxLength={120} placeholder="Weekly product digest" disabled={saving} autoFocus onChange={(event) => setTitle(event.target.value)} />
            {fieldError("title")}
          </label>
          <label className="ui-routines__field ui-routines__field--wide">
            What should it do?
            <textarea
              value={prompt}
              rows={5}
              maxLength={20000}
              placeholder="Summarize what changed in the product this week and flag anything that looks at risk."
              disabled={saving}
              onChange={(event) => setPrompt(event.target.value)}
            />
            {fieldError("prompt")}
          </label>
          <div className="ui-routines__field ui-routines__field--wide">
            Agent and model
            <div>
              <SectionedPicker
                label="Agent and model"
                sections={[
                  { id: "harness", title: "Harnesses", value: harness, keepOpen: true, onChange: (value) => { setHarness(value as HarnessId); setModel(null); }, options: routineHarnesses.map((option) => ({ value: option.id, label: option.label })) },
                  { id: "model", title: "Models", value: model ?? "", onChange: (value) => setModel(value || null), options: models.map((option) => ({ value: option.alias ?? "", label: option.label })) },
                ]}
              >
                {getHarness(harness)?.label} · {modelLabel(harness, model)}
              </SectionedPicker>
            </div>
            {fieldError("model")}
          </div>
        </div>

        <ScheduleFields value={schedule} onChange={setSchedule} disabled={saving} fieldError={fieldError} zones={zones} />

        {isHeavyCadence(schedule.preset) && (
          <p className="ui-routines__notice" role="status">Hourly runs use your Claude plan every hour.</p>
        )}
        <p className="ui-routines__note">Next run: {formatAbsolute(nextRun.toISOString(), schedule.timezone)}</p>

        <div className="ui-routines__actions">
          <span className="ui-routines__secondary">Applies to your whole workspace.</span>
          <button type="button" className="ui-routines__btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="ui-routines__btn ui-routines__btn--primary" disabled={!canCreate}>
            {saving ? "Creating…" : "Create routine"}
          </button>
        </div>
        {error && !error.field && <p className="ui-routines__error" role="alert">{error.message}</p>}
      </form>
    </Dialog>
  );
}

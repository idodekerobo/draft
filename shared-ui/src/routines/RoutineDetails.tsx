"use client";

import type { HarnessId } from "draft-core/harnesses";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AgentFields, isDisconnected, type AgentStatuses, type AgentValue } from "./AgentFields";
import { Select } from "../controls/Select";
import { AbilityFields, RoutinePreview, capabilitiesOf, capabilitiesValid, capabilityChanges, type CapabilityValue } from "./CapabilityFields";
import { Dialog } from "./Dialog";
import { agentLabel } from "./agent-label";
import { RoutineError } from "./errors";
import { formatAbsolute, isHeavyCadence, previewNextRun, zoneLabel } from "./format";
import { RoutineRuns } from "./RoutineRuns";
import { PRESET_LABELS, SELECTABLE, WEEKDAYS, browserTimezone, presetUsesTime, scheduleSentence, timezoneOptions } from "./schedule-fields";
import type { AgentRoutineEdit, OpenRun, Routine, RoutineAgentStatus, RoutineEventName, RoutinePatch, RoutinePreset, RoutinesResponse, RoutineWeekday } from "./types";
import { WhenFields, triggerPreview, type WhenMode } from "./WhenFields";

export function RoutineDetails({ workspaceId, routine, canEdit, onClose, onSave, onDelete, onOpenRun, agents = {}, connectedProviders, onConnect, renderAgentSetup, refreshAgents }: {
  workspaceId: string;
  routine: Routine;
  canEdit: boolean;
  onClose: () => void;
  onSave: (patch: RoutinePatch) => Promise<void>;
  /** Deletes an agent routine. Without it the Delete action does not show. */
  onDelete?: () => Promise<void>;
  /** Opens a run of an agent routine. Without it the runs are listed but not linked. */
  onOpenRun?: OpenRun;
  /** Whether each agent is connected for this workspace's routines, by harness id. */
  agents?: AgentStatuses;
  connectedProviders?: RoutinesResponse["connectedProviders"];
  /** Opens Connections, for a trigger or ability whose connection is missing. */
  onConnect?: () => void;
  /** Help to connect an agent, shown while it blocks Save. */
  renderAgentSetup?: (harness: HarnessId, status: RoutineAgentStatus, refresh: () => void) => ReactNode;
  refreshAgents?: () => void;
}) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const editable = canEdit && routine.editable === "full";
  const isSynthesis = routine.taskType === "synthesize_workspace";
  const original = useMemo<AgentValue | null>(
    () => routine.agent && { title: routine.title, prompt: routine.agent.prompt, harness: routine.agent.harness, model: routine.agent.model, effort: routine.agent.reasoningEffort ?? null },
    [routine],
  );
  const [agent, setAgent] = useState<AgentValue | null>(original);
  const originalCapabilities = useMemo(() => capabilitiesOf(routine.agent), [routine]);
  const [capabilities, setCapabilities] = useState<CapabilityValue>(originalCapabilities);
  const originalMode: WhenMode = routine.agent?.onSchedule === false ? "events" : "schedule";
  const originalEvents = useMemo(() => routine.agent?.events ?? [], [routine]);
  const [mode, setMode] = useState<WhenMode>(originalMode);
  const [events, setEvents] = useState<RoutineEventName[]>(originalEvents);
  const [preset, setPreset] = useState<RoutinePreset>(routine.preset);
  const [time, setTime] = useState(routine.time ?? "09:00");
  const [weekday, setWeekday] = useState<RoutineWeekday>(routine.weekday ?? "mon");
  const [timezone, setTimezone] = useState(
    routine.preset === "draft_default" || routine.preset === "custom" ? browserTimezone() : routine.timezone,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirmingDelete) keepRef.current?.focus();
  }, [confirmingDelete]);

  const usesTime = presetUsesTime(preset);
  const isDefault = preset === "draft_default";
  const effectiveTimezone = isDefault ? "UTC" : timezone;
  const zones = useMemo(() => timezoneOptions(timezone), [timezone]);
  // The schedule's fields are hidden while it is off, so nothing there can change then.
  const scheduleDirty = mode === "schedule" && (
    preset !== routine.preset ||
    (usesTime && time !== routine.time) ||
    (preset === "weekly" && weekday !== routine.weekday) ||
    (!isDefault && timezone !== routine.timezone));

  const agentEdit: AgentRoutineEdit = {};
  if (agent && original) {
    if (agent.title.trim() !== original.title) agentEdit.title = agent.title.trim();
    if (agent.prompt.trim() !== original.prompt) agentEdit.prompt = agent.prompt.trim();
    if (agent.harness !== original.harness) agentEdit.harness = agent.harness;
    if (agent.harness !== original.harness || agent.model !== original.model) agentEdit.model = agent.model;
    if (agent.harness !== original.harness || agent.model !== original.model || agent.effort !== original.effort) agentEdit.reasoningEffort = agent.effort;
  }
  if (agent && original) {
    Object.assign(agentEdit, capabilityChanges(originalCapabilities, capabilities));
    if (mode !== originalMode) agentEdit.onSchedule = mode === "schedule";
    // A routine runs on its schedule or on triggers, so going back to the schedule clears the triggers.
    const nextEvents = mode === "events" ? events : [];
    if (nextEvents.length !== originalEvents.length || nextEvents.some((event) => !originalEvents.includes(event))) agentEdit.events = nextEvents;
  }
  const agentDirty = Object.keys(agentEdit).length > 0;
  const agentValid = !agent || (agent.title.trim() !== "" && agent.prompt.trim() !== "" && capabilitiesValid(capabilities));
  const blocked = !!agent && !!original && agent.harness !== original.harness && isDisconnected(agents[agent.harness]);
  const scheduleOk = !scheduleDirty || (preset !== "custom" && (!usesTime || time !== ""));
  const canSave = editable && (scheduleDirty || agentDirty) && scheduleOk && agentValid && !blocked && !saving && !deleting;
  const noun = isSynthesis || routine.agent ? "run" : "check";

  const nextRun =
    preset === "custom" || !routine.enabled
      ? null
      : previewNextRun({ preset, time: time || "00:00", weekday, timezone: effectiveTimezone });

  async function save() {
    setSaving(true);
    setError(null);
    const schedule =
      scheduleDirty && preset !== "custom"
        ? { preset, ...(usesTime ? { time } : {}), ...(preset === "weekly" ? { weekday } : {}), ...(!isDefault ? { timezone } : {}) }
        : {};
    try {
      await onSave({ ...agentEdit, ...schedule });
    } catch (caught) {
      setError(
        caught instanceof RoutineError
          ? { field: caught.field, message: caught.message }
          : { message: "Could not save this routine. Try again." },
      );
      setSaving(false);
    }
  }

  async function remove() {
    if (!onDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete();
    } catch (caught) {
      setDeleteError(caught instanceof RoutineError ? caught.message : "Could not delete this routine. Try again.");
      setDeleting(false);
    }
  }

  const fieldError = (field: string) =>
    error?.field === field ? <span className="ui-routines__error" role="alert">{error.message}</span> : null;

  const busy = saving || deleting;
  const scheduleFields = (
    <div className="ui-routines__fields">
      <div className="ui-routines__field">
        Frequency
        <Select<RoutinePreset>
          label="Frequency"
          value={preset}
          disabled={!editable || busy}
          options={[
            ...(routine.preset === "custom" ? [{ value: "custom" as const, label: PRESET_LABELS.custom }] : []),
            ...(isSynthesis || routine.preset === "draft_default" ? [{ value: "draft_default" as const, label: PRESET_LABELS.draft_default }] : []),
            ...SELECTABLE.map((option) => ({ value: option, label: PRESET_LABELS[option] })),
          ]}
          onChange={(next) => {
            setPreset(next);
            setError(null);
          }}
        />
        {fieldError("preset")}
      </div>

      {usesTime && (
        <label className="ui-routines__field">
          Time
          <input type="time" value={time} required disabled={!editable || busy} onChange={(event) => setTime(event.target.value)} />
          {fieldError("time")}
        </label>
      )}

      <div className="ui-routines__field">
        Timezone
        <Select label="Timezone" value={effectiveTimezone} searchable disabled={!editable || busy || isDefault} options={zones.map((zone) => ({ value: zone, label: zone }))} onChange={setTimezone} />
        {fieldError("timezone")}
      </div>

      {preset === "weekly" && (
        <div className="ui-routines__field ui-routines__field--wide">
          Day
          <Select<RoutineWeekday> label="Day" value={weekday} disabled={!editable || busy} options={WEEKDAYS.map(([value, label]) => ({ value, label }))} onChange={setWeekday} />
          {fieldError("weekday")}
        </div>
      )}
    </div>
  );

  const scheduleNotices = (isDefault || isHeavyCadence(preset)) && mode === "schedule" && (
    <p className="ui-routines__notice" role="status">
      {isDefault
        ? "Default checks use UTC: 00:00, 04:00, 08:00, hourly 09:00–18:00, and 22:00."
        : "Frequent checks may increase processing usage. Draft processes only new material."}
    </p>
  );

  const runs = routine.agent && (
    <section className="ui-routines__agent">
      <h3 className="ui-routines__subheading">Runs</h3>
      <RoutineRuns workspaceId={workspaceId} routine={routine} onOpenRun={onOpenRun} />
    </section>
  );
  const agentEditable = editable && !!agent;

  const actions = (
    <>
      <div className="ui-routines__actions">
        <span className="ui-routines__secondary">
          {editable ? "Anyone in your workspace can see, edit and run it." : "You have view-only access to routines."}
        </span>
        {editable && (
          <>
            <button type="button" className="ui-routines__btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="ui-routines__btn ui-routines__btn--primary" disabled={!canSave}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </>
        )}
      </div>
      {error && !error.field && <p className="ui-routines__error" role="alert">{error.message}</p>}
    </>
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSave) void save();
  };

  let body: ReactNode;
  if (routine.agent) {
    const when = !routine.enabled
      ? ["Paused. It won’t run until it’s resumed."]
      : mode === "schedule"
        ? [
            preset === "custom" ? routine.scheduleDescription : `${scheduleSentence({ preset, time, weekday })} (${zoneLabel(effectiveTimezone)})`,
            ...(nextRun ? [`Next run ${formatAbsolute(nextRun.toISOString(), effectiveTimezone)}`] : []),
          ]
        : events.length ? events.map(triggerPreview) : ["Runs only when someone presses Run now"];
    body = (
      <form className="ui-routines__editor" onSubmit={submit}>
        <div className="ui-routine-form">
          <div className="ui-routine-form__edit">
            {agentEditable && agent ? (
              <div className="ui-routines__fields">
                <AgentFields
                  value={agent}
                  onChange={setAgent}
                  disabled={busy}
                  agents={agents}
                  blocked={blocked}
                  renderAgentSetup={renderAgentSetup}
                  refreshAgents={refreshAgents}
                  fieldError={fieldError}
                />
                <WhenFields
                  mode={mode}
                  onModeChange={setMode}
                  events={events}
                  onEventsChange={setEvents}
                  connectedProviders={connectedProviders}
                  onConnect={onConnect}
                  disabled={busy}
                  schedule={scheduleFields}
                />
                <AbilityFields value={capabilities} onChange={setCapabilities} disabled={busy} fieldError={fieldError} connectedProviders={connectedProviders} onConnect={onConnect} />
              </div>
            ) : (
              <section className="ui-routines__agent">
                <h3 className="ui-routines__subheading">Request</h3>
                <p className="ui-routines__prompt">{routine.agent.prompt}</p>
                {routine.agent.createdByName && <p className="ui-routines__secondary">Created by {routine.agent.createdByName}</p>}
              </section>
            )}
            {scheduleNotices}
            {agentDirty && (
              <p className="ui-routines__notice" role="status">Changes apply to the next run. Past runs keep the prompt and agent they ran with.</p>
            )}
          </div>
          <RoutinePreview when={when} agent={agentLabel(agent ?? { ...routine.agent, effort: routine.agent.reasoningEffort })} capabilities={capabilities} />
        </div>
        {actions}
      </form>
    );
  } else if (routine.editable === "toggle_only") {
    body = (
      <div className="ui-dialog__info">
        {routine.connectionLabel && <p>{routine.connectionLabel}</p>}
        <p>
          Checks {routine.scheduleDescription.replace(/^Every/, "every")} ({zoneLabel(routine.timezone)}). Timing is
          managed by Draft. Pause or resume this routine using its toggle in the list.
        </p>
      </div>
    );
  } else {
    body = (
      <form className="ui-routines__editor" onSubmit={submit}>
        {scheduleFields}
        {scheduleNotices}
        <p className="ui-routines__note">
          {routine.enabled
            ? nextRun && `Next ${noun}: ${formatAbsolute(nextRun.toISOString(), effectiveTimezone)}`
            : "This routine is paused. Your changes apply when it’s resumed."}
        </p>
        {actions}
      </form>
    );
  }

  return (
    <Dialog titleId={titleId} onClose={onClose} busy={busy} wide={!!routine.agent}>
      <header className="ui-dialog__header">
        <h2 id={titleId}>{routine.title}</h2>
        <button type="button" className="ui-routines__btn" aria-label="Close routine details" disabled={busy} onClick={onClose}>
          Close
        </button>
      </header>
      <p className="ui-dialog__description">{routine.routineDescription}</p>

      {body}
      {runs}

      {routine.agent && canEdit && onDelete && (
        <section className="ui-routines__danger">
          {confirmingDelete ? (
            <div role="group" aria-label="Confirm delete">
              <p>Delete this routine? It stops running and leaves the list. Its past runs stay.</p>
              <div className="ui-routines__actions">
                <button ref={keepRef} type="button" className="ui-routines__btn" disabled={deleting} onClick={() => { setConfirmingDelete(false); setDeleteError(null); }}>
                  Keep routine
                </button>
                <button type="button" className="ui-routines__btn ui-routines__btn--danger" disabled={busy} onClick={() => void remove()}>
                  {deleting ? "Deleting…" : "Delete routine"}
                </button>
              </div>
              {deleteError && <p className="ui-routines__error" role="alert">{deleteError}</p>}
            </div>
          ) : (
            <button type="button" className="ui-routines__btn ui-routines__btn--danger-quiet" disabled={saving} onClick={() => setConfirmingDelete(true)}>
              Delete routine
            </button>
          )}
        </section>
      )}

      {agentEditable && routine.agent?.createdByName && <p className="ui-routines__secondary ui-dialog__changed">Created by {routine.agent.createdByName}.</p>}
      {routine.updatedByName && <p className="ui-routines__secondary ui-dialog__changed">Last changed by {routine.updatedByName}.</p>}
    </Dialog>
  );
}

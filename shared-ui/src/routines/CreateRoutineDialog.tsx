"use client";

import { DEFAULT_HARNESS_ID, type HarnessId } from "draft-core/harnesses";
import { useId, useMemo, useState, type ReactNode } from "react";
import { AgentFields, isDisconnected, type AgentValue } from "./AgentFields";
import { Dialog } from "./Dialog";
import { RoutineError } from "./errors";
import { formatAbsolute, isHeavyCadence, previewNextRun } from "./format";
import { ScheduleFields, browserTimezone, presetUsesTime, timezoneOptions, type ScheduleValue } from "./schedule-fields";
import type { CreateRoutineInput, RoutineAgentStatus } from "./types";

/** Asks for what the routine does, the agent that runs it, and when. Nothing is saved until Create. */
export function CreateRoutineDialog({ onClose, onCreate, agents = {}, renderAgentSetup, refreshAgents }: {
  onClose: () => void;
  onCreate: (input: CreateRoutineInput) => Promise<void>;
  /** Whether each agent is connected for this workspace's routines, by harness id. */
  agents?: Partial<Record<string, RoutineAgentStatus>>;
  /** Help to connect an agent, shown while it blocks Create. Call `refresh` after a connection changes. Null for an agent with none. */
  renderAgentSetup?: (harness: HarnessId, status: RoutineAgentStatus, refresh: () => void) => ReactNode;
  /** Reads the agents' statuses again. */
  refreshAgents?: () => void;
}) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const [agent, setAgent] = useState<AgentValue>({ title: "", prompt: "", harness: DEFAULT_HARNESS_ID, model: null });
  const [schedule, setSchedule] = useState<ScheduleValue>(() => ({ preset: "daily", time: "09:00", weekday: "mon", timezone: browserTimezone() }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);

  const usesTime = presetUsesTime(schedule.preset);
  const zones = useMemo(() => timezoneOptions(schedule.timezone), [schedule.timezone]);
  const blocked = isDisconnected(agents[agent.harness]);
  const canCreate = agent.title.trim() !== "" && agent.prompt.trim() !== "" && (!usesTime || schedule.time !== "") && !saving && !blocked;
  const nextRun = previewNextRun({ ...schedule, time: schedule.time || "00:00" });

  async function create() {
    setSaving(true);
    setError(null);
    try {
      await onCreate({
        title: agent.title.trim(),
        prompt: agent.prompt.trim(),
        harness: agent.harness,
        model: agent.model,
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
          <AgentFields
            value={agent}
            onChange={setAgent}
            disabled={saving}
            autoFocus
            agents={agents}
            blocked={blocked}
            renderAgentSetup={renderAgentSetup}
            refreshAgents={refreshAgents}
            fieldError={fieldError}
          />
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

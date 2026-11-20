"use client";

import { defaultRoutineBuiltInTools } from "draft-core/routines";
import type { HarnessId } from "draft-core/harnesses";
import { useEffect, useRef, useId, useMemo, useState, type ReactNode, type RefObject } from "react";
import { useDraftTrack } from "../query/api";
import { AgentFields, isDisconnected, type AgentValue } from "./AgentFields";
import { defaultAgent, rememberAgent } from "./agent-default";
import { agentLabel } from "./agent-label";
import { AbilityFields, RoutinePreview, capabilitiesValid, defaultCapabilities, type CapabilityValue } from "./CapabilityFields";
import { Dialog } from "./Dialog";
import { RoutineError } from "./errors";
import { formatAbsolute, isHeavyCadence, previewNextRun, zoneLabel } from "./format";
import { ScheduleFields, browserTimezone, presetUsesTime, scheduleInput, scheduleSentence, timezoneOptions, type ScheduleValue } from "./schedule-fields";
import type { CreateRoutineInput, RoutineAgentStatus, RoutineEventName, RoutinesResponse } from "./types";
import { WhenFields, triggerPreview, type WhenMode } from "./WhenFields";

/** Asks what the routine does, which agent runs it, when, and what it may reach. Nothing is saved until Create. */
export function CreateRoutineDialog({ onClose, onCreate, agents = {}, connectedProviders, gmailConnected, onConnect, renderAgentSetup, refreshAgents, returnFocusTo }: {
  onClose: () => void;
  onCreate: (input: CreateRoutineInput) => Promise<void>;
  /** Whether each agent is connected for this workspace's routines, by harness id. */
  agents?: Partial<Record<string, RoutineAgentStatus>>;
  connectedProviders?: RoutinesResponse["connectedProviders"];
  gmailConnected?: RoutinesResponse["gmailConnected"];
  /** Opens Connections, for a trigger or ability whose connection is missing. */
  onConnect?: () => void;
  /** Help to connect an agent, shown while it blocks Create. Call `refresh` after a connection changes. Null for an agent with none. */
  renderAgentSetup?: (harness: HarnessId, status: RoutineAgentStatus, refresh: () => void) => ReactNode;
  /** Reads the agents' statuses again. */
  refreshAgents?: () => void;
  /** The button that opened the dialog. Focus returns to it on close. */
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const track = useDraftTrack();
  const reported = useRef(false);
  useEffect(() => {
    if (!reported.current) { reported.current = true; track("routine_setup_started", {}); }
  }, [track]);
  const ids = useId();
  const titleId = `${ids}-title`;
  const [agent, setAgent] = useState<AgentValue>(() => ({ title: "", prompt: "", ...defaultAgent(agents) }));
  const [mode, setMode] = useState<WhenMode>("schedule");
  const [events, setEvents] = useState<RoutineEventName[]>([]);
  const [schedule, setSchedule] = useState<ScheduleValue>(() => ({ preset: "daily", time: "09:00", weekday: "mon", timezone: browserTimezone() }));
  const [capabilities, setCapabilities] = useState<CapabilityValue>(() => defaultCapabilities(connectedProviders, agent.harness));
  // Each harness has its own built-in tools, so a new harness starts with all of its own.
  const toolsHarness = useRef(agent.harness);
  useEffect(() => {
    if (toolsHarness.current === agent.harness) return;
    toolsHarness.current = agent.harness;
    setCapabilities((current) => ({ ...current, builtInTools: defaultRoutineBuiltInTools(agent.harness) }));
  }, [agent.harness]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);

  const onSchedule = mode === "schedule";
  const usesTime = presetUsesTime(schedule.preset);
  const zones = useMemo(() => timezoneOptions(schedule.timezone), [schedule.timezone]);
  const blocked = isDisconnected(agents[agent.harness]);
  const canCreate = agent.title.trim() !== "" && agent.prompt.trim() !== "" && (!onSchedule || !usesTime || schedule.time !== "") && capabilitiesValid(capabilities) && !saving && !blocked;
  const nextRun = previewNextRun({ ...schedule, time: schedule.time || "00:00" });

  const when = onSchedule
    ? [`${scheduleSentence(schedule)} (${zoneLabel(schedule.timezone)})`, `Next run ${formatAbsolute(nextRun.toISOString(), schedule.timezone)}`]
    : events.length ? events.map(triggerPreview) : ["Runs only when someone presses Run now"];

  async function create() {
    setSaving(true);
    setError(null);
    try {
      await onCreate({
        title: agent.title.trim(),
        prompt: agent.prompt.trim(),
        harness: agent.harness,
        model: agent.model,
        reasoningEffort: agent.effort,
        when: onSchedule ? { schedule: scheduleInput(schedule) } : { schedule: null, events },
        ...(capabilities.canNotify ? { canNotify: true } : {}),
        ...(capabilities.canReadGmail ? { canReadGmail: true } : {}),
        ...(capabilities.postChannels ? { postChannels: capabilities.postChannels } : {}),
        ...(capabilities.github ? { github: capabilities.github } : {}),
        builtInTools: capabilities.builtInTools,
      });
      rememberAgent({ harness: agent.harness, model: agent.model, effort: agent.effort });
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
    <Dialog titleId={titleId} onClose={onClose} busy={saving} wide returnFocusTo={returnFocusTo}>
      <header className="ui-dialog__header">
        <h2 id={titleId}>New routine</h2>
        <button type="button" className="ui-routines__btn" aria-label="Close new routine" disabled={saving} onClick={onClose}>Close</button>
      </header>

      <form
        className="ui-routines__editor"
        onSubmit={(event) => {
          event.preventDefault();
          if (canCreate) void create();
        }}
      >
        <div className="ui-routine-form">
          <div className="ui-routine-form__edit">
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
              <WhenFields
                mode={mode}
                onModeChange={setMode}
                events={events}
                onEventsChange={setEvents}
                connectedProviders={connectedProviders}
                onConnect={onConnect}
                disabled={saving}
                fieldError={fieldError}
                schedule={<ScheduleFields value={schedule} onChange={setSchedule} disabled={saving} fieldError={fieldError} zones={zones} />}
              />
              <AbilityFields harness={agent.harness} value={capabilities} onChange={setCapabilities} disabled={saving} fieldError={fieldError} connectedProviders={connectedProviders} gmailConnected={gmailConnected} onConnect={onConnect} />
            </div>
            {onSchedule && isHeavyCadence(schedule.preset) && (
              <p className="ui-routines__notice" role="status">Hourly runs use your agent plan every hour.</p>
            )}
          </div>

          <RoutinePreview when={when} agent={agentLabel({ ...agent, effort: agent.effort })} capabilities={capabilities} />
        </div>

        <div className="ui-routines__actions">
          <span className="ui-routines__secondary">Anyone in your workspace can see, edit and run it.</span>
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

"use client";

import { HARNESSES, getHarness, modelLabel, type HarnessId } from "draft-core/harnesses";
import type { ReactNode } from "react";
import { SectionedPicker } from "../controls/SectionedPicker";
import type { RoutineAgentStatus } from "./types";

/** What an agent routine does and which agent runs it. */
export interface AgentValue {
  title: string;
  prompt: string;
  harness: HarnessId;
  model: string | null;
}

export type AgentStatuses = Partial<Record<string, RoutineAgentStatus>>;

export const isDisconnected = (status: RoutineAgentStatus | undefined): status is "not_connected" | "needs_reconnect" =>
  status === "not_connected" || status === "needs_reconnect";

/** The fields shared by the new routine dialog and the routine editor. Render them inside `.ui-routines__fields`. */
export function AgentFields({ value, onChange, disabled, autoFocus, agents, blocked, renderAgentSetup, refreshAgents, fieldError }: {
  value: AgentValue;
  onChange: (value: AgentValue) => void;
  disabled: boolean;
  autoFocus?: boolean;
  agents: AgentStatuses;
  /** True when the chosen agent cannot run the routine yet. The connect help shows then. */
  blocked: boolean;
  renderAgentSetup?: (harness: HarnessId, status: RoutineAgentStatus, refresh: () => void) => ReactNode;
  refreshAgents?: () => void;
  fieldError: (field: string) => ReactNode;
}) {
  const { title, prompt, harness, model } = value;
  const status = agents[harness];
  const routineHarnesses = HARNESSES.filter((option) => option.routineModes.length > 0);
  const models = getHarness(harness)?.models ?? [];

  return (
    <>
      <label className="ui-routines__field ui-routines__field--wide">
        Name
        <input type="text" value={title} maxLength={120} placeholder="Weekly product digest" disabled={disabled} autoFocus={autoFocus} onChange={(event) => onChange({ ...value, title: event.target.value })} />
        {fieldError("title")}
      </label>
      <label className="ui-routines__field ui-routines__field--wide">
        What should it do?
        <textarea
          value={prompt}
          rows={5}
          maxLength={20000}
          placeholder="Summarize what changed in the product this week and flag anything that looks at risk."
          disabled={disabled}
          onChange={(event) => onChange({ ...value, prompt: event.target.value })}
        />
        {fieldError("prompt")}
      </label>
      <div className="ui-routines__field ui-routines__field--wide">
        Agent and model
        <div>
          <SectionedPicker
            label="Agent and model"
            sections={[
              { id: "harness", title: "Harnesses", value: harness, keepOpen: true, onChange: (next) => onChange({ ...value, harness: next as HarnessId, model: null }), options: routineHarnesses.map((option) => ({ value: option.id, label: option.label, hint: isDisconnected(agents[option.id]) ? "Connect" : undefined })) },
              { id: "model", title: "Models", value: model ?? "", onChange: (next) => onChange({ ...value, model: next || null }), options: models.map((option) => ({ value: option.alias ?? "", label: option.label })) },
            ]}
          >
            {getHarness(harness)?.label} · {modelLabel(harness, model)}
          </SectionedPicker>
        </div>
        {fieldError("harness")}
        {fieldError("model")}
        {blocked && status && (
          (renderAgentSetup?.(harness, status, refreshAgents ?? (() => {})) ?? null) ?? (
            <p className="ui-routines__notice" role="status">
              {getHarness(harness)?.label} is not connected for routines. Connect it in the Draft desktop app, under Settings, then Agents.
            </p>
          )
        )}
      </div>
    </>
  );
}

"use client";

import { ROUTINE_TRIGGERS } from "draft-core/routines";
import { useId, type ReactNode } from "react";
import type { RoutineEventName, RoutinesResponse } from "./types";

/** How a routine starts: on its schedule, or when something happens. Run now works either way. */
export type WhenMode = "schedule" | "events";

export const triggerLabel = (event: RoutineEventName) => ROUTINE_TRIGGERS.find((trigger) => trigger.event === event)?.label ?? event;
export const triggerPreview = (event: RoutineEventName) => ROUTINE_TRIGGERS.find((trigger) => trigger.event === event)?.preview ?? event;

/** Items in their registry order, one group per provider. */
export function groupByProvider<T extends { provider: string; providerLabel: string }>(items: ReadonlyArray<T>) {
  const groups: Array<{ provider: string; providerLabel: string; items: T[] }> = [];
  for (const item of items) {
    const group = groups.find((entry) => entry.provider === item.provider);
    if (group) group.items.push(item);
    else groups.push({ provider: item.provider, providerLabel: item.providerLabel, items: [item] });
  }
  return groups;
}

/**
 * The single "When it runs" section. `schedule` is the caller's schedule fields, shown in schedule mode.
 * A trigger whose connection is missing offers to connect it instead of a checkbox.
 */
export function WhenFields({ mode, onModeChange, events, onEventsChange, schedule, connectedProviders, onConnect, disabled, fieldError }: {
  mode: WhenMode;
  onModeChange: (mode: WhenMode) => void;
  events: RoutineEventName[];
  onEventsChange: (events: RoutineEventName[]) => void;
  schedule: ReactNode;
  connectedProviders: RoutinesResponse["connectedProviders"];
  /** Opens Connections. Without it a missing connection is only named. */
  onConnect?: () => void;
  disabled: boolean;
  fieldError: (field: string) => ReactNode;
}) {
  const name = useId();
  const connected = (provider: string) => !connectedProviders || connectedProviders.includes(provider);

  return (
    <fieldset className="ui-routines__field ui-routines__field--wide ui-routines__group ui-routines__when-group">
      <legend>When it runs</legend>
      <div className="ui-routines__segmented" role="radiogroup" aria-label="When it runs">
        {([["schedule", "On a schedule"], ["events", "When something happens"]] as const).map(([value, label]) => (
          <label key={value} className="ui-routines__segment">
            <input type="radio" name={name} value={value} checked={mode === value} disabled={disabled} onChange={() => onModeChange(value)} />
            <span>{label}</span>
          </label>
        ))}
      </div>

      {mode === "schedule" ? schedule : (
        <div className="ui-routines__triggers">
          {groupByProvider(ROUTINE_TRIGGERS).map(({ provider, providerLabel, items }) => (
            <div key={provider} className="ui-routines__provider-group" role="group" aria-label={providerLabel}>
              <p className="ui-routines__provider-name">{providerLabel}</p>
              {connected(provider) ? items.map((trigger) => (
                <label key={trigger.event} className="ui-routines__check">
                  <input
                    type="checkbox"
                    checked={events.includes(trigger.event)}
                    disabled={disabled}
                    onChange={(event) => onEventsChange(event.target.checked ? [...events, trigger.event] : events.filter((name) => name !== trigger.event))}
                  />
                  {trigger.label}
                </label>
              )) : (
                <div className="ui-routines__trigger-missing">
                  <span className="ui-routines__secondary">Connect {providerLabel} to start a routine when {items.map((trigger) => trigger.label[0]!.toLowerCase() + trigger.label.slice(1)).join(", or ")}.</span>
                  {onConnect && <button type="button" className="ui-routines__text-button" onClick={onConnect}>Connect {providerLabel}</button>}
                </div>
              )}
            </div>
          ))}
          {events.length === 0 && <p className="ui-routines__secondary">With no trigger picked, it runs only when someone presses Run now.</p>}
        </div>
      )}
      {fieldError("events")}
      {fieldError("when")}
    </fieldset>
  );
}

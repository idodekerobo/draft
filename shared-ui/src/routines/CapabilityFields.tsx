"use client";

import { useQuery } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { useDraftApi } from "../query/api";
import type { AgentRoutine, RoutineEventName } from "./types";

/** What a routine may do beyond reading context, and the events that also start it. */
export interface CapabilityValue {
  events: RoutineEventName[];
  canNotify: boolean;
  /** Null when the routine may not post in Slack. */
  postChannels: "joined" | string[] | null;
}

export const capabilitiesOf = (agent: Pick<AgentRoutine, "events" | "canNotify" | "postChannels"> | null): CapabilityValue => ({
  events: agent?.events ?? [],
  canNotify: agent?.canNotify ?? false,
  postChannels: agent?.postChannels ?? null,
});

export const NO_CAPABILITIES: CapabilityValue = { events: [], canNotify: false, postChannels: null };

const sameChannels = (a: CapabilityValue["postChannels"], b: CapabilityValue["postChannels"]) =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((channel) => b.includes(channel)));

/** Only the fields that changed. Null for postChannels turns posting off. */
export function capabilityChanges(original: CapabilityValue, next: CapabilityValue): Partial<CapabilityValue> {
  const changes: Partial<CapabilityValue> = {};
  if (next.events.length !== original.events.length || next.events.some((event) => !original.events.includes(event))) changes.events = next.events;
  if (next.canNotify !== original.canNotify) changes.canNotify = next.canNotify;
  if (!sameChannels(original.postChannels, next.postChannels)) changes.postChannels = next.postChannels;
  return changes;
}

/** "Only these channels" with none picked would allow posting nowhere, so it can't be saved. */
export const capabilitiesValid = (value: CapabilityValue) => !(Array.isArray(value.postChannels) && value.postChannels.length === 0);

/** A plain sentence for a person who can see the routine but not change it. */
export function describeCapabilities(value: CapabilityValue): string {
  const parts = ["Reads your team’s context"];
  if (value.canNotify) parts.push("messages teammates on Slack");
  if (value.postChannels === "joined") parts.push("posts in any Slack channel Draft is in");
  else if (value.postChannels) parts.push(`posts in ${value.postChannels.join(", ")}`);
  if (value.events.includes("fireflies.meeting_summarized")) parts.push("also runs when a Fireflies meeting is summarized");
  return `${parts.join(", ")}.`;
}

/** The events that start a run besides the schedule. Render inside `.ui-routines__fields`. */
export function TriggerFields({ value, onChange, disabled }: { value: CapabilityValue; onChange: (value: CapabilityValue) => void; disabled: boolean }) {
  const fireflies = value.events.includes("fireflies.meeting_summarized");
  return (
    <fieldset className="ui-routines__field ui-routines__field--wide ui-routines__group">
      <legend>Also run when</legend>
      <label className="ui-routines__check">
        <input
          type="checkbox"
          checked={fireflies}
          disabled={disabled}
          onChange={(event) => onChange({
            ...value,
            events: event.target.checked ? [...value.events, "fireflies.meeting_summarized"] : value.events.filter((name) => name !== "fireflies.meeting_summarized"),
          })}
        />
        A Fireflies meeting is summarized
      </label>
      <label className="ui-routines__check">
        <input type="checkbox" checked={false} disabled />
        An email arrives <span className="ui-routines__secondary">Coming soon</span>
      </label>
    </fieldset>
  );
}

function SlackChannelPicker({ selected, onChange, disabled }: { selected: string[]; onChange: (channels: string[]) => void; disabled: boolean }) {
  const api = useDraftApi();
  const channels = useQuery({
    queryKey: ["routine-slack-channels"],
    queryFn: () => api.getRoutineSlackChannels!(),
    enabled: !!api.getRoutineSlackChannels,
    staleTime: 60_000,
  });
  if (channels.isPending) return <p className="ui-routines__secondary" role="status">Loading channels…</p>;
  if (channels.isError) {
    return (
      <p className="ui-routines__error" role="alert">
        Couldn’t load Slack channels. <button type="button" className="ui-routines__text-button" onClick={() => void channels.refetch()}>Try again</button>
      </p>
    );
  }
  if (channels.data.length === 0) return <p className="ui-routines__secondary">Draft isn’t in any Slack channels yet. Invite the Draft app to a channel first.</p>;
  // A saved name the bot is no longer in still shows, so a person can remove it.
  const known = new Set(channels.data.map((channel) => `#${channel.name}`));
  const missing = selected.filter((channel) => !known.has(channel));
  return (
    <div className="ui-routines__channel-list">
      {[...channels.data.map((channel) => `#${channel.name}`), ...missing].map((name) => (
        <label key={name} className="ui-routines__check">
          <input
            type="checkbox"
            checked={selected.includes(name)}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked ? [...selected, name] : selected.filter((channel) => channel !== name))}
          />
          {name}
          {!known.has(name) && <span className="ui-routines__secondary">Draft left this channel</span>}
        </label>
      ))}
    </div>
  );
}

/** Collapsed by default. Every ability is off until a person turns it on. */
export function CapabilityFields({ value, onChange, disabled, fieldError, initiallyOpen = false }: {
  value: CapabilityValue;
  onChange: (value: CapabilityValue) => void;
  disabled: boolean;
  fieldError: (field: string) => ReactNode;
  initiallyOpen?: boolean;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(initiallyOpen);
  const posting = value.postChannels !== null;
  const onlySome = Array.isArray(value.postChannels);

  return (
    <div className="ui-routines__field ui-routines__field--wide">
      <button type="button" className="ui-routines__disclosure" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
        What it can do
        <span className="ui-routines__secondary">{describeCapabilities(value)}</span>
      </button>
      <div id={panelId} className="ui-routines__panel" hidden={!open}>
        <p className="ui-routines__secondary">Reads your team’s context and shared sources.</p>
        <label className="ui-routines__check">
          <input type="checkbox" checked={value.canNotify} disabled={disabled} onChange={(event) => onChange({ ...value, canNotify: event.target.checked })} />
          Message teammates on Slack
        </label>
        {fieldError("canNotify")}
        <label className="ui-routines__check">
          <input type="checkbox" checked={posting} disabled={disabled} onChange={(event) => onChange({ ...value, postChannels: event.target.checked ? "joined" : null })} />
          Post in Slack
        </label>
        {posting && (
          <fieldset className="ui-routines__group ui-routines__group--nested">
            <legend className="ui-routines__visually-hidden">Where it may post</legend>
            <label className="ui-routines__check">
              <input type="radio" checked={!onlySome} disabled={disabled} onChange={() => onChange({ ...value, postChannels: "joined" })} />
              Any channel Draft is in
            </label>
            <label className="ui-routines__check">
              <input type="radio" checked={onlySome} disabled={disabled} onChange={() => onChange({ ...value, postChannels: [] })} />
              Only these channels
            </label>
            {onlySome && (
              <SlackChannelPicker selected={value.postChannels as string[]} disabled={disabled} onChange={(channels) => onChange({ ...value, postChannels: channels })} />
            )}
            {!capabilitiesValid(value) && <p className="ui-routines__error" role="alert">Pick at least one channel.</p>}
            <p className="ui-routines__secondary">You can also name a channel in the instructions.</p>
          </fieldset>
        )}
        {fieldError("postChannels")}
      </div>
    </div>
  );
}

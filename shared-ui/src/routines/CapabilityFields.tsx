"use client";

import { useQuery } from "@tanstack/react-query";
import { defaultRoutineBuiltInTools, routineBuiltInTools, ROUTINE_ALWAYS_ON_TOOLS, ROUTINE_BUILT_IN_TOOLS } from "draft-core/routines";
import { getHarness } from "draft-core/harnesses";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useDraftApi } from "../query/api";
import type { AgentRoutine } from "./types";

/** What a routine may do beyond reading context. Every ability is off until a person turns it on. */
export interface CapabilityValue {
  canNotify: boolean;
  /** Searches and reads the owner's own Gmail. */
  canReadGmail: boolean;
  /** Null when the routine may not post in Slack. */
  postChannels: "joined" | string[] | null;
  /** Null when the routine may not touch GitHub. */
  github: { repos: string[]; access: "read" | "write" } | null;
  /** The harness's built-in tools it may use. */
  builtInTools: string[];
}

export const capabilitiesOf = (agent: Pick<AgentRoutine, "canNotify" | "canReadGmail" | "postChannels" | "github" | "builtInTools"> | null): CapabilityValue => ({
  canNotify: agent?.canNotify ?? false,
  canReadGmail: agent?.canReadGmail ?? false,
  postChannels: agent?.postChannels ?? null,
  github: agent?.github ?? null,
  builtInTools: agent?.builtInTools ?? [],
});

export const NO_CAPABILITIES: CapabilityValue = { canNotify: false, canReadGmail: false, postChannels: null, github: null, builtInTools: [] };

const sameTools = (a: string[], b: string[]) => a.length === b.length && a.every((tool) => b.includes(tool));

const sameGithub = (a: CapabilityValue["github"], b: CapabilityValue["github"]) =>
  a === b || (!!a && !!b && a.access === b.access && a.repos.length === b.repos.length && a.repos.every((repo) => b.repos.includes(repo)));

const sameChannels = (a: CapabilityValue["postChannels"], b: CapabilityValue["postChannels"]) =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((channel) => b.includes(channel)));

/** Only the fields that changed. Null for postChannels or github turns that ability off. */
export function capabilityChanges(original: CapabilityValue, next: CapabilityValue): Partial<CapabilityValue> {
  const changes: Partial<CapabilityValue> = {};
  if (next.canNotify !== original.canNotify) changes.canNotify = next.canNotify;
  if (next.canReadGmail !== original.canReadGmail) changes.canReadGmail = next.canReadGmail;
  if (!sameChannels(original.postChannels, next.postChannels)) changes.postChannels = next.postChannels;
  if (!sameGithub(original.github, next.github)) changes.github = next.github;
  if (!sameTools(original.builtInTools, next.builtInTools)) changes.builtInTools = next.builtInTools;
  return changes;
}

const channelsValid = (value: CapabilityValue) => !(Array.isArray(value.postChannels) && value.postChannels.length === 0);
const githubValid = (value: CapabilityValue) => !(value.github && value.github.repos.length === 0);

/** "Only these channels" or GitHub with nothing picked would allow nothing, so it can't be saved. */
export const capabilitiesValid = (value: CapabilityValue) => channelsValid(value) && githubValid(value);

/** One line per thing the routine may touch, in plain words. Reading context is always first. */
export function accessLines(value: CapabilityValue): string[] {
  const lines = ["Reads your team’s context and shared sources"];
  if (value.canNotify) lines.push("Messages teammates on Slack");
  if (value.canReadGmail) lines.push("Searches and reads your Gmail");
  if (value.postChannels === "joined") lines.push("Posts in any Slack channel Draft is in");
  else if (value.postChannels?.length) lines.push(`Posts in ${value.postChannels.join(", ")}`);
  const toolLabels = Object.values(ROUTINE_BUILT_IN_TOOLS).flat().filter((entry) => value.builtInTools.includes(entry.tool)).map((entry) => entry.label.toLowerCase());
  if (toolLabels.length) lines.push(`Can ${toolLabels.join(", ")}`);
  if (value.github?.repos.length) lines.push(`${value.github.access === "write" ? "Pushes branches and opens pull requests in" : "Reads code in"} ${value.github.repos.join(", ")}`);
  return lines;
}

/** The right column: what the routine will do and what it can reach, updated as the person edits. */
export function RoutinePreview({ when, agent, capabilities }: {
  /** Sentences about when it runs, such as the schedule and the next run. */
  when: string[];
  agent: string;
  capabilities: CapabilityValue;
}) {
  return (
    <aside className="ui-routine-preview" aria-label="What this routine will do">
      <h3 className="ui-routines__subheading">What it will do</h3>
      <ul className="ui-routine-preview__list">
        {when.map((line) => <li key={line}>{line}</li>)}
        <li>Runs on {agent}</li>
      </ul>
      <h3 className="ui-routines__subheading">What it can reach</h3>
      <ul className="ui-routine-preview__list" aria-live="polite">
        {accessLines(capabilities).map((line) => <li key={line}>{line}</li>)}
      </ul>
    </aside>
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

function GithubRepoPicker({ value, onChange, disabled }: { value: NonNullable<CapabilityValue["github"]>; onChange: (value: NonNullable<CapabilityValue["github"]>) => void; disabled: boolean }) {
  const api = useDraftApi();
  const repos = useQuery({
    queryKey: ["routine-github-repos"],
    queryFn: () => api.getRoutineGithubRepos!(),
    enabled: !!api.getRoutineGithubRepos,
    staleTime: 60_000,
  });
  return (
    <fieldset className="ui-routines__group ui-routines__group--nested">
      <legend className="ui-routines__visually-hidden">GitHub access</legend>
      <label className="ui-routines__check">
        <input type="radio" checked={value.access === "read"} disabled={disabled} onChange={() => onChange({ ...value, access: "read" })} />
        Read code
      </label>
      <label className="ui-routines__check">
        <input type="radio" checked={value.access === "write"} disabled={disabled} onChange={() => onChange({ ...value, access: "write" })} />
        Push branches and open pull requests
      </label>
      {repos.isPending && <p className="ui-routines__secondary" role="status">Loading repositories…</p>}
      {repos.isError && (
        <p className="ui-routines__error" role="alert">
          Couldn’t load repositories. <button type="button" className="ui-routines__text-button" onClick={() => void repos.refetch()}>Try again</button>
        </p>
      )}
      {repos.data?.length === 0 && <p className="ui-routines__secondary">Connect GitHub in Connections and give Draft access to a repository first.</p>}
      {!!repos.data?.length && (
        <div className="ui-routines__channel-list">
          {[...new Set([...repos.data, ...value.repos])].map((repo) => (
            <label key={repo} className="ui-routines__check">
              <input
                type="checkbox"
                checked={value.repos.includes(repo)}
                disabled={disabled}
                onChange={(event) => onChange({ ...value, repos: event.target.checked ? [...value.repos, repo] : value.repos.filter((name) => name !== repo) })}
              />
              {repo}
              {!repos.data.includes(repo) && <span className="ui-routines__secondary">No longer shared with Draft</span>}
            </label>
          ))}
        </div>
      )}
      {value.repos.length === 0 && <p className="ui-routines__error" role="alert">Pick at least one repository.</p>}
    </fieldset>
  );
}

/** What a new routine may do: everything its connections offer, except GitHub, which needs repos picked first. */
export function defaultCapabilities(connectedProviders?: ReadonlyArray<string>, harness = "claude"): CapabilityValue {
  const slack = !!connectedProviders?.includes("slack");
  return { canNotify: slack, canReadGmail: false, postChannels: slack ? "joined" : null, github: null, builtInTools: defaultRoutineBuiltInTools(harness) };
}

/** A checkbox that can show a mixed state, which HTML sets only from script. */
function MixedCheckbox({ state, label, disabled, onChange }: { state: "all" | "some" | "none"; label: string; disabled: boolean; onChange: (on: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={state === "all"} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />;
}

/** The harness's built-in tools: one box for all of them, which opens to pick each. */
function BuiltInToolsField({ harness, value, disabled, onChange }: { harness: string; value: string[]; disabled: boolean; onChange: (tools: string[]) => void }) {
  const offered = routineBuiltInTools(harness);
  if (offered.length === 0) return null;
  const on = offered.filter((entry) => value.includes(entry.tool));
  const state = on.length === 0 ? "none" : on.length === offered.length ? "all" : "some";
  const label = `Enable ${getHarness(harness)?.label ?? harness} built-in tools`;
  const alwaysOn = (ROUTINE_ALWAYS_ON_TOOLS as Record<string, ReadonlyArray<{ tool: string; label: string }>>)[harness] ?? [];
  const name = (entry: { tool: string; label: string }, hint?: string) => (
    <span className="ui-routines__tool-name">
      {entry.label} <code>{entry.tool}</code>
      {hint && <span className="ui-routines__secondary">{hint}</span>}
    </span>
  );
  return (
    <details className="ui-routines__builtins">
      <summary className="ui-routines__builtins-summary">
        <span className="ui-routines__builtins-chevron" aria-hidden="true">▸</span>
        <MixedCheckbox state={state} label={label} disabled={disabled} onChange={(all) => onChange(all ? offered.map((entry) => entry.tool) : [])} />
        <span className="ui-routines__builtins-label">
          {label} <span className="ui-routines__secondary">{on.length} of {offered.length}</span>
        </span>
      </summary>
      <div className="ui-routines__builtins-list">
        {offered.map((entry) => (
          <label key={entry.tool} className="ui-routines__check">
            <input
              type="checkbox"
              checked={value.includes(entry.tool)}
              disabled={disabled}
              onChange={(event) => onChange(event.target.checked ? offered.map((o) => o.tool).filter((tool) => tool === entry.tool || value.includes(tool)) : value.filter((tool) => tool !== entry.tool))}
            />
            {name(entry)}
          </label>
        ))}
        {alwaysOn.map((entry) => (
          <label key={entry.tool} className="ui-routines__check ui-routines__check--locked">
            <input type="checkbox" checked disabled />
            {name(entry, "Always on")}
          </label>
        ))}
      </div>
    </details>
  );
}

function slackShort(value: CapabilityValue): string {
  return [value.postChannels ? "posts" : null, value.canNotify ? "messages" : null].filter(Boolean).join(", ");
}

/**
 * What the routine may do, grouped by connection. Collapsed it shows one row of what is on; expanded,
 * each connection's actions can be changed. A connection that is missing offers to connect it.
 */
export function AbilityFields({ value, onChange, disabled, fieldError, connectedProviders, gmailConnected, gmailOwnerName, onConnect, harness = "claude" }: {
  /** The routine's harness, whose built-in tools it lists. */
  harness?: string;
  value: CapabilityValue;
  onChange: (value: CapabilityValue) => void;
  disabled: boolean;
  fieldError: (field: string) => ReactNode;
  connectedProviders?: ReadonlyArray<string>;
  /** The routine owner's own Gmail, which is personal and never comes from connectedProviders. */
  gmailConnected?: boolean;
  /** Set when the viewer is not the owner: the routine reads this person's Gmail, and only they can connect it. */
  gmailOwnerName?: string | null;
  onConnect?: () => void;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const connected = (provider: string) => !connectedProviders || connectedProviders.includes(provider) || (provider === "slack" ? !!value.postChannels || value.canNotify : !!value.github);
  // A saved routine that already reads Gmail keeps its checkbox, so a person can turn it off.
  const gmailReady = gmailConnected !== false || value.canReadGmail;
  const ownerLabel = gmailOwnerName || "the owner";
  const posting = value.postChannels !== null;
  const onlySome = Array.isArray(value.postChannels);
  const pill = (label: string, isConnected: boolean, on: string) => (
    <li className={`ui-routines__pill${isConnected && on ? "" : " ui-routines__pill--off"}`}>{!isConnected ? `${label} not connected` : on ? `${label} · ${on}` : `${label} off`}</li>
  );
  const missing = (label: string) => (
    <div className="ui-routines__trigger-missing">
      <span className="ui-routines__secondary">Not connected</span>
      {onConnect && <button type="button" className="ui-routines__text-button" onClick={onConnect}>Connect {label}</button>}
    </div>
  );

  return (
    <div className="ui-routines__field ui-routines__field--wide ui-routines__abilities">
      <div className="ui-routines__abilities-header">
        <span>What it can do</span>
        <button type="button" className="ui-routines__text-button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
          {open ? "Done" : "Edit access"}
        </button>
      </div>

      {/* One row of what is on. The preview beside the form spells it out, so this stays short. */}
      {!open && (
        <ul className="ui-routines__ability-pills" aria-label="What it can do now">
          <li className="ui-routines__pill">Draft</li>
          {routineBuiltInTools(harness).length > 0 && (
            <li className={`ui-routines__pill${value.builtInTools.length ? "" : " ui-routines__pill--off"}`}>
              {`Built-in tools · ${value.builtInTools.length} of ${routineBuiltInTools(harness).length}`}
            </li>
          )}
          {pill("Slack", connected("slack"), slackShort(value))}
          {pill("GitHub", connected("github"), value.github ? (value.github.access === "write" ? "opens PRs" : "reads repos") : "")}
          {gmailOwnerName === undefined
            ? pill("Gmail", gmailReady, value.canReadGmail ? "reads your mail" : "")
            : <li className={`ui-routines__pill${gmailReady && value.canReadGmail ? "" : " ui-routines__pill--off"}`}>{!gmailReady ? `${ownerLabel}'s Gmail not connected` : value.canReadGmail ? `Gmail · reads ${ownerLabel}'s mail` : "Gmail off"}</li>}
        </ul>
      )}

      <div id={panelId} className="ui-routines__panel" hidden={!open}>
        <div className="ui-routines__provider-group" role="group" aria-label="Draft">
          <p className="ui-routines__provider-name">Draft</p>
          <p className="ui-routines__secondary">Always reads your team’s context and shared sources.</p>
        </div>

        <div className="ui-routines__provider-group" role="group" aria-label="Built-in tools">
          <p className="ui-routines__provider-name">Built-in tools</p>
          <BuiltInToolsField harness={harness} value={value.builtInTools} disabled={disabled} onChange={(builtInTools) => onChange({ ...value, builtInTools })} />
        </div>

        <div className="ui-routines__provider-group" role="group" aria-label="Slack">
          <p className="ui-routines__provider-name">Slack</p>
          {connected("slack") ? (
            <>
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
                  {!channelsValid(value) && <p className="ui-routines__error" role="alert">Pick at least one channel.</p>}
                  <p className="ui-routines__secondary">You can also name a channel in the instructions.</p>
                </fieldset>
              )}
              <label className="ui-routines__check">
                <input type="checkbox" checked={value.canNotify} disabled={disabled} onChange={(event) => onChange({ ...value, canNotify: event.target.checked })} />
                Message teammates on Slack
              </label>
            </>
          ) : missing("Slack")}
        </div>

        <div className="ui-routines__provider-group" role="group" aria-label="GitHub">
          <p className="ui-routines__provider-name">GitHub</p>
          {connected("github") ? (
            <>
              <label className="ui-routines__check">
                <input type="checkbox" checked={value.github !== null} disabled={disabled} onChange={(event) => onChange({ ...value, github: event.target.checked ? { repos: [], access: "read" } : null })} />
                Work in GitHub repos
              </label>
              {value.github && <GithubRepoPicker value={value.github} disabled={disabled} onChange={(github) => onChange({ ...value, github })} />}
            </>
          ) : missing("GitHub")}
        </div>

        <div className="ui-routines__provider-group" role="group" aria-label="Gmail">
          <p className="ui-routines__provider-name">Gmail</p>
          {gmailReady ? (
            <>
              <label className="ui-routines__check">
                <input type="checkbox" checked={value.canReadGmail} disabled={disabled} onChange={(event) => onChange({ ...value, canReadGmail: event.target.checked })} />
                {gmailOwnerName === undefined ? "Read my Gmail" : `Read ${ownerLabel}'s Gmail`}
              </label>
              <p className="ui-routines__secondary">
                {gmailOwnerName === undefined
                  ? "Searches and reads your own Gmail only when it runs. Draft stores nothing."
                  : `Searches and reads ${ownerLabel}'s Gmail only when it runs. Draft stores nothing.`}
              </p>
            </>
          ) : gmailOwnerName === undefined ? missing("Gmail") : (
            <div className="ui-routines__trigger-missing">
              <span className="ui-routines__secondary">Not connected. Only {ownerLabel} can connect their Gmail.</span>
            </div>
          )}
        </div>
      </div>
      {/* Outside the panel, so an error still shows while the panel is collapsed. */}
      {fieldError("postChannels")}
      {fieldError("canNotify")}
      {fieldError("github")}
      {fieldError("canReadGmail")}
      {/* A collapsed section still has to say why Save is off. */}
      {!open && !capabilitiesValid(value) && <p className="ui-routines__error" role="alert">Open Edit access to finish choosing channels or repos.</p>}
    </div>
  );
}

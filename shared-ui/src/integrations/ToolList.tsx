"use client";

import { useState, type ReactNode } from "react";
import { CopyableCmd } from "../onboarding/components";
import { groupTools, toolsForPlatform, type Platform, type ToolEntry, type ToolGroup, type ToolId, type ToolState, type ToolStatus } from "./registry";

const DEFAULT_STATUS_TEXT: Record<ToolState, string> = {
  connected: "Connected",
  pending: "Waiting for first delivery",
  error: "Needs attention",
  disconnected: "Not connected",
};

function StatusDot({ state }: { state: ToolState }) {
  return <span className={`ui-dot ui-dot--${state}`} aria-hidden="true" />;
}

export function ConnectionRow({ tool, status, panel, connectedAction, unavailableHint }: {
  tool: ToolEntry;
  status: ToolStatus;
  /** Shown on the right once connected, for example Disconnect or Manage channels. */
  connectedAction?: ReactNode;
  /** Connect panel for this platform. Absent means the tool cannot be connected here. */
  panel?: (close: () => void) => ReactNode;
  unavailableHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const connected = status.state === "connected";
  const statusText = status.detail || DEFAULT_STATUS_TEXT[status.state];
  const subline = !connected && tool.scope === "workspace" ? `Connects ${tool.name} for your whole team` : null;

  return (
    <li className="ui-tool-row">
      <div className="ui-tool-row__main">
        <StatusDot state={status.state} />
        <span className="ui-tool-row__name">
          {tool.name}
          {subline && <small>{subline}</small>}
        </span>
        <span className="ui-tool-row__status" role="status">{statusText}</span>
        <span className="ui-tool-row__action">
          {connected && connectedAction}
          {!connected && panel && (
            <button type="button" className={open ? "ui-btn" : "ui-btn ui-btn--primary"} aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "Cancel" : "Connect"}
            </button>
          )}
        </span>
      </div>
      {!connected && !panel && unavailableHint && <p className="ui-tool-row__hint">{unavailableHint}</p>}
      {open && panel && <div className="ui-tool-row__panel">{panel(() => setOpen(false))}</div>}
    </li>
  );
}

/** No dot until the first agent query arrives. */
export function AgentConnectionRow({ name, command, lastUsedAt }: { name: string; command: string; lastUsedAt: string | null }) {
  return (
    <li className="ui-tool-row">
      <div className="ui-tool-row__main">
        {lastUsedAt ? <StatusDot state="connected" /> : <span className="ui-dot ui-dot--none" aria-hidden="true" />}
        <span className="ui-tool-row__name">{name}</span>
        <span className="ui-tool-row__status" role="status">
          {lastUsedAt ? `Last used ${new Date(lastUsedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "Waiting for first use"}
        </span>
        <span className="ui-tool-row__action ui-tool-row__action--wide"><CopyableCmd cmd={command} /></span>
      </div>
    </li>
  );
}

export function ToolList({ platform, groups, statuses, agentCommand, agentLastUsedAt, panels, connectedActions = {}, unavailableHint }: {
  platform: Platform;
  groups?: ToolGroup[];
  statuses: Partial<Record<ToolId, ToolStatus>>;
  agentCommand: string;
  agentLastUsedAt: string | null;
  panels: Partial<Record<ToolId, (close: () => void) => ReactNode>>;
  connectedActions?: Partial<Record<ToolId, ReactNode>>;
  unavailableHint?: string;
}) {
  const grouped = groupTools(toolsForPlatform(platform, groups), statuses);
  return (
    <div className="ui-tool-list">
      {grouped.map(({ group, label, tools }) => (
        <section key={group} className="ui-tool-list__group" aria-label={label}>
          <h3 className="ui-group-label">{label}</h3>
          <ul className="ui-rows">
            {tools.map((tool) => tool.id === "claude-code"
              ? <AgentConnectionRow key={tool.id} name={tool.name} command={agentCommand} lastUsedAt={agentLastUsedAt} />
              : <ConnectionRow key={tool.id} tool={tool} status={statuses[tool.id] ?? { state: "disconnected" }} panel={panels[tool.id]} connectedAction={connectedActions[tool.id]} unavailableHint={unavailableHint} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}

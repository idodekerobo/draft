"use client";

import { useState, type ReactNode } from "react";
import { CopyButton } from "../onboarding/components";
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

export interface ManagePanel {
  label: string;
  render: (close: () => void) => ReactNode;
}

export function ConnectionRow({ tool, status, panel, connectedAction, managePanel, unavailableHint, startHere }: {
  tool: ToolEntry;
  /** Panel reachable once connected, for example Slack's channel picker. */
  managePanel?: ManagePanel;
  /** Neutral label for the one suggested first source (never a colored tag). */
  startHere?: boolean;
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
  const subline = tool.scope === "personal"
    ? "Your account"
    : connected ? "Whole team" : `Connects ${tool.name} for your whole team`;

  return (
    <li className="ui-tool-row">
      <div className="ui-tool-row__main">
        <StatusDot state={status.state} />
        <span className="ui-tool-row__name">
          <span>{tool.name}{startHere && <span className="ui-tool-row__tag">Start here</span>}</span>
          {subline && <small>{subline}</small>}
        </span>
        <span className="ui-tool-row__status" role="status">{statusText}</span>
        <span className="ui-tool-row__action">
          {connected && managePanel && (
            <button type="button" className="ui-btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Close" : managePanel.label}</button>
          )}
          {connected && connectedAction}
          {!connected && panel && (
            <button type="button" className={open ? "ui-btn" : "ui-btn ui-btn--primary"} aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "Cancel" : "Connect"}
            </button>
          )}
        </span>
      </div>
      {!connected && !panel && unavailableHint && <p className="ui-tool-row__hint">{unavailableHint}</p>}
      {open && !connected && panel && <div className="ui-tool-row__panel">{panel(() => setOpen(false))}</div>}
      {open && connected && managePanel && <div className="ui-tool-row__panel">{managePanel.render(() => setOpen(false))}</div>}
    </li>
  );
}

/** No dot until the first agent query arrives. The action copies a CLI setup prompt for the agent. */
export function AgentConnectionRow({ name, prompt, lastUsedAt }: { name: string; prompt: string; lastUsedAt: string | null }) {
  return (
    <li className="ui-tool-row">
      <div className="ui-tool-row__main">
        {lastUsedAt ? <StatusDot state="connected" /> : <span className="ui-dot ui-dot--none" aria-hidden="true" />}
        <span className="ui-tool-row__name">
          {name}
          <small>Tell your agent to install the Draft CLI, then run <code>draft add &lt;agent&gt;</code>.</small>
        </span>
        <span className="ui-tool-row__status" role="status">
          {lastUsedAt ? `Last used ${new Date(lastUsedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "No activity yet"}
        </span>
        <span className="ui-tool-row__action"><CopyButton text={prompt} label="Copy prompt" /></span>
      </div>
      <details className="ui-tool-row__details">
        <summary>See prompt</summary>
        <pre className="ui-prompt">{prompt}</pre>
      </details>
    </li>
  );
}

export function ToolList({ platform, groups, statuses, agentPrompt, agentLastUsedAt, panels, connectedActions = {}, managePanels = {}, unavailableHint, startHere }: {
  platform: Platform;
  groups?: ToolGroup[];
  statuses: Partial<Record<ToolId, ToolStatus>>;
  /** AGENT_SETUP_PROMPT from integrations/agent-prompt.ts. */
  agentPrompt: string;
  agentLastUsedAt: string | null;
  panels: Partial<Record<ToolId, (close: () => void) => ReactNode>>;
  connectedActions?: Partial<Record<ToolId, ReactNode>>;
  managePanels?: Partial<Record<ToolId, ManagePanel>>;
  unavailableHint?: string;
  startHere?: ToolId;
}) {
  const grouped = groupTools(toolsForPlatform(platform, groups), statuses);
  return (
    <div className="ui-tool-list">
      {grouped.map(({ section, label, tools }) => (
        <section key={section} className="ui-tool-list__group" aria-label={label}>
          <h3 className="ui-group-label">{label}</h3>
          <ul className="ui-rows">
            {tools.map((tool) => tool.id === "claude-code"
              ? <AgentConnectionRow key={tool.id} name={tool.name} prompt={agentPrompt} lastUsedAt={agentLastUsedAt} />
              : <ConnectionRow key={tool.id} tool={tool} status={statuses[tool.id] ?? { state: "disconnected" }} panel={panels[tool.id]} connectedAction={connectedActions[tool.id]} managePanel={managePanels[tool.id]} unavailableHint={unavailableHint} startHere={tool.id === startHere} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}

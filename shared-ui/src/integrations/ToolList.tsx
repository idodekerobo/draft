"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { CopyButton } from "../onboarding/components";
import { ProviderLogo } from "./ProviderLogo";
import { mcpSetupSnippets } from "./mcp";
import { filterToolGroups, groupTools, toolsForPlatform, type Platform, type ToolEntry, type ToolGroup, type ToolId, type ToolState, type ToolStatus } from "./registry";

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
        <ProviderLogo providerId={tool.id} />
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
            <button type="button" className="ui-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
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
export function AgentConnectionRow({ name, prompt, mcpUrl, lastUsedAt }: { name: string; prompt: string; mcpUrl: string; lastUsedAt: string | null }) {
  return (
    <li className="ui-tool-row">
      <div className="ui-tool-row__main">
        {lastUsedAt ? <StatusDot state="connected" /> : <span className="ui-dot ui-dot--none" aria-hidden="true" />}
        <ProviderLogo providerId="claude-code" />
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
      <details className="ui-tool-row__details">
        <summary>Connect with MCP instead</summary>
        <div className="ui-mcp">
          <p className="ui-muted">Draft&apos;s MCP server is at <code>{mcpUrl}</code>. Your first connection opens a browser sign-in.</p>
          {mcpSetupSnippets(mcpUrl).map(({ agent, hint, snippet }) => (
            <div key={agent} className="ui-mcp__snippet">
              <span className="ui-muted">{agent} · {hint}</span>
              <pre className="ui-prompt">{snippet}</pre>
              <CopyButton text={snippet} label={`Copy ${agent} setup`} />
            </div>
          ))}
          <p className="ui-muted">Other MCP clients: add a remote HTTP server with the URL above.</p>
        </div>
      </details>
    </li>
  );
}

export function ToolList({ platform, groups, statuses, agentPrompt, agentLastUsedAt, mcpUrl, panels, connectedActions = {}, managePanels = {}, unavailableHint, startHere, searchable = false }: {
  platform: Platform;
  groups?: ToolGroup[];
  statuses: Partial<Record<ToolId, ToolStatus>>;
  /** AGENT_SETUP_PROMPT from integrations/agent-prompt.ts. */
  agentPrompt: string;
  agentLastUsedAt: string | null;
  /** Full MCP endpoint, from mcpUrl(apiBaseUrl). */
  mcpUrl: string;
  panels: Partial<Record<ToolId, (close: () => void) => ReactNode>>;
  connectedActions?: Partial<Record<ToolId, ReactNode>>;
  managePanels?: Partial<Record<ToolId, ManagePanel>>;
  unavailableHint?: string;
  startHere?: ToolId;
  searchable?: boolean;
}) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const grouped = useMemo(() => filterToolGroups(groupTools(toolsForPlatform(platform, groups), statuses), normalizedQuery), [platform, groups, statuses, normalizedQuery]);
  return (
    <div className="ui-tool-list">
      {searchable && <div className="ui-tool-list__search-label">
        <label className="ui-tool-list__search-title" htmlFor={searchId}>Search connections</label>
        <input id={searchId} className="ui-input ui-tool-list__search" type="search" aria-label="Search connections" placeholder="Search connections" value={query} onChange={(event) => setQuery(event.target.value)} />
        {query && <button type="button" className="ui-link ui-tool-list__clear" onClick={() => setQuery("")}>Clear search</button>}
      </div>}
      {grouped.map(({ section, label, tools }) => (
        <section key={section} className="ui-tool-list__group" aria-label={label}>
          <h3 className="ui-group-label">{label}</h3>
          <ul className="ui-rows">
            {tools.map((tool) => tool.id === "claude-code"
              ? <AgentConnectionRow key={tool.id} name={tool.name} prompt={agentPrompt} mcpUrl={mcpUrl} lastUsedAt={agentLastUsedAt} />
              : <ConnectionRow key={tool.id} tool={tool} status={statuses[tool.id] ?? { state: "disconnected" }} panel={panels[tool.id]} connectedAction={connectedActions[tool.id]} managePanel={managePanels[tool.id]} unavailableHint={unavailableHint} startHere={tool.id === startHere} />)}
          </ul>
        </section>
      ))}
      {searchable && normalizedQuery && grouped.length === 0 && <div className="ui-tool-list__empty" role="status">
        <p>No connections match “{query.trim()}”.</p>
        <button type="button" className="ui-link" onClick={() => setQuery("")}>Clear search</button>
      </div>}
    </div>
  );
}

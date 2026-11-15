"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FlowShell, useQuery, type ToolId } from "draft-shared-ui";
import { ApiError, apiFetch } from "@/lib/api";
import { connectionsQueryOptions } from "@/lib/queries";
import { webToolStatuses } from "@/lib/tool-statuses";
import { useWorkspace } from "@/lib/workspace";
import { WebToolList } from "@/components/WebToolList";

type Provider = "github" | "slack" | "linear" | "fireflies" | "granola" | "claude_session";

interface ConnectRequestInfo {
  provider: Provider;
  label: string;
  workspaceId: string;
  workspaceName: string | null;
  expiresAt: string;
}

const TOOL_BY_PROVIDER: Partial<Record<Provider, ToolId>> = {
  github: "github",
  slack: "slack",
  linear: "linear",
  fireflies: "fireflies",
  granola: "granola",
  claude_session: "coding-sessions",
};
const POLL_MS = 3_000;

function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <FlowShell>
      <section className="pairing-panel" aria-labelledby="connect-title">
        <h1 id="connect-title" className="ui-flow__title">{title}</h1>
        {children}
      </section>
    </FlowShell>
  );
}

export function ConnectRequest({ token }: { token: string }) {
  const { workspaceId } = useWorkspace();
  const request = useQuery({
    queryKey: ["connect-request", token],
    queryFn: () => apiFetch<ConnectRequestInfo>(`/connect-requests/${encodeURIComponent(token)}`),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const info = request.data;
  const toolId = info ? TOOL_BY_PROVIDER[info.provider] : undefined;
  const sameWorkspace = info?.workspaceId === workspaceId;

  const connections = useQuery({
    ...connectionsQueryOptions(workspaceId, apiFetch),
    refetchInterval: POLL_MS,
    enabled: Boolean(toolId) && sameWorkspace,
  });
  const connected = toolId !== undefined && webToolStatuses(connections.data?.connections ?? [])[toolId]?.state === "connected";

  const [completed, setCompleted] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const completing = useRef(false);
  useEffect(() => {
    if (!connected || completing.current) return;
    completing.current = true;
    apiFetch(`/connect-requests/${encodeURIComponent(token)}/complete`, { method: "POST" })
      .then(() => setCompleted(true))
      .catch(() => {
        completing.current = false;
        setCompleteError("Could not finish. Keep this tab open and try again.");
      });
  }, [connected, connections.dataUpdatedAt, token]);

  if (request.isError) {
    const used = request.error instanceof ApiError && request.error.status === 409;
    return used
      ? <Notice title="This link was already used." />
      : <Notice title="This link has expired or isn't yours." ><p className="pairing-panel__note">Ask your agent for a new one.</p></Notice>;
  }
  if (!info) return <Notice title="Loading…" />;
  if (!sameWorkspace) return <Notice title="This link is for a different workspace." />;
  if (completed) return <Notice title="Connected."><p className="pairing-panel__note">You can close this tab and tell your agent.</p></Notice>;

  return (
    <FlowShell>
      <section className="pairing-panel" aria-labelledby="connect-title">
        <h1 id="connect-title" className="ui-flow__title">Connect {info.label}</h1>
        <p className="ui-flow__subtitle">Your agent asked to connect {info.label} to {info.workspaceName ?? "your workspace"}.</p>
        <p className="pairing-panel__note">Only enter keys on draftai.us. Your agent never sees the key.</p>
        <div className="pairing-panel__actions">
          {toolId ? <WebToolList only={toolId} /> : <p className="ui-muted">Connect {info.label} in the Draft desktop app.</p>}
        </div>
        {completeError && <p className="error">{completeError}</p>}
      </section>
    </FlowShell>
  );
}

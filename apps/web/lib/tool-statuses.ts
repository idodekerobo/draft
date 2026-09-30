import { normalizeHostedConnectionList, normalizeHostedConnections } from "draft-core/integrations/hosted-connections";
import { toolStatusesFromConnections, type ToolId, type ToolStatus } from "draft-shared-ui";

export function webToolStatuses(raw: unknown[]): Partial<Record<ToolId, ToolStatus>> {
  const personal = [...normalizeHostedConnectionList("fireflies", raw), ...normalizeHostedConnectionList("granola", raw)];
  const sessionsOn = raw.some((row) => {
    const connection = row as { provider?: unknown; status?: unknown };
    return connection.provider === "claude_session" && connection.status === "active";
  });
  return {
    ...toolStatusesFromConnections(personal, normalizeHostedConnections(raw)),
    "coding-sessions": sessionsOn ? { state: "connected" } : { state: "disconnected" },
  };
}

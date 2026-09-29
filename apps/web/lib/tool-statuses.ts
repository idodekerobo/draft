import { normalizeHostedConnectionList, normalizeHostedConnections } from "draft-core/integrations/hosted-connections";
import { toolStatusesFromConnections, type ToolId, type ToolStatus } from "draft-shared-ui";

export function webToolStatuses(raw: unknown[]): Partial<Record<ToolId, ToolStatus>> {
  const personal = [...normalizeHostedConnectionList("fireflies", raw), ...normalizeHostedConnectionList("granola", raw)];
  return toolStatusesFromConnections(personal, normalizeHostedConnections(raw));
}

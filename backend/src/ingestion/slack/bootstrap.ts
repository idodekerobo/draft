// organization_id isn't a column on source_connections (it lives on
// workspaces), so this is the one place that resolves it via a join and
// threads it through to each listener for the storage object key.

import type { SupabaseClient } from "@supabase/supabase-js";
import { connectSlackSocketListener, type SlackListenerHandle } from "./socket-listener";

interface ActiveSlackConnectionRow {
  id: string;
  workspace_id: string;
  workspaces: { organization_id: string } | { organization_id: string }[] | null;
}

const listenerHandles = new Map<string, SlackListenerHandle>();

function resolveOrganizationId(
  workspaces: ActiveSlackConnectionRow["workspaces"],
): string | null {
  if (!workspaces) return null;
  if (Array.isArray(workspaces)) return workspaces[0]?.organization_id ?? null;
  return workspaces.organization_id ?? null;
}

function startResolvedListener(
  row: ActiveSlackConnectionRow,
  client?: SupabaseClient,
): void {
  const organizationId = resolveOrganizationId(row.workspaces);
  if (!organizationId) {
    throw new Error(`Slack connection ${row.id} has no organization_id`);
  }

  listenerHandles.get(row.id)?.stop();
  listenerHandles.set(
    row.id,
    connectSlackSocketListener(
      {
        id: row.id,
        workspace_id: row.workspace_id,
        organization_id: organizationId,
      },
      client,
    ),
  );
}

export async function restartSlackListener(
  connectionId: string,
  client?: SupabaseClient,
): Promise<void> {
  const db = client ?? (await import("../../db/client")).serviceClient;
  const { data, error } = await db
    .from("source_connections")
    .select("id, workspace_id, workspaces!inner(organization_id)")
    .eq("id", connectionId)
    .eq("provider", "slack")
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Active Slack connection ${connectionId} not found`);

  startResolvedListener(data as unknown as ActiveSlackConnectionRow, client);
}

export function stopSlackListener(connectionId: string): void {
  listenerHandles.get(connectionId)?.stop();
  listenerHandles.delete(connectionId);
}

export async function startSlackListeners(client?: SupabaseClient): Promise<void> {
  const db = client ?? (await import("../../db/client")).serviceClient;

  const { data, error } = await db
    .from("source_connections")
    .select("id, workspace_id, workspaces!inner(organization_id)")
    .eq("provider", "slack")
    .eq("status", "active");
  if (error) throw error;

  const rows = (data ?? []) as unknown as ActiveSlackConnectionRow[];

  for (const row of rows) {
    try {
      startResolvedListener(row, client);
    } catch (error) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          component: "slack-bootstrap",
          msg: `skipping Slack connection: ${error}`,
          connection_id: row.id,
        }),
      );
    }
  }
}

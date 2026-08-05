// organization_id isn't a column on source_connections (it lives on
// workspaces), so this is the one place that resolves it via a join and
// threads it through to each listener for the storage object key.

import type { SupabaseClient } from "@supabase/supabase-js";
import { connectSlackSocketListener } from "./socket-listener";

interface ActiveSlackConnectionRow {
  id: string;
  workspace_id: string;
  workspaces: { organization_id: string } | { organization_id: string }[] | null;
}

function resolveOrganizationId(
  workspaces: ActiveSlackConnectionRow["workspaces"],
): string | null {
  if (!workspaces) return null;
  if (Array.isArray(workspaces)) return workspaces[0]?.organization_id ?? null;
  return workspaces.organization_id ?? null;
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
    const organizationId = resolveOrganizationId(row.workspaces);
    if (!organizationId) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          component: "slack-bootstrap",
          msg: "skipping Slack connection with unresolved organization_id",
          connection_id: row.id,
        }),
      );
      continue;
    }

    connectSlackSocketListener(
      {
        id: row.id,
        workspace_id: row.workspace_id,
        organization_id: organizationId,
      },
      client,
    );
  }
}

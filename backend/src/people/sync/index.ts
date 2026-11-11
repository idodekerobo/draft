import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveProviderCredentialById } from "../../credentials/resolve-provider-credential";
import { recordError } from "../../errors/record-error";
import { syncMembers } from "../sync-members";
import { syncLinearIdentities } from "./linear";
import { syncSlackIdentities } from "./slack";

export interface SyncCounts {
  matched: number;
  created: number;
  known: number;
  skipped: number;
}

export interface SyncDeps {
  resolveCredential?: (workspaceId: string, provider: "slack" | "linear", credentialId: string, client: SupabaseClient) => Promise<Record<string, unknown>>;
  recordWarning?: (connection: { id: string; workspace_id: string }, code: string, message: string) => Promise<void>;
}

const defaultDeps: SyncDeps = {
  resolveCredential: (workspaceId, provider, credentialId, client) => resolveProviderCredentialById(workspaceId, provider, credentialId, client) as unknown as Promise<Record<string, unknown>>,
  recordWarning: (connection, code, message) =>
    recordError({ workspaceId: connection.workspace_id, operation: "ingestion", message, code, sourceConnectionId: connection.id }),
};

/** Runs a sync after a response has gone out. A failure is recorded and never reaches the caller. */
export function syncPeopleInBackground(client: SupabaseClient, workspaceId: string): void {
  void syncPeople(client, workspaceId).catch((error) =>
    recordError({ workspaceId, operation: "ingestion", message: "People sync failed", code: "people_sync_failed", error }),
  );
}

/**
 * Brings people up to date for one workspace: its members first, then every connection that has a directory
 * (Slack, Linear). One provider failing is recorded and does not stop the next. Fireflies adds no people:
 * its attendees include clients, so their emails are only kept on the meeting for matching later.
 */
export async function syncPeople(client: SupabaseClient, workspaceId: string, deps: SyncDeps = defaultDeps): Promise<void> {
  await syncMembers(client, workspaceId);

  const { data, error } = await client
    .from("source_connections")
    .select("id, workspace_id, provider, credential_id")
    .eq("workspace_id", workspaceId)
    .in("provider", ["slack", "linear"])
    .eq("status", "active");
  if (error) throw error;

  const merged = { ...defaultDeps, ...deps };
  for (const connection of (data ?? []) as Array<{ id: string; workspace_id: string; provider: "slack" | "linear"; credential_id: string | null }>) {
    if (!connection.credential_id) continue;
    const ref = { id: connection.id, workspace_id: connection.workspace_id, credential_id: connection.credential_id };
    try {
      if (connection.provider === "slack") await syncSlackIdentities(client, ref, merged);
      else await syncLinearIdentities(client, ref, merged);
    } catch (cause) {
      await recordError({
        workspaceId,
        operation: "ingestion",
        message: `People sync failed for ${connection.provider}`,
        code: "people_sync_failed",
        error: cause,
        sourceConnectionId: connection.id,
      });
    }
  }
}

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkspaceEventType, WorkspaceEventVisibility } from "../types/enums";

/**
 * Appends one workspace event. The database allocates the sequence number under the workspace lock, so
 * concurrent writers never collide. A private event is read only by its audience person.
 */
export async function insertEvent(
  client: SupabaseClient,
  workspaceId: string,
  fields: {
    event_type: WorkspaceEventType;
    summary: string;
    agent_run_id?: string | null;
    connection_id?: string | null;
    context_version_id?: string | null;
    payload_json?: Record<string, unknown>;
    visibility?: WorkspaceEventVisibility;
    audience_person_id?: string | null;
  },
): Promise<void> {
  const visibility = fields.visibility ?? "shared";
  if (visibility === "private" && !fields.audience_person_id) throw new Error("private_event_needs_audience");
  const { error } = await client.rpc("append_workspace_event", {
    p_workspace_id: workspaceId,
    p_event_type: fields.event_type,
    p_summary: fields.summary,
    p_agent_run_id: fields.agent_run_id ?? null,
    p_connection_id: fields.connection_id ?? null,
    p_context_version_id: fields.context_version_id ?? null,
    p_payload_json: fields.payload_json ?? {},
    p_visibility: visibility,
    p_audience_person_id: fields.audience_person_id ?? null,
  });
  if (error) throw error;
}

/**
 * Visibility for an event written from a source item. A private source item gives a private event for its owner.
 * Returns null when the owner has no person row: nobody could read that event, so it is not written.
 */
export async function eventAudienceForSource(
  client: SupabaseClient,
  workspaceId: string,
  source: { visibility: "private" | "shared"; owner_user_id: string | null },
): Promise<{ visibility: WorkspaceEventVisibility; audience_person_id: string | null } | null> {
  if (source.visibility === "shared") return { visibility: "shared", audience_person_id: null };
  if (!source.owner_user_id) return null;
  const { data, error } = await client.from("people").select("id").eq("workspace_id", workspaceId).eq("user_id", source.owner_user_id).maybeSingle();
  if (error) throw error;
  return data ? { visibility: "private", audience_person_id: (data as { id: string }).id } : null;
}

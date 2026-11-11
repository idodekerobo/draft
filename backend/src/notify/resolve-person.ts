import type { SupabaseClient } from "@supabase/supabase-js";
import { isNotifyChannelId, type NotifyChannelId } from "draft-core/notify";
import { parsePersonId, parseWorkspaceId } from "draft-core/run-spec";
import type { PeopleRow } from "../types/tables";
import { markReachable, type ReachablePerson } from "./types";

export type ResolveFailure = "person_not_found" | "not_active" | "not_member";

/**
 * The only place a ReachablePerson is made. It checks, in order, that the person is in this workspace, is
 * `active`, and is a `member`. A pending or rejected person can be named in an action item but never messaged.
 */
export async function resolvePerson(client: SupabaseClient, workspaceId: string, personId: string): Promise<ReachablePerson | { failure: ResolveFailure }> {
  const { data, error } = await client.from("people").select("*").eq("id", personId).eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw error;
  const row = data as PeopleRow | null;
  if (!row) return { failure: "person_not_found" };
  if (row.status !== "active") return { failure: "not_active" };
  if (row.affiliation !== "member") return { failure: "not_member" };
  return markReachable({
    id: parsePersonId(row.id),
    workspaceId: parseWorkspaceId(row.workspace_id),
    displayName: row.display_name,
    userId: row.user_id,
    notifyChannels: (row.notify_channels ?? []).filter(isNotifyChannelId) as NotifyChannelId[],
  });
}

export const isFailure = (value: ReachablePerson | { failure: ResolveFailure }): value is { failure: ResolveFailure } => "failure" in value;

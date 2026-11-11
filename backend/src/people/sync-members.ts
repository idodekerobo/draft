import type { SupabaseClient } from "@supabase/supabase-js";
import type { PeopleRow, UserRow } from "../types/tables";

const UNIQUE_VIOLATION = "23505";

type Member = Pick<UserRow, "id" | "email" | "display_name">;

/** The name shown for a member who set none: the part of the email before the @. */
const nameFor = (member: Member) => member.display_name?.trim() || member.email.split("@")[0]!;

/**
 * Makes sure every active member of the workspace's team is a person with a confirmed email identity.
 * It is safe to call at any time and any number of times: it creates only what is missing and never
 * changes a person or identity that exists. A member who is not active gets nothing new.
 */
export async function syncMembers(client: SupabaseClient, workspaceId: string): Promise<void> {
  const { data: workspace, error: workspaceError } = await client.from("workspaces").select("team_id").eq("id", workspaceId).maybeSingle();
  if (workspaceError) throw workspaceError;
  if (!workspace?.team_id) return;

  const { data: users, error: usersError } = await client
    .from("users")
    .select("id, email, display_name")
    .eq("primary_team_id", workspace.team_id)
    .eq("status", "active");
  if (usersError) throw usersError;
  const members = (users ?? []) as Member[];
  if (!members.length) return;

  const { data: existing, error: existingError } = await client
    .from("people")
    .select("id, user_id")
    .eq("workspace_id", workspaceId)
    .in("user_id", members.map((member) => member.id));
  if (existingError) throw existingError;
  const personByUser = new Map((existing ?? []).map((row: Pick<PeopleRow, "id" | "user_id">) => [row.user_id as string, row.id]));

  for (const member of members) {
    if (personByUser.has(member.id)) continue;
    const { data: created, error } = await client
      .from("people")
      .insert({ workspace_id: workspaceId, display_name: nameFor(member), user_id: member.id, status: "active", created_by: "user" })
      .select("id");
    // Another call made this person first. Read theirs.
    if (error?.code === UNIQUE_VIOLATION) {
      const { data: raced, error: racedError } = await client.from("people").select("id").eq("workspace_id", workspaceId).eq("user_id", member.id).maybeSingle();
      if (racedError) throw racedError;
      if (raced) personByUser.set(member.id, raced.id);
      continue;
    }
    if (error) throw error;
    personByUser.set(member.id, (created as Array<{ id: string }>)[0]!.id);
  }

  for (const member of members) {
    const personId = personByUser.get(member.id);
    if (!personId) continue;
    const { error } = await client.from("person_identities").insert({
      workspace_id: workspaceId,
      person_id: personId,
      provider: "email",
      external_id: member.email.trim().toLowerCase(),
      handle: member.email,
      status: "confirmed",
    });
    // The identity exists already, on this person or on another. Either way it stays as it is.
    if (error && error.code !== UNIQUE_VIOLATION) throw error;
  }
}

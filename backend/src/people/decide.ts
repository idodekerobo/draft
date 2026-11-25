import type { SupabaseClient } from "@supabase/supabase-js";
import type { PeopleRow, UserRow } from "../types/tables";
import { viewPeople, type PersonView } from "./view";

/** An admin is an organization owner or admin. Draft has no workspace admin role yet. */
export async function isAdmin(client: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await client.from("users").select("organization_role").eq("id", userId).maybeSingle();
  if (error) throw error;
  const role = (data as Pick<UserRow, "organization_role"> | null)?.organization_role;
  return role === "owner" || role === "admin";
}

export type DecideResult = { ok: true; person: PersonView } | { ok: false; code: "person_not_found" | "already_decided" };

/** Keep a human decision on the user column and a synthesis decision in its evidence and tool audit. */
export async function decidePerson(
  client: SupabaseClient,
  workspaceId: string,
  userId: string | null,
  decision: { personId: string; to: "active" | "rejected"; reason?: string; runId?: string },
): Promise<DecideResult> {
  const { data, error } = await client.from("people").select("*").eq("id", decision.personId).eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw error;
  const row = data as PeopleRow | null;
  if (!row) return { ok: false, code: "person_not_found" };

  // Approve moves a pending or rejected person to active. Reject only turns away a pending person.
  const allowedFrom = decision.to === "active" ? ["pending", "rejected"] : ["pending"];
  if (!allowedFrom.includes(row.status)) return { ok: false, code: "already_decided" };

  const { decidedByRunId: _previousRun, ...evidence } = row.evidence;
  const { error: updateError } = await client
    .from("people")
    .update({
      status: decision.to,
      decided_by_user_id: userId,
      decided_at: new Date().toISOString(),
      evidence: { ...evidence, ...(decision.reason ? { rejectionReason: decision.reason } : {}), ...(decision.runId ? { decidedByRunId: decision.runId } : {}) },
    })
    .eq("id", row.id)
    .eq("workspace_id", workspaceId);
  if (updateError) throw updateError;
  // The admins' "approve this person" cards are settled by the decision, wherever it was made.
  const { error: settleError } = await client
    .from("notifications")
    .update({ state: "done", acted_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("kind", "identity_proposed")
    .eq("ref_type", "person")
    .eq("ref_id", row.id)
    .eq("state", "open");
  if (settleError) throw settleError;
  return { ok: true, person: (await viewPeople(client, workspaceId, [{ ...row, status: decision.to }]))[0]! };
}

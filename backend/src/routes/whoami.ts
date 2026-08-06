import { withAuth } from "../auth/withAuth";
import { serviceClient } from "../db/client";
import type { UserRow } from "../types/tables";

export const GET = withAuth(async (_req, caller) => {
  const { data, error } = await serviceClient
    .from("users")
    .select(
      "id, email, display_name, organization_id, primary_team_id, organization_role, status",
    )
    .eq("id", caller.userId)
    .maybeSingle<UserRow>();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  return Response.json(data);
});

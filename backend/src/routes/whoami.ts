import { withAuth } from "../auth/withAuth";
import { serviceClient } from "../db/client";
import type { UserRow } from "../types/tables";

type UserIdentityRow = Pick<
  UserRow,
  "id" | "email" | "display_name" | "organization_id" | "primary_team_id" | "organization_role" | "status" | "onboarding_completed_at"
> & { workspace_id: string | null };

export const GET = withAuth(async (_req, caller) => {
  const { data, error } = await serviceClient
    .rpc("get_user_identity", { p_user_id: caller.userId })
    .maybeSingle<UserIdentityRow>();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  return Response.json(data);
});

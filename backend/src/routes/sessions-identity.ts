import type { SupabaseClient } from "@supabase/supabase-js";

export interface ResolvedUserFilter {
  userId: string | null;
  contributorId: string | null;
  /** True when the email matched neither a user nor a contributor -- callers should short-circuit to an empty result rather than run an unfiltered query. */
  matchedNothing: boolean;
}

/** Resolves `--user <email>` against both users.email and session_contributors.git_email. */
export async function resolveUserFilter(
  client: SupabaseClient,
  workspaceId: string,
  email: string,
): Promise<ResolvedUserFilter> {
  const [userResult, contributorResult] = await Promise.all([
    client.from("users").select("id").eq("email", email).maybeSingle<{ id: string }>(),
    client
      .from("session_contributors")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("git_email", email)
      .maybeSingle<{ id: string }>(),
  ]);

  const userId = userResult.data?.id ?? null;
  const contributorId = contributorResult.data?.id ?? null;
  return { userId, contributorId, matchedNothing: userId === null && contributorId === null };
}

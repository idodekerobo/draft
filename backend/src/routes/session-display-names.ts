import type { SupabaseClient } from "@supabase/supabase-js";

export type DisplayNameLookup =
  | { ok: true; users: Map<string, string>; contributors: Map<string, string> }
  | { ok: false; code: "users_lookup_failed" | "contributors_lookup_failed"; detail: unknown };

// Verified users resolve to display_name/email, unclaimed git identities to
// git_display_name/git_email.
export async function loadDisplayNames(
  client: SupabaseClient,
  userIds: string[],
  contributorIds: string[],
): Promise<DisplayNameLookup> {
  const [usersResult, contributorsResult] = await Promise.all([
    userIds.length > 0
      ? client.from("users").select("id, display_name, email").in("id", userIds)
      : Promise.resolve({ data: [], error: null }),
    contributorIds.length > 0
      ? client.from("session_contributors").select("id, git_display_name, git_email").in("id", contributorIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (usersResult.error) return { ok: false, code: "users_lookup_failed", detail: usersResult.error };
  if (contributorsResult.error) return { ok: false, code: "contributors_lookup_failed", detail: contributorsResult.error };

  return {
    ok: true,
    users: new Map(
      ((usersResult.data ?? []) as { id: string; display_name: string | null; email: string }[])
        .map((u) => [u.id, u.display_name ?? u.email]),
    ),
    contributors: new Map(
      ((contributorsResult.data ?? []) as { id: string; git_display_name: string | null; git_email: string }[])
        .map((c) => [c.id, c.git_display_name ?? c.git_email]),
    ),
  };
}

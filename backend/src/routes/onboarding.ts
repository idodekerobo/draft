import { withAuth } from "../auth/withAuth";
import { withCors } from "../auth/with-cors";
import { serviceClient } from "../db/client";
import type { UserRow } from "../types/tables";

// Per-user, not per-workspace — see the migration's comment. Only writes
// when unset, so repeat calls (the desktop app calls this once, at the end
// of its onboarding wizard, but retries on network failure) keep the
// original completion timestamp instead of bumping it forward.
export const POST = withCors(withAuth(async (_req, caller) => {
  const { data: existing, error: readError } = await serviceClient
    .from("users")
    .select("onboarding_completed_at")
    .eq("id", caller.userId)
    .single();
  if (readError) {
    return Response.json({ error: readError.message }, { status: 500 });
  }

  const current = (existing as Pick<UserRow, "onboarding_completed_at">).onboarding_completed_at;
  if (current) {
    return Response.json({ onboarding_completed_at: current });
  }

  const nowIso = new Date().toISOString();
  const { data, error } = await serviceClient
    .from("users")
    .update({ onboarding_completed_at: nowIso })
    .eq("id", caller.userId)
    .select("onboarding_completed_at")
    .single();
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ onboarding_completed_at: (data as Pick<UserRow, "onboarding_completed_at">).onboarding_completed_at });
}));

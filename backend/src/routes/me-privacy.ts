import { withAuth } from "../auth/withAuth";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";
import type { UserRow } from "../types/tables";

type PrivacyFields = Pick<UserRow, "analytics_consent" | "analytics_consent_at">;

function isPrivacyBody(value: unknown): value is { analytics_consent: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  return keys.length === 1 && keys[0] === "analytics_consent" && typeof body.analytics_consent === "boolean";
}

const PRIVACY_COLUMNS = "analytics_consent, analytics_consent_at";

// Privacy is per user, but errors rows are per workspace, so look up the
// caller's workspace only when something failed.
function recordPrivacyError(userId: string, operation: "read" | "commit", errorCode: string, error: unknown): void {
  void Promise.resolve(serviceClient.rpc("get_user_identity", { p_user_id: userId }).maybeSingle<{ workspace_id: string | null }>())
    .then(({ data }) => data?.workspace_id ?? null, () => null)
    .then((workspaceId) => recordRouteError({ workspaceId, operation, errorCode, error }));
}

// Consent follows the user across web and desktop. Session replay runs
// whenever consent is on.
export const PATCH = withAuth(async (req, caller) => {
  const body: unknown = await req.json().catch(() => null);
  if (!isPrivacyBody(body)) return Response.json({ error: "invalid_body" }, { status: 400 });

  const { data, error } = await serviceClient
    .from("users")
    .update({ analytics_consent: body.analytics_consent, analytics_consent_at: new Date().toISOString() })
    .eq("id", caller.userId)
    .select(PRIVACY_COLUMNS)
    .single<PrivacyFields>();
  if (error) {
    recordPrivacyError(caller.userId, "commit", "privacy_update_failed", error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data);
});

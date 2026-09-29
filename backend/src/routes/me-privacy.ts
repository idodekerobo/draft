import { withAuth } from "../auth/withAuth";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";
import type { UserRow } from "../types/tables";

type PrivacyFields = Pick<UserRow, "analytics_consent" | "analytics_consent_at" | "session_replay_enabled">;

interface PrivacyBody {
  analytics_consent?: boolean;
  session_replay_enabled?: boolean;
}

function isPrivacyBody(value: unknown): value is PrivacyBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  return keys.length > 0
    && keys.every((key) => key === "analytics_consent" || key === "session_replay_enabled")
    && keys.every((key) => typeof body[key] === "boolean");
}

const PRIVACY_COLUMNS = "analytics_consent, analytics_consent_at, session_replay_enabled";

// Privacy is per user, but errors rows are per workspace, so look up the
// caller's workspace only when something failed.
function recordPrivacyError(userId: string, operation: "read" | "commit", errorCode: string, error: unknown): void {
  void Promise.resolve(serviceClient.rpc("get_user_identity", { p_user_id: userId }).maybeSingle<{ workspace_id: string | null }>())
    .then(({ data }) => data?.workspace_id ?? null, () => null)
    .then((workspaceId) => recordRouteError({ workspaceId, operation, errorCode, error }));
}

// Consent follows the user across web and desktop. Withdrawing consent also
// turns replay off, and replay can never be on without consent.
export const PATCH = withAuth(async (req, caller) => {
  const body: unknown = await req.json().catch(() => null);
  if (!isPrivacyBody(body)) return Response.json({ error: "invalid_body" }, { status: 400 });

  const { data: current, error: readError } = await serviceClient
    .from("users")
    .select(PRIVACY_COLUMNS)
    .eq("id", caller.userId)
    .single<PrivacyFields>();
  if (readError || !current) {
    recordPrivacyError(caller.userId, "read", "privacy_read_failed", readError);
    return Response.json({ error: readError?.message ?? "not_found" }, { status: 500 });
  }

  const consent = body.analytics_consent ?? current.analytics_consent;
  if (body.session_replay_enabled && consent !== true) {
    return Response.json({ error: "replay_requires_consent" }, { status: 400 });
  }

  const update: Partial<PrivacyFields> = {
    session_replay_enabled: consent === true ? (body.session_replay_enabled ?? current.session_replay_enabled) : false,
  };
  if (body.analytics_consent !== undefined) {
    update.analytics_consent = body.analytics_consent;
    update.analytics_consent_at = new Date().toISOString();
  }

  const { data, error } = await serviceClient
    .from("users")
    .update(update)
    .eq("id", caller.userId)
    .select(PRIVACY_COLUMNS)
    .single<PrivacyFields>();
  if (error) {
    recordPrivacyError(caller.userId, "commit", "privacy_update_failed", error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data);
});

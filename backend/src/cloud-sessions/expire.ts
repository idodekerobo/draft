import type { SupabaseClient } from "@supabase/supabase-js";
import { recordError } from "../errors/record-error";
import type { SandboxProvider, VolumeRef } from "../metaharness/sandbox/providers";

/** A sleeping cloud session with no event for this long loses its sandbox volume. */
export const CLOUD_SESSION_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
const EXPIRY_BATCH = 50;

export interface ExpireIdleCloudSessionsDeps {
  client: SupabaseClient;
  provider: SandboxProvider;
  now?: () => Date;
}

export interface ExpireIdleCloudSessionsResult {
  expired: number;
  /** The session woke or changed before it could be claimed. */
  skipped: number;
  failed: number;
}

type Outcome = keyof ExpireIdleCloudSessionsResult;

interface IdleSessionRow {
  id: string;
  workspace_id: string;
  sandbox_volume: unknown;
}

/**
 * Deletes the sandbox volumes of sleeping cloud sessions idle past the expiry window, then ends those sessions.
 * A failure is recorded against its session, and the sweep goes on to the next one.
 */
export async function expireIdleCloudSessions(deps: ExpireIdleCloudSessionsDeps): Promise<ExpireIdleCloudSessionsResult> {
  const now = deps.now ?? (() => new Date());
  const cutoff = new Date(now().getTime() - CLOUD_SESSION_EXPIRY_MS).toISOString();
  const { data, error } = await deps.client
    .from("sessions")
    .select("id, workspace_id, sandbox_volume")
    .eq("runtime", "cloud")
    .eq("status", "sleeping")
    .is("deleted_at", null)
    .lt("last_event_at", cutoff)
    .order("last_event_at", { ascending: true })
    .limit(EXPIRY_BATCH);
  if (error) throw error;

  const result: ExpireIdleCloudSessionsResult = { expired: 0, skipped: 0, failed: 0 };
  for (const session of (data ?? []) as IdleSessionRow[]) {
    let outcome: Outcome;
    try {
      outcome = await expireSession(deps, session, now);
    } catch (cause) {
      await recordError({
        client: deps.client,
        workspaceId: session.workspace_id,
        sessionId: session.id,
        operation: "session",
        code: "session_expire_failed",
        message: "Expiring an idle cloud session failed",
        error: cause,
      });
      outcome = "failed";
    }
    result[outcome] += 1;
  }
  return result;
}

async function expireSession(deps: ExpireIdleCloudSessionsDeps, session: IdleSessionRow, now: () => Date): Promise<Outcome> {
  const { client, provider } = deps;
  const fail = (
    operation: "session" | "execution",
    code: string,
    message: string,
    error?: unknown,
    detail: Record<string, unknown> = {},
  ): Promise<void> =>
    recordError({ client, workspaceId: session.workspace_id, sessionId: session.id, operation, code, message, error, detail });

  const volume = parseVolumeRef(session.sandbox_volume);
  if (!volume) {
    await fail("session", "sandbox_volume_invalid", "An idle cloud session has no valid sandbox volume, so it was not expired");
    return "failed";
  }

  // The newest run that recorded a machine. Runs without one (a wake that failed before its sandbox) are skipped.
  const { data: runData, error: runError } = await client
    .from("agent_runs")
    .select("sandbox_machine_id")
    .eq("session_id", session.id)
    .not("sandbox_machine_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runError) {
    await fail("session", "expiry_machine_lookup_failed", "Reading the sandbox machine of an idle cloud session failed", runError);
    return "failed";
  }
  const machine = (runData as { sandbox_machine_id: string } | null)?.sandbox_machine_id ?? null;
  if (!machine) {
    // The provider's destroy needs a machine id, so the volume is not deleted. The session stays asleep.
    await fail("execution", "sandbox_machine_missing", "An idle cloud session has no sandbox machine, so its volume was not deleted");
    return "failed";
  }

  // Claimed before the destroy, so a wake that wins the claim keeps its volume. A wake after the claim finds the session ended.
  const { data: claimed, error: claimError } = await client
    .from("sessions")
    .update({ status: "ended", end_reason: "expired", ended_at: now().toISOString() })
    .eq("id", session.id)
    .eq("status", "sleeping")
    .select("id")
    .maybeSingle();
  if (claimError) {
    await fail("session", "session_expire_failed", "Ending an idle cloud session failed", claimError);
    return "failed";
  }
  if (!claimed) return "skipped";

  try {
    await provider.destroy({ provider: volume.provider, machine, volume });
  } catch (cause) {
    // The volume ref stays on the ended session, so the volume can still be found after a failed destroy.
    await fail("execution", "sandbox_destroy_failed", "Destroying the sandbox of an expired cloud session failed", cause, { volume_id: volume.id });
    return "failed";
  }

  const { error: clearError } = await client
    .from("sessions")
    .update({ sandbox_volume: null })
    .eq("id", session.id)
    .eq("status", "ended");
  if (clearError) {
    await fail("session", "session_expire_failed", "Clearing the volume reference of an expired cloud session failed", clearError, { volume_id: volume.id });
    return "failed";
  }
  return "expired";
}

function parseVolumeRef(value: unknown): VolumeRef | null {
  if (typeof value !== "object" || value === null) return null;
  const { provider, id, region } = value as Record<string, unknown>;
  return isNonEmptyString(provider) && isNonEmptyString(id) && isNonEmptyString(region) ? { provider, id, region } : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

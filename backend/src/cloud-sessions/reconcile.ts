import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIVE_AGENT_RUN_STATUSES } from "draft-core/run-spec";
import { recordError } from "../errors/record-error";
import type { SandboxProvider } from "../metaharness/sandbox/providers";
import { latestMachineId, parseVolumeRef } from "./session-sandbox";
import { type CloudSessionRef, wakeIfUndelivered } from "./undelivered-inputs";

/** A host silent this long is stuck. A run younger than this may still be booting, so it is left alone. */
export const RECONCILE_AFTER_MS = 10 * 60 * 1000;
const RECONCILE_BATCH = 50;
const STUCK_STATUSES = ["starting", "host_offline"];
const ACTIVE_STATUSES: readonly string[] = ACTIVE_AGENT_RUN_STATUSES;
export const HOST_LOST = "host_lost";

export interface ReconcileCloudSessionsDeps {
  client: SupabaseClient;
  provider: SandboxProvider;
  /** Names the provider in a machine ref when the session row has no volume ref. */
  providerName: string;
  /** Starts a run of a session that sleeps with an undelivered input. */
  wake: (session: CloudSessionRef) => Promise<unknown>;
  now?: () => Date;
}

export interface ReconcileCloudSessionsResult {
  /** Stuck hosts whose machine was gone. Each run failed, and each session sleeps. */
  hostsLost: number;
  /** Ended sessions whose sandbox volume was destroyed. */
  volumesDestroyed: number;
  /** Repairs that stopped at a recorded failure. The sweep went on past each one. */
  failed: number;
}

type StuckOutcome = "lost" | "skipped" | "failed";

interface StuckSessionRow {
  id: string;
  workspace_id: string;
  status: string;
  last_seen: string;
  sandbox_volume: unknown;
}

interface LatestRunRow {
  id: string;
  status: string;
  sandbox_machine_id: string | null;
  created_at: string;
}

interface LeakedSessionRow {
  id: string;
  workspace_id: string;
  sandbox_volume: unknown;
}

/**
 * Repairs two leaks the other sweeps leave. A stuck host whose machine is gone keeps its run active, so its session
 * never sleeps: the run fails and the session sleeps. An ended session can keep its volume: the volume is destroyed.
 */
export async function reconcileCloudSessions(deps: ReconcileCloudSessionsDeps): Promise<ReconcileCloudSessionsResult> {
  const hosts = await reconcileStuckHosts(deps);
  const volumes = await reconcileLeakedVolumes(deps);
  return { hostsLost: hosts.lost, volumesDestroyed: volumes.destroyed, failed: hosts.failed + volumes.failed };
}

async function reconcileStuckHosts(deps: ReconcileCloudSessionsDeps): Promise<{ lost: number; failed: number }> {
  const now = (deps.now ?? (() => new Date()))();
  // Routine sessions send no heartbeat, so a silent one is not stuck.
  const { data, error } = await deps.client
    .from("sessions")
    .select("id, workspace_id, status, last_seen, sandbox_volume")
    .eq("runtime", "cloud")
    .eq("session_type", "interactive")
    .is("deleted_at", null)
    .in("status", STUCK_STATUSES)
    .order("last_seen", { ascending: true })
    .limit(RECONCILE_BATCH);
  if (error) throw error;

  const cutoff = now.getTime() - RECONCILE_AFTER_MS;
  const stuck = ((data ?? []) as StuckSessionRow[]).filter((s) => s.status === "host_offline" || Date.parse(s.last_seen) < cutoff);
  let lost = 0;
  let failed = 0;
  for (const session of stuck) {
    let outcome: StuckOutcome;
    try {
      outcome = await reconcileStuckHost(deps, session, now);
    } catch (error) {
      await recordError({ client: deps.client, workspaceId: session.workspace_id, sessionId: session.id, operation: "session", code: "host_reconcile_failed", message: "Reconciling a stuck cloud host failed", error });
      outcome = "failed";
    }
    if (outcome === "lost") lost += 1;
    if (outcome === "failed") failed += 1;
  }
  return { lost, failed };
}

async function reconcileStuckHost(deps: ReconcileCloudSessionsDeps, session: StuckSessionRow, now: Date): Promise<StuckOutcome> {
  const { client, provider, providerName, wake } = deps;
  const ref: CloudSessionRef = { workspaceId: session.workspace_id, sessionId: session.id };

  const { data: runData, error: runError } = await client
    .from("agent_runs")
    .select("id, status, sandbox_machine_id, created_at")
    .eq("session_id", session.id)
    .eq("workspace_id", session.workspace_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runError) {
    await recordError({ client, ...ref, operation: "session", code: "host_run_lookup_failed", message: "Reading the latest run of a stuck cloud session failed", error: runError });
    return "failed";
  }
  const run = runData as LatestRunRow | null;
  if (!run || !ACTIVE_STATUSES.includes(run.status)) return "skipped";
  // The sweep marks a host offline before its first heartbeat, so a young run may still be booting.
  if (Date.parse(run.created_at) > now.getTime() - RECONCILE_AFTER_MS) return "skipped";

  const volume = parseVolumeRef(session.sandbox_volume);
  let state: "running" | "stopped" | "missing" = "missing";
  if (run.sandbox_machine_id) {
    try {
      state = await provider.status({ provider: volume?.provider ?? providerName, machine: run.sandbox_machine_id, volume });
    } catch (error) {
      await recordError({ client, ...ref, agentRunId: run.id, operation: "execution", code: "host_status_failed", message: "Reading the machine of a stuck cloud host failed", error });
      return "failed";
    }
  }
  // The heartbeat sweep owns a host whose machine still runs.
  if (state === "running") return "skipped";

  // Guarded on active, so a run that ended on its own is left as it is.
  const { data: failedRun, error: failError } = await client
    .from("agent_runs")
    .update({ status: "failed", completed_at: now.toISOString(), failure_code: HOST_LOST, failure_detail: `The sandbox machine was ${state} while its run was active` })
    .eq("id", run.id)
    .in("status", ACTIVE_AGENT_RUN_STATUSES)
    .select("id")
    .maybeSingle();
  if (failError) {
    await recordError({ client, ...ref, agentRunId: run.id, operation: "session", code: "run_fail_update_failed", message: "Marking the run of a lost cloud host as failed failed", error: failError });
    return "failed";
  }
  if (!failedRun) return "skipped";
  await recordError({ client, ...ref, agentRunId: run.id, operation: "session", code: HOST_LOST, message: "The host of a cloud session was lost, so its run was failed", detail: { machine_state: state } });

  const { data: slept, error: sleepError } = await client
    .from("sessions")
    .update({ status: "sleeping" })
    .eq("id", session.id)
    .eq("workspace_id", session.workspace_id)
    .in("status", STUCK_STATUSES)
    .select("id")
    .maybeSingle();
  if (sleepError) {
    await recordError({ client, ...ref, agentRunId: run.id, operation: "session", code: "session_sleep_failed", message: "Sleeping the session of a lost cloud host failed", error: sleepError });
    return "failed";
  }
  if (!slept) return "lost";

  try {
    await wakeIfUndelivered(client, ref, wake);
  } catch (error) {
    await recordError({ client, ...ref, agentRunId: run.id, operation: "session", code: "host_wake_failed", message: "Waking a lost cloud session for its undelivered input failed", error });
  }
  return "lost";
}

async function reconcileLeakedVolumes(deps: ReconcileCloudSessionsDeps): Promise<{ destroyed: number; failed: number }> {
  const { data, error } = await deps.client
    .from("sessions")
    .select("id, workspace_id, sandbox_volume")
    .eq("runtime", "cloud")
    .eq("status", "ended")
    .not("sandbox_volume", "is", null)
    .limit(RECONCILE_BATCH);
  if (error) throw error;

  let destroyed = 0;
  let failed = 0;
  for (const session of (data ?? []) as LeakedSessionRow[]) {
    let outcome: "destroyed" | "failed";
    try {
      outcome = await destroyLeakedVolume(deps, session);
    } catch (error) {
      await recordError({ client: deps.client, workspaceId: session.workspace_id, sessionId: session.id, operation: "session", code: "leaked_volume_failed", message: "Destroying the volume of an ended cloud session failed", error });
      outcome = "failed";
    }
    if (outcome === "destroyed") destroyed += 1;
    else failed += 1;
  }
  return { destroyed, failed };
}

async function destroyLeakedVolume(deps: ReconcileCloudSessionsDeps, session: LeakedSessionRow): Promise<"destroyed" | "failed"> {
  const { client, provider } = deps;
  const ref: CloudSessionRef = { workspaceId: session.workspace_id, sessionId: session.id };

  const volume = parseVolumeRef(session.sandbox_volume);
  if (!volume) {
    await recordError({ client, ...ref, operation: "session", code: "sandbox_volume_invalid", message: "An ended cloud session has no valid sandbox volume ref, so its volume was not destroyed" });
    return "failed";
  }

  let machine: string | null;
  try {
    machine = await latestMachineId(client, session.id);
  } catch (error) {
    await recordError({ client, ...ref, operation: "session", code: "leaked_machine_lookup_failed", message: "Reading the sandbox machine of an ended cloud session failed", error });
    return "failed";
  }

  try {
    // Destroy deletes only the volume when no machine is on record.
    await provider.destroy({ provider: volume.provider, machine: machine ?? "", volume });
  } catch (error) {
    await recordError({ client, ...ref, operation: "execution", code: "sandbox_destroy_failed", message: "Destroying the sandbox of an ended cloud session failed", error, detail: { volume_id: volume.id } });
    return "failed";
  }

  const { error: clearError } = await client
    .from("sessions")
    .update({ sandbox_volume: null })
    .eq("id", session.id)
    .eq("workspace_id", session.workspace_id)
    .eq("status", "ended");
  if (clearError) {
    await recordError({ client, ...ref, operation: "session", code: "leaked_volume_clear_failed", message: "Clearing the volume ref of an ended cloud session failed", error: clearError, detail: { volume_id: volume.id } });
    return "failed";
  }
  return "destroyed";
}

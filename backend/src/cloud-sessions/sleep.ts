import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIVE_AGENT_RUN_STATUSES } from "draft-core/run-spec";
import { recordError } from "../errors/record-error";
import { type CloudSessionRef, hasUndeliveredInputs, wakeIfUndelivered } from "./undelivered-inputs";

/** The statuses a cloud host can sleep its session from. */
export const SLEEPABLE_STATUSES = ["starting", "live", "host_offline"];

export interface SleepCloudSessionInput extends CloudSessionRef {
  /** The host's run. It succeeds when the session sleeps. */
  runId: string;
}

export interface SleepCloudSessionDeps {
  client: SupabaseClient;
  /** Starts a run of the session. Called only when an input arrived after the sleep began. */
  wake: (session: CloudSessionRef) => Promise<unknown>;
  now?: () => Date;
}

/** `inputs_pending` and `session_changed` are answers. `failed` has already been recorded. */
export type SleepCloudSessionOutcome = "sleeping" | "inputs_pending" | "session_changed" | "failed";

/**
 * Sleeps a cloud session once its host is idle. A waiting input refuses the sleep, and the run stays active.
 * The input check runs again after the sleep, so an input that landed meanwhile is woken, not stranded.
 */
export async function sleepCloudSession(input: SleepCloudSessionInput, deps: SleepCloudSessionDeps): Promise<SleepCloudSessionOutcome> {
  const { client, wake } = deps;
  const { workspaceId, sessionId, runId } = input;
  const session = { workspaceId, sessionId };
  const now = deps.now ?? (() => new Date());

  try {
    if (await hasUndeliveredInputs(client, session)) return "inputs_pending";
  } catch (error) {
    await recordError({ client, workspaceId, sessionId, agentRunId: runId, operation: "session", code: "session_sleep_failed", message: "Reading the queued inputs before a sleep failed", error });
    return "failed";
  }

  // Guarded on active, so a run that already ended is left as it is.
  const { error: runError } = await client
    .from("agent_runs")
    .update({ status: "succeeded", completed_at: now().toISOString() })
    .eq("id", runId)
    .in("status", ACTIVE_AGENT_RUN_STATUSES);
  if (runError) {
    await recordError({ client, workspaceId, sessionId, agentRunId: runId, operation: "session", code: "session_sleep_failed", message: "Ending the run of a sleeping cloud session failed", error: runError });
    return "failed";
  }

  const { data, error } = await client
    .from("sessions")
    .update({ status: "sleeping" })
    .eq("id", sessionId)
    .eq("workspace_id", workspaceId)
    .in("status", SLEEPABLE_STATUSES)
    .select("id")
    .maybeSingle();
  if (error) {
    await recordError({ client, workspaceId, sessionId, agentRunId: runId, operation: "session", code: "session_sleep_failed", message: "Sleeping a cloud session failed", error });
    return "failed";
  }
  if (!data) return "session_changed";

  try {
    return (await wakeIfUndelivered(client, session, wake)) ? "inputs_pending" : "sleeping";
  } catch (error) {
    await recordError({ client, workspaceId, sessionId, agentRunId: runId, operation: "session", code: "session_sleep_failed", message: "Waking a cloud session for an input that arrived during its sleep failed", error });
    return "failed";
  }
}

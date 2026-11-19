import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIVE_AGENT_RUN_STATUSES, parseAgentRunId, parseWorkspaceId, type AgentRunSpec } from "draft-core/run-spec";
import { recordError } from "../errors/record-error";
import { resolveCredential as resolveHarnessCredential } from "../credentials/harness-credential";
import { resolveBaseContextVersionId } from "../metaharness/runs/base-context";
import { createAgentRunToken } from "../metaharness/runs/run-token";
import type { SandboxDeploymentConfig } from "../metaharness/sandbox/config";
import type { SandboxProvider } from "../metaharness/sandbox/providers";
import { buildCloudRunSpec, type CloudRunSpecInput } from "./run-spec";
import { cloudSandboxEnv, type CloudSandboxEnvInput } from "./sandbox-env";

export const START_FAILED = "start_failed";
const RUN_TOKEN_TTL_MS = 24 * 60 * 60 * 1_000;

/** What a cloud session's start and wake need from the deployment and the database. Tests pass fakes. */
export interface CloudSessionDeps {
  client: SupabaseClient;
  provider: SandboxProvider;
  config: SandboxDeploymentConfig;
  /** Signs the run token. It is the sandbox callback secret, which run tokens derive their own key from. */
  tokenSecret: string;
  resolveCredential?: typeof resolveHarnessCredential;
  now?: () => number;
  newId?: () => string;
}

/** The spec of a new run of a cloud session. The run reads the workspace's current base context. */
export async function cloudRunSpec(client: SupabaseClient, input: Omit<CloudRunSpecInput, "contextVersionId">): Promise<AgentRunSpec> {
  const contextVersionId = await resolveBaseContextVersionId(client, input.workspaceId);
  return buildCloudRunSpec({ ...input, contextVersionId });
}

type CloudEnvRun = Omit<CloudSandboxEnvInput, "runToken" | "callbackUrl" | "supabaseUrl">;

/** The sandbox environment of one run. It mints the run's own token, so each run needs its own call. Never log it. */
export function cloudRunEnv(run: CloudEnvRun, deps: Pick<CloudSessionDeps, "config" | "tokenSecret" | "now" | "newId">): Record<string, string> {
  const runToken = createAgentRunToken(
    {
      runId: parseAgentRunId(run.runId),
      workspaceId: parseWorkspaceId(run.workspaceId),
      expiresAt: (deps.now ?? Date.now)() + RUN_TOKEN_TTL_MS,
      nonce: (deps.newId ?? randomUUID)(),
    },
    deps.tokenSecret,
  );
  return cloudSandboxEnv({ ...run, runToken, callbackUrl: deps.config.callbackUrl, supabaseUrl: deps.config.supabaseUrl });
}

/** Marks a run that did not start as failed. Only a run that is still active changes. */
export async function failRun(
  client: SupabaseClient,
  failure: { workspaceId: string; sessionId: string; runId: string; code: string; message: string; now: () => number },
): Promise<void> {
  const { error } = await client
    .from("agent_runs")
    .update({ status: "failed", completed_at: new Date(failure.now()).toISOString(), failure_code: failure.code, failure_detail: failure.message })
    .eq("id", failure.runId)
    .in("status", ACTIVE_AGENT_RUN_STATUSES);
  if (error) {
    await recordError({ client, workspaceId: failure.workspaceId, sessionId: failure.sessionId, agentRunId: failure.runId, operation: "session", code: "run_fail_update_failed", message: "Marking a cloud session's run as failed failed", error });
  }
}

/** Ends a cloud session that cannot run. An ended session is left as it is. */
export async function endCloudSession(
  client: SupabaseClient,
  ending: { workspaceId: string; sessionId: string; reason: string; now: () => number },
): Promise<void> {
  const { error } = await client
    .from("sessions")
    .update({ status: "ended", ended_at: new Date(ending.now()).toISOString(), end_reason: ending.reason, open_approval_count: 0 })
    .eq("id", ending.sessionId)
    .neq("status", "ended");
  if (error) {
    await recordError({ client, workspaceId: ending.workspaceId, sessionId: ending.sessionId, operation: "session", code: "session_end_failed", message: "Ending a cloud session failed", error });
  }
}

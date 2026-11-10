import { randomUUID } from "node:crypto";
import type { AgentRunSpec } from "draft-core/agent-run";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAgentRun } from "../agent-runs/agent-run-store";
import { resolveBaseContextVersionId } from "../agent-runs/base-context";
import { describeError, finishAgentRun, markAgentRunRunning } from "../agent-runs/lifecycle";
import { claimPendingSummarySessions } from "./claim-sessions";
import { reportExpiredSummaryLeases } from "./report-expired-leases";
import { renderSessionTranscript } from "./render-transcript";
import { buildSummarizationBundle } from "./build-bundle";
import { summarizationRunId } from "./complete-summarization-callback";
import { buildSummarizationRunSpec } from "./run-spec";
import { summarizationJsonSchema } from "./render-prompt";
import { resolveInferenceCredential } from "../synthesis/resolve-credential";
import { launchFlySandboxRun, type SandboxDeploymentConfig } from "../sandbox";

const MAX_SESSIONS_PER_BATCH = 25;

export interface LaunchSummarizationBatchOptions {
  workspaceId: string;
  /** The scheduled occurrence that started this batch. */
  schedule: { scheduledTaskId: string; occurrenceAt: string };
  config: SandboxDeploymentConfig;
  client: SupabaseClient;
}

export interface LaunchSummarizationBatchResult {
  runId: string;
  machineId: string;
  bundleHash: string;
  sessionCount: number;
}

// Returns null when nothing is eligible, mirroring
// dispatchSynthesizeWorkspace's empty-queue short-circuit.
export async function launchSummarizationBatch(
  options: LaunchSummarizationBatchOptions,
): Promise<LaunchSummarizationBatchResult | null> {
  await reportExpiredSummaryLeases(options.workspaceId, options.client);
  const sessions = await claimPendingSummarySessions(
    options.workspaceId,
    MAX_SESSIONS_PER_BATCH,
    options.client,
  );
  if (sessions.length === 0) return null;

  const { agentRunId, spec } = await startSummarizationRun(options, sessions.map((session) => session.id), summarizationJsonSchema());

  try {
    return await launchBatch(options, sessions, spec);
  } catch (error) {
    await finishAgentRun(options.client, agentRunId, {
      status: "failed",
      failureCode: "summarization_launch_failed",
      failureDetail: describeError(error),
    });
    throw error;
  }
}

/**
 * One run record per batch, linked to every session it holds a lease on. A lease that
 * expires, and a callback that reports back, can then both say which run they mean.
 */
export async function startSummarizationRun(
  options: Pick<LaunchSummarizationBatchOptions, "workspaceId" | "schedule" | "client">,
  sessionIds: string[],
  resultSchema: ReturnType<typeof summarizationJsonSchema>,
): Promise<{ agentRunId: string; spec: AgentRunSpec }> {
  const agentRunId = randomUUID();
  const contextVersionId = await resolveBaseContextVersionId(options.client, options.workspaceId);
  const spec = buildSummarizationRunSpec({
    id: agentRunId,
    workspaceId: options.workspaceId,
    scheduledTaskId: options.schedule.scheduledTaskId,
    occurrenceAt: options.schedule.occurrenceAt,
    contextVersionId,
    resultSchema,
  });
  await createAgentRun(options.client, { spec, idempotencyKey: `summarize:${agentRunId}`, status: "preparing" });
  const { error: linkError } = await options.client
    .from("agent_sessions")
    .update({ summary_agent_run_id: agentRunId })
    .eq("workspace_id", options.workspaceId)
    .in("id", sessionIds);
  if (linkError) {
    await finishAgentRun(options.client, agentRunId, { status: "failed", failureCode: "summarization_launch_failed", failureDetail: linkError.message });
    throw linkError;
  }
  return { agentRunId, spec };
}

async function launchBatch(
  options: LaunchSummarizationBatchOptions,
  sessions: Awaited<ReturnType<typeof claimPendingSummarySessions>>,
  spec: AgentRunSpec,
): Promise<LaunchSummarizationBatchResult> {
  const agentRunId = spec.id;
  const { data: workspaceData, error: workspaceError } = await options.client
    .from("workspaces")
    .select("organization_id")
    .eq("id", options.workspaceId)
    .single();
  if (workspaceError) throw workspaceError;
  const organizationId = (workspaceData as { organization_id: string }).organization_id;

  const sessionInputs = await Promise.all(
    sessions.map(async (session) => ({
      session,
      transcript: await renderSessionTranscript(session.id, options.workspaceId, options.client),
    })),
  );

  const bundle = buildSummarizationBundle({
    organizationId,
    workspaceId: options.workspaceId,
    sessions: sessionInputs,
    runId: summarizationRunId(options.workspaceId, agentRunId),
  });

  const claudeCodeOAuthToken = await resolveInferenceCredential(options.workspaceId, options.client);

  const receipt = await launchFlySandboxRun({
    spec,
    bundle,
    prompt: { kind: "items", manifestPath: bundle.manifestPath },
    credentials: { claudeCodeOAuthToken },
    config: options.config,
  });

  await markAgentRunRunning(options.client, agentRunId, receipt.machineId);

  return {
    runId: receipt.runId,
    machineId: receipt.machineId,
    bundleHash: receipt.bundleHash,
    sessionCount: sessions.length,
  };
}

import { releaseCodexLeaseForRun } from "../../../credentials/codex-credential";
import { loadBuiltInConfig, type BuiltInRoutineConfig } from "../../built-in-config";
import { checkRunAllowed } from "../../check-run-allowed";
import { recordError } from "../../../errors/record-error";
import { launchWithCredentials, reserveCodexRunLogin, RoutineLeaseBusyError } from "../../../metaharness/sandbox/launch-with-credentials";
import { randomUUID } from "node:crypto";
import type { AgentRunSpec } from "draft-core/run-spec";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAgentRun } from "../../../metaharness/runs/agent-run-store";
import { resolveBaseContextVersionId } from "../../../metaharness/runs/base-context";
import { finishAgentRun, markAgentRunRunning } from "../../../metaharness/runs/lifecycle";
import { describeError } from "../../../errors/describe-error";
import { claimPendingSummarySessions } from "./claim-sessions";
import { reportExpiredSummaryLeases } from "./report-expired-leases";
import { renderSessionTranscript } from "./render-transcript";
import { buildSummarizationBundle } from "./build-bundle";
import { buildSummarizationRunSpec } from "./run-spec";
import { summarizationJsonSchema } from "./render-prompt";
import { type SandboxDeploymentConfig } from "../../../metaharness/sandbox";

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

// Returns null when nothing is eligible or the workspace may not run now, mirroring
// dispatchSynthesizeWorkspace's empty-queue short-circuit.
export async function launchSummarizationBatch(
  options: LaunchSummarizationBatchOptions,
): Promise<LaunchSummarizationBatchResult | null> {
  const settings = await loadBuiltInConfig(options.client, options.workspaceId, "summarize_sessions");
  // Before any session is claimed: a claim counts an attempt, and a session is skipped for good after three.
  const admission = await checkRunAllowed(options.workspaceId, options.client, settings.harness, "summarization");
  if (!admission.ok) {
    await recordError({
      client: options.client,
      workspaceId: options.workspaceId,
      scheduledTaskId: options.schedule.scheduledTaskId,
      operation: "scheduling",
      message: `Summarization run denied by admission gate: ${admission.reason}`,
      code: "summarization_admission_denied",
      detail: { reason: admission.reason },
    });
    return null;
  }
  const agentRunId = randomUUID();
  await reportExpiredSummaryLeases(options.workspaceId, options.client);
  if (settings.harness === "codex") {
    try {
      await reserveCodexRunLogin(options.client, options.workspaceId, agentRunId);
    } catch (error) {
      if (!(error instanceof RoutineLeaseBusyError)) throw error;
      console.log(JSON.stringify({ event: "summarization_deferred", workspaceId: options.workspaceId, reason: "codex_login_busy" }));
      return null;
    }
  }

  let started = false;
  let launched = false;
  try {
    const sessions = await claimPendingSummarySessions(options.workspaceId, MAX_SESSIONS_PER_BATCH, options.client);
    if (sessions.length === 0) return null;
    const { spec } = await startSummarizationRun(options, sessions.map((session) => session.id), summarizationJsonSchema(), settings, agentRunId);
    started = true;
    const result = await launchBatch(options, sessions, spec);
    launched = true;
    return result;
  } catch (error) {
    if (started) await finishAgentRun(options.client, agentRunId, {
      status: "failed",
      failureCode: "summarization_launch_failed",
      failureDetail: describeError(error),
    });
    throw error;
  } finally {
    if (!launched && settings.harness === "codex") await releaseCodexLeaseForRun(options.client, options.workspaceId, agentRunId);
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
  savedSettings?: BuiltInRoutineConfig,
  agentRunId = randomUUID(),
): Promise<{ agentRunId: string; spec: AgentRunSpec }> {
  const contextVersionId = await resolveBaseContextVersionId(options.client, options.workspaceId);
  const settings = savedSettings ?? await loadBuiltInConfig(options.client, options.workspaceId, "summarize_sessions");
  const spec = buildSummarizationRunSpec({
    settings,
    id: agentRunId,
    workspaceId: options.workspaceId,
    scheduledTaskId: options.schedule.scheduledTaskId,
    occurrenceAt: options.schedule.occurrenceAt,
    contextVersionId,
    resultSchema,
  });
  await createAgentRun(options.client, { spec, idempotencyKey: `summarize:${agentRunId}`, status: "preparing", scheduledTaskId: options.schedule.scheduledTaskId });
  const { error: linkError } = await options.client
    .from("captured_sessions")
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
    runId: agentRunId,
    instructions: spec.instructions,
  });

  const receipt = await launchWithCredentials({
    spec,
    bundle,
    prompt: { kind: "items", manifestPath: bundle.manifestPath },
    config: options.config,
  }, options.client);

  await markAgentRunRunning(options.client, agentRunId, receipt.machineId);

  return {
    runId: receipt.runId,
    machineId: receipt.machineId,
    bundleHash: receipt.bundleHash,
    sessionCount: sessions.length,
  };
}

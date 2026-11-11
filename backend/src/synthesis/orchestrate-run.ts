import type { SupabaseClient } from "@supabase/supabase-js";
import { checkRunAllowed, RunNotAllowedError } from "./check-run-allowed";
import {
  authenticateSandboxCallbackRequest,
  launchSandboxRun,
} from "../sandbox";
import { loadValidatedRunBundle, PILOT_RUN_BUNDLE_LIMITS } from "./load-run-bundle";
import { finalizeSynthesisResult, InvalidSynthesisResultError } from "./finalize-result";
import { failSynthesisRun } from "./handle-run-failure";
import {
  markRunLaunched,
  OccurrenceAlreadyDispatchedError,
  prepareRun,
  RunPreparationFailedError,
} from "./prepare-run";
import { renderSynthesisPrompt } from "./render-prompt";
import { SYNTHESIS_PERMISSIONS } from "draft-core/tools";
import { syncMembers } from "../people/sync-members";
import { buildSynthesisRunSpec } from "./run-spec";
import { resolveInferenceCredential } from "./resolve-credential";
import type { LaunchSynthesisRunOptions, LaunchSynthesisRunResult } from "./types";
import { saveAgentRunSpec } from "../metaharness/runs/agent-run-store";
import { recordError } from "../errors/record-error";

/**
 * Records why a launch failed. A launch that got as far as creating its run fails that run, which also
 * writes the error row with the run's id. One that did not has only the error row.
 */
export async function recordLaunchFailure(input: {
  client: SupabaseClient;
  runId?: string;
  stage: string;
  options: Pick<LaunchSynthesisRunOptions, "workspaceId" | "scheduledTaskId" | "triggerType">;
  error: unknown;
}): Promise<void> {
  const { client, runId, stage, options, error } = input;
  const operation = stage === "preparation" || stage === "bundle" ? "queue" : "execution";
  const message = `Synthesis launch failed during ${stage}`;
  const code = `synthesis_launch_${stage}_failed`;
  const detail = { stage, trigger_type: options.triggerType };
  if (runId) {
    await failSynthesisRun({ client, runId, failureCode: code, operation, reason: message, error, detail });
  } else {
    await recordError({
      client,
      workspaceId: options.workspaceId,
      scheduledTaskId: options.scheduledTaskId,
      operation,
      message,
      code,
      detail,
      error,
    });
  }
}

/**
 * Launch half of the loop: prepare the run row, load + validate its bundle from
 * Postgres, resolve the credential, render the prompt, and launch the sandbox.
 * Returns once the Fly Machine is created — it does not wait for the sandbox to
 * finish. Completion arrives later via completeSynthesisRunCallback.
 */
export async function launchSynthesisRun(
  options: LaunchSynthesisRunOptions,
): Promise<LaunchSynthesisRunResult> {
  const client = options.client ?? (await import("../db/client")).serviceClient;

  const admission = await checkRunAllowed(options.workspaceId, client);
  if (!admission.ok) {
    await recordError({
      client,
      workspaceId: options.workspaceId,
      scheduledTaskId: options.scheduledTaskId,
      operation: "scheduling",
      message: `Synthesis run denied by admission gate: ${admission.reason}`,
      code: "synthesis_admission_denied",
      detail: { trigger_type: options.triggerType, reason: admission.reason },
    });
    throw new RunNotAllowedError(options.workspaceId, admission.reason);
  }

  let stage = "preparation";
  let runId: string | undefined;
  try {
    runId = await prepareRun(options);

    // Make sure every member is a person, so the roster the run reads can name them.
    await syncMembers(client, options.workspaceId).catch((error) =>
      recordError({ client, workspaceId: options.workspaceId, operation: "ingestion", message: "People sync failed before synthesis", code: "people_sync_failed", error }),
    );

    stage = "bundle";
    const bundle = await loadValidatedRunBundle({
      runId,
      client: options.client,
      limits: PILOT_RUN_BUNDLE_LIMITS,
    });

    stage = "credential";
    const claudeCodeOAuthToken = await resolveInferenceCredential(
      options.workspaceId,
      options.client,
    );
    stage = "prompt";
    const { prompt, jsonSchema } = await renderSynthesisPrompt(bundle, options.dimensions);

    stage = "sandbox";
    const spec = buildSynthesisRunSpec({
      runId,
      workspaceId: options.workspaceId,
      triggerType: options.triggerType,
      scheduledTaskId: options.scheduledTaskId,
      occurrenceAt: options.occurrenceAt,
      retryOfRunId: options.retryOfRunId,
      contextVersionId: bundle.baseContextVersionId,
      resultSchema: jsonSchema,
      permissions: SYNTHESIS_PERMISSIONS,
    });
    await saveAgentRunSpec(client, spec);
    const receipt = await launchSandboxRun({
      spec,
      bundle,
      prompt: { kind: "text", text: prompt },
      credentials: { claudeCodeOAuthToken },
      config: options.config,
    });

    stage = "mark_launched";
    await markRunLaunched(runId, receipt, options.client);

    return { runId, machineId: receipt.machineId, bundleHash: receipt.bundleHash };
  } catch (caught) {
    // Not a failure -- another dispatch already claimed this occurrence.
    if (caught instanceof OccurrenceAlreadyDispatchedError) throw caught;

    // Preparation can fail after the run row exists. Then the row is the one to fail.
    const error = caught instanceof RunPreparationFailedError ? caught.cause : caught;
    runId = runId ?? (caught instanceof RunPreparationFailedError ? caught.runId : undefined);
    await recordLaunchFailure({ client, runId, stage, options, error });
    throw error;
  }
}

/**
 * Callback half of the loop: authenticate the sandbox's HTTP callback and finish the run
 * from its final result and what it wrote. Intended to be called directly from the Bun route
 * handler that owns the /sandbox/callback route.
 */
export async function completeSynthesisRunCallback(
  request: Request,
  callbackSecret: string,
  client?: SupabaseClient,
): Promise<Response> {
  const resolvedClient = client ?? (await import("../db/client")).serviceClient;
  let stage = "callback_auth";
  let runId: string | undefined;
  let workspaceId: string | null = null;
  try {
    const headerRunId = request.headers.get("x-draft-run-id");
    if (headerRunId) {
      const { data: run } = await resolvedClient
        .from("agent_runs")
        .select("workspace_id")
        .eq("id", headerRunId)
        .eq("kind", "synthesis")
        .maybeSingle<{ workspace_id: string }>();
      workspaceId = run?.workspace_id ?? null;
      runId = headerRunId;
    }

    const authenticated = await authenticateSandboxCallbackRequest(request, callbackSecret);
    runId = authenticated.runId;

    // Best-effort and unconditional: saved before validation/commit so it
    // lands even when validateSynthesisResult throws immediately (a
    // runner-reported failure has no `outcome`), and a write hiccup here
    // must never block recording the run's actual outcome below.
    if (authenticated.transcript !== undefined) {
      try {
        const { error: transcriptError } = await resolvedClient
          .from("agent_runs")
          .update({ transcript_json: authenticated.transcript })
          .eq("id", runId);
        if (transcriptError) {
          console.error("completeSynthesisRunCallback: transcript_json update failed", transcriptError);
        }
      } catch (transcriptError) {
        console.error("completeSynthesisRunCallback: transcript_json update threw", transcriptError);
      }
    }

    // A runner-reported failure and an invalid result are final: fail the run
    // once and answer 204 so the runner stops retrying the callback.
    if (typeof authenticated.result === "object" && authenticated.result !== null) {
      const result = authenticated.result as Record<string, unknown>;
      if ("error" in result) {
        const runnerCode = String(result.error);
        await failSynthesisRun({
          client: resolvedClient,
          runId,
          failureCode: "synthesis_runner_failed",
          operation: "execution",
          reason: `Synthesis runner reported a failure: ${runnerCode}`,
          detail: { runner_failure_code: runnerCode, runner_reported_result: result },
        });
        return new Response(null, { status: 204 });
      }
    }

    stage = "validation";
    try {
      await finalizeSynthesisResult(runId, authenticated.result, resolvedClient);
    } catch (validationError) {
      if (!(validationError instanceof InvalidSynthesisResultError)) throw validationError;
      await failSynthesisRun({
        client: resolvedClient,
        runId,
        failureCode: "synthesis_result_invalid",
        operation: "validation",
        reason: "Synthesis result failed validation",
        error: validationError,
      });
      return new Response(null, { status: 204 });
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    await recordError({
      client: resolvedClient,
      workspaceId,
      agentRunId: runId,
      operation: stage === "validation" ? "validation" : "auth",
      message: `Synthesis callback failed during ${stage}`,
      code: `synthesis_${stage}_failed`,
      detail: { stage },
      error,
    });
    throw error;
  }
}

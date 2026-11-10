import type { SupabaseClient } from "@supabase/supabase-js";
import { checkRunAllowed, RunNotAllowedError } from "./check-run-allowed";
import {
  authenticateSandboxCallbackRequest,
  launchFlySandboxRun,
} from "../sandbox";
import { loadValidatedRunBundle, PILOT_RUN_BUNDLE_LIMITS } from "./load-run-bundle";
import { finalizeSynthesisResult, InvalidSynthesisResultError } from "./finalize-result";
import { failSynthesisRun } from "./handle-run-failure";
import {
  markRunLaunched,
  OccurrenceAlreadyDispatchedError,
  prepareRun,
} from "./prepare-run";
import { renderSynthesisPrompt } from "./render-prompt";
import { CONTEXT_READ_WRITE_PERMISSIONS } from "draft-core/agent-run";
import { buildSynthesisRunSpec } from "./run-spec";
import { resolveInferenceCredential } from "./resolve-credential";
import type { LaunchSynthesisRunOptions, LaunchSynthesisRunResult } from "./types";
import { saveAgentRunSpec } from "../metaharness/runs/agent-run-store";
import { recordError } from "../errors/record-error";

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
      permissions: CONTEXT_READ_WRITE_PERMISSIONS,
    });
    await saveAgentRunSpec(client, spec);
    const receipt = await launchFlySandboxRun({
      spec,
      bundle,
      prompt: { kind: "text", text: prompt },
      credentials: { claudeCodeOAuthToken },
      config: options.config,
    });

    stage = "mark_launched";
    await markRunLaunched(runId, receipt, options.client);

    return { runId, machineId: receipt.machineId, bundleHash: receipt.bundleHash };
  } catch (error) {
    // Not a failure -- another dispatch already claimed this occurrence.
    if (error instanceof OccurrenceAlreadyDispatchedError) throw error;

    const operation = stage === "preparation" || stage === "bundle" ? "queue" : "execution";
    const message = `Synthesis launch failed during ${stage}`;
    const code = `synthesis_launch_${stage}_failed`;
    const detail = { stage, trigger_type: options.triggerType };
    if (runId) {
      await failSynthesisRun({
        client,
        runId,
        failureCode: code,
        operation,
        reason: message,
        error,
        detail,
      });
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
        .from("synthesis_runs")
        .select("workspace_id")
        .eq("id", headerRunId)
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
          .from("synthesis_runs")
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
      synthesisRunId: runId,
      operation: stage === "validation" ? "validation" : "auth",
      message: `Synthesis callback failed during ${stage}`,
      code: `synthesis_${stage}_failed`,
      detail: { stage },
      error,
    });
    throw error;
  }
}

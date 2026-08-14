import type { SupabaseClient } from "@supabase/supabase-js";
import { checkRunAllowed, RunNotAllowedError } from "./check-run-allowed";
import {
  authenticateSandboxCallbackRequest,
  launchFlySandboxRun,
} from "../sandbox";
import { loadValidatedRunBundle, PILOT_RUN_BUNDLE_LIMITS } from "./load-run-bundle";
import { commitSynthesisResult } from "./commit-result";
import { markRunFailed, markRunLaunched, prepareRun } from "./prepare-run";
import { renderSynthesisPrompt } from "./render-prompt";
import { resolveInferenceCredential } from "./resolve-credential";
import type {
  LaunchSynthesisRunOptions,
  LaunchSynthesisRunResult,
} from "./types";
import { validateSynthesisResult } from "./validate-result";
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
    const receipt = await launchFlySandboxRun({
      bundle,
      prompt,
      jsonSchema,
      claudeCodeOAuthToken,
      config: options.config,
    });

    stage = "mark_launched";
    await markRunLaunched(runId, receipt, options.client);

    return { runId, machineId: receipt.machineId, bundleHash: receipt.bundleHash };
  } catch (error) {
    await recordError({
      client,
      workspaceId: options.workspaceId,
      scheduledTaskId: options.scheduledTaskId,
      synthesisRunId: runId,
      operation: stage === "preparation" || stage === "bundle" ? "queue" : "execution",
      message: `Synthesis launch failed during ${stage}`,
      code: `synthesis_launch_${stage}_failed`,
      detail: { stage, trigger_type: options.triggerType },
      error,
    });
    if (runId) {
      await markRunFailed(runId, `Synthesis launch failed during ${stage}`, options.client);
    }
    throw error;
  }
}

/**
 * Callback half of the loop: authenticate the sandbox's HTTP callback, validate
 * its result, and commit it. Intended to be called directly from the Bun route
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
  // Captured pre-validation so a runner-reported failure (which has no
  // `outcome` field and makes validateSynthesisResult throw) still ends up
  // in the persisted error's detail, instead of being replaced entirely by
  // the generic "invalid outcome: undefined" validation error.
  let runnerReportedResult: Record<string, unknown> | undefined;
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

    if (typeof authenticated.result === "object" && authenticated.result !== null) {
      const result = authenticated.result as Record<string, unknown>;
      if ("error" in result) runnerReportedResult = result;
    }

    stage = "validation";
    const validated = await validateSynthesisResult(
      runId,
      authenticated.result,
      client,
    );
    // validateSynthesisResult's frozen signature (runId, rawResult, client?) has
    // no way to receive the bundle hash, so it returns a placeholder. The real
    // value is only available here, from the authenticated callback request —
    // fill it in before commit-result.ts (or anything else) relies on it.
    validated.bundleHash = authenticated.bundleHash;

    stage = "commit";
    await commitSynthesisResult(validated, client);

    return new Response(null, { status: 204 });
  } catch (error) {
    await recordError({
      client: resolvedClient,
      workspaceId,
      synthesisRunId: runId,
      operation: stage === "validation" ? "validation" : stage === "commit" ? "commit" : "auth",
      message: `Synthesis callback failed during ${stage}`,
      code: `synthesis_${stage}_failed`,
      detail: { stage, ...(runnerReportedResult ? { runner_reported_result: runnerReportedResult } : {}) },
      error,
    });
    throw error;
  }
}

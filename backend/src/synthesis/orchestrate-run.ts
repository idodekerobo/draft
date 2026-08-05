import type { SupabaseClient } from "@supabase/supabase-js";
import {
  authenticateSandboxCallbackRequest,
  launchFlySandboxRun,
} from "../sandbox";
import { loadValidatedRunBundle, PILOT_RUN_BUNDLE_LIMITS } from "./load-run-bundle";
import { commitSynthesisResult } from "./commit-result";
import { markRunLaunched, prepareRun } from "./prepare-run";
import { renderSynthesisPrompt } from "./render-prompt";
import { resolveInferenceCredential } from "./resolve-credential";
import type {
  LaunchSynthesisRunOptions,
  LaunchSynthesisRunResult,
} from "./types";
import { validateSynthesisResult } from "./validate-result";

/**
 * Launch half of the loop: prepare the run row, load + validate its bundle from
 * Postgres, resolve the credential, render the prompt, and launch the sandbox.
 * Returns once the Fly Machine is created — it does not wait for the sandbox to
 * finish. Completion arrives later via completeSynthesisRunCallback.
 */
export async function launchSynthesisRun(
  options: LaunchSynthesisRunOptions,
): Promise<LaunchSynthesisRunResult> {
  const runId = await prepareRun(options);

  const bundle = await loadValidatedRunBundle({
    runId,
    client: options.client,
    limits: PILOT_RUN_BUNDLE_LIMITS,
  });

  const claudeCodeOAuthToken = await resolveInferenceCredential(
    options.workspaceId,
    options.client,
  );
  const { prompt, jsonSchema } = await renderSynthesisPrompt(bundle);

  const receipt = await launchFlySandboxRun({
    bundle,
    prompt,
    jsonSchema,
    claudeCodeOAuthToken,
    config: options.config,
  });

  // TODO: no reconciliation/heartbeat sweep exists yet to clear a run that
  // never gets a callback (crashed sandbox, dead tunnel, stale image, etc.)
  // -- it stays "running" forever and synthesis_runs_one_active_writer then
  // blocks every future run for the workspace with a 23505 duplicate-key
  // error. Until that sweep exists (M4+), check for and manually mark such
  // rows "failed" first.
  await markRunLaunched(runId, receipt, options.client);

  return { runId, machineId: receipt.machineId, bundleHash: receipt.bundleHash };
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
  const authenticated = await authenticateSandboxCallbackRequest(request, callbackSecret);

  const validated = await validateSynthesisResult(
    authenticated.runId,
    authenticated.result,
    client,
  );
  // validateSynthesisResult's frozen signature (runId, rawResult, client?) has
  // no way to receive the bundle hash, so it returns a placeholder. The real
  // value is only available here, from the authenticated callback request —
  // fill it in before commit-result.ts (or anything else) relies on it.
  validated.bundleHash = authenticated.bundleHash;

  await commitSynthesisResult(validated, client);

  return new Response(null, { status: 204 });
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { claimPendingSummarySessions } from "./claim-sessions";
import { renderSessionTranscript } from "./render-transcript";
import { buildSummarizationBundle } from "./build-bundle";
import { summarizationJsonSchema } from "./render-prompt";
import { resolveInferenceCredential } from "../synthesis/resolve-credential";
import { launchFlySandboxRun, type SandboxDeploymentConfig } from "../sandbox";

const MAX_SESSIONS_PER_BATCH = 25;

export interface LaunchSummarizationBatchOptions {
  workspaceId: string;
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
  const sessions = await claimPendingSummarySessions(
    options.workspaceId,
    MAX_SESSIONS_PER_BATCH,
    options.client,
  );
  if (sessions.length === 0) return null;

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
  });

  const claudeCodeOAuthToken = await resolveInferenceCredential(options.workspaceId, options.client);

  const receipt = await launchFlySandboxRun({
    bundle,
    jsonSchema: summarizationJsonSchema(),
    claudeCodeOAuthToken,
    config: options.config,
    mode: "batch",
    manifestPath: bundle.manifestPath,
  });

  return {
    runId: receipt.runId,
    machineId: receipt.machineId,
    bundleHash: receipt.bundleHash,
    sessionCount: sessions.length,
  };
}

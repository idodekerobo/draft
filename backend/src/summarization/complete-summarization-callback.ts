import type { SupabaseClient } from "@supabase/supabase-js";
import { finishAgentRun } from "../metaharness/runs/lifecycle";
import { describeError } from "../errors/describe-error";
import { authenticateSandboxCallbackRequest } from "../sandbox";
import { validateSummarizationResult } from "./validate-result";
import { materializeSessionSummary } from "./materialize-summary";
import { recordError } from "../errors/record-error";
import type { AgentSessionRow } from "../types/tables";

export const SUMMARIZATION_RUN_ID_PREFIX = "summarize:";

// A batch reports under its agent run's id. Before kind routing it reported as
// summarize:<workspaceId>:<agent run id>; that form is still read so a batch started
// before the change can finish. TODO: remove the prefix once no such run can be in flight.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The agent run behind a summarization run id, or null for an id that does not end in one. */
export function parseAgentRunIdFromSummarizationRunId(runId: string): string | null {
  if (!parseWorkspaceIdFromSummarizationRunId(runId)) return null;
  const last = runId.slice(runId.lastIndexOf(":") + 1);
  return UUID_PATTERN.test(last) ? last : null;
}

export function parseWorkspaceIdFromSummarizationRunId(runId: string): string | null {
  if (!runId.startsWith(SUMMARIZATION_RUN_ID_PREFIX)) return null;
  const rest = runId.slice(SUMMARIZATION_RUN_ID_PREFIX.length);
  const separatorIndex = rest.lastIndexOf(":");
  if (separatorIndex <= 0) return null;
  return rest.slice(0, separatorIndex);
}

export function parseRunnerFailure(result: unknown): { error: string; diagnostics: unknown } | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const { error, diagnostics, items } = result as Record<string, unknown>;
  if (items !== undefined || typeof error !== "string") return null;
  return { error, diagnostics };
}

export async function completeSummarizationRunCallback(
  request: Request,
  callbackSecret: string,
  client?: SupabaseClient,
): Promise<Response> {
  const resolvedClient = client ?? (await import("../db/client")).serviceClient;
  let stage = "callback_auth";
  let runId: string | undefined;
  let workspaceId: string | null = null;
  let agentRunId: string | null = null;
  try {
    const authenticated = await authenticateSandboxCallbackRequest(request, callbackSecret);
    runId = authenticated.runId;
    // An id minted before kind routing carries the workspace; otherwise the id is the agent run's.
    workspaceId = parseWorkspaceIdFromSummarizationRunId(authenticated.runId);
    agentRunId = parseAgentRunIdFromSummarizationRunId(authenticated.runId);
    if (!workspaceId && UUID_PATTERN.test(authenticated.runId)) {
      agentRunId = authenticated.runId;
      const { data: runRow, error: runError } = await resolvedClient.from("agent_runs").select("workspace_id").eq("id", agentRunId).eq("kind", "summarization").maybeSingle();
      if (runError) throw runError;
      workspaceId = (runRow as { workspace_id: string } | null)?.workspace_id ?? null;
    }
    if (!workspaceId) throw new Error(`Cannot recover workspace from run id: ${authenticated.runId}`);

    // The runner reports setup failures (e.g. bundle fetch) as {error, diagnostics}
    // instead of {items}. Record the real reason and ack so it doesn't retry.
    const runnerFailure = parseRunnerFailure(authenticated.result);
    if (runnerFailure) {
      await recordError({
        client: resolvedClient,
        workspaceId,
        operation: "execution",
        message: `Summarization runner failed: ${runnerFailure.error}`,
        code: "summarization_runner_failed",
        detail: { run_id: runId, diagnostics: runnerFailure.diagnostics },
        error: new Error(`summarization runner reported ${runnerFailure.error}`),
      });
      if (agentRunId) await finishAgentRun(resolvedClient, agentRunId, { status: "failed", failureCode: "summarization_runner_failed", failureDetail: runnerFailure.error });
      return new Response(null, { status: 204 });
    }

    stage = "validation";
    const items = validateSummarizationResult(authenticated.result);

    stage = "materialize";
    if (items.length > 0) {
      const { data, error } = await resolvedClient
        .from("agent_sessions")
        .select("*")
        .eq("workspace_id", workspaceId)
        .in("id", items.map((item) => item.sessionId));
      if (error) throw error;
      const sessionsById = new Map(((data ?? []) as AgentSessionRow[]).map((session) => [session.id, session]));

      for (const item of items) {
        const session = sessionsById.get(item.sessionId);
        // Session may have been deleted since claiming -- nothing to update.
        if (!session) continue;
        await materializeSessionSummary(
          session,
          item.ok ? { ok: true, payload: item.payload! } : { ok: false, error: item.error },
          resolvedClient,
        );
      }
    }

    if (agentRunId) {
      const summarized = items.filter((item) => item.ok).length;
      await finishAgentRun(resolvedClient, agentRunId, { status: "succeeded", summary: `${summarized} of ${items.length} sessions summarized` });
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    if (agentRunId) await finishAgentRun(resolvedClient, agentRunId, { status: "failed", failureCode: `summarization_${stage}_failed`, failureDetail: describeError(error) });
    await recordError({
      client: resolvedClient,
      workspaceId,
      operation: stage === "validation" ? "validation" : stage === "materialize" ? "commit" : "auth",
      message: `Summarization callback failed during ${stage}`,
      code: `summarization_${stage}_failed`,
      detail: { stage, run_id: runId },
      error,
    });
    throw error;
  }
}

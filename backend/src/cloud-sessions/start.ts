import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIVE_AGENT_RUN_STATUSES, parseAgentRunId, parseWorkspaceId } from "draft-core/run-spec";
import { cloudHostId } from "../auth/with-host-auth";
import { CredentialError } from "../credentials/crypto";
import { resolveCredential as resolveHarnessCredential } from "../credentials/harness-credential";
import { recordError } from "../errors/record-error";
import { createAgentRun } from "../metaharness/runs/agent-run-store";
import { resolveBaseContextVersionId } from "../metaharness/runs/base-context";
import { createAgentRunToken } from "../metaharness/runs/run-token";
import type { SandboxDeploymentConfig } from "../metaharness/sandbox/config";
import type { SandboxProvider, SandboxRef } from "../metaharness/sandbox/providers";
import type { ErrorOperation } from "../types/enums";
import { claudeCredentialRules } from "./claude-credential";
import type { CloudStartInput } from "./parse-start";
import { buildCloudRunSpec } from "./run-spec";
import { cloudSandboxEnv } from "./sandbox-env";

export const CLOUD_HOST_NAME = "Draft cloud";
/** The volume that holds the workspace and HOME, so a sleeping session keeps its files. */
export const CLOUD_VOLUME_GB = 10;
const RUN_TOKEN_TTL_MS = 24 * 60 * 60 * 1_000;
const START_FAILED = "start_failed";

export interface StartCloudSessionDeps {
  client: SupabaseClient;
  provider: SandboxProvider;
  config: SandboxDeploymentConfig;
  /** Signs the run token. It is the sandbox callback secret, which run tokens derive their own key from. */
  tokenSecret: string;
  resolveCredential?: typeof resolveHarnessCredential;
  now?: () => number;
  newId?: () => string;
}

export type StartCloudSessionOutcome = { ok: true; sessionId: string } | { ok: false; status: 409 | 500 | 502; error: string };

interface StartFailure {
  status: 409 | 502;
  /** The response code the client gets. */
  response: string;
  /** The error row's code, and the run's failure code. */
  code: string;
  operation: ErrorOperation;
  message: string;
  cause?: unknown;
  /** A refusal is a client-side problem, so it marks the run and session but records no error row. */
  refusal?: boolean;
}

/**
 * Starts a cloud session: a session row, its first run, and a sandbox that runs the host. A failure after the
 * session row exists ends the session as start_failed, fails the run, and destroys any sandbox it made.
 */
export async function startCloudSession(input: CloudStartInput, deps: StartCloudSessionDeps): Promise<StartCloudSessionOutcome> {
  const { client, provider, config } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const resolveCredential = deps.resolveCredential ?? resolveHarnessCredential;
  const { workspaceId, ownerUserId, seed } = input;
  const sessionId = newId();
  const runId = newId();

  const { error: insertError } = await client
    .from("sessions")
    .insert({
      id: sessionId,
      workspace_id: workspaceId,
      owner_user_id: ownerUserId,
      harness: input.harness,
      model: input.model,
      reasoning_effort: input.reasoningEffort,
      host_id: cloudHostId(sessionId),
      host_name: CLOUD_HOST_NAME,
      git_remote: seed.gitRemote,
      seed: { kind: "repo", branch: seed.branch },
      runtime: "cloud",
      status: "starting",
    })
    .select("id")
    .single();
  if (insertError) {
    await recordError({ client, workspaceId, operation: "session", code: "session_create_failed", message: "Creating a cloud session failed", error: insertError });
    return { ok: false, status: 500, error: "session_create_failed" };
  }

  let runCreated = false;
  let sandbox: SandboxRef | null = null;

  const abandon = async (failure: StartFailure): Promise<StartCloudSessionOutcome> => {
    const agentRunId = runCreated ? runId : null;
    if (!failure.refusal) {
      await recordError({ client, workspaceId, sessionId, agentRunId, operation: failure.operation, code: failure.code, message: failure.message, error: failure.cause });
    }
    if (sandbox) {
      try {
        await provider.destroy(sandbox);
      } catch (cause) {
        await recordError({ client, workspaceId, sessionId, agentRunId, operation: "execution", code: "sandbox_destroy_failed", message: "Destroying the sandbox of a cloud session that did not start failed", error: cause });
      }
    }
    if (runCreated) {
      const { error } = await client
        .from("agent_runs")
        .update({ status: "failed", completed_at: new Date(now()).toISOString(), failure_code: failure.code, failure_detail: failure.message })
        .eq("id", runId)
        .in("status", ACTIVE_AGENT_RUN_STATUSES);
      if (error) await recordError({ client, workspaceId, sessionId, agentRunId, operation: "session", code: "run_fail_update_failed", message: "Marking a cloud session's run as failed failed", error });
    }
    const { error: endError } = await client
      .from("sessions")
      .update({ status: "ended", ended_at: new Date(now()).toISOString(), end_reason: START_FAILED, open_approval_count: 0 })
      .eq("id", sessionId)
      .neq("status", "ended");
    if (endError) await recordError({ client, workspaceId, sessionId, operation: "session", code: "session_end_failed", message: "Ending a cloud session that did not start failed", error: endError });
    return { ok: false, status: failure.status, error: failure.response };
  };

  try {
    const contextVersionId = await resolveBaseContextVersionId(client, workspaceId);
    const spec = buildCloudRunSpec({
      runId,
      workspaceId,
      ownerUserId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      network: input.network,
      contextVersionId,
      repo: seed.repo,
    });
    await createAgentRun(client, { spec, idempotencyKey: `cloud-session:${sessionId}`, status: "preparing", sessionId });
    runCreated = true;
  } catch (cause) {
    return abandon({ status: 502, response: START_FAILED, code: "run_create_failed", operation: "session", message: "Creating the run of a cloud session failed", cause });
  }

  let claudeToken: string;
  try {
    ({ secret: claudeToken } = await resolveCredential(client, workspaceId, claudeCredentialRules));
  } catch (cause) {
    if (cause instanceof CredentialError) {
      return abandon({ status: 409, response: "claude_not_connected", code: "claude_not_connected", operation: "session", message: "The workspace has no usable Claude Code login", cause, refusal: true });
    }
    return abandon({ status: 502, response: START_FAILED, code: "claude_credential_failed", operation: "session", message: "Reading the workspace's Claude Code login failed", cause });
  }

  let created: SandboxRef;
  try {
    const runToken = createAgentRunToken(
      { runId: parseAgentRunId(runId), workspaceId: parseWorkspaceId(workspaceId), expiresAt: now() + RUN_TOKEN_TTL_MS, nonce: newId() },
      deps.tokenSecret,
    );
    const env = cloudSandboxEnv({
      sessionId,
      workspaceId,
      runId,
      runToken,
      claudeToken,
      seed: { kind: "repo", gitRemote: seed.gitRemote, branch: seed.branch },
      network: input.network,
      callbackUrl: config.callbackUrl,
      supabaseUrl: config.supabaseUrl,
    });
    created = await provider.create({ runId, env, metadata: { session_id: sessionId, run_id: runId, kind: "cloud_session" }, volume: { sizeGb: CLOUD_VOLUME_GB } });
  } catch (cause) {
    return abandon({ status: 502, response: START_FAILED, code: "sandbox_create_failed", operation: "execution", message: "Creating the sandbox of a cloud session failed", cause });
  }
  sandbox = created;

  // Saved before the start, so a crash between create and start still leaves the machine findable.
  try {
    const { error: sessionError } = await client.from("sessions").update({ sandbox_volume: created.volume }).eq("id", sessionId);
    if (sessionError) throw sessionError;
    const { error: runError } = await client.from("agent_runs").update({ sandbox_machine_id: created.machine }).eq("id", runId);
    if (runError) throw runError;
  } catch (cause) {
    return abandon({ status: 502, response: START_FAILED, code: "sandbox_record_failed", operation: "session", message: "Saving the sandbox of a cloud session failed", cause });
  }

  try {
    await provider.start(created);
  } catch (cause) {
    return abandon({ status: 502, response: START_FAILED, code: "sandbox_start_failed", operation: "execution", message: "Starting the sandbox of a cloud session failed", cause });
  }

  const { error: runningError } = await client
    .from("agent_runs")
    .update({ status: "running", started_at: new Date(now()).toISOString() })
    .eq("id", runId)
    .in("status", ACTIVE_AGENT_RUN_STATUSES);
  if (runningError) {
    return abandon({ status: 502, response: START_FAILED, code: "run_start_failed", operation: "session", message: "Marking the run of a cloud session as running failed", cause: runningError });
  }
  return { ok: true, sessionId };
}

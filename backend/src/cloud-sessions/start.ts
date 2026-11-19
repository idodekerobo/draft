import { randomUUID } from "node:crypto";
import { ACTIVE_AGENT_RUN_STATUSES } from "draft-core/run-spec";
import { cloudHostId } from "../auth/with-host-auth";
import { CredentialError } from "../credentials/crypto";
import { resolveCredential as resolveHarnessCredential } from "../credentials/harness-credential";
import { recordError } from "../errors/record-error";
import { createAgentRun } from "../metaharness/runs/agent-run-store";
import type { SandboxRef } from "../metaharness/sandbox/providers";
import type { ErrorOperation } from "../types/enums";
import { claudeCredentialRules } from "./claude-credential";
import { START_FAILED, cloudRunEnv, cloudRunSpec, endCloudSession, failRun, hostSeedFor, snapshotStoreOf, type CloudSessionDeps } from "./launch";
import type { CloudSeed, CloudStartInput } from "./parse-start";
import { loadRoutineRunSource, type RoutineRunSource } from "./routine-seed";
import { discardSnapshot } from "./snapshot-seed";
import type { SeedSpec } from "../sandbox/host/config";

/** The volume that holds the workspace and HOME, so a sleeping session keeps its files. */
export const CLOUD_VOLUME_GB = 10;

export type StartCloudSessionDeps = CloudSessionDeps;

export type StartCloudSessionOutcome = { ok: true; sessionId: string } | { ok: false; status: 404 | 409 | 500 | 502; error: string };

interface StartFailure {
  status: 404 | 409 | 502;
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
  const begun = await beginCloudSession(input, deps);
  return begun.ok ? begun.launch : begun;
}

export type BegunCloudSession = { ok: true; sessionId: string; launch: Promise<StartCloudSessionOutcome> } | Extract<StartCloudSessionOutcome, { ok: false }>;

/**
 * Creates the session and its run, then boots the sandbox in `launch`. A caller can answer as soon as the rows
 * exist and let the sandbox boot behind it. `launch` never rejects: a failure ends the session as start_failed.
 */
export async function beginCloudSession(input: CloudStartInput, deps: StartCloudSessionDeps): Promise<BegunCloudSession> {
  const { client, provider } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const resolveCredential = deps.resolveCredential ?? resolveHarnessCredential;
  const { workspaceId, ownerUserId, seed } = input;
  const snapshots = snapshotStoreOf(deps);
  // A snapshot's session id is its object key's, so the upload sits under the session that starts from it.
  const sessionId = seed.kind === "snapshot" ? seed.sessionId : newId();
  const runId = newId();

  // Checked before any row exists, so a snapshot that never finished uploading leaves nothing behind.
  if (seed.kind === "snapshot") {
    let uploaded: boolean;
    try {
      uploaded = await snapshots.exists(seed.storageKey);
    } catch (cause) {
      await recordError({ client, workspaceId, operation: "session", code: "snapshot_check_failed", message: "Checking the uploaded folder snapshot failed", error: cause });
      return { ok: false, status: 502, error: START_FAILED };
    }
    if (!uploaded) return { ok: false, status: 409, error: "seed_not_uploaded" };
  }

  // A continued chat names a finished run. Its history is read through Draft's tools, so nothing is copied here.
  let routineSource: RoutineRunSource | null = null;
  if (seed.kind === "routine_run") {
    const loaded = await loadRoutineRunSource(client, workspaceId, ownerUserId, seed.routineSessionId);
    if (!loaded.ok) return { ok: false, status: loaded.status, error: loaded.error };
    routineSource = loaded.source;
  }

  // Checked before any row exists, so a workspace without a Claude login gets no empty, ended session.
  let claudeToken: string;
  try {
    ({ secret: claudeToken } = await resolveCredential(client, workspaceId, claudeCredentialRules));
  } catch (cause) {
    if (cause instanceof CredentialError) return { ok: false, status: 409, error: "claude_not_connected" };
    await recordError({ client, workspaceId, operation: "session", code: "claude_credential_failed", message: "Reading the workspace's Claude Code login failed", error: cause });
    return { ok: false, status: 502, error: START_FAILED };
  }

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
      // A sandbox has no machine name to show; the app names the place from runtime.
      host_name: null,
      git_remote: seed.kind === "repo" ? seed.gitRemote : null,
      folder_name: folderNameOf(seed),
      title: routineSource ? `Continued: ${routineSource.routineTitle}` : null,
      seed: storedSeedOf(seed),
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

  const abandon = async (failure: StartFailure): Promise<Extract<StartCloudSessionOutcome, { ok: false }>> => {
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
    if (runCreated) await failRun(client, { workspaceId, sessionId, runId, code: failure.code, message: failure.message, now });
    await endCloudSession(client, { workspaceId, sessionId, reason: START_FAILED, now });
    // A session that did not start can never start again, so its snapshot is no longer needed.
    if (seed.kind === "snapshot") await discardSnapshot(snapshots, seed.storageKey, { client, workspaceId, sessionId });
    return { ok: false, status: failure.status, error: failure.response };
  };

  if (routineSource) {
    const { error: promptError } = await client.rpc("create_session_input", {
      p_session_id: sessionId,
      p_workspace_id: workspaceId,
      p_author_user_id: ownerUserId,
      p_author_name: null,
      p_kind: "message",
      p_payload: { text: routineSource.prompt },
    });
    if (promptError) {
      return abandon({ status: 502, response: START_FAILED, code: "seed_prompt_failed", operation: "session", message: "Queueing the routine run's history for the new chat failed", cause: promptError });
    }
  }

  try {
    const spec = await cloudRunSpec(client, {
      runId,
      workspaceId,
      ownerUserId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      network: input.network,
      repo: seed.kind === "repo" ? seed.repo : null,
    });
    await createAgentRun(client, { spec, idempotencyKey: `cloud-session:${sessionId}`, status: "preparing", sessionId });
    runCreated = true;
  } catch (cause) {
    return abandon({ status: 502, response: START_FAILED, code: "run_create_failed", operation: "session", message: "Creating the run of a cloud session failed", cause });
  }

  const launchSandbox = async (): Promise<StartCloudSessionOutcome> => {
    let hostSeed: SeedSpec;
    try {
      hostSeed = await hostSeedFor(seed, snapshots);
    } catch (cause) {
      return abandon({ status: 502, response: START_FAILED, code: "snapshot_link_failed", operation: "session", message: "Creating the download link of the folder snapshot failed", cause });
    }

    let created: SandboxRef;
    try {
      const env = cloudRunEnv({ sessionId, workspaceId, runId, claudeToken, seed: hostSeed, network: input.network }, deps);
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
  };
  const launch = launchSandbox().catch((cause) =>
    abandon({ status: 502, response: START_FAILED, code: "sandbox_launch_failed", operation: "execution", message: "Launching the sandbox of a cloud session failed", cause }),
  );
  return { ok: true, sessionId, launch };
}

/** The list shows the repository name where a local session shows its folder. */
function repoName(gitRemote: string): string {
  return gitRemote.replace(/\.git$/, "").split("/").pop() || gitRemote;
}

/** The list shows the repository name, the folder's name, or nothing for a chat that continues a routine run. */
function folderNameOf(seed: CloudSeed): string | null {
  if (seed.kind === "repo") return repoName(seed.gitRemote);
  return seed.kind === "snapshot" ? seed.folderName : null;
}

/** The seed as the session row keeps it. A repository keeps its branch only, since its remote has its own column. */
function storedSeedOf(seed: CloudSeed): Record<string, unknown> {
  if (seed.kind === "repo") return { kind: "repo", branch: seed.branch };
  if (seed.kind === "snapshot") return { kind: "snapshot", storageKey: seed.storageKey };
  if (seed.kind === "empty") return { kind: "empty" };
  return { kind: "routine_run", routineSessionId: seed.routineSessionId };
}

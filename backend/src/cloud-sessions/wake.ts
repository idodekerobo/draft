import { randomUUID } from "node:crypto";
import { ACTIVE_AGENT_RUN_STATUSES } from "draft-core/run-spec";
import { CredentialError } from "../credentials/crypto";
import { resolveCredential as resolveHarnessCredential } from "../credentials/harness-credential";
import { recordError } from "../errors/record-error";
import { createAgentRun, specFromRow } from "../metaharness/runs/agent-run-store";
import type { SandboxRef, VolumeRef } from "../metaharness/sandbox/providers";
import type { ErrorOperation } from "../types/enums";
import type { AgentRunRow, SessionRow } from "../types/tables";
import { claudeCredentialRules } from "./claude-credential";
import { START_FAILED, cloudRunEnv, cloudRunSpec, endCloudSession, failRun, hostSeedFor, snapshotStoreOf, type CloudSessionDeps, type StoredSeed } from "./launch";
import { parseGitHubRemote } from "./parse-start";
import type { SeedSpec } from "../sandbox/host/config";

/** A sleeping session whose last runs all failed is ended, so a broken sandbox cannot wake it forever. */
export const RESTART_LIMIT = 3;
const CLAUDE_NOT_CONNECTED = "claude_not_connected";

export interface WakeCloudSessionInput {
  workspaceId: string;
  sessionId: string;
}

export type WakeCloudSessionOutcome = { status: "woken"; runId: string } | { status: "not_claimed" } | { status: "ended" } | { status: "failed" };

interface WakeFailure {
  operation: ErrorOperation;
  code: string;
  message: string;
  cause?: unknown;
  /** A refusal (no Claude login) marks the run and session but records no error row. */
  refusal?: boolean;
}

/**
 * Starts a new run of a sleeping cloud session. Only the claim winner starts one. A machine still on the volume is
 * replaced, since a machine keeps the environment, and so the run token, it was created with.
 */
export async function wakeCloudSession(input: WakeCloudSessionInput, deps: CloudSessionDeps): Promise<WakeCloudSessionOutcome> {
  const { client, provider } = deps;
  const { workspaceId, sessionId } = input;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const resolveCredential = deps.resolveCredential ?? resolveHarnessCredential;

  const { data: claimed, error: claimError } = await client.rpc("claim_cloud_session_wake", { p_session_id: sessionId, p_workspace_id: workspaceId });
  if (claimError) {
    await recordError({ client, workspaceId, sessionId, operation: "session", code: "wake_claim_failed", message: "Claiming a sleeping cloud session for a wake failed", error: claimError });
    return { status: "failed" };
  }
  if (claimed !== true) return { status: "not_claimed" };

  const runId = newId();
  let runCreated = false;
  let created: SandboxRef | null = null;

  // The session is already claimed, so every failure puts it back to sleeping. Only this wake's machine is removed.
  const abandon = async (failure: WakeFailure): Promise<WakeCloudSessionOutcome> => {
    const agentRunId = runCreated ? runId : null;
    if (!failure.refusal) {
      await recordError({ client, workspaceId, sessionId, agentRunId, operation: failure.operation, code: failure.code, message: failure.message, error: failure.cause });
    }
    if (created) {
      try {
        await provider.destroyMachine(created);
      } catch (cause) {
        await recordError({ client, workspaceId, sessionId, agentRunId, operation: "execution", code: "sandbox_destroy_failed", message: "Removing the machine of a failed wake failed", error: cause });
      }
    }
    if (runCreated) await failRun(client, { workspaceId, sessionId, runId, code: failure.code, message: failure.message, now });
    const { error } = await client.from("sessions").update({ status: "sleeping" }).eq("id", sessionId).eq("status", "starting");
    if (error) {
      await recordError({ client, workspaceId, sessionId, agentRunId, operation: "session", code: "session_sleep_restore_failed", message: "Returning a cloud session to sleeping after a failed wake failed", error });
    }
    return { status: "failed" };
  };

  const { data: session, error: sessionError } = await client.from("sessions").select("*").eq("id", sessionId).eq("workspace_id", workspaceId).maybeSingle<SessionRow>();
  if (sessionError || !session) {
    return abandon({ operation: "session", code: "wake_session_lookup_failed", message: "Reading a sleeping cloud session failed", cause: sessionError });
  }

  // A refused wake never made a machine and says nothing about the sandbox, so it does not count. A NULL code must still match.
  const { data: recent, error: recentError } = await client
    .from("agent_runs")
    .select("*")
    .eq("session_id", sessionId)
    .eq("workspace_id", workspaceId)
    .or(`failure_code.is.null,failure_code.neq.${CLAUDE_NOT_CONNECTED}`)
    .order("created_at", { ascending: false })
    .limit(RESTART_LIMIT);
  if (recentError) return abandon({ operation: "session", code: "wake_run_lookup_failed", message: "Reading the runs of a sleeping cloud session failed", cause: recentError });
  const runs = (recent ?? []) as AgentRunRow[];
  if (runs.length === RESTART_LIMIT && runs.every((run) => run.status === "failed")) {
    await endCloudSession(client, { workspaceId, sessionId, reason: START_FAILED, now });
    const { error: inputsError } = await client
      .from("session_inputs")
      .update({ state: "failed", reason: "session_ended", updated_at: new Date(now()).toISOString() })
      .eq("session_id", sessionId)
      .eq("state", "queued");
    if (inputsError) {
      await recordError({ client, workspaceId, sessionId, operation: "session", code: "wake_inputs_failed", message: "Failing the queued messages of an ended cloud session failed", error: inputsError });
    }
    await recordError({ client, workspaceId, sessionId, operation: "session", code: "restart_limit_reached", message: `A cloud session failed its last ${RESTART_LIMIT} runs, so it was ended` });
    return { status: "ended" };
  }

  const latest = runs[0];
  if (!latest) return abandon({ operation: "session", code: "wake_run_missing", message: "The sleeping session has no earlier run to wake from" });
  const seed = storedSeedOf(session);
  if (!seed) return abandon({ operation: "session", code: "session_seed_invalid", message: "The sleeping session has no seed to wake from" });
  const repo = seed.kind === "repo" ? (parseGitHubRemote(seed.gitRemote)?.repo ?? null) : null;

  let network: "restricted" | "open";
  try {
    network = specFromRow(latest).network;
  } catch (cause) {
    return abandon({ operation: "session", code: "run_spec_failed", message: "Reading the spec of the session's last run failed", cause });
  }

  try {
    const spec = await cloudRunSpec(client, {
      runId,
      workspaceId,
      ownerUserId: session.owner_user_id,
      model: session.model,
      reasoningEffort: session.reasoning_effort,
      network,
      repo,
    });
    await createAgentRun(client, { spec, idempotencyKey: `cloud-session:${sessionId}:${runId}`, status: "preparing", sessionId });
    runCreated = true;
  } catch (cause) {
    return abandon({ operation: "session", code: "run_create_failed", message: "Creating the run of a woken cloud session failed", cause });
  }

  let claudeToken: string;
  try {
    ({ secret: claudeToken } = await resolveCredential(client, workspaceId, claudeCredentialRules));
  } catch (cause) {
    if (cause instanceof CredentialError) {
      return abandon({ operation: "session", code: CLAUDE_NOT_CONNECTED, message: "The workspace has no usable Claude Code login", cause, refusal: true });
    }
    return abandon({ operation: "session", code: "claude_credential_failed", message: "Reading the workspace's Claude Code login failed", cause });
  }

  // The first link has expired. The host downloads this one only when the workspace is missing from the volume.
  let hostSeed: SeedSpec;
  try {
    hostSeed = await hostSeedFor(seed, snapshotStoreOf(deps));
  } catch (cause) {
    return abandon({ operation: "session", code: "snapshot_link_failed", message: "Creating the download link of the folder snapshot failed", cause });
  }

  const volume = volumeOf(session.sandbox_volume);
  if (!volume) return abandon({ operation: "session", code: "sandbox_volume_missing", message: "The sleeping session has no sandbox volume to wake on" });

  try {
    if (latest.sandbox_machine_id) {
      const previous: SandboxRef = { provider: volume.provider, machine: latest.sandbox_machine_id, volume };
      const state = await provider.status(previous);
      if (state === "running") {
        await recordError({ client, workspaceId, sessionId, agentRunId: runId, operation: "execution", code: "sandbox_running_on_wake", message: "The machine of a sleeping session was still running, so the wake replaced it" });
      }
      if (state !== "missing") await provider.destroyMachine(previous);
    }
  } catch (cause) {
    return abandon({ operation: "execution", code: "sandbox_replace_failed", message: "Removing the old machine of a sleeping session failed", cause });
  }

  let machine: SandboxRef;
  try {
    const env = cloudRunEnv({ sessionId, workspaceId, runId, claudeToken, seed: hostSeed, network }, deps);
    machine = await provider.create({ runId, env, metadata: { session_id: sessionId, run_id: runId, kind: "cloud_session" }, volume: { existing: volume } });
  } catch (cause) {
    return abandon({ operation: "execution", code: "sandbox_create_failed", message: "Creating the machine of a woken cloud session failed", cause });
  }
  created = machine;

  try {
    const { error } = await client.from("agent_runs").update({ sandbox_machine_id: machine.machine }).eq("id", runId);
    if (error) throw error;
  } catch (cause) {
    return abandon({ operation: "session", code: "sandbox_record_failed", message: "Saving the machine of a woken cloud session failed", cause });
  }

  try {
    await provider.start(machine);
  } catch (cause) {
    return abandon({ operation: "execution", code: "sandbox_start_failed", message: "Starting the machine of a woken cloud session failed", cause });
  }

  const { error: runningError } = await client
    .from("agent_runs")
    .update({ status: "running", started_at: new Date(now()).toISOString() })
    .eq("id", runId)
    .in("status", ACTIVE_AGENT_RUN_STATUSES);
  if (runningError) {
    return abandon({ operation: "session", code: "run_start_failed", message: "Marking the run of a woken cloud session as running failed", cause: runningError });
  }
  return { status: "woken", runId };
}

/** The seed a session was started from, read back from its row. Null when the row has none. */
function storedSeedOf(session: SessionRow): StoredSeed | null {
  const seed = session.seed as { kind?: unknown; branch?: unknown; storageKey?: unknown } | null;
  if (seed?.kind === "snapshot") return typeof seed.storageKey === "string" ? { kind: "snapshot", storageKey: seed.storageKey } : null;
  if (!session.git_remote || seed?.kind !== "repo" || typeof seed.branch !== "string") return null;
  return { kind: "repo", gitRemote: session.git_remote, branch: seed.branch };
}

/** The sandbox volume the session's first run created, read back from its row. */
function volumeOf(value: unknown): VolumeRef | null {
  if (typeof value !== "object" || value === null) return null;
  const { provider, id, region } = value as Record<string, unknown>;
  return typeof provider === "string" && typeof id === "string" && typeof region === "string" ? { provider, id, region } : null;
}

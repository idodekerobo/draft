import { describe, expect, it, mock } from "bun:test";
import { dispatchAgentRoutine } from "../../routines/dispatch-routine";
import { failStaleRoutineSessions } from "../../routines/fail-stale-routine-sessions";
import { CredentialError } from "../../credentials/crypto";
import { RoutineLeaseBusyError, type LaunchRoutineRun } from "../../routines/launch-routine-run";
import type { ScheduledTaskRow } from "../../types/tables";
import { fakeClient, fakeDb } from "./fake-client";

const WS_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "55555555-5555-4555-8555-555555555555";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const OWNER_ID = "66666666-6666-4666-8666-666666666666";
const TEAM_ID = "77777777-7777-4777-8777-777777777777";

const task = {
  id: TASK_ID,
  workspace_id: WS_ID,
  task_type: "agent_routine",
  created_by_user_id: OWNER_ID,
  config_json: { title: "Weekly digest", prompt: "Summarize the week.", harness: "claude", model: "haiku" },
} as unknown as ScheduledTaskRow;

const newDb = (
  workspace: Record<string, unknown> | null = { id: WS_ID, team_id: TEAM_ID, timezone: "UTC", current_context_version_id: VERSION_ID },
  owner: Record<string, unknown> = { id: OWNER_ID, status: "active", primary_team_id: TEAM_ID },
) =>
  fakeDb(
    {
      users: [owner],
      sessions: [],
      errors: [],
      agent_runs: [],
      workspaces: workspace ? [workspace] : [],
      workspace_context_versions: [{ id: VERSION_ID, version_number: 1, documents_json: { "a.md": { content: "A", sha256: "a".repeat(64) } } }],
    },
    {
      unique: { sessions: [["workspace_id", "idempotency_key"]], agent_runs: [["workspace_id", "idempotency_key"]] },
      rpcs: { commit_context_write: () => ({ data: { status: "committed", new_version_id: "99999999-9999-4999-8999-999999999999", version_number: 1 } }) },
    },
  );
const sandboxConfig = {} as never;
const okLaunch = () => mock<LaunchRoutineRun>(async () => {});

function dispatch(db: ReturnType<typeof newDb>, launch: LaunchRoutineRun, occurrenceAt = "2026-10-27T09:00:00.000Z", overrides: Partial<ScheduledTaskRow> = {}) {
  return dispatchAgentRoutine({ task: { ...task, ...overrides }, occurrenceAt, config: sandboxConfig, client: fakeClient(db), launch });
}

describe("dispatchAgentRoutine", () => {
  it("starts a session owned by the routine's creator and launches one run", async () => {
    const db = newDb();
    const launch = okLaunch();
    await dispatch(db, launch);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(db.tables.sessions).toHaveLength(1);
    expect(db.tables.sessions![0]).toMatchObject({
      session_type: "routine",
      owner_user_id: OWNER_ID,
      scheduled_task_id: TASK_ID,
      status: "starting",
      title: "Weekly digest",
      model: "haiku",
      idempotency_key: `${TASK_ID}:2026-10-27T09:00:00.000Z`,
    });
    expect(db.tables.sessions![0]!.host_machine_id).toBe(`fly:${db.tables.sessions![0]!.id}`);
  });

  it("dispatches a duplicate occurrence once", async () => {
    const db = newDb();
    const launch = okLaunch();
    await dispatch(db, launch);
    db.tables.sessions![0]!.status = "ended";
    await dispatch(db, launch);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(db.tables.sessions).toHaveLength(1);
  });

  it("skips while the previous run is still going, and does not catch up", async () => {
    const db = newDb();
    const launch = okLaunch();
    await dispatch(db, launch, "2026-10-27T09:00:00.000Z");
    await dispatch(db, launch, "2026-10-27T10:00:00.000Z");

    expect(launch).toHaveBeenCalledTimes(1);
    expect(db.tables.sessions).toHaveLength(1);
  });

  it("runs the next occurrence once the previous run has ended", async () => {
    const db = newDb();
    const launch = okLaunch();
    await dispatch(db, launch, "2026-10-27T09:00:00.000Z");
    db.tables.sessions![0]!.status = "ended";
    await dispatch(db, launch, "2026-10-27T10:00:00.000Z");

    expect(launch).toHaveBeenCalledTimes(2);
    expect(db.tables.sessions).toHaveLength(2);
  });

  it("ends a run that cannot start as failed with one error and no retry", async () => {
    const db = newDb();
    const launch = mock<LaunchRoutineRun>(async () => { throw new Error("fly is down"); });
    await dispatch(db, launch);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(db.tables.sessions![0]).toMatchObject({ status: "ended", end_reason: "failed" });
    expect(db.tables.errors).toHaveLength(1);
    expect(db.tables.errors![0]).toMatchObject({ operation: "session", scheduled_task_id: TASK_ID, session_id: db.tables.sessions![0]!.id });
  });

  it("records the run with its typed spec, tied to the session, and marks it running once launched", async () => {
    const db = newDb();
    const launch = mock<LaunchRoutineRun>(async () => ({ machineId: "machine-9" }));
    await dispatch(db, launch);

    expect(db.tables.agent_runs).toHaveLength(1);
    const run = db.tables.agent_runs![0]!;
    expect(run).toMatchObject({
      workspace_id: WS_ID,
      kind: "routine",
      harness: "claude",
      model: "haiku",
      instructions: "Summarize the week.",
      base_context_version_id: VERSION_ID,
      session_id: db.tables.sessions![0]!.id,
      idempotency_key: `${TASK_ID}:2026-10-27T09:00:00.000Z`,
      status: "running",
      sandbox_machine_id: "machine-9",
      trigger: { type: "cron", scheduledTaskId: TASK_ID, occurrenceAt: "2026-10-27T09:00:00.000Z" },
      on_behalf_of_user_id: OWNER_ID,
      output: { type: "text" },
    });
    expect(run.permissions).toEqual([{ tool: "context.read" }, { tool: "context.write" }]);
    expect(run.runtime).toMatchObject({ type: "cloud", environment: { nativeTools: [{ harness: "claude", tool: "Read" }, { harness: "claude", tool: "Glob" }] } });
    expect(run.started_at).toBeTruthy();
    const launchInput = launch.mock.calls[0]![0];
    expect(launchInput.run.id).toBe(run.id as never);
    expect(launchInput.run.inputs.contextVersionId).toBe(VERSION_ID as never);
  });

  it.each([
    ["was disabled", { id: OWNER_ID, status: "disabled", primary_team_id: TEAM_ID }],
    ["left the team", { id: OWNER_ID, status: "active", primary_team_id: "88888888-8888-4888-8888-888888888888" }],
  ])("fails with principal_inactive, and launches nothing, when the owner %s", async (_label, owner) => {
    const db = newDb(undefined, owner);
    const launch = okLaunch();
    await dispatch(db, launch);

    expect(launch).not.toHaveBeenCalled();
    expect(db.tables.agent_runs).toHaveLength(0);
    expect(db.tables.sessions![0]).toMatchObject({ status: "ended", end_reason: "failed" });
    expect(db.tables.errors).toEqual([expect.objectContaining({ detail_json: expect.objectContaining({ code: "principal_inactive" }) })]);
  });

  it("gives a Codex routine a Codex environment", async () => {
    const db = newDb();
    await dispatch(db, okLaunch(), undefined, { config_json: { title: "t", prompt: "p", harness: "codex", model: null } });
    expect(db.tables.agent_runs![0]).toMatchObject({ harness: "codex", model: null });
    expect(db.tables.agent_runs![0]!.runtime).toMatchObject({ environment: { nativeTools: [{ harness: "codex", tool: "shell" }] } });
  });

  it("seeds a workspace with no context so the run has a base version", async () => {
    const db = newDb({ id: WS_ID, team_id: TEAM_ID, timezone: "UTC", current_context_version_id: null });
    await dispatch(db, okLaunch());
    expect(db.rpcCalls.map((call) => call.name)).toContain("commit_context_write");
    expect(db.rpcCalls[0]!.args).toMatchObject({ p_creation_reason: "seed", p_expected_version_id: null });
    expect(db.tables.agent_runs).toHaveLength(1);
  });

  it("dispatches a duplicate occurrence to one run record", async () => {
    const db = newDb();
    await dispatch(db, okLaunch());
    db.tables.sessions![0]!.status = "ended";
    await dispatch(db, okLaunch());
    expect(db.tables.agent_runs).toHaveLength(1);
  });

  it("ends the run as failed with the code when the launch fails", async () => {
    const db = newDb();
    await dispatch(db, mock<LaunchRoutineRun>(async () => { throw new Error("fly is down"); }));
    expect(db.tables.agent_runs![0]).toMatchObject({ status: "failed", failure_code: "routine_launch_failed" });
    expect(db.tables.agent_runs![0]!.completed_at).toBeTruthy();
  });

  it("cancels the run when it was skipped because another Codex run held the login", async () => {
    const db = newDb();
    await dispatch(db, mock<LaunchRoutineRun>(async () => { throw new RoutineLeaseBusyError(); }), undefined, { config_json: { title: "t", prompt: "p", harness: "codex", model: null } });
    expect(db.tables.agent_runs![0]).toMatchObject({ status: "cancelled", failure_code: "routine_run_skipped" });
  });

  it("ends the session as failed, and records nothing as running, when the run record cannot be made", async () => {
    const db = newDb(null);
    await dispatch(db, okLaunch());
    expect(db.tables.sessions![0]).toMatchObject({ status: "ended", end_reason: "failed" });
    expect(db.tables.agent_runs).toHaveLength(0);
  });

  it("throws for a routine with no creator or an invalid config, without starting a session", async () => {
    const db = newDb();
    await expect(dispatch(db, okLaunch(), undefined, { created_by_user_id: null })).rejects.toThrow("no creator");
    await expect(dispatch(db, okLaunch(), undefined, { config_json: { title: "x" } })).rejects.toThrow("invalid config");
    expect(db.tables.sessions).toHaveLength(0);
  });
});

describe("failStaleRoutineSessions", () => {
  const now = new Date("2026-10-27T12:00:00.000Z");
  const session = (id: string, startedAt: string, extra: Record<string, unknown> = {}) => ({
    id, workspace_id: "ws-1", session_type: "routine", status: "starting", scheduled_task_id: TASK_ID,
    host_machine_id: `fly:${id}`, started_at: startedAt, ...extra,
  });

  it("fails a silent machine once it is past the timeout, and leaves a fresh run alone", async () => {
    const db = fakeDb({
      sessions: [session("old", "2026-10-27T11:30:00.000Z"), session("fresh", "2026-10-27T11:55:00.000Z")],
      errors: [],
    });
    expect(await failStaleRoutineSessions(fakeClient(db), now)).toBe(1);

    expect(db.tables.sessions!.find((s) => s.id === "old")).toMatchObject({ status: "ended", end_reason: "failed" });
    expect(db.tables.sessions!.find((s) => s.id === "fresh")!.status).toBe("starting");
    expect(db.tables.errors).toHaveLength(1);
  });

  it("writes no second error on the next tick", async () => {
    const db = fakeDb({ sessions: [session("old", "2026-10-27T11:30:00.000Z", { status: "live" })], errors: [] });
    await failStaleRoutineSessions(fakeClient(db), now);
    await failStaleRoutineSessions(fakeClient(db), now);
    expect(db.tables.errors).toHaveLength(1);
  });

  it("never touches interactive sessions", async () => {
    const db = fakeDb({ sessions: [session("mine", "2026-10-27T08:00:00.000Z", { session_type: "interactive" })], errors: [] });
    expect(await failStaleRoutineSessions(fakeClient(db), now)).toBe(0);
  });
});

describe("dispatchAgentRoutine on Codex", () => {
  const codexTask = { config_json: { title: "Weekly digest", prompt: "Summarize the week.", harness: "codex", model: null } } as Partial<ScheduledTaskRow>;
  const rejecting = (error: Error) => mock<LaunchRoutineRun>(async () => { throw error; });

  it("leaves a run out, with a note and no error row, while another Codex run holds the login", async () => {
    const db = newDb();
    await dispatch(db, rejecting(new RoutineLeaseBusyError()), "2026-10-27T09:00:00.000Z", codexTask);

    expect(db.tables.sessions![0]).toMatchObject({ status: "ended", end_reason: "failed", harness: "codex" });
    expect(db.tables.errors).toHaveLength(0);
    const events = db.rpcCalls.find((c) => c.name === "append_session_events")!.args.p_events as Array<{ payload: { text: string } }>;
    expect(events[0]!.payload.text).toBe("Another Codex routine was still running, so this run was skipped.");
  });

  it("says Codex is not connected when the workspace has no login, and records the error", async () => {
    const db = newDb();
    await dispatch(db, rejecting(new CredentialError("no login", "missing")), "2026-10-27T09:00:00.000Z", codexTask);

    expect(db.tables.sessions![0]).toMatchObject({ status: "ended", end_reason: "failed" });
    expect(db.tables.errors).toHaveLength(1);
    const events = db.rpcCalls.find((c) => c.name === "append_session_events")!.args.p_events as Array<{ payload: { text: string } }>;
    expect(events[0]!.payload.text).toContain("Codex is not connected");
  });

  it("gives a Claude routine the old note for the same kind of error", async () => {
    const db = newDb();
    await dispatch(db, rejecting(new CredentialError("no token", "missing")));
    const events = db.rpcCalls.find((c) => c.name === "append_session_events")!.args.p_events as Array<{ payload: { text: string } }>;
    expect(events[0]!.payload.text).toBe("The run could not start.");
  });

  it("frees the login's lease when a Codex session ends, and only for the run that holds it", async () => {
    const db = newDb();
    db.tables.credentials = [{ id: "cred-1", workspace_id: WS_ID, provider: "codex_chatgpt_auth" }];
    db.rpcs.release_credential_lease = () => ({ data: true });
    await dispatch(db, rejecting(new Error("fly down")), "2026-10-27T09:00:00.000Z", codexTask);

    const release = db.rpcCalls.find((c) => c.name === "release_credential_lease")!;
    expect(release.args).toEqual({ p_credential_id: "cred-1", p_run_id: db.tables.sessions![0]!.id });
  });
});

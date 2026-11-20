import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { parseUserId, parseWorkspaceId, type AgentRunSpec, type AgentRunTrigger } from "draft-core/run-spec";
import { personCaller, runCaller, type ToolCaller } from "draft-core/tools";
import type { AgentRoutineConfig } from "../../../routines/config";
import { buildRoutineRunSpec } from "../../../routines/run-spec";
import type { ScheduledTaskRow } from "../../../types/tables";
import { fakeClient, fakeDb, type FakeDb } from "../../routines/fake-client";

const db: FakeDb = fakeDb({}, { uuidTables: ["scheduled_tasks", "errors"] });
mock.module("../../../db/client", () => ({ serviceClient: fakeClient(db) }));
const { createRoutineTools } = await import("../../../metaharness/tools/definitions/routines");
const { runMayManage, runVisibility, widerAccess } = await import("../../../routines/run-creator");
const schedules = await import("../../../routines/service");
const agentStatus = await import("../../../routines/agent-status");

const listConnected = spyOn(schedules, "listConnectedProviders").mockResolvedValue(["github", "slack"]);
const runNow = spyOn(schedules, "runRoutineNow").mockResolvedValue({ status: "queued" });
const agentProblem = spyOn(agentStatus, "routineAgentProblem").mockResolvedValue(null);
afterAll(() => {
  listConnected.mockRestore();
  runNow.mockRestore();
  agentProblem.mockRestore();
});

const WS = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";
const CONTEXT = "44444444-4444-4444-8444-444444444444";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

// Person-made routines, and the runs they start.
const P = id(0x10);
const Q = id(0x11);
const PRIVATE = id(0x12);
const PLAIN = id(0x13);
const DEEP = id(0x14);
const BROKEN = id(0x15);
const THEIRS = id(0x16);
// Routines that runs made.
const CHILD = id(0x20);
const CHAIN_ROUTINE = id(0x21);
const GRANDCHILD = id(0x22);
const PLAIN_CHILD = id(0x23);
const BROKEN_CHILD = id(0x24);

const RUN_1 = id(0x100);
const RUN_2 = id(0x101);
const RUN_Q = id(0x102);
const RUN_CHILD = id(0x103);
const RUN_PLAIN = id(0x104);
const RUN_FREE = id(0x105);
const RUN_DEEP = id(0x106);
const RUN_BROKEN = id(0x107);

const PARENT: AgentRoutineConfig = {
  title: "Digest", prompt: "Summarize the week.", harness: "claude", model: "haiku", reasoningEffort: "low",
  canNotify: true, postChannels: "joined", github: { repos: ["acme/app"], access: "read" }, toolset: { nativeTools: ["WebSearch"], mcpServers: [] },
};
const NO_ACCESS: AgentRoutineConfig = { title: "Quiet", prompt: "Look.", harness: "claude", model: null };

type Row = Record<string, unknown>;
const table = (name: string): Row[] => (db.tables[name] ??= []);
const seed = (name: string, rows: Row[]) => table(name).push(...rows);
const asTask = (row: Row) => row as unknown as ScheduledTaskRow;

function routineRow(taskId: string, config: object, extra: Row = {}): Row {
  return {
    id: taskId, workspace_id: WS, connection_id: null, task_type: "agent_routine", task_key: taskId,
    schedule_kind: "cron", cron_expression: "0 9 * * *", interval_seconds: null, timezone: "UTC", enabled: true,
    config_json: config, next_due_at: null, deleted_at: null, last_enqueued_at: null, claimed_occurrence_at: null,
    run_at: null, fired_at: null, created_via: "app", created_by_run_id: null, trigger_depth: 0, visibility: "shared",
    created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z",
    updated_by_user_id: OWNER, created_by_user_id: OWNER,
    ...extra,
  };
}

/** A made-by-run routine row: the run that made it, one level below its parent. */
const madeByRun = (taskId: string, config: object, runId: string, depth = 1, extra: Row = {}) =>
  routineRow(taskId, config, { created_via: "run", created_by_run_id: runId, trigger_depth: depth, ...extra });

/** A run a routine started (or none), with the spec the run would have. Seeds the run row the tools read. */
function runOf(runId: string, taskId: string | null, options: { owner?: string | null; routine?: AgentRoutineConfig; trigger?: AgentRunTrigger } = {}): AgentRunSpec {
  seed("agent_runs", [{ id: runId, workspace_id: WS, scheduled_task_id: taskId }]);
  const spec = buildRoutineRunSpec({
    id: runId, workspaceId: WS, scheduledTaskId: taskId ?? P, ownerUserId: OWNER, occurrenceAt: "2026-11-16T09:00:00.000Z",
    routine: options.routine ?? PARENT, contextVersionId: CONTEXT,
    trigger: options.trigger ?? (taskId ? undefined : { type: "system", reason: "manual" }),
  });
  return options.owner === null ? { ...spec, onBehalfOf: null } : spec;
}

const asOwner = personCaller({ userId: parseUserId(OWNER), workspaceId: parseWorkspaceId(WS), via: "mcp" });

/** Parses the input the way the gateway does, then calls the tool. The gateway's limit checks do not run here. */
async function call(name: string, caller: ToolCaller, input: Record<string, unknown>, client = fakeClient(db)) {
  const tool = createRoutineTools(client).find((item) => item.name === name)!;
  const parsed = tool.parse(input);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return tool.run(caller, parsed.value);
}

const output = (result: unknown) => (result as { output: { routine?: Row; routines?: Row[] } }).output;
const refusedWith = (result: unknown, code: string, message: string) => expect(result).toEqual({ status: "refused", code, message });
const NO_OWNER = (action: string) => `This run works for the whole workspace, not a person, so it can't ${action} routines.`;
const CHANGE_SCOPE = "This run can only change routines it or its own runs created.";
const FAILED = { status: "refused" as const, code: "routine_failed", message: "The routine operation could not be completed." };

beforeEach(() => {
  db.tables = {};
  listConnected.mockClear();
  runNow.mockClear();
  seed("scheduled_tasks", [routineRow(P, PARENT)]);
});

describe("routines.create from a run", () => {
  it("makes the routine for the run's owner, one level below its routine, and copies the settings it leaves out", async () => {
    const result = await call("routines.create", runCaller(runOf(RUN_1, P)), { title: "Check the digest", prompt: "Check it.", when: { in: "2h" } });

    expect(result.status).toBe("ok");
    const row = table("scheduled_tasks").find((task) => task.created_via === "run")!;
    expect(row).toMatchObject({
      created_by_user_id: OWNER, updated_by_user_id: OWNER, created_by_run_id: RUN_1, created_via: "run",
      trigger_depth: 1, visibility: "shared", schedule_kind: "once",
    });
    expect(row.config_json).toEqual({
      title: "Check the digest", prompt: "Check it.", harness: "claude", model: "haiku", reasoningEffort: "low",
      canNotify: true, postChannels: "joined", github: { repos: ["acme/app"], access: "read" },
      toolset: { nativeTools: ["WebSearch"], mcpServers: [] }, builtInTools: ["Bash", "WebSearch"],
    });
    expect(output(result).routine!.id).toBe(row.id);
  });

  it("does not copy the harness's model or effort onto a different harness", async () => {
    await call("routines.create", runCaller(runOf(RUN_1, P)), { title: "x", prompt: "y", when: { in: "2h" }, harness: "codex" });
    expect(table("scheduled_tasks").find((task) => task.created_via === "run")!.config_json).toEqual({
      title: "x", prompt: "y", harness: "codex", model: null, canNotify: true, postChannels: "joined", github: { repos: ["acme/app"], access: "read" },
      builtInTools: ["web_search"],
    });
  });

  it("refuses when the run has no owner, and creates nothing", async () => {
    refusedWith(
      await call("routines.create", runCaller(runOf(RUN_1, P, { owner: null })), { title: "x", prompt: "y", when: { in: "2h" } }),
      "no_owner",
      "This run works for the whole workspace, not a person, so it can't create routines.",
    );
    expect(table("scheduled_tasks").filter((task) => task.created_via === "run")).toHaveLength(0);
  });

  it("refuses at depth 3, and allows a child at depth 3", async () => {
    seed("scheduled_tasks", [routineRow(DEEP, PARENT, { trigger_depth: 3 }), routineRow(CHILD, PARENT, { trigger_depth: 2 })]);
    refusedWith(
      await call("routines.create", runCaller(runOf(RUN_DEEP, DEEP)), { title: "x", prompt: "y", when: { in: "2h" } }),
      "depth_limit",
      "Routines can nest 3 levels deep. This run is at level 3, so it can't create another routine.",
    );
    expect((await call("routines.create", runCaller(runOf(RUN_CHILD, CHILD)), { title: "x", prompt: "y", when: { in: "2h" } })).status).toBe("ok");
    expect(table("scheduled_tasks").find((task) => task.created_by_run_id === RUN_CHILD)).toMatchObject({ trigger_depth: 3 });
  });

  it("refuses the sixth create in a run, and a refused create is not counted", async () => {
    const run = runOf(RUN_1, P);
    seed("agent_run_tool_calls", Array.from({ length: 5 }, () => ({ workspace_id: WS, agent_run_id: RUN_1, tool_name: "routines.create", status: "ok" })));
    refusedWith(
      await call("routines.create", runCaller(run), { title: "x", prompt: "y", when: { in: "2h" } }),
      "limit_reached",
      "This run has created 5 routines, its limit. Finish the work now, or say in your result what is left.",
    );

    table("agent_run_tool_calls").length = 0;
    seed("agent_run_tool_calls", Array.from({ length: 5 }, () => ({ workspace_id: WS, agent_run_id: RUN_1, tool_name: "routines.create", status: "refused" })));
    expect((await call("routines.create", runCaller(run), { title: "x", prompt: "y", when: { in: "2h" } })).status).toBe("ok");
  });

  it("refuses when 20 one-shots made by agents are pending, and not when the 20th has fired", async () => {
    const pending = (n: number, extra: Row = {}) => routineRow(id(0x300 + n), PARENT, { schedule_kind: "once", run_at: "2026-11-20T09:00:00.000Z", cron_expression: null, created_via: "mcp", ...extra });
    seed("scheduled_tasks", Array.from({ length: 19 }, (_, n) => pending(n)));
    seed("scheduled_tasks", [pending(19, { fired_at: "2026-11-15T09:00:00.000Z" })]);
    expect((await call("routines.create", runCaller(runOf(RUN_1, P)), { title: "x", prompt: "y", when: { in: "2h" } })).status).toBe("ok");

    // That one-shot is now the 20th pending, so the next create is over the cap.
    refusedWith(
      await call("routines.create", runCaller(runOf(RUN_2, P)), { title: "x", prompt: "y", when: { in: "2h" } }),
      "too_many_pending",
      "This workspace has 20 pending routines made by agents. Wait for some to run, or delete ones you no longer need.",
    );
  });

  it("refuses a cron that runs more often than hourly, and allows the hourly preset", async () => {
    refusedWith(
      await call("routines.create", runCaller(runOf(RUN_1, P)), { title: "x", prompt: "y", when: { schedule: { cron: "*/30 * * * *", timezone: "UTC" } } }),
      "too_frequent",
      "Routines made by an agent can run at most once an hour.",
    );
    expect((await call("routines.create", runCaller(runOf(RUN_2, P)), { title: "x", prompt: "y", when: { schedule: { preset: "hourly" } } })).status).toBe("ok");
  });

  it("refuses access the run's routine does not hold, naming the setting", async () => {
    seed("scheduled_tasks", [routineRow(PLAIN, NO_ACCESS)]);
    refusedWith(
      await call("routines.create", runCaller(runOf(RUN_PLAIN, PLAIN, { routine: NO_ACCESS })), { title: "x", prompt: "y", when: { in: "2h" }, canNotify: true }),
      "not_permitted",
      "This run can't give a routine access it doesn't have itself: canNotify.",
    );
  });

  it("refuses a time past the 365-day horizon, and a time that has passed", async () => {
    const far = new Date(Date.now() + 400 * 86_400_000).toISOString();
    refusedWith(
      await call("routines.create", runCaller(runOf(RUN_1, P)), { title: "x", prompt: "y", when: { at: far } }),
      "too_far_ahead",
      `A routine can be set at most 365 days ahead. You asked for ${far}.`,
    );
    refusedWith(
      await call("routines.create", runCaller(runOf(RUN_2, P)), { title: "x", prompt: "y", when: { at: "2020-01-01T00:00:00.000Z" } }),
      "in_the_past",
      "That time has already passed (2020-01-01T00:00:00.000Z). Use a future time.",
    );
  });

  it("needs a harness when there is no routine to copy one from, and makes a run-less routine at depth 1 when given one", async () => {
    refusedWith(
      await call("routines.create", runCaller(runOf(RUN_FREE, null)), { title: "x", prompt: "y", when: { in: "2h" } }),
      "invalid_input",
      "harness is required.",
    );
    expect((await call("routines.create", runCaller(runOf(RUN_2, null)), { title: "x", prompt: "y", when: { in: "2h" }, harness: "claude" })).status).toBe("ok");
    expect(table("scheduled_tasks").find((task) => task.created_by_run_id === RUN_2)).toMatchObject({ created_by_user_id: OWNER, trigger_depth: 1 });
  });

  it("makes the routine private when its parent is private, or when the run came from private data", async () => {
    seed("scheduled_tasks", [routineRow(PRIVATE, PARENT, { visibility: "private" })]);
    await call("routines.create", runCaller(runOf(RUN_1, PRIVATE)), { title: "x", prompt: "y", when: { in: "2h" } });
    expect(table("scheduled_tasks").find((task) => task.created_by_run_id === RUN_1)).toMatchObject({ visibility: "private" });

    seed("agent_event_inbox", [{ id: id(0x500), workspace_id: WS, claimed_by_run_id: RUN_2, source_item_id: id(0x501) }]);
    seed("source_items", [{ id: id(0x501), workspace_id: WS, visibility: "private" }]);
    await call("routines.create", runCaller(runOf(RUN_2, P)), { title: "x", prompt: "y", when: { in: "2h" } });
    expect(table("scheduled_tasks").find((task) => task.created_by_run_id === RUN_2)).toMatchObject({ visibility: "private" });
  });

  it("records an error with the run and its routine when the parent routine cannot be read, then answers with a failure", async () => {
    seed("scheduled_tasks", [routineRow(BROKEN, {})]);
    const result = await call("routines.create", runCaller(runOf(RUN_BROKEN, BROKEN)), { title: "x", prompt: "y", when: { in: "2h" } });

    expect(result).toEqual(FAILED);
    expect(table("errors")).toEqual([
      expect.objectContaining({
        workspace_id: WS, agent_run_id: RUN_BROKEN, scheduled_task_id: BROKEN, operation: "execution",
        detail_json: expect.objectContaining({ code: "routine_tool_failed", tool: "routines.create" }),
      }),
    ]);
  });

  it("records an error with the run and its routine when counting its creates fails", async () => {
    const failing = {
      from: (name: string) => (name === "agent_run_tool_calls" ? { select: () => { throw new Error("db down"); } } : fakeClient(db).from(name)),
    } as unknown as ReturnType<typeof fakeClient>;
    const result = await call("routines.create", runCaller(runOf(RUN_1, P)), { title: "x", prompt: "y", when: { in: "2h" } }, failing);

    expect(result).toEqual(FAILED);
    expect(table("errors")).toEqual([
      expect.objectContaining({ workspace_id: WS, agent_run_id: RUN_1, scheduled_task_id: P, operation: "execution" }),
    ]);
  });

  it("records no error for a guard refusal", async () => {
    seed("scheduled_tasks", [routineRow(DEEP, PARENT, { trigger_depth: 3 })]);
    refusedWith(
      await call("routines.create", runCaller(runOf(RUN_1, P)), { title: "x", prompt: "y", when: { at: "2020-01-01T00:00:00.000Z" } }),
      "in_the_past",
      "That time has already passed (2020-01-01T00:00:00.000Z). Use a future time.",
    );
    refusedWith(
      await call("routines.create", runCaller(runOf(RUN_2, DEEP)), { title: "x", prompt: "y", when: { in: "2h" } }),
      "depth_limit",
      "Routines can nest 3 levels deep. This run is at level 3, so it can't create another routine.",
    );
    expect(table("errors")).toHaveLength(0);
  });
});

describe("routines.create from a person", () => {
  it("makes the routine for the person, through the surface they used, at depth 0", async () => {
    const result = await call("routines.create", asOwner,{ title: "Standup", prompt: "Post it.", harness: "claude", model: "haiku", when: { schedule: { preset: "daily", time: "09:00", timezone: "UTC" } } });
    expect(result.status).toBe("ok");
    expect(table("scheduled_tasks").find((task) => task.created_via === "mcp")).toMatchObject({
      created_by_user_id: OWNER, created_by_run_id: null, trigger_depth: 0, visibility: "shared", schedule_kind: "cron",
    });
  });

  it("refuses a past time and an unknown timezone, with the exact message", async () => {
    refusedWith(
      await call("routines.create", asOwner,{ title: "x", prompt: "y", harness: "claude", when: { at: "2020-01-01T00:00:00.000Z" } }),
      "in_the_past",
      "That time has already passed (2020-01-01T00:00:00.000Z). Use a future time.",
    );
    refusedWith(
      await call("routines.create", asOwner,{ title: "x", prompt: "y", harness: "claude", when: { schedule: { cron: "0 9 * * *", timezone: "Mars/Olympus" } } }),
      "invalid_schedule",
      "Unknown timezone",
    );
  });

  it("allows a cron more often than hourly, since the hourly floor is for agents only", async () => {
    expect((await call("routines.create", asOwner,{ title: "x", prompt: "y", harness: "claude", when: { schedule: { cron: "*/30 * * * *", timezone: "UTC" } } })).status).toBe("ok");
  });
});

describe("routines with canReadGmail", () => {
  const GMAIL_REFUSAL = "Gmail is not connected for the routine's owner. Ask the person whether to connect it, then call connections.connect with provider google.";
  const daily = { schedule: { preset: "daily", time: "09:00", timezone: "UTC" } };

  it("refuses create and update when the owner has no Gmail connection, even when a teammate has one", async () => {
    seed("connections", [{ id: "c-1", workspace_id: WS, provider: "gmail", connected_by_user_id: STRANGER, status: "active" }]);
    refusedWith(await call("routines.create", asOwner, { title: "Inbox", prompt: "Read mail.", harness: "claude", canReadGmail: true, when: daily }), "gmail_not_connected", GMAIL_REFUSAL);
    refusedWith(await call("routines.update", asOwner, { taskId: P, patch: { canReadGmail: true } }), "gmail_not_connected", GMAIL_REFUSAL);
  });

  it("saves canReadGmail when the owner has their own Gmail connection", async () => {
    seed("connections", [{ id: "c-1", workspace_id: WS, provider: "gmail", connected_by_user_id: OWNER, status: "degraded" }]);
    expect((await call("routines.create", asOwner, { title: "Inbox", prompt: "Read mail.", harness: "claude", canReadGmail: true, when: daily })).status).toBe("ok");
    expect(table("scheduled_tasks").find((task) => (task.config_json as Row).title === "Inbox")!.config_json).toMatchObject({ canReadGmail: true });
  });
});

describe("the checks behind what a run may manage", () => {
  it("lets a run manage what its own chain made, including what a sibling run of the same routine made", async () => {
    seed("scheduled_tasks", [madeByRun(CHAIN_ROUTINE, PARENT, RUN_1)]);
    const chain = asTask(table("scheduled_tasks").find((task) => task.id === CHAIN_ROUTINE)!);
    const own = runOf(RUN_1, P);
    expect(await runMayManage(fakeClient(db), own, chain)).toBe(true);
    expect(await runMayManage(fakeClient(db), runOf(RUN_2, P), chain)).toBe(true);
  });

  it("walks up a chain of runs, and stops at a routine a person made", async () => {
    seed("scheduled_tasks", [madeByRun(CHILD, PARENT, RUN_1), madeByRun(GRANDCHILD, PARENT, RUN_CHILD, 2)]);
    runOf(RUN_1, P);
    runOf(RUN_CHILD, CHILD);
    const grandchild = asTask(table("scheduled_tasks").find((task) => task.id === GRANDCHILD)!);
    expect(await runMayManage(fakeClient(db), runOf(RUN_1, P), grandchild)).toBe(true);
    // A run of another routine, Q, never reaches P's chain: the walk reaches P, which a person made.
    seed("scheduled_tasks", [routineRow(Q, PARENT)]);
    const child = asTask(table("scheduled_tasks").find((task) => task.id === CHILD)!);
    expect(await runMayManage(fakeClient(db), runOf(RUN_Q, Q), child)).toBe(false);
  });

  it("never lets a run manage a routine a person made", async () => {
    expect(await runMayManage(fakeClient(db), runOf(RUN_1, P), asTask(table("scheduled_tasks").find((task) => task.id === P)!))).toBe(false);
  });

  it("checks a wider access setting and names it, and passes a narrower one", () => {
    expect(widerAccess(null, {})).toBeNull();
    expect(widerAccess(null, { canNotify: false })).toBeNull();
    expect(widerAccess({ canNotify: false }, { canNotify: true })).toBe("canNotify");
    expect(widerAccess({ canNotify: true }, { canNotify: true })).toBeNull();

    expect(widerAccess(null, { postChannels: "joined" })).toBe("postChannels");
    expect(widerAccess({ postChannels: ["general"] }, { postChannels: "joined" })).toBe("postChannels");
    expect(widerAccess({ postChannels: "joined" }, { postChannels: ["random"] })).toBeNull();
    expect(widerAccess({ postChannels: ["general"] }, { postChannels: ["random"] })).toBe("postChannels");
    expect(widerAccess({ postChannels: ["general"] }, { postChannels: ["#General"] })).toBeNull();

    expect(widerAccess(null, { github: { repos: ["acme/app"], access: "read" } })).toBe("github");
    expect(widerAccess({ github: { repos: ["acme/app"], access: "read" } }, { github: { repos: ["acme/web"], access: "read" } })).toBe("github");
    expect(widerAccess({ github: { repos: ["acme/app"], access: "read" } }, { github: { repos: ["acme/app"], access: "write" } })).toBe("github");
    expect(widerAccess({ github: { repos: ["acme/app"], access: "write" } }, { github: { repos: ["acme/app"], access: "read" } })).toBeNull();
  });

  it("marks a run private only when a source it was woken by is private", async () => {
    expect(await runVisibility(fakeClient(db), RUN_1)).toBe("shared");
    seed("agent_event_inbox", [{ id: id(0x600), workspace_id: WS, claimed_by_run_id: RUN_1, source_item_id: id(0x601) }]);
    seed("source_items", [{ id: id(0x601), workspace_id: WS, visibility: "shared" }]);
    expect(await runVisibility(fakeClient(db), RUN_1)).toBe("shared");
    table("source_items")[0]!.visibility = "private";
    expect(await runVisibility(fakeClient(db), RUN_1)).toBe("private");
  });
});

describe("routines.list, runs and run from a run", () => {
  it("lists shared routines for a run with no owner, and the owner's own private ones for a run with an owner", async () => {
    seed("scheduled_tasks", [routineRow(PRIVATE, PARENT, { visibility: "private" }), routineRow(THEIRS, PARENT, { visibility: "private", created_by_user_id: STRANGER })]);
    const ownerless = await call("routines.list", runCaller(runOf(RUN_1, P, { owner: null })), {});
    expect(output(ownerless).routines!.map((routine) => routine.id)).toEqual([P]);
    const withOwner = await call("routines.list", runCaller(runOf(RUN_2, P)), {});
    expect(output(withOwner).routines!.map((routine) => routine.id).sort()).toEqual([P, PRIVATE].sort());
  });

  it("runs a routine the owner can see, and refuses one that only someone else can see", async () => {
    seed("scheduled_tasks", [routineRow(PRIVATE, PARENT, { visibility: "private" }), routineRow(THEIRS, PARENT, { visibility: "private", created_by_user_id: STRANGER })]);
    expect((await call("routines.run", runCaller(runOf(RUN_1, P)), { taskId: PRIVATE })).status).toBe("ok");
    expect(runNow).toHaveBeenCalledWith(WS, PRIVATE, OWNER, { attribution: { via: "run" } });
    // The service hides another person's private routine, as if it did not exist.
    runNow.mockRejectedValueOnce(new Error("not_found"));
    refusedWith(await call("routines.run", runCaller(runOf(RUN_2, P)), { taskId: THEIRS }), "not_found", "Routine not found.");
    expect(runNow).toHaveBeenLastCalledWith(WS, THEIRS, OWNER, { attribution: { via: "run" } });
  });

  it("refuses a run that starts its own routine again", async () => {
    seed("scheduled_tasks", [routineRow(Q, PARENT)]);
    refusedWith(
      await call("routines.run", runCaller(runOf(RUN_1, P)), { taskId: P }),
      "not_permitted",
      'A run can\'t start its own routine again. To follow up later, create a one-shot with routines.create and when {in: "2h"}.',
    );
    expect(runNow).not.toHaveBeenCalled();
  });

  it("refuses a sixth routines.run in one run", async () => {
    seed("scheduled_tasks", [routineRow(Q, PARENT)]);
    seed("agent_run_tool_calls", Array.from({ length: 5 }, () => ({ workspace_id: WS, agent_run_id: RUN_1, tool_name: "routines.run", status: "ok" })));
    refusedWith(await call("routines.run", runCaller(runOf(RUN_1, P)), { taskId: Q }), "limit_reached", "This run has already started 5 routines, the most one run can.");
    expect(runNow).not.toHaveBeenCalled();
  });

  it("refuses a private routine to a run with no owner, for runs and for run", async () => {
    seed("scheduled_tasks", [routineRow(PRIVATE, PARENT, { visibility: "private" })]);
    refusedWith(await call("routines.runs", runCaller(runOf(RUN_1, P, { owner: null })), { taskId: PRIVATE }), "not_found", "Routine not found.");
    refusedWith(await call("routines.run", runCaller(runOf(RUN_1, P, { owner: null })), { taskId: PRIVATE }), "no_owner", NO_OWNER("run"));
    expect(runNow).not.toHaveBeenCalled();
  });

  it("answers a run's read of a routine the owner can see", async () => {
    expect((await call("routines.runs", runCaller(runOf(RUN_1, P)), { taskId: P })).status).toBe("ok");
  });
});

describe("routines.update and routines.delete from a run", () => {
  it("changes a routine its chain made, and a title change to one that stores a setting the run's routine lacks", async () => {
    seed("scheduled_tasks", [madeByRun(CHILD, { ...PARENT, title: "Old" }, RUN_1)]);
    const ok = await call("routines.update", runCaller(runOf(RUN_1, P)), { taskId: CHILD, patch: { title: "New" } });
    expect(ok.status).toBe("ok");
    expect(table("scheduled_tasks").find((task) => task.id === CHILD)!.config_json).toMatchObject({ title: "New" });

    seed("scheduled_tasks", [routineRow(PLAIN, NO_ACCESS), madeByRun(PLAIN_CHILD, { ...NO_ACCESS, canNotify: true }, RUN_PLAIN)]);
    expect((await call("routines.update", runCaller(runOf(RUN_PLAIN, PLAIN, { routine: NO_ACCESS })), { taskId: PLAIN_CHILD, patch: { title: "Renamed" } })).status).toBe("ok");
  });

  it("refuses a routine a person made, and a routine outside the run's chain", async () => {
    seed("scheduled_tasks", [madeByRun(CHILD, PARENT, RUN_1)]);
    refusedWith(await call("routines.update", runCaller(runOf(RUN_1, P)), { taskId: P, patch: { title: "x" } }), "not_permitted", CHANGE_SCOPE);
    refusedWith(await call("routines.update", runCaller(runOf(RUN_Q, Q)), { taskId: CHILD, patch: { title: "x" } }), "not_permitted", CHANGE_SCOPE);
    refusedWith(await call("routines.delete", runCaller(runOf(RUN_Q, Q)), { taskId: CHILD }), "not_permitted", CHANGE_SCOPE);
  });

  it("refuses access the run's routine lacks, and a schedule more often than hourly", async () => {
    seed("scheduled_tasks", [routineRow(PLAIN, NO_ACCESS), madeByRun(PLAIN_CHILD, NO_ACCESS, RUN_PLAIN)]);
    refusedWith(
      await call("routines.update", runCaller(runOf(RUN_PLAIN, PLAIN, { routine: NO_ACCESS })), { taskId: PLAIN_CHILD, patch: { canNotify: true } }),
      "not_permitted",
      "This run can't give a routine access it doesn't have itself: canNotify.",
    );
    seed("scheduled_tasks", [madeByRun(CHILD, PARENT, RUN_1)]);
    refusedWith(
      await call("routines.update", runCaller(runOf(RUN_1, P)), { taskId: CHILD, patch: { when: { schedule: { cron: "*/30 * * * *", timezone: "UTC" } } } }),
      "too_frequent",
      "Routines made by an agent can run at most once an hour.",
    );
  });

  it("deletes a routine its chain made", async () => {
    seed("scheduled_tasks", [madeByRun(CHILD, PARENT, RUN_1)]);
    expect((await call("routines.delete", runCaller(runOf(RUN_1, P)), { taskId: CHILD })).status).toBe("ok");
    expect(table("scheduled_tasks").find((task) => task.id === CHILD)!.deleted_at).not.toBeNull();
  });

  it("refuses a run with no owner for update, delete and run, each with its own wording", async () => {
    seed("scheduled_tasks", [madeByRun(CHILD, PARENT, RUN_1)]);
    const ownerless = runOf(RUN_1, P, { owner: null });
    refusedWith(await call("routines.update", runCaller(ownerless), { taskId: CHILD, patch: { title: "x" } }), "no_owner", NO_OWNER("change"));
    refusedWith(await call("routines.delete", runCaller(ownerless), { taskId: CHILD }), "no_owner", NO_OWNER("delete"));
    refusedWith(await call("routines.run", runCaller(ownerless), { taskId: CHILD }), "no_owner", NO_OWNER("run"));
  });

  it("records an error with the routine and run when the run's own routine cannot be read, then answers with a failure", async () => {
    seed("scheduled_tasks", [routineRow(BROKEN, {}), madeByRun(BROKEN_CHILD, PARENT, RUN_BROKEN)]);
    const result = await call("routines.update", runCaller(runOf(RUN_BROKEN, BROKEN)), { taskId: BROKEN_CHILD, patch: { canNotify: true } });

    expect(result).toEqual(FAILED);
    expect(table("errors")).toEqual([
      expect.objectContaining({ agent_run_id: RUN_BROKEN, scheduled_task_id: BROKEN_CHILD, operation: "execution" }),
    ]);
  });
});

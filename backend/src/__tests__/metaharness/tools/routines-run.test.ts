import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { parseUserId, parseWorkspaceId } from "draft-core/run-spec";
import type { ToolCaller } from "draft-core/tools";
import { fakeClient, fakeDb } from "../../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";

// Unexpected failures are recorded through the service client, so the tool's errors row lands here.
const serviceDb = fakeDb({ errors: [] });
mock.module("../../../db/client", () => ({ serviceClient: fakeClient(serviceDb) }));
const { createRoutineTools } = await import("../../../metaharness/tools/definitions/routines");
const schedules = await import("../../../routines/service");

const runNow = spyOn(schedules, "runRoutineNow");
afterAll(() => runNow.mockRestore());
beforeEach(() => {
  runNow.mockReset();
  serviceDb.tables.errors = [];
});

const caller: ToolCaller = { type: "user", userId: parseUserId(USER), workspaceId: parseWorkspaceId(WS), via: "mcp" };
const runRoutine = (input: { taskId: string } = { taskId: TASK }) => {
  const tool = createRoutineTools(fakeClient(fakeDb())).find((candidate) => candidate.name === "routines.run")!;
  return tool.run(caller, input);
};

describe("routines.run", () => {
  it("answers queued without a run id, and does not refuse", async () => {
    runNow.mockResolvedValueOnce({ status: "queued" });

    expect(await runRoutine()).toEqual({
      status: "ok",
      output: { sessionId: null, queued: true, message: "Queued. It runs when the current run ends." },
    });
    expect(runNow).toHaveBeenCalledWith(WS, TASK, USER);
  });

  it("answers with the session id, for routines.runs, and the outcome", async () => {
    runNow.mockResolvedValueOnce({ status: "started", runId: "run-1", sessionId: "s-1" });

    expect(await runRoutine()).toEqual({
      status: "ok",
      output: { sessionId: "s-1", outcome: { status: "started", runId: "run-1", sessionId: "s-1" } },
    });
  });

  it("refuses codex_login_busy when another Codex run holds the login", async () => {
    runNow.mockResolvedValueOnce({ status: "failed", code: "routine_lease_busy" });

    expect(await runRoutine()).toMatchObject({ status: "refused", code: "codex_login_busy" });
  });

  it("refuses with the failure code when the run could not start, and records nothing new", async () => {
    runNow.mockResolvedValueOnce({ status: "failed", code: "routine_launch_failed" });

    expect(await runRoutine()).toMatchObject({ status: "refused", code: "routine_launch_failed" });
    expect(serviceDb.tables.errors).toHaveLength(0);
  });

  it("refuses a person without edit rights, and records nothing", async () => {
    runNow.mockRejectedValueOnce(new Error("forbidden"));

    expect(await runRoutine()).toMatchObject({ status: "refused", code: "not_permitted" });
    expect(serviceDb.tables.errors).toHaveLength(0);
  });

  it("refuses a routine that does not exist, and records nothing", async () => {
    runNow.mockRejectedValueOnce(new Error("not_found"));

    expect(await runRoutine()).toMatchObject({ status: "refused", code: "not_found" });
    expect(serviceDb.tables.errors).toHaveLength(0);
  });

  it("refuses with routine_failed and records an unexpected failure", async () => {
    runNow.mockRejectedValueOnce(new Error("db down"));

    expect(await runRoutine()).toMatchObject({ status: "refused", code: "routine_failed" });
    expect(serviceDb.tables.errors).toEqual([
      expect.objectContaining({
        workspace_id: WS,
        scheduled_task_id: TASK,
        operation: "execution",
        detail_json: expect.objectContaining({ code: "routine_tool_failed", tool: "routines.run" }),
      }),
    ]);
  });
});

import { describe, expect, it } from "bun:test";
import { recordRunResult } from "../../events/run-result";
import { fakeClient, fakeDb } from "../routines/fake-client";

const WS = "22222222-2222-4222-8222-222222222222";
const RUN = "11111111-1111-4111-8111-111111111111";

function setup(tables: Record<string, Array<Record<string, unknown>>>) {
  const db = fakeDb({ people: [{ id: "person-1", workspace_id: WS, user_id: "user-1" }], ...tables });
  return { db, client: fakeClient(db) };
}
const appended = (db: ReturnType<typeof fakeDb>) => db.rpcCalls.filter((c) => c.name === "append_workspace_event").map((c) => c.args);

describe("recording a finished run", () => {
  const steps = [{ parent_run_id: RUN, workspace_id: WS, status: "succeeded" }, { parent_run_id: RUN, workspace_id: WS, status: "succeeded" }, { parent_run_id: RUN, workspace_id: WS, status: "failed" }];

  it("writes a shared row for synthesis with ids, status and step counts, and no summary text", async () => {
    const { db, client } = setup({ agent_runs: [{ id: RUN, workspace_id: WS, scheduled_task_id: null }, ...steps.map((s, i) => ({ id: `s${i}`, ...s }))] });
    await recordRunResult(client, { id: RUN, kind: "synthesis", workspace_id: WS, status: "failed", outcome: null, on_behalf_of_user_id: null });
    const [call] = appended(db);
    expect(call).toMatchObject({ p_event_type: "run_result", p_agent_run_id: RUN, p_visibility: "shared", p_audience_person_id: null, p_summary: "Context update failed" });
    expect(call!.p_payload_json).toEqual({ runId: RUN, kind: "synthesis", status: "failed", outcome: null, stepCounts: { succeeded: 2, failed: 1 } });
  });

  it("makes a private routine's row private to its owner's person", async () => {
    const { db, client } = setup({
      agent_runs: [{ id: RUN, workspace_id: WS, scheduled_task_id: "task-1" }],
      scheduled_tasks: [{ id: "task-1", visibility: "private", created_by_user_id: "user-1" }],
    });
    await recordRunResult(client, { id: RUN, kind: "routine", workspace_id: WS, status: "succeeded", outcome: null, on_behalf_of_user_id: "user-1" });
    expect(appended(db)[0]).toMatchObject({ p_visibility: "private", p_audience_person_id: "person-1", p_summary: "Routine succeeded" });
  });

  it("writes nothing when a private routine's owner has no person row", async () => {
    const { db, client } = setup({
      agent_runs: [{ id: RUN, workspace_id: WS, scheduled_task_id: "task-1" }],
      scheduled_tasks: [{ id: "task-1", visibility: "private", created_by_user_id: "ghost" }],
    });
    await recordRunResult(client, { id: RUN, kind: "routine", workspace_id: WS, status: "succeeded", outcome: null, on_behalf_of_user_id: "ghost" });
    expect(appended(db)).toEqual([]);
  });
});

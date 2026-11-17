import { describe, expect, it, mock } from "bun:test";
import { enqueueEvent, type EnqueueEventInput } from "../../events/enqueue";
import { fakeClient, fakeDb, type FakeDb } from "../routines/fake-client";

const input: EnqueueEventInput = {
  workspaceId: "ws-1",
  scheduledTaskId: "task-1",
  origin: "manual",
  eventName: "manual.run",
  dedupeKey: "task-1:manual:m1",
  concurrencyKey: "task-1",
  payload: { type: "manual", requestedBy: "user-1" },
};

function setup() {
  const db: FakeDb = fakeDb({ agent_events: [], errors: [] }, { unique: { agent_events: [["workspace_id", "dedupe_key"]] }, uuidTables: ["agent_events"] });
  return { db, client: fakeClient(db) };
}

async function until(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("enqueueEvent", () => {
  it("reports a repeated dedupe key as a duplicate, stores one row, and starts a drain each call", async () => {
    const { db, client } = setup();
    const drain = mock(async () => {});

    const first = await enqueueEvent(client, input, { drain });
    const second = await enqueueEvent(client, input, { drain });

    expect(first).toEqual({ id: expect.any(String), duplicate: false });
    expect(second).toEqual({ id: null, duplicate: true });
    expect(db.tables.agent_events).toHaveLength(1);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it("records a failed drain instead of throwing it to the caller", async () => {
    const { db, client } = setup();

    await enqueueEvent(client, input, {
      drain: async () => {
        throw new Error("drain down");
      },
    });
    await until(() => (db.tables.errors ?? []).length > 0);

    expect(db.tables.errors![0]).toMatchObject({ operation: "scheduling", workspace_id: "ws-1", detail_json: { code: "event_drain_failed" } });
  });
});

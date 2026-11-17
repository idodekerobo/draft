import { describe, expect, it, mock } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueRoutineEvents, type StartEventRoutinesInput } from "../../events/enqueue-routine-events";
import type { ScheduledTaskRow } from "../../types/tables";
import { fakeClient, fakeDb, type FakeDb } from "../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const OWNER = "66666666-6666-4666-8666-666666666666";
const OTHER = "88888888-8888-4888-8888-888888888888";
const SOURCE = "99999999-9999-4999-8999-999999999999";
const LISTENING = "55555555-5555-4555-8555-555555555551";
const NOT_LISTENING = "55555555-5555-4555-8555-555555555552";
const DISABLED = "55555555-5555-4555-8555-555555555553";
const MINE = "55555555-5555-4555-8555-555555555554";
const THEIRS = "55555555-5555-4555-8555-555555555555";
const SECOND = "55555555-5555-4555-8555-555555555556";
const REFUSED = "55555555-5555-4555-8555-555555555557";

const base = { title: "Meeting follow-up", prompt: "DM each owner their items.", harness: "claude", model: null };
const listen = { ...base, events: ["fireflies.meeting_summarized"] };

const taskRow = (id: string, config: Record<string, unknown>, owner = OWNER) =>
  ({ id, workspace_id: WS, task_type: "agent_routine", enabled: true, deleted_at: null, created_by_user_id: owner, timezone: "UTC", schedule_kind: "cron", cron_expression: "0 0 1 1 *", config_json: config }) as unknown as ScheduledTaskRow;

const shared = { visibility: "shared", owner_user_id: null, content_markdown: "# Standup\nUzo ships the demo.", metadata_json: { title: "Nov 9 standup" } };

const input: StartEventRoutinesInput & { concurrencyKey: string } = {
  workspaceId: WS,
  name: "fireflies.meeting_summarized",
  eventId: "meeting-1",
  sourceItemId: SOURCE,
  facts: [{ label: "Fireflies meeting id", value: "meeting-1" }],
  concurrencyKey: "fireflies:meeting-1",
};

function newDb(tasks: ScheduledTaskRow[], source: Record<string, unknown> | null = null): FakeDb {
  return fakeDb(
    {
      scheduled_tasks: tasks as unknown as Array<Record<string, unknown>>,
      source_items: source ? [{ id: SOURCE, workspace_id: WS, ...source }] : [],
      agent_events: [],
      errors: [],
    },
    { unique: { agent_events: [["workspace_id", "dedupe_key"]] }, uuidTables: ["agent_events"] },
  );
}

/** A client whose reads of one table throw, as a dropped connection would. */
function failingReads(db: FakeDb, table: string): SupabaseClient {
  const client = fakeClient(db);
  return {
    from: (name: string) => {
      if (name === table) throw new Error(`${table} read failed`);
      return client.from(name);
    },
  } as unknown as SupabaseClient;
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("enqueueRoutineEvents", () => {
  it("adds one webhook event for each enabled routine that asked, and counts it", async () => {
    const db = newDb([taskRow(LISTENING, listen), taskRow(NOT_LISTENING, base), { ...taskRow(DISABLED, listen), enabled: false }], shared);
    const drain = mock(async () => {});

    expect(await enqueueRoutineEvents(fakeClient(db), input, { drain })).toBe(1);

    expect(db.tables.agent_events).toEqual([
      expect.objectContaining({
        workspace_id: WS,
        scheduled_task_id: LISTENING,
        origin: "webhook",
        event_name: "fireflies.meeting_summarized",
        dedupe_key: `${LISTENING}:fireflies.meeting_summarized:meeting-1`,
        concurrency_key: "fireflies:meeting-1",
        source_item_id: SOURCE,
      }),
    ]);
    expect(db.tables.agent_events![0]!.payload).toEqual({
      type: "webhook",
      event: {
        name: "fireflies.meeting_summarized",
        eventId: "meeting-1",
        description: "a Fireflies meeting was summarized",
        providerLabel: "Fireflies",
        sourceItemId: SOURCE,
        facts: input.facts,
        title: "Nov 9 standup",
        text: "# Standup\nUzo ships the demo.",
        truncated: false,
      },
    });
  });

  it("stores a repeat delivery as a duplicate: no second row, and it is not counted", async () => {
    const db = newDb([taskRow(LISTENING, listen)], shared);
    const drain = mock(async () => {});

    expect(await enqueueRoutineEvents(fakeClient(db), input, { drain })).toBe(1);
    expect(await enqueueRoutineEvents(fakeClient(db), input, { drain })).toBe(0);

    expect(db.tables.agent_events).toHaveLength(1);
  });

  it("kicks one drain after every row is stored", async () => {
    const db = newDb([taskRow(LISTENING, listen), taskRow(SECOND, listen)], shared);
    const storedWhenDrained: number[] = [];
    const drain = mock(async () => {
      storedWhenDrained.push(db.tables.agent_events!.length);
    });

    expect(await enqueueRoutineEvents(fakeClient(db), input, { drain })).toBe(2);

    expect(drain).toHaveBeenCalledTimes(1);
    expect(storedWhenDrained).toEqual([2]);
  });

  it("marks a private meeting skipped for the routine whose owner cannot see it", async () => {
    const db = newDb([taskRow(MINE, listen, OWNER), taskRow(THEIRS, listen, OTHER)], { ...shared, visibility: "private", owner_user_id: OWNER });

    expect(await enqueueRoutineEvents(fakeClient(db), input, { drain: async () => {} })).toBe(2);

    const payloadFor = (taskId: string) => db.tables.agent_events!.find((row) => row.scheduled_task_id === taskId)!.payload as { skip?: { code: string; note: string } };
    expect(payloadFor(MINE)).not.toHaveProperty("skip");
    expect(payloadFor(THEIRS).skip).toEqual({ code: "routine_source_not_visible", note: expect.stringContaining("owner can't see it") });
    expect(payloadFor(THEIRS).skip!.note).not.toContain("Nov 9 standup");
  });

  it("stores nothing when no routine asked for the event, or the source has no content", async () => {
    const drain = mock(async () => {});
    const notAsked = newDb([taskRow(NOT_LISTENING, base)], shared);
    const noContent = newDb([taskRow(LISTENING, listen)], { ...shared, content_markdown: null });

    expect(await enqueueRoutineEvents(fakeClient(notAsked), input, { drain })).toBe(0);
    expect(await enqueueRoutineEvents(fakeClient(noContent), input, { drain })).toBe(0);

    expect(notAsked.tables.agent_events).toHaveLength(0);
    expect(noContent.tables.agent_events).toHaveLength(0);
    expect(drain).not.toHaveBeenCalled();
  });

  it("throws when the routine query fails, and queues nothing", async () => {
    const db = newDb([taskRow(LISTENING, listen)], shared);
    const drain = mock(async () => {});

    await expect(enqueueRoutineEvents(failingReads(db, "scheduled_tasks"), input, { drain })).rejects.toThrow("scheduled_tasks read failed");

    expect(db.tables.agent_events).toHaveLength(0);
    expect(drain).not.toHaveBeenCalled();
  });

  it("throws when the source item cannot be read or is missing", async () => {
    const drain = mock(async () => {});
    const db = newDb([taskRow(LISTENING, listen)], shared);

    await expect(enqueueRoutineEvents(failingReads(db, "source_items"), input, { drain })).rejects.toThrow("source_items read failed");
    await expect(enqueueRoutineEvents(fakeClient(newDb([taskRow(LISTENING, listen)], null)), input, { drain })).rejects.toThrow(`Source item ${SOURCE} was not found`);

    expect(db.tables.agent_events).toHaveLength(0);
  });

  it("records a refused insert for one routine, and still queues the others", async () => {
    const db = newDb([taskRow(REFUSED, listen), taskRow(LISTENING, listen)], shared);
    // A unique index that already holds this routine's row makes its next insert fail, as a real constraint would.
    db.tables.agent_events!.push({ id: "seeded", workspace_id: WS, scheduled_task_id: REFUSED, dedupe_key: "seeded" });
    db.unique.agent_events!.push({ name: "one_row_per_refused_routine", columns: ["scheduled_task_id"], where: (row) => row.scheduled_task_id === REFUSED });
    const drain = mock(async () => {});

    expect(await enqueueRoutineEvents(fakeClient(db), input, { drain })).toBe(1);

    expect(db.tables.agent_events!.filter((row) => row.scheduled_task_id === LISTENING)).toHaveLength(1);
    expect(db.tables.errors).toEqual([
      expect.objectContaining({
        workspace_id: WS,
        scheduled_task_id: REFUSED,
        operation: "scheduling",
        detail_json: expect.objectContaining({ code: "event_enqueue_failed", event: "fireflies.meeting_summarized", event_id: "meeting-1" }),
      }),
    ]);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("records a failed drain, and still returns the count of rows it added", async () => {
    const db = newDb([taskRow(LISTENING, listen)], shared);

    expect(await enqueueRoutineEvents(fakeClient(db), input, { drain: async () => { throw new Error("drain down"); } })).toBe(1);
    await until(() => (db.tables.errors ?? []).length > 0);

    expect(db.tables.errors).toEqual([expect.objectContaining({ workspace_id: WS, operation: "scheduling", detail_json: expect.objectContaining({ code: "event_drain_failed" }) })]);
    expect(db.tables.agent_events).toHaveLength(1);
  });
});

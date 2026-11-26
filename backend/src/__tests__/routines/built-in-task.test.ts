import { describe, expect, it } from "bun:test";
import { defaultBuiltInConfig } from "../../routines/built-in-config";
import { registerBuiltInTask } from "../../routines/built-in-task";
import { fakeClient, fakeDb } from "./fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const input = { workspaceId: WS, taskType: "summarize_sessions" as const, cron: "0 3 * * *", timezone: "America/New_York" };

describe("registering a built-in routine's scheduled task", () => {
  it("creates a cron task with the default settings, due at the next slot in the given timezone", async () => {
    const db = fakeDb({});
    await registerBuiltInTask(fakeClient(db), input);
    const [row] = db.tables.scheduled_tasks!;
    expect(row).toMatchObject({
      workspace_id: WS, task_type: "summarize_sessions", task_key: WS, schedule_kind: "cron", cron_expression: "0 3 * * *",
      timezone: "America/New_York", enabled: true, connection_id: null, interval_seconds: null,
    });
    expect(row!.config_json).toEqual(defaultBuiltInConfig("summarize_sessions"));
    expect(new Date(String(row!.next_due_at)).getTime()).toBeGreaterThan(Date.now());
  });

  it("keeps the settings a team saved when it is called again", async () => {
    const db = fakeDb({});
    const client = fakeClient(db);
    await registerBuiltInTask(client, input);
    db.tables.scheduled_tasks![0]!.config_json = { ...defaultBuiltInConfig("summarize_sessions"), prompt: "Custom instructions." };
    await registerBuiltInTask(client, input);
    expect(db.tables.scheduled_tasks).toHaveLength(1);
    expect(db.tables.scheduled_tasks![0]!.config_json).toMatchObject({ prompt: "Custom instructions." });
  });

  it("turns a paused task back on only when asked to", async () => {
    const paused = { id: "t1", workspace_id: WS, task_type: "summarize_sessions", task_key: WS, enabled: false, config_json: { prompt: "Mine." } };
    const left = fakeDb({ scheduled_tasks: [{ ...paused }] });
    await registerBuiltInTask(fakeClient(left), input);
    expect(left.tables.scheduled_tasks![0]!.enabled).toBe(false);

    const woken = fakeDb({ scheduled_tasks: [{ ...paused }] });
    await registerBuiltInTask(fakeClient(woken), { ...input, reenableExisting: true });
    expect(woken.tables.scheduled_tasks).toHaveLength(1);
    expect(woken.tables.scheduled_tasks![0]).toMatchObject({ enabled: true, config_json: { prompt: "Mine." } });
  });
});

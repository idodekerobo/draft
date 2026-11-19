import { describe, expect, it, mock } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sleepCloudSession } from "../../cloud-sessions/sleep";
import { fakeClient, fakeDb, failingOn, type FakeDb } from "../routines/fake-client";

type Row = Record<string, unknown>;

const WS = "ws-1";
const SESSION = "session-1";
const RUN = "run-1";
const NOW = new Date("2026-11-18T10:00:00.000Z");
const INPUT = { workspaceId: WS, sessionId: SESSION, runId: RUN };

function db(overrides: Record<string, Row[]> = {}): FakeDb {
  return fakeDb({
    sessions: [{ id: SESSION, workspace_id: WS, status: "live" }],
    agent_runs: [{ id: RUN, workspace_id: WS, session_id: SESSION, status: "running" }],
    session_inputs: [],
    errors: [],
    ...overrides,
  });
}

function input(state: string): Row {
  return { id: crypto.randomUUID(), session_id: SESSION, workspace_id: WS, kind: "message", state };
}

const sessionRow = (d: FakeDb) => d.tables.sessions![0]!;
const runRow = (d: FakeDb) => d.tables.agent_runs![0]!;
const errorCodes = (d: FakeDb) => d.tables.errors!.map((row) => (row.detail_json as { code?: string }).code);

/** A client that lands an input the first time the run is updated, which is after the first input check. */
function landingInputAfterCheck(d: FakeDb): SupabaseClient {
  const base = fakeClient(d);
  let landed = false;
  return {
    from: (table: string) => {
      if (table === "agent_runs" && !landed) {
        landed = true;
        d.tables.session_inputs!.push(input("queued"));
      }
      return base.from(table);
    },
    rpc: base.rpc,
  } as unknown as SupabaseClient;
}

describe("sleepCloudSession", () => {
  it("sleeps the session and succeeds its run when no input waits", async () => {
    const d = db();
    const wake = mock(async () => ({ status: "woken" }));

    const outcome = await sleepCloudSession(INPUT, { client: fakeClient(d), wake, now: () => NOW });

    expect(outcome).toBe("sleeping");
    expect(sessionRow(d)).toMatchObject({ status: "sleeping" });
    expect(runRow(d)).toMatchObject({ status: "succeeded", completed_at: NOW.toISOString() });
    expect(wake).not.toHaveBeenCalled();
    expect(d.tables.errors).toEqual([]);
  });

  it.each(["queued", "delivering"])("refuses the sleep while a %s input waits, and leaves the run active", async (state) => {
    const d = db({ session_inputs: [input(state)] });
    const wake = mock(async () => ({ status: "woken" }));

    const outcome = await sleepCloudSession(INPUT, { client: fakeClient(d), wake, now: () => NOW });

    expect(outcome).toBe("inputs_pending");
    expect(sessionRow(d)).toMatchObject({ status: "live" });
    expect(runRow(d)).toMatchObject({ status: "running" });
    expect(wake).not.toHaveBeenCalled();
  });

  it("wakes the session when an input lands after the first check, since its own send saw the session awake", async () => {
    const d = db();
    const wake = mock(async () => ({ status: "woken" }));

    const outcome = await sleepCloudSession(INPUT, { client: landingInputAfterCheck(d), wake, now: () => NOW });

    expect(outcome).toBe("inputs_pending");
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith({ workspaceId: WS, sessionId: SESSION });
    expect(sessionRow(d)).toMatchObject({ status: "sleeping" });
    expect(d.tables.errors).toEqual([]);
  });

  it("reports a session that changed meanwhile, and does not sleep it", async () => {
    const d = db({ sessions: [{ id: SESSION, workspace_id: WS, status: "ended" }] });
    const wake = mock(async () => ({ status: "woken" }));

    const outcome = await sleepCloudSession(INPUT, { client: fakeClient(d), wake, now: () => NOW });

    expect(outcome).toBe("session_changed");
    expect(sessionRow(d)).toMatchObject({ status: "ended" });
    expect(wake).not.toHaveBeenCalled();
    expect(d.tables.errors).toEqual([]);
  });

  it("records a failed input read, and sleeps nothing", async () => {
    const d = db();
    const client = failingOn(fakeClient(d), "session_inputs", "inputs down");

    const outcome = await sleepCloudSession(INPUT, { client, wake: mock(async () => ({})), now: () => NOW });

    expect(outcome).toBe("failed");
    expect(sessionRow(d)).toMatchObject({ status: "live" });
    expect(runRow(d)).toMatchObject({ status: "running" });
    expect(errorCodes(d)).toEqual(["session_sleep_failed"]);
  });

  it("records a failed run update, and leaves the session awake", async () => {
    const d = db();
    const client = failingOn(fakeClient(d), "agent_runs", "runs down");

    const outcome = await sleepCloudSession(INPUT, { client, wake: mock(async () => ({})), now: () => NOW });

    expect(outcome).toBe("failed");
    expect(sessionRow(d)).toMatchObject({ status: "live" });
    expect(d.tables.errors![0]).toMatchObject({ agent_run_id: RUN });
    expect(errorCodes(d)).toEqual(["session_sleep_failed"]);
  });

  it("records a failed wake for a late input, after the session slept", async () => {
    const d = db();
    const wake = mock(async (): Promise<never> => {
      throw new Error("start down");
    });

    const outcome = await sleepCloudSession(INPUT, { client: landingInputAfterCheck(d), wake, now: () => NOW });

    expect(outcome).toBe("failed");
    expect(sessionRow(d)).toMatchObject({ status: "sleeping" });
    expect(errorCodes(d)).toEqual(["session_sleep_failed"]);
  });
});

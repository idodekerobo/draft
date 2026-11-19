import { describe, expect, it, mock } from "bun:test";
import type { CloudSessionRef } from "../../cloud-sessions/undelivered-inputs";
import { hasUndeliveredInputs, wakeIfUndelivered } from "../../cloud-sessions/undelivered-inputs";
import { fakeClient, fakeDb, failingOn, type FakeDb } from "../routines/fake-client";

const WS = "ws-1";
const SESSION = "session-1";
const REF: CloudSessionRef = { workspaceId: WS, sessionId: SESSION };

function input(state: string, overrides: Record<string, unknown> = {}) {
  return { id: crypto.randomUUID(), session_id: SESSION, workspace_id: WS, kind: "message", state, ...overrides };
}

function dbWith(rows: Record<string, unknown>[]): FakeDb {
  return fakeDb({ session_inputs: rows as Record<string, unknown>[] });
}

describe("hasUndeliveredInputs", () => {
  it.each(["queued", "delivering"])("counts a %s input as undelivered", async (state) => {
    expect(await hasUndeliveredInputs(fakeClient(dbWith([input(state)])), REF)).toBe(true);
  });

  it.each(["consumed", "failed", "uncertain", "cancelled"])("does not count a %s input", async (state) => {
    expect(await hasUndeliveredInputs(fakeClient(dbWith([input(state)])), REF)).toBe(false);
  });

  it("counts control inputs too, since the host takes every kind", async () => {
    expect(await hasUndeliveredInputs(fakeClient(dbWith([input("queued", { kind: "stop" })])), REF)).toBe(true);
  });

  it("ignores inputs of another session or workspace", async () => {
    const rows = [input("queued", { session_id: "session-2" }), input("queued", { workspace_id: "ws-2" })];
    expect(await hasUndeliveredInputs(fakeClient(dbWith(rows)), REF)).toBe(false);
  });

  it("throws when the read fails, so the caller can record it", async () => {
    const client = failingOn(fakeClient(dbWith([input("queued")])), "session_inputs", "inputs down");
    await expect(hasUndeliveredInputs(client, REF)).rejects.toThrow("inputs down");
  });
});

describe("wakeIfUndelivered", () => {
  it("wakes nothing when every input is taken", async () => {
    const wake = mock(async () => ({ status: "woken" }));
    expect(await wakeIfUndelivered(fakeClient(dbWith([input("consumed")])), REF, wake)).toBe(false);
    expect(wake).not.toHaveBeenCalled();
  });

  it("wakes the session when an input is still undelivered, and reports that it did", async () => {
    const wake = mock(async () => ({ status: "woken" }));
    expect(await wakeIfUndelivered(fakeClient(dbWith([input("delivering")])), REF, wake)).toBe(true);
    expect(wake).toHaveBeenCalledWith(REF);
  });

  it("lets a failed wake reach the caller", async () => {
    const wake = mock(async (): Promise<never> => {
      throw new Error("start down");
    });
    await expect(wakeIfUndelivered(fakeClient(dbWith([input("queued")])), REF, wake)).rejects.toThrow("start down");
  });
});

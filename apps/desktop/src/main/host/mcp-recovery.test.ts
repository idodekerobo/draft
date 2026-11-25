import { expect, test } from "bun:test";
import { afterMcpRestored } from "./mcp-recovery";
import { McpStatusStore } from "./mcp-status";

test("session recovery cannot race bridge restoration, including unavailable results", async () => {
  for (const state of ["ready", "unavailable"]) {
    let release!: () => void;
    const restored = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const recovery = afterMcpRestored(() => restored, () => { calls.push(state); return "coding"; });
    await Promise.resolve(); expect(calls).toEqual([]);
    release(); expect(await recovery).toBe("coding"); expect(calls).toEqual([state]);
  }
});

test("status revisions let a renderer reject snapshots older than a received update", () => {
  const store = new McpStatusStore(); const received: number[] = [];
  store.subscribe((value) => received.push(value.revision));
  store.set("one", { state: "connecting" });
  const snapshot = store.get("one");
  store.set("one", { state: "ready" });
  expect(store.get("one").revision).toBeGreaterThan(snapshot.revision);
  store.clear(); expect(store.get("one").status).toBeNull();
  expect(received).toEqual([1, 2, 3]);
});

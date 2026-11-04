import { describe, expect, it } from "bun:test";
import { pollInstallSession, type InstallSessionStatus } from "./github-install-poll";

function harness(statuses: Array<InstallSessionStatus | Error>, options: { cancelAfter?: number; timeoutMs?: number } = {}) {
  let clock = 0;
  let fetches = 0;
  const run = () => pollInstallSession({
    fetchStatus: async () => {
      const next = statuses[Math.min(fetches, statuses.length - 1)]!;
      fetches += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    isCancelled: () => options.cancelAfter !== undefined && fetches >= options.cancelAfter,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    intervalMs: 1_000,
    timeoutMs: options.timeoutMs ?? 10_000,
  });
  return { run, fetchCount: () => fetches };
}

describe("pollInstallSession", () => {
  it("keeps polling while pending, then reports connected", async () => {
    const { run, fetchCount } = harness([{ status: "pending" }, { status: "pending" }, { status: "connected" }]);
    expect(await run()).toEqual({ outcome: "connected" });
    expect(fetchCount()).toBe(3);
  });

  it("reports the error message GitHub flow returned", async () => {
    const { run } = harness([{ status: "error", errorMessage: "Needs owner approval" }]);
    expect(await run()).toEqual({ outcome: "error", message: "Needs owner approval" });
  });

  it("falls back to a generic message when none is given", async () => {
    const { run } = harness([{ status: "error" }]);
    const result = await run();
    expect(result.outcome).toBe("error");
  });

  it("times out when the session never resolves", async () => {
    const { run } = harness([{ status: "pending" }], { timeoutMs: 3_000 });
    expect(await run()).toEqual({ outcome: "error", message: "The GitHub install timed out. Try again." });
  });

  it("treats a 404 as an expired session", async () => {
    const { run } = harness([Object.assign(new Error("not found"), { status: 404 })]);
    expect((await run()).outcome).toBe("error");
  });

  it("retries after a transient failure", async () => {
    const { run, fetchCount } = harness([Object.assign(new Error("network"), { status: 0 }), { status: "connected" }]);
    expect(await run()).toEqual({ outcome: "connected" });
    expect(fetchCount()).toBe(2);
  });

  it("stops when cancelled", async () => {
    const { run, fetchCount } = harness([{ status: "pending" }], { cancelAfter: 2 });
    expect(await run()).toEqual({ outcome: "cancelled" });
    expect(fetchCount()).toBe(2);
  });
});

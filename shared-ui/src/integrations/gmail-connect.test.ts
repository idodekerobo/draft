import { describe, expect, test } from "bun:test";
import { gmailErrorMessage, waitForGmailConnect } from "./gmail-connect";
import type { GoogleConnectPoll } from "../types";

function scripted(results: Array<GoogleConnectPoll | Error>) {
  let index = 0;
  const poll = async () => {
    const next = results[Math.min(index++, results.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  };
  return { poll, calls: () => index };
}

const instant = { sleep: async () => {}, isCancelled: () => false };

describe("waitForGmailConnect", () => {
  test("resolves when the browser tab finishes", async () => {
    const { poll, calls } = scripted([{ status: "pending" }, { status: "pending" }, { status: "connected" }]);
    expect(await waitForGmailConnect(poll, instant)).toEqual({ status: "connected" });
    expect(calls()).toBe(3);
  });

  test("returns the server's message when the connect fails", async () => {
    const { poll } = scripted([{ status: "error", message: "Gmail access was not granted." }]);
    expect(await waitForGmailConnect(poll, instant)).toEqual({ status: "error", message: "Gmail access was not granted." });
  });

  test("survives a couple of failed polls but gives up after five in a row", async () => {
    const flaky = scripted([new Error("net"), new Error("net"), { status: "connected" }]);
    expect(await waitForGmailConnect(flaky.poll, instant)).toEqual({ status: "connected" });

    const dead = scripted([new Error("net")]);
    const outcome = await waitForGmailConnect(dead.poll, instant);
    expect(outcome.status).toBe("error");
    expect(dead.calls()).toBe(5);
  });

  test("stops when cancelled and times out after ten minutes", async () => {
    const { poll, calls } = scripted([{ status: "pending" }]);
    let polls = 0;
    const cancelled = await waitForGmailConnect(poll, { sleep: async () => {}, isCancelled: () => polls++ >= 2 });
    expect(cancelled).toEqual({ status: "cancelled" });
    expect(calls()).toBe(2);

    let clock = 0;
    const timedOut = await waitForGmailConnect(scripted([{ status: "pending" }]).poll, {
      isCancelled: () => false,
      now: () => clock,
      sleep: async () => { clock += 60_000; },
    });
    expect(timedOut).toMatchObject({ status: "error" });
  });
});

describe("gmailErrorMessage", () => {
  test("maps known codes and falls back otherwise", () => {
    expect(gmailErrorMessage("google_already_connected", "x")).toContain("already connected");
    expect(gmailErrorMessage("weird", "fallback")).toBe("fallback");
    expect(gmailErrorMessage(undefined, "fallback")).toBe("fallback");
  });
});

import { describe, expect, test } from "bun:test";
import { pollGithubInstall, GithubInstallPollError } from "../github-install-poll";

function harness(opts: {
  responses: (url: string) => Promise<Response> | Response;
  pollIntervalMs?: number;
  deadlineMs?: number;
}) {
  const controller = new AbortController();
  const fetchImpl = ((input: string) => Promise.resolve(opts.responses(input))) as typeof fetch;
  const run = () => pollGithubInstall({
    apiUrl: "https://api.test",
    workspaceId: "ws-1",
    code: "abc123",
    fetch: fetchImpl,
    signal: controller.signal,
    pollIntervalMs: opts.pollIntervalMs ?? 1,
    deadlineMs: opts.deadlineMs ?? 50,
  });
  return { run, controller };
}

describe("pollGithubInstall", () => {
  test("resolves connected after a pending status", async () => {
    let polls = 0;
    const h = harness({
      responses: () => {
        polls++;
        if (polls < 2) return Response.json({ status: "pending" });
        return Response.json({ status: "connected" });
      },
    });
    await expect(h.run()).resolves.toEqual({ status: "connected" });
  });

  test("resolves with an error status and its message", async () => {
    const h = harness({ responses: () => Response.json({ status: "error", errorMessage: "owner approval required" }) });
    await expect(h.run()).resolves.toEqual({ status: "error", message: "owner approval required" });
  });

  test("404 rejects with expired", async () => {
    const h = harness({ responses: () => new Response(null, { status: 404 }) });
    await expect(h.run()).rejects.toMatchObject({ kind: "expired" });
  });

  test("403 rejects with forbidden", async () => {
    const h = harness({ responses: () => new Response(null, { status: 403 }) });
    await expect(h.run()).rejects.toMatchObject({ kind: "forbidden" });
  });

  test("other non-ok status rejects with poll_failed", async () => {
    const h = harness({ responses: () => new Response(null, { status: 500 }) });
    await expect(h.run()).rejects.toMatchObject({ kind: "poll_failed" });
  });

  test("malformed body rejects with malformed_response", async () => {
    const h = harness({ responses: () => Response.json({ status: "unexpected" }) });
    await expect(h.run()).rejects.toMatchObject({ kind: "malformed_response" });
  });

  test("timeout: deadline reached while still pending", async () => {
    const h = harness({ responses: () => Response.json({ status: "pending" }), pollIntervalMs: 1, deadlineMs: 5 });
    await expect(h.run()).rejects.toMatchObject({ kind: "timed_out" });
  });

  test("signal cancellation stops polling", async () => {
    let pollCount = 0;
    const h = harness({
      responses: () => {
        pollCount++;
        return Response.json({ status: "pending" });
      },
      pollIntervalMs: 5,
      deadlineMs: 1000,
    });
    const promise = h.run();
    setTimeout(() => h.controller.abort(), 8);
    await expect(promise).rejects.toMatchObject({ kind: "aborted" });
    const countAtAbort = pollCount;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pollCount).toBe(countAtAbort);
  });

  test("GithubInstallPollError instances carry their kind", () => {
    const error = new GithubInstallPollError("expired");
    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe("expired");
  });
});

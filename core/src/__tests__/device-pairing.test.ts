import { describe, expect, test } from "bun:test";
import { pairDevice, DevicePairingError } from "../device-pairing";

function harness(opts: {
  responses: (url: string, init?: RequestInit) => Promise<Response> | Response;
  pollIntervalMs?: number;
  deadlineMs?: number;
  now?: () => number;
}) {
  const urls: string[] = [];
  const progress: string[] = [];
  const controller = new AbortController();
  const fetchImpl = ((input: string, init?: RequestInit) => Promise.resolve(opts.responses(input, init))) as typeof fetch;
  const run = () => pairDevice({
    apiUrl: "https://api.test",
    appUrl: "https://app.test",
    fetch: fetchImpl,
    signal: controller.signal,
    onUrl: (url) => urls.push(url),
    onProgress: (event) => progress.push(event.phase),
    pollIntervalMs: opts.pollIntervalMs ?? 1,
    deadlineMs: opts.deadlineMs ?? 50,
    now: opts.now,
  });
  return { run, urls, progress, controller };
}

describe("pairDevice", () => {
  test("success: emits the pairing URL then resolves with tokens", async () => {
    let polls = 0;
    const h = harness({
      responses: (url) => {
        if (url.endsWith("/link")) return Response.json({ code: "abc123" });
        polls++;
        if (polls < 2) return new Response(null, { status: 204 });
        return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 60 });
      },
    });
    const tokens = await h.run();
    expect(tokens.access_token).toBe("at");
    expect(tokens.refresh_token).toBe("rt");
    expect(h.urls).toEqual(["https://app.test/link?code=abc123"]);
    expect(h.progress).toEqual(["awaiting_approval", "authenticated"]);
  });

  test("refusal/expiry: 404 on poll rejects with expired", async () => {
    const h = harness({
      responses: (url) => url.endsWith("/link") ? Response.json({ code: "x" }) : new Response(null, { status: 404 }),
    });
    await expect(h.run()).rejects.toMatchObject({ kind: "expired" });
    expect(h.progress).toContain("expired");
  });

  test("malformed response: missing code on create", async () => {
    const h = harness({ responses: () => Response.json({}) });
    await expect(h.run()).rejects.toMatchObject({ kind: "malformed_response" });
  });

  test("malformed response: missing tokens on poll", async () => {
    const h = harness({
      responses: (url) => url.endsWith("/link") ? Response.json({ code: "x" }) : Response.json({ foo: "bar" }),
    });
    await expect(h.run()).rejects.toMatchObject({ kind: "malformed_response" });
  });

  test("transient failure: non-ok poll response", async () => {
    const h = harness({
      responses: (url) => url.endsWith("/link") ? Response.json({ code: "x" }) : new Response(null, { status: 500 }),
    });
    await expect(h.run()).rejects.toMatchObject({ kind: "pairing_failed" });
  });

  test("create pairing failure", async () => {
    const h = harness({ responses: () => new Response(null, { status: 500 }) });
    await expect(h.run()).rejects.toMatchObject({ kind: "pairing_failed" });
    expect(h.urls).toEqual([]);
  });

  test("timeout: deadline reached without approval", async () => {
    const h = harness({
      responses: (url) => url.endsWith("/link") ? Response.json({ code: "x" }) : new Response(null, { status: 204 }),
      pollIntervalMs: 1,
      deadlineMs: 5,
    });
    await expect(h.run()).rejects.toMatchObject({ kind: "timed_out" });
    expect(h.progress).toContain("expired");
  });

  test("signal cancellation: aborts cleanly and stops polling", async () => {
    let pollCount = 0;
    const h = harness({
      responses: (url) => {
        if (url.endsWith("/link")) return Response.json({ code: "x" });
        pollCount++;
        return new Response(null, { status: 204 });
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

  test("DevicePairingError instances carry their kind", () => {
    const error = new DevicePairingError("expired");
    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe("expired");
  });
});

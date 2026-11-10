import { afterEach, describe, expect, mock, test } from "bun:test";
import { serverFetcher } from "./server-prefetch";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("serverFetcher", () => {
  test("marks server-side prefetches as the web app, so the backend does not count them as an agent", async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;

    await serverFetcher("token-1")("/workspaces/w/tools/context.read", { method: "POST", body: "{}" });

    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ "x-draft-client": "web", Authorization: "Bearer token-1" });
    expect(init.method).toBe("POST");
  });
});

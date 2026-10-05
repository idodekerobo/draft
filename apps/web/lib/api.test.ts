import { afterEach, describe, expect, mock, test } from "bun:test";

let session: { access_token: string } | null = { access_token: "token-1" };
mock.module("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session } }) } }),
}));

const { ApiError, apiFetch, apiFetchBlob } = await import("./api");
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  session = { access_token: "token-1" };
});

function respond(status: number, body: unknown) {
  globalThis.fetch = mock(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("apiFetch", () => {
  test("sends the bearer token and returns the body", async () => {
    respond(200, { ok: true });
    expect(await apiFetch("/whoami")).toEqual({ ok: true });
    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
  });

  test("turns an {error} body into a typed error", async () => {
    respond(404, { error: "no_context_yet" });
    const error = await apiFetch("/x").catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: "no_context_yet" });
  });

  test("reports 401 and a missing session as status 401", async () => {
    respond(401, {});
    expect(await apiFetch("/x").catch((caught) => caught)).toMatchObject({ status: 401, code: "http_401" });
    session = null;
    expect(await apiFetch("/x").catch((caught) => caught)).toMatchObject({ status: 401, code: "signed_out" });
  });

  test("reports a network failure as status 0", async () => {
    globalThis.fetch = mock(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    expect(await apiFetch("/x").catch((caught) => caught)).toMatchObject({ status: 0, code: "network" });
  });
});

describe("apiFetchBlob", () => {
  test("returns the file and its name from Content-Disposition", async () => {
    globalThis.fetch = mock(async () => new Response("zipbytes", {
      headers: { "content-disposition": 'attachment; filename="draft-context-v3-2026-10-05.zip"' },
    })) as unknown as typeof fetch;
    const { blob, fileName } = await apiFetchBlob("/workspaces/ws-1/context/export");
    expect(fileName).toBe("draft-context-v3-2026-10-05.zip");
    expect(await blob.text()).toBe("zipbytes");
  });

  test("turns an {error} body into a typed error", async () => {
    respond(404, { error: "no_context_yet" });
    expect(await apiFetchBlob("/x").catch((caught) => caught)).toMatchObject({ status: 404, code: "no_context_yet" });
  });
});

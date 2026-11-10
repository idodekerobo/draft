import { afterEach, describe, expect, test } from "bun:test";
import { AuthRefreshError } from "draft-core/auth-state";
import { callTool, createServerFetch, ServerError, SessionExpiredError, setSessionExpiredHandler, type ServerFetchDeps, type SessionExpiredCause } from "./server-client";

function setup(statuses: number[], token: ServerFetchDeps["token"] = async (force) => (force ? "fresh" : "old")) {
  const requests: string[] = [];
  const forced: boolean[] = [];
  const deps: ServerFetchDeps = {
    token: async (force) => { forced.push(force); return token(force); },
    fetch: async (_url, init) => {
      requests.push((init.headers as Record<string, string>).Authorization ?? "");
      return new Response(null, { status: statuses.shift() ?? 200 });
    },
  };
  let expired = 0;
  const causes: SessionExpiredCause[] = [];
  setSessionExpiredHandler((cause) => { expired++; causes.push(cause); });
  return { fetchServer: createServerFetch(deps), requests, forced, expired: () => expired, causes };
}

afterEach(() => setSessionExpiredHandler(null));

describe("fetchServer client header", () => {
  test("marks every call as coming from the desktop app, so the backend does not count it as an agent", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchServer = createServerFetch({
      token: async () => "old",
      fetch: async (_url, init) => {
        seen.push(init.headers as Record<string, string>);
        return new Response(null, { status: 200 });
      },
    });
    await fetchServer("workspaces/w/context", { headers: { "X-Other": "kept" } });
    expect(seen[0]).toMatchObject({ "x-draft-client": "desktop", Authorization: "Bearer old", "X-Other": "kept" });
  });
});

describe("fetchServer session expiry", () => {
  test("terminal refresh error calls the handler and throws SessionExpiredError", async () => {
    const t = setup([], async () => { throw new AuthRefreshError("terminal"); });
    await expect(t.fetchServer("x")).rejects.toBeInstanceOf(SessionExpiredError);
    expect(t.expired()).toBe(1);
  });
  test("a missing login calls the handler", async () => {
    const t = setup([], async () => { throw new Error("not_signed_in"); });
    await expect(t.fetchServer("x")).rejects.toBeInstanceOf(SessionExpiredError);
    expect(t.expired()).toBe(1);
  });
  test("401 then success retries once with a forced refresh and keeps the login", async () => {
    const t = setup([401, 200]);
    const response = await t.fetchServer("x");
    expect(response.status).toBe(200);
    expect(t.forced).toEqual([false, true]);
    expect(t.requests).toEqual(["Bearer old", "Bearer fresh"]);
    expect(t.expired()).toBe(0);
  });
  test("401 twice calls the handler", async () => {
    const t = setup([401, 401]);
    await expect(t.fetchServer("x")).rejects.toBeInstanceOf(SessionExpiredError);
    expect(t.expired()).toBe(1);
    expect(t.causes[0]).toEqual({ apiStatus: 401 });
  });
  test("passes the refresh error to the handler so the sign-out can be explained", async () => {
    const error = new AuthRefreshError("terminal", 400, "refresh_token_already_used");
    const t = setup([], async () => { throw error; });
    await expect(t.fetchServer("x")).rejects.toBeInstanceOf(SessionExpiredError);
    expect(t.causes[0]?.error).toBe(error);
  });
  test("terminal refresh error on the retry calls the handler", async () => {
    const t = setup([401], async (force) => { if (force) throw new AuthRefreshError("terminal"); return "old"; });
    await expect(t.fetchServer("x")).rejects.toBeInstanceOf(SessionExpiredError);
    expect(t.expired()).toBe(1);
  });
  test("403 is a normal request error", async () => {
    const t = setup([403]);
    await expect(t.fetchServer("x")).rejects.toBeInstanceOf(ServerError);
    expect(t.expired()).toBe(0);
    expect(t.forced).toEqual([false]);
  });
  test("5xx is a normal request error", async () => {
    const t = setup([503]);
    await expect(t.fetchServer("x")).rejects.toBeInstanceOf(ServerError);
    expect(t.expired()).toBe(0);
  });
  test("transient refresh error is rethrown without the handler", async () => {
    const t = setup([], async () => { throw new AuthRefreshError("transient"); });
    await expect(t.fetchServer("x")).rejects.toBeInstanceOf(AuthRefreshError);
    expect(t.expired()).toBe(0);
  });
});

describe("callTool", () => {
  test("posts the input to the tool's path and returns its output", async () => {
    const seen: Array<{ path: string; init?: RequestInit }> = [];
    const output = await callTool<{ n: number }>(
      (async (path: string, init?: RequestInit) => (seen.push({ path, init }), { status: "ok", output: { n: 1 } })) as never,
      "ws-1",
      "context.read",
      { paths: ["a.md"] },
    );
    expect(output).toEqual({ n: 1 });
    expect(seen[0]!.path).toBe("workspaces/ws-1/tools/context.read");
    expect(seen[0]!.init).toMatchObject({ method: "POST", body: JSON.stringify({ paths: ["a.md"] }) });
  });

  test("throws a ServerError with the tool's code when its output is a refusal", async () => {
    const error = await callTool((async () => ({ status: "ok", output: { error: "no_context_yet" } })) as never, "ws-1", "context.read").catch((caught) => caught);
    expect(error).toBeInstanceOf(ServerError);
    expect(error).toMatchObject({ code: "no_context_yet" });
  });
});

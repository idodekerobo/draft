import { describe, expect, it } from "bun:test";
import { ServerError, SessionExpiredError } from "draft-core/host/services";
import { buildHostServices } from "../../sandbox/host/cloud-services";

const config = { apiBase: "https://api.example.test", runToken: "run-secret", sessionId: "sess-1", workspaceId: "ws-1" };

function hostWith(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const host = buildHostServices(config, {
    fetch: async (url, init) => {
      requests.push({ url, init });
      return respond(url, init);
    },
    capture: async () => ({ exitCode: 0, stdout: "captured", stderr: "" }),
  });
  return { host, requests };
}

async function errorOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("fetchServer", () => {
  it("joins the base URL and sends the run token on every call", async () => {
    const { host, requests } = hostWith(() => new Response(null, { status: 204 }));

    await host.fetchServer("workspaces/ws-1/live-sessions/sess-1/heartbeat", { method: "POST", body: "{}" });

    expect(requests[0]!.url).toBe("https://api.example.test/workspaces/ws-1/live-sessions/sess-1/heartbeat");
    const headers = new Headers(requests[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer run-secret");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("x-draft-client")).toBe(false);
  });

  it("maps a server error to a ServerError with its code, field and body", async () => {
    const { host } = hostWith(() => Response.json({ error: "session_ended", field: "hostId" }, { status: 409 }));

    const error = await errorOf(() => host.fetchServer("workspaces/ws-1/live-sessions/sess-1/end", { method: "POST" }));

    expect(error).toBeInstanceOf(ServerError);
    expect(error).toMatchObject({ code: "session_ended", field: "hostId", detail: { error: "session_ended", field: "hostId" } });
  });

  it("uses the status as the code when the error body is not JSON", async () => {
    const { host } = hostWith(() => new Response("<html>bad gateway</html>", { status: 502 }));

    const error = await errorOf(() => host.fetchServer("workspaces/ws-1/live-sessions/sess-1/heartbeat"));

    expect(error).toMatchObject({ code: "request_failed_502" });
  });

  it("pauses the session when the run token is rejected", async () => {
    const { host } = hostWith(() => new Response(null, { status: 401 }));

    expect(await errorOf(() => host.fetchServer("workspaces/ws-1/live-sessions/sess-1/heartbeat"))).toBeInstanceOf(SessionExpiredError);
  });

  it("lets a network failure through unchanged, so the host retries it", async () => {
    const failure = new TypeError("fetch failed");
    const { host } = hostWith(() => {
      throw failure;
    });

    expect(await errorOf(() => host.fetchServer("workspaces/ws-1/live-sessions/sess-1/heartbeat"))).toBe(failure);
  });
});

describe("fetchServerJSON", () => {
  it("parses the body of a successful call", async () => {
    const { host } = hostWith(() => Response.json({ inputs: [{ id: "i1" }] }));

    expect(await host.fetchServerJSON<{ inputs: Array<{ id: string }> }>("workspaces/ws-1/live-sessions/sess-1/inputs/pending")).toEqual({
      inputs: [{ id: "i1" }],
    });
  });
});

describe("the other host services", () => {
  it("has no realtime: nothing connects, watches or sends", () => {
    const { host } = hostWith(() => new Response(null));
    expect(host.realtime.connected()).toBe(false);
    const stop = host.realtime.watch("signals:session:sess-1", () => {});
    expect(() => stop()).not.toThrow();
    expect(() => host.realtime.send("live:session:sess-1", "text", {})).not.toThrow();
  });

  it("names the workspace and the cloud host", () => {
    const { host } = hostWith(() => new Response(null));
    expect(host.workspaceId()).toBe("ws-1");
    expect(host.hostId()).toBe("cloud:sess-1");
  });

  it("runs commands through the injected capture", async () => {
    const { host } = hostWith(() => new Response(null));
    expect((await host.capture(["claude", "--version"])).stdout).toBe("captured");
  });

  it("refuses to open a terminal, since a cloud session has none", async () => {
    const { host } = hostWith(() => new Response(null));
    expect(await errorOf(() => host.openInTerminal("pane", "exec attach"))).toMatchObject({
      message: "openInTerminal is not available in a cloud session",
    });
  });
});

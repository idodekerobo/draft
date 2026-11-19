import { describe, expect, it, mock } from "bun:test";
import { ServerError } from "draft-core/host/services";
import { startCloudLiveSession, startLiveSessionRequest, type CloudStartDeps, type CloudStartParams } from "./live-session-api";

const cloud: CloudStartParams = { runtime: "cloud", model: "sonnet", effort: "high", network: "restricted", gitRemote: "https://github.com/acme/marigold", branch: "main" };

function deps(response: () => Promise<unknown>, workspaceId: string | null = "w1") {
  const fetchServerJSON = mock(async (_path: string, _init?: RequestInit) => response());
  const value: CloudStartDeps = { workspaceId: () => workspaceId, fetchServerJSON: fetchServerJSON as CloudStartDeps["fetchServerJSON"] };
  return { value, fetchServerJSON };
}

describe("startLiveSessionRequest for a cloud session", () => {
  it("posts the cloud body to the workspace and returns the new session", async () => {
    const { value, fetchServerJSON } = deps(async () => ({ ok: true, session: { id: "s-cloud" } }));
    const startLocal = mock(async () => ({ ok: true as const, sessionId: "local" }));
    const result = await startLiveSessionRequest(cloud, startLocal, value);
    expect(result).toEqual({ ok: true, sessionId: "s-cloud" });
    expect(fetchServerJSON).toHaveBeenCalledTimes(1);
    const [path, init] = fetchServerJSON.mock.calls[0]! as unknown as [string, RequestInit];
    expect(path).toBe("workspaces/w1/live-sessions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      runtime: "cloud",
      harness: "claude",
      model: "sonnet",
      reasoningEffort: "high",
      network: "restricted",
      seed: { kind: "repo", gitRemote: "https://github.com/acme/marigold", branch: "main" },
    });
  });

  it("starts no computer session for a cloud request", async () => {
    const { value } = deps(async () => ({ ok: true, session: { id: "s-cloud" } }));
    const startLocal = mock(async () => ({ ok: true as const, sessionId: "local" }));
    await startLiveSessionRequest(cloud, startLocal, value);
    expect(startLocal).not.toHaveBeenCalled();
  });

  it("passes the server's error code back, so the screen can say what is wrong", async () => {
    const { value } = deps(async () => { throw new ServerError("claude_not_connected"); });
    expect(await startCloudLiveSession(cloud, value)).toEqual({ ok: false, error: "claude_not_connected" });
  });

  it("reports start_failed when the request never got an answer", async () => {
    const { value } = deps(async () => { throw new TypeError("fetch failed"); });
    expect(await startCloudLiveSession(cloud, value)).toEqual({ ok: false, error: "start_failed" });
  });

  it("refuses without a workspace and sends nothing", async () => {
    const { value, fetchServerJSON } = deps(async () => ({}), null);
    expect(await startCloudLiveSession(cloud, value)).toEqual({ ok: false, error: "signed_out" });
    expect(fetchServerJSON).not.toHaveBeenCalled();
  });
});

describe("startLiveSessionRequest for a computer session", () => {
  it("hands a computer request to the local start, and does not call the server", async () => {
    const { value, fetchServerJSON } = deps(async () => ({}));
    const local = { harness: "codex", folderPath: "/work/marigold", model: null, effort: null };
    const startLocal = mock(async (_params: unknown) => ({ ok: true as const, sessionId: "local-1" }));
    expect(await startLiveSessionRequest(local, startLocal, value)).toEqual({ ok: true, sessionId: "local-1" });
    expect(startLocal).toHaveBeenCalledWith(local);
    expect(fetchServerJSON).not.toHaveBeenCalled();
  });
});

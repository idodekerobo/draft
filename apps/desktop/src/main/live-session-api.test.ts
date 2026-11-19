import { describe, expect, it, mock } from "bun:test";
import { ServerError } from "draft-core/host/services";
import { listLiveSessionEnvFiles, startCloudLiveSession, startLiveSessionRequest, uploadLiveSessionSnapshot, type CloudSnapshotDeps, type CloudStartDeps, type CloudStartParams } from "./live-session-api";
import type { SnapshotEntry, SnapshotFs } from "./snapshot";

const cloud: CloudStartParams = {
  runtime: "cloud",
  model: "sonnet",
  effort: "high",
  network: "restricted",
  seed: { kind: "repo", gitRemote: "https://github.com/acme/marigold", branch: "main" },
};
const snapshot: CloudStartParams = {
  runtime: "cloud",
  model: "sonnet",
  effort: "high",
  network: "restricted",
  seed: { kind: "snapshot", sessionId: "s-snap", storageKey: "w1/s-snap/seed.tar.gz", folderName: "marigold" },
};

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

describe("startCloudLiveSession from a folder snapshot", () => {
  it("names the uploaded session at the top level, and sends the key and folder name as the seed", async () => {
    const { value, fetchServerJSON } = deps(async () => ({ ok: true, session: { id: "s-snap" } }));
    expect(await startCloudLiveSession(snapshot, value)).toEqual({ ok: true, sessionId: "s-snap" });
    const [, init] = fetchServerJSON.mock.calls[0]! as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      runtime: "cloud",
      harness: "claude",
      model: "sonnet",
      reasoningEffort: "high",
      network: "restricted",
      sessionId: "s-snap",
      seed: { kind: "snapshot", storageKey: "w1/s-snap/seed.tar.gz", folderName: "marigold" },
    });
  });

  it("passes the server's refusal of a missing upload back as the error", async () => {
    const { value } = deps(async () => { throw new ServerError("seed_not_uploaded"); });
    expect(await startCloudLiveSession(snapshot, value)).toEqual({ ok: false, error: "seed_not_uploaded" });
  });
});

describe("startCloudLiveSession from a finished routine run", () => {
  it("sends the routine run's session as the seed, with no body session id, and returns the new chat", async () => {
    const { value, fetchServerJSON } = deps(async () => ({ ok: true, session: { id: "s-chat" } }));
    const continued: CloudStartParams = { runtime: "cloud", model: null, effort: null, network: "restricted", seed: { kind: "routine_run", sessionId: "s-run" } };

    expect(await startCloudLiveSession(continued, value)).toEqual({ ok: true, sessionId: "s-chat" });
    const [, init] = fetchServerJSON.mock.calls[0]! as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      runtime: "cloud",
      harness: "claude",
      model: null,
      reasoningEffort: null,
      network: "restricted",
      seed: { kind: "routine_run", sessionId: "s-run" },
    });
  });
});

describe("uploadLiveSessionSnapshot", () => {
  /** A folder with one source file and one .env file. Packing reads only the listing and the archive size. */
  const folder: SnapshotFs = {
    isDirectory: () => true,
    readDirectory: (dir) => {
      const entry = (name: string, isFile: boolean): SnapshotEntry => ({ name, isDirectory: () => !isFile, isFile: () => isFile, isSymbolicLink: () => false });
      return dir === "/work/marigold" ? [entry("index.ts", true), entry(".env", true)] : [];
    },
    fileSize: () => 512,
    makeTempDirectory: () => "/tmp/draft-snapshot-live",
    writeText: () => {},
    remove: () => {},
  };

  function snapshotDeps(options: { response?: () => Promise<unknown>; workspaceId?: string | null } = {}) {
    const fetchServerJSON = mock(async (_path: string, _init?: RequestInit) =>
      options.response ? options.response() : { ok: true, sessionId: "s-up", storageKey: "w1/s-up/seed.tar.gz", signedUrl: "https://storage.test/upload/s-up" },
    );
    const put = mock(async (_url: string, _archive: string, _bytes: number) => {});
    const exec = mock(async () => ({ exitCode: 0, stderr: "" }));
    const value: CloudSnapshotDeps = {
      workspaceId: () => (options.workspaceId === undefined ? "w1" : options.workspaceId),
      fetchServerJSON: fetchServerJSON as CloudSnapshotDeps["fetchServerJSON"],
      fs: folder,
      exec,
      put,
    };
    return { value, fetchServerJSON, put, exec };
  }

  it("packs the folder, asks the server for a link, PUTs the archive, and returns the start fields", async () => {
    const { value, fetchServerJSON, put, exec } = snapshotDeps();
    const result = await uploadLiveSessionSnapshot({ folderPath: "/work/marigold", includeEnvFiles: [] }, value);

    expect(result).toEqual({ ok: true, sessionId: "s-up", storageKey: "w1/s-up/seed.tar.gz", folderName: "marigold", bytes: 512 });
    expect(exec).toHaveBeenCalledTimes(1);
    const [path, init] = fetchServerJSON.mock.calls[0]! as unknown as [string, RequestInit];
    expect(path).toBe("workspaces/w1/live-sessions/seed-upload");
    expect(init.method).toBe("POST");
    expect(put).toHaveBeenCalledWith("https://storage.test/upload/s-up", "/tmp/draft-snapshot-live/snapshot.tar.gz", 512);
  });

  it("refuses without a workspace and packs nothing", async () => {
    const { value, fetchServerJSON, exec } = snapshotDeps({ workspaceId: null });
    expect(await uploadLiveSessionSnapshot({ folderPath: "/work/marigold", includeEnvFiles: [] }, value)).toEqual({ ok: false, error: "signed_out" });
    expect(fetchServerJSON).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("passes a refused link request back as its error code", async () => {
    const { value, put } = snapshotDeps({ response: async () => { throw new ServerError("seed_upload_url_failed"); } });
    expect(await uploadLiveSessionSnapshot({ folderPath: "/work/marigold", includeEnvFiles: [] }, value)).toEqual({ ok: false, error: "seed_upload_url_failed" });
    expect(put).not.toHaveBeenCalled();
  });
});

describe("listLiveSessionEnvFiles", () => {
  it("lists the folder's .env files for the checklist", () => {
    const fs: SnapshotFs = {
      isDirectory: () => true,
      readDirectory: () => [{ name: ".env.local", isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }],
      fileSize: () => 0,
      makeTempDirectory: () => "/tmp/x",
      writeText: () => {},
      remove: () => {},
    };
    expect(listLiveSessionEnvFiles("/work/marigold", fs)).toEqual({ ok: true, files: [".env.local"] });
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

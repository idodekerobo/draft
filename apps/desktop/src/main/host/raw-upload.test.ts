import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gunzipSync } from "zlib";
import { loadStates, saveState, deleteState, type HostSessionState } from "./cursor-store";
import { uploadRawFiles, type RawUploadDeps } from "./raw-upload";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "raw-"));
  dirs.push(dir);
  return dir;
}

function fakeDeps() {
  const calls: string[] = [];
  const uploaded = new Map<string, Buffer>();
  const deps: RawUploadDeps = {
    requestUrls: async (files) => {
      calls.push(`urls:${files.join(",")}`);
      return files.map((file) => ({ file, signedUrl: `https://storage.test/${file}` }));
    },
    put: async (url, gz) => {
      calls.push(`put:${url.split("/").slice(3).join("/")}`);
      uploaded.set(url.split("/").slice(3).join("/"), Buffer.from(gz));
    },
    complete: async () => void calls.push("complete"),
  };
  return { deps, calls, uploaded };
}

describe("uploadRawFiles", () => {
  it("gzips each file byte for byte, then marks the upload complete", async () => {
    const dir = tempDir();
    const root = join(dir, "root.jsonl");
    const sub = join(dir, "agent-a.jsonl");
    const rootBytes = Buffer.from('{"a":"é"}\n{"b":2}\n');
    writeFileSync(root, rootBytes);
    writeFileSync(sub, '{"c":3}\n');
    const { deps, calls, uploaded } = fakeDeps();

    const records = await uploadRawFiles(
      [{ label: "root.jsonl", path: root }, { label: "subagents/agent-a.jsonl", path: sub }],
      {},
      deps,
    );

    expect(calls).toEqual(["urls:root.jsonl,subagents/agent-a.jsonl", "put:root.jsonl", "put:subagents/agent-a.jsonl", "complete"]);
    expect(gunzipSync(uploaded.get("root.jsonl")!).equals(rootBytes)).toBe(true);
    expect(Object.keys(records)).toEqual(["root.jsonl", "subagents/agent-a.jsonl"]);
  });

  it("uploads nothing when no file changed since its last upload", async () => {
    const dir = tempDir();
    const root = join(dir, "root.jsonl");
    writeFileSync(root, "{}\n");
    const first = fakeDeps();
    const records = await uploadRawFiles([{ label: "root.jsonl", path: root }], {}, first.deps);

    const second = fakeDeps();
    expect(await uploadRawFiles([{ label: "root.jsonl", path: root }], records, second.deps)).toBe(records);
    expect(second.calls).toEqual([]);
  });

  it("uploads only the file that grew", async () => {
    const dir = tempDir();
    const root = join(dir, "root.jsonl");
    const sub = join(dir, "agent-a.jsonl");
    writeFileSync(root, "{}\n");
    writeFileSync(sub, "{}\n");
    const files = [{ label: "root.jsonl", path: root }, { label: "subagents/agent-a.jsonl", path: sub }];
    const records = await uploadRawFiles(files, {}, fakeDeps().deps);

    appendFileSync(sub, "{}\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(sub, later, later);
    const { deps, calls } = fakeDeps();
    await uploadRawFiles(files, records, deps);
    expect(calls).toEqual(["urls:subagents/agent-a.jsonl", "put:subagents/agent-a.jsonl", "complete"]);
  });

  it("keeps the old records when an upload fails so the next run retries", async () => {
    const dir = tempDir();
    const root = join(dir, "root.jsonl");
    writeFileSync(root, "{}\n");
    const { deps } = fakeDeps();
    deps.put = async () => {
      throw new Error("raw_upload_put_failed_500");
    };
    await expect(uploadRawFiles([{ label: "root.jsonl", path: root }], {}, deps)).rejects.toThrow("raw_upload_put_failed_500");
  });
});

describe("cursor store", () => {
  const state = (id: string): HostSessionState => ({
    sessionId: id,
    workspaceId: "ws",
    hostMachineId: "host",
    nativeSessionId: "native",
    folderPath: "/work/app",
    tmuxSession: `draft-${id}`,
    cursors: { "root.jsonl": { offset: 10, fingerprint: "abc", seenIds: ["u1"] } },
    rawUploads: {},
    ended: false,
  });

  it("round-trips states and deletes them", () => {
    const dir = tempDir();
    saveState(state("s1"), dir);
    saveState(state("s2"), dir);
    expect(loadStates(dir).map((s) => s.sessionId).sort()).toEqual(["s1", "s2"]);
    deleteState("s1", dir);
    expect(loadStates(dir).map((s) => s.sessionId)).toEqual(["s2"]);
  });

  it("skips a corrupt state file instead of failing", () => {
    const dir = tempDir();
    saveState(state("s1"), dir);
    writeFileSync(join(dir, "bad.json"), "{nope");
    expect(loadStates(dir).map((s) => s.sessionId)).toEqual(["s1"]);
  });

  it("returns nothing when the folder does not exist", () => {
    expect(loadStates(join(tempDir(), "missing"))).toEqual([]);
  });
});

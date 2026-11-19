import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SNAPSHOT_BUCKET, createSeedUpload, sessionIdOfSnapshotKey, snapshotKeyFor, storageSnapshotStore } from "../../cloud-sessions/snapshot-seed";

const WS = "11111111-1111-4111-8111-111111111111";
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY = `${WS}/${SESSION}/seed.tar.gz`;

type Call = { method: string; args: unknown[] };

/** A storage client over an in-memory list of object keys. Each failure option makes that call return an error. */
function fakeStorage(options: { objects?: string[]; listError?: boolean; signError?: boolean; uploadError?: boolean } = {}) {
  const calls: Call[] = [];
  const bucketCalls: string[] = [];
  const objects = options.objects ?? [];
  const bucket = {
    async list(folder: string) {
      calls.push({ method: "list", args: [folder] });
      if (options.listError) return { data: null, error: new Error("list failed") };
      const names = objects
        .filter((key) => key.startsWith(`${folder}/`) && !key.slice(folder.length + 1).includes("/"))
        .map((key) => ({ name: key.slice(folder.length + 1) }));
      return { data: names, error: null };
    },
    async createSignedUrl(path: string, ttl: number) {
      calls.push({ method: "createSignedUrl", args: [path, ttl] });
      if (options.signError) return { data: null, error: new Error("sign failed") };
      return { data: { signedUrl: `https://project.supabase.co/storage/v1/object/sign/${SNAPSHOT_BUCKET}/${path}?token=t` }, error: null };
    },
    async createSignedUploadUrl(path: string, uploadOptions: unknown) {
      calls.push({ method: "createSignedUploadUrl", args: [path, uploadOptions] });
      if (options.uploadError) return { data: null, error: new Error("upload sign failed") };
      return { data: { signedUrl: `https://project.supabase.co/storage/v1/object/upload/sign/${SNAPSHOT_BUCKET}/${path}?token=u` }, error: null };
    },
  };
  const client = {
    storage: {
      from: (bucketId: string) => {
        bucketCalls.push(bucketId);
        return bucket;
      },
    },
  } as unknown as SupabaseClient;
  return { client, calls, bucketCalls };
}

describe("snapshot keys", () => {
  it("names a snapshot by its workspace and session", () => {
    expect(snapshotKeyFor(WS, SESSION)).toBe(KEY);
  });

  it("reads the session id back only from a seed key of this workspace", () => {
    expect(sessionIdOfSnapshotKey(KEY, WS)).toBe(SESSION);
    expect(sessionIdOfSnapshotKey(KEY, "22222222-2222-4222-8222-222222222222")).toBeNull();
    expect(sessionIdOfSnapshotKey(`${WS}/${SESSION}/root.jsonl.gz`, WS)).toBeNull();
    expect(sessionIdOfSnapshotKey(`${WS}/${SESSION.toUpperCase()}/seed.tar.gz`, WS)).toBeNull();
  });
});

describe("storageSnapshotStore", () => {
  it("reports a snapshot that is in its session folder, in the session-seeds bucket", async () => {
    const storage = fakeStorage({ objects: [KEY] });
    expect(await storageSnapshotStore(storage.client).exists(KEY)).toBe(true);
    expect(storage.bucketCalls).toEqual([SNAPSHOT_BUCKET]);
    expect(storage.calls).toEqual([{ method: "list", args: [`${WS}/${SESSION}`] }]);
  });

  it("reports a missing snapshot, and ignores other files in the folder", async () => {
    const storage = fakeStorage({ objects: [`${WS}/${SESSION}/other.tar.gz`] });
    expect(await storageSnapshotStore(storage.client).exists(KEY)).toBe(false);
  });

  it("throws when the listing fails, so a start does not mistake an outage for a missing upload", async () => {
    const storage = fakeStorage({ listError: true });
    await expect(storageSnapshotStore(storage.client).exists(KEY)).rejects.toThrow("list failed");
  });

  it("signs a download link for the key with the requested lifetime", async () => {
    const storage = fakeStorage();
    const url = await storageSnapshotStore(storage.client).downloadUrl(KEY, 3600);
    expect(url).toContain(KEY);
    expect(storage.calls).toEqual([{ method: "createSignedUrl", args: [KEY, 3600] }]);
  });

  it("throws when a download link cannot be signed", async () => {
    const storage = fakeStorage({ signError: true });
    await expect(storageSnapshotStore(storage.client).downloadUrl(KEY, 3600)).rejects.toThrow("snapshot download link failed");
  });
});

describe("createSeedUpload", () => {
  it("signs an upsert upload link for the key under the workspace and session", async () => {
    const storage = fakeStorage();
    const upload = await createSeedUpload(storage.client, WS, SESSION);
    expect(upload).toEqual({ storageKey: KEY, signedUrl: expect.stringContaining(KEY) });
    expect(storage.calls).toEqual([{ method: "createSignedUploadUrl", args: [KEY, { upsert: true }] }]);
  });

  it("throws when the upload link cannot be signed", async () => {
    const storage = fakeStorage({ uploadError: true });
    await expect(createSeedUpload(storage.client, WS, SESSION)).rejects.toThrow("snapshot upload link failed");
  });
});

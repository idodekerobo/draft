import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mintRoutineSessionUpload, RAW_BUCKET } from "../../routines/session-upload";
import { fakeClient, fakeDb } from "./fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

/** A storage client whose signed upload links name their object, so a test can see which path was signed. */
function storageClient(failing: string[] = []): { client: SupabaseClient; signed: string[] } {
  const signed: string[] = [];
  const base = fakeClient(fakeDb({ errors: [] }));
  const client = {
    ...base,
    from: base.from,
    rpc: base.rpc,
    storage: {
      from: (bucket: string) => ({
        createSignedUploadUrl: async (path: string, options: { upsert?: boolean }) => {
          expect(bucket).toBe(RAW_BUCKET);
          expect(options).toEqual({ upsert: true });
          if (failing.some((name) => path.endsWith(name))) return { data: null, error: { message: "storage 503" } };
          signed.push(path);
          return { data: { signedUrl: `https://project.supabase.co/upload/${path}?token=t` }, error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;
  return { client, signed };
}

describe("mintRoutineSessionUpload", () => {
  it("signs an upload for the session file and the metadata, under the run's session folder", async () => {
    const { client, signed } = storageClient();

    const upload = await mintRoutineSessionUpload(client, WS, SESSION);

    expect(signed).toEqual([`${WS}/${SESSION}/root.jsonl.gz`, `${WS}/${SESSION}/metadata.json`]);
    expect(upload).toEqual({
      fileUrl: `https://project.supabase.co/upload/${WS}/${SESSION}/root.jsonl.gz?token=t`,
      metadataUrl: `https://project.supabase.co/upload/${WS}/${SESSION}/metadata.json?token=t`,
    });
  });

  it("returns null and records the failure when a link cannot be made, so the run goes on without a file", async () => {
    const db = fakeDb({ errors: [] });
    const { client } = storageClient(["metadata.json"]);
    const withErrors = { ...client, from: fakeClient(db).from } as unknown as SupabaseClient;

    expect(await mintRoutineSessionUpload(withErrors, WS, SESSION)).toBeNull();
    expect(db.tables.errors).toHaveLength(1);
    expect(db.tables.errors![0]).toMatchObject({ workspace_id: WS, session_id: SESSION });
    expect((db.tables.errors![0]!.detail_json as { code?: string }).code).toBe("session_upload_link_failed");
  });
});

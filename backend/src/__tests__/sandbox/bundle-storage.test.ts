import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BUNDLE_SIGNED_URL_TTL_SECONDS,
  BUNDLE_STORAGE_BUCKET,
  uploadRunBundle,
} from "../../sandbox/bundle-storage";

function fakeClient(overrides: {
  uploadError?: { message: string; name?: string; status?: number };
  /** Errors for the first uploads, one each. The upload works after them. */
  uploadErrors?: Array<{ message: string; name?: string; status?: number }>;
  signError?: { message: string };
  signedUrl?: string;
} = {}): {
  client: SupabaseClient;
  calls: { objectKey?: string; body?: unknown; options?: unknown; uploads: number };
} {
  const calls: { objectKey?: string; body?: unknown; options?: unknown; uploads: number } = { uploads: 0 };
  const queued = [...(overrides.uploadErrors ?? [])];
  const client = {
    storage: {
      from: (bucket: string) => {
        expect(bucket).toBe(BUNDLE_STORAGE_BUCKET);
        return {
          upload: async (objectKey: string, body: unknown, options: unknown) => {
            calls.objectKey = objectKey;
            calls.body = body;
            calls.options = options;
            calls.uploads += 1;
            return { error: queued.shift() ?? overrides.uploadError ?? null };
          },
          createSignedUrl: async () => {
            if (overrides.signError) return { data: null, error: overrides.signError };
            return {
              data: { signedUrl: overrides.signedUrl ?? "https://storage.example.test/signed" },
              error: null,
            };
          },
        };
      },
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe("uploadRunBundle", () => {
  it("uploads the bundle JSON to the run's object key and returns a signed URL", async () => {
    const { client, calls } = fakeClient({ signedUrl: "https://storage.example.test/abc" });
    const result = await uploadRunBundle(
      {
        organizationId: "org-1",
        workspaceId: "workspace-1",
        runId: "run-1",
        files: { "input/prompt.md": "hello" },
      },
      client,
    );

    expect(calls.objectKey).toBe("sandbox_uploads/org-1/workspace-1/run-1.json");
    expect(calls.body).toBe(JSON.stringify({ files: { "input/prompt.md": "hello" } }));
    expect(calls.options).toEqual({ contentType: "application/json", upsert: true });
    expect(result).toEqual({
      signedUrl: "https://storage.example.test/abc",
      objectKey: "sandbox_uploads/org-1/workspace-1/run-1.json",
    });
  });

  it("throws a distinct error when upload fails", async () => {
    const { client } = fakeClient({ uploadError: { message: "disk full" } });
    await expect(
      uploadRunBundle(
        { organizationId: "org-1", workspaceId: "workspace-1", runId: "run-1", files: {} },
        client,
      ),
    ).rejects.toThrow("bundle upload failed: disk full");
  });

  it("tries once more after a storage server error, then goes on", async () => {
    const { client, calls } = fakeClient({ uploadErrors: [{ message: "Internal Server Error", status: 500 }] });
    const result = await uploadRunBundle(
      { organizationId: "org-1", workspaceId: "workspace-1", runId: "run-1", files: {} },
      client,
      0,
    );
    expect(calls.uploads).toBe(2);
    expect(result.signedUrl).toBe("https://storage.example.test/signed");
  });

  it("tries once more after a lost connection", async () => {
    const { client, calls } = fakeClient({ uploadErrors: [{ message: "fetch failed", name: "StorageUnknownError" }] });
    await uploadRunBundle({ organizationId: "org-1", workspaceId: "workspace-1", runId: "run-1", files: {} }, client, 0);
    expect(calls.uploads).toBe(2);
  });

  it("gives up after the second failure", async () => {
    const { client, calls } = fakeClient({ uploadError: { message: "Internal Server Error", status: 500 } });
    await expect(
      uploadRunBundle({ organizationId: "org-1", workspaceId: "workspace-1", runId: "run-1", files: {} }, client, 0),
    ).rejects.toThrow("bundle upload failed: Internal Server Error");
    expect(calls.uploads).toBe(2);
  });

  it("does not repeat a request that the server rejected", async () => {
    const { client, calls } = fakeClient({ uploadError: { message: "Payload too large", status: 413 } });
    await expect(
      uploadRunBundle({ organizationId: "org-1", workspaceId: "workspace-1", runId: "run-1", files: {} }, client, 0),
    ).rejects.toThrow("bundle upload failed: Payload too large");
    expect(calls.uploads).toBe(1);
  });

  it("throws a distinct error when signed URL generation fails", async () => {
    const { client } = fakeClient({ signError: { message: "not found" } });
    await expect(
      uploadRunBundle(
        { organizationId: "org-1", workspaceId: "workspace-1", runId: "run-1", files: {} },
        client,
      ),
    ).rejects.toThrow("bundle signed URL generation failed: not found");
  });

  it("uses a 10-minute signed URL TTL", () => {
    expect(BUNDLE_SIGNED_URL_TTL_SECONDS).toBe(600);
  });
});

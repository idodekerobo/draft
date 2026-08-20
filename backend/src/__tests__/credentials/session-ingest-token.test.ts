import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mintSessionIngestToken, resolveWorkspaceFromIngestToken } from "../../credentials/session-ingest-token";

const workspaceId = "55555555-5555-4555-8555-555555555555";

beforeAll(() => {
  process.env.INFERENCE_CREDENTIAL_KEK_V1 = randomBytes(32).toString("base64");
});

interface FakeRow {
  id: string;
  workspace_id: string;
  provider: string;
  label: string | null;
  encrypted_payload: unknown;
  encryption_key_version: string;
  status: string;
  expires_at: string | null;
  last_used_at: string | null;
}

function createFakeClient() {
  const rows: FakeRow[] = [];
  let nextId = 0;

  function from(table: string) {
    if (table !== "credentials") throw new Error(`Unexpected table: ${table}`);

    return {
      insert(payload: Partial<FakeRow>) {
        const row: FakeRow = {
          id: `cred-${++nextId}`,
          workspace_id: payload.workspace_id!,
          provider: payload.provider!,
          label: payload.label ?? null,
          encrypted_payload: payload.encrypted_payload,
          encryption_key_version: payload.encryption_key_version!,
          status: payload.status ?? "active",
          expires_at: null,
          last_used_at: null,
        };
        rows.push(row);
        return {
          select: () => ({
            single: async () => ({ data: { id: row.id }, error: null }),
          }),
        };
      },
      select() {
        const filters: Record<string, unknown> = {};
        const builder = {
          eq(column: string, value: unknown) {
            filters[column] = value;
            return builder;
          },
          async maybeSingle() {
            const found = rows.find((row) =>
              Object.entries(filters).every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value),
            );
            return { data: found ?? null, error: null };
          },
        };
        return builder;
      },
      update(payload: Partial<FakeRow>) {
        const builder = {
          eq(_column: string, value: unknown) {
            const row = rows.find((r) => r.id === value);
            if (row) Object.assign(row, payload);
            return Promise.resolve({ data: null, error: null });
          },
        };
        return builder;
      },
    };
  }

  return { client: { from } as unknown as SupabaseClient, rows };
}

describe("mintSessionIngestToken / resolveWorkspaceFromIngestToken", () => {
  let fake: ReturnType<typeof createFakeClient>;

  beforeEach(() => {
    fake = createFakeClient();
  });

  it("round-trips: a minted token resolves back to its workspace", async () => {
    const minted = await mintSessionIngestToken(fake.client, workspaceId, "my-repo");
    expect(minted.token.startsWith("draft_sit_")).toBe(true);
    expect(fake.rows[0]?.provider).toBe("claude_session_ingest");
    expect(fake.rows[0]?.label).toBe("my-repo");

    const resolved = await resolveWorkspaceFromIngestToken(fake.client, minted.token);
    expect(resolved).toBe(workspaceId);
    expect(fake.rows[0]?.last_used_at).not.toBeNull();
  });

  it("rejects a tampered secret", async () => {
    const minted = await mintSessionIngestToken(fake.client, workspaceId, null);
    const tampered = `${minted.token}garbage`;
    expect(await resolveWorkspaceFromIngestToken(fake.client, tampered)).toBeNull();
  });

  it("rejects a token for an unknown credential id", async () => {
    await mintSessionIngestToken(fake.client, workspaceId, null);
    expect(
      await resolveWorkspaceFromIngestToken(fake.client, "draft_sit_nonexistent_secretvalue"),
    ).toBeNull();
  });

  it("rejects a revoked token", async () => {
    const minted = await mintSessionIngestToken(fake.client, workspaceId, null);
    fake.rows[0]!.status = "revoked";
    expect(await resolveWorkspaceFromIngestToken(fake.client, minted.token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const minted = await mintSessionIngestToken(fake.client, workspaceId, null);
    fake.rows[0]!.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await resolveWorkspaceFromIngestToken(fake.client, minted.token)).toBeNull();
  });

  it("rejects a malformed token without throwing", async () => {
    expect(await resolveWorkspaceFromIngestToken(fake.client, "not-a-token")).toBeNull();
    expect(await resolveWorkspaceFromIngestToken(fake.client, "draft_sit_")).toBeNull();
    expect(await resolveWorkspaceFromIngestToken(fake.client, "")).toBeNull();
  });
});

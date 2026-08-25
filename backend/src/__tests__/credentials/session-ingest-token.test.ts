import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  adminRevokeCredential,
  mintSessionIngestToken,
  resolveIngestCredentialScope,
  revokeSessionIngestTokenWithGrace,
  rotateSessionIngestToken,
} from "../../credentials/session-ingest-token";

const workspaceId = "55555555-5555-4555-8555-555555555555";
const otherWorkspaceId = "66666666-6666-4666-8666-666666666666";
const sessionProjectId = "77777777-7777-4777-8777-777777777777";

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
  session_project_id: string | null;
  allowed_providers: string[] | null;
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
          session_project_id: payload.session_project_id ?? null,
          allowed_providers: payload.allowed_providers ?? null,
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
        const inFilters: Record<string, unknown[]> = {};
        const builder = {
          eq(column: string, value: unknown) {
            filters[column] = value;
            return builder;
          },
          in(column: string, values: unknown[]) {
            inFilters[column] = values;
            return builder;
          },
          async maybeSingle() {
            const found = rows.find(
              (row) =>
                Object.entries(filters).every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value) &&
                Object.entries(inFilters).every(([key, values]) => values.includes((row as unknown as Record<string, unknown>)[key])),
            );
            return { data: found ?? null, error: null };
          },
        };
        return builder;
      },
      update(payload: Partial<FakeRow>) {
        const filters: Record<string, unknown> = {};
        const inFilters: Record<string, unknown[]> = {};
        const builder = {
          eq(column: string, value: unknown) {
            filters[column] = value;
            return builder;
          },
          in(column: string, values: unknown[]) {
            inFilters[column] = values;
            return builder;
          },
          select() {
            const found = rows.find(
              (row) =>
                Object.entries(filters).every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value) &&
                Object.entries(inFilters).every(([key, values]) => values.includes((row as unknown as Record<string, unknown>)[key])),
            );
            if (found) Object.assign(found, payload);
            return { maybeSingle: async () => ({ data: found ? { id: found.id } : null, error: null }) };
          },
          then(resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) {
            const found = rows.find(
              (row) =>
                Object.entries(filters).every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value) &&
                Object.entries(inFilters).every(([key, values]) => values.includes((row as unknown as Record<string, unknown>)[key])),
            );
            if (found) Object.assign(found, payload);
            return Promise.resolve({ data: null, error: null }).then(resolve, reject);
          },
        };
        return builder;
      },
    };
  }

  return { client: { from } as unknown as SupabaseClient, rows };
}

describe("mintSessionIngestToken / resolveIngestCredentialScope", () => {
  let fake: ReturnType<typeof createFakeClient>;

  beforeEach(() => {
    fake = createFakeClient();
  });

  it("round-trips: a minted scoped token resolves back to its scope", async () => {
    const minted = await mintSessionIngestToken(fake.client, {
      workspaceId,
      label: "my-repo",
      sessionProjectId,
      allowedProviders: ["claude-code"],
    });
    expect(minted.token.startsWith("draft_sit_")).toBe(true);
    expect(fake.rows[0]?.provider).toBe("agent_session_ingest");
    expect(fake.rows[0]?.label).toBe("my-repo");

    const resolved = await resolveIngestCredentialScope(fake.client, minted.token);
    expect(resolved?.workspaceId).toBe(workspaceId);
    expect(resolved?.sessionProjectId).toBe(sessionProjectId);
    expect(resolved?.allowedProviders).toEqual(["claude-code"]);
    expect(fake.rows[0]?.last_used_at).not.toBeNull();
  });

  it("a token minted for project A does not resolve project B's scope", async () => {
    const otherProjectId = "88888888-8888-4888-8888-888888888888";
    const minted = await mintSessionIngestToken(fake.client, {
      workspaceId,
      label: null,
      sessionProjectId,
      allowedProviders: ["claude-code"],
    });
    const resolved = await resolveIngestCredentialScope(fake.client, minted.token);
    expect(resolved?.sessionProjectId).not.toBe(otherProjectId);
  });

  it("rejects a tampered secret", async () => {
    const minted = await mintSessionIngestToken(fake.client, {
      workspaceId,
      label: null,
      sessionProjectId,
      allowedProviders: ["claude-code"],
    });
    const tampered = `${minted.token}garbage`;
    expect(await resolveIngestCredentialScope(fake.client, tampered)).toBeNull();
  });

  it("rejects a token for an unknown credential id", async () => {
    await mintSessionIngestToken(fake.client, { workspaceId, label: null, sessionProjectId, allowedProviders: ["claude-code"] });
    expect(await resolveIngestCredentialScope(fake.client, "draft_sit_nonexistent_secretvalue")).toBeNull();
  });

  it("rejects a revoked token", async () => {
    const minted = await mintSessionIngestToken(fake.client, { workspaceId, label: null, sessionProjectId, allowedProviders: ["claude-code"] });
    fake.rows[0]!.status = "revoked";
    expect(await resolveIngestCredentialScope(fake.client, minted.token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const minted = await mintSessionIngestToken(fake.client, { workspaceId, label: null, sessionProjectId, allowedProviders: ["claude-code"] });
    fake.rows[0]!.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await resolveIngestCredentialScope(fake.client, minted.token)).toBeNull();
  });

  it("rejects a malformed token without throwing", async () => {
    expect(await resolveIngestCredentialScope(fake.client, "not-a-token")).toBeNull();
    expect(await resolveIngestCredentialScope(fake.client, "draft_sit_")).toBeNull();
    expect(await resolveIngestCredentialScope(fake.client, "")).toBeNull();
  });

  it("a legacy-shaped row (no session_project_id) resolves with null project scope", async () => {
    // Simulate a pre-P0 credential inserted without project scope.
    const minted = await mintSessionIngestToken(fake.client, { workspaceId, label: null, sessionProjectId, allowedProviders: ["claude-code"] });
    fake.rows[0]!.session_project_id = null;
    fake.rows[0]!.allowed_providers = null;
    fake.rows[0]!.provider = "claude_session_ingest";
    const resolved = await resolveIngestCredentialScope(fake.client, minted.token);
    expect(resolved?.sessionProjectId).toBeNull();
    expect(resolved?.allowedProviders).toBeNull();
  });
});

describe("rotateSessionIngestToken", () => {
  let fake: ReturnType<typeof createFakeClient>;

  beforeEach(() => {
    fake = createFakeClient();
  });

  it("mints a new credential with the same scope and grace-windows the old one", async () => {
    const minted = await mintSessionIngestToken(fake.client, { workspaceId, label: null, sessionProjectId, allowedProviders: ["claude-code"] });
    const rotated = await rotateSessionIngestToken(fake.client, minted.token);
    expect(rotated).not.toBeNull();
    expect(rotated!.token).not.toBe(minted.token);

    const oldRow = fake.rows.find((r) => r.id === fake.rows[0]!.id)!;
    expect(oldRow.status).toBe("active");
    expect(oldRow.expires_at).not.toBeNull();
    expect(new Date(oldRow.expires_at!).getTime()).toBeGreaterThan(Date.now());

    // Old token still resolves within the grace window.
    expect(await resolveIngestCredentialScope(fake.client, minted.token)).not.toBeNull();
    // New token resolves too.
    expect(await resolveIngestCredentialScope(fake.client, rotated!.token)).not.toBeNull();
  });

  it("old token 401s once expires_at has elapsed — no separate status check", async () => {
    const minted = await mintSessionIngestToken(fake.client, { workspaceId, label: null, sessionProjectId, allowedProviders: ["claude-code"] });
    await rotateSessionIngestToken(fake.client, minted.token);
    fake.rows[0]!.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(fake.rows[0]!.status).toBe("active");
    expect(await resolveIngestCredentialScope(fake.client, minted.token)).toBeNull();
  });

  it("returns null for an already-invalid presented token", async () => {
    expect(await rotateSessionIngestToken(fake.client, "draft_sit_bad_secret")).toBeNull();
  });
});

describe("revokeSessionIngestTokenWithGrace (disable)", () => {
  it("grace-windows the credential rather than an immediate hard revoke", async () => {
    const fake = createFakeClient();
    const minted = await mintSessionIngestToken(fake.client, { workspaceId, label: null, sessionProjectId, allowedProviders: ["claude-code"] });
    const ok = await revokeSessionIngestTokenWithGrace(fake.client, minted.token);
    expect(ok).toBe(true);
    expect(fake.rows[0]!.status).toBe("active");
    expect(fake.rows[0]!.expires_at).not.toBeNull();
    expect(await resolveIngestCredentialScope(fake.client, minted.token)).not.toBeNull();
  });
});

describe("adminRevokeCredential", () => {
  it("hard-revokes by id without needing the credential itself", async () => {
    const fake = createFakeClient();
    const minted = await mintSessionIngestToken(fake.client, { workspaceId, label: null, sessionProjectId, allowedProviders: ["claude-code"] });
    const credentialId = fake.rows[0]!.id;
    const ok = await adminRevokeCredential(fake.client, workspaceId, credentialId);
    expect(ok).toBe(true);
    expect(fake.rows[0]!.status).toBe("revoked");
    expect(await resolveIngestCredentialScope(fake.client, minted.token)).toBeNull();
  });

  it("refuses to revoke a credential in a different workspace", async () => {
    const fake = createFakeClient();
    await mintSessionIngestToken(fake.client, { workspaceId, label: null, sessionProjectId, allowedProviders: ["claude-code"] });
    const credentialId = fake.rows[0]!.id;
    const ok = await adminRevokeCredential(fake.client, otherWorkspaceId, credentialId);
    expect(ok).toBe(false);
    expect(fake.rows[0]!.status).toBe("active");
  });
});

import { describe, expect, it, mock } from "bun:test";

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://supabase.example.test";
process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "publishable-key";
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "service-key";
process.env.INFERENCE_CREDENTIAL_KEK_V1 = Buffer.alloc(32, 7).toString("base64");
process.env.INFERENCE_CREDENTIAL_KEK_V2 ??= Buffer.alloc(32, 7).toString("base64");

const { encryptCredentialPayload, CURRENT_CREDENTIAL_KEY_VERSION } = await import("../../credentials/crypto");
const { releaseGoogleCredential } = await import("../../ingestion/google/release-credential");
const { createFakeDb } = await import("./fake-db");

function setup(extraConnections: Array<Record<string, unknown>> = []) {
  return createFakeDb({
    connections: [
      { id: "conn-1", workspace_id: "ws-1", provider: "gmail", credential_id: "cred-1", status: "revoked" },
      ...extraConnections,
    ],
    credentials: [
      {
        id: "cred-1",
        workspace_id: "ws-1",
        provider: "google",
        status: "active",
        encrypted_payload: encryptCredentialPayload(JSON.stringify({ refresh_token: "refresh-1", scopes: [] }), CURRENT_CREDENTIAL_KEY_VERSION),
        encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION,
      },
    ],
  });
}

const base = { workspaceId: "ws-1", connectionId: "conn-1" };

describe("releaseGoogleCredential", () => {
  it("revokes the token at Google and marks the credential revoked", async () => {
    const db = setup();
    const revokeToken = mock(async () => {});

    await releaseGoogleCredential({ ...base, client: db.client, revokeToken });

    expect(revokeToken).toHaveBeenCalledWith("refresh-1");
    expect(db.tables.credentials![0]!.status).toBe("revoked");
  });

  it("still marks the credential revoked when Google's revoke fails", async () => {
    const db = setup();
    const revokeToken = mock(async () => {
      throw new Error("google down");
    });

    await releaseGoogleCredential({ ...base, client: db.client, revokeToken });

    expect(revokeToken).toHaveBeenCalledTimes(1);
    expect(db.tables.credentials![0]!.status).toBe("revoked");
  });

  it("keeps the grant when another live connection shares the credential", async () => {
    const db = setup([{ id: "conn-2", workspace_id: "ws-1", provider: "gmail", credential_id: "cred-1", status: "active" }]);
    const revokeToken = mock(async () => {});

    await releaseGoogleCredential({ ...base, client: db.client, revokeToken });

    expect(revokeToken).not.toHaveBeenCalled();
    expect(db.tables.credentials![0]!.status).toBe("active");
  });
});

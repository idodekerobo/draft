import { describe, expect, it } from "bun:test";

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://supabase.example.test";
process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "publishable-key";
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "service-key";
process.env.INFERENCE_CREDENTIAL_KEK_V1 ??= Buffer.alloc(32, 7).toString("base64");
process.env.INFERENCE_CREDENTIAL_KEK_V2 ??= Buffer.alloc(32, 7).toString("base64");

const { encryptCredentialPayload, CURRENT_CREDENTIAL_KEY_VERSION } = await import("../../credentials/crypto");
const { gmailAccessFor } = await import("../../ingestion/gmail/access");
const { fakeClient, fakeDb } = await import("../routines/fake-client");

const settings = { clientId: "c", clientSecret: "s", redirectUri: "https://api.test/cb" };
const now = () => new Date("2026-11-19T12:00:00.000Z");

function seed(status = "active", connectedBy = "user-1") {
  return fakeDb({
    connections: [
      { id: "conn-1", workspace_id: "ws-1", provider: "gmail", connected_by_user_id: connectedBy, credential_id: "cred-1", status, last_error_at: null },
    ],
    credentials: [
      {
        id: "cred-1",
        workspace_id: "ws-1",
        provider: "google",
        status: "active",
        expires_at: null,
        encrypted_payload: encryptCredentialPayload(JSON.stringify({ refresh_token: "refresh-1", scopes: [] }), CURRENT_CREDENTIAL_KEY_VERSION),
        encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION,
      },
    ],
    errors: [],
  });
}

const tokenFetch = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("gmailAccessFor", () => {
  it("says to connect Google when the user has no Gmail connection, even if a teammate does", async () => {
    const db = seed("active", "user-2");
    const access = await gmailAccessFor(fakeClient(db), "ws-1", "user-1", { settings: () => settings, fetchImpl: tokenFetch(200, {}) });
    expect(access).toEqual({
      ok: false,
      code: "google_not_connected",
      message: "Connect Google to let your agent read your Gmail: draft connections connect --provider google",
    });
  });

  it("marks the connection degraded and asks to reconnect on invalid_grant", async () => {
    const db = seed();
    const access = await gmailAccessFor(fakeClient(db), "ws-1", "user-1", {
      settings: () => settings,
      fetchImpl: tokenFetch(400, { error: "invalid_grant" }),
      now,
    });
    expect(access).toMatchObject({ ok: false, code: "google_reconnect_required", message: "Reconnect Google" });
    expect(db.tables.connections![0]).toMatchObject({ status: "degraded", last_error_at: "2026-11-19T12:00:00.000Z" });
    expect(db.tables.errors).toEqual([expect.objectContaining({ workspace_id: "ws-1", connection_id: "conn-1", operation: "auth", detail_json: expect.objectContaining({ code: "gmail_access_degraded", reason: "invalid_grant" }) })]);

    await gmailAccessFor(fakeClient(db), "ws-1", "user-1", { settings: () => settings, fetchImpl: tokenFetch(400, { error: "invalid_grant" }), now });
    expect(db.tables.errors).toHaveLength(1);
  });

  it("returns a client and sets a degraded connection back to active when the refresh works", async () => {
    const db = seed("degraded");
    const access = await gmailAccessFor(fakeClient(db), "ws-1", "user-1", {
      settings: () => settings,
      fetchImpl: tokenFetch(200, { access_token: "a", expires_in: 3600 }),
      now,
    });
    expect(access.ok).toBe(true);
    expect(db.tables.connections![0]!.status).toBe("active");
  });

  it("does not store the access token", async () => {
    const db = seed();
    await gmailAccessFor(fakeClient(db), "ws-1", "user-1", { settings: () => settings, fetchImpl: tokenFetch(200, { access_token: "secret-access" }) });
    expect(JSON.stringify(db.tables)).not.toContain("secret-access");
  });
});

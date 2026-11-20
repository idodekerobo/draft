import { beforeEach, describe, expect, it, mock } from "bun:test";

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://supabase.example.test";
process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "publishable-key";
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "service-key";
process.env.GITHUB_APP_ID = process.env.GITHUB_APP_ID ?? "123456";
process.env.GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG ?? "draft-test";
process.env.GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY ?? "key";
process.env.GITHUB_APP_WEBHOOK_SECRET = process.env.GITHUB_APP_WEBHOOK_SECRET ?? "secret";
process.env.INFERENCE_CREDENTIAL_KEK_V1 = Buffer.alloc(32, 7).toString("base64");
process.env.INFERENCE_CREDENTIAL_KEK_V2 ??= Buffer.alloc(32, 7).toString("base64");

const { handleGoogleCallback } = await import("../../routes/google-callback");
const { createGoogleOAuthSession, getGoogleOAuthSession, resetGoogleOAuthSessionStore } = await import(
  "../../auth/google-oauth-state-store"
);
const { DRIVE_READONLY_SCOPE, GMAIL_READONLY_SCOPE, GoogleOAuthError } = await import("../../ingestion/google/oauth");
const { decryptCredentialPayload } = await import("../../credentials/crypto");
const { createFakeDb } = await import("./fake-db");

const settings = { clientId: "client-1", clientSecret: "secret", redirectUri: "https://api.test/cb" };

function tokens(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: "a",
    refreshToken: "refresh-1",
    idToken: "id-token",
    scopes: ["openid", "email", GMAIL_READONLY_SCOPE],
    expiresInSeconds: 3600,
    ...overrides,
  };
}

function makeDeps(db: ReturnType<typeof createFakeDb>, overrides: Record<string, unknown> = {}) {
  return {
    settings: () => settings,
    exchangeCode: mock(async () => tokens()) as never,
    verifyIdToken: mock(async () => ({ sub: "sub-1", email: "me@company.com" })) as never,
    // Not the real helper: other test files replace that module for the whole run.
    upsertConnection: (async (client: any, input: Record<string, unknown>) => {
      const { data } = await client
        .from("connections")
        .upsert(input, { onConflict: "workspace_id,provider,connection_key" })
        .select()
        .single();
      return data;
    }) as never,
    registerDriveSyncTask: mock(async () => {}) as never,
    db: db.client,
    ...overrides,
  };
}

const request = (state: string | null, extra = "code=abc") =>
  new Request(`https://api.test/workspaces/google/callback?${state ? `state=${state}&` : ""}${extra}`);

describe("handleGoogleCallback", () => {
  beforeEach(() => resetGoogleOAuthSessionStore());

  it("rejects a callback with no state", async () => {
    const response = await handleGoogleCallback(request(null), makeDeps(createFakeDb()));
    expect(response.status).toBe(400);
  });

  it("ignores unknown or already-used state", async () => {
    const db = createFakeDb();
    const deps = makeDeps(db);
    const response = await handleGoogleCallback(request("missing"), deps);
    expect(await response.text()).toContain("expired");
    expect(deps.exchangeCode).not.toHaveBeenCalled();
  });

  it("connects a mailbox: encrypted google credential, connection keyed by sub", async () => {
    const db = createFakeDb();
    const deps = makeDeps(db);
    const state = createGoogleOAuthSession("ws-1", "user-1", "verifier-1");

    const response = await handleGoogleCallback(request(state), deps);

    expect(await response.text()).toContain("Gmail connected");
    expect(getGoogleOAuthSession(state).status).toBe("connected");
    expect(deps.exchangeCode).toHaveBeenCalledWith(settings, { code: "abc", codeVerifier: "verifier-1" });

    const credential = db.tables.credentials![0]!;
    expect(credential.provider).toBe("google");
    expect(JSON.parse(decryptCredentialPayload(credential.encrypted_payload, credential.encryption_key_version as string))).toEqual({
      refresh_token: "refresh-1",
      scopes: ["openid", "email", GMAIL_READONLY_SCOPE],
    });

    expect(db.tables.connections![0]).toMatchObject({
      workspace_id: "ws-1",
      provider: "gmail",
      connection_key: "sub-1",
      external_account_id: "sub-1",
      display_name: "me@company.com",
      connected_by_user_id: "user-1",
      status: "active",
      credential_id: credential.id,
    });
  });

  it("reconnecting the same Google account reuses the connection and credential row and refreshes the email", async () => {
    const db = createFakeDb({
      credentials: [{ id: "cred-1", workspace_id: "ws-1", provider: "google", status: "active" }],
      connections: [
        {
          id: "conn-1",
          workspace_id: "ws-1",
          provider: "gmail",
          connection_key: "sub-1",
          credential_id: "cred-1",
          connected_by_user_id: "user-1",
          status: "degraded",
          display_name: "old@company.com",
        },
      ],
    });
    const state = createGoogleOAuthSession("ws-1", "user-1", "v");

    await handleGoogleCallback(request(state), makeDeps(db));

    expect(db.tables.connections).toHaveLength(1);
    expect(db.tables.credentials).toHaveLength(1);
    expect(db.tables.connections![0]).toMatchObject({
      status: "active",
      display_name: "me@company.com",
    });
  });

  it("refuses a mailbox a teammate already connected", async () => {
    const db = createFakeDb({
      connections: [
        { id: "conn-9", workspace_id: "ws-1", provider: "gmail", connection_key: "sub-1", connected_by_user_id: "user-2", status: "active" },
      ],
    });
    const state = createGoogleOAuthSession("ws-1", "user-1", "v");

    await handleGoogleCallback(request(state), makeDeps(db));

    expect(getGoogleOAuthSession(state)).toMatchObject({ status: "error", errorCode: "gmail_mailbox_already_connected" });
    expect(db.tables.credentials).toHaveLength(0);
  });

  it("allows only one mailbox per user", async () => {
    const db = createFakeDb({
      connections: [
        { id: "conn-9", workspace_id: "ws-1", provider: "gmail", connection_key: "sub-other", connected_by_user_id: "user-1", status: "active" },
      ],
    });
    const state = createGoogleOAuthSession("ws-1", "user-1", "v");

    await handleGoogleCallback(request(state), makeDeps(db));

    expect(getGoogleOAuthSession(state)).toMatchObject({ status: "error", errorCode: "gmail_already_connected" });
  });

  it("fails when the user did not grant Gmail", async () => {
    const db = createFakeDb();
    const state = createGoogleOAuthSession("ws-1", "user-1", "v");
    const deps = makeDeps(db, { exchangeCode: mock(async () => tokens({ scopes: ["openid", "email"] })) });

    await handleGoogleCallback(request(state), deps);

    expect(getGoogleOAuthSession(state)).toMatchObject({ status: "error", errorCode: "google_scope_missing" });
    expect(db.tables.connections).toHaveLength(0);
  });

  it("connects Google Drive alone and registers its sync task", async () => {
    const db = createFakeDb();
    const state = createGoogleOAuthSession("ws-1", "user-1", "v");
    const deps = makeDeps(db, { exchangeCode: mock(async () => tokens({ scopes: ["openid", "email", DRIVE_READONLY_SCOPE] })) });

    const response = await handleGoogleCallback(request(state), deps);

    expect(await response.text()).toContain("Google Drive connected");
    expect(db.tables.connections!.map((row) => row.provider)).toEqual(["google_drive"]);
    expect(deps.registerDriveSyncTask).toHaveBeenCalledTimes(1);
    expect((deps.registerDriveSyncTask as any).mock.calls[0][0]).toMatchObject({ workspace_id: "ws-1" });
  });

  it("connects both products on one shared credential", async () => {
    const db = createFakeDb();
    const state = createGoogleOAuthSession("ws-1", "user-1", "v");
    const deps = makeDeps(db, {
      exchangeCode: mock(async () => tokens({ scopes: ["openid", "email", GMAIL_READONLY_SCOPE, DRIVE_READONLY_SCOPE] })),
    });

    const response = await handleGoogleCallback(request(state), deps);

    expect(await response.text()).toContain("Gmail and Google Drive connected");
    expect(db.tables.credentials).toHaveLength(1);
    expect(db.tables.connections!.map((row) => row.provider).sort()).toEqual(["gmail", "google_drive"]);
    expect(new Set(db.tables.connections!.map((row) => row.credential_id))).toEqual(new Set([db.tables.credentials![0]!.id]));
    expect(deps.registerDriveSyncTask).toHaveBeenCalledTimes(1);
  });

  it("adds Google Drive to a Gmail-only person and reuses the credential", async () => {
    const db = createFakeDb({
      credentials: [{ id: "cred-1", workspace_id: "ws-1", provider: "google", status: "active" }],
      connections: [
        { id: "conn-1", workspace_id: "ws-1", provider: "gmail", connection_key: "sub-1", credential_id: "cred-1", connected_by_user_id: "user-1", status: "active" },
      ],
    });
    const state = createGoogleOAuthSession("ws-1", "user-1", "v");
    const deps = makeDeps(db, {
      exchangeCode: mock(async () => tokens({ scopes: ["openid", "email", GMAIL_READONLY_SCOPE, DRIVE_READONLY_SCOPE] })),
    });

    await handleGoogleCallback(request(state), deps);

    expect(getGoogleOAuthSession(state).status).toBe("connected");
    expect(db.tables.credentials).toHaveLength(1);
    expect(db.tables.connections!.find((row) => row.provider === "google_drive")).toMatchObject({ credential_id: "cred-1", status: "active" });
  });

  it("keeps Drive sync progress on reconnect and clears only the reconnect flag", async () => {
    const backfill = { seen: 3, folders: { "f-1": { done: true } } };
    const db = createFakeDb({
      credentials: [{ id: "cred-1", workspace_id: "ws-1", provider: "google", status: "active" }],
      connections: [
        { id: "conn-2", workspace_id: "ws-1", provider: "google_drive", connection_key: "sub-1", credential_id: "cred-1", connected_by_user_id: "user-1", status: "degraded", cursor_json: { start_page_token: "t-9", backfill, reauth_required: true } },
      ],
    });
    const state = createGoogleOAuthSession("ws-1", "user-1", "v");
    await handleGoogleCallback(request(state), makeDeps(db, { exchangeCode: mock(async () => tokens({ scopes: ["openid", "email", DRIVE_READONLY_SCOPE] })) }));

    expect(db.tables.connections!.find((row) => row.provider === "google_drive")).toMatchObject({ status: "active", cursor_json: { start_page_token: "t-9", backfill } });
    expect(db.tables.connections!.find((row) => row.provider === "google_drive")!.cursor_json).not.toHaveProperty("reauth_required");
  });

  it("refuses a Google account a teammate already connected for Drive", async () => {
    const db = createFakeDb({
      connections: [
        { id: "conn-9", workspace_id: "ws-1", provider: "google_drive", connection_key: "sub-1", connected_by_user_id: "user-2", status: "active" },
      ],
    });
    const state = createGoogleOAuthSession("ws-1", "user-1", "v");
    const deps = makeDeps(db, { exchangeCode: mock(async () => tokens({ scopes: ["openid", "email", DRIVE_READONLY_SCOPE] })) });

    await handleGoogleCallback(request(state), deps);

    expect(getGoogleOAuthSession(state)).toMatchObject({ status: "error", errorCode: "drive_account_already_connected" });
    expect(deps.registerDriveSyncTask).not.toHaveBeenCalled();
  });

  it("fails when Google returns no refresh token", async () => {
    const db = createFakeDb();
    const state = createGoogleOAuthSession("ws-1", "user-1", "v");
    const deps = makeDeps(db, { exchangeCode: mock(async () => tokens({ refreshToken: null })) });
    await handleGoogleCallback(request(state), deps);
    expect(getGoogleOAuthSession(state)).toMatchObject({ status: "error", errorCode: "google_no_refresh_token" });
  });

  it("records access denied without exchanging a code", async () => {
    const db = createFakeDb();
    const deps = makeDeps(db);
    const state = createGoogleOAuthSession("ws-1", "user-1", "v");
    await handleGoogleCallback(request(state, "error=access_denied"), deps);
    expect(getGoogleOAuthSession(state)).toMatchObject({ status: "error", errorCode: "google_access_denied" });
    expect(deps.exchangeCode).not.toHaveBeenCalled();
  });

  it("does not create a connection when id_token verification fails", async () => {
    const db = createFakeDb();
    const state = createGoogleOAuthSession("ws-1", "user-1", "v");
    const deps = makeDeps(db, {
      verifyIdToken: mock(async () => {
        throw new GoogleOAuthError("bad", "invalid_id_token");
      }),
    });
    await handleGoogleCallback(request(state), deps);
    expect(getGoogleOAuthSession(state)).toMatchObject({ status: "error", errorCode: "google_callback_failed" });
    expect(db.tables.connections).toHaveLength(0);
  });
});

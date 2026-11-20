import { beforeEach, describe, expect, it } from "bun:test";

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://supabase.example.test";
process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "publishable-key";
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "service-key";
process.env.GITHUB_APP_ID = process.env.GITHUB_APP_ID ?? "123456";
process.env.GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG ?? "draft-test";
process.env.GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY ?? "key";
process.env.GITHUB_APP_WEBHOOK_SECRET = process.env.GITHUB_APP_WEBHOOK_SECRET ?? "secret";

const { createGoogleConnectSession, pollGoogleConnectSession } = await import("../../routes/google-connect");
const { createGoogleOAuthSession, resetGoogleOAuthSessionStore, resolveGoogleOAuthSession } = await import(
  "../../auth/google-oauth-state-store"
);
const { createFakeDb } = await import("./fake-db");

const settings = { clientId: "client-1", clientSecret: "s", redirectUri: "https://api.test/workspaces/google/callback" };

describe("createGoogleConnectSession", () => {
  beforeEach(() => resetGoogleOAuthSessionStore());

  it("returns 503 when Google OAuth is not configured", async () => {
    const db = createFakeDb();
    const response = await createGoogleConnectSession("ws-1", "user-1", { settings: () => null, db: db.client });
    expect(response.status).toBe(503);
  });

  it("returns an auth URL bound to the caller with the sign-in email as a hint", async () => {
    const db = createFakeDb({ users: [{ id: "user-1", email: "me@gmail.com" }] });
    const response = await createGoogleConnectSession("ws-1", "user-1", { settings: () => settings, db: db.client });
    const body = (await response.json()) as { code: string; authUrl: string };
    const url = new URL(body.authUrl);

    expect(response.status).toBe(200);
    expect(url.searchParams.get("state")).toBe(body.code);
    expect(url.searchParams.get("login_hint")).toBe("me@gmail.com");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(pollGoogleConnectSession("ws-1", "user-1", body.code).status).toBe(200);
  });

  it("refuses a new connect when the user already has both Google products active", async () => {
    const db = createFakeDb({
      connections: [
        { id: "c1", workspace_id: "ws-1", provider: "gmail", connected_by_user_id: "user-1", status: "active" },
        { id: "c2", workspace_id: "ws-1", provider: "google_drive", connected_by_user_id: "user-1", status: "active" },
      ],
    });
    const response = await createGoogleConnectSession("ws-1", "user-1", { settings: () => settings, db: db.client });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "google_already_connected" });
  });

  it("lets a Gmail-only person connect again to add Google Drive", async () => {
    const db = createFakeDb({
      connections: [
        { id: "c1", workspace_id: "ws-1", provider: "gmail", connected_by_user_id: "user-1", status: "active" },
      ],
    });
    const response = await createGoogleConnectSession("ws-1", "user-1", { settings: () => settings, db: db.client });
    expect(response.status).toBe(200);
  });

  it("ignores a teammate's Gmail connection", async () => {
    const db = createFakeDb({
      connections: [
        { id: "c1", workspace_id: "ws-1", provider: "gmail", connected_by_user_id: "user-2", status: "active" },
      ],
    });
    const response = await createGoogleConnectSession("ws-1", "user-1", { settings: () => settings, db: db.client });
    expect(response.status).toBe(200);
  });

  it("lets a degraded connection connect again to fix the grant", async () => {
    const db = createFakeDb({
      connections: [
        { id: "c1", workspace_id: "ws-1", provider: "gmail", connected_by_user_id: "user-1", status: "degraded" },
      ],
    });
    const response = await createGoogleConnectSession("ws-1", "user-1", { settings: () => settings, db: db.client });
    expect(response.status).toBe(200);
  });
});

describe("pollGoogleConnectSession", () => {
  beforeEach(() => resetGoogleOAuthSessionStore());

  it("is scoped to the workspace and the user who started the connect", async () => {
    const state = createGoogleOAuthSession("ws-1", "user-1", "v");
    expect(pollGoogleConnectSession("ws-1", "user-1", state).status).toBe(200);
    expect(pollGoogleConnectSession("ws-2", "user-1", state).status).toBe(403);
    expect(pollGoogleConnectSession("ws-1", "user-2", state).status).toBe(403);
    expect(pollGoogleConnectSession("ws-1", "user-1", "nope").status).toBe(404);
  });

  it("reports the callback outcome", async () => {
    const state = createGoogleOAuthSession("ws-1", "user-1", "v");
    resolveGoogleOAuthSession(state, { status: "error", errorCode: "google_scope_missing", errorMessage: "grant it" });
    expect(await pollGoogleConnectSession("ws-1", "user-1", state).json()).toEqual({
      status: "error",
      errorCode: "google_scope_missing",
      errorMessage: "grant it",
    });
  });
});

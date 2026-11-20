import { describe, expect, it } from "bun:test";
import { completeConnectRequest, createConnectRequest, findConnectRequest, hashConnectToken, listIntegrations } from "../../integrations/service";
import { fakeClient, fakeDb } from "../routines/fake-client";
import { createIntegrationTools } from "../../metaharness/tools/definitions/integrations";

const WS = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-14T12:00:00.000Z");
const deps = { now: NOW, appUrl: "https://app.test" };
const connection = (provider: string, status = "active", by: string | null = ME) => ({ workspace_id: WS, provider, status, connected_by_user_id: by });
const tokenOf = (url: string) => url.split("/connect/")[1]!;

describe("listIntegrations", () => {
  it("gives every provider its state, what it unlocks and how to connect it", async () => {
    const db = fakeDb({ connections: [connection("slack"), connection("linear", "error"), connection("github", "active", OTHER), connection("fireflies", "pending"), connection("granola", "revoked")] });
    const list = await listIntegrations(fakeClient(db), WS, ME);
    const by = (provider: string) => list.find((item) => item.provider === provider)!;
    expect(by("slack")).toMatchObject({ status: "connected", connectedByYou: true });
    expect(by("github")).toMatchObject({ status: "connected", connectedByYou: false });
    expect(by("linear")).toMatchObject({ status: "needs_reconnect", connect: { cli: "draft connections connect --provider linear" } });
    expect(by("granola").status).toBe("not_connected");
    expect(by("fireflies").status).toBe("pending");
    expect(by("claude_session").connect.cli).toBe("draft connections connect --provider claude-code");
    expect(by("linear").triggers.map((trigger) => trigger.event)).toEqual(["linear.issue_created", "linear.issue_completed"]);
  });
});

describe("Google in listIntegrations", () => {
  it("is connected only by the caller's own live gmail connection, and is private to them", async () => {
    const db = fakeDb({ connections: [connection("gmail", "active", OTHER), connection("slack")] });
    const theirs = (await listIntegrations(fakeClient(db), WS, ME)).find((item) => item.provider === "google")!;
    expect(theirs).toMatchObject({ status: "not_connected", destination: "only_you", connect: { cli: "draft connections connect --provider google" } });
    const mine = (await listIntegrations(fakeClient(db), WS, OTHER)).find((item) => item.provider === "google")!;
    expect(mine).toMatchObject({ status: "connected", connectedByYou: true });
    expect((await listIntegrations(fakeClient(db), WS, ME)).find((item) => item.provider === "slack")!.destination).toBe("company_context");
  });

  it("counts the caller's Google Drive row for Google, and lists Google Drive as company context for the workspace", async () => {
    const db = fakeDb({ connections: [connection("google_drive", "active", OTHER)] });
    const forMe = await listIntegrations(fakeClient(db), WS, ME);
    expect(forMe.find((item) => item.provider === "google")!.status).toBe("not_connected");
    expect(forMe.find((item) => item.provider === "google_drive")).toMatchObject({
      status: "connected",
      connectedByYou: false,
      destination: "company_context",
      connect: { cli: "draft connections connect google" },
    });
    const forThem = await listIntegrations(fakeClient(db), WS, OTHER);
    expect(forThem.find((item) => item.provider === "google")!.status).toBe("connected");
    expect(forThem.find((item) => item.provider === "google_drive")!.connectedByYou).toBe(true);
  });

  it("stores a google connect request and closes it once the requester connects Gmail", async () => {
    const db = fakeDb({ connections: [] });
    const result = await createConnectRequest(fakeClient(db), { workspaceId: WS, userId: ME, provider: "google", via: "mcp" }, deps);
    expect(result).toMatchObject({ status: "action_required", action: "connect_google", provider: "google" });
    expect(db.tables.connection_requests![0]!.provider).toBe("google");
    const found = await findConnectRequest(fakeClient(db), tokenOf((result as { url: string }).url), ME, NOW);
    if (!found.ok) throw new Error("expected the request");
    expect(await completeConnectRequest(fakeClient(db), found.request, NOW)).toBe(false);
    db.tables.connections!.push(connection("gmail"));
    expect(await completeConnectRequest(fakeClient(db), found.request, NOW)).toBe(true);
  });
});

describe("Google connect links", () => {
  it("issues a link while the caller lacks Gmail or Google Drive, and reports connected with both", async () => {
    const gmailOnly = fakeDb({ connections: [connection("gmail"), connection("google_drive", "active", OTHER)] });
    expect(await createConnectRequest(fakeClient(gmailOnly), { workspaceId: WS, userId: ME, provider: "google", via: "mcp" }, deps)).toMatchObject({ status: "action_required" });
    const driveOnly = fakeDb({ connections: [connection("google_drive"), connection("gmail", "revoked")] });
    expect(await createConnectRequest(fakeClient(driveOnly), { workspaceId: WS, userId: ME, provider: "google", via: "mcp" }, deps)).toMatchObject({ status: "action_required" });
    const both = fakeDb({ connections: [connection("gmail"), connection("google_drive", "degraded")] });
    expect(await createConnectRequest(fakeClient(both), { workspaceId: WS, userId: ME, provider: "google", via: "mcp" }, deps)).toEqual({ status: "connected", provider: "google" });
  });
});

describe("connect links", () => {
  it("returns a link and stores only the token's hash", async () => {
    const db = fakeDb({ connections: [] });
    const result = await createConnectRequest(fakeClient(db), { workspaceId: WS, userId: ME, provider: "linear", via: "mcp" }, deps);
    expect(result).toMatchObject({ status: "action_required", action: "connect_linear", provider: "linear", expiresAt: "2026-11-14T12:15:00.000Z" });
    const token = tokenOf((result as { url: string }).url);
    const row = db.tables.connection_requests![0]!;
    expect(row.token_hash).toBe(hashConnectToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("makes no link for a provider that is already connected", async () => {
    const db = fakeDb({ connections: [connection("linear")] });
    expect(await createConnectRequest(fakeClient(db), { workspaceId: WS, userId: ME, provider: "linear", via: "cli" }, deps)).toEqual({
      status: "connected",
      provider: "linear",
      message: "Linear is already connected. No link is needed.",
    });
    expect(db.tables.connection_requests ?? []).toHaveLength(0);
  });

  it("says a saved connection is waiting for its first event, and makes no link", async () => {
    const db = fakeDb({ connections: [connection("fireflies", "pending")] });
    const result = await createConnectRequest(fakeClient(db), { workspaceId: WS, userId: ME, provider: "fireflies", via: "mcp" }, deps);
    expect(result).toMatchObject({ status: "pending", provider: "fireflies" });
    expect((result as { message: string }).message).toContain("waiting for its first event");
    expect(db.tables.connection_requests ?? []).toHaveLength(0);
  });

  it("works only for the person who asked, and only until it expires", async () => {
    const db = fakeDb({ connections: [] });
    const { url } = (await createConnectRequest(fakeClient(db), { workspaceId: WS, userId: ME, provider: "linear", via: "mcp" }, deps)) as { url: string };
    const token = tokenOf(url);
    expect((await findConnectRequest(fakeClient(db), token, ME, NOW)).ok).toBe(true);
    expect(await findConnectRequest(fakeClient(db), token, OTHER, NOW)).toEqual({ ok: false, error: "expired_or_unknown" });
    expect(await findConnectRequest(fakeClient(db), token, ME, new Date("2026-11-14T12:16:00.000Z"))).toEqual({ ok: false, error: "expired_or_unknown" });
    expect(await findConnectRequest(fakeClient(db), "not-a-token", ME, NOW)).toEqual({ ok: false, error: "expired_or_unknown" });
  });

  it("closes only once the provider is connected, and can't be used again", async () => {
    const db = fakeDb({ connections: [] });
    const { url } = (await createConnectRequest(fakeClient(db), { workspaceId: WS, userId: ME, provider: "granola", via: "mcp" }, deps)) as { url: string };
    const found = await findConnectRequest(fakeClient(db), tokenOf(url), ME, NOW);
    if (!found.ok) throw new Error("expected the request");
    expect(await completeConnectRequest(fakeClient(db), found.request, NOW)).toBe(false);
    db.tables.connections!.push(connection("granola"));
    expect(await completeConnectRequest(fakeClient(db), found.request, NOW)).toBe(true);
    expect(await findConnectRequest(fakeClient(db), tokenOf(url), ME, NOW)).toEqual({ ok: false, error: "already_used" });
  });

  it("stops handing out links after ten open ones", async () => {
    const db = fakeDb({ connections: [] });
    for (let index = 0; index < 10; index++) await createConnectRequest(fakeClient(db), { workspaceId: WS, userId: ME, provider: "linear", via: "mcp" }, deps);
    expect(await createConnectRequest(fakeClient(db), { workspaceId: WS, userId: ME, provider: "linear", via: "mcp" }, deps)).toEqual({ status: "too_many_requests" });
  });

  it("connections.connect accepts google", () => {
    const connect = createIntegrationTools(fakeClient(fakeDb()))[1]!;
    expect(connect.parse({ provider: "google" }).ok).toBe(true);
    expect(connect.parse({ provider: "gmail" }).ok).toBe(false);
  });
});

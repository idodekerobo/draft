import { describe, expect, it } from "bun:test";
import { completeConnectRequest, createConnectRequest, findConnectRequest, hashConnectToken, listIntegrations } from "../../integrations/service";
import { fakeClient, fakeDb } from "../routines/fake-client";

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
    expect(by("linear")).toMatchObject({ status: "needs_reconnect", connect: { cli: "draft connections connect linear" } });
    expect(by("granola").status).toBe("not_connected");
    expect(by("fireflies").status).toBe("pending");
    expect(by("claude_session").connect.cli).toBe("draft connections connect claude-code");
    expect(by("linear").triggers.map((trigger) => trigger.event)).toEqual(["linear.issue_created", "linear.issue_completed"]);
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
    expect(await createConnectRequest(fakeClient(db), { workspaceId: WS, userId: ME, provider: "linear", via: "cli" }, deps)).toEqual({ status: "connected", provider: "linear" });
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
});

import { SANDBOX_RUN_DIRECTORY, sandboxComputer, sandboxExecution } from "draft-core/run-spec";
import { describe, expect, it } from "bun:test";

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://supabase.example.test";
process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "publishable-key";
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "service-key";
process.env.INFERENCE_CREDENTIAL_KEK_V1 ??= Buffer.alloc(32, 7).toString("base64");
process.env.INFERENCE_CREDENTIAL_KEK_V2 ??= Buffer.alloc(32, 7).toString("base64");

const { parseAgentRunId, parseContextVersionId, parseScheduledTaskId, parseIsoTimestamp, parseUserId, parseWorkspaceId } = await import("draft-core/run-spec");
const { personCaller, runCaller } = await import("draft-core/tools");
const { encryptCredentialPayload, CURRENT_CREDENTIAL_KEY_VERSION } = await import("../../../credentials/crypto");
const { createIntegrationTools } = await import("../../../metaharness/tools/definitions/integrations");
const { personalConnectionProviders, personalConnectionProvidersOrNone } = await import("../../../ingestion/gmail/access");
const { invokeTool } = await import("../../../metaharness/tools/invoke-tool");
const { ToolRegistry } = await import("../../../metaharness/tools/tool-registry");
const { fakeClient, fakeDb } = await import("../../routines/fake-client");
import type { AgentRunSpec } from "draft-core/run-spec";
import type { AnyDraftToolPermission, ToolCaller } from "draft-core/tools";

const WS = "11111111-1111-4111-8111-111111111111";
const RUN = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const TEAMMATE = "55555555-5555-4555-8555-555555555555";
const TASK = "66666666-6666-4666-8666-666666666666";
const settings = { clientId: "c", clientSecret: "s", redirectUri: "https://api.test/cb" };
const GMAIL = ["connections.search", "connections.read"].map((tool) => ({ tool, provider: "gmail" })) as AnyDraftToolPermission[];

const run = (permissions: AnyDraftToolPermission[], onBehalfOf: string | null = OWNER): AgentRunSpec => ({
  id: parseAgentRunId(RUN), kind: "routine",
  workspaceId: parseWorkspaceId(WS),
  trigger: { type: "cron", scheduledTaskId: parseScheduledTaskId(TASK), occurrenceAt: parseIsoTimestamp("2026-11-11T09:00:00.000Z") },
  onBehalfOf: onBehalfOf ? parseUserId(onBehalfOf) : null,
  execution: sandboxExecution("claude-print"), toolset: { nativeTools: [], mcpServers: [], skills: [], instructions: [] }, computer: sandboxComputer("open", SANDBOX_RUN_DIRECTORY),
  harness: "claude", model: null, instructions: "", inputs: { contextVersionId: parseContextVersionId("77777777-7777-4777-8777-777777777777") },
  permissions, output: { type: "text" },
});

const person = (userId: string) => personCaller({ userId: parseUserId(userId), workspaceId: parseWorkspaceId(WS), via: "cli" });

function seed() {
  return fakeDb({
    connections: [{ id: "conn-1", workspace_id: WS, provider: "gmail", connected_by_user_id: OWNER, credential_id: "cred-1", status: "active", last_error_at: null }],
    credentials: [{
      id: "cred-1", workspace_id: WS, provider: "google", status: "active", expires_at: null,
      encrypted_payload: encryptCredentialPayload(JSON.stringify({ refresh_token: "refresh-1", scopes: [] }), CURRENT_CREDENTIAL_KEY_VERSION),
      encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION,
    }],
    source_items: [],
  });
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const message = (id: string, body: string) => ({
  id, threadId: "t-1", internalDate: "1763550000000", snippet: `snippet ${id}`, labelIds: ["INBOX"],
  payload: {
    mimeType: "multipart/mixed",
    headers: [{ name: "From", value: "Ada <ada@example.com>" }, { name: "Subject", value: `Subject ${id}` }],
    parts: [
      { mimeType: "text/plain", body: { data: b64(body) } },
      { mimeType: "application/pdf", filename: "deck.pdf", body: { attachmentId: "att-1", size: 3000 } },
    ],
  },
});

function gmailFetch(options: { token?: { status: number; body: unknown }; urls?: string[] } = {}) {
  const token = options.token ?? { status: 200, body: { access_token: "access", expires_in: 3600 } };
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    options.urls?.push(url.toString());
    if (url.host === "oauth2.googleapis.com") return Response.json(token.body, { status: token.status });
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "m-1" }, { id: "m-2" }], nextPageToken: "page-2" });
    if (url.pathname.includes("/attachments/")) return Response.json({ size: 3000, data: Buffer.alloc(3000, 1).toString("base64url") });
    if (url.pathname.includes("/threads/")) return Response.json({ id: "t-1", messages: [message("m-1", "a".repeat(1500)), message("m-2", "b".repeat(1500))] });
    if (url.pathname.endsWith("/missing")) return Response.json({ error: { code: 404 } }, { status: 404 });
    const id = url.pathname.split("/").pop()!;
    return Response.json(message(id, "x".repeat(2000)));
  }) as unknown as typeof fetch;
}

function setup(fetchFn = gmailFetch()) {
  const db = seed();
  const registry = new ToolRegistry(createIntegrationTools(fakeClient(db), { gmail: { fetch: fetchFn, settings: () => settings } }));
  const audits: Array<{ arguments: unknown }> = [];
  const invoke = (caller: ToolCaller, tool: string, input: unknown) =>
    invokeTool({ registry, audit: async (entry) => { audits.push(entry as never); }, authorizeUser: async () => null }, caller, tool, input);
  return { db, invoke, audits };
}

describe("Gmail tools", () => {
  it("searches the person's own mailbox, adds date terms and redacts the query in the audit", async () => {
    const urls: string[] = [];
    const { db, invoke, audits } = setup(gmailFetch({ urls }));
    const result = await invoke(person(OWNER), "connections.search", { provider: "gmail", query: "from:ada", since: "2026-11-01", until: "2026-11-15", limit: 2 });
    expect(result).toMatchObject({ status: "ok", output: {
      provider: "gmail",
      results: [{ id: "m-1", threadId: "t-1", from: "Ada <ada@example.com>", title: "Subject m-1", snippet: "snippet m-1" }, { id: "m-2" }],
      nextCursor: "page-2",
    } });
    expect(new URL(urls.find((url) => url.endsWith("maxResults=2"))!).searchParams.get("q")).toBe("from:ada after:2026/11/01 before:2026/11/15");
    expect(JSON.stringify(audits)).not.toContain("from:ada");
    expect(audits[0]?.arguments).toMatchObject({ provider: "gmail", query: "[redacted]" });
    expect(db.tables.source_items).toEqual([]);
  });

  it("refuses a member without their own connection even when a teammate is connected", async () => {
    const { invoke } = setup();
    expect(await invoke(person(TEAMMATE), "connections.search", { provider: "gmail", query: "x" })).toMatchObject({ status: "refused", code: "google_not_connected" });
  });

  it("needs a gmail permission on a run, uses the run owner's connection, and refuses a run with no person", async () => {
    const { invoke } = setup();
    const search = { provider: "gmail", query: "x" };
    expect(await invoke(runCaller(run([])), "connections.search", search)).toMatchObject({ status: "denied", code: "not_permitted" });
    expect(await invoke(runCaller(run([{ tool: "connections.search", provider: "slack" }])), "connections.search", search)).toMatchObject({ status: "denied", code: "not_permitted" });
    expect(await invoke(runCaller(run(GMAIL)), "connections.search", search)).toMatchObject({ status: "ok" });
    expect(await invoke(runCaller(run(GMAIL, null)), "connections.search", search)).toMatchObject({ status: "refused", code: "gmail_requires_person" });
  });

  it("asks to reconnect and degrades the connection on invalid_grant", async () => {
    const { db, invoke } = setup(gmailFetch({ token: { status: 400, body: { error: "invalid_grant" } } }));
    expect(await invoke(person(OWNER), "connections.read", { provider: "gmail", messageId: "m-1" })).toMatchObject({ status: "refused", code: "google_reconnect_required" });
    expect(db.tables.connections![0]!.status).toBe("degraded");
  });

  it("pages a thread body with a cursor and refuses both ids", async () => {
    const { invoke } = setup();
    const first = await invoke(person(OWNER), "connections.read", { provider: "gmail", threadId: "t-1", maxBytes: 2000 }) as { status: string; output: { messages: Array<{ id: string; body_text: string }>; truncated: boolean; nextCursor: string } };
    expect(first.output.truncated).toBe(true);
    expect(first.output.messages.map((item) => [item.id, item.body_text.length])).toEqual([["m-1", 1500], ["m-2", 500]]);
    const second = await invoke(person(OWNER), "connections.read", { provider: "gmail", threadId: "t-1", maxBytes: 2000, cursor: first.output.nextCursor });
    expect(second).toMatchObject({ status: "ok", output: { truncated: false, nextCursor: null } });
    expect((second as { output: { messages: Array<{ id: string; body_text: string }> } }).output.messages.map((item) => [item.id, item.body_text.length])).toEqual([["m-2", 1000]]);
    expect(await invoke(person(OWNER), "connections.read", { provider: "gmail", messageId: "m-1", cursor: first.output.nextCursor })).toMatchObject({ status: "refused", code: "invalid_cursor" });
    expect(await invoke(person(OWNER), "connections.read", { provider: "gmail", messageId: "m-1", threadId: "t-1" })).toMatchObject({ status: "refused", code: "invalid_input" });
    expect(await invoke(person(OWNER), "connections.read", { provider: "gmail", messageId: "missing" })).toMatchObject({ status: "refused", code: "gmail_not_found" });
    expect(await invoke(person(OWNER), "connections.read", { provider: "gmail" })).toMatchObject({ status: "refused", code: "invalid_input" });
  });

  it("downloads an attachment in parts", async () => {
    const { invoke } = setup();
    const args = { provider: "gmail", messageId: "m-1", attachmentId: "att-1", maxBytes: 2048 };
    const first = await invoke(person(OWNER), "connections.read", args) as { output: { nextCursor: string } };
    expect(first).toMatchObject({ status: "ok", output: { filename: "deck.pdf", mimeType: "application/pdf", size: 3000, offset: 0, truncated: true } });
    const second = await invoke(person(OWNER), "connections.read", { ...args, cursor: first.output.nextCursor });
    expect(second).toMatchObject({ status: "ok", output: { offset: 2048, truncated: false, nextCursor: null } });
    expect(await invoke(person(OWNER), "connections.read", { provider: "gmail", attachmentId: "att-1" })).toMatchObject({ status: "refused", code: "invalid_input" });
  });
});

describe("personalConnectionProviders", () => {
  it("counts only the user's own live connections", async () => {
    const client = fakeClient(fakeDb({
      connections: [
        { id: "c-1", workspace_id: WS, provider: "gmail", connected_by_user_id: TEAMMATE, status: "active" },
        { id: "c-2", workspace_id: WS, provider: "fireflies", connected_by_user_id: OWNER, status: "degraded" },
        { id: "c-3", workspace_id: WS, provider: "granola", connected_by_user_id: OWNER, status: "revoked" },
      ],
    }));
    expect([...(await personalConnectionProviders(client, WS, OWNER))]).toEqual(["fireflies"]);
    expect([...(await personalConnectionProviders(client, WS, TEAMMATE))]).toEqual(["gmail"]);
  });

  it("gives no providers when the lookup fails", async () => {
    const broken = { from: () => { throw new Error("db down"); } } as never;
    expect((await personalConnectionProvidersOrNone(broken, WS, OWNER, "test")).size).toBe(0);
  });
});

it("connections.list advertises Gmail only to its connected person", async () => {
  const { invoke } = setup();
  const own = await invoke(person(OWNER), "connections.list", { provider: "gmail" }) as any;
  expect(own.output.connections[0].actions.map((action: any) => action.verb)).toEqual(["search", "read"]);
  const teammate = await invoke(person(TEAMMATE), "connections.list", { provider: "gmail" }) as any;
  expect(teammate.output.connections[0].actions).toEqual([]);
});

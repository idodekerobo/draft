import { beforeEach, describe, expect, it, mock } from "bun:test";

interface FakeScope {
  credentialId: string;
  workspaceId: string;
  sessionProjectId: string | null;
  allowedProviders: string[] | null;
}

let ingestScope: FakeScope | null = null;
const inserted: Record<string, unknown>[] = [];

mock.module("../../credentials/session-ingest-token", () => ({
  resolveIngestCredentialScope: async () => ingestScope,
}));
mock.module("../../db/client", () => ({
  serviceClient: {
    from(table: string) {
      return {
        insert: async (row: Record<string, unknown>) => {
          inserted.push({ table, ...row });
          return { error: null };
        },
      };
    },
  },
  publishableClient: {},
}));

const routeModule = await import("../../routes/sessions-ingest-errors");

let nextIp = 0;

function report(body: unknown, opts: { token?: string; ip?: string } = {}): Request {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? `10.0.0.${++nextIp}` };
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  return new Request("https://internal.test/sessions/ingest-errors", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// The route records without awaiting the insert, so let it settle.
async function post(request: Request): Promise<Response> {
  const response = await routeModule.POST(request as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
}

function detailOf(row: Record<string, unknown>): Record<string, unknown> {
  return row.detail_json as Record<string, unknown>;
}

beforeEach(() => {
  ingestScope = null;
  inserted.length = 0;
});

describe("POST /sessions/ingest-errors", () => {
  it("attributes the row to the workspace of a valid ingest token", async () => {
    ingestScope = { credentialId: "cred-1", workspaceId: "ws-1", sessionProjectId: "proj-1", allowedProviders: null };
    const response = await post(report({ code: "upload-timeout", os: "Darwin" }, { token: "draft_sit_x" }));
    expect(response.status).toBe(202);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ table: "errors", workspace_id: "ws-1", operation: "ingestion" });
    expect(detailOf(inserted[0]!)).toMatchObject({ code: "upload-timeout", source: "client", credential_id: "cred-1", os: "Darwin" });
  });

  it("records a workspace-less row for an invalid token and never trusts a claimed workspace", async () => {
    const response = await post(report({ code: "http-401", workspaceId: "ws-claimed" }, { token: "bad" }));
    expect(response.status).toBe(202);
    expect(inserted[0]!.workspace_id).toBeNull();
    expect(detailOf(inserted[0]!)).toMatchObject({ source: "client_unauthenticated", claimed_workspace_id: "ws-claimed" });
  });

  it("accepts a report with no token at all", async () => {
    const response = await post(report({ code: "placeholder-config" }));
    expect(response.status).toBe(202);
    expect(inserted[0]!.workspace_id).toBeNull();
  });

  it("rejects unknown codes, malformed bodies and oversize bodies", async () => {
    expect((await post(report({ code: "made-up" }))).status).toBe(400);
    expect((await post(report({ code: "http-999" }))).status).toBe(400);
    expect((await post(report("not json"))).status).toBe(400);
    expect((await post(report("[1]"))).status).toBe(400);
    expect((await post(report({ code: "upload-failed", reason: "x".repeat(2000) }))).status).toBe(413);
    expect(inserted).toHaveLength(0);
  });

  it("truncates free-text fields", async () => {
    await post(report({ code: "upload-failed", reason: "y".repeat(500) }));
    expect((detailOf(inserted[0]!).reason as string).length).toBe(200);
  });

  it("redacts tokens that leak into free text", async () => {
    await post(report({ code: "upload-failed", reason: "request failed token=draft_sit_secret123 and Bearer abc.def" }));
    const reason = detailOf(inserted[0]!).reason as string;
    expect(reason).not.toContain("draft_sit_secret123");
    expect(reason).not.toContain("abc.def");
  });

  it("rate limits one address and leaves others alone", async () => {
    const ip = "203.0.113.9";
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await post(report({ code: "upload-failed" }, { ip }))).status);
    expect(statuses.slice(0, 30).every((s) => s === 202)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect((await post(report({ code: "upload-failed" }, { ip: "203.0.113.10" }))).status).toBe(202);
  });
});

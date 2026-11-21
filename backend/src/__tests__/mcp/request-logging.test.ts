import { afterAll, describe, expect, it } from "bun:test";
import { createMcpProtectedRequestHandler } from "@better-auth/mcp";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createLoggedMcpHandler, type McpRequestContext } from "../../mcp/request-logging";
import { recordError } from "../../errors/record-error";
import type { recordRouteError } from "../../errors/route-error";
import type { SupabaseClient } from "@supabase/supabase-js";

const expected = { issuer: "https://api.example.test/api/auth", resource: "https://api.example.test/mcp", requiredScopes: ["read", "write"] };
const { privateKey, publicKey } = await generateKeyPair("ES256");
const jwks = { keys: [{ ...await exportJWK(publicKey), kid: "test" }] };
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(jwks) });
const jwksUrl = new URL("/jwks", server.url).href;
afterAll(() => server.stop(true));

async function token(scope = "read write", expires = "1h") {
  return new SignJWT({ scope, client_id: "client-1" }).setProtectedHeader({ alg: "ES256", kid: "test" })
    .setSubject("user-1").setIssuer(expected.issuer).setAudience(expected.resource).setExpirationTime(expires).sign(privateKey);
}

function fixture(handle?: (request: Request, context: McpRequestContext) => Promise<Response>) {
  const records: Parameters<typeof recordRouteError>[0][] = [];
  const handler = createLoggedMcpHandler(handle ?? ((request, context) => createMcpProtectedRequestHandler({
    issuer: expected.issuer, audience: expected.resource, jwksUrl, requiredScopes: expected.requiredScopes,
  }, async (_request, claims) => {
    context.stage = "mcp_handling";
    context.userId = claims.sub;
    return Response.json({ ok: true });
  })(request)), expected, (entry) => { records.push(entry); });
  return { handler, records };
}

function request(credential?: string) {
  return new Request(expected.resource, { method: "POST", headers: {
    "user-agent": "test-client", "mcp-protocol-version": "2026-07-28",
    ...(credential ? { authorization: `Bearer ${credential}` } : {}),
  } });
}

describe("MCP request diagnostics", () => {
  it("captures the real missing-credential challenge and preserves the client response", async () => {
    const { handler, records } = fixture();
    const response = await handler(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { message: "missing authorization header" } });
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
    expect(records[0]?.detail).toMatchObject({
      stage: "token_verification", authorization_present: false, credential_present: false,
      authorization_scheme: "none", response_error_message: "missing authorization header",
      challenge_resource_metadata: "https://api.example.test/.well-known/oauth-protected-resource/mcp",
      expected_issuer: expected.issuer, user_agent: "test-client", mcp_protocol_version: "2026-07-28",
    });
    expect(records[0]?.detail?.request_id).toBeString();
  });

  it("captures real expired and invalid token responses without retaining credentials", async () => {
    for (const credential of [await token("read write", "-1h"), "not-a-valid-jwt"]) {
      const { handler, records } = fixture();
      expect((await handler(request(credential))).status).toBe(401);
      expect(records[0]?.detail).toMatchObject({ credential_present: true, stage: "token_verification" });
      expect(records[0]?.detail?.response_error_message).toBeString();
      expect(JSON.stringify(records)).not.toContain(credential);
      if (credential.startsWith("eyJ")) expect(records[0]?.detail?.rejection_reason).toBe("expired");
    }
  });

  it("records a real insufficient-scope rejection without claiming a verified identity", async () => {
    const { handler, records } = fixture();
    expect((await handler(request(await token("read")))).status).toBe(403);
    expect(records[0]?.detail).toMatchObject({ challenge_error: "insufficient_scope", challenge_scope: "write" });
    expect(records[0]?.detail).not.toHaveProperty("verified_user_id");
  });

  it("does not record successful authenticated requests", async () => {
    const { handler, records } = fixture();
    expect((await handler(request(await token()))).status).toBe(200);
    expect(records).toHaveLength(0);
  });

  it("distinguishes a missing subject from a failure after verification", async () => {
    for (const stage of ["missing_subject", "mcp_handling"] as const) {
      const { handler, records } = fixture(async (_request, context) => {
        context.stage = stage;
        if (stage === "mcp_handling") Object.assign(context, { userId: "user-1", clientId: "client-1", scopes: ["read"] });
        return Response.json({ error: "invalid_token" }, { status: 401 });
      });
      await handler(request());
      expect(records[0]?.detail?.stage).toBe(stage);
      if (stage === "mcp_handling") expect(records[0]?.detail).toMatchObject({ verified_user_id: "user-1", verified_client_id: "client-1", verified_scopes: ["read"] });
    }
  });

  it("redacts echoed credentials and persists exception stacks while rethrowing the original", async () => {
    const secret = "opaque-private-credential";
    const original = new Error(`failed with ${secret}`);
    const { handler, records } = fixture(async () => { throw original; });
    await expect(handler(request(secret))).rejects.toBe(original);
    const inserts: Record<string, unknown>[] = [];
    const client = { from: () => ({ insert: async (row: Record<string, unknown>) => { inserts.push(row); return { error: null }; } }) } as unknown as SupabaseClient;
    const entry = records[0]!;
    await recordError({ ...entry, operation: entry.operation ?? "read", message: "MCP failed", client });
    expect(inserts[0]?.stack_trace).toBeString();
    expect(JSON.stringify(inserts)).not.toContain(secret);
  });

  it("excludes bodies, query strings and credentials from response diagnostics", async () => {
    const secret = "opaque-private-credential";
    const response = Response.json({ error: { code: -32000, message: `Bearer ${secret}` }, access_token: "another-secret" }, {
      status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://example.test/metadata?secret=hidden", unknown="hidden"' },
    });
    const { handler, records } = fixture(async () => response);
    expect(await handler(request(secret))).toBe(response);
    expect(records[0]?.detail).toMatchObject({ response_error_message: "Bearer [REDACTED]", challenge_resource_metadata: "https://example.test/metadata" });
    expect(JSON.stringify(records)).not.toMatch(/opaque-private|another-secret|hidden/);
    expect(await response.json()).toHaveProperty("access_token", "another-secret");
  });

  it("bounds large, malformed, non-JSON and stalled response summaries", async () => {
    const cases: Array<[Response, string | undefined]> = [
      [Response.json({ error: "x".repeat(9000) }, { status: 500 }), "too_large"],
      [new Response("invalid json", { status: 500, headers: { "content-type": "application/json" } }), "unavailable"],
      [new Response("private body", { status: 500 }), undefined],
      [new Response(new ReadableStream({ start() {} }), { status: 500, headers: { "content-type": "application/json" } }), "timeout"],
    ];
    for (const [response, summary] of cases) {
      const { handler, records } = fixture(async () => response);
      expect(await handler(request())).toBe(response);
      expect(JSON.stringify(records).length).toBeLessThan(2000);
      expect(records[0]?.detail?.response_summary).toBe(summary);
      if (response.body) void response.body.cancel().catch(() => {});
    }
  });

  it("isolates caller metadata and request IDs between concurrent requests", async () => {
    const { handler, records } = fixture(async (req, context) => {
      context.stage = "mcp_handling";
      context.userId = req.headers.get("user-agent")!;
      await Promise.resolve();
      return Response.json({ error: "refused" }, { status: 403 });
    });
    await Promise.all(["caller-1", "caller-2"].map((caller) => handler(new Request(expected.resource, { headers: { "user-agent": caller } }))));
    expect(records).toHaveLength(2);
    expect(new Set(records.map((entry) => entry.detail?.request_id)).size).toBe(2);
    for (const entry of records) expect(entry.detail?.verified_user_id).toBe(entry.detail?.user_agent);
  });
});

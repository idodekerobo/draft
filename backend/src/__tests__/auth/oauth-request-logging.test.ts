import { expect, test } from "bun:test";
import { createLoggedOAuthHandler } from "../../auth/oauth-request-logging";

test("OAuth diagnostics preserve redirects and redact every credential-bearing field", async () => {
  const records: Record<string, unknown>[] = [];
  const response = new Response(null, { status: 302, headers: { location: "https://client.test/?code=private", "set-cookie": "session=private" } });
  const handler = createLoggedOAuthHandler(async () => response, (row) => { records.push(row); });
  const result = await handler(new Request("https://api.test/api/auth/oauth2/authorize?client_id=https://client.test/private&code=private", { headers: { cookie: "private" } }));
  expect(result).toBe(response);
  expect(result.headers.get("set-cookie")).toBe("session=private");
  expect(records).toHaveLength(1);
  expect(JSON.stringify(records)).not.toContain("private");
  expect(records[0]?.client_hash).toBeString();
});

test("failed refresh exposes only an allowlisted error code and retains the response", async () => {
  const records: Record<string, unknown>[] = [];
  const handler = createLoggedOAuthHandler(async (request) => {
    expect(await request.text()).toContain("refresh_token=secret");
    return Response.json({ error: "invalid_grant", error_description: "secret" }, { status: 400 });
  }, (row) => { records.push(row); });
  const response = await handler(new Request("https://api.test/api/auth/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Bearer secret" },
    body: "grant_type=refresh_token&refresh_token=secret&client_assertion=secret",
  }));
  expect(await response.json()).toEqual({ error: "invalid_grant", error_description: "secret" });
  expect(records[0]).toMatchObject({ status: 400, grant_type: "refresh_token", oauth_error: "invalid_grant" });
  expect(JSON.stringify(records)).not.toContain("secret");
});

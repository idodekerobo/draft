import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { decodeJwt } from "jose";
import { mcpOptions } from "../../auth/mcp-options";

test("MCP OAuth refreshes expired access without a browser session and honors revocation", async () => {
  const database = new Database(":memory:");
  const base = "http://localhost:8787";
  const resource = `${base}/mcp`;
  const redirect = "https://client.example.test/callback";
  const options = {
    database,
    baseURL: base,
    secret: "test-only-secret-with-at-least-thirty-two-characters",
    emailAndPassword: { enabled: true },
    plugins: [jwt(), mcp({ ...mcpOptions({ mcpResourceUrl: resource, appUrl: base }), accessTokenExpiresIn: 1 })],
  };
  try {
    await (await getMigrations(options)).runMigrations();
    const auth = betterAuth(options);
    const discovery = await auth.handler(new Request(`${base}/.well-known/oauth-authorization-server/api/auth`));
    expect((await discovery.json() as { scopes_supported: string[] }).scopes_supported).toContain("offline_access");
    const metadata = await auth.handler(new Request(`${base}/.well-known/oauth-protected-resource/mcp`));
    expect((await metadata.json() as { scopes_supported: string[] }).scopes_supported).toEqual(["read", "write"]);

    const signup = await auth.api.signUpEmail({
      body: { name: "MCP test", email: "mcp@example.test", password: "test-password-123456" },
      asResponse: true,
    });
    expect(signup.status).toBe(200);
    const cookie = signup.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const client = await auth.api.adminCreateOAuthClient({
      headers: { cookie },
      body: {
        redirect_uris: [redirect],
        scope: "read write offline_access",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        skip_consent: true,
      },
    });
    const verifier = "a".repeat(64);
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
    authorize.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirect,
      response_type: "code",
      scope: "read write offline_access",
      resource,
      state: "test-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const authorized = await auth.handler(new Request(authorize.toString(), { headers: { cookie } }));
    expect(authorized.status).toBe(302);
    const code = new URL(authorized.headers.get("location")!).searchParams.get("code");
    expect(code).toBeTruthy();

    const exchange = async (body: Record<string, string>) => auth.handler(new Request(`${base}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.client_id, ...body }),
    }));
    const issued = await exchange({ grant_type: "authorization_code", code: code!, redirect_uri: redirect, code_verifier: verifier, resource });
    expect(issued.status).toBe(200);
    const tokens = await issued.json() as { access_token: string; refresh_token: string };
    expect(tokens.refresh_token).toBeString();
    await Bun.sleep(1100);
    expect(decodeJwt(tokens.access_token).exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    const refreshed = await exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(refreshed.status).toBe(200);
    const rotated = await refreshed.json() as { access_token: string; refresh_token: string };
    expect(rotated.access_token).toBeString();
    expect(rotated.refresh_token).toBeString();
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    const revoked = await auth.handler(new Request(`${base}/api/auth/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.client_id, token: rotated.refresh_token, token_type_hint: "refresh_token" }),
    }));
    expect(revoked.status).toBe(200);
    const rejected = await exchange({ grant_type: "refresh_token", refresh_token: rotated.refresh_token });
    expect(rejected.status).toBe(400);
    expect((await rejected.json() as { error: string }).error).toBe("invalid_grant");
  } finally {
    database.close();
  }
});

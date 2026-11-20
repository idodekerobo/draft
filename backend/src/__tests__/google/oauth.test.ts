import { describe, expect, it } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  GMAIL_READONLY_SCOPE,
  GoogleOAuthError,
  generatePkcePair,
  refreshGoogleAccessToken,
  revokeGoogleToken,
  verifyGoogleIdToken,
} from "../../ingestion/google/oauth";
import { createHash } from "node:crypto";

const settings = { clientId: "client-1", clientSecret: "secret-1", redirectUri: "https://api.test/workspaces/google/callback" };

function jsonFetch(status: number, body: unknown, capture?: { body?: string }): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    if (capture) capture.body = String(init?.body ?? "");
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

describe("buildGoogleAuthUrl", () => {
  it("requests offline access, forces consent, and uses PKCE with only the needed scopes", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));

    const url = new URL(buildGoogleAuthUrl(settings, { state: "s1", codeChallenge: challenge, loginHint: "me@x.com" }));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("login_hint")).toBe("me@x.com");
  });

  it("requests exactly the Gmail-only scopes", () => {
    const url = new URL(buildGoogleAuthUrl(settings, { state: "s", codeChallenge: "c" }));
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(["openid", "email", GMAIL_READONLY_SCOPE]);
    expect(url.searchParams.get("scope")).not.toContain("drive");
  });

  it("omits login_hint when unknown", () => {
    const url = new URL(buildGoogleAuthUrl(settings, { state: "s", codeChallenge: "c" }));
    expect(url.searchParams.has("login_hint")).toBe(false);
  });
});

describe("token requests", () => {
  it("parses a code exchange", async () => {
    const capture: { body?: string } = {};
    const tokens = await exchangeGoogleCode(
      settings,
      { code: "c", codeVerifier: "v" },
      jsonFetch(200, { access_token: "a", refresh_token: "r", id_token: "i", scope: "openid email x", expires_in: 100 }, capture),
    );
    expect(tokens).toMatchObject({ accessToken: "a", refreshToken: "r", idToken: "i", scopes: ["openid", "email", "x"] });
    expect(capture.body).toContain("code_verifier=v");
  });

  it("surfaces invalid_grant on refresh", async () => {
    const error = await refreshGoogleAccessToken(settings, "r", jsonFetch(400, { error: "invalid_grant" })).catch((e) => e);
    expect(error).toBeInstanceOf(GoogleOAuthError);
    expect(error.code).toBe("invalid_grant");
  });

  it("treats an already-dead token as a successful revoke", async () => {
    await revokeGoogleToken("t", jsonFetch(400, { error: "invalid_token" }));
    await expect(revokeGoogleToken("t", jsonFetch(500, {}))).rejects.toThrow();
  });
});

describe("verifyGoogleIdToken", () => {
  async function sign(overrides: { aud?: string; iss?: string } = {}) {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "k1" };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const token = await new SignJWT({ email: "me@x.com" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setSubject("sub-1")
      .setIssuer(overrides.iss ?? "https://accounts.google.com")
      .setAudience(overrides.aud ?? "client-1")
      .setExpirationTime("5m")
      .sign(privateKey);
    return { token, keys };
  }

  it("returns sub and email for a valid token", async () => {
    const { token, keys } = await sign();
    expect(await verifyGoogleIdToken(token, "client-1", keys)).toEqual({ sub: "sub-1", email: "me@x.com" });
  });

  it("rejects the wrong audience and the wrong issuer", async () => {
    const wrongAud = await sign({ aud: "other-client" });
    await expect(verifyGoogleIdToken(wrongAud.token, "client-1", wrongAud.keys)).rejects.toThrow(GoogleOAuthError);
    const wrongIss = await sign({ iss: "https://evil.test" });
    await expect(verifyGoogleIdToken(wrongIss.token, "client-1", wrongIss.keys)).rejects.toThrow(GoogleOAuthError);
  });

  it("rejects a token signed by another key", async () => {
    const { token } = await sign();
    const other = await sign();
    await expect(verifyGoogleIdToken(token, "client-1", other.keys)).rejects.toThrow(GoogleOAuthError);
  });
});

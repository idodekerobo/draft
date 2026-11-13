import { describe, expect, it } from "bun:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import { createLocalVerifier } from "../../auth/verify-local";

const ISSUER = "https://project.test/auth/v1";

type Claims = { sub?: string; aud?: string; iss?: string; exp?: number };

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
  const verify = createLocalVerifier({ issuer: ISSUER, getKey: createLocalJWKSet({ keys: [jwk] }) });
  return { verify, privateKey };
}

function sign(privateKey: CryptoKey, claims: Claims = {}, kid = "k1"): Promise<string> {
  const { sub = "user-1", aud = "authenticated", iss = ISSUER, exp = Math.floor(Date.now() / 1000) + 3600 } = claims;
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(privateKey);
}

describe("createLocalVerifier", () => {
  it("returns the subject of a valid token", async () => {
    const { verify, privateKey } = await setup();
    expect(await verify(await sign(privateKey, { sub: "user-42" }))).toBe("user-42");
  });

  it("returns null for an expired token", async () => {
    const { verify, privateKey } = await setup();
    expect(await verify(await sign(privateKey, { exp: Math.floor(Date.now() / 1000) - 60 }))).toBeNull();
  });

  it("returns null for the wrong audience", async () => {
    const { verify, privateKey } = await setup();
    expect(await verify(await sign(privateKey, { aud: "anon" }))).toBeNull();
  });

  it("returns null for the wrong issuer", async () => {
    const { verify, privateKey } = await setup();
    expect(await verify(await sign(privateKey, { iss: "https://other.test/auth/v1" }))).toBeNull();
  });

  it("returns null when another key signed the token", async () => {
    const { verify } = await setup();
    const { privateKey: otherKey } = await generateKeyPair("ES256");
    expect(await verify(await sign(otherKey))).toBeNull();
  });

  it("returns null for a key id the project does not publish", async () => {
    const { verify, privateKey } = await setup();
    expect(await verify(await sign(privateKey, {}, "k2"))).toBeNull();
  });

  it("returns null when the token has no subject", async () => {
    const { verify, privateKey } = await setup();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience("authenticated")
      .setExpirationTime("1h")
      .sign(privateKey);
    expect(await verify(token)).toBeNull();
  });

  it("returns null for a malformed token", async () => {
    const { verify } = await setup();
    expect(await verify("not-a-jwt")).toBeNull();
  });
});

import { describe, expect, it } from "bun:test";
import {
  createSandboxCallbackToken,
  verifySandboxCallbackToken,
} from "../../sandbox/callback-token";

const claims = {
  runId: "run-123",
  bundleHash: "a".repeat(64),
  expiresAt: 2_000,
  nonce: "nonce-456",
};

describe("sandbox callback token", () => {
  it("round-trips valid base64url HMAC claims", () => {
    const token = createSandboxCallbackToken(claims, "secret");
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifySandboxCallbackToken(token, "secret", { now: 1_999 })).toEqual(claims);
  });

  it("rejects a tampered payload", () => {
    const token = createSandboxCallbackToken(claims, "secret");
    const [payload, signature] = token.split(".");
    const tampered = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${signature}`;
    expect(() => verifySandboxCallbackToken(tampered, "secret", { now: 1_000 })).toThrow(
      "signature is invalid",
    );
  });

  it("rejects an expired token at the expiration boundary", () => {
    const token = createSandboxCallbackToken(claims, "secret");
    expect(() => verifySandboxCallbackToken(token, "secret", { now: 2_000 })).toThrow(
      "has expired",
    );
  });

  it("rejects a token signed with a different secret", () => {
    const token = createSandboxCallbackToken(claims, "right-secret");
    expect(() => verifySandboxCallbackToken(token, "wrong-secret", { now: 1_000 })).toThrow(
      "signature is invalid",
    );
  });
});

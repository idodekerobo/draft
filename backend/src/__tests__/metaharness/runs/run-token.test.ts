import { describe, expect, it } from "bun:test";
import { parseAgentRunId, parseWorkspaceId } from "draft-core/run-spec";
import { createSandboxCallbackToken } from "../../../metaharness/sandbox/callback-token";
import { createAgentRunToken, verifyAgentRunToken } from "../../../metaharness/runs/run-token";

const claims = {
  runId: parseAgentRunId("11111111-1111-4111-8111-111111111111"),
  workspaceId: parseWorkspaceId("22222222-2222-4222-8222-222222222222"),
  expiresAt: 2_000,
  nonce: "nonce-1",
};

describe("agent run token", () => {
  it("round-trips its claims", () => {
    const token = createAgentRunToken(claims, "secret");
    expect(verifyAgentRunToken(token, "secret", { now: 1_999 })).toEqual(claims);
  });

  it("rejects a token signed with another secret", () => {
    const token = createAgentRunToken(claims, "secret");
    expect(() => verifyAgentRunToken(token, "other", { now: 1_000 })).toThrow("signature is invalid");
  });

  it("rejects a tampered payload", () => {
    const [payload, signature] = createAgentRunToken(claims, "secret").split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, workspaceId: "33333333-3333-4333-8333-333333333333" })).toString("base64url");
    expect(forged).not.toBe(payload);
    expect(() => verifyAgentRunToken(`${forged}.${signature}`, "secret", { now: 1_000 })).toThrow("signature is invalid");
  });

  it("rejects an expired token at the boundary", () => {
    const token = createAgentRunToken(claims, "secret");
    expect(() => verifyAgentRunToken(token, "secret", { now: 2_000 })).toThrow("expired");
  });

  it("rejects malformed tokens", () => {
    expect(() => verifyAgentRunToken("nodot", "secret")).toThrow("malformed");
    expect(() => verifyAgentRunToken(".sig", "secret")).toThrow("malformed");
  });

  it("does not accept a sandbox callback token signed with the same secret", () => {
    const callback = createSandboxCallbackToken(
      { runId: claims.runId, bundleHash: "a".repeat(64), expiresAt: 2_000, nonce: "n" },
      "secret",
    );
    expect(() => verifyAgentRunToken(callback, "secret", { now: 1_000 })).toThrow("signature is invalid");
  });
});

describe("agent run token scope", () => {
  it("round-trips each scope", () => {
    for (const scope of ["host", "mcp"] as const) {
      const token = createAgentRunToken({ ...claims, scope }, "secret");
      expect(verifyAgentRunToken(token, "secret", { now: 1_000 })).toEqual({ ...claims, scope });
    }
  });

  it("gives an unscoped token no scope and the same payload it had before scopes", () => {
    const token = createAgentRunToken(claims, "secret");
    const payload = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"));
    expect(payload).toEqual({ runId: claims.runId, workspaceId: claims.workspaceId, expiresAt: 2_000, nonce: "nonce-1" });
    expect(verifyAgentRunToken(token, "secret", { now: 1_000 }).scope).toBeUndefined();
  });

  it("does not let a holder widen an mcp token to host", () => {
    const [, signature] = createAgentRunToken({ ...claims, scope: "mcp" }, "secret").split(".");
    const widened = Buffer.from(JSON.stringify({ ...claims, scope: "host" })).toString("base64url");
    expect(() => verifyAgentRunToken(`${widened}.${signature}`, "secret", { now: 1_000 })).toThrow("signature is invalid");
  });

  it("rejects an unknown scope, and a null or non-string scope", () => {
    const verifyWith = (scope: unknown) => verifyAgentRunToken(createAgentRunToken({ ...claims, scope } as never, "secret"), "secret", { now: 1_000 });
    expect(() => verifyWith("admin")).toThrow("claims are invalid");
    expect(() => verifyWith(null)).toThrow("claims are invalid");
    expect(() => verifyWith(1)).toThrow("claims are invalid");
  });
});

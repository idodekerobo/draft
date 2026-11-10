import { describe, expect, it } from "bun:test";
import { parseAgentRunId, parseWorkspaceId } from "draft-core/agent-run";
import { createSandboxCallbackToken } from "../../../sandbox/callback-token";
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

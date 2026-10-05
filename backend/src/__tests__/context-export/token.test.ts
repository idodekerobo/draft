import { describe, expect, it } from "bun:test";
import {
  ContextExportTokenError,
  createContextExportToken,
  verifyContextExportToken,
} from "../../context-export/token";

const secret = "test-secret";
const claims = { workspaceId: "ws-1", userId: "user-1", exp: 2_000_000 };

describe("context export token", () => {
  it("round trips claims", () => {
    const token = createContextExportToken(claims, secret);
    expect(verifyContextExportToken(token, secret, { now: 1_000_000 })).toEqual(claims);
  });

  it("rejects an expired token", () => {
    const token = createContextExportToken(claims, secret);
    expect(() => verifyContextExportToken(token, secret, { now: 2_000_000 })).toThrow("expired");
  });

  it("rejects a tampered payload", () => {
    const [, signature] = createContextExportToken(claims, secret).split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, userId: "user-2" })).toString("base64url");
    expect(() => verifyContextExportToken(`${forged}.${signature}`, secret, { now: 1 })).toThrow("signature");
  });

  it("rejects a token signed with another secret", () => {
    const token = createContextExportToken(claims, "other");
    expect(() => verifyContextExportToken(token, secret, { now: 1 })).toThrow("signature");
  });

  it("rejects malformed tokens", () => {
    expect(() => verifyContextExportToken("nodot", secret)).toThrow(ContextExportTokenError);
    expect(() => verifyContextExportToken("a.b.c", secret)).toThrow(ContextExportTokenError);
  });

  it("fails clearly when the secret is missing", () => {
    expect(() => createContextExportToken(claims, undefined)).toThrow("CONTEXT_EXPORT_SECRET");
  });
});

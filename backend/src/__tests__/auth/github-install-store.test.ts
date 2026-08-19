import { beforeEach, describe, expect, it } from "bun:test";
import {
  createInstallSession,
  getInstallSession,
  resetInstallSessionStore,
  resolveInstallSession,
} from "../../auth/github-install-store";

describe("github install store", () => {
  let time = 1000;
  beforeEach(() => {
    time = 1000;
    resetInstallSessionStore(() => time);
  });

  it("resolves and reads a session exactly once, workspace-bound", () => {
    const code = createInstallSession("ws-1");
    expect(getInstallSession(code)).toEqual({ status: "pending", workspaceId: "ws-1" });

    expect(resolveInstallSession(code, { status: "connected" })).toBe(true);
    expect(getInstallSession(code)).toEqual({ status: "connected", workspaceId: "ws-1" });
    expect(getInstallSession(code)).toEqual({ status: "expired_or_unknown" });
  });

  it("carries an error message through resolution", () => {
    const code = createInstallSession("ws-1");
    resolveInstallSession(code, { status: "error", errorMessage: "org approval required" });
    expect(getInstallSession(code)).toEqual({
      status: "error",
      workspaceId: "ws-1",
      errorMessage: "org approval required",
    });
  });

  it("is a no-op resolving an already-resolved session (single-use)", () => {
    const code = createInstallSession("ws-1");
    expect(resolveInstallSession(code, { status: "connected" })).toBe(true);
    expect(resolveInstallSession(code, { status: "error", errorMessage: "late" })).toBe(false);
    expect(getInstallSession(code)).toEqual({ status: "connected", workspaceId: "ws-1" });
  });

  it("expires entries after the TTL and rejects late resolution", () => {
    const code = createInstallSession("ws-1");
    time += 300_000;
    expect(resolveInstallSession(code, { status: "connected" })).toBe(false);
    expect(getInstallSession(code)).toEqual({ status: "expired_or_unknown" });
  });

  it("returns unknown for a code that was never created", () => {
    expect(getInstallSession("bogus-code")).toEqual({ status: "expired_or_unknown" });
  });
});

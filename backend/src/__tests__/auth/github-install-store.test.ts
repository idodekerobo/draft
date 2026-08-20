import { beforeEach, describe, expect, it } from "bun:test";
import {
  createInstallSession,
  getInstallSessionStoreSizeForTests,
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

  it("keeps a connected result readable through the full TTL", () => {
    const code = createInstallSession("ws-1");
    expect(getInstallSession(code)).toEqual({ status: "pending", workspaceId: "ws-1" });

    expect(resolveInstallSession(code, { status: "connected" })).toBe(true);
    expect(getInstallSession(code)).toEqual({ status: "connected", workspaceId: "ws-1" });
    expect(getInstallSession(code)).toEqual({ status: "connected", workspaceId: "ws-1" });
    time += 299_999;
    expect(getInstallSession(code)).toEqual({ status: "connected", workspaceId: "ws-1" });
    time += 1;
    expect(getInstallSession(code)).toEqual({ status: "expired_or_unknown" });
  });

  it("keeps an error result readable through the full TTL", () => {
    const code = createInstallSession("ws-1");
    resolveInstallSession(code, {
      status: "error",
      errorCode: "github_installation_conflict",
      errorMessage: "disconnect first",
    });
    const expected = {
      status: "error",
      workspaceId: "ws-1",
      errorCode: "github_installation_conflict",
      errorMessage: "disconnect first",
    } as const;
    expect(getInstallSession(code)).toEqual(expected);
    expect(getInstallSession(code)).toEqual(expected);
    time += 299_999;
    expect(getInstallSession(code)).toEqual(expected);
    time += 1;
    expect(getInstallSession(code)).toEqual({ status: "expired_or_unknown" });
  });

  it("keeps the first terminal result when a later resolver races", () => {
    const code = createInstallSession("ws-1");
    expect(resolveInstallSession(code, { status: "connected" })).toBe(true);
    expect(resolveInstallSession(code, { status: "error", errorMessage: "late" })).toBe(false);
    expect(getInstallSession(code)).toEqual({ status: "connected", workspaceId: "ws-1" });
  });

  it("expires unresolved entries after the TTL and rejects late resolution", () => {
    const code = createInstallSession("ws-1");
    time += 300_000;
    expect(resolveInstallSession(code, { status: "connected" })).toBe(false);
    expect(getInstallSession(code)).toEqual({ status: "expired_or_unknown" });
  });

  it("reclaims an unpolled terminal session during later store activity", () => {
    const staleCode = createInstallSession("ws-stale");
    resolveInstallSession(staleCode, { status: "connected" });
    expect(getInstallSessionStoreSizeForTests()).toBe(1);

    time += 300_000;
    const freshCode = createInstallSession("ws-fresh");

    expect(getInstallSessionStoreSizeForTests()).toBe(1);
    expect(getInstallSession(staleCode)).toEqual({ status: "expired_or_unknown" });
    expect(getInstallSession(freshCode)).toEqual({ status: "pending", workspaceId: "ws-fresh" });
  });

  it("returns unknown for a code that was never created", () => {
    expect(getInstallSession("bogus-code")).toEqual({ status: "expired_or_unknown" });
  });
});

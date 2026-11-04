import { describe, expect, test } from "bun:test";
import { claudeRowState } from "./claude-row-state";

describe("claudeRowState", () => {
  test("waits while the check runs", () => {
    expect(claudeRowState(null, false)).toEqual({ description: "Checking…", action: null });
  });

  test("offers the install guide when Claude Code is missing", () => {
    expect(claudeRowState({ installed: false, auth: "unknown" }, false).action).toBe("install");
  });

  test("offers sign in when installed but signed out", () => {
    const state = claudeRowState({ installed: true, auth: "signed_out" }, false);
    expect(state.action).toBe("sign_in");
    expect(state.description).toContain("not signed in");
  });

  test("tells the person to finish in Terminal once it has opened", () => {
    const state = claudeRowState({ installed: true, auth: "signed_out" }, true);
    expect(state.action).toBe("sign_in");
    expect(state.description).toContain("Terminal");
  });

  test("has no action when ready", () => {
    expect(claudeRowState({ installed: true, auth: "signed_in" }, false).action).toBeNull();
  });

  test("treats an unknown login state as usable", () => {
    const state = claudeRowState({ installed: true, auth: "unknown" }, false);
    expect(state.action).toBeNull();
    expect(state.description).toContain("Installed");
  });
});

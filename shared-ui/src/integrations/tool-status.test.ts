import { describe, expect, test } from "bun:test";
import { toolStatusesFromConnections } from "./tool-status";

describe("toolStatusesFromConnections", () => {
  test("personal tools use only the caller's own connection", () => {
    const statuses = toolStatusesFromConnections(
      [{ provider: "fireflies", status: "connected", display_name: "teammate", is_mine: false }],
      [],
    );
    expect(statuses.fireflies).toEqual({ state: "disconnected" });
  });

  test("team tools show the account name, pending and error states", () => {
    const statuses = toolStatusesFromConnections([], [
      { provider: "slack", status: "connected", display_name: "cedar-frame-studio" },
      { provider: "github", status: "pending", display_name: null },
      { provider: "linear", status: "degraded", display_name: null },
    ]);
    expect(statuses.slack).toEqual({ state: "connected", detail: "cedar-frame-studio" });
    expect(statuses.github?.state).toBe("pending");
    expect(statuses.linear?.state).toBe("error");
  });

  test("a Granola workspace key counts as connected", () => {
    const statuses = toolStatusesFromConnections(
      [{ provider: "granola", status: "connected", display_name: null, is_mine: false, account_kind: "workspace" }],
      [],
    );
    expect(statuses.granola).toEqual({ state: "connected", detail: "Workspace key" });
  });
});

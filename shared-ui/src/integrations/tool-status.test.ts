import { describe, expect, test } from "bun:test";
import { driveToolStatus, gmailToolStatus, hasDriveConnection, hasGmailConnection, toolStatusesFromConnections } from "./tool-status";

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

describe("gmailToolStatus", () => {
  test("connected shows the word Connected with the mailbox", () => {
    expect(gmailToolStatus([{ provider: "gmail", status: "active", display_name: "me@company.com" }])).toEqual({ state: "connected", detail: "Connected · me@company.com" });
    expect(gmailToolStatus([{ provider: "gmail", status: "active", display_name: null }])).toEqual({ state: "connected", detail: "Connected" });
  });

  test("a degraded row asks for a reconnect", () => {
    expect(gmailToolStatus([{ provider: "gmail", status: "degraded" }])).toEqual({ state: "error", detail: "Reconnect needed" });
    expect(hasGmailConnection([{ provider: "gmail", status: "degraded" }])).toBe(true);
  });

  test("no live Gmail row is not connected", () => {
    expect(gmailToolStatus([])).toEqual({ state: "disconnected" });
    expect(gmailToolStatus([{ provider: "slack", status: "active" }])).toEqual({ state: "disconnected" });
    expect(gmailToolStatus([{ provider: "gmail", status: "revoked" }])).toEqual({ state: "disconnected" });
    expect(hasGmailConnection([{ provider: "gmail", status: "revoked" }])).toBe(false);
  });
});

describe("driveToolStatus", () => {
  const live = [{ provider: "google_drive", status: "active" }];
  test("counts synced folders in text", () => {
    expect(driveToolStatus(live, 3)).toEqual({ state: "connected", detail: "Connected · 3 synced folders" });
    expect(driveToolStatus(live, 1)).toEqual({ state: "connected", detail: "Connected · 1 synced folder" });
    expect(driveToolStatus(live, null)).toEqual({ state: "connected", detail: "Connected" });
  });

  test("no folders asks the person to choose some and keeps the row manageable", () => {
    expect(driveToolStatus(live, 0)).toEqual({ state: "pending", detail: "Choose folders", linked: true });
  });

  test("a degraded row asks for a reconnect; no row is not connected", () => {
    expect(driveToolStatus([{ provider: "google_drive", status: "degraded" }], 2)).toEqual({ state: "error", detail: "Reconnect needed" });
    expect(driveToolStatus([{ provider: "gmail", status: "active" }], null)).toEqual({ state: "disconnected" });
    expect(hasDriveConnection([{ provider: "google_drive", status: "revoked" }])).toBe(false);
  });
});

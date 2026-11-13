import { describe, expect, it } from "bun:test";
import { ClaudeDriver } from "./claude-driver";
import type { HostSessionState } from "./cursor-store";
import type { DriverHost, HostInput } from "./harness-driver";
import type { PendingInput } from "./input-delivery";

const state: HostSessionState = {
  sessionId: "s1",
  workspaceId: "w1",
  hostMachineId: "m1",
  nativeSessionId: "n1",
  folderPath: "/tmp",
  cursors: {},
  rawUploads: {},
  ended: false,
};

const host: DriverHost = {
  base: "workspaces/w1/live-sessions/s1",
  state: () => state,
  persist: () => {},
  postLines: async () => {},
  postHostEvents: async () => {},
  setInputState: async () => true,
  isFatal: () => false,
  onFatal: () => {},
  reportError: () => {},
  requestUpload: () => {},
  wake: () => {},
  reportModes: () => {},
};

const message = (state: PendingInput["state"]): PendingInput => ({ id: `i-${state}`, kind: "message", state, delivered_text: "hi" });

async function pollAfter(inputs: HostInput[]): Promise<number> {
  const driver = new ClaudeDriver(host);
  await driver.serve(inputs).catch(() => {});
  return driver.pollMs();
}

describe("ClaudeDriver.pollMs", () => {
  it("polls every 2 s before any pass", () => {
    expect(new ClaudeDriver(host).pollMs()).toBe(2_000);
  });

  it("polls every 250 ms after a pass that holds a queued message", async () => {
    expect(await pollAfter([message("queued")])).toBe(250);
  });

  it("polls every 2 s after a pass with no queued message", async () => {
    expect(await pollAfter([])).toBe(2_000);
    expect(await pollAfter([message("delivering")])).toBe(2_000);
  });
});

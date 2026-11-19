import { describe, expect, it } from "bun:test";
import { canSleep, type IdleSnapshot } from "../../sandbox/host/idle";

const MINUTE = 60_000;
const now = 100 * MINUTE;
const quiet: IdleSnapshot = { now, turnRunning: false, lastInputAt: now - 10 * MINUTE, openApprovalsSince: [] };

describe("canSleep", () => {
  it("sleeps once no turn runs, no approval waits and ten minutes passed since the last input", () => {
    expect(canSleep(quiet)).toBe(true);
  });

  it("stays awake while a turn runs, however long ago the last input came", () => {
    expect(canSleep({ ...quiet, turnRunning: true, lastInputAt: now - 60 * MINUTE })).toBe(false);
  });

  it("stays awake until ten minutes have passed since the last input", () => {
    expect(canSleep({ ...quiet, lastInputAt: now - 10 * MINUTE + 1 })).toBe(false);
  });

  it("stays awake for an approval asked less than thirty minutes ago", () => {
    expect(canSleep({ ...quiet, openApprovalsSince: [now - 29 * MINUTE] })).toBe(false);
  });

  it("stops counting an approval once it has waited thirty minutes", () => {
    expect(canSleep({ ...quiet, openApprovalsSince: [now - 30 * MINUTE] })).toBe(true);
  });

  it("one fresh approval among old ones keeps the session awake", () => {
    expect(canSleep({ ...quiet, openApprovalsSince: [now - 45 * MINUTE, now - 5 * MINUTE] })).toBe(false);
  });
});

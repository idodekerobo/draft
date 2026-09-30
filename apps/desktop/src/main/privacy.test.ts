import { describe, expect, test } from "bun:test";
import { mirroredAnalyticsConfig } from "./privacy";

const base = { consent: "pending" as const, replay_enabled: false, anonymous_id: "device-1" };

describe("mirroredAnalyticsConfig", () => {
  test("maps the account choice onto local consent", () => {
    expect(mirroredAnalyticsConfig(base, { analytics_consent: true, session_replay_enabled: true })).toMatchObject({ consent: "opted_in", replay_enabled: true });
    expect(mirroredAnalyticsConfig(base, { analytics_consent: false, session_replay_enabled: false })).toMatchObject({ consent: "opted_out", replay_enabled: false });
    expect(mirroredAnalyticsConfig(base, { analytics_consent: null, session_replay_enabled: false })).toMatchObject({ consent: "pending" });
  });

  test("never enables replay without consent and keeps the device id", () => {
    const mirrored = mirroredAnalyticsConfig(base, { analytics_consent: false, session_replay_enabled: true });
    expect(mirrored.replay_enabled).toBe(false);
    expect(mirrored.anonymous_id).toBe("device-1");
  });
});

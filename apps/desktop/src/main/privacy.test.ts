import { describe, expect, test } from "bun:test";
import { mirroredAnalyticsConfig } from "./privacy";

const base = { consent: "pending" as const, anonymous_id: "device-1" };

describe("mirroredAnalyticsConfig", () => {
  test("maps the account choice onto local consent", () => {
    expect(mirroredAnalyticsConfig(base, { analytics_consent: true })).toMatchObject({ consent: "opted_in" });
    expect(mirroredAnalyticsConfig(base, { analytics_consent: false })).toMatchObject({ consent: "opted_out" });
    expect(mirroredAnalyticsConfig(base, { analytics_consent: null })).toMatchObject({ consent: "pending" });
  });

  test("keeps the device id", () => {
    expect(mirroredAnalyticsConfig(base, { analytics_consent: false }).anonymous_id).toBe("device-1");
  });
});

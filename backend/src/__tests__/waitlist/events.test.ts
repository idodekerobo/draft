import { describe, expect, it } from "bun:test";
import { MetaSendError, type MetaEventInput } from "../../meta/capi";
import { hasOptedOut, sendLeadEvent, type LeadDeps, type LeadSignup } from "../../waitlist/events";

const settings = { pixelId: "1", accessToken: "t", testEventCode: "TEST1" };

function signup(overrides: Partial<LeadSignup> = {}): LeadSignup {
  return {
    signupId: "signup-1",
    email: "person@example.com",
    eventId: "evt-1",
    source: "getstarted",
    attribution: { last: { utm_source: "meta", fbp: "fb.1.1.2", fbc: "fb.1.1.abc" } },
    client: { ip: "203.0.113.5", userAgent: "UA", sourceUrl: "https://draftai.us/getstarted" },
    ...overrides,
  };
}

function deps(overrides: Partial<LeadDeps> = {}) {
  const sent: MetaEventInput[] = [];
  const errors: unknown[] = [];
  const value: LeadDeps = {
    settings,
    send: async (event) => {
      sent.push(event);
    },
    logError: (async (input: unknown) => {
      errors.push(input);
    }) as LeadDeps["logError"],
    ...overrides,
  };
  return { value, sent, errors };
}

describe("hasOptedOut", () => {
  it("reads the gpc flag from either touch", () => {
    expect(hasOptedOut({ last: { gpc: "1" } })).toBe(true);
    expect(hasOptedOut({ first: { gpc: "1" } })).toBe(true);
    expect(hasOptedOut({ last: { utm_source: "meta" } })).toBe(false);
    expect(hasOptedOut(null)).toBe(false);
  });
});

describe("sendLeadEvent", () => {
  it("sends a Lead with the browser identifiers", async () => {
    const { value, sent } = deps();
    expect(await sendLeadEvent(signup(), value)).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      eventName: "Lead",
      eventId: "evt-1",
      externalId: "signup-1",
      fbp: "fb.1.1.2",
      fbc: "fb.1.1.abc",
      clientIp: "203.0.113.5",
      contentName: "getstarted",
    });
  });

  it("does nothing when sending is not configured", async () => {
    const { value, sent } = deps({ settings: null });
    expect(await sendLeadEvent(signup(), value)).toBe("skipped_unconfigured");
    expect(sent).toHaveLength(0);
  });

  it("does nothing for visitors who sent Global Privacy Control", async () => {
    const { value, sent } = deps();
    expect(await sendLeadEvent(signup({ attribution: { last: { gpc: "1" } } }), value)).toBe("skipped_opt_out");
    expect(sent).toHaveLength(0);
  });

  it("logs a failure without the email and returns failed", async () => {
    const { value, errors } = deps({
      send: async () => {
        throw new MetaSendError("Meta responded with status 400", 400, 190);
      },
    });
    expect(await sendLeadEvent(signup(), value)).toBe("failed");
    expect(errors).toHaveLength(1);
    const logged = JSON.stringify(errors[0]);
    expect(logged).toContain("190");
    expect(logged).not.toContain("person@example.com");
  });
});

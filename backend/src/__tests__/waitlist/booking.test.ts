import { describe, expect, it } from "bun:test";
import type { MetaEventInput } from "../../meta/capi";
import { handleBookingCreated, type SignupRow, type SignupStore } from "../../waitlist/booking";
import type { EventDeps } from "../../waitlist/events";
import type { CalBooking } from "../../webhooks/cal/payload";

const settings = { pixelId: "1", accessToken: "t", testEventCode: "TEST1" };

function fakeStore(existing: SignupRow | null) {
  const inserts: unknown[] = [];
  const updates: { id: string; profile: Record<string, string> }[] = [];
  const store: SignupStore = {
    findByEmail: async () => existing,
    insertIfNew: async (row) => {
      if (existing) return { row: existing, inserted: false };
      inserts.push(row);
      return {
        row: { id: "new-1", email: row.email, profile: row.profile, attribution: row.attribution },
        inserted: true,
      };
    },
    updateProfile: async (id, profile) => {
      updates.push({ id, profile });
    },
  };
  return { store, inserts, updates };
}

function fakeEvents(overrides: Partial<EventDeps> = {}) {
  const sent: MetaEventInput[] = [];
  const events: EventDeps = {
    settings,
    send: async (event) => {
      sent.push(event);
    },
    logError: (async () => {}) as EventDeps["logError"],
    ...overrides,
  };
  return { events, sent };
}

function booking(overrides: Partial<CalBooking> = {}): CalBooking {
  return {
    uid: "bk-1",
    email: "person@example.com",
    name: "Sam Lee",
    answers: { role: "Engineering", team_size: "2-10" },
    metadata: { event_id: "evt-1", fbp: "fb.1.1.2", fbc: "fb.1.1.abc", source: "getstarted", utm_source: "meta" },
    ...overrides,
  };
}

describe("handleBookingCreated", () => {
  it("sends only Schedule for someone who already signed up, with the browser event id", async () => {
    const existing: SignupRow = { id: "s-1", email: "person@example.com", profile: { role: "founder" }, attribution: null };
    const { store, updates } = fakeStore(existing);
    const { events, sent } = fakeEvents();

    const result = await handleBookingCreated(booking(), { store, events });

    expect(result).toEqual({ signupId: "s-1", createdSignup: false, lead: null, schedule: "sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      eventName: "Schedule",
      eventId: "evt-1",
      externalId: "s-1",
      firstName: "Sam",
      lastName: "Lee",
      fbp: "fb.1.1.2",
      contentName: "getstarted",
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].profile).toMatchObject({ role: "founder", team_size: "2_10", name: "Sam Lee" });
  });

  it("keeps answers already on the signup", async () => {
    const existing: SignupRow = {
      id: "s-1",
      email: "person@example.com",
      profile: { role: "founder", team_size: "11_50", name: "Sam Lee", profile_version: "2" },
      attribution: null,
    };
    const { store, updates } = fakeStore(existing);
    await handleBookingCreated(booking(), { store, events: fakeEvents().events });
    expect(updates).toHaveLength(0);
  });

  it("creates the signup and sends Lead then Schedule for a direct booker", async () => {
    const { store, inserts } = fakeStore(null);
    const { events, sent } = fakeEvents();

    const result = await handleBookingCreated(booking({ metadata: { utm_source: "meta", fbp: "fb.1.1.2" } }), {
      store,
      events,
      fallbackSourceUrl: "https://draftai.us/getstarted",
    });

    expect(result).toMatchObject({ createdSignup: true, lead: "sent", schedule: "sent" });
    expect(inserts[0]).toMatchObject({
      email: "person@example.com",
      source: "cal_direct",
      attribution: { last: { utm_source: "meta", fbp: "fb.1.1.2" } },
      profile: { role: "engineering", team_size: "2_10" },
    });
    const byName = Object.fromEntries(sent.map((event) => [event.eventName, event]));
    expect(byName.Lead.eventId).toBe("lead-bk-1");
    expect(byName.Schedule.eventId).toBe("bk-1");
    expect(byName.Schedule.sourceUrl).toBe("https://draftai.us/getstarted");
  });

  it("sends nothing for visitors who sent Global Privacy Control", async () => {
    const { store } = fakeStore(null);
    const { events, sent } = fakeEvents();
    const result = await handleBookingCreated(booking({ metadata: { gpc: "1" } }), { store, events });
    expect(result).toMatchObject({ lead: "skipped_opt_out", schedule: "skipped_opt_out" });
    expect(sent).toHaveLength(0);
  });

  it("still saves the booking when Meta sending is not configured", async () => {
    const { store, inserts } = fakeStore(null);
    const { events } = fakeEvents({ settings: null });
    const result = await handleBookingCreated(booking(), { store, events });
    expect(result).toMatchObject({ createdSignup: true, lead: "skipped_unconfigured", schedule: "skipped_unconfigured" });
    expect(inserts).toHaveLength(1);
  });
});

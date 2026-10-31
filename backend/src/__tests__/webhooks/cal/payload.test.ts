import { describe, expect, it } from "bun:test";
import { parseBookingCreated } from "../../../webhooks/cal/payload";

function body(payload: Record<string, unknown>) {
  return { triggerEvent: "BOOKING_CREATED", payload };
}

describe("parseBookingCreated", () => {
  it("reads attendee, answers, and metadata", () => {
    const booking = parseBookingCreated(
      body({
        uid: "bk-1",
        attendees: [{ email: "Person@Example.com", name: "Sam Lee" }],
        responses: {
          name: { label: "your_name", value: "Sam Lee" },
          email: { label: "email_address", value: "person@example.com" },
          role: { label: "Role", value: "Engineering" },
          team_size: { label: "Team Size", value: "2-10" },
          ai_tools: { label: "AI Tools You Use", value: ["Claude", "Cursor"] },
          use_case: { label: "Use Case", value: "  roll out AI " },
          how_heard: { label: "How did you hear about us?" },
        },
        metadata: { event_id: "evt-1", fbp: "fb.1.1.2", utm_source: "meta", count: 3 },
      }),
    );
    expect(booking).toEqual({
      uid: "bk-1",
      email: "person@example.com",
      name: "Sam Lee",
      answers: {
        role: "Engineering",
        team_size: "2-10",
        ai_tools: ["Claude", "Cursor"],
        use_case: "roll out AI",
      },
      metadata: { event_id: "evt-1", fbp: "fb.1.1.2", utm_source: "meta" },
    });
  });

  it("falls back to userFieldsResponses for custom answers", () => {
    const booking = parseBookingCreated(
      body({
        uid: "bk-2",
        attendees: [{ email: "a@b.co" }],
        userFieldsResponses: { role: { label: "Role", value: "Founder" } },
      }),
    );
    expect(booking?.answers).toEqual({ role: "Founder" });
  });

  it("uses the name response when the attendee has no name", () => {
    const booking = parseBookingCreated(
      body({ uid: "bk-3", attendees: [{ email: "a@b.co" }], responses: { name: { value: "Pat" } } }),
    );
    expect(booking?.name).toBe("Pat");
  });

  it("returns null without a booking uid or attendee email", () => {
    expect(parseBookingCreated(body({ attendees: [{ email: "a@b.co" }] }))).toBeNull();
    expect(parseBookingCreated(body({ uid: "bk-4", attendees: [] }))).toBeNull();
    expect(parseBookingCreated(null)).toBeNull();
    expect(parseBookingCreated({ triggerEvent: "BOOKING_CREATED" })).toBeNull();
  });
});

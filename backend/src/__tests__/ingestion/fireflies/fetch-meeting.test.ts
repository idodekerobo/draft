import { afterEach, describe, expect, it } from "bun:test";
import { fetchFirefliesMeeting } from "../../../ingestion/fireflies/fetch-meeting";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchOnce(response: {
  ok: boolean;
  status?: number;
  statusText?: string;
  json?: unknown;
  text?: string;
}) {
  globalThis.fetch = (async () =>
    ({
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      statusText: response.statusText ?? "",
      json: async () => response.json,
      text: async () => response.text ?? "",
    }) as Response) as unknown as typeof fetch;
}

describe("fetchFirefliesMeeting", () => {
  it("parses a successful transcript response into FirefliesMeetingData", async () => {
    mockFetchOnce({
      ok: true,
      json: {
        data: {
          transcript: {
            id: "meeting-123",
            title: "Weekly Sync",
            date: 1735689600000,
            participants: ["a@example.com", "b@example.com"],
            meeting_attendees: [
              { displayName: "Alice", name: null, email: "a@example.com" },
              { displayName: "Bob", name: null, email: "b@example.com" },
            ],
            summary: {
              short_summary: "Quick sync on Q1 roadmap.",
              overview: "Discussed roadmap priorities.",
              action_items: "- Alice to follow up with design.",
              outline: "1. Roadmap\n2. Action items",
            },
            sentences: [
              { speaker_name: "Alice", text: "Let's start." },
              { speaker_name: "Bob", text: "Sounds good." },
            ],
          },
        },
      },
    });

    const result = await fetchFirefliesMeeting("fake-token", "meeting-123");

    expect(result.meetingId).toBe("meeting-123");
    expect(result.title).toBe("Weekly Sync");
    expect(result.occurredAt).toBe(new Date(1735689600000).toISOString());
    expect(result.attendees).toEqual(["Alice", "Bob"]);
    expect(result.shortSummary).toBe("Quick sync on Q1 roadmap.");
    expect(result.overview).toBe("Discussed roadmap priorities.");
    expect(result.actionItems).toBe("- Alice to follow up with design.");
    expect(result.outline).toBe("1. Roadmap\n2. Action items");
    expect(result.sentences).toEqual([
      { speakerName: "Alice", text: "Let's start." },
      { speakerName: "Bob", text: "Sounds good." },
    ]);
  });

  it("falls back to participants when meeting_attendees is empty", async () => {
    mockFetchOnce({
      ok: true,
      json: {
        data: {
          transcript: {
            id: "meeting-456",
            title: "No Attendee Objects",
            date: 1735689600000,
            participants: ["a@example.com", "b@example.com"],
            meeting_attendees: [],
            summary: {},
            sentences: [],
          },
        },
      },
    });

    const result = await fetchFirefliesMeeting("fake-token", "meeting-456");
    expect(result.attendees).toEqual(["a@example.com", "b@example.com"]);
  });

  it("throws on a non-2xx HTTP response", async () => {
    mockFetchOnce({ ok: false, status: 401, statusText: "Unauthorized", text: "bad token" });

    await expect(fetchFirefliesMeeting("bad-token", "meeting-1")).rejects.toThrow(
      /401/,
    );
  });

  it("throws when the GraphQL response contains an errors array", async () => {
    mockFetchOnce({
      ok: true,
      json: {
        errors: [{ message: "Transcript not found" }],
      },
    });

    await expect(fetchFirefliesMeeting("fake-token", "missing-meeting")).rejects.toThrow(
      /Transcript not found/,
    );
  });

  it("throws when the response has no transcript data", async () => {
    mockFetchOnce({
      ok: true,
      json: { data: { transcript: null } },
    });

    await expect(fetchFirefliesMeeting("fake-token", "meeting-1")).rejects.toThrow(
      /no transcript/,
    );
  });
});

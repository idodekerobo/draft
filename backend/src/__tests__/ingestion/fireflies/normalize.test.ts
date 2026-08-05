import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import type { FirefliesMeetingData } from "../../../ingestion/fireflies/fetch-meeting";

// mock.module() mutates the module's exports object in place, so mocking
// "../../../credentials/resolve-provider-credential" here would otherwise
// leak into every other file importing it (e.g. request-auth.test.ts) when
// both run in the same `bun test` process. Capture the real export by value
// up front and restore it in afterAll.
const realResolveProviderCredentialModule = await import(
  "../../../credentials/resolve-provider-credential"
);
const realResolveProviderCredential = realResolveProviderCredentialModule.resolveProviderCredential;
const RealCredentialError = realResolveProviderCredentialModule.CredentialError;

const ids = {
  workspace: "88888888-8888-4888-8888-888888888888",
  connection: "99999999-9999-4999-8999-999999999999",
};

const originalFetch = globalThis.fetch;

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function mockFetchOnce(json: unknown) {
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      statusText: "",
      json: async () => json,
      text: async () => "",
    }) as Response) as unknown as typeof fetch;
}

const TRANSCRIPT_FIXTURE = {
  data: {
    transcript: {
      id: "meeting-123",
      title: "Weekly Sync",
      date: 1735689600000,
      participants: ["a@example.com"],
      meeting_attendees: [{ displayName: "Alice", name: null, email: "a@example.com" }],
      summary: {
        short_summary: "Quick sync.",
        overview: "Roadmap discussion.",
        action_items: "- Follow up with design.",
        outline: "1. Roadmap",
      },
      sentences: [
        { speaker_name: "Alice", text: "Let's start." },
        { speaker_name: "Bob", text: "Sounds good." },
      ],
    },
  },
};

interface FakeState {
  priorReadyRevisions: { id: string; external_version: string }[];
  upsertedItem: Record<string, unknown> | null;
  supersedeCalls: string[][];
  eventInsertPayload: Record<string, unknown> | null;
}

function createFakeClient(priorReadyRevisions: { id: string; external_version: string }[] = []) {
  const state: FakeState = {
    priorReadyRevisions,
    upsertedItem: null,
    supersedeCalls: [],
    eventInsertPayload: null,
  };

  function from(table: string) {
    if (table === "source_items") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                neq: async () => ({ data: state.priorReadyRevisions, error: null }),
              }),
            }),
          }),
        }),
        upsert: (payload: Record<string, unknown>) => {
          state.upsertedItem = payload;
          return {
            select: () => ({
              single: async () => ({
                data: { id: "new-item-id", ...payload },
                error: null,
              }),
            }),
          };
        },
        update: () => ({
          in: async (_col: string, idsArg: string[]) => {
            state.supersedeCalls.push(idsArg);
            return { error: null };
          },
        }),
      };
    }

    if (table === "workspace_events") {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        }),
        insert: async (payload: Record<string, unknown>) => {
          state.eventInsertPayload = payload;
          return { error: null };
        },
      };
    }

    throw new Error(`Unexpected table in fake client: ${table}`);
  }

  return { client: { from } as unknown as SupabaseClient, state };
}

describe("ingestFirefliesMeeting", () => {
  beforeEach(() => {
    mock.module("../../../credentials/resolve-provider-credential", () => ({
      resolveProviderCredential: async () => ({
        api_token: "fake-token",
        webhook_secret: "fake-secret",
      }),
      CredentialError: RealCredentialError,
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    mock.module("../../../credentials/resolve-provider-credential", () => ({
      resolveProviderCredential: realResolveProviderCredential,
      CredentialError: RealCredentialError,
    }));
  });

  it("fetches, normalizes, and writes a source_item + event on the happy path", async () => {
    mockFetchOnce(TRANSCRIPT_FIXTURE);
    const { client, state } = createFakeClient([]);
    const { ingestFirefliesMeeting } = await import("../../../ingestion/fireflies/normalize");

    const result = await ingestFirefliesMeeting(
      { id: ids.connection, workspace_id: ids.workspace },
      "meeting-123",
      client,
    );

    expect(result.sourceItemId).toBe("new-item-id");

    expect(state.upsertedItem?.workspace_id).toBe(ids.workspace);
    expect(state.upsertedItem?.source_connection_id).toBe(ids.connection);
    expect(state.upsertedItem?.item_type).toBe("meeting_transcript");
    expect(state.upsertedItem?.external_id).toBe("meeting-123");
    expect(state.upsertedItem?.occurred_at).toBe(new Date(1735689600000).toISOString());

    const markdown = state.upsertedItem?.content_markdown as string;
    expect(markdown).toContain("# Weekly Sync");
    expect(markdown).toContain("**Attendees:** Alice");
    expect(markdown).toContain("## Short Summary");
    expect(markdown).toContain("Quick sync.");
    expect(markdown).toContain("## Overview");
    expect(markdown).toContain("## Action Items");
    expect(markdown).toContain("## Outline");
    expect(markdown).toContain("## Transcript");
    expect(markdown).toContain("**Alice:** Let's start.");
    expect(markdown).toContain("**Bob:** Sounds good.");

    const expectedHash = sha256(markdown);
    expect(state.upsertedItem?.external_version).toBe(expectedHash);
    expect(state.upsertedItem?.content_hash).toBe(expectedHash);

    expect(state.eventInsertPayload?.event_type).toBe("source_items_added");
    expect(state.eventInsertPayload?.source_connection_id).toBe(ids.connection);
    expect(state.eventInsertPayload?.summary).toBe("Weekly Sync");
  });

  it("throws instead of silently producing empty content when Fireflies returns a GraphQL error", async () => {
    mockFetchOnce({ errors: [{ message: "Transcript not found" }] });
    const { client } = createFakeClient([]);
    const { ingestFirefliesMeeting } = await import("../../../ingestion/fireflies/normalize");

    await expect(
      ingestFirefliesMeeting({ id: ids.connection, workspace_id: ids.workspace }, "missing", client),
    ).rejects.toThrow(/Transcript not found/);
  });

  it("marks a prior ready revision superseded when re-ingesting changed content", async () => {
    mockFetchOnce(TRANSCRIPT_FIXTURE);
    const priorId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const { client, state } = createFakeClient([
      { id: priorId, external_version: "some-old-hash" },
    ]);
    const { ingestFirefliesMeeting } = await import("../../../ingestion/fireflies/normalize");

    await ingestFirefliesMeeting(
      { id: ids.connection, workspace_id: ids.workspace },
      "meeting-123",
      client,
    );

    expect(state.upsertedItem?.supersedes_source_item_id).toBe(priorId);
    expect(state.supersedeCalls).toEqual([[priorId]]);
  });
});

describe("content hashing (idempotency)", () => {
  it("produces the same external_version/content_hash for identical fetched content", async () => {
    const { buildFirefliesContentMarkdown } = await import(
      "../../../ingestion/fireflies/normalize"
    );

    const meeting: FirefliesMeetingData = {
      meetingId: "meeting-123",
      title: "Weekly Sync",
      occurredAt: new Date(1735689600000).toISOString(),
      attendees: ["Alice"],
      shortSummary: "Quick sync.",
      overview: "Roadmap discussion.",
      actionItems: "- Follow up with design.",
      outline: "1. Roadmap",
      sentences: [
        { speakerName: "Alice", text: "Let's start." },
        { speakerName: "Bob", text: "Sounds good." },
      ],
    };

    const markdownA = buildFirefliesContentMarkdown(meeting);
    const markdownB = buildFirefliesContentMarkdown({ ...meeting });

    expect(markdownA).toBe(markdownB);
    expect(sha256(markdownA)).toBe(sha256(markdownB));

    const differentMeeting: FirefliesMeetingData = {
      ...meeting,
      sentences: [...meeting.sentences, { speakerName: "Alice", text: "One more thing." }],
    };
    const markdownC = buildFirefliesContentMarkdown(differentMeeting);
    expect(sha256(markdownC)).not.toBe(sha256(markdownA));
  });
});

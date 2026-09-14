import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

// mock.module() mutates the module's exports object in place, so mocking
// "../../../credentials/resolve-provider-credential" here would otherwise
// leak into other files importing it when both run in the same `bun test`
// process. Capture the real export by value up front and restore in afterAll.
const realResolveProviderCredentialModule = await import(
  "../../../credentials/resolve-provider-credential"
);
const realResolveProviderCredentialById = realResolveProviderCredentialModule.resolveProviderCredentialById;
const RealCredentialError = realResolveProviderCredentialModule.CredentialError;

const ids = {
  workspace: "88888888-8888-4888-8888-888888888888",
  connection: "99999999-9999-4999-8999-999999999999",
  credential: "77777777-7777-4777-8777-777777777777",
};

const originalFetch = globalThis.fetch;

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function mockFetchSequence(responses: Array<{ status: number; json: unknown }>) {
  let call = 0;
  globalThis.fetch = (async () => {
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: "",
      json: async () => response.json,
      text: async () => "",
    } as Response;
  }) as unknown as typeof fetch;
}

const NOTE_FIXTURE = {
  id: "not_123",
  title: "Quarterly Review",
  owner: { name: "Oat Benson", email: "oat@granola.ai" },
  summary: "Reviewed the quarterly numbers.",
  transcript: [
    { speaker: { source: "microphone" }, text: "Let's start." },
    { speaker: { source: "speaker" }, text: "Sounds good." },
  ],
  created_at: "2026-01-27T15:30:00.000Z",
};

interface FakeState {
  priorReadyRevisions: { id: string; external_version: string }[];
  upsertedItem: Record<string, unknown> | null;
  eventInsertPayload: Record<string, unknown> | null;
  updatedVisibility: { visibility: string; owner_user_id: string | null } | null;
}

interface FakeClientOptions {
  priorReadyRevisions?: { id: string; external_version: string }[];
  // Other Granola connections already present in the workspace, for the
  // cross-connection dedup lookup. Empty by default so existing tests are
  // unaffected -- the dedup query short-circuits when there's nothing to find.
  granolaConnectionIds?: string[];
  existingItem?: { id: string; source_connection_id: string; visibility: "private" | "shared" } | null;
}

function createFakeClient(options: FakeClientOptions = {}) {
  const state: FakeState = {
    priorReadyRevisions: options.priorReadyRevisions ?? [],
    upsertedItem: null,
    eventInsertPayload: null,
    updatedVisibility: null,
  };

  function from(table: string) {
    if (table === "source_connections") {
      return {
        select: () => ({
          eq: () => ({
            eq: async () => ({
              data: (options.granolaConnectionIds ?? []).map((id) => ({ id })),
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === "source_items") {
      return {
        select: (columns?: string) => {
          if (columns?.includes("source_connection_id")) {
            return {
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    in: () => ({
                      maybeSingle: async () => ({ data: options.existingItem ?? null, error: null }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {
            eq: (_col: string, val: string) => ({
              single: async () => ({ data: { id: val, ...state.upsertedItem }, error: null }),
            }),
          };
        },
        update: (payload: Record<string, unknown>) => ({
          eq: () => ({
            eq: async () => {
              state.updatedVisibility = payload as { visibility: string; owner_user_id: string | null };
              return { error: null };
            },
          }),
        }),
      };
    }
    if (table === "workspace_events") {
      return {
        select: () => ({
          eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
        }),
        insert: async (payload: Record<string, unknown>) => {
          state.eventInsertPayload = payload;
          return { error: null };
        },
      };
    }
    throw new Error(`Unexpected table in fake client: ${table}`);
  }

  function rpc(fnName: string, params: Record<string, unknown>) {
    if (fnName !== "upsert_source_item") throw new Error(`Unexpected rpc in fake client: ${fnName}`);
    const priorIds = state.priorReadyRevisions.map((r) => r.id);
    state.upsertedItem = {
      workspace_id: params.p_workspace_id,
      source_connection_id: params.p_source_connection_id,
      item_type: params.p_item_type,
      external_id: params.p_external_id,
      external_version: params.p_external_version,
      occurred_at: params.p_occurred_at,
      content_markdown: params.p_content_markdown,
      content_hash: params.p_content_hash,
      metadata_json: params.p_metadata_json,
      sanitized_raw_json: params.p_sanitized_raw_json,
      visibility: params.p_visibility,
      owner_user_id: params.p_owner_user_id,
      supersedes_source_item_id: priorIds[0] ?? null,
    };
    return Promise.resolve({ data: { item_id: "new-item-id", changed: true, superseded_item_ids: priorIds }, error: null });
  }

  return { client: { from, rpc } as unknown as SupabaseClient, state };
}

describe("ingestGranolaNote", () => {
  beforeEach(() => {
    mock.module("../../../credentials/resolve-provider-credential", () => ({
      resolveProviderCredentialById: async () => ({
        api_token: "fake-token",
        webhook_secret: "whsec_fake",
        webhook_endpoint_id: "whe_fake",
      }),
      CredentialError: RealCredentialError,
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    mock.module("../../../credentials/resolve-provider-credential", () => ({
      resolveProviderCredentialById: realResolveProviderCredentialById,
      CredentialError: RealCredentialError,
    }));
  });

  it("fetches, normalizes, and writes a source_item + event on the happy path", async () => {
    mockFetchSequence([{ status: 200, json: NOTE_FIXTURE }]);
    const { client, state } = createFakeClient();
    const { ingestGranolaNote } = await import("../../../ingestion/granola/normalize");

    const result = await ingestGranolaNote(
      { id: ids.connection, workspace_id: ids.workspace, connected_by_user_id: "user-1" },
      ids.credential,
      "not_123",
      client,
    );

    expect(result.sourceItemId).toBe("new-item-id");
    expect(state.upsertedItem?.item_type).toBe("meeting_notes");
    expect(state.upsertedItem?.external_id).toBe("not_123");
    expect(state.upsertedItem?.occurred_at).toBe("2026-01-27T15:30:00.000Z");

    const markdown = state.upsertedItem?.content_markdown as string;
    expect(markdown).toContain("# Quarterly Review");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("Reviewed the quarterly numbers.");
    expect(markdown).toContain("## Transcript");
    expect(markdown).toContain("Let's start.");

    expect(state.upsertedItem?.content_hash).toBe(sha256(markdown));
    expect(state.eventInsertPayload?.event_type).toBe("source_items_added");
    expect(state.eventInsertPayload?.summary).toBe("Quarterly Review");
  });

  it("marks a personal-key connection's notes private and owned by the connecting teammate", async () => {
    mockFetchSequence([{ status: 200, json: NOTE_FIXTURE }]);
    const { client, state } = createFakeClient();
    const { ingestGranolaNote } = await import("../../../ingestion/granola/normalize");

    await ingestGranolaNote(
      { id: ids.connection, workspace_id: ids.workspace, connected_by_user_id: "user-1" },
      ids.credential,
      "not_123",
      client,
    );

    expect(state.upsertedItem?.visibility).toBe("private");
    expect(state.upsertedItem?.owner_user_id).toBe("user-1");
  });

  it("marks a workspace-key connection's notes shared with no owner", async () => {
    mockFetchSequence([{ status: 200, json: NOTE_FIXTURE }]);
    const { client, state } = createFakeClient();
    const { ingestGranolaNote } = await import("../../../ingestion/granola/normalize");

    await ingestGranolaNote(
      { id: ids.connection, workspace_id: ids.workspace, connected_by_user_id: null },
      ids.credential,
      "not_123",
      client,
    );

    expect(state.upsertedItem?.visibility).toBe("shared");
    expect(state.upsertedItem?.owner_user_id).toBe(null);
  });

  it("falls back to separate note + transcript fetches when the inline transcript is too large", async () => {
    mockFetchSequence([
      { status: 413, json: { error: "TRANSCRIPT_TOO_LARGE" } },
      { status: 200, json: { ...NOTE_FIXTURE, transcript: undefined } },
      { status: 200, json: { transcript: NOTE_FIXTURE.transcript } },
    ]);
    const { client, state } = createFakeClient();
    const { ingestGranolaNote } = await import("../../../ingestion/granola/normalize");

    await ingestGranolaNote(
      { id: ids.connection, workspace_id: ids.workspace, connected_by_user_id: "user-1" },
      ids.credential,
      "not_123",
      client,
    );

    const markdown = state.upsertedItem?.content_markdown as string;
    expect(markdown).toContain("Let's start.");
  });

  it("marks a prior active revision superseded when re-ingesting changed content", async () => {
    mockFetchSequence([{ status: 200, json: NOTE_FIXTURE }]);
    const priorId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const { client, state } = createFakeClient({ priorReadyRevisions: [{ id: priorId, external_version: "some-old-hash" }] });
    const { ingestGranolaNote } = await import("../../../ingestion/granola/normalize");

    await ingestGranolaNote(
      { id: ids.connection, workspace_id: ids.workspace, connected_by_user_id: "user-1" },
      ids.credential,
      "not_123",
      client,
    );

    expect(state.upsertedItem?.supersedes_source_item_id).toBe(priorId);
  });

  it("skips writing a second row when another granola connection already owns this note", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; throw new Error("should not fetch"); }) as unknown as typeof fetch;
    const { client, state } = createFakeClient({
      granolaConnectionIds: [ids.connection, "other-connection"],
      existingItem: { id: "existing-item-id", source_connection_id: "other-connection", visibility: "shared" },
    });
    const { ingestGranolaNote } = await import("../../../ingestion/granola/normalize");

    const result = await ingestGranolaNote(
      { id: ids.connection, workspace_id: ids.workspace, connected_by_user_id: "user-1" },
      ids.credential,
      "not_123",
      client,
    );

    expect(result.sourceItemId).toBe("existing-item-id");
    expect(fetchCalled).toBe(false);
    expect(state.updatedVisibility).toBe(null);
    expect(state.upsertedItem).toBe(null);
  });

  it("widens visibility to shared when a workspace connection captures a note already owned by a personal connection", async () => {
    const { client, state } = createFakeClient({
      granolaConnectionIds: [ids.connection, "other-connection"],
      existingItem: { id: "existing-item-id", source_connection_id: "other-connection", visibility: "private" },
    });
    const { ingestGranolaNote } = await import("../../../ingestion/granola/normalize");

    const result = await ingestGranolaNote(
      { id: ids.connection, workspace_id: ids.workspace, connected_by_user_id: null },
      ids.credential,
      "not_123",
      client,
    );

    expect(result.sourceItemId).toBe("existing-item-id");
    expect(state.updatedVisibility).toEqual({ visibility: "shared", owner_user_id: null });
  });

  it("never narrows an already-shared note back to private", async () => {
    const { client, state } = createFakeClient({
      granolaConnectionIds: [ids.connection, "other-connection"],
      existingItem: { id: "existing-item-id", source_connection_id: "other-connection", visibility: "shared" },
    });
    const { ingestGranolaNote } = await import("../../../ingestion/granola/normalize");

    await ingestGranolaNote(
      { id: ids.connection, workspace_id: ids.workspace, connected_by_user_id: "user-1" },
      ids.credential,
      "not_123",
      client,
    );

    expect(state.updatedVisibility).toBe(null);
  });

  it("proceeds with a normal upsert when the existing item belongs to the same connection", async () => {
    mockFetchSequence([{ status: 200, json: NOTE_FIXTURE }]);
    const { client, state } = createFakeClient({
      granolaConnectionIds: [ids.connection],
      existingItem: { id: "existing-item-id", source_connection_id: ids.connection, visibility: "private" },
    });
    const { ingestGranolaNote } = await import("../../../ingestion/granola/normalize");

    const result = await ingestGranolaNote(
      { id: ids.connection, workspace_id: ids.workspace, connected_by_user_id: "user-1" },
      ids.credential,
      "not_123",
      client,
    );

    expect(result.sourceItemId).toBe("new-item-id");
    expect(state.upsertedItem?.item_type).toBe("meeting_notes");
  });
});

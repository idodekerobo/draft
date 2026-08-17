import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { upsertSourceConnection, upsertSourceItem } from "../../ingestion/upsert-source-item";

const ids = {
  workspace: "88888888-8888-4888-8888-888888888888",
  connection: "99999999-9999-4999-8999-999999999999",
  priorItem: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

interface FakeState {
  priorReadyRevisions: { id: string; external_version: string }[];
  upsertedItem: Record<string, unknown> | null;
  supersedeCalls: string[][];
  connectionUpsertPayload: Record<string, unknown> | null;
}

function createFakeClient(priorReadyRevisions: { id: string; external_version: string }[]) {
  const state: FakeState = {
    priorReadyRevisions,
    upsertedItem: null,
    supersedeCalls: [],
    connectionUpsertPayload: null,
  };

  function from(table: string) {
    if (table === "source_connections") {
      return {
        upsert: (payload: Record<string, unknown>) => {
          state.connectionUpsertPayload = payload;
          return {
            select: () => ({
              single: async () => ({
                data: { id: ids.connection, ...payload },
                error: null,
              }),
            }),
          };
        },
      };
    }

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
        update: (payload: Record<string, unknown>) => ({
          in: async (_col: string, ids_: string[]) => {
            state.supersedeCalls.push(ids_);
            return { error: null };
          },
        }),
      };
    }

    throw new Error(`Unexpected table in fake client: ${table}`);
  }

  return { client: { from } as unknown as SupabaseClient, state };
}

describe("upsertSourceConnection", () => {
  it("upserts on (workspace_id, provider, connection_key)", async () => {
    const { client, state } = createFakeClient([]);
    const connection = await upsertSourceConnection(client, {
      workspace_id: ids.workspace,
      provider: "fireflies",
      connection_key: "founder-primary",
    });

    expect(connection.id).toBe(ids.connection);
    expect(state.connectionUpsertPayload).toMatchObject({
      workspace_id: ids.workspace,
      provider: "fireflies",
      connection_key: "founder-primary",
      status: "active",
    });
  });
});

describe("upsertSourceItem", () => {
  it("upserts a new item with no prior revisions to supersede", async () => {
    const { client, state } = createFakeClient([]);
    const result = await upsertSourceItem(client, {
      workspace_id: ids.workspace,
      source_connection_id: ids.connection,
      item_type: "meeting_transcript",
      external_id: "meeting-1",
      external_version: "hash-a",
      occurred_at: new Date().toISOString(),
      content_markdown: "# Meeting 1",
      content_hash: "hash-a",
    });

    expect(result.item.id).toBe("new-item-id");
    expect(result.supersededItemIds).toEqual([]);
    expect(state.upsertedItem?.supersedes_source_item_id).toBeNull();
    expect(state.supersedeCalls).toEqual([]);
  });

  it("marks prior ready revisions superseded and links via supersedes_source_item_id", async () => {
    const { client, state } = createFakeClient([
      { id: ids.priorItem, external_version: "hash-old" },
    ]);
    const result = await upsertSourceItem(client, {
      workspace_id: ids.workspace,
      source_connection_id: ids.connection,
      item_type: "meeting_transcript",
      external_id: "meeting-1",
      external_version: "hash-new",
      occurred_at: new Date().toISOString(),
      content_markdown: "# Meeting 1 v2",
      content_hash: "hash-new",
    });

    expect(result.supersededItemIds).toEqual([ids.priorItem]);
    expect(state.upsertedItem?.supersedes_source_item_id).toBe(ids.priorItem);
    expect(state.supersedeCalls).toEqual([[ids.priorItem]]);
  });
});

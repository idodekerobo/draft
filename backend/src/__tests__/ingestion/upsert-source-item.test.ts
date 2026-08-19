import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { upsertSourceConnection, upsertSourceItem } from "../../ingestion/upsert-source-item";

const ids = {
  workspace: "88888888-8888-4888-8888-888888888888",
  connection: "99999999-9999-4999-8999-999999999999",
  priorItem: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

interface RpcResult {
  item_id: string;
  changed: boolean;
  superseded_item_ids: string[];
}

interface FakeState {
  rpcParams: Record<string, unknown> | null;
  fetchedItemId: string | null;
  connectionUpsertPayload: Record<string, unknown> | null;
}

// Supersede logic lives in upsert_source_item (db/functions/upsert_source_item.sql);
// this fake only proves the wrapper calls the RPC and reads back its result.
function createFakeClient(rpcResult: RpcResult) {
  const state: FakeState = {
    rpcParams: null,
    fetchedItemId: null,
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
          eq: (_col: string, val: string) => ({
            single: async () => {
              state.fetchedItemId = val;
              return {
                data: {
                  id: val,
                  supersedes_source_item_id: rpcResult.superseded_item_ids[0] ?? null,
                },
                error: null,
              };
            },
          }),
        }),
      };
    }

    throw new Error(`Unexpected table in fake client: ${table}`);
  }

  function rpc(fnName: string, params: Record<string, unknown>) {
    if (fnName !== "upsert_source_item") {
      throw new Error(`Unexpected rpc in fake client: ${fnName}`);
    }
    state.rpcParams = params;
    return Promise.resolve({ data: rpcResult, error: null });
  }

  return { client: { from, rpc } as unknown as SupabaseClient, state };
}

describe("upsertSourceConnection", () => {
  it("upserts on (workspace_id, provider, connection_key)", async () => {
    const { client, state } = createFakeClient({
      item_id: "unused",
      changed: true,
      superseded_item_ids: [],
    });
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
  it("calls the RPC with the input fields and returns the row it wrote", async () => {
    const { client, state } = createFakeClient({
      item_id: "new-item-id",
      changed: true,
      superseded_item_ids: [],
    });
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

    expect(state.rpcParams).toMatchObject({
      p_workspace_id: ids.workspace,
      p_source_connection_id: ids.connection,
      p_item_type: "meeting_transcript",
      p_external_id: "meeting-1",
      p_external_version: "hash-a",
      p_content_markdown: "# Meeting 1",
      p_content_hash: "hash-a",
      p_lifecycle_status: "ready",
    });
    expect(state.fetchedItemId).toBe("new-item-id");
    expect(result.item.id).toBe("new-item-id");
    expect(result.supersededItemIds).toEqual([]);
  });

  it("surfaces the superseded item ids the RPC reports", async () => {
    const { client } = createFakeClient({
      item_id: "new-item-id-2",
      changed: true,
      superseded_item_ids: [ids.priorItem],
    });

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
    expect(result.item.supersedes_source_item_id).toBe(ids.priorItem);
  });
});

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  SourceConnectionProvider,
  SourceConnectionStatus,
  SourceItemLifecycleStatus,
  SourceItemType,
} from "../types/enums";
import type { SourceConnectionRow, SourceItemRow } from "../types/tables";

export interface UpsertSourceConnectionInput {
  workspace_id: string;
  provider: SourceConnectionProvider;
  connection_key: string;
  display_name?: string | null;
  external_account_id?: string | null;
  status?: SourceConnectionStatus;
  credential_id?: string | null;
  config_json?: Record<string, unknown>;
  cursor_json?: Record<string, unknown>;
  connected_by_user_id?: string | null;
}

export async function upsertSourceConnection(
  client: SupabaseClient,
  input: UpsertSourceConnectionInput,
): Promise<SourceConnectionRow> {
  const { data, error } = await client
    .from("source_connections")
    .upsert(
      {
        workspace_id: input.workspace_id,
        provider: input.provider,
        connection_key: input.connection_key,
        display_name: input.display_name ?? null,
        external_account_id: input.external_account_id ?? null,
        // Omitted entirely (not defaulted to "active") when the caller
        // doesn't pass one, so PostgREST's merge-duplicates upsert leaves
        // an existing row's status untouched on conflict -- only a column
        // present in the payload gets written into the ON CONFLICT DO
        // UPDATE SET clause. New rows still get the table's default
        // ('pending') via the column list omission on INSERT.
        ...(input.status !== undefined ? { status: input.status } : {}),
        credential_id: input.credential_id ?? null,
        config_json: input.config_json ?? {},
        cursor_json: input.cursor_json ?? {},
        connected_by_user_id: input.connected_by_user_id ?? null,
      },
      { onConflict: "workspace_id,provider,connection_key" },
    )
    .select()
    .single();
  if (error) throw error;
  return data as SourceConnectionRow;
}

export interface UpsertSourceItemInput {
  workspace_id: string;
  source_connection_id: string;
  item_type: SourceItemType;
  external_id: string;
  // A provider revision id, or a content hash for providers that give none.
  external_version: string;
  occurred_at: string;
  content_markdown: string;
  content_hash: string;
  metadata_json?: Record<string, unknown>;
  sanitized_raw_json?: unknown;
  lifecycle_status?: SourceItemLifecycleStatus;
}

export interface UpsertSourceItemResult {
  item: SourceItemRow;
  supersededItemIds: string[];
}

interface UpsertSourceItemRpcResult {
  item_id: string;
  changed: boolean;
  superseded_item_ids: string[];
}

// Supersede logic lives in the upsert_source_item Postgres function
// (db/functions/upsert_source_item.sql), not here.
export async function upsertSourceItem(
  client: SupabaseClient,
  input: UpsertSourceItemInput,
): Promise<UpsertSourceItemResult> {
  const { data: rpcData, error: rpcError } = await client
    .rpc("upsert_source_item", {
      p_workspace_id: input.workspace_id,
      p_source_connection_id: input.source_connection_id,
      p_item_type: input.item_type,
      p_external_id: input.external_id,
      p_external_version: input.external_version,
      p_occurred_at: input.occurred_at,
      p_content_markdown: input.content_markdown,
      p_content_hash: input.content_hash,
      p_metadata_json: input.metadata_json ?? {},
      p_sanitized_raw_json: input.sanitized_raw_json ?? null,
      p_lifecycle_status: input.lifecycle_status ?? "ready",
    });
  if (rpcError) throw rpcError;

  const result = rpcData as UpsertSourceItemRpcResult;

  const { data: itemData, error: itemError } = await client
    .from("source_items")
    .select()
    .eq("id", result.item_id)
    .single();
  if (itemError) throw itemError;

  return {
    item: itemData as SourceItemRow,
    supersededItemIds: result.superseded_item_ids ?? [],
  };
}

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ConnectionProvider,
  ConnectionStatus,
  SourceItemLifecycleStatus,
  SourceItemType,
  SourceItemVisibility,
} from "../types/enums";
import type { ConnectionRow, SourceItemRow } from "../types/tables";
import type { SourceRepresentationKind, SourceTimeBasis } from "draft-core/sources";

export interface UpsertConnectionInput {
  workspace_id: string;
  provider: ConnectionProvider;
  connection_key: string;
  display_name?: string | null;
  external_account_id?: string | null;
  status?: ConnectionStatus;
  credential_id?: string | null;
  config_json?: Record<string, unknown>;
  cursor_json?: Record<string, unknown>;
  connected_by_user_id?: string | null;
}

export async function upsertConnection(
  client: SupabaseClient,
  input: UpsertConnectionInput,
): Promise<ConnectionRow> {
  const { data, error } = await client
    .from("connections")
    .upsert(
      {
        workspace_id: input.workspace_id,
        provider: input.provider,
        connection_key: input.connection_key,
        display_name: input.display_name ?? null,
        external_account_id: input.external_account_id ?? null,
        // Omitted (not defaulted to "active") when unset, so PostgREST's
        // merge-duplicates upsert leaves an existing row's status untouched.
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
  return data as ConnectionRow;
}

export interface UpsertSourceItemInput {
  workspace_id: string;
  connection_id: string;
  item_type: SourceItemType;
  external_id: string;
  // A provider revision id, or a content hash for providers that give none.
  external_version: string;
  occurred_at: string;
  source_time_start?: string | null;
  source_time_end?: string | null;
  representation_kind?: SourceRepresentationKind;
  time_basis?: SourceTimeBasis;
  captured_session_id?: string | null;
  content_markdown: string;
  content_hash: string;
  metadata_json?: Record<string, unknown>;
  sanitized_raw_json?: unknown;
  lifecycle_status?: SourceItemLifecycleStatus;
  // Defaults to 'shared'/null -- only multi-account providers (fireflies)
  // pass 'private' + the connecting user's id at ingest time.
  visibility?: SourceItemVisibility;
  owner_user_id?: string | null;
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

export function isConnectionInactiveError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "P0001" && candidate.message === "connection_inactive";
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
      p_connection_id: input.connection_id,
      p_item_type: input.item_type,
      p_external_id: input.external_id,
      p_external_version: input.external_version,
      p_occurred_at: input.occurred_at,
      p_content_markdown: input.content_markdown,
      p_content_hash: input.content_hash,
      p_metadata_json: {
        ...(input.metadata_json ?? {}),
        time_basis: input.time_basis ?? "unknown",
      },
      p_sanitized_raw_json: input.sanitized_raw_json ?? null,
      p_lifecycle_status: input.lifecycle_status ?? "active",
      p_visibility: input.visibility ?? "shared",
      p_owner_user_id: input.owner_user_id ?? null,
      p_representation_kind: input.representation_kind ?? "unknown",
      p_source_time_start: input.source_time_start ?? null,
      p_source_time_end: input.source_time_end ?? null,
      p_captured_session_id: input.captured_session_id ?? null,
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

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
        status: input.status ?? "active",
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

// A changed external_version is always a new row (content is never mutated
// once a row is ready), so any prior ready revision of the same external_id
// gets marked superseded here -- otherwise both stay 'ready' and a
// synthesis run reconciles against duplicate content for one item.
export async function upsertSourceItem(
  client: SupabaseClient,
  input: UpsertSourceItemInput,
): Promise<UpsertSourceItemResult> {
  const lifecycleStatus = input.lifecycle_status ?? "ready";

  const { data: priorReadyRevisions, error: priorError } = await client
    .from("source_items")
    .select("id, external_version")
    .eq("source_connection_id", input.source_connection_id)
    .eq("external_id", input.external_id)
    .eq("lifecycle_status", "ready")
    .neq("external_version", input.external_version);
  if (priorError) throw priorError;

  const { data: itemData, error: itemError } = await client
    .from("source_items")
    .upsert(
      {
        workspace_id: input.workspace_id,
        source_connection_id: input.source_connection_id,
        item_type: input.item_type,
        external_id: input.external_id,
        external_version: input.external_version,
        lifecycle_status: lifecycleStatus,
        occurred_at: input.occurred_at,
        normalized_at: new Date().toISOString(),
        content_markdown: input.content_markdown,
        content_hash: input.content_hash,
        metadata_json: input.metadata_json ?? {},
        sanitized_raw_json: input.sanitized_raw_json ?? null,
        supersedes_source_item_id: priorReadyRevisions?.[0]?.id ?? null,
      },
      { onConflict: "source_connection_id,external_id,external_version" },
    )
    .select()
    .single();
  if (itemError) throw itemError;

  const supersededItemIds = (priorReadyRevisions ?? []).map((r) => r.id as string);
  if (supersededItemIds.length > 0) {
    const { error: supersedeError } = await client
      .from("source_items")
      .update({ lifecycle_status: "superseded" })
      .in("id", supersededItemIds);
    if (supersedeError) throw supersedeError;
  }

  return { item: itemData as SourceItemRow, supersededItemIds };
}

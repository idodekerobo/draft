import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchGranolaNoteWithTranscriptFallback, type GranolaNote } from "./fetch-note";
import { upsertSourceItem } from "../upsert-source-item";
import { insertEvent } from "../../events/insert-event";
import { resolveProviderCredentialById } from "../../credentials/resolve-provider-credential";
import type { SourceItemVisibility } from "../../types/enums";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Renders a Granola note's summary and transcript as the item's markdown body. */
export function buildGranolaContentMarkdown(note: GranolaNote): string {
  const transcriptText = (note.transcript ?? [])
    .map((item) => item.text)
    .filter((text) => text.length > 0)
    .join("\n");

  const sections: string[] = [];
  if (note.summary) sections.push(`## Summary\n\n${note.summary}`);
  if (transcriptText) sections.push(`## Transcript\n\n${transcriptText}`);

  return `# ${note.title}

${sections.join("\n\n")}
`;
}

/** Deterministic revision id -- Granola gives none, so this hashes the rendered markdown plus the raw note. */
export function buildGranolaExternalVersion(contentMarkdown: string, sanitizedRaw: GranolaNote): string {
  return sha256(JSON.stringify({ contentMarkdown, sanitizedRaw }));
}

interface LiveGranolaSourceItem {
  id: string;
  source_connection_id: string;
  visibility: SourceItemVisibility;
}

/**
 * Finds the workspace's current `ready` source_item for a Granola note
 * across every Granola connection, not just the caller's -- personal and
 * workspace scopes can both see the same note.
 */
async function findLiveGranolaSourceItem(
  db: SupabaseClient,
  workspaceId: string,
  noteId: string,
): Promise<LiveGranolaSourceItem | null> {
  const { data: connections, error: connectionsError } = await db
    .from("source_connections")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("provider", "granola");
  if (connectionsError) throw connectionsError;

  const connectionIds = ((connections ?? []) as { id: string }[]).map((row) => row.id);
  if (connectionIds.length === 0) return null;

  const { data, error } = await db
    .from("source_items")
    .select("id, source_connection_id, visibility")
    .eq("workspace_id", workspaceId)
    .eq("external_id", noteId)
    .eq("lifecycle_status", "ready")
    .in("source_connection_id", connectionIds)
    .maybeSingle();
  if (error) throw error;
  return data as LiveGranolaSourceItem | null;
}

/**
 * Fetches a Granola note and writes it as a source_item. If another Granola
 * connection in the workspace already owns this note (personal and
 * workspace scopes can overlap on the same note), skips writing a second
 * row -- the owning connection's own webhook keeps it in sync -- and widens
 * `private` to `shared` if this delivery proves the note is workspace-visible,
 * but never narrows the other way.
 */
export async function ingestGranolaNote(
  connection: { id: string; workspace_id: string; connected_by_user_id?: string | null },
  credentialId: string,
  noteId: string,
  client?: SupabaseClient,
): Promise<{ sourceItemId: string }> {
  const db = client ?? (await import("../../db/client")).serviceClient;
  const visibility: SourceItemVisibility = connection.connected_by_user_id ? "private" : "shared";

  const existing = await findLiveGranolaSourceItem(db, connection.workspace_id, noteId);
  if (existing && existing.source_connection_id !== connection.id) {
    if (existing.visibility === "private" && visibility === "shared") {
      const { error } = await db
        .from("source_items")
        .update({ visibility: "shared", owner_user_id: null })
        .eq("id", existing.id)
        .eq("workspace_id", connection.workspace_id);
      if (error) throw error;
    }
    return { sourceItemId: existing.id };
  }

  const { api_token: apiToken } = await resolveProviderCredentialById(
    connection.workspace_id,
    "granola",
    credentialId,
    client,
  );

  const note = await fetchGranolaNoteWithTranscriptFallback(apiToken, noteId);
  const contentMarkdown = buildGranolaContentMarkdown(note);
  const contentHash = sha256(contentMarkdown);
  const externalVersion = buildGranolaExternalVersion(contentMarkdown, note);

  const result = await upsertSourceItem(db, {
    workspace_id: connection.workspace_id,
    source_connection_id: connection.id,
    item_type: "meeting_notes",
    external_id: noteId,
    external_version: externalVersion,
    occurred_at: note.created_at ?? new Date().toISOString(),
    content_markdown: contentMarkdown,
    content_hash: contentHash,
    metadata_json: {
      title: note.title,
      granola_note_id: noteId,
    },
    sanitized_raw_json: note,
    visibility,
    owner_user_id: connection.connected_by_user_id ?? null,
  });

  await insertEvent(db, connection.workspace_id, {
    event_type: "source_items_added",
    source_connection_id: connection.id,
    summary: note.title,
  });

  return { sourceItemId: result.item.id };
}

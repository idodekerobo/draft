import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchFirefliesMeeting, type FirefliesMeetingData } from "./fetch-meeting";
import { upsertSourceItem } from "../upsert-source-item";
import { insertEvent } from "../../events/insert-event";
import { resolveProviderCredentialById } from "../../credentials/resolve-provider-credential";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function buildFirefliesContentMarkdown(meeting: FirefliesMeetingData): string {
  const sections: string[] = [];

  if (meeting.shortSummary) {
    sections.push(`## Short Summary\n\n${meeting.shortSummary}`);
  }
  if (meeting.overview) {
    sections.push(`## Overview\n\n${meeting.overview}`);
  }
  if (meeting.actionItems) {
    sections.push(`## Action Items\n\n${meeting.actionItems}`);
  }
  if (meeting.outline) {
    sections.push(`## Outline\n\n${meeting.outline}`);
  }

  return `# ${meeting.title}

**Date:** ${meeting.occurredAt}
**Attendees:** ${meeting.attendees.join(", ")}

${sections.join("\n\n")}
`;
}

export function buildFirefliesSanitizedRaw(meeting: FirefliesMeetingData): FirefliesMeetingData {
  return {
    meetingId: meeting.meetingId,
    title: meeting.title,
    occurredAt: meeting.occurredAt,
    attendees: [...meeting.attendees],
    ...(meeting.shortSummary !== undefined ? { shortSummary: meeting.shortSummary } : {}),
    ...(meeting.overview !== undefined ? { overview: meeting.overview } : {}),
    ...(meeting.actionItems !== undefined ? { actionItems: meeting.actionItems } : {}),
    ...(meeting.outline !== undefined ? { outline: meeting.outline } : {}),
    sentences: meeting.sentences.map(({ speakerName, text }) => ({ speakerName, text })),
  };
}

export function buildFirefliesExternalVersion(
  contentMarkdown: string,
  sanitizedRaw: FirefliesMeetingData,
): string {
  return sha256(JSON.stringify({ contentMarkdown, sanitizedRaw }));
}

/**
 * Finds the workspace's current `ready` source_item for a Fireflies meeting
 * across every Fireflies connection, not just the caller's -- Fireflies'
 * Team feature has one bot join on behalf of whoever invited it first, so
 * teammates on the same Fireflies team can each independently fetch the
 * same meeting_id through their own connection.
 */
async function findLiveFirefliesSourceItem(
  db: SupabaseClient,
  workspaceId: string,
  meetingId: string,
): Promise<{ id: string; source_connection_id: string } | null> {
  const { data: connections, error: connectionsError } = await db
    .from("source_connections")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("provider", "fireflies");
  if (connectionsError) throw connectionsError;

  const connectionIds = ((connections ?? []) as { id: string }[]).map((row) => row.id);
  if (connectionIds.length === 0) return null;

  const { data, error } = await db
    .from("source_items")
    .select("id, source_connection_id")
    .eq("workspace_id", workspaceId)
    .eq("external_id", meetingId)
    .eq("lifecycle_status", "ready")
    .in("source_connection_id", connectionIds)
    .maybeSingle();
  if (error) throw error;
  return data as { id: string; source_connection_id: string } | null;
}

export async function ingestFirefliesMeeting(
  connection: { id: string; workspace_id: string; connected_by_user_id?: string | null },
  credentialId: string,
  meetingId: string,
  client?: SupabaseClient,
): Promise<{ sourceItemId: string }> {
  const db = client ?? (await import("../../db/client")).serviceClient;

  // Dedup only -- visibility stays whatever the first-ingesting connection set
  // (always 'private' today). Skipping here means the meeting stays owned by
  // whoever's connection saw it first; it does NOT become visible to the
  // second teammate unless a future widen decision is made, same as Granola's.
  const existing = await findLiveFirefliesSourceItem(db, connection.workspace_id, meetingId);
  if (existing && existing.source_connection_id !== connection.id) {
    return { sourceItemId: existing.id };
  }

  const { api_token: apiToken } = await resolveProviderCredentialById(
    connection.workspace_id,
    "fireflies",
    credentialId,
    client,
  );

  const meeting = await fetchFirefliesMeeting(apiToken, meetingId);
  const contentMarkdown = buildFirefliesContentMarkdown(meeting);
  const contentHash = sha256(contentMarkdown);
  const sanitizedRaw = buildFirefliesSanitizedRaw(meeting);
  const externalVersion = buildFirefliesExternalVersion(contentMarkdown, sanitizedRaw);

  const result = await upsertSourceItem(db, {
    workspace_id: connection.workspace_id,
    source_connection_id: connection.id,
    item_type: "meeting_transcript",
    external_id: meetingId,
    // Fireflies gives no revision id, so include both synthesis content and
    // structured transcript data in the deterministic revision hash.
    external_version: externalVersion,
    occurred_at: meeting.occurredAt,
    content_markdown: contentMarkdown,
    content_hash: contentHash,
    metadata_json: {
      title: meeting.title,
      attendees: meeting.attendees,
      fireflies_meeting_id: meetingId,
    },
    sanitized_raw_json: sanitizedRaw,
    // Fireflies is a multi-account provider -- meetings are private to the
    // connecting teammate by default (no widen action exists yet).
    visibility: "private",
    owner_user_id: connection.connected_by_user_id ?? null,
  });

  await insertEvent(db, connection.workspace_id, {
    event_type: "source_items_added",
    source_connection_id: connection.id,
    summary: meeting.title,
  });

  return { sourceItemId: result.item.id };
}

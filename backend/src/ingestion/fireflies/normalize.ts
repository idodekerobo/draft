import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchFirefliesMeeting, type FirefliesMeetingData } from "./fetch-meeting";
import { upsertSourceItem } from "../upsert-source-item";
import { insertEvent } from "../../events/insert-event";
import { resolveProviderCredentialById } from "../../credentials/resolve-provider-credential";
import type { SourceItemVisibility } from "../../types/enums";

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

interface LiveFirefliesSourceItem {
  id: string;
  source_connection_id: string;
  visibility: SourceItemVisibility;
}

/**
 * Finds the workspace's current active source_item for a Fireflies meeting
 * across every Fireflies connection, not just the caller's -- Fireflies'
 * Team feature has one bot join on behalf of whoever invited it first, so
 * teammates on the same Fireflies team can each independently fetch the
 * same meeting_id through their own connection.
 */
async function findLiveFirefliesSourceItem(
  db: SupabaseClient,
  workspaceId: string,
  meetingId: string,
): Promise<LiveFirefliesSourceItem | null> {
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
    .select("id, source_connection_id, visibility")
    .eq("workspace_id", workspaceId)
    .eq("external_id", meetingId)
    .eq("lifecycle_status", "active")
    .in("source_connection_id", connectionIds)
    .maybeSingle();
  if (error) throw error;
  return data as LiveFirefliesSourceItem | null;
}

export async function ingestFirefliesMeeting(
  connection: { id: string; workspace_id: string; connected_by_user_id?: string | null },
  credentialId: string,
  meetingId: string,
  client?: SupabaseClient,
): Promise<{ sourceItemId: string }> {
  const db = client ?? (await import("../../db/client")).serviceClient;

  // A second teammate's connection independently fetching the same meeting_id
  // is proof this meeting isn't exclusive to the first owner -- visibility has
  // no in-between state, so this widens private -> shared (clearing owner_user_id)
  // and never narrows the other way, same as Granola's cross-connection widen.
  const existing = await findLiveFirefliesSourceItem(db, connection.workspace_id, meetingId);
  if (existing && existing.source_connection_id !== connection.id) {
    if (existing.visibility === "private") {
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
    representation_kind: "summary",
    source_time_start: meeting.occurredAt,
    source_time_end: meeting.occurredAt,
    time_basis: "source_event",
    metadata_json: {
      title: meeting.title,
      attendees: meeting.attendees,
      fireflies_meeting_id: meetingId,
    },
    sanitized_raw_json: sanitizedRaw,
    // Fireflies is a multi-account provider -- meetings start private to the
    // first connecting teammate; widened to 'shared' above if another
    // teammate's connection later proves it's not exclusive to them.
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

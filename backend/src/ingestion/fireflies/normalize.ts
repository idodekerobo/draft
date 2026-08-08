import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchFirefliesMeeting, type FirefliesMeetingData } from "./fetch-meeting";
import { upsertSourceItem } from "../upsert-source-item";
import { insertEvent } from "../../events/insert-event";
import { resolveProviderCredential } from "../../credentials/resolve-provider-credential";

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

export async function ingestFirefliesMeeting(
  connection: { id: string; workspace_id: string },
  meetingId: string,
  client?: SupabaseClient,
): Promise<{ sourceItemId: string }> {
  const { api_token: apiToken } = await resolveProviderCredential(
    connection.workspace_id,
    "fireflies",
    client,
  );

  const meeting = await fetchFirefliesMeeting(apiToken, meetingId);
  const contentMarkdown = buildFirefliesContentMarkdown(meeting);
  const contentHash = sha256(contentMarkdown);
  const sanitizedRaw = buildFirefliesSanitizedRaw(meeting);
  const externalVersion = buildFirefliesExternalVersion(contentMarkdown, sanitizedRaw);

  const db = client ?? (await import("../../db/client")).serviceClient;

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
  });

  await insertEvent(db, connection.workspace_id, {
    event_type: "source_items_added",
    source_connection_id: connection.id,
    summary: meeting.title,
  });

  return { sourceItemId: result.item.id };
}

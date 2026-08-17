// The same starting cursor plus the same set of captured messages must
// always produce the same external_id and rendered content_markdown, so a
// crash mid-commit is safe to retry -- it re-derives the identical batch.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { renderSlackMessages } from "./render";
import { loadSlackBatchLimits, type SlackBatchLimits } from "./config";
import type { SlackMessageRow } from "./types";
import { upsertSourceItem } from "../upsert-source-item";
import { insertEvent } from "../../events/insert-event";
import type { ScheduledTaskRow } from "../../types/tables";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function byteLength(content: string): number {
  return new TextEncoder().encode(content).length;
}

// Slack message_ts is "<seconds>.<microseconds>" (e.g. "1622547800.123456").
// parseFloat handles the fractional part fine for millisecond-resolution math.
function tsToMs(ts: string): number {
  return parseFloat(ts) * 1000;
}

export interface MaterializeSlackBatchesConnectionInput {
  id: string;
  workspace_id: string;
  cursor_json: Record<string, unknown>;
}

interface SlackCursorChannelState {
  last_batched_message_ts?: string;
}

interface SlackCursorShape {
  channels?: Record<string, SlackCursorChannelState>;
  [key: string]: unknown;
}

function getChannelCursor(cursorJson: Record<string, unknown>, channelId: string): string | undefined {
  const shape = cursorJson as SlackCursorShape;
  return shape.channels?.[channelId]?.last_batched_message_ts;
}

function withChannelCursor(
  cursorJson: Record<string, unknown>,
  channelId: string,
  lastBatchedMessageTs: string,
): Record<string, unknown> {
  const shape = cursorJson as SlackCursorShape;
  return {
    ...cursorJson,
    channels: {
      ...(shape.channels ?? {}),
      [channelId]: {
        ...(shape.channels?.[channelId] ?? {}),
        last_batched_message_ts: lastBatchedMessageTs,
      },
    },
  };
}

async function getChannelIdsWithMessages(
  client: SupabaseClient,
  connectionId: string,
): Promise<string[]> {
  const { data, error } = await client
    .from("slack_messages")
    .select("channel_id")
    .eq("source_connection_id", connectionId);
  if (error) throw error;
  const channelIds = new Set<string>();
  for (const row of (data ?? []) as { channel_id: string }[]) {
    channelIds.add(row.channel_id);
  }
  return [...channelIds];
}

async function getPendingMessages(
  client: SupabaseClient,
  connectionId: string,
  channelId: string,
  cursorTs: string | undefined,
): Promise<SlackMessageRow[]> {
  let query = client
    .from("slack_messages")
    .select("*")
    .eq("source_connection_id", connectionId)
    .eq("channel_id", channelId)
    .order("message_ts", { ascending: true });
  // Cursor points at the last message already batched -- `>` excludes it
  // without skipping the next one.
  if (cursorTs !== undefined) {
    query = query.gt("message_ts", cursorTs);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as SlackMessageRow[];
}

interface CommittedBatch {
  channelId: string;
  messageIds: string[];
  lastMessageTs: string;
  messageCount: number;
}

async function commitBatch(
  client: SupabaseClient,
  connection: { id: string; workspace_id: string },
  channelId: string,
  batch: SlackMessageRow[],
  contentMarkdown: string,
): Promise<CommittedBatch> {
  const first = batch[0]!;
  const last = batch[batch.length - 1]!;

  const externalId = `${channelId}:${first.message_ts}`;
  const contentHash = sha256(contentMarkdown);

  const { item } = await upsertSourceItem(client, {
    workspace_id: connection.workspace_id,
    source_connection_id: connection.id,
    item_type: "message",
    external_id: externalId,
    external_version: contentHash,
    occurred_at: new Date(tsToMs(last.message_ts)).toISOString(),
    content_markdown: contentMarkdown,
    content_hash: contentHash,
    metadata_json: {
      channel_id: channelId,
      message_count: batch.length,
      first_message_ts: first.message_ts,
      last_message_ts: last.message_ts,
    },
  });

  await insertEvent(client, connection.workspace_id, {
    event_type: "source_items_added",
    source_connection_id: connection.id,
    summary: `Batched ${batch.length} Slack message(s) from channel ${channelId}`,
    payload_json: {
      channel_id: channelId,
      message_count: batch.length,
      source_item_id: item.id,
    },
  });

  const messageIds = batch.map((m) => m.id);
  const { error: linkError } = await client
    .from("slack_messages")
    .update({ source_item_id: item.id })
    .in("id", messageIds);
  if (linkError) throw linkError;

  return {
    channelId,
    messageIds,
    lastMessageTs: last.message_ts,
    messageCount: batch.length,
  };
}

// Span/count thresholds keep the triggering message in the batch that
// crosses them; the byte-size threshold instead excludes it and seeds the
// next batch, so a committed batch's content_markdown never exceeds the
// budget (a lone oversized message ships alone rather than stalling).
async function materializeChannelBatches(
  client: SupabaseClient,
  connection: { id: string; workspace_id: string },
  channelId: string,
  messages: SlackMessageRow[],
  limits: SlackBatchLimits,
): Promise<{ committed: CommittedBatch[] }> {
  const committed: CommittedBatch[] = [];
  let batch: SlackMessageRow[] = [];

  for (const message of messages) {
    batch.push(message);

    let content = await renderSlackMessages(
      batch.map((m) => m.id),
      client,
    );
    let bytes = byteLength(content);

    if (bytes >= limits.maxContentBytes && batch.length > 1) {
      const overflow = batch.pop()!;
      content = await renderSlackMessages(
        batch.map((m) => m.id),
        client,
      );
      committed.push(await commitBatch(client, connection, channelId, batch, content));
      batch = [overflow];
      continue;
    }

    const first = batch[0]!;
    const spanMs = tsToMs(message.message_ts) - tsToMs(first.message_ts);
    const countCrossed = batch.length >= limits.maxMessageCount;
    const spanCrossed = spanMs > limits.maxSpanMs;
    const sizeCrossedAlone = bytes >= limits.maxContentBytes && batch.length === 1;

    if (countCrossed || spanCrossed || sizeCrossedAlone) {
      committed.push(await commitBatch(client, connection, channelId, batch, content));
      batch = [];
    }
  }

  return { committed };
}

export interface MaterializeSlackBatchesResult {
  batchesCut: number;
  updatedCursorJson: Record<string, unknown>;
}

export async function materializeSlackBatches(
  connection: MaterializeSlackBatchesConnectionInput,
  client?: SupabaseClient,
): Promise<MaterializeSlackBatchesResult> {
  const db = client ?? (await import("../../db/client")).serviceClient;
  const limits = loadSlackBatchLimits();

  let cursorJson = connection.cursor_json;
  let batchesCut = 0;

  const channelIds = await getChannelIdsWithMessages(db, connection.id);

  for (const channelId of channelIds) {
    const cursorTs = getChannelCursor(cursorJson, channelId);
    const messages = await getPendingMessages(db, connection.id, channelId, cursorTs);
    if (messages.length === 0) continue;

    const { committed } = await materializeChannelBatches(
      db,
      connection,
      channelId,
      messages,
      limits,
    );

    // Cursor is persisted after each cut, not just at the end of the pass,
    // so a crash between two cuts leaves it at the last fully committed batch.
    for (const batch of committed) {
      cursorJson = withChannelCursor(cursorJson, channelId, batch.lastMessageTs);
      const { error } = await db
        .from("source_connections")
        .update({ cursor_json: cursorJson })
        .eq("id", connection.id)
        .eq("workspace_id", connection.workspace_id);
      if (error) throw error;
      batchesCut += 1;
    }
  }

  return { batchesCut, updatedCursorJson: cursorJson };
}

// This is the primary path from captured messages to source_items (not a
// backstop like Fireflies' reconciliation), so it runs on a tighter cadence.
const MATERIALIZATION_INTERVAL_SECONDS = 5 * 60;

export interface RegisterSlackBatchMaterializationTaskConnection {
  id: string;
  workspace_id: string;
}

export async function registerSlackBatchMaterializationTask(
  connection: RegisterSlackBatchMaterializationTaskConnection,
  client?: SupabaseClient,
): Promise<void> {
  const db = client ?? (await import("../../db/client")).serviceClient;

  // next_due_at must be set here, or the tick never selects this row.
  const nextDueAt = new Date(Date.now() + MATERIALIZATION_INTERVAL_SECONDS * 1000);

  const { error } = await db.from("scheduled_tasks").upsert(
    {
      workspace_id: connection.workspace_id,
      source_connection_id: connection.id,
      task_type: "ingest_source",
      task_key: connection.id,
      schedule_kind: "interval",
      interval_seconds: MATERIALIZATION_INTERVAL_SECONDS,
      cron_expression: null,
      timezone: "UTC",
      enabled: true,
      next_due_at: nextDueAt.toISOString(),
    } satisfies Partial<ScheduledTaskRow>,
    { onConflict: "workspace_id,task_type,task_key" },
  );
  if (error) throw error;
}

// The same starting cursor plus the same set of captured messages must
// always produce the same external_id and rendered content_markdown, so a
// crash mid-commit is safe to retry -- it re-derives the identical batch.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { renderSlackMessageRows } from "./render";
import { loadSlackBatchLimits, type SlackBatchLimits } from "./config";
import type { SlackMessageRow } from "./types";
import { isConnectionInactiveError } from "../upsert-source-item";
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

async function getPendingChannelIds(
  client: SupabaseClient,
  workspaceId: string,
  connectionId: string,
): Promise<string[]> {
  const channelIds: string[] = [];
  let after: string | null = null;
  while (true) {
    const { data, error } = await client.rpc("get_pending_slack_channel_ids", {
      p_workspace_id: workspaceId,
      p_source_connection_id: connectionId,
      p_after_channel_id: after,
      p_limit: 100,
    });
    if (error) throw error;
    const page = (data ?? []) as { channel_id: string }[];
    channelIds.push(...page.map((row) => row.channel_id));
    if (page.length < 100) break;
    after = page[page.length - 1]!.channel_id;
  }
  return channelIds;
}

async function getPendingMessages(
  client: SupabaseClient,
  workspaceId: string,
  connectionId: string,
  channelId: string,
): Promise<SlackMessageRow[]> {
  const query = client
    .from("slack_messages")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("source_connection_id", connectionId)
    .eq("channel_id", channelId)
    .is("source_item_id", null)
    .order("message_ts", { ascending: true })
    .order("id", { ascending: true })
    .limit(1000);
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
): Promise<CommittedBatch | null> {
  const first = batch[0]!;
  const last = batch[batch.length - 1]!;

  const externalId = `${channelId}:${first.message_ts}`;
  const contentHash = sha256(contentMarkdown);

  const messageIds = batch.map((message) => message.id);
  const { data, error } = await client.rpc("commit_slack_source_batch", {
    p_workspace_id: connection.workspace_id,
    p_source_connection_id: connection.id,
    p_channel_id: channelId,
    p_message_ids: messageIds,
    p_external_id: externalId,
    p_external_version: contentHash,
    p_occurred_at: new Date(tsToMs(last.message_ts)).toISOString(),
    p_source_time_start: new Date(tsToMs(first.message_ts)).toISOString(),
    p_source_time_end: new Date(tsToMs(last.message_ts)).toISOString(),
    p_content_markdown: contentMarkdown,
    p_content_hash: contentHash,
    p_metadata_json: {
      channel_id: channelId,
      message_count: batch.length,
      first_message_ts: first.message_ts,
      last_message_ts: last.message_ts,
    },
  });
  if (error) throw error;
  if ((data as { status?: string } | null)?.status === "stale_batch") return null;

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

    let content = renderSlackMessageRows(batch);
    const bytes = byteLength(content);

    if (bytes >= limits.maxContentBytes && batch.length > 1) {
      const overflow = batch.pop()!;
      content = renderSlackMessageRows(batch);
      const cut = await commitBatch(client, connection, channelId, batch, content);
      if (cut) committed.push(cut);
      batch = [overflow];
      continue;
    }

    const first = batch[0]!;
    const spanMs = tsToMs(message.message_ts) - tsToMs(first.message_ts);
    const countCrossed = batch.length >= limits.maxMessageCount;
    const spanCrossed = spanMs > limits.maxSpanMs;
    const sizeCrossedAlone = bytes >= limits.maxContentBytes && batch.length === 1;

    if (countCrossed || spanCrossed || sizeCrossedAlone) {
      const cut = await commitBatch(client, connection, channelId, batch, content);
      if (cut) committed.push(cut);
      batch = [];
    }
  }

  if (batch.length > 0) {
    const cut = await commitBatch(client, connection, channelId, batch, renderSlackMessageRows(batch));
    if (cut) committed.push(cut);
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

  try {
    const channelIds = await getPendingChannelIds(db, connection.workspace_id, connection.id);

    for (const channelId of channelIds) {
      const messages = await getPendingMessages(db, connection.workspace_id, connection.id, channelId);
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
  } catch (error) {
    if (!isConnectionInactiveError(error)) throw error;
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

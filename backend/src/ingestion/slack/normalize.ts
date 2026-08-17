// message_changed/message_deleted nest the real content at event.message /
// event.previous_message, not at the top level -- classify by subtype
// before reading any other field, or you'll capture the wrong ts/text.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SlackMessageFileRef, SlackMessageRow } from "./types";

const SKIP_SUBTYPES = new Set([
  "bot_message",
  "channel_join",
  "channel_leave",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "thread_broadcast",
]);

const DEFERRED_SUBTYPES = new Set(["message_changed", "message_deleted"]);

export interface SlackMessageEventContext {
  connectionId: string;
  workspaceId: string;
  organizationId: string;
  channelId: string;
  channelName?: string | null;
  botToken: string;
}

interface RawSlackFile {
  id: string;
  name: string;
  mimetype?: string;
  size?: number;
  url_private: string;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

function structuredLog(
  level: "info" | "warn" | "error",
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    component: "slack-normalize",
    msg,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function logDeferredEdit(
  subtype: "message_changed" | "message_deleted",
  rawEvent: Record<string, unknown>,
  ctx: SlackMessageEventContext,
): void {
  const nested =
    subtype === "message_changed"
      ? (rawEvent.message as Record<string, unknown> | undefined)
      : (rawEvent.previous_message as Record<string, unknown> | undefined);
  const nestedTs = (nested?.ts as string | undefined) ?? null;

  structuredLog("info", "deferred edit/delete event — not applied to slack_messages", {
    event: "slack_message_edit_deferred",
    subtype,
    connection_id: ctx.connectionId,
    channel_id: ctx.channelId,
    envelope_ts: (rawEvent.ts as string | undefined) ?? null,
    nested_message_ts: nestedTs,
  });
}

async function downloadAndStoreFile(
  raw: RawSlackFile,
  ctx: SlackMessageEventContext,
  client: SupabaseClient,
): Promise<SlackMessageFileRef | null> {
  try {
    const response = await fetch(raw.url_private, {
      headers: { Authorization: `Bearer ${ctx.botToken}` },
    });
    if (!response.ok) {
      structuredLog("warn", `file download failed (${response.status})`, {
        file_id: raw.id,
        file_name: raw.name,
      });
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentHash = createHash("sha256").update(buffer).digest("hex");
    const safeName = sanitizeFilename(raw.name);
    const objectKey = `slack/${ctx.organizationId}/${ctx.workspaceId}/${ctx.channelId}/${raw.id}-${safeName}`;

    const { error } = await client.storage
      .from("slack-attachments")
      .upload(objectKey, buffer, {
        contentType: raw.mimetype,
        upsert: true,
      });
    if (error) {
      structuredLog("error", `file upload failed: ${error.message}`, {
        file_id: raw.id,
        object_key: objectKey,
      });
      return null;
    }

    // Never store raw/signed Slack URLs -- only the durable object key +
    // content hash, per the hard requirement.
    return {
      file_id: raw.id,
      name: raw.name,
      mimetype: raw.mimetype ?? null,
      size_bytes: raw.size ?? null,
      object_key: objectKey,
      content_hash: contentHash,
    };
  } catch (err) {
    structuredLog("error", `file download error: ${err}`, {
      file_id: raw.id,
      file_name: raw.name,
    });
    return null;
  }
}

async function upsertSlackMessageRow(
  client: SupabaseClient,
  row: Omit<SlackMessageRow, "id" | "created_at" | "updated_at">,
): Promise<void> {
  const { error } = await client.from("slack_messages").upsert(row, {
    onConflict: "source_connection_id,channel_id,message_ts,message_version",
  });
  if (error) throw error;
}

export async function handleSlackMessageEvent(
  rawEvent: Record<string, unknown>,
  ctx: SlackMessageEventContext,
  client?: SupabaseClient,
): Promise<void> {
  const subtype = (rawEvent.subtype as string | undefined) ?? null;

  if (subtype === "message_changed" || subtype === "message_deleted") {
    logDeferredEdit(subtype, rawEvent, ctx);
    return;
  }

  if (subtype && SKIP_SUBTYPES.has(subtype)) return;

  const db = client ?? (await import("../../db/client")).serviceClient;

  const channelId = (rawEvent.channel as string | undefined) ?? ctx.channelId;
  const ts = rawEvent.ts as string;
  const text = (rawEvent.text as string | undefined) ?? null;
  const userId = (rawEvent.user as string | undefined) ?? null;
  const threadTs = (rawEvent.thread_ts as string | undefined) ?? null;
  const parentUserId = (rawEvent.parent_user_id as string | undefined) ?? null;

  const rawFiles = (rawEvent.files as RawSlackFile[] | undefined) ?? [];
  const files: SlackMessageFileRef[] = [];
  for (const raw of rawFiles) {
    const stored = await downloadAndStoreFile(raw, { ...ctx, channelId }, db);
    if (stored) files.push(stored);
  }

  await upsertSlackMessageRow(db, {
    workspace_id: ctx.workspaceId,
    source_connection_id: ctx.connectionId,
    source_item_id: null,
    channel_id: channelId,
    channel_name_snapshot: ctx.channelName ?? null,
    message_ts: ts,
    message_version: ts,
    thread_ts: threadTs,
    parent_user_id: parentUserId,
    slack_user_id: userId,
    // Best-effort only -- resolving real display names requires a
    // users.info Web API call this module doesn't make; some event
    // payloads (e.g. bot posts) include `username` directly.
    user_name_snapshot: (rawEvent.username as string | undefined) ?? null,
    text,
    subtype,
    is_deleted: false,
    edited_at: null,
    deleted_at: null,
    blocks_json: (rawEvent.blocks as unknown[] | undefined) ?? [],
    files_json: files,
    reactions_json: [],
    provider_metadata_json: {
      event_id: (rawEvent.event_id as string | undefined) ?? null,
    },
    captured_at: new Date().toISOString(),
  });
}

export { DEFERRED_SUBTYPES, SKIP_SUBTYPES };

// Seven-day (configurable) historical Slack backfill. Runs as its own
// scheduled task per Slack connection, separate from the live socket
// listener and the batch materializer: it only ever writes into
// slack_messages via the same raw-capture path live events use
// (handleSlackMessageEvent), then leaves rolling those rows into
// source_items to the existing materializer. It never writes source_items
// directly.
//
// Progress is checkpointed into source_connections.cursor_json under a
// dedicated `slack_backfill` key so it survives restarts and resumes
// exactly where it left off, one channel and one thread at a time.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchSlackConversationHistory,
  fetchSlackConversationReplies,
  SlackRateLimitedError,
} from "draft-core/integrations/slack-hosted";
import { handleSlackMessageEvent, type SlackMessageEventContext } from "./normalize";
import { resolveProviderCredentialById } from "../../credentials/resolve-provider-credential";
import { redactString } from "../../errors/record-error";
import type { ScheduledTaskRow } from "../../types/tables";

export const SLACK_BACKFILL_DEFAULT_DAYS = 7;
export const SLACK_BACKFILL_MAX_REQUESTS_PER_DISPATCH = 10;
export const SLACK_BACKFILL_PAGE_LIMIT = 200;
const MESSAGE_INGEST_CONCURRENCY = 10;

// Each message's ingest is an independent upsert (its own row lock, no
// ordering dependency on the others in the page), so a page of up to
// SLACK_BACKFILL_PAGE_LIMIT messages doesn't need to go one at a time --
// just bounded so a page doesn't open hundreds of connections at once.
async function ingestMessagesConcurrently(
  messages: Array<Record<string, unknown>>,
  ingest: (message: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < messages.length; i += MESSAGE_INGEST_CONCURRENCY) {
    await Promise.all(messages.slice(i, i + MESSAGE_INGEST_CONCURRENCY).map(ingest));
  }
}
const SLACK_BACKFILL_INTERVAL_SECONDS = 60;

export type SlackBackfillStatus = "in_progress" | "partial" | "completed";

export interface SlackBackfillState {
  status: SlackBackfillStatus;
  cutoff: string;
  pending_channel_ids: string[];
  current_channel_id: string | null;
  history_cursor: string | null;
  history_done: boolean;
  pending_reply_thread_ts: string[];
  current_thread_ts: string | null;
  replies_cursor: string | null;
  done_channel_ids: string[];
  next_eligible_attempt_at: string | null;
  completed_at: string | null;
  last_error: string | null;
}

function loadBackfillDays(): number {
  const raw = process.env.DRAFT_SLACK_BACKFILL_DAYS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SLACK_BACKFILL_DEFAULT_DAYS;
}

export function resolveSlackBackfillCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - loadBackfillDays() * 24 * 60 * 60 * 1000).toISOString();
}

// Slack's `oldest`/`ts` params are Unix seconds with optional microseconds.
function toSlackTimestamp(iso: string): string {
  return (new Date(iso).getTime() / 1000).toFixed(6);
}

export function readSlackChannelIds(configJson: Record<string, unknown> | null | undefined): string[] {
  const raw = (configJson as { channel_ids?: unknown } | null)?.channel_ids;
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
}

export function buildInitialSlackBackfillState(
  channelIds: string[],
  now: Date = new Date(),
): SlackBackfillState {
  const hasChannels = channelIds.length > 0;
  return {
    status: hasChannels ? "in_progress" : "completed",
    cutoff: resolveSlackBackfillCutoff(now),
    pending_channel_ids: [...channelIds],
    current_channel_id: null,
    history_cursor: null,
    history_done: false,
    pending_reply_thread_ts: [],
    current_thread_ts: null,
    replies_cursor: null,
    done_channel_ids: [],
    next_eligible_attempt_at: null,
    completed_at: hasChannels ? null : now.toISOString(),
    last_error: null,
  };
}

function isSlackBackfillState(value: unknown): value is SlackBackfillState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<SlackBackfillState>;
  return (
    typeof state.status === "string" &&
    typeof state.cutoff === "string" &&
    Array.isArray(state.pending_channel_ids) &&
    Array.isArray(state.pending_reply_thread_ts) &&
    Array.isArray(state.done_channel_ids)
  );
}

// Called once when a Slack connection activates (fresh connect or
// reconnect) -- fixes the cutoff and channel queue for this activation so a
// later retry never moves the window out from under an in-progress pass.
export async function initializeSlackBackfillForConnection(
  connection: { id: string; workspace_id: string },
  client: SupabaseClient,
): Promise<void> {
  const { data, error } = await client
    .from("source_connections")
    .select("config_json, cursor_json")
    .eq("id", connection.id)
    .eq("workspace_id", connection.workspace_id)
    .single();
  if (error) throw error;
  const row = data as { config_json: Record<string, unknown> | null; cursor_json: Record<string, unknown> | null };

  const state = buildInitialSlackBackfillState(readSlackChannelIds(row.config_json));
  const { error: updateError } = await client
    .from("source_connections")
    .update({ cursor_json: { ...(row.cursor_json ?? {}), slack_backfill: state } })
    .eq("id", connection.id)
    .eq("workspace_id", connection.workspace_id);
  if (updateError) throw updateError;
}

export async function registerSlackBackfillTask(
  connection: { id: string; workspace_id: string },
  client?: SupabaseClient,
): Promise<void> {
  const db = client ?? (await import("../../db/client")).serviceClient;
  const nextDueAt = new Date(Date.now() + SLACK_BACKFILL_INTERVAL_SECONDS * 1000);

  const { error } = await db.from("scheduled_tasks").upsert(
    {
      workspace_id: connection.workspace_id,
      source_connection_id: connection.id,
      task_type: "slack_backfill",
      task_key: connection.id,
      schedule_kind: "interval",
      interval_seconds: SLACK_BACKFILL_INTERVAL_SECONDS,
      cron_expression: null,
      timezone: "UTC",
      enabled: true,
      next_due_at: nextDueAt.toISOString(),
    } satisfies Partial<ScheduledTaskRow>,
    { onConflict: "workspace_id,task_type,task_key" },
  );
  if (error) throw error;
}

// redactString is the codebase's established defense against an
// underlying error echoing back a token/secret/header -- capped to keep a
// pathological message from bloating cursor_json.
function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactString(message).slice(0, 500);
}

function messageHasReplies(message: Record<string, unknown>): message is Record<string, unknown> & { ts: string } {
  return (
    typeof message.ts === "string" &&
    message.thread_ts === message.ts &&
    typeof message.reply_count === "number" &&
    message.reply_count > 0
  );
}

export interface SlackBackfillDeps {
  fetchSlackConversationHistory: typeof fetchSlackConversationHistory;
  fetchSlackConversationReplies: typeof fetchSlackConversationReplies;
  handleSlackMessageEvent: typeof handleSlackMessageEvent;
  resolveProviderCredentialById: typeof resolveProviderCredentialById;
}

const defaultSlackBackfillDeps: SlackBackfillDeps = {
  fetchSlackConversationHistory,
  fetchSlackConversationReplies,
  handleSlackMessageEvent,
  resolveProviderCredentialById,
};

export interface SlackBackfillConnectionInput {
  id: string;
  workspace_id: string;
  organization_id: string;
  credential_id: string;
  config_json: Record<string, unknown> | null;
  cursor_json: Record<string, unknown> | null;
}

async function disableSlackBackfillTask(
  connection: { id: string; workspace_id: string },
  client: SupabaseClient,
): Promise<void> {
  const { error } = await client
    .from("scheduled_tasks")
    .update({ enabled: false })
    .eq("workspace_id", connection.workspace_id)
    .eq("task_type", "slack_backfill")
    .eq("task_key", connection.id);
  if (error) throw error;
}

export async function runSlackBackfillDispatch(
  connection: SlackBackfillConnectionInput,
  client: SupabaseClient,
  deps: SlackBackfillDeps = defaultSlackBackfillDeps,
): Promise<void> {
  const existing = (connection.cursor_json as { slack_backfill?: unknown } | null)?.slack_backfill;
  let state: SlackBackfillState = isSlackBackfillState(existing)
    ? existing
    : buildInitialSlackBackfillState(readSlackChannelIds(connection.config_json));

  if (state.status === "completed") return;
  if (state.next_eligible_attempt_at && new Date(state.next_eligible_attempt_at).getTime() > Date.now()) return;

  const persist = async (): Promise<void> => {
    const { error } = await client
      .from("source_connections")
      .update({ cursor_json: { ...(connection.cursor_json ?? {}), slack_backfill: state } })
      .eq("id", connection.id)
      .eq("workspace_id", connection.workspace_id);
    if (error) throw error;
  };

  const complete = async (): Promise<void> => {
    state = { ...state, status: "completed", completed_at: new Date().toISOString(), next_eligible_attempt_at: null };
    await persist();
    await disableSlackBackfillTask(connection, client);
  };

  if (state.pending_channel_ids.length === 0 && !state.current_channel_id) {
    await complete();
    return;
  }

  const credential = await deps.resolveProviderCredentialById(connection.workspace_id, "slack", connection.credential_id, client);
  const botToken = credential.bot_token;

  const ctxFor = (channelId: string): SlackMessageEventContext => ({
    connectionId: connection.id,
    workspaceId: connection.workspace_id,
    organizationId: connection.organization_id,
    channelId,
    channelName: null,
    botToken,
  });

  let requestsUsed = 0;
  try {
    while (requestsUsed < SLACK_BACKFILL_MAX_REQUESTS_PER_DISPATCH) {
      if (!state.current_channel_id) {
        const next = state.pending_channel_ids[0];
        if (!next) {
          await complete();
          return;
        }
        // A pure bookkeeping transition -- no API call, so it doesn't need
        // its own checkpoint; it's captured by whichever persist() follows.
        state = {
          ...state,
          pending_channel_ids: state.pending_channel_ids.slice(1),
          current_channel_id: next,
          history_cursor: null,
          history_done: false,
          pending_reply_thread_ts: [],
          current_thread_ts: null,
          replies_cursor: null,
        };
        continue;
      }

      const channelId = state.current_channel_id;

      if (state.current_thread_ts) {
        const page = await deps.fetchSlackConversationReplies(
          botToken,
          channelId,
          state.current_thread_ts,
          { cursor: state.replies_cursor ?? undefined, limit: SLACK_BACKFILL_PAGE_LIMIT },
        );
        requestsUsed += 1;
        // The first item in a replies page is always the thread parent
        // itself, already captured via conversations.history -- skip it so
        // it isn't re-upserted for no reason.
        await ingestMessagesConcurrently(
          page.messages.slice(1),
          (message) => deps.handleSlackMessageEvent(message, ctxFor(channelId), client),
        );
        state = {
          ...state,
          replies_cursor: page.nextCursor,
          current_thread_ts: page.nextCursor ? state.current_thread_ts : null,
          status: "in_progress",
          last_error: null,
        };
        await persist();
        continue;
      }

      if (!state.history_done) {
        const page = await deps.fetchSlackConversationHistory(
          botToken,
          channelId,
          { oldest: toSlackTimestamp(state.cutoff), cursor: state.history_cursor ?? undefined, limit: SLACK_BACKFILL_PAGE_LIMIT },
        );
        requestsUsed += 1;
        const newThreads = page.messages.filter(messageHasReplies).map((message) => message.ts);
        await ingestMessagesConcurrently(
          page.messages,
          (message) => deps.handleSlackMessageEvent(message, ctxFor(channelId), client),
        );
        state = {
          ...state,
          history_cursor: page.nextCursor,
          history_done: page.nextCursor === null,
          pending_reply_thread_ts: [...state.pending_reply_thread_ts, ...newThreads],
          status: "in_progress",
          last_error: null,
        };
        await persist();
        continue;
      }

      if (state.pending_reply_thread_ts.length > 0) {
        const [nextThread, ...rest] = state.pending_reply_thread_ts;
        state = { ...state, current_thread_ts: nextThread!, replies_cursor: null, pending_reply_thread_ts: rest };
        continue;
      }

      // Channel fully covered: no more history pages, no more threads. Also
      // a pure bookkeeping transition -- folded into the next persist().
      state = {
        ...state,
        done_channel_ids: [...state.done_channel_ids, channelId],
        current_channel_id: null,
        history_cursor: null,
        history_done: false,
      };
    }
  } catch (error) {
    if (error instanceof SlackRateLimitedError) {
      state = {
        ...state,
        status: "partial",
        next_eligible_attempt_at: new Date(Date.now() + error.retryAfterSeconds * 1000).toISOString(),
      };
      await persist();
      return;
    }
    // Any other failure: mark partial with a sanitized error and let the
    // next scheduled dispatch retry -- never throw back into the scheduler.
    state = { ...state, status: "partial", last_error: sanitizeErrorMessage(error) };
    await persist();
  }
}

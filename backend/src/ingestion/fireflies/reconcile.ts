// No separate "already ingested" check against source_items -- every listed
// transcript is re-passed to ingestFirefliesMeeting, whose upsert-on-conflict
// makes re-ingesting unchanged content a cheap no-op.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestFirefliesMeeting } from "./normalize";
import { resolveProviderCredential } from "../../credentials/resolve-provider-credential";
import type { ScheduledTaskRow } from "../../types/tables";

const FIREFLIES_GRAPHQL_URL = "https://api.fireflies.ai/graphql";

// Field/query names are unverified against a live Fireflies API response.
const LIST_TRANSCRIPTS_QUERY = `
  query RecentTranscripts($fromDate: Long, $limit: Int) {
    transcripts(fromDate: $fromDate, limit: $limit) {
      id
      date
    }
  }
`;

interface FirefliesGraphQLTranscriptListItem {
  id: string;
  date: number | string;
}

interface FirefliesGraphQLListResponse {
  data?: { transcripts: FirefliesGraphQLTranscriptListItem[] | null };
  errors?: { message: string }[];
}

// No prior cursor -- bound the first-ever sweep to a sane recent window
// rather than attempting to fetch a workspace's entire meeting history.
const DEFAULT_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// Cap how many transcripts a single sweep will list/ingest, so one pass
// can't run unbounded against a very active workspace.
const LIST_LIMIT = 200;

async function listRecentFirefliesTranscripts(
  apiToken: string,
  sinceMs: number,
): Promise<FirefliesGraphQLTranscriptListItem[]> {
  const response = await fetch(FIREFLIES_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify({
      query: LIST_TRANSCRIPTS_QUERY,
      variables: { fromDate: sinceMs, limit: LIST_LIMIT },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Fireflies API list-transcripts request failed: ${response.status} ${response.statusText} ${body}`,
    );
  }

  const payload = (await response.json()) as FirefliesGraphQLListResponse;

  if (payload.errors && payload.errors.length > 0) {
    throw new Error(
      `Fireflies API returned errors listing transcripts: ${payload.errors
        .map((e) => e.message)
        .join("; ")}`,
    );
  }

  return payload.data?.transcripts ?? [];
}

export interface ReconcileFirefliesConnectionInput {
  id: string;
  workspace_id: string;
  cursor_json: Record<string, unknown>;
}

export async function reconcileFirefliesConnection(
  connection: ReconcileFirefliesConnectionInput,
  client?: SupabaseClient,
): Promise<{ ingested: number }> {
  const db = client ?? (await import("../../db/client")).serviceClient;

  const lastReconciledAt = connection.cursor_json.last_reconciled_at;
  const sinceMs =
    typeof lastReconciledAt === "string" && !Number.isNaN(Date.parse(lastReconciledAt))
      ? Date.parse(lastReconciledAt)
      : Date.now() - DEFAULT_LOOKBACK_MS;

  const credential = await resolveProviderCredential(connection.workspace_id, "fireflies", db);
  const transcripts = await listRecentFirefliesTranscripts(credential.api_token, sinceMs);

  // Recorded before ingestion, not after, so a subsequent pass re-covers
  // anything created during this sweep instead of risking a gap.
  const sweepStartedAt = new Date().toISOString();

  let ingested = 0;
  for (const transcript of transcripts) {
    await ingestFirefliesMeeting(connection, transcript.id, db);
    ingested += 1;
  }

  const { error: cursorError } = await db
    .from("source_connections")
    .update({
      cursor_json: { ...connection.cursor_json, last_reconciled_at: sweepStartedAt },
    })
    .eq("id", connection.id)
    .eq("workspace_id", connection.workspace_id);
  if (cursorError) throw cursorError;

  return { ingested };
}

export interface RegisterFirefliesReconciliationTaskConnection {
  id: string;
  workspace_id: string;
}

// A backstop for missed webhooks, not the primary path -- 15 minutes bounds
// staleness without hammering the Fireflies API.
const RECONCILIATION_INTERVAL_SECONDS = 15 * 60;

export async function registerFirefliesReconciliationTask(
  connection: RegisterFirefliesReconciliationTaskConnection,
  client?: SupabaseClient,
): Promise<void> {
  const db = client ?? (await import("../../db/client")).serviceClient;

  // next_due_at must be set here, or the tick never selects this row.
  const nextDueAt = new Date(Date.now() + RECONCILIATION_INTERVAL_SECONDS * 1000);

  const { error } = await db.from("scheduled_tasks").upsert(
    {
      workspace_id: connection.workspace_id,
      source_connection_id: connection.id,
      task_type: "ingest_source",
      task_key: connection.id,
      schedule_kind: "interval",
      interval_seconds: RECONCILIATION_INTERVAL_SECONDS,
      cron_expression: null,
      timezone: "UTC",
      enabled: true,
      next_due_at: nextDueAt.toISOString(),
    } satisfies Partial<ScheduledTaskRow>,
    { onConflict: "workspace_id,task_type,task_key" },
  );
  if (error) throw error;
}

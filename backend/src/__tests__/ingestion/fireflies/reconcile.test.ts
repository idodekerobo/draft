import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptCredentialPayload } from "../../../credentials/crypto";
import {
  reconcileFirefliesConnection,
  registerFirefliesReconciliationTask,
} from "../../../ingestion/fireflies/reconcile";

const ids = {
  workspace: "11111111-1111-4111-8111-111111111111",
  connection: "22222222-2222-4222-8222-222222222222",
  credential: "33333333-3333-4333-8333-333333333333",
};

const KEY_VERSION = "v1";

beforeAll(() => {
  process.env.INFERENCE_CREDENTIAL_KEK_V1 = randomBytes(32).toString("base64");
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface FakeState {
  cursorUpdates: Record<string, unknown>[];
  scheduledTaskUpserts: { payload: Record<string, unknown>; onConflict: string }[];
}

function createFakeClient(): { client: SupabaseClient; state: FakeState } {
  const state: FakeState = { cursorUpdates: [], scheduledTaskUpserts: [] };

  const secrets = { api_token: "ff-token", webhook_secret: "ff-webhook-secret" };
  const encryptedPayload = encryptCredentialPayload(JSON.stringify(secrets), KEY_VERSION);

  function from(table: string) {
    if (table === "source_connections") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: ids.connection, credential_id: ids.credential },
                error: null,
              }),
            }),
          }),
        }),
        update: (payload: Record<string, unknown>) => ({
          eq: () => ({
            eq: async () => {
              state.cursorUpdates.push(payload);
              return { error: null };
            },
          }),
        }),
      };
    }

    if (table === "credentials") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: ids.credential,
                  status: "active",
                  expires_at: null,
                  encrypted_payload: encryptedPayload,
                  encryption_key_version: KEY_VERSION,
                },
                error: null,
              }),
            }),
          }),
        }),
      };
    }

    if (table === "source_items") {
      return {
        select: () => ({
          eq: (_col: string, val: string) => ({
            single: async () => ({
              data: { id: val },
              error: null,
            }),
          }),
        }),
      };
    }

    if (table === "workspace_events") {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        }),
        insert: async () => ({ error: null }),
      };
    }

    if (table === "scheduled_tasks") {
      return {
        upsert: (payload: Record<string, unknown>, opts: { onConflict: string }) => {
          state.scheduledTaskUpserts.push({ payload, onConflict: opts.onConflict });
          return Promise.resolve({ error: null });
        },
      };
    }

    throw new Error(`Unexpected table in fake client: ${table}`);
  }

  function rpc(fnName: string, params: Record<string, unknown>) {
    if (fnName !== "upsert_source_item") {
      throw new Error(`Unexpected rpc in fake client: ${fnName}`);
    }
    return Promise.resolve({
      data: {
        item_id: `item-${params.p_external_id}`,
        changed: true,
        superseded_item_ids: [],
      },
      error: null,
    });
  }

  return { client: { from, rpc } as unknown as SupabaseClient, state };
}

function transcriptPayload(id: string) {
  return {
    data: {
      transcript: {
        id,
        title: `Meeting ${id}`,
        date: Date.now(),
        participants: ["a@example.com"],
        meeting_attendees: [{ displayName: "Alice", email: "a@example.com" }],
        summary: {
          short_summary: "summary",
          overview: "overview",
          action_items: "items",
          outline: "outline",
        },
        sentences: [{ speaker_name: "Alice", text: "Hello" }],
      },
    },
  };
}

function mockFetch(
  listResult: { id: string; date: number }[],
  opts: { failingMeetingId?: string } = {},
) {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };

    if (body.query.includes("RecentTranscripts")) {
      return new Response(
        JSON.stringify({ data: { transcripts: listResult } }),
        { status: 200 },
      );
    }

    if (body.query.includes("query Transcript(")) {
      const meetingId = body.variables.meetingId as string;
      if (opts.failingMeetingId && meetingId === opts.failingMeetingId) {
        return new Response("boom", { status: 500, statusText: "Internal Server Error" });
      }
      return new Response(JSON.stringify(transcriptPayload(meetingId)), { status: 200 });
    }

    throw new Error(`Unexpected GraphQL query in test: ${body.query}`);
  }) as typeof fetch;
}

describe("reconcileFirefliesConnection", () => {
  it("ingests every listed transcript and advances the cursor only after the full pass succeeds", async () => {
    mockFetch([
      { id: "m1", date: Date.now() },
      { id: "m2", date: Date.now() },
    ]);
    const { client, state } = createFakeClient();

    const result = await reconcileFirefliesConnection(
      { id: ids.connection, workspace_id: ids.workspace, cursor_json: {} },
      client,
    );

    expect(result).toEqual({ ingested: 2 });
    expect(state.cursorUpdates).toHaveLength(1);
    const cursorPayload = state.cursorUpdates[0] as { cursor_json: Record<string, unknown> };
    expect(typeof cursorPayload.cursor_json.last_reconciled_at).toBe("string");
  });

  it("leaves the cursor untouched when a mid-pass ingestion fails", async () => {
    mockFetch(
      [
        { id: "m1", date: Date.now() },
        { id: "m2", date: Date.now() },
      ],
      { failingMeetingId: "m2" },
    );
    const { client, state } = createFakeClient();

    await expect(
      reconcileFirefliesConnection(
        { id: ids.connection, workspace_id: ids.workspace, cursor_json: {} },
        client,
      ),
    ).rejects.toThrow();

    expect(state.cursorUpdates).toHaveLength(0);
  });

  it("uses the existing cursor's last_reconciled_at rather than the default lookback", async () => {
    let capturedFromDate: unknown;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes("RecentTranscripts")) {
        capturedFromDate = body.variables.fromDate;
        return new Response(JSON.stringify({ data: { transcripts: [] } }), { status: 200 });
      }
      throw new Error("unexpected query");
    }) as typeof fetch;

    const { client } = createFakeClient();
    const priorCursor = Date.now() - 60_000;

    const result = await reconcileFirefliesConnection(
      {
        id: ids.connection,
        workspace_id: ids.workspace,
        cursor_json: { last_reconciled_at: new Date(priorCursor).toISOString() },
      },
      client,
    );

    expect(result).toEqual({ ingested: 0 });
    expect(capturedFromDate).toBe(priorCursor);
  });
});

describe("registerFirefliesReconciliationTask", () => {
  it("upserts on the (workspace_id, task_type, task_key) conflict target and is idempotent", async () => {
    const { client, state } = createFakeClient();

    await registerFirefliesReconciliationTask({ id: ids.connection, workspace_id: ids.workspace }, client);
    await registerFirefliesReconciliationTask({ id: ids.connection, workspace_id: ids.workspace }, client);

    expect(state.scheduledTaskUpserts).toHaveLength(2);
    for (const call of state.scheduledTaskUpserts) {
      expect(call.onConflict).toBe("workspace_id,task_type,task_key");
      expect(call.payload).toMatchObject({
        workspace_id: ids.workspace,
        source_connection_id: ids.connection,
        task_type: "ingest_source",
        task_key: ids.connection,
        schedule_kind: "interval",
        interval_seconds: 15 * 60,
        timezone: "UTC",
        enabled: true,
      });
    }
    // Same task_key both times -> a real upsert-on-conflict would produce
    // exactly one row, not a duplicate.
    expect(state.scheduledTaskUpserts[0]?.payload.task_key).toBe(
      state.scheduledTaskUpserts[1]?.payload.task_key,
    );
  });
});

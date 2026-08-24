import { afterEach, describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  materializeSlackBatches,
  registerSlackBatchMaterializationTask,
} from "../../../ingestion/slack/materialize-batches";
import { renderSlackMessages } from "../../../ingestion/slack/render";
import type { SlackMessageRow } from "../../../ingestion/slack/types";

const WORKSPACE_ID = "88888888-8888-4888-8888-888888888888";
const CONNECTION_ID = "99999999-9999-4999-8999-999999999999";

// ── Fixture / fake client plumbing ──────────────────────────────────────────

// Fixed-width seconds.microseconds so plain string `>` comparisons (used by
// the real Supabase `.gt()` filter, which this fake reimplements) stay
// consistent with numeric ordering, matching how Postgres would compare a
// text column here.
function ts(n: number): string {
  return (1_700_000_000 + n).toFixed(6);
}

function makeMessage(
  channelId: string,
  n: number,
  overrides: Partial<SlackMessageRow> = {},
): SlackMessageRow {
  return {
    id: `msg-${channelId}-${n}`,
    workspace_id: WORKSPACE_ID,
    source_connection_id: CONNECTION_ID,
    source_item_id: null,
    channel_id: channelId,
    channel_name_snapshot: channelId,
    message_ts: ts(n),
    message_version: "1",
    thread_ts: null,
    parent_user_id: null,
    slack_user_id: "U1",
    user_name_snapshot: "Alice",
    text: `message ${n}`,
    subtype: null,
    is_deleted: false,
    edited_at: null,
    deleted_at: null,
    blocks_json: [],
    files_json: [],
    reactions_json: [],
    provider_metadata_json: {},
    captured_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

type Row = Record<string, any>;

interface Filter {
  op: "eq" | "neq" | "gt" | "in";
  col: string;
  val: any;
}

class FakeQueryBuilder {
  table: string;
  type: "select" | "update" | "upsert" | "insert" = "select";
  payload: Row | null = null;
  filters: Filter[] = [];
  orderCol?: string;
  orderAsc = true;
  limitN?: number;
  singleMode: "none" | "single" | "maybeSingle" = "none";
  cols?: string;
  private execFn: (qb: FakeQueryBuilder) => { data: any; error: any };

  constructor(table: string, execFn: (qb: FakeQueryBuilder) => { data: any; error: any }) {
    this.table = table;
    this.execFn = execFn;
  }

  select(cols?: string) {
    this.cols = cols;
    return this;
  }
  eq(col: string, val: any) {
    this.filters.push({ op: "eq", col, val });
    return this;
  }
  neq(col: string, val: any) {
    this.filters.push({ op: "neq", col, val });
    return this;
  }
  gt(col: string, val: any) {
    this.filters.push({ op: "gt", col, val });
    return this;
  }
  in(col: string, vals: any[]) {
    this.filters.push({ op: "in", col, val: vals });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  update(payload: Row) {
    this.type = "update";
    this.payload = payload;
    return this;
  }
  upsert(payload: Row, _opts?: { onConflict?: string }) {
    this.type = "upsert";
    this.payload = payload;
    return this;
  }
  insert(payload: Row) {
    this.type = "insert";
    this.payload = payload;
    return this;
  }
  single() {
    this.singleMode = "single";
    return this;
  }
  maybeSingle() {
    this.singleMode = "maybeSingle";
    return this;
  }

  then(resolve: (v: { data: any; error: any }) => void, reject: (e: unknown) => void) {
    try {
      resolve(this.execFn(this));
    } catch (e) {
      reject(e);
    }
  }
}

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((r) =>
    filters.every((f) => {
      if (f.op === "eq") return r[f.col] === f.val;
      if (f.op === "neq") return r[f.col] !== f.val;
      if (f.op === "gt") return r[f.col] > f.val;
      if (f.op === "in") return (f.val as any[]).includes(r[f.col]);
      return true;
    }),
  );
}

function sortRows(rows: Row[], col: string, ascending: boolean): Row[] {
  const sorted = [...rows].sort((a, b) => {
    if (a[col] < b[col]) return -1;
    if (a[col] > b[col]) return 1;
    return 0;
  });
  return ascending ? sorted : sorted.reverse();
}

interface Store {
  slackMessages: Row[];
  sourceItems: Row[];
  workspaceEvents: Row[];
  sourceConnections: Row[];
  rpcCalls: Array<{ functionName: string; params: Row }>;
}

function createFakeClient(
  messages: SlackMessageRow[],
  cursorJson: Record<string, unknown>,
  rpcError: unknown = null,
) {
  const store: Store = {
    slackMessages: messages,
    sourceItems: [],
    workspaceEvents: [],
    sourceConnections: [{ id: CONNECTION_ID, workspace_id: WORKSPACE_ID, cursor_json: cursorJson }],
    rpcCalls: [],
  };

  function execSlackMessages(qb: FakeQueryBuilder) {
    if (qb.type === "select") {
      let rows = applyFilters(store.slackMessages, qb.filters);
      if (qb.orderCol) rows = sortRows(rows, qb.orderCol, qb.orderAsc);
      if (qb.cols === "channel_id") rows = rows.map((r) => ({ channel_id: r.channel_id }));
      return { data: rows, error: null };
    }
    if (qb.type === "update") {
      const inFilter = qb.filters.find((f) => f.op === "in" && f.col === "id");
      const ids: string[] = inFilter?.val ?? [];
      for (const row of store.slackMessages) {
        if (ids.includes(row.id)) Object.assign(row, qb.payload);
      }
      return { data: null, error: null };
    }
    throw new Error(`unsupported slack_messages op: ${qb.type}`);
  }

  function execSourceItems(qb: FakeQueryBuilder) {
    if (qb.type === "select") {
      const rows = applyFilters(store.sourceItems, qb.filters);
      if (qb.singleMode === "single") {
        return { data: rows[0] ?? null, error: rows[0] ? null : { message: "not found" } };
      }
      return { data: rows, error: null };
    }
    throw new Error(`unsupported source_items op: ${qb.type}`);
  }

  // Reimplements just enough of upsert_source_item (db/functions/upsert_source_item.sql)
  // against store.sourceItems to exercise the batching behaviour under test.
  function execUpsertSourceItemRpc(params: Row) {
    const priorReady = store.sourceItems.filter(
      (r) =>
        r.source_connection_id === params.p_source_connection_id &&
        r.external_id === params.p_external_id &&
        r.lifecycle_status === "ready" &&
        r.external_version !== params.p_external_version,
    );
    const priorIds = priorReady.map((r) => r.id as string);

    const idx = store.sourceItems.findIndex(
      (r) =>
        r.source_connection_id === params.p_source_connection_id &&
        r.external_id === params.p_external_id &&
        r.external_version === params.p_external_version,
    );

    const payload: Row = {
      workspace_id: params.p_workspace_id,
      source_connection_id: params.p_source_connection_id,
      item_type: params.p_item_type,
      external_id: params.p_external_id,
      external_version: params.p_external_version,
      lifecycle_status: params.p_lifecycle_status ?? "ready",
      occurred_at: params.p_occurred_at,
      normalized_at: new Date().toISOString(),
      content_markdown: params.p_content_markdown,
      content_hash: params.p_content_hash,
      metadata_json: params.p_metadata_json,
      sanitized_raw_json: params.p_sanitized_raw_json,
      supersedes_source_item_id: priorIds[0] ?? null,
    };

    let row: Row;
    if (idx >= 0) {
      row = { ...store.sourceItems[idx], ...payload };
      store.sourceItems[idx] = row;
    } else {
      row = { id: `item-${store.sourceItems.length + 1}`, ...payload };
      store.sourceItems.push(row);
    }

    for (const prior of priorReady) prior.lifecycle_status = "superseded";

    return {
      data: { item_id: row.id, changed: true, superseded_item_ids: priorIds },
      error: null,
    };
  }

  function execWorkspaceEvents(qb: FakeQueryBuilder) {
    if (qb.type === "select") {
      let rows = applyFilters(store.workspaceEvents, qb.filters);
      if (qb.orderCol) rows = sortRows(rows, qb.orderCol, qb.orderAsc);
      if (qb.limitN !== undefined) rows = rows.slice(0, qb.limitN);
      if (qb.singleMode === "maybeSingle") return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }
    if (qb.type === "insert") {
      store.workspaceEvents.push({ id: `event-${store.workspaceEvents.length + 1}`, ...qb.payload });
      return { data: null, error: null };
    }
    throw new Error(`unsupported workspace_events op: ${qb.type}`);
  }

  function execSourceConnections(qb: FakeQueryBuilder) {
    if (qb.type === "update") {
      const idFilter = qb.filters.find((f) => f.col === "id");
      const conn = store.sourceConnections.find((c) => c.id === idFilter?.val);
      if (conn) Object.assign(conn, qb.payload);
      return { data: null, error: null };
    }
    if (qb.type === "upsert") {
      store.sourceConnections.push({ id: `task-${store.sourceConnections.length}`, ...qb.payload });
      return { data: qb.payload, error: null };
    }
    throw new Error(`unsupported source_connections op: ${qb.type}`);
  }

  function execScheduledTasks(qb: FakeQueryBuilder) {
    if (qb.type === "upsert") {
      (store as any).scheduledTasks = (store as any).scheduledTasks ?? [];
      (store as any).scheduledTasks.push(qb.payload);
      return { data: qb.payload, error: null };
    }
    throw new Error(`unsupported scheduled_tasks op: ${qb.type}`);
  }

  function dispatch(qb: FakeQueryBuilder) {
    if (qb.table === "slack_messages") return execSlackMessages(qb);
    if (qb.table === "source_items") return execSourceItems(qb);
    if (qb.table === "workspace_events") return execWorkspaceEvents(qb);
    if (qb.table === "source_connections") return execSourceConnections(qb);
    if (qb.table === "scheduled_tasks") return execScheduledTasks(qb);
    throw new Error(`unexpected table: ${qb.table}`);
  }

  const client = {
    from(table: string) {
      return new FakeQueryBuilder(table, dispatch);
    },
    rpc(fnName: string, params: Row) {
      if (fnName === "upsert_source_item") {
        store.rpcCalls.push({ functionName: fnName, params });
        if (rpcError) return Promise.resolve({ data: null, error: rpcError });
        return Promise.resolve(execUpsertSourceItemRpc(params));
      }
      throw new Error(`unexpected rpc: ${fnName}`);
    },
  } as unknown as SupabaseClient;

  return { client, store };
}

// ── Threshold env plumbing ──────────────────────────────────────────────────

const LIMIT_ENV_KEYS = [
  "SLACK_BATCH_MAX_SPAN_HOURS",
  "SLACK_BATCH_MAX_MESSAGES",
  "SLACK_BATCH_MAX_CONTENT_BYTES",
] as const;

function setLimits(opts: { spanHours?: number; maxMessages?: number; maxBytes?: number }) {
  process.env.SLACK_BATCH_MAX_SPAN_HOURS = String(opts.spanHours ?? 1_000_000);
  process.env.SLACK_BATCH_MAX_MESSAGES = String(opts.maxMessages ?? 1_000_000);
  process.env.SLACK_BATCH_MAX_CONTENT_BYTES = String(opts.maxBytes ?? 100_000_000);
}

afterEach(() => {
  for (const key of LIMIT_ENV_KEYS) delete process.env[key];
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("materializeSlackBatches", () => {
  it("cuts a batch once the message-count threshold is crossed, including the crossing message", async () => {
    const channelId = "C-count";
    const messages = [0, 1, 2, 3, 4].map((n) => makeMessage(channelId, n));
    const { client, store } = createFakeClient(messages, {});
    setLimits({ maxMessages: 3 });

    const result = await materializeSlackBatches(
      { id: CONNECTION_ID, workspace_id: WORKSPACE_ID, cursor_json: {} },
      client,
    );

    expect(result.batchesCut).toBe(1);
    expect(store.rpcCalls[0]?.functionName).toBe("upsert_source_item");
    expect(store.sourceItems).toHaveLength(1);
    expect(store.sourceItems[0]!.metadata_json.message_count).toBe(3);

    const linked = store.slackMessages.filter((m) => m.source_item_id !== null);
    expect(linked.map((m) => m.id).sort()).toEqual(
      [messages[0]!.id, messages[1]!.id, messages[2]!.id].sort(),
    );
    expect(store.slackMessages.find((m) => m.id === messages[3]!.id)!.source_item_id).toBeNull();
    expect(store.slackMessages.find((m) => m.id === messages[4]!.id)!.source_item_id).toBeNull();

    const cursor = (result.updatedCursorJson as any).channels[channelId].last_batched_message_ts;
    expect(cursor).toBe(messages[2]!.message_ts);
  });

  it("treats connection_inactive from upsert_source_item as a stale materialization skip", async () => {
    const channelId = "C-stale";
    const messages = [0, 1].map((n) => makeMessage(channelId, n));
    const initialCursor = {};
    const { client, store } = createFakeClient(
      messages,
      initialCursor,
      { code: "P0001", message: "connection_inactive" },
    );
    setLimits({ maxMessages: 2 });

    const result = await materializeSlackBatches(
      { id: CONNECTION_ID, workspace_id: WORKSPACE_ID, cursor_json: initialCursor },
      client,
    );

    expect(result).toEqual({ batchesCut: 0, updatedCursorJson: initialCursor });
    expect(store.rpcCalls).toHaveLength(1);
    expect(store.sourceItems).toHaveLength(0);
    expect(store.workspaceEvents).toHaveLength(0);
    expect(store.slackMessages.every((message) => message.source_item_id === null)).toBe(true);
    expect(store.sourceConnections[0]?.cursor_json).toEqual(initialCursor);
  });

  it("cuts a batch once the span threshold is crossed, including the crossing message", async () => {
    const channelId = "C-span";
    // 2-second gaps between messages.
    const messages = [0, 2, 4].map((n) => makeMessage(channelId, n));
    const { client, store } = createFakeClient(messages, {});
    // Threshold sits between a 0ms span (1 message) and a 2000ms span (2 messages).
    setLimits({ spanHours: 1500 / 3_600_000 });

    const result = await materializeSlackBatches(
      { id: CONNECTION_ID, workspace_id: WORKSPACE_ID, cursor_json: {} },
      client,
    );

    expect(result.batchesCut).toBe(1);
    expect(store.sourceItems[0]!.metadata_json.message_count).toBe(2);
    expect(store.slackMessages.find((m) => m.id === messages[0]!.id)!.source_item_id).not.toBeNull();
    expect(store.slackMessages.find((m) => m.id === messages[1]!.id)!.source_item_id).not.toBeNull();
    expect(store.slackMessages.find((m) => m.id === messages[2]!.id)!.source_item_id).toBeNull();

    const cursor = (result.updatedCursorJson as any).channels[channelId].last_batched_message_ts;
    expect(cursor).toBe(messages[1]!.message_ts);
  });

  it("cuts a batch once the rendered-byte threshold is crossed, EXCLUDING the message that pushes it over", async () => {
    const channelId = "C-size";
    const messages = [0, 1, 2, 3].map((n) => makeMessage(channelId, n, { text: "x".repeat(200) }));
    const { client, store } = createFakeClient([...messages], {});

    // Derive the threshold from the real renderer rather than hardcoding a
    // byte count that's an implementation detail of render.ts.
    const sizeAfter: number[] = [];
    for (let k = 1; k <= messages.length; k++) {
      const content = await renderSlackMessages(
        messages.slice(0, k).map((m) => m.id),
        client,
      );
      sizeAfter.push(new TextEncoder().encode(content).length);
    }
    const threshold = sizeAfter[2]! - 1; // just under the size of the first 3 messages
    expect(sizeAfter[1]).toBeLessThan(threshold); // sanity: first 2 messages fit comfortably

    setLimits({ maxBytes: threshold });

    const result = await materializeSlackBatches(
      { id: CONNECTION_ID, workspace_id: WORKSPACE_ID, cursor_json: {} },
      client,
    );

    expect(result.batchesCut).toBe(1);
    expect(store.sourceItems).toHaveLength(1);
    // The 3rd message (which would have pushed bytes over the threshold) is
    // excluded from this batch -- only messages 1-2 are committed.
    expect(store.sourceItems[0]!.metadata_json.message_count).toBe(2);
    expect(store.slackMessages.find((m) => m.id === messages[2]!.id)!.source_item_id).toBeNull();
    expect(store.slackMessages.find((m) => m.id === messages[3]!.id)!.source_item_id).toBeNull();

    const cursor = (result.updatedCursorJson as any).channels[channelId].last_batched_message_ts;
    expect(cursor).toBe(messages[1]!.message_ts);
  });

  it("never mixes messages from two different channels into one batch", async () => {
    const messagesA = [0, 1].map((n) => makeMessage("C-A", n));
    const messagesB = [0, 1].map((n) => makeMessage("C-B", n));
    const { client, store } = createFakeClient([...messagesA, ...messagesB], {});
    setLimits({ maxMessages: 2 });

    const result = await materializeSlackBatches(
      { id: CONNECTION_ID, workspace_id: WORKSPACE_ID, cursor_json: {} },
      client,
    );

    expect(result.batchesCut).toBe(2);
    expect(store.sourceItems).toHaveLength(2);

    for (const item of store.sourceItems) {
      const channelId = item.metadata_json.channel_id as string;
      expect(["C-A", "C-B"]).toContain(channelId);
      expect(item.external_id as string).toStartWith(`${channelId}:`);
    }

    const itemA = store.sourceItems.find((i) => i.metadata_json.channel_id === "C-A")!;
    const itemB = store.sourceItems.find((i) => i.metadata_json.channel_id === "C-B")!;

    for (const msg of messagesA) {
      expect(store.slackMessages.find((m) => m.id === msg.id)!.source_item_id).toBe(itemA.id);
    }
    for (const msg of messagesB) {
      expect(store.slackMessages.find((m) => m.id === msg.id)!.source_item_id).toBe(itemB.id);
    }
  });

  it("writes nothing and leaves the cursor unchanged when no threshold is crossed", async () => {
    const channelId = "C-quiet";
    const messages = [makeMessage(channelId, 0)];
    const initialCursor = { channels: { "C-other": { last_batched_message_ts: ts(999) } } };
    const { client, store } = createFakeClient(messages, initialCursor);

    const result = await materializeSlackBatches(
      { id: CONNECTION_ID, workspace_id: WORKSPACE_ID, cursor_json: initialCursor },
      client,
    );

    expect(result.batchesCut).toBe(0);
    expect(store.sourceItems).toHaveLength(0);
    expect(store.slackMessages[0]!.source_item_id).toBeNull();
    expect(result.updatedCursorJson).toEqual(initialCursor);
    expect(store.sourceConnections[0]!.cursor_json).toEqual(initialCursor);
  });

  it("re-running with an un-advanced cursor (simulated crash) lands on the same row instead of duplicating", async () => {
    const channelId = "C-crash";
    const messages = [0, 1, 2].map((n) => makeMessage(channelId, n));
    const { client, store } = createFakeClient(messages, {});
    setLimits({ maxMessages: 3 });

    const first = await materializeSlackBatches(
      { id: CONNECTION_ID, workspace_id: WORKSPACE_ID, cursor_json: {} },
      client,
    );
    expect(first.batchesCut).toBe(1);
    expect(store.sourceItems).toHaveLength(1);
    const firstItemId = store.sourceItems[0]!.id;
    const firstExternalId = store.sourceItems[0]!.external_id;
    const firstExternalVersion = store.sourceItems[0]!.external_version;

    // Simulate a crash between step 6/7 (commit + link, already reflected in
    // `store`) and step 8 (cursor persisted) by replaying with the same
    // stale (un-advanced) cursor_json the caller held before the first run.
    const second = await materializeSlackBatches(
      { id: CONNECTION_ID, workspace_id: WORKSPACE_ID, cursor_json: {} },
      client,
    );

    expect(second.batchesCut).toBe(1);
    // Same row updated in place -- not a duplicate.
    expect(store.sourceItems).toHaveLength(1);
    expect(store.sourceItems[0]!.id).toBe(firstItemId);
    expect(store.sourceItems[0]!.external_id).toBe(firstExternalId);
    expect(store.sourceItems[0]!.external_version).toBe(firstExternalVersion);
  });
});

describe("registerSlackBatchMaterializationTask", () => {
  it("upserts an idempotent ingest_source task keyed by connection id", async () => {
    const { client, store } = createFakeClient([], {});

    await registerSlackBatchMaterializationTask(
      { id: CONNECTION_ID, workspace_id: WORKSPACE_ID },
      client,
    );

    const tasks = (store as any).scheduledTasks as Row[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      workspace_id: WORKSPACE_ID,
      source_connection_id: CONNECTION_ID,
      task_type: "ingest_source",
      task_key: CONNECTION_ID,
      schedule_kind: "interval",
      timezone: "UTC",
      enabled: true,
    });
    expect(tasks[0]!.interval_seconds).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { renderSlackMessages } from "../../../ingestion/slack/render";
import type { SlackMessageRow } from "../../../ingestion/slack/types";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const CHANNEL_ID = "C0PRODUCT";

function baseRow(overrides: Partial<SlackMessageRow>): SlackMessageRow {
  return {
    id: overrides.id ?? "unknown-id",
    workspace_id: WORKSPACE_ID,
    source_connection_id: CONNECTION_ID,
    source_item_id: null,
    channel_id: CHANNEL_ID,
    channel_name_snapshot: "product",
    message_ts: "1700000000.000100",
    message_version: "v1",
    thread_ts: null,
    parent_user_id: null,
    slack_user_id: "U123",
    user_name_snapshot: "Ada",
    text: "hello",
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

function createFakeClient(rows: SlackMessageRow[]) {
  function from(table: string) {
    if (table === "slack_messages") {
      return {
        select: () => ({
          in: async (_col: string, ids: string[]) => ({
            data: rows.filter((r) => ids.includes(r.id)),
            error: null,
          }),
        }),
      };
    }
    throw new Error(`Unexpected table in fake client: ${table}`);
  }
  return { from } as unknown as SupabaseClient;
}

describe("renderSlackMessages", () => {
  // Standalone message
  const standalone = baseRow({
    id: "msg-standalone",
    message_ts: "1700000010.000100",
    thread_ts: null,
    user_name_snapshot: "Bea",
    text: "just a standalone message",
  });

  // Thread root + 2 replies
  const threadRoot = baseRow({
    id: "msg-thread-root",
    message_ts: "1700000020.000100",
    thread_ts: "1700000020.000100",
    user_name_snapshot: "Cy",
    text: "starting a thread",
  });
  const reply1 = baseRow({
    id: "msg-thread-reply-1",
    message_ts: "1700000021.000100",
    thread_ts: "1700000020.000100",
    user_name_snapshot: "Dee",
    text: "first reply",
  });
  const reply2 = baseRow({
    id: "msg-thread-reply-2",
    message_ts: "1700000022.000100",
    thread_ts: "1700000020.000100",
    user_name_snapshot: "Eli",
    text: "second reply",
  });

  // Message with a file attachment
  const withFile = baseRow({
    id: "msg-with-file",
    message_ts: "1700000030.000100",
    thread_ts: null,
    user_name_snapshot: "Fay",
    text: "here is a file",
    files_json: [
      {
        file_id: "F123",
        name: "roadmap.pdf",
        mimetype: "application/pdf",
        size_bytes: 1024,
        object_key: "slack/org1/ws1/C0PRODUCT/F123-roadmap.pdf",
        content_hash: "hash123",
      },
    ],
  });

  // Message with reactions
  const withReactions = baseRow({
    id: "msg-with-reactions",
    message_ts: "1700000040.000100",
    thread_ts: null,
    user_name_snapshot: "Gus",
    text: "ship it",
    reactions_json: [
      { name: "white_check_mark", count: 2, users: ["U1", "U2"] },
      { name: "tada", count: 1, users: ["U3"] },
    ],
  });

  // Deleted message
  const deleted = baseRow({
    id: "msg-deleted",
    message_ts: "1700000050.000100",
    thread_ts: null,
    user_name_snapshot: "Hal",
    text: "this should never appear in output",
    is_deleted: true,
    deleted_at: new Date().toISOString(),
  });

  const allRows = [standalone, threadRoot, reply1, reply2, withFile, withReactions, deleted];

  it("groups thread replies under their root, not interleaved with standalone messages", async () => {
    const client = createFakeClient(allRows);
    const output = await renderSlackMessages(allRows.map((r) => r.id), client);

    const rootIdx = output.indexOf("starting a thread");
    const reply1Idx = output.indexOf("first reply");
    const reply2Idx = output.indexOf("second reply");
    const standaloneIdx = output.indexOf("just a standalone message");
    const withFileIdx = output.indexOf("here is a file");

    expect(rootIdx).toBeGreaterThan(-1);
    expect(reply1Idx).toBeGreaterThan(rootIdx);
    expect(reply2Idx).toBeGreaterThan(reply1Idx);
    // Replies must come before the next root-level message (withFile, which
    // is chronologically after the thread).
    expect(withFileIdx).toBeGreaterThan(reply2Idx);
    // Standalone message (ts 10) chronologically precedes the thread (ts 20).
    expect(standaloneIdx).toBeGreaterThan(-1);
    expect(standaloneIdx).toBeLessThan(rootIdx);

    // Replies are visually nested (indented / marked) rather than looking
    // like top-level messages.
    const reply1Line = output.split("\n").find((l) => l.includes("first reply"));
    expect(reply1Line).toBeDefined();
  });

  it("renders in chronological order even when messageIds arrive shuffled", async () => {
    const shuffledIds = [
      withReactions.id,
      deleted.id,
      reply2.id,
      standalone.id,
      threadRoot.id,
      withFile.id,
      reply1.id,
    ];
    const client = createFakeClient(allRows);
    const output = await renderSlackMessages(shuffledIds, client);

    const order = [
      "just a standalone message",
      "starting a thread",
      "first reply",
      "second reply",
      "here is a file",
      "ship it",
    ].map((needle) => output.indexOf(needle));

    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(order[i - 1]!);
    }
  });

  it("renders file attachments as the durable object key, never a URL or local path", async () => {
    const client = createFakeClient(allRows);
    const output = await renderSlackMessages(allRows.map((r) => r.id), client);

    expect(output).toContain("slack/org1/ws1/C0PRODUCT/F123-roadmap.pdf");
    expect(output).not.toContain("http://");
    expect(output).not.toContain("https://");
    expect(output).not.toMatch(/\/tmp\//);
  });

  it("renders reactions inline in a parseable way", async () => {
    const client = createFakeClient(allRows);
    const output = await renderSlackMessages(allRows.map((r) => r.id), client);

    expect(output).toContain("white_check_mark");
    expect(output).toContain("×2");
    expect(output).toContain("tada");
    expect(output).toContain("×1");
  });

  it("does not leak deleted message content into the output", async () => {
    const client = createFakeClient(allRows);
    const output = await renderSlackMessages(allRows.map((r) => r.id), client);

    expect(output).not.toContain("this should never appear in output");
    // The deleted message's author/placeholder may still show up as a
    // terse marker.
    expect(output).toContain("[deleted]");
  });

  it("returns empty string for an empty id list without querying", async () => {
    const client = createFakeClient(allRows);
    const output = await renderSlackMessages([], client);
    expect(output).toBe("");
  });
});

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleSlackMessageEvent, type SlackMessageEventContext } from "../../../ingestion/slack/normalize";

const ctx: SlackMessageEventContext = {
  connectionId: "conn-1",
  workspaceId: "workspace-1",
  organizationId: "org-1",
  channelId: "C123",
  channelName: "general",
  botToken: "xoxb-fake",
};

interface FakeState {
  upserts: Array<{ table: string; payload: Record<string, unknown>; options: unknown }>;
  uploads: Array<{ bucket: string; path: string; options: unknown }>;
}

function createFakeClient(): { client: SupabaseClient; state: FakeState } {
  const state: FakeState = { upserts: [], uploads: [] };

  const client = {
    from(table: string) {
      return {
        upsert: async (payload: Record<string, unknown>, options: unknown) => {
          state.upserts.push({ table, payload, options });
          return { error: null };
        },
      };
    },
    storage: {
      from(bucket: string) {
        return {
          upload: async (path: string, _body: unknown, options: unknown) => {
            state.uploads.push({ bucket, path, options });
            return { data: { path }, error: null };
          },
        };
      },
    },
  };

  return { client: client as unknown as SupabaseClient, state };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("handleSlackMessageEvent — ordinary messages", () => {
  it("upserts a slack_messages row with source_item_id null and message_version = ts", async () => {
    const { client, state } = createFakeClient();

    await handleSlackMessageEvent(
      {
        type: "message",
        channel: "C123",
        ts: "1700000000.000100",
        text: "hello team",
        user: "U1",
        thread_ts: null,
      },
      ctx,
      client,
    );

    expect(state.upserts).toHaveLength(1);
    const [{ table, payload, options }] = state.upserts;
    expect(table).toBe("slack_messages");
    expect(payload).toMatchObject({
      workspace_id: "workspace-1",
      source_connection_id: "conn-1",
      source_item_id: null,
      channel_id: "C123",
      message_ts: "1700000000.000100",
      message_version: "1700000000.000100",
      slack_user_id: "U1",
      text: "hello team",
      subtype: null,
      is_deleted: false,
    });
    expect(options).toMatchObject({
      onConflict: "source_connection_id,channel_id,message_ts,message_version",
    });
  });

  it("skips noise subtypes (e.g. channel_join) without writing a row", async () => {
    const { client, state } = createFakeClient();

    await handleSlackMessageEvent(
      { type: "message", channel: "C123", ts: "1700000000.000200", subtype: "channel_join", user: "U1" },
      ctx,
      client,
    );

    expect(state.upserts).toHaveLength(0);
  });

  it.each(["channel_name", "channel_purpose", "channel_topic"])(
    "captures %s as an ordinary slack_messages row using Slack's own text",
    async (subtype) => {
      const { client, state } = createFakeClient();

      await handleSlackMessageEvent(
        {
          type: "message",
          channel: "C123",
          ts: "1700000000.000250",
          subtype,
          user: "U1",
          text: `<@U1> has updated the channel ${subtype}`,
        },
        ctx,
        client,
      );

      expect(state.upserts).toHaveLength(1);
      const [{ payload }] = state.upserts;
      expect(payload).toMatchObject({
        subtype,
        text: `<@U1> has updated the channel ${subtype}`,
      });
    },
  );

  it("downloads and stores file attachments as object_key + content_hash, never a raw URL", async () => {
    const { client, state } = createFakeClient();

    globalThis.fetch = mock(async () => {
      return new Response(new TextEncoder().encode("file bytes"), { status: 200 });
    }) as unknown as typeof fetch;

    await handleSlackMessageEvent(
      {
        type: "message",
        channel: "C123",
        ts: "1700000000.000300",
        user: "U1",
        text: "see attached",
        files: [
          {
            id: "F1",
            name: "report final (v2).csv",
            mimetype: "text/csv",
            size: 10,
            url_private: "https://files.slack.com/secret/report.csv",
          },
        ],
      },
      ctx,
      client,
    );

    expect(state.uploads).toHaveLength(1);
    expect(state.uploads[0].bucket).toBe("slack-attachments");
    expect(state.uploads[0].path).toBe("slack/org-1/workspace-1/C123/F1-report_final__v2_.csv");

    const [{ payload }] = state.upserts;
    const files = payload.files_json as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      file_id: "F1",
      name: "report final (v2).csv",
      object_key: "slack/org-1/workspace-1/C123/F1-report_final__v2_.csv",
    });
    expect(files[0].content_hash).toBeTruthy();
    expect(JSON.stringify(files[0])).not.toContain("url_private");
    expect(JSON.stringify(files[0])).not.toContain("https://files.slack.com");
  });
});

describe("handleSlackMessageEvent — message_changed / message_deleted (the bug fix)", () => {
  let logSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    logSpy = mock(() => {});
    console.log = logSpy as unknown as typeof console.log;
  });

  it("detects message_changed, logs a deferred marker, and writes NO slack_messages row", async () => {
    const { client, state } = createFakeClient();

    // Outer envelope's own ts/text do NOT reflect the real edited content --
    // the real edited message is nested at event.message. If normalize.ts
    // regressed to the old bug, it would upsert using the outer ts/text.
    await handleSlackMessageEvent(
      {
        type: "message",
        subtype: "message_changed",
        channel: "C123",
        ts: "1700000000.000500", // edit-event's own ts, NOT the message's ts
        message: {
          type: "message",
          ts: "1700000000.000100", // the actual (edited) message's ts
          text: "hello team EDITED",
          user: "U1",
        },
        previous_message: {
          ts: "1700000000.000100",
          text: "hello team",
          user: "U1",
        },
      },
      ctx,
      client,
    );

    expect(state.upserts).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse((logSpy.mock.calls[0] as unknown[])[0] as string);
    expect(logged).toMatchObject({
      event: "slack_message_edit_deferred",
      subtype: "message_changed",
      nested_message_ts: "1700000000.000100",
    });
  });

  it("detects message_deleted, logs a deferred marker, and writes NO slack_messages row", async () => {
    const { client, state } = createFakeClient();

    await handleSlackMessageEvent(
      {
        type: "message",
        subtype: "message_deleted",
        channel: "C123",
        ts: "1700000000.000600",
        previous_message: {
          ts: "1700000000.000100",
          text: "hello team",
          user: "U1",
        },
      },
      ctx,
      client,
    );

    expect(state.upserts).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse((logSpy.mock.calls[0] as unknown[])[0] as string);
    expect(logged).toMatchObject({
      event: "slack_message_edit_deferred",
      subtype: "message_deleted",
      nested_message_ts: "1700000000.000100",
    });
  });
});

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
  rpcCalls: Array<{ functionName: string; params: Record<string, unknown> }>;
  uploads: Array<{ bucket: string; path: string; options: unknown }>;
}

function createFakeClient(rpcError: unknown = null): { client: SupabaseClient; state: FakeState } {
  const state: FakeState = { rpcCalls: [], uploads: [] };

  const client = {
    async rpc(functionName: string, params: Record<string, unknown>) {
      state.rpcCalls.push({ functionName, params });
      return { data: rpcError ? null : { message_id: "message-1" }, error: rpcError };
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
  it("writes through the active-gated Slack message RPC", async () => {
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

    expect(state.rpcCalls).toHaveLength(1);
    const [{ functionName, params }] = state.rpcCalls;
    expect(functionName).toBe("upsert_slack_message_if_connection_active");
    expect(params).toMatchObject({
      p_workspace_id: "workspace-1",
      p_source_connection_id: "conn-1",
      p_channel_id: "C123",
      p_message_ts: "1700000000.000100",
      p_message_version: "1700000000.000100",
      p_slack_user_id: "U1",
      p_text: "hello team",
      p_subtype: null,
      p_is_deleted: false,
    });
  });

  it("treats connection_inactive from the final RPC as a stale-delivery skip", async () => {
    const { client, state } = createFakeClient({ code: "P0001", message: "connection_inactive" });

    await expect(handleSlackMessageEvent(
      { type: "message", channel: "C123", ts: "1700000000.000150", text: "stale" },
      ctx,
      client,
    )).resolves.toBeUndefined();
    expect(state.rpcCalls).toHaveLength(1);
  });

  it("still propagates non-lifecycle RPC failures", async () => {
    const { client } = createFakeClient({ code: "XX000", message: "database unavailable" });

    await expect(handleSlackMessageEvent(
      { type: "message", channel: "C123", ts: "1700000000.000175", text: "fail" },
      ctx,
      client,
    )).rejects.toMatchObject({ code: "XX000" });
  });

  it("skips noise subtypes (e.g. channel_join) without writing a row", async () => {
    const { client, state } = createFakeClient();

    await handleSlackMessageEvent(
      { type: "message", channel: "C123", ts: "1700000000.000200", subtype: "channel_join", user: "U1" },
      ctx,
      client,
    );

    expect(state.rpcCalls).toHaveLength(0);
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

      expect(state.rpcCalls).toHaveLength(1);
      const [{ params }] = state.rpcCalls;
      expect(params).toMatchObject({
        p_subtype: subtype,
        p_text: `<@U1> has updated the channel ${subtype}`,
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

    const [{ params }] = state.rpcCalls;
    const files = params.p_files_json as Array<Record<string, unknown>>;
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

    expect(state.rpcCalls).toHaveLength(0);
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

    expect(state.rpcCalls).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse((logSpy.mock.calls[0] as unknown[])[0] as string);
    expect(logged).toMatchObject({
      event: "slack_message_edit_deferred",
      subtype: "message_deleted",
      nested_message_ts: "1700000000.000100",
    });
  });
});

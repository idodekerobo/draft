import { describe, expect, it, mock } from "bun:test";
import {
  joinPublicSlackChannels,
  leavePublicSlackChannels,
  listPublicSlackChannels,
  reconcileSlackChannels,
  SlackProviderError,
} from "../../../ingestion/slack/provider";

describe("Slack provider domain", () => {
  it("walks every conversations.list page and sorts by member count", async () => {
    const calls: Array<{ url: URL; authorization: string | null }> = [];
    const fetchFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (!url.searchParams.has("cursor")) {
        return Response.json({
          ok: true,
          channels: [{ id: "C1", name: "small", num_members: 3, is_member: false }],
          response_metadata: { next_cursor: "next page" },
        });
      }
      return Response.json({
        ok: true,
        channels: [{ id: "C2", name: "large", num_members: 20, is_member: true }],
        response_metadata: { next_cursor: "" },
      });
    }) as unknown as typeof fetch;

    await expect(listPublicSlackChannels("xoxb-secret", fetchFn)).resolves.toEqual([
      { id: "C2", name: "large", memberCount: 20, isMember: true },
      { id: "C1", name: "small", memberCount: 3, isMember: false },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.searchParams.get("types")).toBe("public_channel");
    expect(calls[0]?.url.searchParams.get("limit")).toBe("200");
    expect(calls[0]?.url.searchParams.get("exclude_archived")).toBe("true");
    expect(calls[0]?.url.searchParams.has("cursor")).toBe(false);
    expect(calls[1]?.url.searchParams.get("cursor")).toBe("next page");
    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer xoxb-secret",
      "Bearer xoxb-secret",
    ]);
  });

  it("accepts an empty channel page", async () => {
    const fetchFn = mock(async () => Response.json({
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    })) as unknown as typeof fetch;

    await expect(listPublicSlackChannels("xoxb-token", fetchFn)).resolves.toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects a repeated non-empty cursor instead of walking forever", async () => {
    const fetchFn = mock(async () => Response.json({
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "repeated-cursor" },
    })) as unknown as typeof fetch;

    await expect(listPublicSlackChannels("xoxb-token", fetchFn)).rejects.toMatchObject({
      code: "slack_channel_list_failed",
      message: "slack_channel_list_failed",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("sends form-encoded channel bodies for join and leave and accepts converged responses", async () => {
    const calls: Array<{
      operation: string;
      method: string | undefined;
      authorization: string | null;
      contentType: string | null;
      channel: string | null;
    }> = [];
    const fetchFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const operation = new URL(String(input)).pathname.split(".").at(-1) ?? "";
      const body = init?.body as URLSearchParams;
      calls.push({
        operation,
        method: init?.method,
        authorization: new Headers(init?.headers).get("authorization"),
        contentType: new Headers(init?.headers).get("content-type"),
        channel: body.get("channel"),
      });
      if (operation === "join" && body.get("channel") === "C-already") {
        return Response.json({ ok: false, error: "already_in_channel" });
      }
      if (operation === "leave" && body.get("channel") === "C-gone") {
        return Response.json({ ok: false, error: "not_in_channel" });
      }
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    await joinPublicSlackChannels("xoxb-token", ["C-already", "C-join"], fetchFn);
    await leavePublicSlackChannels("xoxb-token", ["C-gone", "C-leave"], fetchFn);

    expect(calls.map(({ operation, channel }) => ({ operation, channel }))).toEqual([
      { operation: "join", channel: "C-already" },
      { operation: "join", channel: "C-join" },
      { operation: "leave", channel: "C-gone" },
      { operation: "leave", channel: "C-leave" },
    ]);
    for (const call of calls) {
      expect(call.method).toBe("POST");
      expect(call.authorization).toBe("Bearer xoxb-token");
      expect(call.contentType).toBe("application/x-www-form-urlencoded");
    }
  });

  it("returns converged membership with safe structured join/leave failures", async () => {
    const rawProviderDetail = "canary-provider-detail-must-not-escape";
    const fetchFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const operation = new URL(String(input)).pathname.split(".").at(-1);
      const channel = (init?.body as URLSearchParams).get("channel");
      if (channel === "C-join-fail" || channel === "C-leave-fail") {
        return Response.json({ ok: false, error: rawProviderDetail });
      }
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const result = await reconcileSlackChannels(
      "xoxb-token",
      ["C-keep", "C-leave-ok", "C-leave-fail"],
      ["C-keep", "C-join-ok", "C-join-fail"],
      fetchFn,
    );

    expect(result).toEqual({
      channelIds: ["C-keep", "C-join-ok", "C-leave-fail"],
      joined: ["C-join-ok"],
      left: ["C-leave-ok"],
      failed: [
        {
          channelId: "C-join-fail",
          operation: "join",
          code: "slack_channel_join_failed",
        },
        {
          channelId: "C-leave-fail",
          operation: "leave",
          code: "slack_channel_leave_failed",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(rawProviderDetail);
  });

  it("maps direct join/leave provider, HTTP, JSON, and transport failures to safe operation codes", async () => {
    const canary = "canary-slack-provider-body";
    const token = "xoxb-token-must-not-escape";
    const cases: Array<{
      operation: "join" | "leave";
      fetchFn: typeof fetch;
      code: "slack_channel_join_failed" | "slack_channel_leave_failed";
    }> = [
      {
        operation: "join",
        fetchFn: mock(async () => Response.json({ ok: false, error: canary })) as unknown as typeof fetch,
        code: "slack_channel_join_failed",
      },
      {
        operation: "join",
        fetchFn: mock(async () => new Response(canary, { status: 200 })) as unknown as typeof fetch,
        code: "slack_channel_join_failed",
      },
      {
        operation: "leave",
        fetchFn: mock(async () => new Response(canary, { status: 503 })) as unknown as typeof fetch,
        code: "slack_channel_leave_failed",
      },
      {
        operation: "leave",
        fetchFn: mock(async () => {
          throw new Error(canary);
        }) as unknown as typeof fetch,
        code: "slack_channel_leave_failed",
      },
    ];

    for (const testCase of cases) {
      try {
        if (testCase.operation === "join") {
          await joinPublicSlackChannels(token, ["C-fail"], testCase.fetchFn);
        } else {
          await leavePublicSlackChannels(token, ["C-fail"], testCase.fetchFn);
        }
        throw new Error("expected membership failure");
      } catch (error) {
        expect(error).toBeInstanceOf(SlackProviderError);
        expect((error as SlackProviderError).code).toBe(testCase.code);
        expect((error as Error).message).toBe(testCase.code);
        expect((error as Error).message).not.toContain(canary);
        expect((error as Error).message).not.toContain(token);
      }
    }
  });

  it("maps malformed or provider-rejected list responses to one reviewed code", async () => {
    const rawProviderDetail = "canary-list-provider-detail";
    const fetchFn = mock(async () => Response.json({ ok: false, error: rawProviderDetail })) as unknown as typeof fetch;

    try {
      await listPublicSlackChannels("xoxb-token", fetchFn);
      throw new Error("expected list failure");
    } catch (error) {
      expect(error).toBeInstanceOf(SlackProviderError);
      expect((error as SlackProviderError).code).toBe("slack_channel_list_failed");
      expect((error as Error).message).toBe("slack_channel_list_failed");
      expect((error as Error).message).not.toContain(rawProviderDetail);
    }
  });
});

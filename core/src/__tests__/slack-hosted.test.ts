import { describe, expect, it, mock } from "bun:test";
import { readFileSync } from "fs";
import {
  buildSlackManifestUrl,
  fetchSlackChannels,
  joinPublicSlackChannels,
  leavePublicSlackChannels,
  listPublicSlackChannels,
  listSlackChannels,
  slackManifest,
  SlackProviderError,
  type SlackProviderErrorCode,
  validateSlackTokenFormat,
} from "../integrations/slack-hosted";

const manifestPath = new URL("../../../background/integrations/slack/manifest.json", import.meta.url);

describe("hosted Slack manifest", () => {
  it("matches the canonical manifest imported at compile time", () => {
    expect(slackManifest).toEqual(JSON.parse(readFileSync(manifestPath, "utf8")));
  });

  it("builds a decodable Slack URL containing the exact canonical manifest", () => {
    const result = buildSlackManifestUrl();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected manifest URL");
    const url = new URL(result.url);
    expect(url.origin).toBe("https://api.slack.com");
    expect(url.pathname).toBe("/apps");
    expect([...url.searchParams.keys()].sort()).toEqual(["manifest_json", "new_app"]);
    expect(url.searchParams.get("new_app")).toBe("1");
    expect(JSON.parse(url.searchParams.get("manifest_json")!)).toEqual(slackManifest);
  });
});

describe("hosted Slack token validation", () => {
  it("validates prefixes only", () => {
    expect(validateSlackTokenFormat("xoxb-", "xapp-")).toEqual({ ok: true });
    expect(validateSlackTokenFormat("xoxb-any-value", "xapp-any-value")).toEqual({ ok: true });
    expect(validateSlackTokenFormat("xapp-wrong", "xapp-ok")).toEqual({
      ok: false,
      error: "Bot tokens start with xoxb-.",
    });
    expect(validateSlackTokenFormat("xoxb-ok", "xoxb-wrong")).toEqual({
      ok: false,
      error: "App tokens start with xapp-.",
    });
  });
});

describe("hosted Slack channel listing", () => {
  it("walks all cursor pages, authenticates each request, and sorts the aggregate", async () => {
    const calls: Array<{ url: URL; auth: string | null }> = [];
    const fetchFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (!url.searchParams.has("cursor")) {
        return Response.json({
          ok: true,
          channels: [{ id: "C1", name: "small", num_members: 2, is_member: false }],
          response_metadata: { next_cursor: "next page" },
        });
      }
      return Response.json({
        ok: true,
        channels: [{ id: "C2", name: "large", num_members: 50, is_member: true }],
        response_metadata: { next_cursor: "" },
      });
    }) as unknown as typeof fetch;

    await expect(listPublicSlackChannels("xoxb-list-canary", fetchFn)).resolves.toEqual([
      { id: "C2", name: "large", memberCount: 50, isMember: true },
      { id: "C1", name: "small", memberCount: 2, isMember: false },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.auth)).toEqual([
      "Bearer xoxb-list-canary",
      "Bearer xoxb-list-canary",
    ]);
    for (const call of calls) {
      expect(call.url.searchParams.get("types")).toBe("public_channel");
      expect(call.url.searchParams.get("limit")).toBe("200");
      expect(call.url.searchParams.get("exclude_archived")).toBe("true");
    }
    expect(calls[1]!.url.searchParams.get("cursor")).toBe("next page");
  });

  it("returns an empty result union for an empty page", async () => {
    for (const payload of [
      { ok: true, channels: [], response_metadata: { next_cursor: "" } },
      { ok: true, response_metadata: { next_cursor: "" } },
    ]) {
      const fetchFn = mock(async () => Response.json(payload)) as unknown as typeof fetch;
      await expect(fetchSlackChannels("xoxb-token", "public_channel", fetchFn)).resolves.toEqual({
        ok: true,
        channels: [],
      });
    }
  });

  it("rejects repeated cursors and caps the page walk", async () => {
    const repeated = mock(async () => Response.json({
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "repeat" },
    })) as unknown as typeof fetch;
    await expect(listPublicSlackChannels("xoxb-token", repeated)).rejects.toMatchObject({
      code: "slack_channel_list_failed",
    });
    expect(repeated).toHaveBeenCalledTimes(2);

    let page = 0;
    const unbounded = mock(async () => Response.json({
      ok: true,
      channels: [],
      response_metadata: { next_cursor: `cursor-${++page}` },
    })) as unknown as typeof fetch;
    await expect(listSlackChannels("xoxb-token", "public_channel", unbounded)).rejects.toMatchObject({
      code: "slack_channel_list_failed",
    });
    expect(unbounded).toHaveBeenCalledTimes(1_000);
  });

  it("collapses malformed, HTTP, provider, and transport failures without leaking details", async () => {
    const canary = "raw-list-canary";
    const token = "xoxb-list-secret-canary";
    const cases = [
      mock(async () => Response.json({ ok: true, channels: "bad" })),
      mock(async () => Response.json({ ok: true, channels: [{ id: "C1" }] })),
      mock(async () => Response.json({ ok: false, error: canary })),
      mock(async () => new Response(canary, { status: 503 })),
      mock(async () => new Response(canary, { status: 200 })),
      mock(async () => { throw new Error(canary); }),
    ];

    for (const fetchCase of cases) {
      const fetchFn = fetchCase as unknown as typeof fetch;
      try {
        await listPublicSlackChannels(token, fetchFn);
        throw new Error("expected list failure");
      } catch (error) {
        expect(error).toBeInstanceOf(SlackProviderError);
        expect((error as SlackProviderError).code).toBe("slack_channel_list_failed");
        expect((error as Error).message).toBe("slack_channel_list_failed");
        expect(JSON.stringify(error)).not.toContain(canary);
        expect(JSON.stringify(error)).not.toContain(token);
      }
      await expect(fetchSlackChannels(token, "public_channel", fetchFn)).resolves.toEqual({
        ok: false,
        error: "Could not fetch Slack channels.",
      });
    }
  });
});

describe("hosted Slack channel membership", () => {
  it("uses form bodies and accepts already-converged join and leave responses", async () => {
    const calls: Array<{ operation: string; channel: string | null; headers: Headers; method?: string }> = [];
    const fetchFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const operation = new URL(String(input)).pathname.split(".").at(-1)!;
      const channel = (init?.body as URLSearchParams).get("channel");
      calls.push({ operation, channel, headers: new Headers(init?.headers), method: init?.method });
      if (channel === "C-already") return Response.json({ ok: false, error: "already_in_channel" });
      if (channel === "C-gone") return Response.json({ ok: false, error: "not_in_channel" });
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
      expect(call.headers.get("authorization")).toBe("Bearer xoxb-token");
      expect(call.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    }
  });

  it("returns only stable operation codes for provider, HTTP, JSON, and transport failures", async () => {
    const canary = "raw-membership-canary";
    const token = "xoxb-membership-secret";
    const cases: Array<{
      operation: "join" | "leave";
      fetchFn: typeof fetch;
      code: SlackProviderErrorCode;
    }> = [
      { operation: "join", fetchFn: mock(async () => Response.json({ ok: false, error: canary })) as unknown as typeof fetch, code: "slack_channel_join_failed" },
      { operation: "join", fetchFn: mock(async () => new Response(canary, { status: 200 })) as unknown as typeof fetch, code: "slack_channel_join_failed" },
      { operation: "leave", fetchFn: mock(async () => new Response(canary, { status: 503 })) as unknown as typeof fetch, code: "slack_channel_leave_failed" },
      { operation: "leave", fetchFn: mock(async () => { throw new Error(canary); }) as unknown as typeof fetch, code: "slack_channel_leave_failed" },
    ];

    for (const testCase of cases) {
      try {
        const operation = testCase.operation === "join" ? joinPublicSlackChannels : leavePublicSlackChannels;
        await operation(token, ["C-fail"], testCase.fetchFn);
        throw new Error("expected membership failure");
      } catch (error) {
        expect(error).toBeInstanceOf(SlackProviderError);
        expect((error as SlackProviderError).code).toBe(testCase.code);
        expect((error as Error).message).toBe(testCase.code);
        expect(JSON.stringify(error)).not.toContain(canary);
        expect(JSON.stringify(error)).not.toContain(token);
      }
    }
  });
});

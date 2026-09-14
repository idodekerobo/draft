import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SlackRateLimitedError, type SlackMessagePage } from "draft-core/integrations/slack-hosted";
import {
  buildInitialSlackBackfillState,
  resolveSlackBackfillCutoff,
  runSlackBackfillDispatch,
  SLACK_BACKFILL_MAX_REQUESTS_PER_DISPATCH,
  type SlackBackfillDeps,
  type SlackBackfillState,
} from "../../../ingestion/slack/backfill";

const WORKSPACE_ID = "workspace-1";
const CONNECTION_ID = "connection-1";
const ORG_ID = "org-1";
const CREDENTIAL_ID = "credential-1";

function baseConnection(state: SlackBackfillState, channelIds: string[] = ["C1"]) {
  return {
    id: CONNECTION_ID,
    workspace_id: WORKSPACE_ID,
    organization_id: ORG_ID,
    credential_id: CREDENTIAL_ID,
    config_json: { channel_ids: channelIds },
    cursor_json: { slack_backfill: state },
  };
}

interface UpdateCall {
  table: string;
  payload: Record<string, unknown>;
  filters: Record<string, unknown>;
}

function fakeClient(): { client: SupabaseClient; updates: UpdateCall[] } {
  const updates: UpdateCall[] = [];
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        update(payload: Record<string, unknown>) {
          return {
            eq(col: string, val: unknown) {
              filters[col] = val;
              return this;
            },
            then(resolve: (v: unknown) => unknown) {
              updates.push({ table, payload, filters: { ...filters } });
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, updates };
}

function latestState(updates: UpdateCall[]): SlackBackfillState {
  const relevant = updates.filter((u) => u.table === "source_connections");
  const last = relevant[relevant.length - 1];
  return (last!.payload.cursor_json as { slack_backfill: SlackBackfillState }).slack_backfill;
}

function page(messages: Array<Record<string, unknown>>, nextCursor: string | null = null): SlackMessagePage {
  return { messages, hasMore: nextCursor !== null, nextCursor };
}

describe("resolveSlackBackfillCutoff", () => {
  const originalEnv = process.env.DRAFT_SLACK_BACKFILL_DAYS;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DRAFT_SLACK_BACKFILL_DAYS;
    else process.env.DRAFT_SLACK_BACKFILL_DAYS = originalEnv;
  });

  it("defaults to 7 days back", () => {
    delete process.env.DRAFT_SLACK_BACKFILL_DAYS;
    const now = new Date("2026-09-14T00:00:00.000Z");
    expect(resolveSlackBackfillCutoff(now)).toBe("2026-09-07T00:00:00.000Z");
  });

  it("honors DRAFT_SLACK_BACKFILL_DAYS", () => {
    process.env.DRAFT_SLACK_BACKFILL_DAYS = "3";
    const now = new Date("2026-09-14T00:00:00.000Z");
    expect(resolveSlackBackfillCutoff(now)).toBe("2026-09-11T00:00:00.000Z");
  });
});

describe("buildInitialSlackBackfillState", () => {
  it("starts in_progress with a populated channel queue", () => {
    const state = buildInitialSlackBackfillState(["C1", "C2"], new Date("2026-09-14T00:00:00.000Z"));
    expect(state.status).toBe("in_progress");
    expect(state.pending_channel_ids).toEqual(["C1", "C2"]);
    expect(state.completed_at).toBeNull();
    expect(state.cutoff).toBe("2026-09-07T00:00:00.000Z");
  });

  it("starts completed immediately when there are no configured channels", () => {
    const state = buildInitialSlackBackfillState([], new Date("2026-09-14T00:00:00.000Z"));
    expect(state.status).toBe("completed");
    expect(state.completed_at).not.toBeNull();
  });
});

describe("runSlackBackfillDispatch", () => {
  let deps: SlackBackfillDeps;
  let handled: Array<{ message: Record<string, unknown>; channelId: string }>;

  beforeEach(() => {
    handled = [];
    deps = {
      fetchSlackConversationHistory: mock(async () => page([])),
      fetchSlackConversationReplies: mock(async () => page([])),
      handleSlackMessageEvent: mock(async (message, ctx) => {
        handled.push({ message, channelId: ctx.channelId });
      }) as unknown as SlackBackfillDeps["handleSlackMessageEvent"],
      resolveProviderCredentialById: mock(async () => ({ bot_token: "xoxb-test", app_token: "xapp-test" })) as unknown as SlackBackfillDeps["resolveProviderCredentialById"],
    };
  });

  it("does nothing once already completed", async () => {
    const state = buildInitialSlackBackfillState([]);
    const { client, updates } = fakeClient();
    await runSlackBackfillDispatch(baseConnection({ ...state, status: "completed" }), client, deps);
    expect(deps.resolveProviderCredentialById).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("does nothing before next_eligible_attempt_at elapses", async () => {
    const state = buildInitialSlackBackfillState(["C1"]);
    state.next_eligible_attempt_at = new Date(Date.now() + 60_000).toISOString();
    const { client, updates } = fakeClient();
    await runSlackBackfillDispatch(baseConnection(state), client, deps);
    expect(deps.resolveProviderCredentialById).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("completes and disables the task once the channel queue is empty with none in progress", async () => {
    const state = buildInitialSlackBackfillState(["C1"]);
    state.pending_channel_ids = [];
    state.current_channel_id = null;
    state.done_channel_ids = ["C1"];
    const { client, updates } = fakeClient();

    await runSlackBackfillDispatch(baseConnection(state, ["C1"]), client, deps);

    const final = latestState(updates);
    expect(final.status).toBe("completed");
    expect(updates.some((u) => u.table === "scheduled_tasks" && u.payload.enabled === false)).toBe(true);
  });

  it("ingests one channel's single history page and marks it done and completed", async () => {
    (deps.fetchSlackConversationHistory as ReturnType<typeof mock>).mockImplementation(async () =>
      page([{ ts: "100.000001", text: "hello" }]),
    );
    const state = buildInitialSlackBackfillState(["C1"]);
    const { client, updates } = fakeClient();

    await runSlackBackfillDispatch(baseConnection(state, ["C1"]), client, deps);

    expect(handled).toEqual([{ message: { ts: "100.000001", text: "hello" }, channelId: "C1" }]);
    const final = latestState(updates);
    expect(final.status).toBe("completed");
    expect(final.done_channel_ids).toEqual(["C1"]);
    expect(final.completed_at).not.toBeNull();
  });

  it("passes the fixed cutoff as `oldest` and resumes from a persisted history cursor", async () => {
    let calls = 0;
    (deps.fetchSlackConversationHistory as ReturnType<typeof mock>).mockImplementation(async (_token, _channel, options) => {
      calls += 1;
      expect(options.oldest).toBeDefined();
      if (calls === 1) {
        expect(options.cursor).toBeUndefined();
        return page([{ ts: "100.0" }], "cursor-2");
      }
      expect(options.cursor).toBe("cursor-2");
      return page([{ ts: "200.0" }], null);
    });
    const state = buildInitialSlackBackfillState(["C1"]);
    const { client, updates } = fakeClient();

    await runSlackBackfillDispatch(baseConnection(state, ["C1"]), client, deps);

    expect(calls).toBe(2);
    expect(handled.map((h) => h.message.ts)).toEqual(["100.0", "200.0"]);
    expect(latestState(updates).status).toBe("completed");
  });

  it("fetches replies for a thread parent and skips the parent itself in the replies page", async () => {
    (deps.fetchSlackConversationHistory as ReturnType<typeof mock>).mockImplementation(async () =>
      page([{ ts: "100.0", thread_ts: "100.0", reply_count: 2 }]),
    );
    (deps.fetchSlackConversationReplies as ReturnType<typeof mock>).mockImplementation(async (_token, channelId, threadTs) => {
      expect(channelId).toBe("C1");
      expect(threadTs).toBe("100.0");
      return page([{ ts: "100.0", thread_ts: "100.0" }, { ts: "100.1", thread_ts: "100.0", text: "reply" }]);
    });
    const state = buildInitialSlackBackfillState(["C1"]);
    const { client, updates } = fakeClient();

    await runSlackBackfillDispatch(baseConnection(state, ["C1"]), client, deps);

    // The parent (from history) plus only the reply (not the re-listed parent from the replies page).
    expect(handled.map((h) => h.message.ts)).toEqual(["100.0", "100.1"]);
    expect(latestState(updates).status).toBe("completed");
  });

  it("caps API calls at the per-dispatch budget and leaves resumable state", async () => {
    const channelIds = Array.from({ length: SLACK_BACKFILL_MAX_REQUESTS_PER_DISPATCH + 5 }, (_, i) => `C${i}`);
    (deps.fetchSlackConversationHistory as ReturnType<typeof mock>).mockImplementation(async () => page([]));
    const state = buildInitialSlackBackfillState(channelIds);
    const { client, updates } = fakeClient();

    await runSlackBackfillDispatch(baseConnection(state, channelIds), client, deps);

    expect(deps.fetchSlackConversationHistory).toHaveBeenCalledTimes(SLACK_BACKFILL_MAX_REQUESTS_PER_DISPATCH);
    const final = latestState(updates);
    expect(final.status).not.toBe("completed");
    // The budget is enforced strictly on network calls: the last channel
    // touched may have its history fetched (consuming the final request)
    // without yet being folded into done_channel_ids -- that bookkeeping
    // happens for free on the very next dispatch, with no extra request.
    const touched = final.done_channel_ids.length + (final.current_channel_id ? 1 : 0);
    expect(touched).toBe(SLACK_BACKFILL_MAX_REQUESTS_PER_DISPATCH);
    expect(final.pending_channel_ids).toHaveLength(5);
    if (final.current_channel_id) expect(final.history_done).toBe(true);
  });

  it("on a 429, persists next_eligible_attempt_at and marks partial without throwing", async () => {
    (deps.fetchSlackConversationHistory as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new SlackRateLimitedError(42);
    });
    const state = buildInitialSlackBackfillState(["C1"]);
    const { client, updates } = fakeClient();

    await runSlackBackfillDispatch(baseConnection(state, ["C1"]), client, deps);

    const final = latestState(updates);
    expect(final.status).toBe("partial");
    expect(final.next_eligible_attempt_at).not.toBeNull();
    const waitMs = new Date(final.next_eligible_attempt_at!).getTime() - Date.now();
    expect(waitMs).toBeGreaterThan(40_000);
    expect(waitMs).toBeLessThan(45_000);
  });

  it("on a non-rate-limit error, persists a sanitized last_error and marks partial without throwing", async () => {
    (deps.fetchSlackConversationHistory as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error("request to https://slack.com failed with token xoxb-super-secret-value");
    });
    const state = buildInitialSlackBackfillState(["C1"]);
    const { client, updates } = fakeClient();

    await runSlackBackfillDispatch(baseConnection(state, ["C1"]), client, deps);

    const final = latestState(updates);
    expect(final.status).toBe("partial");
    expect(final.last_error).not.toContain("xoxb-super-secret-value");
    expect(final.last_error).toContain("[REDACTED]");
  });
});

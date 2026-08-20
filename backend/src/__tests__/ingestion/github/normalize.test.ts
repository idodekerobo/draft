import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ingestGithubPullRequestEvent,
  ingestGithubPushEvent,
  type GithubPullRequestWebhookPayload,
  type GithubPushWebhookPayload,
} from "../../../ingestion/github/normalize";

const connection = { id: "conn-1", workspace_id: "ws-1" };

interface FakeState {
  existingItem: { external_version: string } | null;
  upsertCalls: Record<string, unknown>[];
  insertEventCalls: Record<string, unknown>[];
}

// normalize.ts's own idempotency lookup and upsertSourceItem's internal
// prior-ready-revision lookup both chain select().eq().eq().eq() on
// source_items and differ only in their terminal call (maybeSingle vs.
// neq), so the fake exposes both terminals rather than guessing call order.
function createFakeClientForUpsert(existingItem: { external_version: string } | null = null) {
  const state: FakeState = { existingItem, upsertCalls: [], insertEventCalls: [] };

  function from(table: string) {
    if (table === "source_items") {
      const terminal = {
        maybeSingle: async () => ({ data: state.existingItem, error: null }),
        neq: async () => ({ data: [], error: null }),
      };
      return {
        select: () => ({ eq: () => ({ eq: () => ({ eq: () => terminal }) }) }),
        upsert: (payload: Record<string, unknown>) => {
          state.upsertCalls.push(payload);
          return {
            select: () => ({
              single: async () => ({ data: { id: `item-${state.upsertCalls.length}`, ...payload }, error: null }),
            }),
          };
        },
        update: () => ({ in: async () => ({ error: null }) }),
      };
    }
    if (table === "workspace_events") {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            }),
          }),
        }),
        insert: async (payload: Record<string, unknown>) => {
          state.insertEventCalls.push(payload);
          return { error: null };
        },
      };
    }
    throw new Error(`Unexpected table in fake client: ${table}`);
  }

  return { client: { from } as unknown as SupabaseClient, state };
}

function basePrPayload(overrides: Partial<GithubPullRequestWebhookPayload> = {}): GithubPullRequestWebhookPayload {
  return {
    action: "opened",
    pull_request: {
      node_id: "PR_node1",
      number: 42,
      title: "Add feature",
      body: "Some description",
      state: "open",
      draft: false,
      updated_at: "2026-08-18T12:00:00Z",
      html_url: "https://github.com/acme/repo/pull/42",
      user: { login: "octocat" },
      base: { ref: "main" },
      head: { ref: "feature" },
      labels: [{ name: "bug" }],
    },
    repository: { full_name: "acme/repo" },
    ...overrides,
  };
}

describe("ingestGithubPullRequestEvent", () => {
  it("skips actions outside PR_ACTIONS_TO_INGEST", async () => {
    const { client, state } = createFakeClientForUpsert();
    const result = await ingestGithubPullRequestEvent(connection, basePrPayload({ action: "assigned" }), client);
    expect(result).toEqual({ skipped: true });
    expect(state.upsertCalls).toHaveLength(0);
  });

  it("ingests an opened PR with markdown built from known fields", async () => {
    const { client, state } = createFakeClientForUpsert(null);
    const result = await ingestGithubPullRequestEvent(connection, basePrPayload(), client);
    expect(result).toEqual({ sourceItemId: "item-1" });
    const upserted = state.upsertCalls[0];
    expect(upserted.external_id).toBe("PR_node1");
    expect(upserted.external_version).toBe("2026-08-18T12:00:00Z");
    const markdown = upserted.content_markdown as string;
    expect(markdown).toContain("PR #42 — Add feature");
    expect(markdown).toContain("**Author:** octocat");
    expect(markdown).toContain("main ← feature");
    expect(markdown).toContain("bug");
    expect(state.insertEventCalls).toHaveLength(1);
  });

  it("skips a redelivered/out-of-order payload that isn't strictly newer", async () => {
    const { client, state } = createFakeClientForUpsert({ external_version: "2026-08-18T12:00:00Z" });
    const result = await ingestGithubPullRequestEvent(connection, basePrPayload(), client);
    expect(result).toEqual({ skipped: true });
    expect(state.upsertCalls).toHaveLength(0);
  });

  it("processes a strictly newer payload over an older existing revision", async () => {
    const { client, state } = createFakeClientForUpsert({ external_version: "2026-08-18T11:00:00Z" });
    const result = await ingestGithubPullRequestEvent(connection, basePrPayload(), client);
    expect(result).toEqual({ sourceItemId: "item-1" });
    expect(state.upsertCalls).toHaveLength(1);
  });
});

function basePushPayload(overrides: Partial<GithubPushWebhookPayload> = {}): GithubPushWebhookPayload {
  return {
    ref: "refs/heads/main",
    repository: { full_name: "acme/repo", default_branch: "main" },
    commits: [
      {
        id: "abc123def456",
        message: "Fix bug",
        url: "https://github.com/acme/repo/commit/abc123def456",
        timestamp: "2026-08-18T12:00:00Z",
        author: { name: "Octo Cat", username: "octocat" },
      },
    ],
    ...overrides,
  };
}

describe("ingestGithubPushEvent", () => {
  it("skips pushes to a non-default branch", async () => {
    const { client, state } = createFakeClientForUpsert();
    const result = await ingestGithubPushEvent(
      connection,
      basePushPayload({ ref: "refs/heads/feature-x" }),
      client,
    );
    expect(result).toEqual({ skipped: true });
    expect(state.upsertCalls).toHaveLength(0);
  });

  it("ingests each commit on a default-branch push", async () => {
    const { client, state } = createFakeClientForUpsert();
    const result = await ingestGithubPushEvent(connection, basePushPayload(), client);
    expect(result).toEqual({ sourceItemIds: ["item-1"] });
    const upserted = state.upsertCalls[0];
    expect(upserted.external_id).toBe("abc123def456");
    expect(upserted.external_version).toBe("abc123def456");
    const markdown = upserted.content_markdown as string;
    expect(markdown).toContain("Commit abc123d on main");
    expect(markdown).toContain("Fix bug");
    expect(state.insertEventCalls).toHaveLength(1);
  });
});

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { setupDbIntegrationTest } from "./support";

const { describeWithDatabase, db, createWorkspace } = setupDbIntegrationTest("retrieval", "retrieval");

async function createConnection(
  workspaceId: string,
  provider: "slack" | "fireflies" | "github" = "slack",
  status: "pending" | "active" | "degraded" | "revoked" | "error" = "active",
): Promise<string> {
  const [connection] = await db()<[{ id: string }]>`
    insert into source_connections (workspace_id, provider, connection_key, status)
    values (${workspaceId}, ${provider}, ${randomUUID()}, ${status})
    returning id
  `;
  return connection.id;
}

async function createContributor(workspaceId: string): Promise<string> {
  const [row] = await db()<[{ id: string }]>`
    insert into session_contributors (workspace_id, git_email)
    values (${workspaceId}, ${`contributor-${randomUUID()}@example.com`})
    returning id
  `;
  return row.id;
}

async function createUser(): Promise<string> {
  const id = randomUUID();
  await db()`
    insert into auth.users (id, email) values (${id}, ${`retrieval-${id}@example.com`})
  `;
  return id;
}

interface SourceItemOptions {
  itemType?: string;
  content?: string;
  externalVersion?: string;
  contentHash?: string;
  lifecycleStatus?: string;
  visibility?: "shared" | "private";
  ownerUserId?: string | null;
  occurredAt?: Date;
}

async function insertSourceItem(
  workspaceId: string,
  connectionId: string,
  options: SourceItemOptions = {},
): Promise<string> {
  const {
    itemType = "message",
    content = "hello world",
    externalVersion = "v1",
    contentHash = randomUUID().replace(/-/g, "").padEnd(64, "0"),
    lifecycleStatus = "active",
    visibility = "shared",
    ownerUserId = null,
    occurredAt = new Date(),
  } = options;
  const [row] = await db()<[{ id: string }]>`
    insert into source_items (
      workspace_id, source_connection_id, item_type, external_id, external_version,
      lifecycle_status, occurred_at, content_markdown, content_hash, visibility, owner_user_id
    ) values (
      ${workspaceId}, ${connectionId}, ${itemType}, ${randomUUID()}, ${externalVersion},
      ${lifecycleStatus}, ${occurredAt}, ${content}, ${contentHash}, ${visibility}, ${ownerUserId}
    )
    returning id
  `;
  return row.id;
}

async function searchSources(
  workspaceId: string,
  callerUserId: string,
  query: string,
  extra: Partial<{
    provider: string | null;
    types: string[] | null;
    since: Date | null;
    until: Date | null;
    afterRank: number | null;
    afterOccurredAt: Date | null;
    afterId: string | null;
    limit: number;
  }> = {},
): Promise<Array<{ source_item_id: string; rank: number; occurred_at: Date }>> {
  const rows = await db()<Array<{ source_item_id: string; rank: number; occurred_at: Date }>>`
    select source_item_id, rank, occurred_at from search_sources(
      ${workspaceId}, ${callerUserId}, ${query},
      ${extra.provider ?? null}, ${extra.types ? db().array(extra.types, "text") : null},
      ${extra.since ?? null}, ${extra.until ?? null},
      ${extra.afterRank ?? null}::real, ${extra.afterOccurredAt ?? null}, ${extra.afterId ?? null},
      ${extra.limit ?? 11}
    )
  `;
  return rows;
}

describeWithDatabase("source retrieval migration", () => {
  describe("search_sources visibility and filters", () => {
    test("excludes non-active lifecycle statuses", async () => {
      const { workspaceId } = await createWorkspace();
      const connectionId = await createConnection(workspaceId);
      const caller = await createUser();

      const active = await insertSourceItem(workspaceId, connectionId, { content: "unique-marker-alpha" });
      await insertSourceItem(workspaceId, connectionId, {
        content: "unique-marker-alpha",
        lifecycleStatus: "superseded",
        externalVersion: "v0",
      });
      await insertSourceItem(workspaceId, connectionId, {
        content: "unique-marker-alpha",
        lifecycleStatus: "received",
        externalVersion: "v-received",
      });

      const results = await searchSources(workspaceId, caller, "unique-marker-alpha");
      expect(results.map((r) => r.source_item_id)).toEqual([active]);
    });

    test("private sources are visible only to their owner", async () => {
      const { workspaceId } = await createWorkspace();
      const connectionId = await createConnection(workspaceId, "fireflies");
      const owner = await createUser();
      const stranger = await createUser();

      const privateItem = await insertSourceItem(workspaceId, connectionId, {
        content: "confidential-marker-beta",
        visibility: "private",
        ownerUserId: owner,
      });
      const sharedItem = await insertSourceItem(workspaceId, connectionId, {
        content: "confidential-marker-beta shared",
        visibility: "shared",
      });

      const ownerResults = await searchSources(workspaceId, owner, "confidential-marker-beta");
      expect(new Set(ownerResults.map((r) => r.source_item_id))).toEqual(new Set([privateItem, sharedItem]));

      const strangerResults = await searchSources(workspaceId, stranger, "confidential-marker-beta");
      expect(strangerResults.map((r) => r.source_item_id)).toEqual([sharedItem]);
    });

    test("workspace filter isolates results from other workspaces", async () => {
      const { workspaceId: workspaceA } = await createWorkspace();
      const { workspaceId: workspaceB } = await createWorkspace();
      const connectionA = await createConnection(workspaceA);
      const connectionB = await createConnection(workspaceB);
      const callerA = await createUser();

      await insertSourceItem(workspaceB, connectionB, { content: "cross-workspace-marker-gamma" });
      const itemA = await insertSourceItem(workspaceA, connectionA, { content: "cross-workspace-marker-gamma" });

      const results = await searchSources(workspaceA, callerA, "cross-workspace-marker-gamma");
      expect(results.map((r) => r.source_item_id)).toEqual([itemA]);
    });

    test("provider and type filters narrow results", async () => {
      const { workspaceId } = await createWorkspace();
      const slackConnection = await createConnection(workspaceId, "slack");
      const githubConnection = await createConnection(workspaceId, "github");
      const caller = await createUser();

      const slackItem = await insertSourceItem(workspaceId, slackConnection, {
        content: "filter-marker-delta",
        itemType: "message",
      });
      await insertSourceItem(workspaceId, githubConnection, {
        content: "filter-marker-delta",
        itemType: "provider_event",
      });

      const byProvider = await searchSources(workspaceId, caller, "filter-marker-delta", { provider: "slack" });
      expect(byProvider.map((r) => r.source_item_id)).toEqual([slackItem]);

      const byType = await searchSources(workspaceId, caller, "filter-marker-delta", { types: ["message"] });
      expect(byType.map((r) => r.source_item_id)).toEqual([slackItem]);
    });

    test("since/until filter on source-time overlap, inclusive/exclusive as documented", async () => {
      const { workspaceId } = await createWorkspace();
      const connectionId = await createConnection(workspaceId);
      const caller = await createUser();

      const inRange = await insertSourceItem(workspaceId, connectionId, {
        content: "time-marker-epsilon",
        occurredAt: new Date("2026-06-15T00:00:00Z"),
      });
      const before = await insertSourceItem(workspaceId, connectionId, {
        content: "time-marker-epsilon",
        occurredAt: new Date("2026-06-01T00:00:00Z"),
      });
      const atUntilBoundary = await insertSourceItem(workspaceId, connectionId, {
        content: "time-marker-epsilon",
        occurredAt: new Date("2026-07-01T00:00:00Z"),
      });

      const results = await searchSources(workspaceId, caller, "time-marker-epsilon", {
        since: new Date("2026-06-10T00:00:00Z"),
        until: new Date("2026-07-01T00:00:00Z"),
      });
      const ids = results.map((r) => r.source_item_id);
      expect(ids).toContain(inRange);
      expect(ids).not.toContain(before);
      expect(ids).not.toContain(atUntilBoundary);
    });

    test("ranks by relevance then recency, with a stable id tiebreaker for pagination", async () => {
      const { workspaceId } = await createWorkspace();
      const connectionId = await createConnection(workspaceId);
      const caller = await createUser();

      // Identical content -> identical rank, so ordering must fall through
      // to occurred_at desc, then the id tiebreak on a further tie.
      const older = await insertSourceItem(workspaceId, connectionId, {
        content: "tiebreak-marker-zeta identical text",
        occurredAt: new Date("2026-01-01T00:00:00Z"),
      });
      const newer = await insertSourceItem(workspaceId, connectionId, {
        content: "tiebreak-marker-zeta identical text",
        occurredAt: new Date("2026-02-01T00:00:00Z"),
      });

      const page1 = await searchSources(workspaceId, caller, "tiebreak-marker-zeta", { limit: 1 });
      expect(page1).toHaveLength(1);
      expect(page1[0]!.source_item_id).toBe(newer);

      const page2 = await searchSources(workspaceId, caller, "tiebreak-marker-zeta", {
        limit: 1,
        afterRank: page1[0]!.rank,
        afterOccurredAt: page1[0]!.occurred_at,
        afterId: page1[0]!.source_item_id,
      });
      expect(page2).toHaveLength(1);
      expect(page2[0]!.source_item_id).toBe(older);
      expect(page2[0]!.source_item_id).not.toBe(page1[0]!.source_item_id);
    });

    test("keyset pagination reconstructs the full result set with no duplicates or gaps", async () => {
      const { workspaceId } = await createWorkspace();
      const connectionId = await createConnection(workspaceId);
      const caller = await createUser();

      const expectedIds = new Set<string>();
      for (let i = 0; i < 12; i++) {
        expectedIds.add(
          await insertSourceItem(workspaceId, connectionId, {
            content: `pagination-marker-eta item ${i}`,
            occurredAt: new Date(Date.UTC(2026, 0, 1 + i)),
          }),
        );
      }

      const seen: string[] = [];
      let cursor: { rank: number; occurredAt: Date; id: string } | undefined;
      for (let page = 0; page < 20 && seen.length < expectedIds.size; page++) {
        const rows = await searchSources(workspaceId, caller, "pagination-marker-eta", {
          limit: 5,
          afterRank: cursor?.rank ?? null,
          afterOccurredAt: cursor?.occurredAt ?? null,
          afterId: cursor?.id ?? null,
        });
        if (rows.length === 0) break;
        for (const row of rows) seen.push(row.source_item_id);
        const last = rows[rows.length - 1]!;
        cursor = { rank: last.rank, occurredAt: last.occurred_at, id: last.source_item_id };
      }

      expect(seen).toHaveLength(expectedIds.size);
      expect(new Set(seen)).toEqual(expectedIds);
    });
  });

  describe("commit_slack_source_batch atomicity", () => {
    async function insertPendingSlackMessage(
      workspaceId: string,
      connectionId: string,
      channelId: string,
      messageTs: string,
    ): Promise<string> {
      const [row] = await db()<[{ id: string }]>`
        insert into slack_messages (
          workspace_id, source_connection_id, channel_id, channel_name_snapshot, message_ts,
          message_version, slack_user_id, user_name_snapshot, text
        ) values (
          ${workspaceId}, ${connectionId}, ${channelId}, 'general', ${messageTs},
          ${messageTs}, 'U1', 'Test User', 'hello'
        )
        returning id
      `;
      return row.id;
    }

    test("two concurrent commits over the same messages: exactly one succeeds, the other reports stale_batch", async () => {
      const { workspaceId } = await createWorkspace();
      const connectionId = await createConnection(workspaceId);
      const messageId = await insertPendingSlackMessage(workspaceId, connectionId, "C1", "1000.000001");

      const commitOnce = () =>
        db()<[{ result: { status: string; item_id?: string } }]>`
          select commit_slack_source_batch(
            ${workspaceId}, ${connectionId}, 'C1', ${db().array([messageId], "uuid")},
            'C1:1000.000001', 'hash-v1', now(), now(), now(), 'rendered content',
            ${"a".repeat(64)}, '{}'::jsonb
          ) as result
        `;

      const [first, second] = await Promise.all([commitOnce(), commitOnce()]);
      const statuses = [first[0]!.result.status, second[0]!.result.status].sort();
      expect(statuses).toEqual(["committed", "stale_batch"]);

      const [linked] = await db()<[{ source_item_id: string | null }]>`
        select source_item_id from slack_messages where id = ${messageId}
      `;
      expect(linked.source_item_id).not.toBeNull();

      const [itemCount] = await db()<[{ count: string }]>`
        select count(*)::text as count from source_items
        where workspace_id = ${workspaceId} and item_type = 'message'
      `;
      expect(itemCount.count).toBe("1");
    });

    test("returns stale_batch (not a raised error) when a message was already claimed by a prior commit", async () => {
      const { workspaceId } = await createWorkspace();
      const connectionId = await createConnection(workspaceId);
      const messageId = await insertPendingSlackMessage(workspaceId, connectionId, "C2", "2000.000001");

      const [firstResult] = await db()<[{ result: { status: string } }]>`
        select commit_slack_source_batch(
          ${workspaceId}, ${connectionId}, 'C2', ${db().array([messageId], "uuid")},
          'C2:2000.000001', 'hash-v1', now(), now(), now(), 'rendered content',
          ${"b".repeat(64)}, '{}'::jsonb
        ) as result
      `;
      expect(firstResult.result.status).toBe("committed");

      const [secondResult] = await db()<[{ result: { status: string } }]>`
        select commit_slack_source_batch(
          ${workspaceId}, ${connectionId}, 'C2', ${db().array([messageId], "uuid")},
          'C2:2000.000001', 'hash-v2', now(), now(), now(), 'rendered content 2',
          ${"c".repeat(64)}, '{}'::jsonb
        ) as result
      `;
      expect(secondResult.result.status).toBe("stale_batch");
    });

    test("raises connection_inactive and commits nothing when the connection is revoked", async () => {
      const { workspaceId } = await createWorkspace();
      const connectionId = await createConnection(workspaceId, "slack", "active");
      const messageId = await insertPendingSlackMessage(workspaceId, connectionId, "C3", "3000.000001");

      await db()`update source_connections set status = 'revoked' where id = ${connectionId}`;

      let threw = false;
      try {
        await db()`
          select commit_slack_source_batch(
            ${workspaceId}, ${connectionId}, 'C3', ${db().array([messageId], "uuid")},
            'C3:3000.000001', 'hash-v1', now(), now(), now(), 'rendered content',
            ${"d".repeat(64)}, '{}'::jsonb
          )
        `;
      } catch (error) {
        threw = true;
        expect((error as Error & { message?: string }).message).toContain("connection_inactive");
      }
      expect(threw).toBe(true);

      const [linked] = await db()<[{ source_item_id: string | null }]>`
        select source_item_id from slack_messages where id = ${messageId}
      `;
      expect(linked.source_item_id).toBeNull();
    });
  });

  describe("get_pending_slack_channel_ids", () => {
    test("returns only channels with unlinked messages, keyset-paginated", async () => {
      const { workspaceId } = await createWorkspace();
      const connectionId = await createConnection(workspaceId);

      for (const channelId of ["C-a", "C-b", "C-c"]) {
        const messageTs = `${channelId}-ts.000001`;
        await db()`
          insert into slack_messages (
            workspace_id, source_connection_id, channel_id, channel_name_snapshot, message_ts,
            message_version, slack_user_id, user_name_snapshot, text
          ) values (
            ${workspaceId}, ${connectionId}, ${channelId}, ${channelId}, ${messageTs},
            ${messageTs}, 'U1', 'Test User', 'hello'
          )
        `;
      }
      // A fully-linked channel should not appear.
      const linkedItem = await insertSourceItem(workspaceId, connectionId, { content: "linked" });
      await db()`
        insert into slack_messages (
          workspace_id, source_connection_id, channel_id, channel_name_snapshot, message_ts,
          message_version, slack_user_id, user_name_snapshot, text, source_item_id
        ) values (
          ${workspaceId}, ${connectionId}, 'C-linked', 'C-linked', 'linked-ts.000002',
          'linked-ts.000002', 'U1', 'Test User', 'hello', ${linkedItem}
        )
      `;

      const page1 = await db()<[{ channel_id: string }]>`
        select * from get_pending_slack_channel_ids(${workspaceId}, ${connectionId}, null, 2)
      `;
      expect(page1.map((r) => r.channel_id)).toEqual(["C-a", "C-b"]);

      const page2 = await db()<[{ channel_id: string }]>`
        select * from get_pending_slack_channel_ids(${workspaceId}, ${connectionId}, ${page1[page1.length - 1]!.channel_id}, 2)
      `;
      expect(page2.map((r) => r.channel_id)).toEqual(["C-c"]);
    });
  });

  describe("replace_agent_session_messages transcript_revision", () => {
    test("increments atomically and each replace fully supersedes the prior message set", async () => {
      const { workspaceId } = await createWorkspace();
      const externalSessionId = randomUUID();
      const contributorId = await createContributor(workspaceId);

      const [first] = await db()<[{ result: { session_id: string; transcript_revision: number } }]>`
        select replace_agent_session_messages(
          ${workspaceId}, 'claude-code', ${externalSessionId}, null, ${contributorId}, 'proj', '/tmp',
          now(), now(), 'completed',
          ${[{ role: "user", content: "first" }]}::jsonb
        ) as result
      `;
      expect(first.result.transcript_revision).toBe(1);
      const sessionId = first.result.session_id;

      const [second] = await db()<[{ result: { session_id: string; transcript_revision: number } }]>`
        select replace_agent_session_messages(
          ${workspaceId}, 'claude-code', ${externalSessionId}, null, ${contributorId}, 'proj', '/tmp',
          now(), now(), 'completed',
          ${[{ role: "user", content: "second-a" }, { role: "assistant", content: "second-b" }]}::jsonb
        ) as result
      `;
      expect(second.result.session_id).toBe(sessionId);
      expect(second.result.transcript_revision).toBe(2);

      const messages = await db()<Array<{ content: string }>>`
        select content from agent_messages where session_id = ${sessionId} order by seq
      `;
      expect(messages.map((m) => m.content)).toEqual(["second-a", "second-b"]);

      const [sessionRow] = await db()<[{ transcript_revision: number }]>`
        select transcript_revision from agent_sessions where id = ${sessionId}
      `;
      expect(Number(sessionRow.transcript_revision)).toBe(2);
    });

    test("concurrent replaces on the same session serialize and leave a consistent final revision", async () => {
      const { workspaceId } = await createWorkspace();
      const externalSessionId = randomUUID();
      const contributorId = await createContributor(workspaceId);

      await db()`
        select replace_agent_session_messages(
          ${workspaceId}, 'claude-code', ${externalSessionId}, null, ${contributorId}, 'proj', '/tmp',
          now(), now(), 'completed', ${[{ role: "user", content: "seed" }]}::jsonb
        )
      `;

      const replaceWith = (label: string) =>
        db()`
          select replace_agent_session_messages(
            ${workspaceId}, 'claude-code', ${externalSessionId}, null, ${contributorId}, 'proj', '/tmp',
            now(), now(), 'completed', ${[{ role: "user", content: label }]}::jsonb
          )
        `;

      await Promise.all([replaceWith("race-a"), replaceWith("race-b")]);

      const [sessionRow] = await db()<[{ id: string; transcript_revision: number }]>`
        select id, transcript_revision from agent_sessions
        where workspace_id = ${workspaceId} and provider = 'claude-code' and external_session_id = ${externalSessionId}
      `;
      // Started at revision 1; two more successful, serialized replaces land on 3 exactly (no lost update).
      expect(Number(sessionRow.transcript_revision)).toBe(3);

      const messages = await db()<Array<{ content: string }>>`
        select content from agent_messages where session_id = ${sessionRow.id}
      `;
      // Whichever writer went last, the message set is exactly its own -- never a merge of both.
      expect(messages).toHaveLength(1);
      expect(["race-a", "race-b"]).toContain(messages[0]!.content);
    });
  });
});

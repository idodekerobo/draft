import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";

// Disposable Postgres gate for the Slack history backfill. Never falls back
// to the app's configured Supabase project:
//   DRAFT_INTEGRATION_TEST_DATABASE_URL=postgresql://... bun test <this-file>
//
// This suite covers the DB-level contract the backfill depends on --
// scheduled_tasks accepting the new task_type, and the shared Slack capture
// path (upsert_slack_message_if_connection_active) being safe to call from
// both live and historical capture without corruption or duplication --
// leaving the JS-level orchestration (pagination, budget, 429 handling,
// checkpoint resumption) to backend/src/__tests__/ingestion/slack/backfill.test.ts.
const testDatabaseUrl = process.env.DRAFT_INTEGRATION_TEST_DATABASE_URL;
const requireDatabase = process.env.DRAFT_REQUIRE_DB_INTEGRATION_TESTS === "1";
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const sql = testDatabaseUrl ? new SQL(testDatabaseUrl, { max: 8 }) : null;

if (requireDatabase && !testDatabaseUrl) {
  describe("slack backfill release gate", () => {
    test("requires an explicit disposable Postgres URL", () => {
      throw new Error("DRAFT_INTEGRATION_TEST_DATABASE_URL is required by the slack backfill release gate");
    });
  });
}

const organizationIds = new Set<string>();

function db(): SQL {
  if (!sql) throw new Error("DRAFT_INTEGRATION_TEST_DATABASE_URL is required");
  return sql;
}

interface WorkspaceFixture {
  organizationId: string;
  workspaceId: string;
}

async function createWorkspace(): Promise<WorkspaceFixture> {
  const suffix = randomUUID();
  const [organization] = await db()<[{ id: string }]>`
    insert into organizations (slug, name)
    values (${`backfill-org-${suffix}`}, 'Slack backfill contract test')
    returning id
  `;
  const [team] = await db()<[{ id: string }]>`
    insert into teams (organization_id, slug, name)
    values (${organization.id}, ${`backfill-team-${suffix}`}, 'Slack backfill contract test')
    returning id
  `;
  const [workspace] = await db()<[{ id: string }]>`
    insert into workspaces (organization_id, team_id, slug, name)
    values (${organization.id}, ${team.id}, ${`backfill-workspace-${suffix}`}, 'Slack backfill contract test')
    returning id
  `;
  organizationIds.add(organization.id);
  return { organizationId: organization.id, workspaceId: workspace.id };
}

async function createSlackConnection(
  workspaceId: string,
  status: "pending" | "active" | "degraded" | "revoked" | "error" = "active",
): Promise<string> {
  const [connection] = await db()<[{ id: string }]>`
    insert into source_connections (workspace_id, provider, connection_key, status)
    values (${workspaceId}, 'slack', ${randomUUID()}, ${status})
    returning id
  `;
  return connection.id;
}

async function captureSlackMessage(
  workspaceId: string,
  connectionId: string,
  channelId: string,
  messageTs: string,
  overrides: Partial<{ text: string; capturedAt: Date }> = {},
): Promise<{ message_id: string }> {
  const [row] = await db()<[{ result: { message_id: string } }]>`
    select upsert_slack_message_if_connection_active(
      ${workspaceId}, ${connectionId}, ${channelId}, 'general',
      ${messageTs}, ${messageTs}, null, null, 'U1', 'Test User',
      ${overrides.text ?? "hello"}, null, false, null, null,
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, ${overrides.capturedAt ?? new Date()}
    ) as result
  `;
  return row.result;
}

describeWithDatabase("slack backfill migration", () => {
  afterEach(async () => {
    if (!sql || organizationIds.size === 0) return;
    const ids = [...organizationIds];
    organizationIds.clear();
    await sql`delete from organizations where id = any(${sql.array(ids, "uuid")})`;
  });

  afterAll(async () => {
    await sql?.close();
  });

  describe("scheduled_tasks.task_type", () => {
    test("accepts slack_backfill", async () => {
      const { workspaceId } = await createWorkspace();
      const connectionId = await createSlackConnection(workspaceId);
      const [row] = await db()<[{ id: string }]>`
        insert into scheduled_tasks (
          workspace_id, source_connection_id, task_type, task_key,
          schedule_kind, interval_seconds, timezone
        ) values (
          ${workspaceId}, ${connectionId}, 'slack_backfill', ${connectionId},
          'interval', 60, 'UTC'
        )
        returning id
      `;
      expect(row.id).toBeTruthy();
    });

    test("still rejects an unknown task_type", async () => {
      const { workspaceId } = await createWorkspace();
      const connectionId = await createSlackConnection(workspaceId);
      let threw = false;
      try {
        await db()`
          insert into scheduled_tasks (
            workspace_id, source_connection_id, task_type, task_key,
            schedule_kind, interval_seconds, timezone
          ) values (
            ${workspaceId}, ${connectionId}, 'not_a_real_task_type', ${connectionId},
            'interval', 60, 'UTC'
          )
        `;
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });

  describe("upsert_slack_message_if_connection_active as the shared capture path", () => {
    test("historical and live capture of the identical message converge on one row", async () => {
      const { workspaceId } = await createWorkspace();
      const connectionId = await createSlackConnection(workspaceId);

      // Backfill discovers this message from conversations.history...
      const historical = await captureSlackMessage(workspaceId, connectionId, "C1", "1000.000001", { text: "original" });
      // ...and, in an overlap window, the live socket listener also delivers
      // the same event (same channel/ts/version) before backfill has moved
      // past this channel.
      const live = await captureSlackMessage(workspaceId, connectionId, "C1", "1000.000001", { text: "original" });

      expect(live.message_id).toBe(historical.message_id);

      const rows = await db()<Array<{ id: string }>>`
        select id from slack_messages
        where source_connection_id = ${connectionId} and channel_id = 'C1' and message_ts = '1000.000001'
      `;
      expect(rows).toHaveLength(1);
    });

    test("raises connection_inactive and writes nothing when the connection is revoked mid-backfill", async () => {
      const { workspaceId } = await createWorkspace();
      const connectionId = await createSlackConnection(workspaceId, "active");
      await captureSlackMessage(workspaceId, connectionId, "C1", "1000.000001");

      await db()`update source_connections set status = 'revoked' where id = ${connectionId}`;

      let threw = false;
      try {
        await captureSlackMessage(workspaceId, connectionId, "C1", "1000.000002");
      } catch (error) {
        threw = true;
        expect((error as Error).message).toContain("connection_inactive");
      }
      expect(threw).toBe(true);

      const rows = await db()<Array<{ message_ts: string }>>`
        select message_ts from slack_messages where source_connection_id = ${connectionId}
      `;
      expect(rows.map((r) => r.message_ts)).toEqual(["1000.000001"]);
    });
  });

  describe("backfill-captured messages compose with the existing materializer", () => {
    test("a channel populated only through upsert_slack_message_if_connection_active can be discovered and committed into exactly one source_item", async () => {
      const { workspaceId } = await createWorkspace();
      const connectionId = await createSlackConnection(workspaceId);

      // Simulate three historical messages the backfill discovered, written
      // through the same capture path live events use -- never touching
      // source_items directly.
      await captureSlackMessage(workspaceId, connectionId, "C1", "1000.000001", { text: "first" });
      await captureSlackMessage(workspaceId, connectionId, "C1", "1000.000002", { text: "second" });
      await captureSlackMessage(workspaceId, connectionId, "C1", "1000.000003", { text: "third" });

      const pendingChannels = await db()<Array<{ channel_id: string }>>`
        select * from get_pending_slack_channel_ids(${workspaceId}, ${connectionId}, null, 100)
      `;
      expect(pendingChannels.map((r) => r.channel_id)).toEqual(["C1"]);

      const messages = await db()<Array<{ id: string }>>`
        select id from slack_messages
        where source_connection_id = ${connectionId} and channel_id = 'C1'
        order by message_ts
      `;
      const [commitResult] = await db()<[{ result: { status: string; item_id?: string } }]>`
        select commit_slack_source_batch(
          ${workspaceId}, ${connectionId}, 'C1', ${db().array(messages.map((m) => m.id), "uuid")},
          'C1:1000.000001', 'backfill-batch-v1', now(), now(), now(), 'first\nsecond\nthird',
          ${"e".repeat(64)}, '{}'::jsonb
        ) as result
      `;
      expect(commitResult.result.status).toBe("committed");

      const [item] = await db()<[{ id: string; item_type: string; representation_kind: string }]>`
        select id, item_type, representation_kind from source_items where id = ${commitResult.result.item_id!}
      `;
      expect(item.item_type).toBe("message");
      expect(item.representation_kind).toBe("source");

      const linked = await db()<Array<{ source_item_id: string | null }>>`
        select source_item_id from slack_messages where source_connection_id = ${connectionId} and channel_id = 'C1'
      `;
      expect(linked.every((row) => row.source_item_id === item.id)).toBe(true);

      // No pending channels remain -- every message is now linked.
      const remaining = await db()<Array<{ channel_id: string }>>`
        select * from get_pending_slack_channel_ids(${workspaceId}, ${connectionId}, null, 100)
      `;
      expect(remaining).toHaveLength(0);
    });
  });
});

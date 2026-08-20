import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";

// This suite intentionally never falls back to the app's configured Supabase
// project. Point it at a disposable, fully migrated Postgres database:
//   DRAFT_INTEGRATION_TEST_DATABASE_URL=postgresql://... bun test <this-file>
const testDatabaseUrl = process.env.DRAFT_INTEGRATION_TEST_DATABASE_URL;
const requireDatabase = process.env.DRAFT_REQUIRE_DB_INTEGRATION_TESTS === "1";
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const sql = testDatabaseUrl ? new SQL(testDatabaseUrl, { max: 8 }) : null;

if (requireDatabase && !testDatabaseUrl) {
  describe("hosted integration lifecycle release gate", () => {
    test("requires an explicit disposable Postgres URL", () => {
      throw new Error(
        "DRAFT_INTEGRATION_TEST_DATABASE_URL is required by the lifecycle release gate",
      );
    });
  });
}

interface Fixture {
  organizationId: string;
  workspaceId: string;
}

interface ConnectionFixture extends Fixture {
  connectionId: string;
}

const organizationIds = new Set<string>();

function db(): SQL {
  if (!sql) throw new Error("DRAFT_INTEGRATION_TEST_DATABASE_URL is required");
  return sql;
}

async function createWorkspace(): Promise<Fixture> {
  const suffix = randomUUID();
  const [organization] = await db()<[{ id: string }]>`
    insert into organizations (slug, name)
    values (${`lifecycle-org-${suffix}`}, 'Lifecycle contract test')
    returning id
  `;
  const [team] = await db()<[{ id: string }]>`
    insert into teams (organization_id, slug, name)
    values (${organization.id}, ${`lifecycle-team-${suffix}`}, 'Lifecycle contract test')
    returning id
  `;
  const [workspace] = await db()<[{ id: string }]>`
    insert into workspaces (organization_id, team_id, slug, name)
    values (
      ${organization.id}, ${team.id}, ${`lifecycle-workspace-${suffix}`},
      'Lifecycle contract test'
    )
    returning id
  `;

  organizationIds.add(organization.id);
  return { organizationId: organization.id, workspaceId: workspace.id };
}

async function createConnection(
  provider: "fireflies" | "github" | "linear" | "slack",
  status: "pending" | "active" | "degraded" | "revoked" | "error" = "active",
): Promise<ConnectionFixture> {
  const fixture = await createWorkspace();
  const [connection] = await db()<[{ id: string }]>`
    insert into source_connections (
      workspace_id, provider, connection_key, status
    ) values (
      ${fixture.workspaceId}, ${provider}, ${randomUUID()}, ${status}
    )
    returning id
  `;
  return { ...fixture, connectionId: connection.id };
}

async function expectPostgresError(
  promise: Promise<unknown>,
  expected: { code?: string; message?: string },
): Promise<void> {
  try {
    await promise;
    throw new Error("expected Postgres statement to fail");
  } catch (error) {
    const pgError = error as Error & { code?: string };
    if (pgError.message === "expected Postgres statement to fail") throw pgError;
    if (expected.code) expect(pgError.code).toBe(expected.code);
    if (expected.message) expect(pgError.message).toContain(expected.message);
  }
}

async function upsertSourceItem(
  workspaceId: string,
  connectionId: string,
  externalId = randomUUID(),
  externalVersion = "v1",
  hash = "a".repeat(64),
): Promise<{ item_id: string; changed: boolean; superseded_item_ids: string[] }> {
  const [row] = await db()<
    [{ result: { item_id: string; changed: boolean; superseded_item_ids: string[] } }]
  >`
    select upsert_source_item(
      ${workspaceId}, ${connectionId}, 'message', ${externalId}, ${externalVersion}, now(),
      'contract test', ${hash}, '{}'::jsonb, null, 'ready'
    ) as result
  `;
  return row.result;
}

async function upsertSlackMessage(
  workspaceId: string,
  connectionId: string,
  messageTs = "1724176800.000001",
): Promise<unknown> {
  return db()`
    select upsert_slack_message_if_connection_active(
      ${workspaceId}, ${connectionId}, 'C123', 'contracts', ${messageTs},
      ${messageTs}, null, null, 'U123', 'Contract User', 'hello', null,
      false, null, null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
      '{}'::jsonb, now()
    ) as result
  `;
}

async function waitForBackendLock(
  backendPid: number,
  isSettled: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (isSettled()) {
      throw new Error(`backend ${backendPid} completed before reaching the expected lock wait`);
    }
    const [activity] = await db()<[{ wait_event_type: string | null; wait_event: string | null }]>`
      select wait_event_type, wait_event
      from pg_stat_activity
      where pid = ${backendPid}
    `;
    if (activity?.wait_event_type === "Lock") return;
    await Bun.sleep(10);
  }
  throw new Error(`backend ${backendPid} never entered a PostgreSQL lock wait`);
}

describeWithDatabase("hosted integration lifecycle migration", () => {
  afterEach(async () => {
    if (!sql || organizationIds.size === 0) return;
    const ids = [...organizationIds];
    organizationIds.clear();
    await sql`delete from organizations where id = any(${sql.array(ids, "uuid")})`;
  });

  afterAll(async () => {
    await sql?.close();
  });

  test("new lifecycle functions are executable only by service_role", async () => {
    const rows = await db()<
      Array<{
        name: string;
        security_definer: boolean;
        public_execute: boolean;
        anon_execute: boolean;
        authenticated_execute: boolean;
        service_execute: boolean;
      }>
    >`
      select
        p.proname as name,
        p.prosecdef as security_definer,
        exists (
          select 1
          from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          where acl.grantee = 0
            and acl.privilege_type = 'EXECUTE'
        ) as public_execute,
        has_function_privilege('anon', p.oid, 'execute') as anon_execute,
        has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
        has_function_privilege('service_role', p.oid, 'execute') as service_execute
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in (
          'upsert_source_item',
          'upsert_slack_message_if_connection_active',
          'disconnect_source_connection',
          'commit_linear_connection_swap'
        )
      order by p.proname
    `;

    expect(rows.map((row) => row.name)).toEqual([
      "commit_linear_connection_swap",
      "disconnect_source_connection",
      "upsert_slack_message_if_connection_active",
      "upsert_source_item",
    ]);
    for (const row of rows) {
      expect(row.security_definer).toBe(true);
      expect(row.public_execute).toBe(false);
      expect(row.anon_execute).toBe(false);
      expect(row.authenticated_execute).toBe(false);
      expect(row.service_execute).toBe(true);
    }
  });

  test("allows only one non-revoked GitHub connection per workspace", async () => {
    const fixture = await createWorkspace();
    await db()`
      insert into source_connections (workspace_id, provider, connection_key, status)
      values (${fixture.workspaceId}, 'github', ${randomUUID()}, 'active')
    `;

    await expectPostgresError(
      db()`
        insert into source_connections (workspace_id, provider, connection_key, status)
        values (${fixture.workspaceId}, 'github', ${randomUUID()}, 'pending')
      `,
      { code: "23505" },
    );

    await db()`
      insert into source_connections (workspace_id, provider, connection_key, status)
      values (${fixture.workspaceId}, 'github', ${randomUUID()}, 'revoked')
    `;
  });

  test("source-item writes accept active/degraded and reject inactive connections", async () => {
    for (const status of ["active", "degraded"] as const) {
      const connection = await createConnection("fireflies", status);
      const result = await upsertSourceItem(connection.workspaceId, connection.connectionId);
      expect(result.item_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(result.changed).toBe(true);
      expect(result.superseded_item_ids).toEqual([]);
    }

    for (const status of ["pending", "error", "revoked"] as const) {
      const connection = await createConnection("fireflies", status);
      await expectPostgresError(
        upsertSourceItem(connection.workspaceId, connection.connectionId),
        { code: "P0001", message: "connection_inactive" },
      );
    }
  });

  test("source-item upsert reports same-revision changes and supersedes prior ready rows in order", async () => {
    const connection = await createConnection("fireflies", "active");
    const externalId = randomUUID();
    const firstHash = "1".repeat(64);
    const changedHash = "2".repeat(64);

    const first = await upsertSourceItem(
      connection.workspaceId,
      connection.connectionId,
      externalId,
      "same-revision",
      firstHash,
    );
    expect(first.changed).toBe(true);

    const unchanged = await upsertSourceItem(
      connection.workspaceId,
      connection.connectionId,
      externalId,
      "same-revision",
      firstHash,
    );
    expect(unchanged.item_id).toBe(first.item_id);
    expect(unchanged.changed).toBe(false);

    const changed = await upsertSourceItem(
      connection.workspaceId,
      connection.connectionId,
      externalId,
      "same-revision",
      changedHash,
    );
    expect(changed.item_id).toBe(first.item_id);
    expect(changed.changed).toBe(true);

    const priorHash = "3".repeat(64);
    const priorRows = await db()<Array<{ id: string; external_version: string }>>`
      insert into source_items (
        workspace_id, source_connection_id, item_type, external_id,
        external_version, lifecycle_status, occurred_at, normalized_at,
        content_markdown, content_hash
      ) values
        (
          ${connection.workspaceId}, ${connection.connectionId}, 'message',
          ${externalId}, 'older', 'ready', now(), '2026-01-01T00:00:00Z',
          'older', ${priorHash}
        ),
        (
          ${connection.workspaceId}, ${connection.connectionId}, 'message',
          ${externalId}, 'newer', 'ready', now(), '2026-01-02T00:00:00Z',
          'newer', ${priorHash}
        )
      returning id, external_version
    `;
    const older = priorRows.find((row) => row.external_version === "older")!;
    const newer = priorRows.find((row) => row.external_version === "newer")!;

    const replacement = await upsertSourceItem(
      connection.workspaceId,
      connection.connectionId,
      externalId,
      "replacement",
      "4".repeat(64),
    );
    // The same-revision row was most recently normalized by the calls above,
    // followed by the explicitly ordered newer and older fixtures.
    expect(replacement.superseded_item_ids).toEqual([first.item_id, newer.id, older.id]);

    const rows = await db()<Array<{ id: string; lifecycle_status: string; supersedes_source_item_id: string | null }>>`
      select id, lifecycle_status, supersedes_source_item_id
      from source_items
      where source_connection_id = ${connection.connectionId}
        and external_id = ${externalId}
    `;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(first.item_id)?.lifecycle_status).toBe("superseded");
    expect(byId.get(newer.id)?.lifecycle_status).toBe("superseded");
    expect(byId.get(older.id)?.lifecycle_status).toBe("superseded");
    expect(byId.get(replacement.item_id)?.lifecycle_status).toBe("ready");
    expect(byId.get(replacement.item_id)?.supersedes_source_item_id).toBe(first.item_id);
  });

  test("Slack capture is active-gated and preserves materialization links on replay", async () => {
    const connection = await createConnection("slack", "active");
    const messageTs = "1724176800.000002";
    await upsertSlackMessage(connection.workspaceId, connection.connectionId, messageTs);

    const [sourceItem] = await db()<[{ id: string }]>`
      insert into source_items (
        workspace_id, source_connection_id, item_type, external_id,
        external_version, lifecycle_status, occurred_at, normalized_at,
        content_markdown, content_hash
      ) values (
        ${connection.workspaceId}, ${connection.connectionId}, 'message',
        ${randomUUID()}, 'v1', 'ready', now(), now(), 'batch', ${"b".repeat(64)}
      )
      returning id
    `;
    await db()`
      update slack_messages
      set source_item_id = ${sourceItem.id}
      where source_connection_id = ${connection.connectionId}
        and message_ts = ${messageTs}
    `;

    await upsertSlackMessage(connection.workspaceId, connection.connectionId, messageTs);
    const [replayed] = await db()<[{ source_item_id: string | null }]>`
      select source_item_id
      from slack_messages
      where source_connection_id = ${connection.connectionId}
        and message_ts = ${messageTs}
    `;
    expect(replayed.source_item_id).toBe(sourceItem.id);

    await db()`
      update source_connections set status = 'revoked'
      where id = ${connection.connectionId}
    `;
    await expectPostgresError(
      upsertSlackMessage(connection.workspaceId, connection.connectionId, "1724176800.000003"),
      { code: "P0001", message: "connection_inactive" },
    );
  });

  test("disconnect revokes the connection and disables schedules idempotently", async () => {
    const connection = await createConnection("fireflies", "active");
    await db()`
      insert into scheduled_tasks (
        workspace_id, source_connection_id, task_type, task_key,
        schedule_kind, interval_seconds, timezone, enabled
      ) values (
        ${connection.workspaceId}, ${connection.connectionId}, 'ingest_source',
        ${randomUUID()}, 'interval', 300, 'UTC', true
      )
    `;

    const [first] = await db()<[{ connection_id: string; transitioned: boolean }]>`
      select * from disconnect_source_connection(${connection.workspaceId}, 'fireflies')
    `;
    expect(first).toEqual({ connection_id: connection.connectionId, transitioned: true });

    const [state] = await db()<[{ status: string; enabled: boolean }]>`
      select sc.status, st.enabled
      from source_connections sc
      join scheduled_tasks st on st.source_connection_id = sc.id
      where sc.id = ${connection.connectionId}
    `;
    expect(state).toEqual({ status: "revoked", enabled: false });

    const [second] = await db()<[{ connection_id: string | null; transitioned: boolean }]>`
      select * from disconnect_source_connection(${connection.workspaceId}, 'fireflies')
    `;
    expect(second).toEqual({ connection_id: null, transitioned: false });
  });

  test("source-item ingest commits before a waiting disconnect", async () => {
    const connection = await createConnection("fireflies", "active");
    const blocker = await db().reserve();
    const waiter = await db().reserve();
    const [waiterBackend] = await waiter<[{ pid: number }]>`select pg_backend_pid() as pid`;
    let blockerOpen = false;
    let settled = false;
    let pending: Promise<unknown> | undefined;

    try {
      await blocker`begin`;
      blockerOpen = true;
      await blocker`
        select upsert_source_item(
          ${connection.workspaceId}, ${connection.connectionId}, 'message',
          'ingest-first', 'v1', now(), 'ingest-first', ${"5".repeat(64)},
          '{}'::jsonb, null, 'ready'
        )
      `;

      pending = waiter`
        select * from disconnect_source_connection(${connection.workspaceId}, 'fireflies')
      `.then((rows) => {
        settled = true;
        return rows;
      }, (error) => {
        settled = true;
        throw error;
      });

      await waitForBackendLock(waiterBackend.pid, () => settled);
      await blocker`commit`;
      blockerOpen = false;

      const [result] = await pending as Array<{
        connection_id: string;
        transitioned: boolean;
      }>;
      expect(result).toEqual({ connection_id: connection.connectionId, transitioned: true });

      const [state] = await db()<[{ item_count: number; status: string }]>`
        select
          count(si.id)::int as item_count,
          min(sc.status) as status
        from source_connections sc
        left join source_items si on si.source_connection_id = sc.id
          and si.external_id = 'ingest-first'
        where sc.id = ${connection.connectionId}
      `;
      expect(state).toEqual({ item_count: 1, status: "revoked" });
    } finally {
      if (blockerOpen) await blocker`rollback`.catch(() => undefined);
      await pending?.catch(() => undefined);
      blocker.release();
      waiter.release();
    }
  });

  test("source-item ingest rejects after a disconnect holding the lock commits", async () => {
    const connection = await createConnection("fireflies", "active");
    const blocker = await db().reserve();
    const waiter = await db().reserve();
    const [waiterBackend] = await waiter<[{ pid: number }]>`select pg_backend_pid() as pid`;
    let blockerOpen = false;
    let settled = false;
    let pending: Promise<unknown> | undefined;

    try {
      await blocker`begin`;
      blockerOpen = true;
      await blocker`
        select * from disconnect_source_connection(${connection.workspaceId}, 'fireflies')
      `;

      pending = waiter`
        select upsert_source_item(
          ${connection.workspaceId}, ${connection.connectionId}, 'message',
          'disconnect-first', 'v1', now(), 'disconnect-first', ${"6".repeat(64)},
          '{}'::jsonb, null, 'ready'
        )
      `.then((rows) => {
        settled = true;
        return rows;
      }, (error) => {
        settled = true;
        throw error;
      });

      await waitForBackendLock(waiterBackend.pid, () => settled);
      await blocker`commit`;
      blockerOpen = false;

      await expectPostgresError(pending, { code: "P0001", message: "connection_inactive" });
      const [count] = await db()<[{ count: number }]>`
        select count(*)::int as count
        from source_items
        where source_connection_id = ${connection.connectionId}
          and external_id = 'disconnect-first'
      `;
      expect(count.count).toBe(0);
    } finally {
      if (blockerOpen) await blocker`rollback`.catch(() => undefined);
      await pending?.catch(() => undefined);
      blocker.release();
      waiter.release();
    }
  });

  test("Slack capture commits before a waiting disconnect", async () => {
    const connection = await createConnection("slack", "active");
    const blocker = await db().reserve();
    const waiter = await db().reserve();
    const [waiterBackend] = await waiter<[{ pid: number }]>`select pg_backend_pid() as pid`;
    let blockerOpen = false;
    let settled = false;
    let pending: Promise<unknown> | undefined;

    try {
      await blocker`begin`;
      blockerOpen = true;
      await blocker`
        select upsert_slack_message_if_connection_active(
          ${connection.workspaceId}, ${connection.connectionId}, 'C123', 'contracts',
          '1724176800.000010', '1724176800.000010', null, null, 'U123',
          'Contract User', 'capture-first', null, false, null, null,
          '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, now()
        )
      `;

      pending = waiter`
        select * from disconnect_source_connection(${connection.workspaceId}, 'slack')
      `.then((rows) => {
        settled = true;
        return rows;
      }, (error) => {
        settled = true;
        throw error;
      });

      await waitForBackendLock(waiterBackend.pid, () => settled);
      await blocker`commit`;
      blockerOpen = false;
      await pending;

      const [state] = await db()<[{ message_count: number; status: string }]>`
        select
          count(sm.id)::int as message_count,
          min(sc.status) as status
        from source_connections sc
        left join slack_messages sm on sm.source_connection_id = sc.id
          and sm.message_ts = '1724176800.000010'
        where sc.id = ${connection.connectionId}
      `;
      expect(state).toEqual({ message_count: 1, status: "revoked" });
    } finally {
      if (blockerOpen) await blocker`rollback`.catch(() => undefined);
      await pending?.catch(() => undefined);
      blocker.release();
      waiter.release();
    }
  });

  test("Slack capture rejects after a disconnect holding the lock commits", async () => {
    const connection = await createConnection("slack", "active");
    const blocker = await db().reserve();
    const waiter = await db().reserve();
    const [waiterBackend] = await waiter<[{ pid: number }]>`select pg_backend_pid() as pid`;
    let blockerOpen = false;
    let settled = false;
    let pending: Promise<unknown> | undefined;

    try {
      await blocker`begin`;
      blockerOpen = true;
      await blocker`
        select * from disconnect_source_connection(${connection.workspaceId}, 'slack')
      `;

      pending = waiter`
        select upsert_slack_message_if_connection_active(
          ${connection.workspaceId}, ${connection.connectionId}, 'C123', 'contracts',
          '1724176800.000011', '1724176800.000011', null, null, 'U123',
          'Contract User', 'disconnect-first', null, false, null, null,
          '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, now()
        )
      `.then((rows) => {
        settled = true;
        return rows;
      }, (error) => {
        settled = true;
        throw error;
      });

      await waitForBackendLock(waiterBackend.pid, () => settled);
      await blocker`commit`;
      blockerOpen = false;

      await expectPostgresError(pending, { code: "P0001", message: "connection_inactive" });
      const [count] = await db()<[{ count: number }]>`
        select count(*)::int as count
        from slack_messages
        where source_connection_id = ${connection.connectionId}
          and message_ts = '1724176800.000011'
      `;
      expect(count.count).toBe(0);
    } finally {
      if (blockerOpen) await blocker`rollback`.catch(() => undefined);
      await pending?.catch(() => undefined);
      blocker.release();
      waiter.release();
    }
  });

  test("Linear swap commits credential/webhook state and rejects stale versions", async () => {
    const fixture = await createWorkspace();
    const [initial] = await db()<[{ result: Record<string, unknown> }]>`
      select commit_linear_connection_swap(
        ${fixture.workspaceId}, null, 'linear-key-1', '\\x0102'::bytea,
        'v1', 'webhook-1', null
      ) as result
    `;
    expect(initial.result.prior_webhook_id).toBeNull();

    const [observed] = await db()<
      [{ id: string; credential_id: string; updated_at: string; config_json: { linear_webhook_id: string } }]
    >`
      select id, credential_id, updated_at::text as updated_at, config_json
      from source_connections
      where workspace_id = ${fixture.workspaceId} and provider = 'linear'
    `;
    expect(observed.config_json.linear_webhook_id).toBe("webhook-1");

    const [replacement] = await db()<[{ result: Record<string, unknown> }]>`
      select commit_linear_connection_swap(
        ${fixture.workspaceId}, ${observed.updated_at}, 'linear-key-2',
        '\\x0304'::bytea, 'v2', 'webhook-2', null
      ) as result
    `;
    expect(replacement.result.prior_webhook_id).toBe("webhook-1");
    expect(replacement.result.connection_id).toBe(observed.id);
    expect(replacement.result.credential_id).toBe(observed.credential_id);

    await expectPostgresError(
      db()`
        select commit_linear_connection_swap(
          ${fixture.workspaceId}, ${observed.updated_at}, 'linear-key-stale',
          '\\x0506'::bytea, 'v3', 'webhook-stale', null
        )
      `,
      { code: "P0001", message: "linear_connection_conflict" },
    );

    const [committed] = await db()<
      [{ connection_key: string; status: string; last_error_at: Date | null; webhook_id: string; payload: string }]
    >`
      select
        sc.connection_key,
        sc.status,
        sc.last_error_at,
        sc.config_json ->> 'linear_webhook_id' as webhook_id,
        encode(c.encrypted_payload, 'hex') as payload
      from source_connections sc
      join credentials c on c.id = sc.credential_id
      where sc.id = ${observed.id}
    `;
    expect(committed).toEqual({
      connection_key: "linear-key-2",
      status: "active",
      last_error_at: null,
      webhook_id: "webhook-2",
      payload: "0304",
    });
  });

  test("Linear swap rolls back credential mutation when the connection update fails", async () => {
    const fixture = await createWorkspace();
    await db()`
      select commit_linear_connection_swap(
        ${fixture.workspaceId}, null, 'linear-original', '\\x0a0b'::bytea,
        'v1', 'webhook-original', null
      )
    `;
    const [observed] = await db()<
      [{ id: string; credential_id: string; updated_at: string }]
    >`
      select id, credential_id, updated_at::text as updated_at
      from source_connections
      where workspace_id = ${fixture.workspaceId} and provider = 'linear'
    `;

    // This intentionally malformed second singleton is test-only. Its key
    // collides during the final source_connections update, after the RPC has
    // already mutated the first row's credential inside the same transaction.
    await db()`
      insert into source_connections (
        workspace_id, provider, connection_key, status, created_at
      ) values (
        ${fixture.workspaceId}, 'linear', 'linear-collision', 'revoked',
        now() + interval '1 minute'
      )
    `;

    await expectPostgresError(
      db()`
        select commit_linear_connection_swap(
          ${fixture.workspaceId}, ${observed.updated_at}, 'linear-collision',
          '\\x0c0d'::bytea, 'v2', 'webhook-should-rollback', null
        )
      `,
      { code: "23505" },
    );

    const [unchanged] = await db()<
      [{ connection_key: string; webhook_id: string; payload: string; key_version: string }]
    >`
      select
        sc.connection_key,
        sc.config_json ->> 'linear_webhook_id' as webhook_id,
        encode(c.encrypted_payload, 'hex') as payload,
        c.encryption_key_version as key_version
      from source_connections sc
      join credentials c on c.id = sc.credential_id
      where sc.id = ${observed.id}
    `;
    expect(unchanged).toEqual({
      connection_key: "linear-original",
      webhook_id: "webhook-original",
      payload: "0a0b",
      key_version: "v1",
    });
  });
});

// Proves the naming refactor rolls back. Applies every earlier migration, seeds rows under the old
// names, then runs the up file, the rollback file and the up file again.
// Needs a disposable Supabase-shaped Postgres (auth, storage, realtime) where no app migration has run.
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setupDbIntegrationTest } from "./support";

const { describeWithDatabase, db } = setupDbIntegrationTest("naming refactor rollback", "nrr");

const UP_FILE = "20261118200405_naming_refactor.sql";
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../supabase/migrations/", import.meta.url));
const ROLLBACK_FILE = fileURLToPath(new URL("../../../../db/rollback/naming_refactor_down.sql", import.meta.url));

const OLD_FUNCTION_NAMES = [
  "search_source_items", "search_sources", "upsert_source_item", "claim_pending_summary_sessions",
  "replace_agent_session_messages", "append_session_events", "heartbeat_session", "host_transition_session_input",
  "commit_slack_source_batch", "get_pending_slack_channel_ids", "upsert_slack_message_if_connection_active",
  "disconnect_source_connection", "commit_linear_connection_swap", "mark_fireflies_webhook_success",
  "mark_granola_webhook_success", "rotate_fireflies_connection_credential", "rotate_granola_connection_credential",
];

describeWithDatabase("naming refactor rollback", () => {
  test("up, rollback and up again keep the rows and swap the names", async () => {
    const sql = db();
    const [guard] = await sql<[{ taken: boolean }]>`
      select to_regclass('public.agent_sessions') is not null
        or to_regclass('public.captured_sessions') is not null as taken
    `;
    if (guard.taken) throw new Error("naming refactor rollback test needs a database where no app migration has run");

    const earlier = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && f < UP_FILE).sort();
    for (const file of earlier) await sql.unsafe(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));

    const suffix = randomUUID();
    const [org] = await sql<[{ id: string }]>`
      insert into organizations (slug, name) values (${`nrr-org-${suffix}`}, 'Rollback test') returning id`;
    const [team] = await sql<[{ id: string }]>`
      insert into teams (organization_id, slug, name) values (${org.id}, ${`nrr-team-${suffix}`}, 'Rollback test') returning id`;
    const [workspace] = await sql<[{ id: string }]>`
      insert into workspaces (organization_id, team_id, slug, name)
      values (${org.id}, ${team.id}, ${`nrr-workspace-${suffix}`}, 'Rollback test') returning id`;
    const userId = randomUUID();
    await sql`insert into auth.users (id, email) values (${userId}, ${`${userId}@example.test`})`;
    const [version] = await sql<[{ id: string }]>`
      insert into workspace_context_versions (workspace_id, version_number, documents_json, content_hash, creation_reason, summary)
      values (${workspace.id}, 1, '{}', ${"a".repeat(64)}, 'seed', 'seed') returning id`;
    const [run] = await sql<[{ id: string; updated_at: Date }]>`
      insert into agent_runs (workspace_id, kind, trigger, runtime, harness, base_context_version_id, idempotency_key)
      values (${workspace.id}, 'interactive', '{"type":"manual"}',
        '{"type":"cloud","environment":{"nativeTools":[1]}}', 'claude', ${version.id}, ${`run-${suffix}`})
      returning id, updated_at`;
    const [session] = await sql<[{ id: string }]>`
      insert into agent_sessions (workspace_id, user_id, provider, external_session_id, started_at, ended_at, status)
      values (${workspace.id}, ${userId}, 'claude_session', ${`ext-${suffix}`},
        ${"2026-11-01T00:00:00Z"}, ${"2026-11-01T01:00:00Z"}, 'ended')
      returning id`;
    await sql`
      insert into agent_messages (session_id, workspace_id, seq, role, content)
      values (${session.id}, ${workspace.id}, 0, 'user', 'hello')`;
    const [connection] = await sql<[{ id: string }]>`
      insert into source_connections (workspace_id, provider, connection_key)
      values (${workspace.id}, 'slack', ${`C-${suffix}`}) returning id`;
    const [host] = await sql<[{ id: string }]>`
      insert into sessions (workspace_id, owner_user_id, host_machine_id)
      values (${workspace.id}, ${userId}, 'host-1') returning id`;

    const tableExists = async (name: string) => {
      const [row] = await sql<[{ present: boolean }]>`select to_regclass(${`public.${name}`}) is not null as present`;
      return row.present;
    };
    const functionNames = async () =>
      new Set((await sql<{ proname: string }[]>`
        select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'`).map((r) => r.proname));

    await sql.unsafe(readFileSync(join(MIGRATIONS_DIR, UP_FILE), "utf8"));
    expect(await tableExists("captured_sessions")).toBe(true);
    expect(await tableExists("agent_sessions")).toBe(false);

    await sql.unsafe(readFileSync(ROLLBACK_FILE, "utf8"));
    for (const name of ["agent_sessions", "agent_messages", "source_connections"]) {
      expect(await tableExists(name)).toBe(true);
    }
    for (const name of ["captured_sessions", "captured_session_messages", "connections"]) {
      expect(await tableExists(name)).toBe(false);
    }
    expect(await sql`select 1 from agent_sessions where id = ${session.id}`).toHaveLength(1);
    expect(await sql`select 1 from agent_messages where session_id = ${session.id}`).toHaveLength(1);
    expect(await sql`select 1 from source_connections where id = ${connection.id}`).toHaveLength(1);
    const [hostAfterDown] = await sql<[{ host_machine_id: string }]>`
      select host_machine_id from sessions where id = ${host.id}`;
    expect(hostAfterDown.host_machine_id).toBe("host-1");
    const [runAfterDown] = await sql<[{ runtime: unknown; updated_at: Date }]>`
      select runtime, updated_at from agent_runs where id = ${run.id}`;
    expect(runAfterDown.runtime).toEqual({ type: "cloud", environment: { nativeTools: [1] } });
    expect(runAfterDown.updated_at.getTime()).toBe(run.updated_at.getTime());
    const namesAfterDown = await functionNames();
    for (const name of OLD_FUNCTION_NAMES) expect(namesAfterDown.has(name)).toBe(true);
    expect(namesAfterDown.has("replace_captured_session_messages")).toBe(false);
    expect(namesAfterDown.has("disconnect_connection")).toBe(false);

    await sql.unsafe(readFileSync(join(MIGRATIONS_DIR, UP_FILE), "utf8"));
    expect(await tableExists("captured_sessions")).toBe(true);
    expect(await tableExists("agent_sessions")).toBe(false);
    expect(await sql`select 1 from captured_sessions where id = ${session.id}`).toHaveLength(1);
    expect(await sql`select 1 from captured_session_messages where captured_session_id = ${session.id}`).toHaveLength(1);
    expect(await sql`select 1 from connections where id = ${connection.id}`).toHaveLength(1);
    const [hostAfterUp] = await sql<[{ host_id: string }]>`select host_id from sessions where id = ${host.id}`;
    expect(hostAfterUp.host_id).toBe("host-1");
    const [runAfterUp] = await sql<[{ runtime: unknown }]>`select runtime from agent_runs where id = ${run.id}`;
    expect(runAfterUp.runtime).toEqual({ type: "cloud", toolset: { nativeTools: [1] } });
    const namesAfterUp = await functionNames();
    expect(namesAfterUp.has("replace_captured_session_messages")).toBe(true);
    expect(namesAfterUp.has("disconnect_connection")).toBe(true);
    expect(namesAfterUp.has("replace_agent_session_messages")).toBe(false);
    expect(namesAfterUp.has("disconnect_source_connection")).toBe(false);
  }, 120_000);
});

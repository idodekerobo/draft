import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { setupDbIntegrationTest } from "./support";

// The DB-level rules of people and person_identities: workspace scope by foreign key, one owner per
// identity, and the actor/delegator check. Everything else about people is tested in the backend.
const { describeWithDatabase, db, createWorkspace } = setupDbIntegrationTest("people schema", "people");

async function rejects(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return String((error as { message?: string }).message ?? error);
  }
  throw new Error("expected the statement to be rejected");
}

async function addPerson(workspaceId: string, columns: { createdBy: "user" | "agent" | "connection"; createdByUserId?: string | null; onBehalfOf?: string | null }): Promise<string> {
  const [row] = await db()<[{ id: string }]>`
    insert into people (workspace_id, display_name, created_by, created_by_user_id, on_behalf_of_user_id)
    values (${workspaceId}, 'Cory', ${columns.createdBy}, ${columns.createdByUserId ?? null}, ${columns.onBehalfOf ?? null})
    returning id
  `;
  return row.id;
}

describeWithDatabase("people schema", () => {
  test("an identity cannot point at a person in another workspace", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    const personId = await addPerson(a.workspaceId, { createdBy: "connection" });
    const message = await rejects(
      () => db()`insert into person_identities (workspace_id, person_id, provider, external_id, status) values (${b.workspaceId}, ${personId}, 'slack', 'U1', 'confirmed')`,
    );
    expect(message).toContain("person_identities_person_id_workspace_id_fkey");
  });

  test("an identity cannot name a connection from another workspace", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    const personId = await addPerson(a.workspaceId, { createdBy: "connection" });
    const [connection] = await db()<[{ id: string }]>`
      insert into source_connections (workspace_id, provider, connection_key, status) values (${b.workspaceId}, 'slack', ${randomUUID()}, 'active') returning id
    `;
    const message = await rejects(
      () => db()`insert into person_identities (workspace_id, person_id, provider, external_id, status, source_connection_id) values (${a.workspaceId}, ${personId}, 'slack', 'U1', 'from_connection', ${connection.id})`,
    );
    expect(message).toContain("source_connection_id_workspace_id_fkey");
  });

  test("one Slack user is exactly one person in a workspace, but may exist in another", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    const first = await addPerson(a.workspaceId, { createdBy: "connection" });
    const second = await addPerson(a.workspaceId, { createdBy: "connection" });
    const other = await addPerson(b.workspaceId, { createdBy: "connection" });
    await db()`insert into person_identities (workspace_id, person_id, provider, external_id, status) values (${a.workspaceId}, ${first}, 'slack', 'U1', 'confirmed')`;
    const message = await rejects(
      () => db()`insert into person_identities (workspace_id, person_id, provider, external_id, status) values (${a.workspaceId}, ${second}, 'slack', 'U1', 'inferred')`,
    );
    expect(message).toContain("person_identities_workspace_id_provider_external_id_key");
    await db()`insert into person_identities (workspace_id, person_id, provider, external_id, status) values (${b.workspaceId}, ${other}, 'slack', 'U1', 'confirmed')`;
  });

  test("deleting a person deletes their identities", async () => {
    const a = await createWorkspace();
    const personId = await addPerson(a.workspaceId, { createdBy: "connection" });
    await db()`insert into person_identities (workspace_id, person_id, provider, external_id, status) values (${a.workspaceId}, ${personId}, 'email', 'c@example.com', 'confirmed')`;
    await db()`delete from people where id = ${personId}`;
    const rows = await db()`select 1 from person_identities where person_id = ${personId}`;
    expect(rows).toHaveLength(0);
  });

  describe("actor and delegator columns", () => {
    async function anyUserId(): Promise<string | null> {
      const [row] = await db()<Array<{ id: string }>>`select id from users limit 1`;
      return row?.id ?? null;
    }

    test("a person row keeps the actor and the delegator apart", async () => {
      const userId = await anyUserId();
      if (!userId) return;
      const { workspaceId } = await createWorkspace();
      await addPerson(workspaceId, { createdBy: "user", createdByUserId: userId });
      await addPerson(workspaceId, { createdBy: "agent", onBehalfOf: userId });
      await addPerson(workspaceId, { createdBy: "agent" });
      await addPerson(workspaceId, { createdBy: "connection" });

      expect(await rejects(() => addPerson(workspaceId, { createdBy: "agent", createdByUserId: userId }))).toContain("people_check");
      expect(await rejects(() => addPerson(workspaceId, { createdBy: "user", createdByUserId: userId, onBehalfOf: userId }))).toContain("people_check");
      expect(await rejects(() => addPerson(workspaceId, { createdBy: "connection", onBehalfOf: userId }))).toContain("people_check");
    });
  });

  test("agent_runs stores the user a run acts for", async () => {
    const [column] = await db()<Array<{ data_type: string; is_nullable: string }>>`
      select data_type, is_nullable from information_schema.columns where table_name = 'agent_runs' and column_name = 'on_behalf_of_user_id'
    `;
    expect(column).toEqual({ data_type: "uuid", is_nullable: "YES" });
  });
});

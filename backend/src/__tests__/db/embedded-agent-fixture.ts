import { randomUUID } from "node:crypto";
import { afterAll } from "bun:test";
import { Pool } from "pg";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EmbeddedAgentContext } from "../../embedded-agent/adapter";
import { PgStorage } from "../../embedded-agent/pi/pg-storage";
import { setupDbIntegrationTest } from "./support";

// Shared by the embedded agent database tests: a pool on the disposable database, and a backend-target Home session
// with a claim on it. Gated by DRAFT_INTEGRATION_TEST_DATABASE_URL like the other database tests.
const base = setupDbIntegrationTest("embedded agent", "eas");
const url = process.env.DRAFT_INTEGRATION_TEST_DATABASE_URL;
const sharedPool = url ? new Pool({ connectionString: url, max: 6 }) : null;
afterAll(async () => {
  await sharedPool?.end();
});

export const embeddedAgentDb = { describeWithDatabase: base.describeWithDatabase, db: base.db, createWorkspace: base.createWorkspace, pool: () => sharedPool! };
const { db, createWorkspace } = base;
const pool = () => sharedPool!;

export interface Fixture {
  sessionId: string;
  workspaceId: string;
  userId: string;
  owner: string;
  epoch: number;
}

/** A backend-target session for the storage to belong to, a claim on it, and the storage opened under that claim. */
export async function withFixtureStorage(use: (storage: PgStorage, fixture: Fixture) => Promise<void>): Promise<void> {
  const { workspaceId } = await createWorkspace();
  const userId = randomUUID();
  let sessionId: string | undefined;
  try {
    await db()`insert into auth.users (id, email) values (${userId}, ${`${userId}@example.test`})`;
    const [w] = await db()<[{ organization_id: string; team_id: string }]>`select organization_id, team_id from workspaces where id = ${workspaceId}`;
    await db()`update users set organization_id = ${w.organization_id}, primary_team_id = ${w.team_id}, status = 'active' where id = ${userId}`;
    const [session] = await db()<[{ id: string }]>`
      insert into sessions (workspace_id, owner_user_id, host_id, is_home, execution_target, adapter_id)
      values (${workspaceId}, ${userId}, ${`backend:${randomUUID()}`}, true, 'backend', 'pi-durable-sdk') returning id
    `;
    sessionId = session.id;
    const owner = `test-${randomUUID()}`;
    const [{ claim }] = await db()<[{ claim: { claimed: boolean; epoch: number } }]>`select claim_embedded_agent(${sessionId}, ${owner}, '10 minutes'::interval) as claim`;
    if (!claim.claimed) throw new Error("fixture claim failed");
    const storage = await PgStorage.open({ pool: pool(), sessionId, owner, epoch: Number(claim.epoch) });
    try {
      await use(storage, { sessionId, workspaceId, userId, owner, epoch: Number(claim.epoch) });
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  } finally {
    if (sessionId) await db()`delete from sessions where id = ${sessionId}`;
    await db()`delete from auth.users where id = ${userId}`;
  }
}

/** A backend session with a claim, for one test. Gives the context the host would, and removes everything after. */
export async function homeContext(): Promise<{ context: EmbeddedAgentContext; cleanup: () => Promise<void>; sessionId: string }> {
  const { workspaceId } = await createWorkspace();
  const userId = randomUUID();
  await db()`insert into auth.users (id, email) values (${userId}, ${`${userId}@example.test`})`;
  const [w] = await db()<[{ organization_id: string; team_id: string }]>`select organization_id, team_id from workspaces where id = ${workspaceId}`;
  await db()`update users set organization_id = ${w.organization_id}, primary_team_id = ${w.team_id}, status = 'active' where id = ${userId}`;
  const [session] = await db()<[{ id: string }]>`
    insert into sessions (workspace_id, owner_user_id, host_id, is_home, execution_target, adapter_id)
    values (${workspaceId}, ${userId}, ${`backend:${randomUUID()}`}, true, 'backend', 'pi-durable-sdk') returning id`;
  const owner = `test-${randomUUID()}`;
  const [{ claim }] = await db()<[{ claim: { epoch: number } }]>`select claim_embedded_agent(${session.id}, ${owner}, '10 minutes'::interval) as claim`;
  const context: EmbeddedAgentContext = {
    sessionId: session.id, workspaceId, ownerUserId: userId, owner, epoch: Number(claim.epoch), instructions: "You are Home.",
    assertOwner: () => {}, stillOwner: async () => true, currentRun: async () => { throw new Error("no run in this test"); },
  };
  return { context, sessionId: session.id, cleanup: async () => { await db()`delete from sessions where id = ${session.id}`; await db()`delete from auth.users where id = ${userId}`; } };
}

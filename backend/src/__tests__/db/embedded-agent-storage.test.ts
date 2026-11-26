import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ConversationId, type EntryId, type StorageWrite } from "@earendil-works/pi-durable";
import { commitWrites, registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { OwnershipLostError, PgStorage } from "../../embedded-agent/pi/pg-storage";
import { setupDbIntegrationTest } from "./support";

// pi-durable's own storage conformance suite, run on PgStorage over the three embedded agent tables. Gated by
// DRAFT_INTEGRATION_TEST_DATABASE_URL like the other database tests.
const { describeWithDatabase, db, createWorkspace } = setupDbIntegrationTest("embedded agent storage", "eas");
const url = process.env.DRAFT_INTEGRATION_TEST_DATABASE_URL;
const pool = url ? new Pool({ connectionString: url, max: 6 }) : null;
afterAll(async () => {
  await pool?.end();
});

/** A backend-target session for the storage to belong to, a claim on it, and the storage opened under that claim. */
export async function withFixtureStorage(use: (storage: PgStorage, fixture: { sessionId: string; owner: string; epoch: number }) => Promise<void>): Promise<void> {
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
    const storage = await PgStorage.open({ pool: pool!, sessionId, owner, epoch: Number(claim.epoch) });
    try {
      await use(storage, { sessionId, owner, epoch: Number(claim.epoch) });
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  } finally {
    if (sessionId) await db()`delete from sessions where id = ${sessionId}`;
    await db()`delete from auth.users where id = ${userId}`;
  }
}

describeWithDatabase("PgStorage", () => {
  registerStorageConformance(
    { describe, expect: expect as never, it: (name: string, test: () => Promise<void>) => it(name, test, 60_000) },
    "pi-durable storage conformance",
    (use) => withFixtureStorage((storage) => use(storage)),
  );
});

const ctx = BACKGROUND_CONTEXT;
const rootWrite: StorageWrite = { type: "conversation", value: { id: ROOT_CONVERSATION_ID } };
const entryWrite = (id: number): StorageWrite => ({ type: "entry", value: { id: id as unknown as EntryId, conversationId: ROOT_CONVERSATION_ID as ConversationId, kind: "message" } });
const count = async (sessionId: string, table: string, where = "true") => Number((await pool!.query(`select count(*)::int as n from ${table} where session_id = $1 and ${where}`, [sessionId])).rows[0].n);

describeWithDatabase("PgStorage ownership and recovery", () => {
  const claim = async (sessionId: string, owner: string) => (await pool!.query(`select claim_embedded_agent($1, $2, '10 minutes'::interval) as claim`, [sessionId, owner])).rows[0].claim as { claimed: boolean; epoch: number };

  it("lets one process own an agent at a time, and gives a takeover a higher epoch", () =>
    withFixtureStorage(async (_storage, { sessionId, owner, epoch }) => {
      expect(await claim(sessionId, "other")).toMatchObject({ claimed: false, owner });
      expect((await claim(sessionId, owner)).epoch).toBe(epoch);
      await pool!.query(`select release_embedded_agent($1, $2, $3)`, [sessionId, owner, epoch]);
      expect(await claim(sessionId, "other")).toMatchObject({ claimed: true, epoch: epoch + 1 });
      const renewed = async (o: string, e: number) => (await pool!.query(`select renew_embedded_agent($1, $2, $3, '10 minutes'::interval) as ok`, [sessionId, o, e])).rows[0].ok;
      expect(await renewed(owner, epoch)).toBe(false);
      expect(await renewed("other", epoch + 1)).toBe(true);
    }));

  it("refuses a write from a process that lost its claim, and accepts the new owner's", () =>
    withFixtureStorage(async (stale, { sessionId, owner, epoch }) => {
      await pool!.query(`select release_embedded_agent($1, $2, $3)`, [sessionId, owner, epoch]);
      const next = await claim(sessionId, "next-owner");
      const current = await PgStorage.open({ pool: pool!, sessionId, owner: "next-owner", epoch: Number(next.epoch) });

      await expect(commitWrites(stale, [rootWrite], ctx)).rejects.toBeInstanceOf(OwnershipLostError);
      expect(await count(sessionId, "embedded_agent_records")).toBe(0);
      await commitWrites(current, [rootWrite], ctx);
      expect(await count(sessionId, "embedded_agent_records")).toBe(1);
    }));

  it("refuses a write after the claim expired, even when nobody took it", () =>
    withFixtureStorage(async (storage, { sessionId, owner, epoch }) => {
      await pool!.query(`select release_embedded_agent($1, $2, $3)`, [sessionId, owner, epoch]);
      await expect(commitWrites(storage, [rootWrite], ctx)).rejects.toBeInstanceOf(OwnershipLostError);
    }));

  it("leaves nothing behind when a commit fails part way, and the next commit starts at the same seq", () =>
    withFixtureStorage(async (_storage, { sessionId, owner, epoch }) => {
      const failing = await PgStorage.open({ pool: pool!, sessionId, owner, epoch, outbox: () => { throw new Error("boom"); } });
      await expect(commitWrites(failing, [rootWrite, entryWrite(2)], ctx)).rejects.toThrow("boom");
      expect(await count(sessionId, "embedded_agent_records")).toBe(0);
      expect(await count(sessionId, "embedded_agent_state", "kind = 'outbox'")).toBe(0);
      const healthy = await PgStorage.open({ pool: pool!, sessionId, owner, epoch });
      expect(Number(await commitWrites(healthy, [rootWrite], ctx))).toBe(1);
    }));

  it("writes the outbox with its batch and only for the batches that were stored", () =>
    withFixtureStorage(async (_storage, { sessionId, owner, epoch }) => {
      const storage = await PgStorage.open({
        pool: pool!, sessionId, owner, epoch,
        outbox: (writes, seq) => writes.filter((w) => w.type === "entry").map((w) => ({ sourceId: `entry:${(w as { value: { id: number } }).value.id}`, payload: { seq } })),
      });
      const received: number[] = [];
      const result = await storage.commit([[rootWrite, entryWrite(2)], [entryWrite(2)], [entryWrite(3)]], (_i, seq) => received.push(seq), ctx);
      expect(result.kind).toBe("refused");
      expect(received).toEqual([1]);
      const rows = (await pool!.query(`select key, seq::int as seq, projected_at from embedded_agent_state where session_id = $1 and kind = 'outbox' order by seq`, [sessionId])).rows;
      expect(rows.map((r) => r.key)).toEqual(["entry:2"]);
      expect(rows[0].projected_at).toBeNull();
    }));

  it("keeps ids rising after the agent is reopened", () =>
    withFixtureStorage(async (first, { sessionId, owner, epoch }) => {
      await commitWrites(first, [rootWrite], ctx);
      const minted = [await first.mintId<EntryId>(), await first.mintId<EntryId>(), await first.mintId<EntryId>()];
      await commitWrites(first, minted.map((id) => entryWrite(id)), ctx);
      await first.close(ctx);
      const reopened = await PgStorage.open({ pool: pool!, sessionId, owner, epoch });
      expect(await reopened.mintId<EntryId>()).toBeGreaterThan(Math.max(...minted.map(Number)));
    }));
});

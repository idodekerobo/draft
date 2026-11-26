import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHostStore } from "../../home/runtime/store";
import { embeddedAgentDb, withFixtureStorage } from "./embedded-agent-fixture";

// The host's real queries on staging Postgres: claims, saved inputs, and the recovery search.
const { describeWithDatabase, pool } = embeddedAgentDb;

/** The service client's rpc and table reads, answered straight on the database. */
function shim(): SupabaseClient {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      try {
        const keys = Object.keys(args);
        const { rows } = await pool().query(`select ${name}(${keys.map((_, i) => `$${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
        return { data: rows[0].r, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const ins: Array<[string, unknown[]]> = [];
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (column: string, value: unknown) => (filters.push([column, value]), chain);
      chain.in = (column: string, values: unknown[]) => (ins.push([column, values]), chain);
      chain.is = () => chain;
      chain.order = () => chain;
      const run = async () => {
        const where = [...filters.map(([c], i) => `${c} = $${i + 1}`), ...ins.map(([c], i) => `${c} = any($${filters.length + i + 1})`), table === "session_inputs" ? "dismissed_at is null" : "true"].join(" and ");
        const { rows } = await pool().query(`select * from ${table} where ${where}${table === "session_inputs" ? " order by created_at" : ""}`, [...filters.map(([, v]) => v), ...ins.map(([, v]) => v)]);
        return rows;
      };
      chain.maybeSingle = async () => ({ data: (await run())[0] ?? null, error: null });
      chain.then = (resolve: (v: unknown) => unknown) => run().then((data) => resolve({ data, error: null }));
      return chain;
    },
  } as unknown as SupabaseClient;
}

describeWithDatabase("the Home host's store", () => {
  it("claims a Home for one owner, renews it, and lets another take over after release", () =>
    withFixtureStorage(async (_storage, f) => {
      const store = createHostStore({ pool: pool(), client: shim() });
      expect(await store.claim(f.sessionId, "other", 30)).toMatchObject({ claimed: false });
      expect(await store.stillOwner(f.sessionId, f.owner, f.epoch)).toBe(true);
      expect(await store.renew(f.sessionId, f.owner, f.epoch, 30)).toBe(true);
      await store.release(f.sessionId, f.owner, f.epoch);
      expect(await store.stillOwner(f.sessionId, f.owner, f.epoch)).toBe(false);
      const takeover = await store.claim(f.sessionId, "other", 30);
      expect(takeover).toEqual({ claimed: true, epoch: f.epoch + 1 });
      expect(await store.renew(f.sessionId, f.owner, f.epoch, 30)).toBe(false);
    }));

  it("loads the session, lists waiting inputs oldest first, and moves them through their states", () =>
    withFixtureStorage(async (_storage, f) => {
      const store = createHostStore({ pool: pool(), client: shim() });
      expect(await store.loadSession(f.sessionId)).toMatchObject({ id: f.sessionId, workspaceId: f.workspaceId, ownerUserId: f.userId, ended: false });
      const add = async (kind: string, payload: object) => (await pool().query(`insert into session_inputs (session_id, workspace_id, author_user_id, author_name, kind, payload) values ($1, $2, $3, 'Owner', $4, $5::jsonb) returning id`, [f.sessionId, f.workspaceId, f.userId, kind, JSON.stringify(payload)])).rows[0].id as string;
      const first = await add("message", { text: "one" });
      const second = await add("stop", {});
      const waiting = await store.pendingInputs(f.sessionId);
      expect(waiting.map((i) => [i.id, i.kind, i.state])).toEqual([[first, "message", "queued"], [second, "stop", "queued"]]);

      expect(await store.transition(first, f.sessionId, ["queued"], "delivering", null)).toBe(true);
      expect(await store.transition(first, f.sessionId, ["queued"], "delivering", null)).toBe(false);
      expect(await store.transition(second, f.sessionId, ["queued"], "delivering", null)).toBe(true);
      expect(await store.transition(second, f.sessionId, ["delivering"], "consumed", null)).toBe(true);
      expect((await store.pendingInputs(f.sessionId)).map((i) => i.id)).toEqual([first]);
    }));

  it("finds a Home with waiting work, unprojected events or an open run, and not an idle one", () =>
    withFixtureStorage(async (_storage, f) => {
      const store = createHostStore({ pool: pool(), client: shim() });
      expect(await store.sessionsNeedingRecovery()).not.toContain(f.sessionId);
      await pool().query(`insert into session_inputs (session_id, workspace_id, author_user_id, author_name, kind, payload) values ($1, $2, $3, 'Owner', 'message', '{"text":"hi"}')`, [f.sessionId, f.workspaceId, f.userId]);
      expect(await store.sessionsNeedingRecovery()).toContain(f.sessionId);
      await pool().query(`update session_inputs set state = 'consumed' where session_id = $1`, [f.sessionId]);
      expect(await store.sessionsNeedingRecovery()).not.toContain(f.sessionId);
      await pool().query(`insert into embedded_agent_state (session_id, kind, key, seq, payload) values ($1, 'outbox', 'k1', 1, '{}')`, [f.sessionId]);
      expect(await store.sessionsNeedingRecovery()).toContain(f.sessionId);
    }));

  it("sets the session's model", () =>
    withFixtureStorage(async (_storage, f) => {
      const store = createHostStore({ pool: pool(), client: { from: () => ({ update: () => ({ eq: async () => (await pool().query(`update sessions set model = 'claude-next' where id = $1`, [f.sessionId]), { error: null }) }) }) } as unknown as SupabaseClient });
      await store.setSessionModel(f.sessionId, "claude-next");
      expect((await pool().query(`select model from sessions where id = $1`, [f.sessionId])).rows[0].model).toBe("claude-next");
    }));
});

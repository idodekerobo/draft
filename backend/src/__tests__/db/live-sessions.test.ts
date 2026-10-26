import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { setupDbIntegrationTest } from "./support";

const { describeWithDatabase, db, createWorkspace } = setupDbIntegrationTest("live sessions", "live-sessions");

const userIds: string[] = [];

afterEach(async () => {
  const ids = userIds.splice(0);
  if (ids.length === 0) return;
  await db()`delete from auth.users where id = any(${db().array(ids, "uuid")})`;
});

async function createSession(workspaceId: string, hostMachineId = "host-1"): Promise<string> {
  const userId = randomUUID();
  userIds.push(userId);
  await db()`insert into auth.users (id, email) values (${userId}, ${`${userId}@example.test`})`;
  const [session] = await db()<[{ id: string }]>`
    insert into sessions (workspace_id, owner_user_id, host_machine_id)
    values (${workspaceId}, ${userId}, ${hostMachineId})
    returning id
  `;
  return session.id;
}

function events(...sourceIds: string[]) {
  return sourceIds.map((source_id) => ({ source_id, kind: "user_message", payload: { text: source_id } }));
}

async function append(sessionId: string, workspaceId: string, batch: ReturnType<typeof events>, host = "host-1") {
  const [row] = await db()<[{ result: { last_seq: number; inserted: number } }]>`
    select append_session_events(${sessionId}, ${workspaceId}, ${host}, ${JSON.stringify(batch)}::text::jsonb) as result
  `;
  return row.result;
}

describeWithDatabase("append_session_events", () => {
  test("assigns seq without gaps across batches and marks the session live", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);

    expect(await append(sessionId, workspaceId, events("a", "b"))).toEqual({ last_seq: 2, inserted: 2 });
    expect(await append(sessionId, workspaceId, events("c"))).toEqual({ last_seq: 3, inserted: 1 });

    const rows = await db()<{ seq: string; source_id: string }[]>`
      select seq, source_id from session_events where session_id = ${sessionId} order by seq
    `;
    expect(rows.map((r) => [Number(r.seq), r.source_id])).toEqual([[1, "a"], [2, "b"], [3, "c"]]);

    const [session] = await db()<[{ status: string; last_seq: string; last_event_at: Date | null }]>`
      select status, last_seq, last_event_at from sessions where id = ${sessionId}
    `;
    expect(session.status).toBe("live");
    expect(Number(session.last_seq)).toBe(3);
    expect(session.last_event_at).not.toBeNull();
  });

  test("a duplicate source id is a no-op and does not use a seq", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);

    await append(sessionId, workspaceId, events("a", "b"));
    expect(await append(sessionId, workspaceId, events("b", "c", "a"))).toEqual({ last_seq: 3, inserted: 1 });
    expect(await append(sessionId, workspaceId, events("a", "c"))).toEqual({ last_seq: 3, inserted: 0 });
  });

  test("a duplicate inside one batch inserts once", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);

    expect(await append(sessionId, workspaceId, events("a", "a", "b"))).toEqual({ last_seq: 2, inserted: 2 });
  });

  test("concurrent appends keep seq unique and gap free", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);

    await Promise.all(
      Array.from({ length: 6 }, (_, i) => append(sessionId, workspaceId, events(`m${i}-1`, `m${i}-2`))),
    );

    const rows = await db()<{ seq: string }[]>`select seq from session_events where session_id = ${sessionId} order by seq`;
    expect(rows.map((r) => Number(r.seq))).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  test("rejects writes for an ended session", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);
    await db()`update sessions set status = 'ended', ended_at = now() where id = ${sessionId}`;

    await expect(append(sessionId, workspaceId, events("a"))).rejects.toThrow("session_ended");
  });

  test("rejects writes from a host that does not own the session", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId, "host-1");

    await expect(append(sessionId, workspaceId, events("a"), "host-2")).rejects.toThrow("foreign_host");
    const rows = await db()`select 1 from session_events where session_id = ${sessionId}`;
    expect(rows.length).toBe(0);
  });

  test("rejects a session id paired with another workspace", async () => {
    const { workspaceId } = await createWorkspace();
    const other = await createWorkspace();
    const sessionId = await createSession(workspaceId);

    await expect(append(sessionId, other.workspaceId, events("a"))).rejects.toThrow("session_not_found");
  });
});

describeWithDatabase("errors with a session", () => {
  test("accepts the session operation and links the session", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);

    await db()`
      insert into errors (workspace_id, session_id, operation, message)
      values (${workspaceId}, ${sessionId}, 'session', 'lines_post_failed')
    `;
  });

  test("rejects a session from another workspace", async () => {
    const { workspaceId } = await createWorkspace();
    const other = await createWorkspace();
    const sessionId = await createSession(workspaceId);

    await expect((async () => {
      await db()`
        insert into errors (workspace_id, session_id, operation, message)
        values (${other.workspaceId}, ${sessionId}, 'session', 'x')
      `;
    })()).rejects.toThrow();
  });

  test("a workspace-less error cannot carry a session link", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);

    await expect((async () => {
      await db()`
        insert into errors (workspace_id, session_id, operation, message)
        values (null, ${sessionId}, 'session', 'x')
      `;
    })()).rejects.toThrow();
  });
});

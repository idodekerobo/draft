import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { setupDbIntegrationTest } from "./support";

const { describeWithDatabase, db, createWorkspace } = setupDbIntegrationTest("live sessions", "live-sessions");

const userIds: string[] = [];

async function removeUsers() {
  const ids = userIds.splice(0);
  if (ids.length === 0) return;
  await db()`delete from auth.users where id = any(${db().array(ids, "uuid")})`;
}

async function removeObjects(...names: string[]) {
  await db().begin(async (tx) => {
    await tx`select set_config('storage.allow_delete_query', 'true', true)`;
    await tx`delete from storage.objects where bucket_id = 'session-raw' and name = any(${tx.array(names, "text")})`;
  });
}

afterEach(removeUsers);

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

interface TestEvent {
  source_id: string;
  kind: string;
  payload: Record<string, unknown>;
}

function events(...sourceIds: string[]): TestEvent[] {
  return sourceIds.map((source_id) => ({ source_id, kind: "user_message", payload: { text: source_id } }));
}

async function createMember(workspaceId: string): Promise<string> {
  const userId = randomUUID();
  userIds.push(userId);
  await db()`insert into auth.users (id, email) values (${userId}, ${`${userId}@example.test`})`;
  const [workspace] = await db()<[{ organization_id: string; team_id: string }]>`
    select organization_id, team_id from workspaces where id = ${workspaceId}
  `;
  await db()`
    update users set organization_id = ${workspace.organization_id}, primary_team_id = ${workspace.team_id}, status = 'active'
    where id = ${userId}
  `;
  return userId;
}

async function append(sessionId: string, workspaceId: string, batch: TestEvent[], host = "host-1") {
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

describeWithDatabase("event kinds", () => {
  test("accepts tool, thinking and note events and rejects an unknown kind", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);
    const kinds = ["tool_use", "tool_result", "thinking", "session_note"];

    const batch = kinds.map((kind) => ({ source_id: kind, kind, payload: {} }));
    expect(await append(sessionId, workspaceId, batch)).toEqual({ last_seq: 4, inserted: 4 });

    await expect(
      append(sessionId, workspaceId, [{ source_id: "x", kind: "bogus", payload: {} }]),
    ).rejects.toThrow();
  });
});

describeWithDatabase("session-raw storage", () => {
  async function readableObjects(userId: string): Promise<string[]> {
    return db().begin(async (tx) => {
      await tx`set local role authenticated`;
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
      const rows = await tx<{ name: string }[]>`select name from storage.objects where bucket_id = 'session-raw'`;
      return rows.map((r) => r.name);
    });
  }

  test("members read their own workspace's raw files and nothing from another workspace", async () => {
    const mine = await createWorkspace();
    const theirs = await createWorkspace();
    const member = await createMember(mine.workspaceId);
    const outsider = await createMember(theirs.workspaceId);

    const myPath = `${mine.workspaceId}/${randomUUID()}/root.jsonl.gz`;
    const theirPath = `${theirs.workspaceId}/${randomUUID()}/root.jsonl.gz`;
    await db()`
      insert into storage.objects (bucket_id, name) values ('session-raw', ${myPath}), ('session-raw', ${theirPath})
    `;

    try {
      expect(await readableObjects(member)).toEqual([myPath]);
      expect(await readableObjects(outsider)).toEqual([theirPath]);
    } finally {
      await removeObjects(myPath, theirPath);
      await removeUsers();
    }
  });

  test("a signed-in user outside every workspace reads nothing", async () => {
    const { workspaceId } = await createWorkspace();
    const stranger = randomUUID();
    userIds.push(stranger);
    await db()`insert into auth.users (id, email) values (${stranger}, ${`${stranger}@example.test`})`;

    const path = `${workspaceId}/${randomUUID()}/root.jsonl.gz`;
    await db()`insert into storage.objects (bucket_id, name) values ('session-raw', ${path})`;
    try {
      expect(await readableObjects(stranger)).toEqual([]);
    } finally {
      await removeObjects(path);
    }
  });
});

async function createInput(sessionId: string, workspaceId: string, authorId: string, text = "hi"): Promise<{ id: string; state: string }> {
  const [row] = await db()<[{ input: { id: string; state: string } }]>`
    select create_session_input(${sessionId}, ${workspaceId}, ${authorId}, 'Priya', 'message', ${JSON.stringify({ text })}::text::jsonb) as input
  `;
  return row.input;
}

async function transition(inputId: string, sessionId: string, from: string[], to: string, reason: string | null = null, seq: number | null = null) {
  const [row] = await db()<[{ ok: boolean }]>`
    select transition_session_input(${inputId}, ${sessionId}, ${db().array(from, "text")}, ${to}, ${reason}, ${seq}) as ok
  `;
  return row.ok;
}

describeWithDatabase("session inputs", () => {
  afterEach(removeUsers);

  test("a new input is queued with its author", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);
    const author = await createMember(workspaceId);

    const input = await createInput(sessionId, workspaceId, author, "fix it");
    expect(input.state).toBe("queued");
    const [row] = await db()<[{ author_name: string; payload: { text: string } }]>`
      select author_name, payload from session_inputs where id = ${input.id}
    `;
    expect(row.author_name).toBe("Priya");
    expect(row.payload.text).toBe("fix it");
  });

  test("rejects input for an ended session and for another workspace", async () => {
    const { workspaceId } = await createWorkspace();
    const other = await createWorkspace();
    const sessionId = await createSession(workspaceId);
    const author = await createMember(workspaceId);

    await expect(createInput(sessionId, other.workspaceId, author)).rejects.toThrow("session_not_found");
    await db()`update sessions set status = 'ended', ended_at = now() where id = ${sessionId}`;
    await expect(createInput(sessionId, workspaceId, author)).rejects.toThrow("session_ended");
  });

  test("a full queue rejects more input", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);
    const author = await createMember(workspaceId);

    for (let i = 0; i < 20; i++) await createInput(sessionId, workspaceId, author, `m${i}`);
    await expect(createInput(sessionId, workspaceId, author, "one more")).rejects.toThrow("queue_full");
  });

  test("moves through the delivery states and ignores a late writer", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);
    const author = await createMember(workspaceId);
    const { id } = await createInput(sessionId, workspaceId, author);

    expect(await transition(id, sessionId, ["queued"], "queued", "composer_busy")).toBe(true);
    expect(await transition(id, sessionId, ["queued"], "delivering")).toBe(true);
    expect(await transition(id, sessionId, ["queued"], "delivering")).toBe(false);
    expect(await transition(id, sessionId, ["delivering"], "uncertain")).toBe(true);
    expect(await transition(id, sessionId, ["delivering", "uncertain"], "consumed", null, 7)).toBe(true);

    const [row] = await db()<[{ state: string; consumed_seq: string }]>`select state, consumed_seq from session_inputs where id = ${id}`;
    expect(row.state).toBe("consumed");
    expect(Number(row.consumed_seq)).toBe(7);
  });

  test("rejects a move the state machine does not allow", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);
    const author = await createMember(workspaceId);
    const { id } = await createInput(sessionId, workspaceId, author);

    await expect(transition(id, sessionId, ["queued"], "consumed")).rejects.toThrow("invalid_transition");
  });

  test("two hosts racing for one input: only one takes it", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);
    const author = await createMember(workspaceId);
    const { id } = await createInput(sessionId, workspaceId, author);

    const results = await Promise.all([transition(id, sessionId, ["queued"], "delivering"), transition(id, sessionId, ["queued"], "delivering")]);
    expect(results.filter(Boolean).length).toBe(1);
  });

  test("an input of another session cannot be moved", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);
    const otherSession = await createSession(workspaceId);
    const author = await createMember(workspaceId);
    const { id } = await createInput(sessionId, workspaceId, author);

    expect(await transition(id, otherSession, ["queued"], "delivering")).toBe(false);
  });
});

describeWithDatabase("permission approvals", () => {
  afterEach(removeUsers);

  const request = (id: string): TestEvent => ({ source_id: `perm:${id}`, kind: "permission_request", payload: { requestId: id, tool_name: "Bash" } });
  const resolved = (id: string, payload: Record<string, unknown>): TestEvent => ({
    source_id: `permres:${id}`,
    kind: "permission_resolved",
    payload: { requestId: id, ...payload },
  });

  async function decide(sessionId: string, workspaceId: string, author: string, name: string, requestId: string, decision = "allow") {
    const [row] = await db()<[{ result: { outcome: string; by_name?: string; reason?: string; input?: { id: string } } }]>`
      select create_permission_decision(${sessionId}, ${workspaceId}, ${author}, ${name}, ${requestId}, ${decision}) as result
    `;
    return row.result;
  }

  const openCount = async (sessionId: string) =>
    (await db()<[{ open_approval_count: number }]>`select open_approval_count from sessions where id = ${sessionId}`)[0].open_approval_count;

  test("counts open requests up and down, never below zero", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);

    await append(sessionId, workspaceId, [request("a"), request("b")]);
    expect(await openCount(sessionId)).toBe(2);
    await append(sessionId, workspaceId, [resolved("a", { reason: "decided" })]);
    expect(await openCount(sessionId)).toBe(1);
    await append(sessionId, workspaceId, [resolved("a", { reason: "decided" })]);
    expect(await openCount(sessionId)).toBe(1);
    await append(sessionId, workspaceId, [resolved("b", { reason: "expired" }), resolved("c", { reason: "expired" })]);
    expect(await openCount(sessionId)).toBe(0);
  });

  test("the first decision wins and the second sees who decided", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);
    const first = await createMember(workspaceId);
    const second = await createMember(workspaceId);
    await append(sessionId, workspaceId, [request("r1")]);

    const won = await decide(sessionId, workspaceId, first, "Dev", "r1");
    expect(won.outcome).toBe("created");
    const lost = await decide(sessionId, workspaceId, second, "Priya", "r1", "deny");
    expect(lost).toMatchObject({ outcome: "already_decided", by_name: "Dev" });
  });

  test("two deciders racing: exactly one input is created", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);
    const a = await createMember(workspaceId);
    const b = await createMember(workspaceId);
    await append(sessionId, workspaceId, [request("r1")]);

    const results = await Promise.all([decide(sessionId, workspaceId, a, "A", "r1"), decide(sessionId, workspaceId, b, "B", "r1")]);
    expect(results.filter((r) => r.outcome === "created").length).toBe(1);
  });

  test("a request closed another way, an unknown request and an ended session are refused", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);
    const author = await createMember(workspaceId);
    await append(sessionId, workspaceId, [request("r1"), resolved("r1", { reason: "answered_locally" })]);

    expect(await decide(sessionId, workspaceId, author, "Dev", "r1")).toEqual({ outcome: "request_closed", reason: "answered_locally" });
    await expect(decide(sessionId, workspaceId, author, "Dev", "nope")).rejects.toThrow("request_not_found");

    await db()`update sessions set status = 'ended' where id = ${sessionId}`;
    await expect(decide(sessionId, workspaceId, author, "Dev", "r1")).rejects.toThrow("session_ended");
  });

  test("a failed decision lets the request be decided again", async () => {
    const { workspaceId } = await createWorkspace();
    const sessionId = await createSession(workspaceId);
    const author = await createMember(workspaceId);
    await append(sessionId, workspaceId, [request("r1")]);

    const first = await decide(sessionId, workspaceId, author, "Dev", "r1");
    await db()`update session_inputs set state = 'failed' where id = ${first.input!.id}`;
    expect((await decide(sessionId, workspaceId, author, "Dev", "r1")).outcome).toBe("created");
  });
});

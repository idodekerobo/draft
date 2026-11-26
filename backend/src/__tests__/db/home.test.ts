import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { setupDbIntegrationTest } from "./support";

// The DB rules behind Home: Home sessions are owner-only, private workspace events reach only their audience,
// event sequences have no gaps, and a notification action and its history change in one transaction.
const { describeWithDatabase, db, createWorkspace } = setupDbIntegrationTest("home", "home");

const userIds: string[] = [];
// Registered inside each describe so it runs before the shared hook that deletes organizations, which users reference.
function cleanUpUsers() {
  afterEach(async () => {
    if (!userIds.length) return;
    const ids = userIds.splice(0);
    await db()`delete from auth.users where id = any(${db().array(ids, "uuid")})`;
  });
}

async function addMember(workspaceId: string): Promise<{ userId: string; personId: string }> {
  const userId = randomUUID();
  userIds.push(userId);
  await db()`insert into auth.users (id, email) values (${userId}, ${`${userId}@example.test`})`;
  const [w] = await db()<[{ organization_id: string; team_id: string }]>`select organization_id, team_id from workspaces where id = ${workspaceId}`;
  await db()`update users set organization_id = ${w.organization_id}, primary_team_id = ${w.team_id}, status = 'active' where id = ${userId}`;
  const [person] = await db()<[{ id: string }]>`
    insert into people (workspace_id, display_name, user_id, status, created_by) values (${workspaceId}, 'Member', ${userId}, 'active', 'connection') returning id
  `;
  return { userId, personId: person.id };
}

async function asUser<T>(userId: string, run: (tx: any) => Promise<T>): Promise<T> {
  return db().begin(async (tx) => {
    await tx`set local role authenticated`;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
    return run(tx);
  });
}

async function addSession(workspaceId: string, ownerUserId: string, isHome: boolean): Promise<string> {
  const [row] = await db()<[{ id: string }]>`
    insert into sessions (workspace_id, owner_user_id, host_id, is_home, execution_target, adapter_id) values (${workspaceId}, ${ownerUserId}, 'host-1', ${isHome}, 'host', 'claude-terminal') returning id
  `;
  return row.id;
}

async function addTodo(workspaceId: string, recipientPersonId: string, senderUserId: string | null): Promise<string> {
  const key = randomUUID();
  const [row] = await db()<[{ id: string }]>`
    insert into notifications (workspace_id, recipient_person_id, sender_user_id, kind, subject, body_text, needs_action, idempotency_key, content_hash)
    values (${workspaceId}, ${recipientPersonId}, ${senderUserId}, 'todo_routed', 'Send the quote', 'body', true, ${key}, 'hash') returning id
  `;
  return row.id;
}

const act = async (workspaceId: string, notificationId: string, userId: string, action: string) =>
  (await db()<[{ result: Record<string, unknown> }]>`select act_on_notification(${workspaceId}, ${notificationId}, ${userId}, ${action}) as result`)[0].result;

describeWithDatabase("home privacy", () => {
  cleanUpUsers();
  test("a teammate reads no Home session, events or inputs; the owner does; other sessions stay team-visible", async () => {
    const { workspaceId } = await createWorkspace();
    const owner = await addMember(workspaceId);
    const mate = await addMember(workspaceId);
    const home = await addSession(workspaceId, owner.userId, true);
    const normal = await addSession(workspaceId, owner.userId, false);
    await db()`insert into session_events (session_id, workspace_id, seq, source_id, kind, payload) values (${home}, ${workspaceId}, 1, 'a', 'assistant_text', '{}')`;

    const mateSessions = await asUser(mate.userId, (tx) => tx`select id from sessions where workspace_id = ${workspaceId}`);
    expect(mateSessions.map((r: { id: string }) => r.id)).toEqual([normal]);
    const mateEvents = await asUser(mate.userId, (tx) => tx`select 1 from session_events where session_id = ${home}`);
    expect(mateEvents).toHaveLength(0);
    const ownerSessions = await asUser(owner.userId, (tx) => tx`select id from sessions where workspace_id = ${workspaceId}`);
    expect(ownerSessions).toHaveLength(2);
    const ownerEvents = await asUser(owner.userId, (tx) => tx`select 1 from session_events where session_id = ${home}`);
    expect(ownerEvents).toHaveLength(1);
  });

  test("the database itself refuses another person's Home: no view, no input; the owner and ordinary sessions work", async () => {
    const { workspaceId } = await createWorkspace();
    const owner = await addMember(workspaceId);
    const mate = await addMember(workspaceId);
    const home = await addSession(workspaceId, owner.userId, true);
    const normal = await addSession(workspaceId, owner.userId, false);

    const view = async (sessionId: string, viewer: string | null) =>
      await db()`select read_session_view(${workspaceId}, ${sessionId}, null, null, null, null, null, 50, true, ${viewer}) as page`;
    await expect(view(home, mate.userId)).rejects.toThrow("session_not_found");
    await expect(view(home, null)).rejects.toThrow("session_not_found");
    expect(await view(home, owner.userId)).toHaveLength(1);
    expect(await view(normal, mate.userId)).toHaveLength(1);

    const send = async (sessionId: string, author: string) =>
      await db()`select create_session_input(${sessionId}, ${workspaceId}, ${author}, null, 'message', '{"text":"hi"}'::jsonb)`;
    await expect(send(home, mate.userId)).rejects.toThrow("session_not_found");
    await send(home, owner.userId);
    await send(normal, mate.userId);
    const inputs = await db()<{ session_id: string }[]>`select session_id from session_inputs where workspace_id = ${workspaceId}`;
    expect(inputs.map((row) => row.session_id).sort()).toEqual([home, normal].sort());
  });

  test("a person has one open Home session", async () => {
    const { workspaceId } = await createWorkspace();
    const owner = await addMember(workspaceId);
    await addSession(workspaceId, owner.userId, true);
    await expect(addSession(workspaceId, owner.userId, true)).rejects.toThrow();
  });
});

describeWithDatabase("workspace events", () => {
  cleanUpUsers();
  test("a private event is read only by its audience", async () => {
    const { workspaceId } = await createWorkspace();
    const a = await addMember(workspaceId);
    const b = await addMember(workspaceId);
    await db()`select append_workspace_event(${workspaceId}, 'manual_edit', 'shared one')`;
    await db()`select append_workspace_event(${workspaceId}, 'notification_done', 'private one', null, null, null, '{}'::jsonb, 'private', ${a.personId})`;
    const forA = await asUser(a.userId, (tx) => tx`select summary from workspace_events where workspace_id = ${workspaceId} order by sequence_number`);
    const forB = await asUser(b.userId, (tx) => tx`select summary from workspace_events where workspace_id = ${workspaceId} order by sequence_number`);
    expect(forA.map((r: { summary: string }) => r.summary)).toEqual(["shared one", "private one"]);
    expect(forB.map((r: { summary: string }) => r.summary)).toEqual(["shared one"]);
  });

  test("parallel appends give gap-free sequences", async () => {
    const { workspaceId } = await createWorkspace();
    await Promise.all(Array.from({ length: 12 }, (_, i) => db()`select append_workspace_event(${workspaceId}, 'manual_edit', ${`e${i}`})`));
    const rows = await db()<{ sequence_number: string }[]>`select sequence_number from workspace_events where workspace_id = ${workspaceId} order by sequence_number`;
    expect(rows.map((r) => Number(r.sequence_number))).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });
});

describeWithDatabase("act_on_notification", () => {
  cleanUpUsers();
  test("done is idempotent, writes one private event, and only the recipient may act", async () => {
    const { workspaceId } = await createWorkspace();
    const owner = await addMember(workspaceId);
    const me = await addMember(workspaceId);
    const id = await addTodo(workspaceId, me.personId, owner.userId);
    expect(await act(workspaceId, id, owner.userId, "done")).toMatchObject({ ok: false, code: "not_recipient" });
    expect(await act(workspaceId, id, me.userId, "done")).toMatchObject({ ok: true, state: "done", changed: true });
    expect(await act(workspaceId, id, me.userId, "done")).toMatchObject({ ok: true, changed: false });
    const events = await db()`select audience_person_id, visibility from workspace_events where workspace_id = ${workspaceId} and event_type = 'notification_done'`;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ visibility: "private", audience_person_id: me.personId });
  });

  test("not mine creates exactly one reassign card and one event; undo retracts the card", async () => {
    const { workspaceId } = await createWorkspace();
    const owner = await addMember(workspaceId);
    const me = await addMember(workspaceId);
    const id = await addTodo(workspaceId, me.personId, owner.userId);
    const first = await act(workspaceId, id, me.userId, "not_mine");
    await act(workspaceId, id, me.userId, "not_mine");
    const cards = await db()<{ id: string; recipient_person_id: string; state: string }[]>`select id, recipient_person_id, state from notifications where workspace_id = ${workspaceId} and kind = 'todo_reassign'`;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ recipient_person_id: owner.personId, state: "open", id: first.reassignNotificationId });
    expect(await act(workspaceId, id, me.userId, "undo")).toMatchObject({ ok: true, state: "open" });
    const after = await db()<{ state: string }[]>`select state from notifications where id = ${cards[0].id}`;
    expect(after[0].state).toBe("retracted");
  });

  test("undo is refused once the owner has acted on the reassign card", async () => {
    const { workspaceId } = await createWorkspace();
    const owner = await addMember(workspaceId);
    const me = await addMember(workspaceId);
    const id = await addTodo(workspaceId, me.personId, owner.userId);
    const { reassignNotificationId } = await act(workspaceId, id, me.userId, "not_mine");
    expect(await act(workspaceId, reassignNotificationId as string, owner.userId, "done")).toMatchObject({ ok: true });
    expect(await act(workspaceId, id, me.userId, "undo")).toMatchObject({ ok: false, code: "stale_undo" });
  });
});

describeWithDatabase("workspace event backfill", () => {
  cleanUpUsers();

  test("an event written from a private meeting becomes private to its owner; one from a shared item stays shared", async () => {
    const { workspaceId } = await createWorkspace();
    const owner = await addMember(workspaceId);
    const [connection] = await db()<[{ id: string }]>`
      insert into connections (workspace_id, provider, connection_key, status) values (${workspaceId}, 'fireflies', ${randomUUID()}, 'active') returning id
    `;
    await db()`
      insert into source_items (workspace_id, connection_id, item_type, external_id, external_version, occurred_at, metadata_json, visibility, owner_user_id)
      values (${workspaceId}, ${connection.id}, 'meeting_transcript', 'm1', 'v1', now(), '{"title":"Board prep"}'::jsonb, 'private', ${owner.userId})
    `;
    await db()`select append_workspace_event(${workspaceId}, 'source_items_added', 'Board prep', null, ${connection.id})`;
    await db()`select append_workspace_event(${workspaceId}, 'source_items_added', 'Team lunch', null, ${connection.id})`;

    // The backfill is the update statement of the migration, run again over the rows above.
    const migration = await Bun.file(new URL("../../../../supabase/migrations/20261125001116_workspace_event_visibility.sql", import.meta.url)).text();
    const backfill = migration.slice(migration.indexOf("update workspace_events e")).trim();
    await db().unsafe(backfill);

    const rows = await db()<{ summary: string; visibility: string; audience_person_id: string | null }[]>`
      select summary, visibility, audience_person_id from workspace_events where workspace_id = ${workspaceId} order by sequence_number
    `;
    expect(rows[0]).toMatchObject({ summary: "Board prep", visibility: "private", audience_person_id: owner.personId });
    expect(rows[1]).toMatchObject({ summary: "Team lunch", visibility: "shared", audience_person_id: null });
  });
});

import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { setupDbIntegrationTest } from "./support";

const { describeWithDatabase, db, createWorkspace } = setupDbIntegrationTest("always-on claims", "aoc");

interface AgentEventRow {
  id: string;
  workspace_id: string;
  status: string;
  attempts: number;
  failure_code: string | null;
}

interface DueClaim {
  task: { id: string; task_type: string };
  occurrence_at: Date;
}

interface TaskFixture {
  workspaceId: string;
  taskType: "agent_routine" | "summarize_sessions";
  createdVia?: "app" | "system";
  scheduleKind: "cron" | "interval" | "once";
  cronExpression?: string;
  intervalSeconds?: number;
  runAt?: string;
  nextDueAt: string | null;
}

const userIds: string[] = [];

function hourBefore(now: Date): string {
  return new Date(now.getTime() - 60 * 60_000).toISOString();
}

async function insertTask(task: TaskFixture): Promise<string> {
  const [row] = await db()<[{ id: string }]>`
    insert into scheduled_tasks (
      workspace_id, task_type, task_key, schedule_kind, cron_expression,
      interval_seconds, run_at, timezone, next_due_at, created_via
    ) values (
      ${task.workspaceId}, ${task.taskType}, ${randomUUID()}, ${task.scheduleKind},
      ${task.cronExpression ?? null}, ${task.intervalSeconds ?? null}::int,
      ${task.runAt ?? null}::timestamptz, 'UTC', ${task.nextDueAt}::timestamptz,
      ${task.createdVia ?? "app"}
    )
    returning id
  `;
  return row.id;
}

// A routine that is not due, so only the event tests touch its rows.
function idleRoutine(workspaceId: string): Promise<string> {
  return insertTask({
    workspaceId,
    taskType: "agent_routine",
    scheduleKind: "cron",
    cronExpression: "0 9 * * *",
    nextDueAt: null,
  });
}

async function insertEvent(workspaceId: string, taskId: string): Promise<string> {
  const [row] = await db()<[{ id: string }]>`
    insert into agent_events (
      workspace_id, scheduled_task_id, origin, event_name, dedupe_key, concurrency_key
    ) values (
      ${workspaceId}, ${taskId}, 'manual', 'test.event', ${randomUUID()}, ${taskId}
    )
    returning id
  `;
  return row.id;
}

async function claimWithExpiredLease(eventId: string, attempts: number): Promise<void> {
  await db()`
    update agent_events
    set status = 'claimed', attempts = ${attempts}::int, lease_until = now() - interval '1 minute'
    where id = ${eventId}
  `;
}

async function claimDueTasks(now: Date): Promise<DueClaim[]> {
  // Claims are global. The large limit keeps this test's due rows inside each batch.
  return db()<DueClaim[]>`
    select task, occurrence_at
    from claim_due_scheduled_tasks(${now.toISOString()}::timestamptz, 500, 60)
  `;
}

async function countEvents(taskId: string): Promise<number> {
  const [row] = await db()<[{ count: number }]>`
    select count(*)::int as count from agent_events where scheduled_task_id = ${taskId}
  `;
  return row.count;
}

async function createUser(): Promise<string> {
  const id = randomUUID();
  userIds.push(id);
  await db()`insert into auth.users (id, email) values (${id}, ${`${id}@example.test`})`;
  return id;
}

async function insertRoutineSession(
  workspaceId: string,
  ownerId: string,
  taskId: string,
  status: "live" | "ended",
  concurrencyKey: string,
): Promise<string> {
  const [row] = await db()<[{ id: string }]>`
    insert into sessions (
      workspace_id, owner_user_id, host_machine_id, session_type, scheduled_task_id,
      concurrency_key, status
    ) values (
      ${workspaceId}, ${ownerId}, 'host-1', 'routine', ${taskId}, ${concurrencyKey}, ${status}
    )
    returning id
  `;
  return row.id;
}

async function postgresError(statement: Promise<unknown>): Promise<Error & { errno?: string }> {
  // Bun's SQL client puts the Postgres SQLSTATE in `errno`, not `code`.
  const failure = await statement.then(
    () => null,
    (error: Error & { errno?: string }) => error,
  );
  if (!failure) throw new Error("expected Postgres statement to fail");
  return failure;
}

describeWithDatabase("always-on claim functions", () => {
  afterEach(async () => {
    const ids = userIds.splice(0);
    if (ids.length === 0) return;
    await db()`delete from auth.users where id = any(${db().array(ids, "uuid")})`;
  });

  test("parallel claim_agent_events calls return disjoint events that cover the pending set", async () => {
    const { workspaceId } = await createWorkspace();
    const taskId = await idleRoutine(workspaceId);
    const eventIds = await Promise.all(
      Array.from({ length: 10 }, () => insertEvent(workspaceId, taskId)),
    );

    const [first, second] = await Promise.all([
      db()<AgentEventRow[]>`select * from claim_agent_events(10, 60)`,
      db()<AgentEventRow[]>`select * from claim_agent_events(10, 60)`,
    ]);

    const returnedIds = [...first, ...second].map((row) => row.id);
    expect(new Set(returnedIds).size).toBe(returnedIds.length);

    const ownIds = [...first, ...second]
      .filter((row) => row.workspace_id === workspaceId)
      .map((row) => row.id);
    expect(ownIds.sort()).toEqual([...eventIds].sort());
  });

  test("a claimed event with an expired lease is returned again with one more attempt", async () => {
    const { workspaceId } = await createWorkspace();
    const taskId = await idleRoutine(workspaceId);
    const eventId = await insertEvent(workspaceId, taskId);
    await claimWithExpiredLease(eventId, 1);

    const claimed = await db()<AgentEventRow[]>`select * from claim_agent_events(10, 60)`;
    const ownRows = claimed.filter((row) => row.workspace_id === workspaceId);
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0]).toMatchObject({ id: eventId, status: "claimed", attempts: 2 });
  });

  test("a claimed event whose lease expired after three attempts becomes dead", async () => {
    const { workspaceId } = await createWorkspace();
    const taskId = await idleRoutine(workspaceId);
    const eventId = await insertEvent(workspaceId, taskId);
    await claimWithExpiredLease(eventId, 3);

    const claimed = await db()<{ id: string }[]>`select id from claim_agent_events(10, 60)`;
    expect(claimed.map((row) => row.id)).not.toContain(eventId);

    const [row] = await db()<[AgentEventRow]>`select * from agent_events where id = ${eventId}`;
    expect(row).toMatchObject({ status: "dead", failure_code: "lease_expired", attempts: 3 });

    const errors = await db()<{ scheduled_task_id: string; detail_json: Record<string, unknown> }[]>`
      select scheduled_task_id, detail_json from errors where detail_json->>'event_id' = ${eventId}
    `;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ scheduled_task_id: taskId, detail_json: { code: "agent_event_dead" } });
  });

  test("a due once routine fires one event and then disables itself", async () => {
    const { workspaceId } = await createWorkspace();
    const now = new Date();
    const taskId = await insertTask({
      workspaceId,
      taskType: "agent_routine",
      scheduleKind: "once",
      runAt: hourBefore(now),
      nextDueAt: hourBefore(now),
    });

    const firstClaims = (await claimDueTasks(now)).filter((claim) => claim.task.id === taskId);
    expect(firstClaims).toHaveLength(1);
    expect(firstClaims[0].occurrence_at.toISOString()).toBe(hourBefore(now));
    expect(await countEvents(taskId)).toBe(1);

    const [task] = await db()<[{ enabled: boolean; fired_at: Date | null; next_due_at: Date | null }]>`
      select enabled, fired_at, next_due_at from scheduled_tasks where id = ${taskId}
    `;
    expect(task.enabled).toBe(false);
    expect(task.fired_at?.toISOString()).toBe(now.toISOString());
    expect(task.next_due_at).toBeNull();

    const secondClaims = (await claimDueTasks(now)).filter((claim) => claim.task.id === taskId);
    expect(secondClaims).toHaveLength(0);
    expect(await countEvents(taskId)).toBe(1);
  });

  test("parallel claims of a due cron routine produce one event and advance next_due_at", async () => {
    const { workspaceId } = await createWorkspace();
    const now = new Date();
    const taskId = await insertTask({
      workspaceId,
      taskType: "agent_routine",
      scheduleKind: "cron",
      cronExpression: "0 9 * * *",
      nextDueAt: hourBefore(now),
    });

    const [first, second] = await Promise.all([claimDueTasks(now), claimDueTasks(now)]);
    const ownClaims = [...first, ...second].filter((claim) => claim.task.id === taskId);
    expect(ownClaims).toHaveLength(1);
    expect(await countEvents(taskId)).toBe(1);

    const [task] = await db()<[{ next_due_at: Date }]>`
      select next_due_at from scheduled_tasks where id = ${taskId}
    `;
    expect(task.next_due_at.toISOString()).toBe(new Date(now.getTime() + 60_000).toISOString());
  });

  test("a reclaim after a crash before the advance reuses the occurrence and adds no event", async () => {
    const { workspaceId } = await createWorkspace();
    const now = new Date();
    const occurrence = hourBefore(now);
    const taskId = await insertTask({
      workspaceId,
      taskType: "agent_routine",
      scheduleKind: "cron",
      cronExpression: "0 9 * * *",
      nextDueAt: occurrence,
    });

    await claimDueTasks(now);
    // The tick died before writing the real next_due_at, so the lease expires.
    const later = new Date(now.getTime() + 120_000);
    const reclaims = (await claimDueTasks(later)).filter((claim) => claim.task.id === taskId);
    expect(reclaims).toHaveLength(1);
    expect(reclaims[0]!.occurrence_at.toISOString()).toBe(occurrence);
    expect(await countEvents(taskId)).toBe(1);
  });

  test("a due system task is claimed without an agent event", async () => {
    const { workspaceId } = await createWorkspace();
    const now = new Date();
    const taskId = await insertTask({
      workspaceId,
      taskType: "summarize_sessions",
      createdVia: "system",
      scheduleKind: "interval",
      intervalSeconds: 3600,
      nextDueAt: hourBefore(now),
    });

    const ownClaims = (await claimDueTasks(now)).filter((claim) => claim.task.id === taskId);
    expect(ownClaims).toHaveLength(1);
    expect(ownClaims[0].task.task_type).toBe("summarize_sessions");
    expect(await countEvents(taskId)).toBe(0);
  });

  test("a second live routine session with the same concurrency key is rejected until the first ends", async () => {
    const { workspaceId } = await createWorkspace();
    const ownerId = await createUser();
    const taskId = await idleRoutine(workspaceId);
    const firstId = await insertRoutineSession(workspaceId, ownerId, taskId, "live", "daily");

    const failure = await postgresError(
      insertRoutineSession(workspaceId, ownerId, taskId, "live", "daily"),
    );
    expect(failure.errno).toBe("23505");
    expect(failure.message).toContain("sessions_one_live_per_key_idx");

    await db()`update sessions set status = 'ended', ended_at = now() where id = ${firstId}`;
    const secondId = await insertRoutineSession(workspaceId, ownerId, taskId, "live", "daily");
    expect(secondId).not.toBe(firstId);
  });
});

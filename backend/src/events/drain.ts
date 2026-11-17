import type { SupabaseClient } from "@supabase/supabase-js";
import { recordError } from "../errors/record-error";
import type { dispatchAgentRoutine } from "../routines/dispatch-routine";
import type { RoutineEventPayload } from "../routines/event";
import type { SandboxDeploymentConfig } from "../sandbox";
import type { ScheduledTaskRow } from "../types/tables";
import type { AgentEventPayload, AgentEventRow } from "./types";

export const EVENT_CLAIM_LIMIT = 50;
export const EVENT_LEASE_SECONDS = 15 * 60;
export const EVENT_MAX_ATTEMPTS = 3;
export const EVENTS_PER_RUN = 20;

const LIVE_SESSION_STATUSES = ["starting", "live", "host_offline"];

type Dispatch = typeof dispatchAgentRoutine;
type DispatchOutcome = Awaited<ReturnType<Dispatch>>;
type Skip = NonNullable<Extract<AgentEventPayload, { type: "webhook" }>["skip"]>;

export interface DrainDeps {
  client: SupabaseClient;
  config: SandboxDeploymentConfig;
  dispatch: Dispatch;
  now: () => Date;
}

/** The status a dispatched event takes when its outcome is started, skipped or already dispatched. */
interface Settle {
  status: "done" | "skipped";
  failureCode: string | null;
}

interface HiddenEvent {
  event: AgentEventRow;
  routineEvent: RoutineEventPayload;
  skip: Skip;
}

const DONE: Settle = { status: "done", failureCode: null };

let running: Promise<void> | null = null;
let again = false;

/**
 * Works through the event inbox. One drain runs at a time. A call made during a drain
 * runs one more pass after it, and returns the running drain's promise.
 */
export function drainEventInbox(deps: Partial<DrainDeps> = {}): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      const client = deps.client ?? (await import("../db/client")).serviceClient;
      do {
        again = false;
        await drainOnce(client, deps);
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

export function __resetDrainForTests(): void {
  running = null;
  again = false;
}

/** Defaults load lazily, and only once there is an event to run, so an empty drain needs no sandbox env. */
async function resolveDeps(client: SupabaseClient, deps: Partial<DrainDeps>): Promise<DrainDeps> {
  return {
    client,
    config: deps.config ?? (await import("../sandbox")).loadSandboxDeploymentConfig(),
    dispatch: deps.dispatch ?? (await import("../routines/dispatch-routine")).dispatchAgentRoutine,
    now: deps.now ?? (() => new Date()),
  };
}

async function drainOnce(client: SupabaseClient, partial: Partial<DrainDeps>): Promise<void> {
  const { data, error } = await client.rpc("claim_agent_events", {
    p_limit: EVENT_CLAIM_LIMIT,
    p_lease_seconds: EVENT_LEASE_SECONDS,
  });
  if (error) throw error;
  const claimed = (data ?? []) as AgentEventRow[];
  if (claimed.length === 0) return;
  let deps: DrainDeps;
  try {
    deps = await resolveDeps(client, partial);
  } catch (cause) {
    await releaseRows({ client, now: partial.now ?? (() => new Date()) } as DrainDeps, claimed);
    throw cause;
  }
  for (const group of groupEvents(claimed)) {
    try {
      await processGroup(deps, group);
    } catch (cause) {
      // The rows stay claimed until their lease expires, then a later claim retries them.
      await recordError({
        client: deps.client,
        workspaceId: group[0]!.workspace_id,
        scheduledTaskId: group[0]!.scheduled_task_id,
        operation: "scheduling",
        message: "Processing an event group failed",
        code: "event_group_failed",
        error: cause,
        detail: { event_ids: group.map((event) => event.id) },
      });
    }
  }
}

/** The events for one routine and one concurrency key. Each group runs in one dispatch, oldest first. */
function groupEvents(events: AgentEventRow[]): AgentEventRow[][] {
  const sorted = [...events].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return [...groupBy(sorted, (event) => `${event.scheduled_task_id}\u0000${event.concurrency_key}`).values()];
}

async function processGroup(deps: DrainDeps, group: AgentEventRow[]): Promise<void> {
  const task = await loadTask(deps.client, group[0]!);
  if (!task || task.deleted_at) {
    await setRows(deps, group, { status: "skipped", failure_code: "routine_deleted" });
    return;
  }

  const open = group.filter((event) => task.enabled || runsWhileDisabled(task, event));
  await setRows(deps, group.filter((event) => !open.includes(event)), { status: "skipped", failure_code: "routine_disabled" });
  if (open.length === 0) return;

  if (await hasLiveSession(deps.client, task, group[0]!.concurrency_key)) {
    await releaseRows(deps, open);
    return;
  }

  const timers = open.filter((event) => event.payload.type === "timer");
  const newestTimer = timers.reduce<AgentEventRow | undefined>((newest, event) => (!newest || timerMs(event) > timerMs(newest) ? event : newest), undefined);
  const coalesced = timers.filter((event) => event !== newestTimer);
  await setRows(deps, coalesced, { status: "skipped", failure_code: "timer_coalesced" });

  const hidden: HiddenEvent[] = [];
  const rest: AgentEventRow[] = [];
  for (const event of open) {
    if (coalesced.includes(event)) continue;
    const payload = event.payload;
    if (payload.type === "webhook" && payload.skip) hidden.push({ event, routineEvent: payload.event, skip: payload.skip });
    else rest.push(event);
  }
  for (const item of hidden) await runHidden(deps, task, item);

  await releaseRows(deps, rest.slice(EVENTS_PER_RUN));
  const chosen = rest.slice(0, EVENTS_PER_RUN);
  if (chosen.length > 0) await runRoutine(deps, task, chosen);
}

/** Run now works on a paused routine. A one-shot's timer is queued by the claim that disables it, so it runs too. */
function runsWhileDisabled(task: ScheduledTaskRow, event: AgentEventRow): boolean {
  if (event.origin === "manual") return true;
  return event.origin === "schedule" && task.schedule_kind === "once" && Boolean(task.fired_at);
}

async function runHidden(deps: DrainDeps, task: ScheduledTaskRow, { event, routineEvent, skip }: HiddenEvent): Promise<void> {
  let outcome: DispatchOutcome;
  try {
    outcome = await deps.dispatch({
      task,
      occurrenceAt: deps.now().toISOString(),
      events: [routineEvent],
      skip,
      kind: event.event_name,
      firstEventId: event.id,
      concurrencyKey: null,
      eventIds: [event.id],
      config: deps.config,
      client: deps.client,
    });
  } catch (cause) {
    await retryOrDead(deps, task, [event], cause);
    return;
  }
  await applyOutcome(deps, [event], outcome, { status: "skipped", failureCode: skip.code });
}

async function runRoutine(deps: DrainDeps, task: ScheduledTaskRow, chosen: AgentEventRow[]): Promise<void> {
  const first = chosen[0]!;
  const occurrenceAt = chosen.map(timerOccurrence).find((value) => value !== null) ?? deps.now().toISOString();
  const requestedBy = chosen.map(manualRequester).find((value) => value !== null);
  const routineEvents = chosen.flatMap((event) => (event.payload.type === "webhook" ? [event.payload.event] : []));

  let outcome: DispatchOutcome;
  try {
    outcome = await deps.dispatch({
      task,
      occurrenceAt,
      kind: runKind(first),
      firstEventId: first.id,
      concurrencyKey: first.concurrency_key,
      eventIds: chosen.map((event) => event.id),
      ...(routineEvents.length > 0 ? { events: routineEvents } : {}),
      ...(requestedBy ? { manual: { requestedBy } } : {}),
      config: deps.config,
      client: deps.client,
    });
  } catch (cause) {
    await retryOrDead(deps, task, chosen, cause);
    return;
  }
  await applyOutcome(deps, chosen, outcome, DONE);
}

async function applyOutcome(deps: DrainDeps, rows: AgentEventRow[], outcome: DispatchOutcome, settle: Settle): Promise<void> {
  switch (outcome.status) {
    case "started":
    case "skipped":
      if (outcome.runId) await linkRuns(deps, rows, outcome.runId);
      await setRows(deps, rows, { status: settle.status, failure_code: settle.failureCode, claimed_by_run_id: outcome.runId });
      return;
    case "already_dispatched":
      await setRows(deps, rows, { status: settle.status, failure_code: settle.failureCode });
      return;
    case "failed":
      await setRows(deps, rows, { status: "failed", failure_code: outcome.code ?? "dispatch_failed" });
      return;
    case "busy":
      await releaseRows(deps, rows);
      return;
  }
}

async function retryOrDead(deps: DrainDeps, task: ScheduledTaskRow, rows: AgentEventRow[], cause: unknown): Promise<void> {
  const retry = rows.filter((event) => event.attempts < EVENT_MAX_ATTEMPTS);
  const dead = rows.filter((event) => event.attempts >= EVENT_MAX_ATTEMPTS);
  await setRows(deps, retry, { status: "pending", failure_code: "dispatch_error" });
  await setRows(deps, dead, { status: "dead", failure_code: "dispatch_error" });
  if (retry.length > 0) {
    await recordError({
      client: deps.client,
      workspaceId: task.workspace_id,
      scheduledTaskId: task.id,
      operation: "scheduling",
      message: "An event could not start its routine; it will retry",
      code: "agent_event_dispatch_failed",
      error: cause,
      detail: { event_ids: retry.map((event) => event.id), attempts: retry.map((event) => event.attempts) },
    });
  }
  if (dead.length > 0) {
    await recordError({
      client: deps.client,
      workspaceId: task.workspace_id,
      scheduledTaskId: task.id,
      operation: "scheduling",
      message: "An event could not start its routine after retries",
      code: "agent_event_dead",
      error: cause,
      detail: { event_ids: dead.map((event) => event.id) },
    });
  }
}

/** The claim counted an attempt that never ran, so the release gives it back. */
async function releaseRows(deps: DrainDeps, rows: AgentEventRow[]): Promise<void> {
  for (const [attempts, group] of groupBy(rows, (event) => event.attempts)) {
    await setRows(deps, group, { status: "pending", attempts: Math.max(attempts - 1, 0) });
  }
}

async function setRows(deps: DrainDeps, rows: AgentEventRow[], fields: Record<string, unknown>): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await deps.client
    .from("agent_events")
    .update({ ...fields, lease_until: null, updated_at: deps.now().toISOString() })
    .in("id", rows.map((event) => event.id));
  if (error) throw error;
}

async function linkRuns(deps: DrainDeps, rows: AgentEventRow[], runId: string): Promise<void> {
  const { error } = await deps.client.from("agent_run_events").insert(
    rows.map((event) => ({ agent_run_id: runId, agent_event_id: event.id, workspace_id: event.workspace_id })),
  );
  if (error) throw error;
}

async function loadTask(client: SupabaseClient, event: AgentEventRow): Promise<ScheduledTaskRow | null> {
  const { data, error } = await client
    .from("scheduled_tasks")
    .select("*")
    .eq("id", event.scheduled_task_id)
    .eq("workspace_id", event.workspace_id)
    .maybeSingle();
  if (error) throw error;
  return (data as ScheduledTaskRow | null) ?? null;
}

async function hasLiveSession(client: SupabaseClient, task: ScheduledTaskRow, concurrencyKey: string): Promise<boolean> {
  const { data, error } = await client
    .from("sessions")
    .select("id")
    .eq("workspace_id", task.workspace_id)
    .eq("scheduled_task_id", task.id)
    .eq("concurrency_key", concurrencyKey)
    .in("status", LIVE_SESSION_STATUSES)
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

function groupBy<T, K>(items: T[], keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function timerOccurrence(event: AgentEventRow): string | null {
  return event.payload.type === "timer" ? event.payload.occurrenceAt : null;
}

function manualRequester(event: AgentEventRow): string | null {
  return event.payload.type === "manual" ? event.payload.requestedBy : null;
}

function timerMs(event: AgentEventRow): number {
  const occurrence = timerOccurrence(event);
  return occurrence ? Date.parse(occurrence) : 0;
}

function runKind(event: AgentEventRow): string {
  if (event.payload.type === "timer" || event.payload.type === "manual") return event.payload.type;
  return event.event_name;
}

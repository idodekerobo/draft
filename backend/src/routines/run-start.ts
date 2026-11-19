import { ROUTINE_EVENT_NAMES, type RoutineEventName } from "draft-core/routines";

export type RoutineRunStart = { type: "schedule" } | { type: "manual" } | { type: "event"; event: RoutineEventName };

/** Read from the run's idempotency key, which dispatch writes as "<task>:<occurrence>", "<task>:manual:<id>" or "<task>:<event>:<id>". */
export function routineRunStartOf(row: { idempotency_key: string | null; scheduled_task_id: string }): RoutineRunStart {
  const rest = row.idempotency_key?.slice(row.scheduled_task_id.length + 1) ?? "";
  if (rest.startsWith("manual:")) return { type: "manual" };
  const event = ROUTINE_EVENT_NAMES.find((name) => rest.startsWith(`${name}:`));
  return event ? { type: "event", event } : { type: "schedule" };
}

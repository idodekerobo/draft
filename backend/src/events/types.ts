import type { RoutineEventPayload } from "../routines/event";

export type AgentEventOrigin = "schedule" | "webhook" | "manual" | "agent";

export interface AgentEventRow {
  id: string;
  workspace_id: string;
  scheduled_task_id: string;
  origin: AgentEventOrigin;
  event_name: string;
  dedupe_key: string;
  concurrency_key: string;
  source_item_id: string | null;
  payload: AgentEventPayload;
  status: "pending" | "claimed" | "done" | "skipped" | "failed" | "dead";
  attempts: number;
  lease_until: string | null;
  claimed_by_run_id: string | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
}

export type AgentEventPayload =
  | { type: "timer"; occurrenceAt: string }
  | { type: "manual"; requestedBy: string }
  | { type: "webhook"; event: RoutineEventPayload; skip?: { code: string; note: string } };

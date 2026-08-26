import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import type { ScheduledTaskRow } from "../types/tables";
import { recordRouteError } from "../errors/route-error";

type SynthesisScheduleRequest = Bun.BunRequest<"/workspaces/:id/synthesis-schedule">;

type ScheduleRow = Pick<
  ScheduledTaskRow,
  "enabled" | "schedule_kind" | "cron_expression" | "interval_seconds" | "next_due_at" | "last_enqueued_at"
>;

function toScheduleResponse(task: ScheduleRow) {
  return {
    enabled: task.enabled,
    scheduleKind: task.schedule_kind,
    cronExpression: task.cron_expression,
    intervalSeconds: task.interval_seconds,
    nextDueAt: task.next_due_at,
    lastEnqueuedAt: task.last_enqueued_at,
  };
}

export const GET = withAuth<SynthesisScheduleRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const { data: task, error } = await serviceClient
    .from("scheduled_tasks")
    .select("enabled, schedule_kind, cron_expression, interval_seconds, next_due_at, last_enqueued_at")
    .eq("workspace_id", req.params.id)
    .eq("task_type", "synthesize_workspace")
    .maybeSingle<ScheduleRow>();
  if (error) {
    recordRouteError({ workspaceId: req.params.id, operation: "read", errorCode: "synthesis_schedule_read_failed", error });
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!task) return Response.json({ error: "no_schedule_yet" }, { status: 404 });

  return Response.json(toScheduleResponse(task));
});

interface SynthesisScheduleBody {
  enabled: boolean;
}

function isSynthesisScheduleBody(value: unknown): value is SynthesisScheduleBody {
  return !!value && typeof value === "object" && typeof (value as { enabled?: unknown }).enabled === "boolean";
}

// Only toggles enabled -- cadence editing isn't supported yet.
export const PATCH = withAuth<SynthesisScheduleRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!isSynthesisScheduleBody(body)) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const { data: task, error } = await serviceClient
    .from("scheduled_tasks")
    .update({ enabled: body.enabled })
    .eq("workspace_id", req.params.id)
    .eq("task_type", "synthesize_workspace")
    .select("enabled, schedule_kind, cron_expression, interval_seconds, next_due_at, last_enqueued_at")
    .maybeSingle<ScheduleRow>();
  if (error) {
    recordRouteError({ workspaceId: req.params.id, operation: "commit", errorCode: "synthesis_schedule_update_failed", error });
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!task) return Response.json({ error: "no_schedule_yet" }, { status: 404 });

  return Response.json(toScheduleResponse(task));
});

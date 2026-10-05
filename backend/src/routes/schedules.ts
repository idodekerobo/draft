import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";
import { recordAgentQueryLog } from "../observability/record-query-log";
import { canEditSchedules } from "../schedules/permissions";
import { ScheduleServiceError, getRoutineTask, listRoutines, updateRoutine } from "../schedules/service";
import { validatePatch } from "../schedules/validate-patch";

type SchedulesRequest = Bun.BunRequest<"/workspaces/:id/schedules">;
type ScheduleRequest = Bun.BunRequest<"/workspaces/:id/schedules/:taskId">;

export const GET = withAuth<SchedulesRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  try {
    const [routines, canEdit] = await Promise.all([
      listRoutines(req.params.id),
      canEditSchedules(req.params.id, caller.userId),
    ]);
    const body = JSON.stringify({ routines, canEdit });
    // Browser reads carry an Origin header; only agent reads (CLI) count as agent usage.
    if (!req.headers.has("origin")) void recordAgentQueryLog(serviceClient, {
      workspaceId: req.params.id,
      userId: caller.userId,
      command: "routines.list",
      argsJson: {},
      resultBytes: Buffer.byteLength(body, "utf8"),
    });
    return new Response(body, { headers: { "content-type": "application/json" } });
  } catch (error) {
    recordRouteError({ workspaceId: req.params.id, errorCode: "schedules_read_failed", error });
    return Response.json({ error: "schedules_read_failed" }, { status: 500 });
  }
});

export const PATCH = withAuth<ScheduleRequest>(async (req, caller) => {
  const { id: workspaceId, taskId } = req.params;
  const denied = await assertWorkspaceAccess(workspaceId, caller.userId);
  if (denied) return denied;
  if (!(await canEditSchedules(workspaceId, caller.userId))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const routineTask = await getRoutineTask(workspaceId, taskId);
    if (!routineTask) return Response.json({ error: "not_found" }, { status: 404 });
    const { definition } = routineTask;

    const validation = validatePatch(body, definition.editable);
    if (!validation.ok) {
      return Response.json({ error: validation.error, field: validation.field }, { status: 400 });
    }
    return Response.json(await updateRoutine(routineTask, validation.patch, caller.userId));
  } catch (error) {
    if (error instanceof ScheduleServiceError) {
      if (error.code === "not_found") return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json({ error: "invalid_schedule", field: error.field }, { status: 400 });
    }
    recordRouteError({ workspaceId, operation: "commit", errorCode: "schedules_update_failed", error });
    return Response.json({ error: "schedules_update_failed" }, { status: 500 });
  }
});

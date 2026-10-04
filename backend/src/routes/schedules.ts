import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { recordRouteError } from "../errors/route-error";
import { ROUTINE_REGISTRY } from "../scheduling/routine-registry";
import { assertCanEditSchedules } from "../schedules/permissions";
import { ScheduleServiceError, getEditableTask, listRoutines, updateRoutine } from "../schedules/service";
import { validatePatch } from "../schedules/validate-patch";

type SchedulesRequest = Bun.BunRequest<"/workspaces/:id/schedules">;
type ScheduleRequest = Bun.BunRequest<"/workspaces/:id/schedules/:taskId">;

export const GET = withAuth<SchedulesRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  try {
    const [routines, editDenied] = await Promise.all([
      listRoutines(req.params.id),
      assertCanEditSchedules(req.params.id, caller.userId),
    ]);
    return Response.json({ routines, canEdit: editDenied === null });
  } catch (error) {
    recordRouteError({ workspaceId: req.params.id, errorCode: "schedules_read_failed", error });
    return Response.json({ error: "schedules_read_failed" }, { status: 500 });
  }
});

export const PATCH = withAuth<ScheduleRequest>(async (req, caller) => {
  const { id: workspaceId, taskId } = req.params;
  const denied = await assertCanEditSchedules(workspaceId, caller.userId);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const task = await getEditableTask(workspaceId, taskId);
    const definition = task && ROUTINE_REGISTRY[task.task_type];
    if (!task || !definition) return Response.json({ error: "not_found" }, { status: 404 });

    const validation = validatePatch(body, definition.editable);
    if (!validation.ok) {
      return Response.json({ error: validation.error, field: validation.field }, { status: 400 });
    }
    return Response.json(await updateRoutine(task, validation.patch, caller.userId));
  } catch (error) {
    if (error instanceof ScheduleServiceError) {
      if (error.code === "not_found") return Response.json({ error: "not_found" }, { status: 404 });
      if (error.code === "invalid_schedule") {
        return Response.json({ error: "invalid_schedule", field: error.field }, { status: 400 });
      }
      return Response.json({ error: "schedules_update_failed" }, { status: 500 });
    }
    recordRouteError({ workspaceId, operation: "commit", errorCode: "schedules_update_failed", error });
    return Response.json({ error: "schedules_update_failed" }, { status: 500 });
  }
});

import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";
import { recordAgentQueryLog } from "../observability/record-query-log";
import { lacksRoutineLogin, routineAgentStatuses } from "../routines/agent-status";
import { canEditSchedules } from "../schedules/permissions";
import { parseAgentRoutineConfig } from "../routines/config";
import { ScheduleServiceError, createAgentRoutine, deleteRoutine, getRoutineTask, listRoutineRuns, listRoutines, updateRoutine } from "../schedules/service";
import { validateCreate } from "../schedules/validate-create";
import { validatePatch } from "../schedules/validate-patch";

type SchedulesRequest = Bun.BunRequest<"/workspaces/:id/schedules">;
type ScheduleRequest = Bun.BunRequest<"/workspaces/:id/schedules/:taskId">;
type RunsRequest = Bun.BunRequest<"/workspaces/:id/schedules/:taskId/runs">;

export const GET = withAuth<SchedulesRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  try {
    const [routines, canEdit, agents] = await Promise.all([
      listRoutines(req.params.id),
      canEditSchedules(req.params.id, caller.userId),
      // A failed lookup leaves the list working. The page then offers every agent as ready.
      routineAgentStatuses(serviceClient, req.params.id).catch(() => undefined),
    ]);
    const body = JSON.stringify({ routines, canEdit, agents });
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
    const { definition, task } = routineTask;
    const current = task.task_type === "agent_routine" ? parseAgentRoutineConfig(task.config_json) : null;

    const validation = validatePatch(body, definition.editable, current);
    if (!validation.ok) {
      return Response.json({ error: validation.error, field: validation.field }, { status: 400 });
    }
    const harness = validation.patch.agent?.harness;
    if (harness && harness !== current?.harness && (await lacksRoutineLogin(serviceClient, workspaceId, harness))) {
      return Response.json({ error: "codex_not_connected", field: "harness" }, { status: 409 });
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

export const DELETE = withAuth<ScheduleRequest>(async (req, caller) => {
  const { id: workspaceId, taskId } = req.params;
  const denied = await assertWorkspaceAccess(workspaceId, caller.userId);
  if (denied) return denied;
  if (!(await canEditSchedules(workspaceId, caller.userId))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const routineTask = await getRoutineTask(workspaceId, taskId);
    if (!routineTask) return Response.json({ error: "not_found" }, { status: 404 });
    // Only a routine that a person made can be deleted. The built-in ones are part of the product.
    if (routineTask.task.task_type !== "agent_routine") return Response.json({ error: "field_not_editable" }, { status: 400 });
    await deleteRoutine(routineTask, caller.userId);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof ScheduleServiceError && error.code === "not_found") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    recordRouteError({ workspaceId, operation: "commit", errorCode: "schedules_delete_failed", error });
    return Response.json({ error: "schedules_delete_failed" }, { status: 500 });
  }
});

export const POST = withAuth<SchedulesRequest>(async (req, caller) => {
  const workspaceId = req.params.id;
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
  const validation = validateCreate(body);
  if (!validation.ok) return Response.json({ error: "invalid_body", field: validation.field }, { status: 400 });

  try {
    if (await lacksRoutineLogin(serviceClient, workspaceId, validation.config.harness)) {
      return Response.json({ error: "codex_not_connected", field: "harness" }, { status: 409 });
    }
    return Response.json(await createAgentRoutine(workspaceId, caller.userId, validation), { status: 201 });
  } catch (error) {
    if (error instanceof ScheduleServiceError) {
      return Response.json({ error: "invalid_schedule", field: error.field }, { status: 400 });
    }
    recordRouteError({ workspaceId, operation: "commit", errorCode: "schedules_create_failed", error });
    return Response.json({ error: "schedules_create_failed" }, { status: 500 });
  }
});

export const RUNS = withAuth<RunsRequest>(async (req, caller) => {
  const { id: workspaceId, taskId } = req.params;
  const denied = await assertWorkspaceAccess(workspaceId, caller.userId);
  if (denied) return denied;

  try {
    const runs = await listRoutineRuns(workspaceId, taskId);
    if (!runs) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ runs });
  } catch (error) {
    recordRouteError({ workspaceId, errorCode: "schedules_runs_failed", error });
    return Response.json({ error: "schedules_runs_failed" }, { status: 500 });
  }
});

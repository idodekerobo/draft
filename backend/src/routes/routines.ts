import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";
import { callSurface, isAgentRequest } from "../observability/is-agent-request";
import { recordAgentQueryLog } from "../observability/record-query-log";
import { routineAgentProblem, routineAgentStatuses } from "../routines/agent-status";
import { canEditSchedules } from "../routines/permissions";
import { personCreator } from "../routines/creator";
import { parseAgentRoutineConfig } from "../routines/config";
import { RoutineListFilter } from "draft-core/routines";
import { ScheduleServiceError, createAgentRoutine, deleteRoutine, getRoutineTask, listRoutineRuns, listConnectedProviders, listRoutines, runRoutineNow, updateRoutine } from "../routines/service";
import { validateCreate } from "../routines/validate-create";
import { parseCursor } from "../activity/service";
import { validatePatch } from "../routines/validate-patch";
import { personalConnectionProviders } from "../ingestion/gmail/access";

type SchedulesRequest = Bun.BunRequest<"/workspaces/:id/schedules">;
type ScheduleRequest = Bun.BunRequest<"/workspaces/:id/schedules/:taskId">;
type RunsRequest = Bun.BunRequest<"/workspaces/:id/schedules/:taskId/runs">;
type RunRequest = Bun.BunRequest<"/workspaces/:id/schedules/:taskId/run">;

const LIST_FILTER_KEYS = ["kind", "status", "createdBy"];

/** Reads kind, status and createdBy from the query string. Other parameters are ignored. */
function listFilterFrom(url: string): { ok: true; filter: RoutineListFilter } | { ok: false; field: string } {
  const params = new URL(url).searchParams;
  const raw = Object.fromEntries(LIST_FILTER_KEYS.filter((key) => params.has(key)).map((key) => [key, params.get(key)]));
  const parsed = RoutineListFilter.omit({ taskId: true }).safeParse(raw);
  return parsed.success ? { ok: true, filter: parsed.data } : { ok: false, field: String(parsed.error.issues[0]?.path[0] ?? "filter") };
}

export const GET = withAuth<SchedulesRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  const filter = listFilterFrom(req.url);
  if (!filter.ok) return Response.json({ error: "invalid_filter", message: `${filter.field} is not a value the routine list takes.`, field: filter.field }, { status: 400 });

  try {
    const [routines, connectedProviders, agents, gmailConnected] = await Promise.all([
      listRoutines(req.params.id, caller.userId, filter.filter),
      // A failed lookup is recorded and leaves the list working. The form then treats every connection as present.
      listConnectedProviders(req.params.id).catch((error) => {
        recordRouteError({ workspaceId: req.params.id, errorCode: "schedules_connections_lookup_failed", error });
        return undefined;
      }),
      // A failed lookup is recorded and leaves the list working. The page then offers every agent as ready.
      routineAgentStatuses(serviceClient, req.params.id).catch((error) => {
        recordRouteError({ workspaceId: req.params.id, errorCode: "schedules_agent_status_failed", error });
        return undefined;
      }),
      // Gmail is personal: this is the caller's own connection, never a teammate's.
      personalConnectionProviders(serviceClient, req.params.id, caller.userId).then((providers) => providers.has("gmail")).catch((error) => {
        recordRouteError({ workspaceId: req.params.id, errorCode: "schedules_gmail_lookup_failed", error });
        return undefined;
      }),
    ]);
    const canEdit = await canEditSchedules(req.params.id, caller.userId);
    const body = JSON.stringify({ routines, canEdit, agents, connectedProviders, gmailConnected });
    if (isAgentRequest(req)) void recordAgentQueryLog(serviceClient, {
      workspaceId: req.params.id,
      userId: caller.userId,
      command: "routines.list",
      status: "ok",
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
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const routineTask = await getRoutineTask(workspaceId, taskId, undefined, caller.userId);
    if (!routineTask) return Response.json({ error: "not_found" }, { status: 404 });
    const { definition, task } = routineTask;
    const current = task.task_type === "agent_routine" ? parseAgentRoutineConfig(task.config_json) : null;

    const validation = validatePatch(body, definition.editable, current);
    if (!validation.ok) {
      return Response.json({ error: validation.error, field: validation.field }, { status: 400 });
    }
    const harness = validation.patch.agent?.harness;
    const agentProblem = harness && harness !== current?.harness ? await routineAgentProblem(serviceClient, workspaceId, harness) : null;
    if (agentProblem) return Response.json({ error: agentProblem.code, message: agentProblem.message, field: "harness" }, { status: 409 });
    return Response.json(await updateRoutine(routineTask, validation.patch, caller.userId, new Date(), { via: callSurface(req) }));
  } catch (error) {
    if (error instanceof ScheduleServiceError) {
      if (error.code === "not_found") return Response.json({ error: "not_found" }, { status: 404 });
      if (error.code === "forbidden") return Response.json({ error: "forbidden" }, { status: 403 });
      return Response.json({ error: error.code, message: error.message, field: error.field }, { status: 400 });
    }
    recordRouteError({ workspaceId, operation: "commit", errorCode: "schedules_update_failed", error });
    return Response.json({ error: "schedules_update_failed" }, { status: 500 });
  }
});

export const DELETE = withAuth<ScheduleRequest>(async (req, caller) => {
  const { id: workspaceId, taskId } = req.params;
  const denied = await assertWorkspaceAccess(workspaceId, caller.userId);
  if (denied) return denied;
  try {
    const routineTask = await getRoutineTask(workspaceId, taskId, undefined, caller.userId);
    if (!routineTask) return Response.json({ error: "not_found" }, { status: 404 });
    // Only a routine that a person made can be deleted. The built-in ones are part of the product.
    if (routineTask.task.task_type !== "agent_routine") return Response.json({ error: "field_not_editable" }, { status: 400 });
    await deleteRoutine(routineTask, caller.userId, new Date(), { via: callSurface(req) });
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
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const validation = validateCreate(body);
  if (!validation.ok) return Response.json({ error: "invalid_body", field: validation.field }, { status: 400 });

  try {
    const agentProblem = await routineAgentProblem(serviceClient, workspaceId, validation.config.harness);
    if (agentProblem) return Response.json({ error: agentProblem.code, message: agentProblem.message, field: "harness" }, { status: 409 });
    return Response.json(await createAgentRoutine(workspaceId, personCreator(caller.userId, callSurface(req)), validation), { status: 201 });
  } catch (error) {
    if (error instanceof ScheduleServiceError) {
      if (error.code === "forbidden") return Response.json({ error: "forbidden" }, { status: 403 });
      return Response.json({ error: error.code, message: error.message, field: error.field }, { status: 400 });
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
    const before = parseCursor(new URL(req.url).searchParams.get("before"));
    if (before === "invalid") return Response.json({ error: "invalid_cursor" }, { status: 400 });
    const page = await listRoutineRuns(workspaceId, taskId, { before, viewerId: caller.userId });
    if (!page) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(page);
  } catch (error) {
    recordRouteError({ workspaceId, errorCode: "schedules_runs_failed", error });
    return Response.json({ error: "schedules_runs_failed" }, { status: 500 });
  }
});

export const RUN = withAuth<RunRequest>(async (req, caller) => {
  const { id: workspaceId, taskId } = req.params;
  const denied = await assertWorkspaceAccess(workspaceId, caller.userId);
  if (denied) return denied;
  try {
    const outcome = await runRoutineNow(workspaceId, taskId, caller.userId, { attribution: { via: callSurface(req) } });
    if (outcome.status === "failed" && outcome.code === "routine_lease_busy") return Response.json({ error: "codex_login_busy", outcome }, { status: 409 });
    if (outcome.status === "failed") return Response.json({ error: "run_failed", outcome }, { status: 502 });
    return Response.json({ outcome }, { status: 202 });
  } catch (error) {
    if (error instanceof ScheduleServiceError) {
      if (error.code === "not_found") return Response.json({ error: "not_found" }, { status: 404 });
      if (error.code === "forbidden") return Response.json({ error: "forbidden" }, { status: 403 });
    }
    recordRouteError({ workspaceId, operation: "commit", errorCode: "schedules_run_now_failed", error });
    return Response.json({ error: "schedules_run_now_failed" }, { status: 500 });
  }
});

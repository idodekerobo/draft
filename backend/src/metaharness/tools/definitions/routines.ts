import type { SupabaseClient } from "@supabase/supabase-js";
import { RoutineInput, RoutinePatch } from "draft-core/routines";
import { z } from "zod";
import { defineTool, refuse } from "../tool-registry";
import { requireUser } from "./shared";

const scheduleService = () => import("../../../schedules/service");
const UUID = z.string().uuid();
const runError = (error: unknown) => error instanceof Error && error.message === "forbidden"
  ? refuse("not_permitted", "Only the routine's creator or a workspace admin can change it.")
  : refuse("routine_failed", "The routine operation could not be completed.");

export function createRoutineTools(client: SupabaseClient) {
  const list = defineTool({ name: "routines.list", mcp: true, callers: ["user"], input: z.object({}), description: "List workspace routines.", handler: async ({ caller }) => {
    const user = requireUser(caller, "routines.list");
    return { status: "ok", output: { routines: await (await scheduleService()).listRoutines(user.workspaceId, user.userId) } };
  } });
  const create = defineTool({ name: "routines.create", mcp: true, callers: ["user"], input: RoutineInput, description: "Create a scheduled routine.", handler: async ({ caller, input }) => {
    const user = requireUser(caller, "routines.create");
    try {
      const { validateCreate } = await import("../../../schedules/validate-create");
      const checked = validateCreate({ ...input, schedule: input.schedule });
      if (!checked.ok) return refuse("invalid_input", `Invalid routine field: ${checked.field}`);
      const { lacksRoutineLogin } = await import("../../../routines/agent-status");
      if (await lacksRoutineLogin(client, user.workspaceId, checked.config.harness)) return refuse("codex_not_connected", "Connect Codex in Settings before creating this routine.");
      return { status: "ok", output: await (await scheduleService()).createAgentRoutine(user.workspaceId, user.userId, checked) };
    } catch (error) { return runError(error); }
  } });
  const update = defineTool({ name: "routines.update", mcp: true, callers: ["user"], input: z.object({ taskId: UUID, patch: RoutinePatch }), description: "Update a routine you created, or any routine as an admin.", handler: async ({ caller, input }) => {
    const user = requireUser(caller, "routines.update");
    try {
      const svc = await scheduleService();
      const task = await svc.getRoutineTask(user.workspaceId, input.taskId);
      if (!task) return refuse("not_found", "Routine not found.");
      const { validatePatch } = await import("../../../schedules/validate-patch");
      const config = task.task.task_type === "agent_routine" ? (await import("../../../routines/config")).parseAgentRoutineConfig(task.task.config_json) : null;
      const patch = validatePatch(input.patch, task.definition.editable, config);
      if (!patch.ok) return refuse(patch.error === "field_not_editable" ? "not_permitted" : "invalid_input", patch.field ?? "Invalid routine patch.");
      if (patch.patch.agent?.harness) {
        const { lacksRoutineLogin } = await import("../../../routines/agent-status");
        if (await lacksRoutineLogin(client, user.workspaceId, patch.patch.agent.harness)) return refuse("codex_not_connected", "Connect Codex in Settings before selecting this harness.");
      }
      return { status: "ok", output: await svc.updateRoutine(task, patch.patch, user.userId) };
    } catch (error) { return runError(error); }
  } });
  const remove = defineTool({ name: "routines.delete", mcp: true, callers: ["user"], input: z.object({ taskId: UUID }), description: "Delete a routine you created, or any routine as an admin.", handler: async ({ caller, input }) => {
    const user = requireUser(caller, "routines.delete");
    try {
      const svc = await scheduleService();
      const task = await svc.getRoutineTask(user.workspaceId, input.taskId);
      if (!task || task.task.task_type !== "agent_routine") return refuse("not_found", "Routine not found.");
      await svc.deleteRoutine(task, user.userId);
      return { status: "ok", output: { deleted: true } };
    } catch (error) { return runError(error); }
  } });
  const run = defineTool({ name: "routines.run", mcp: true, callers: ["user"], input: z.object({ taskId: UUID }), description: "Run a routine now.", handler: async ({ caller, input }) => {
    const user = requireUser(caller, "routines.run");
    try {
      const outcome = await (await scheduleService()).runRoutineNow(user.workspaceId, input.taskId, user.userId);
      if (outcome.status === "already_running") return refuse("already_running", "This routine already has a run in progress.");
      if (outcome.status === "failed" && outcome.code === "routine_lease_busy") return refuse("codex_login_busy", "Another Codex run is using the login. Try again when it finishes.");
      if (outcome.status === "failed") return refuse(outcome.code ?? "run_failed", "The routine could not start.");
      return { status: "ok", output: { outcome } };
    } catch (error) { return runError(error); }
  } });
  const runs = defineTool({ name: "routines.runs", mcp: true, callers: ["user"], input: z.object({ taskId: UUID }), description: "List recent runs for a routine.", handler: async ({ caller, input }) => {
    const user = requireUser(caller, "routines.runs");
    try {
      const result = await (await scheduleService()).listRoutineRuns(user.workspaceId, input.taskId);
      return result ? { status: "ok", output: { runs: result } } : refuse("not_found", "Routine not found.");
    } catch (error) { return runError(error); }
  } });
  return [list, create, update, remove, run, runs];
}

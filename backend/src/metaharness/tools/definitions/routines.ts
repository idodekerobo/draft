import type { SupabaseClient } from "@supabase/supabase-js";
import { HARNESSES } from "draft-core/harnesses";
import { ROUTINE_PRESETS, ROUTINE_TRIGGERS, ROUTINE_WEEKDAYS, RoutineInput, RoutinePatch, routineProviders } from "draft-core/routines";
import { z } from "zod";
import { recordError } from "../../../errors/record-error";
import { defineTool, refuse, type ToolHandlerResult } from "../tool-registry";
import { requireUser } from "./shared";
import { createSlackTools } from "./slack";

const scheduleService = () => import("../../../schedules/service");
const UUID = z.string().uuid();
/** A forbidden caller is a refusal. Anything else is unexpected, so it is recorded before the generic refusal. */
async function runError(error: unknown, workspaceId: string, tool: string, scheduledTaskId?: string): Promise<ToolHandlerResult> {
  if (error instanceof Error && error.message === "forbidden") return refuse("not_permitted", "You can't change routines in this workspace.");
  await recordError({ workspaceId, scheduledTaskId, operation: "execution", code: "routine_tool_failed", message: `${tool} failed`, detail: { tool }, error });
  return refuse("routine_failed", "The routine operation could not be completed.");
}

const PRESET_MEANINGS: Record<(typeof ROUTINE_PRESETS)[number], string> = {
  draft_default: "Draft's default cadence",
  hourly: "Every hour",
  daily: "Every day at `time`",
  weekdays: "Monday to Friday at `time`",
  weekly: "Once a week on `weekday` at `time`",
};

/** Refuses when the given settings need a connection the workspace doesn't have, so a trigger can't be saved that never fires. */
async function refuseMissingConnections(workspaceId: string, settings: Parameters<typeof routineProviders>[0]): Promise<ToolHandlerResult | null> {
  const needed = routineProviders(settings);
  if (needed.length === 0) return null;
  const connected = await (await scheduleService()).listConnectedProviders(workspaceId);
  const missing = needed.filter((provider) => !connected.includes(provider));
  if (missing.length === 0) return null;
  return refuse(`${missing[0]}_not_connected`, `${missing.join(", ")} is not connected. Ask the person whether to connect it, then call integrations.connect.`);
}

/** The routine as routines.list shows it, so a write answers with exactly what was stored. */
async function savedRoutine(workspaceId: string, userId: string, taskId: string) {
  return (await (await scheduleService()).listRoutines(workspaceId, userId)).find((routine) => routine.id === taskId) ?? null;
}

export function createRoutineTools(client: SupabaseClient) {
  const list = defineTool({
    name: "routines.list", mcp: true, callers: ["user"],
    input: z.object({ taskId: UUID.optional().describe("One routine's id. Omit for all.") }),
    description: "List the workspace's routines with their full settings: instructions, agent, schedule, triggers, Slack and GitHub access, last run. Pass taskId for one. missingConnections names triggers or access that can't work until that provider is connected.",
    handler: async ({ caller, input }) => {
      const user = requireUser(caller, "routines.list");
      const routines = await (await scheduleService()).listRoutines(user.workspaceId, user.userId);
      if (!input.taskId) return { status: "ok", output: { routines } };
      const routine = routines.find((item) => item.id === input.taskId);
      return routine ? { status: "ok", output: { routine } } : refuse("not_found", "Routine not found.");
    },
  });

  const options = defineTool({
    name: "routines.options", mcp: true, callers: ["user"],
    input: z.object({}),
    description: "What a routine can be set to: triggers (and whether each one's provider is connected), schedule presets, agents and whether each can run, Slack channels and GitHub repos it can be given. Call before routines.create or update.",
    handler: async ({ caller }) => {
      const user = requireUser(caller, "routines.options");
      const svc = await scheduleService();
      const slackList = createSlackTools(client).find((tool) => tool.name === "slack.list_channels")!;
      const [connected, agents, slack, github] = await Promise.all([
        svc.listConnectedProviders(user.workspaceId),
        import("../../../routines/agent-status").then(({ routineAgentStatuses }) => routineAgentStatuses(client, user.workspaceId)),
        slackList.run(caller, {}).catch(() => null),
        import("./github").then(({ listWorkspaceGithubRepos }) => listWorkspaceGithubRepos(client, user.workspaceId)).catch(() => null),
      ]);
      return {
        status: "ok",
        output: {
          triggers: ROUTINE_TRIGGERS.map(({ event, provider, label }) => ({ event, provider, label, connected: connected.includes(provider) })),
          schedule: {
            presets: ROUTINE_PRESETS.map((preset) => ({ preset, meaning: PRESET_MEANINGS[preset] })),
            weekdays: ROUTINE_WEEKDAYS,
            time: "HH:MM, 24-hour, in `timezone` (an IANA zone such as America/New_York)",
            onSchedule: "false runs it only on its triggers and Run now; the schedule is kept for when it is turned back on",
          },
          agents: HARNESSES.filter((harness) => harness.routineModes.length > 0).map((harness) => ({
            harness: harness.id,
            status: agents[harness.id as keyof typeof agents] ?? "not_connected",
            models: harness.models.map((model) => ({ model: model.alias, label: model.label, reasoningEfforts: model.efforts, defaultReasoningEffort: model.defaultEffort })),
          })),
          access: {
            postChannels: "\"joined\" for any channel Draft's bot is in, or a list of channel names; null (update only) turns posting off",
            canNotify: "true lets it message teammates on Slack",
            github: "{ repos: [\"owner/repo\"], access: \"read\" | \"write\" }; write lets it open pull requests; null (update only) turns it off",
            slackChannels: slack?.status === "ok" ? slack.output : null,
            githubRepos: github,
          },
          notes: "A routine runs as the person who created it. An event run only sees a source that person can see; otherwise the run is recorded as skipped.",
        },
      };
    },
  });

  const create = defineTool({
    name: "routines.create", mcp: true, callers: ["user"], input: RoutineInput,
    description: "Create a routine. Call routines.options first for valid triggers, presets, agents, channels and repos. Answers with the saved routine.",
    handler: async ({ caller, input }) => {
      const user = requireUser(caller, "routines.create");
      try {
        const missing = await refuseMissingConnections(user.workspaceId, input);
        if (missing) return missing;
        const { validateCreate } = await import("../../../schedules/validate-create");
        const checked = validateCreate({ ...input, schedule: input.schedule });
        if (!checked.ok) return refuse("invalid_input", `Invalid routine field: ${checked.field}`);
        const { routineAgentProblem } = await import("../../../routines/agent-status");
        const agentProblem = await routineAgentProblem(client, user.workspaceId, checked.config.harness);
        if (agentProblem) return refuse(agentProblem.code, agentProblem.message);
        const created = await (await scheduleService()).createAgentRoutine(user.workspaceId, user.userId, checked);
        return { status: "ok", output: { routine: (await savedRoutine(user.workspaceId, user.userId, created.id)) ?? created } };
      } catch (error) { return runError(error, user.workspaceId, "routines.create"); }
    },
  });

  const update = defineTool({
    name: "routines.update", mcp: true, callers: ["user"], input: z.object({ taskId: UUID, patch: RoutinePatch }),
    description: "Change a routine. Send only the fields to change; schedule fields are flat. null turns Slack posting or GitHub access off; events: [] removes every trigger. Answers with the saved routine.",
    handler: async ({ caller, input }) => {
      const user = requireUser(caller, "routines.update");
      try {
        const svc = await scheduleService();
        const task = await svc.getRoutineTask(user.workspaceId, input.taskId);
        if (!task) return refuse("not_found", "Routine not found.");
        // Only what this change adds is checked, so editing the title of a routine with a lost connection still works.
        const missing = await refuseMissingConnections(user.workspaceId, input.patch);
        if (missing) return missing;
        const { validatePatch } = await import("../../../schedules/validate-patch");
        const config = task.task.task_type === "agent_routine" ? (await import("../../../routines/config")).parseAgentRoutineConfig(task.task.config_json) : null;
        const patch = validatePatch(input.patch, task.definition.editable, config);
        if (!patch.ok) return refuse(patch.error === "field_not_editable" ? "not_permitted" : "invalid_input", patch.field ?? "Invalid routine patch.");
        if (patch.patch.agent?.harness) {
          const { routineAgentProblem } = await import("../../../routines/agent-status");
          const agentProblem = await routineAgentProblem(client, user.workspaceId, patch.patch.agent.harness);
          if (agentProblem) return refuse(agentProblem.code, agentProblem.message);
        }
        const updated = await svc.updateRoutine(task, patch.patch, user.userId);
        return { status: "ok", output: { routine: (await savedRoutine(user.workspaceId, user.userId, input.taskId)) ?? updated } };
      } catch (error) { return runError(error, user.workspaceId, "routines.update"); }
    },
  });

  const remove = defineTool({
    name: "routines.delete", mcp: true, callers: ["user"], destructive: true, input: z.object({ taskId: UUID }),
    description: "Delete a routine. Confirm with the person first. Its past runs stay readable in the app.",
    handler: async ({ caller, input }) => {
      const user = requireUser(caller, "routines.delete");
      try {
        const svc = await scheduleService();
        const task = await svc.getRoutineTask(user.workspaceId, input.taskId);
        if (!task || task.task.task_type !== "agent_routine") return refuse("not_found", "Routine not found.");
        await svc.deleteRoutine(task, user.userId);
        return { status: "ok", output: { deleted: true } };
      } catch (error) { return runError(error, user.workspaceId, "routines.delete"); }
    },
  });

  const run = defineTool({
    name: "routines.run", mcp: true, callers: ["user"], input: z.object({ taskId: UUID }),
    description: "Start a run of a routine now. Answers with the run's id; poll routines.runs with that runId for its status and result. If a run is already in progress, this run is queued: it starts when that run ends, and the answer has queued: true and no runId.",
    handler: async ({ caller, input }) => {
      const user = requireUser(caller, "routines.run");
      try {
        const outcome = await (await scheduleService()).runRoutineNow(user.workspaceId, input.taskId, user.userId);
        if (outcome.status === "queued") return { status: "ok", output: { runId: null, queued: true, message: "Queued. It runs when the current run ends." } };
        if (outcome.status === "failed" && outcome.code === "routine_lease_busy") return refuse("codex_login_busy", "Another Codex run is using the login. Try again when it finishes.");
        if (outcome.status === "failed") return refuse(outcome.code, "The routine could not start.");
        return { status: "ok", output: { runId: outcome.sessionId, outcome } };
      } catch (error) {
        if (error instanceof Error && error.message === "not_found") return refuse("not_found", "Routine not found.");
        return runError(error, user.workspaceId, "routines.run", input.taskId);
      }
    },
  });

  const runs = defineTool({
    name: "routines.runs", mcp: true, callers: ["user"],
    input: z.object({
      taskId: UUID,
      runId: UUID.optional().describe("One run, however old. Omit for the newest runs."),
      cursor: z.string().max(200).optional().describe("Without runId: the nextCursor of the previous page, for older runs. With transcript: the transcript's nextCursor."),
      transcript: z.boolean().optional().describe("With runId: include the run's transcript, a page at a time."),
    }),
    description: "A routine's runs, newest first, 50 at a time: status, what started it (schedule, Run now or an event), result, and why a skipped run was skipped. Pass nextCursor back as cursor for older runs. Pass runId for one run; add transcript: true for what the agent did, in pages.",
    handler: async ({ caller, input }) => {
      const user = requireUser(caller, "routines.runs");
      try {
        const svc = await scheduleService();
        if (!input.runId) {
          const { parseCursor } = await import("../../../activity/service");
          const before = parseCursor(input.cursor);
          if (before === "invalid") return refuse("invalid_cursor", "That cursor isn't one this tool returned. Pass nextCursor from the previous page.");
          const page = await svc.listRoutineRuns(user.workspaceId, input.taskId, { before });
          return page ? { status: "ok", output: page } : refuse("not_found", "Routine not found.");
        }
        const page = await svc.listRoutineRuns(user.workspaceId, input.taskId, { runId: input.runId });
        if (!page) return refuse("not_found", "Routine not found.");
        const one = page.runs[0];
        if (!one) return refuse("not_found", "Run not found for this routine.");
        if (!input.transcript) return { status: "ok", output: { run: one } };
        const cursor = input.cursor ? Number(input.cursor) : 0;
        if (!Number.isInteger(cursor) || cursor < 0) return refuse("invalid_cursor", "A transcript cursor is the nextCursor number from the previous page.");
        const { readRunTranscript } = await import("../../../schedules/routine-run-detail");
        return { status: "ok", output: { run: one, transcript: await readRunTranscript(client, user.workspaceId, one.id, cursor) } };
      } catch (error) { return runError(error, user.workspaceId, "routines.runs"); }
    },
  });

  return [list, options, create, update, remove, run, runs];
}

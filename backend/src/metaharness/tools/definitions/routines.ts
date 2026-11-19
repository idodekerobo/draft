import type { SupabaseClient } from "@supabase/supabase-js";
import { HARNESSES } from "draft-core/harnesses";
import { ROUTINE_PRESETS, ROUTINE_TRIGGERS, ROUTINE_WEEKDAYS, RoutineInput, RoutineListFilter, RoutinePatch, routineProvidersForWhen } from "draft-core/routines";
import type { AgentRunSpec } from "draft-core/run-spec";
import { ANY_RUN, findToolPermission, type DraftToolLimits, type ToolCaller, type UserCallSurface } from "draft-core/tools";
import { z } from "zod";
import { recordError } from "../../../errors/record-error";
import { countRunToolCalls } from "../../../people/limits";
import { parseAgentRoutineConfig, type AgentRoutineConfig } from "../../../routines/config";
import { loadParentRoutine, MAX_PENDING_AGENT_ONE_SHOTS, pendingAgentOneShots, ROUTINE_MAX_DEPTH, runMayManage, runVisibility, widerAccess, type RoutineAccess } from "../../../routines/run-creator";
import { ROUTINE_CREATE_MAX_PER_RUN } from "../../../routines/run-spec";
import { personCreator, type RoutineCreator } from "../../../routines/creator";
import type { ResolvedWhen } from "../../../routines/when";
import { MIN_RUN_MADE_CRON_GAP_SECONDS, minCronGapSeconds, resolveWhen } from "../../../routines/when";
import type { ScheduledTaskRow } from "../../../types/tables";
import { defineTool, refuse, type ToolHandlerResult } from "../tool-registry";
import { createSlackTools } from "./slack";

const scheduleService = () => import("../../../routines/service");
const UUID = z.string().uuid();

/** Who a tool call acts for. A run acts for its owner, the person it works for. A run with no owner works for the workspace. */
type RoutineCaller =
  | { type: "user"; userId: string; workspaceId: string; via: UserCallSurface }
  | { type: "run"; run: AgentRunSpec; userId: string | null; workspaceId: string };

function resolveRoutineCaller(caller: ToolCaller): RoutineCaller {
  const { origin } = caller;
  if (origin.kind === "run") return { type: "run", run: origin.run, userId: caller.onBehalfOf, workspaceId: caller.workspaceId };
  return { type: "user", userId: origin.userId, workspaceId: caller.workspaceId, via: origin.via };
}

/** Where a failure is recorded. Only ids that exist are named, because the errors table checks them. */
interface Scope {
  scheduledTaskId?: string;
}

function scopeOf(actor: RoutineCaller): Scope {
  return actor.type === "run" && actor.run.trigger.type === "cron" ? { scheduledTaskId: actor.run.trigger.scheduledTaskId } : {};
}

const agentRunOf = (actor: RoutineCaller) =>(actor.type === "run" ? actor.run.id : undefined);

const noOwner = (action: string) => refuse("no_owner", `This run works for the whole workspace, not a person, so it can't ${action} routines.`);
const RUN_CHANGE_SCOPE = "This run can only change routines it or its own runs created.";

/** A forbidden caller is a refusal, and so is a user-facing service error. Anything else is unexpected, so it is recorded before the generic refusal. */
async function runError(error: unknown, workspaceId: string, tool: string, scheduledTaskId?: string, agentRunId?: string): Promise<ToolHandlerResult> {
  if (error instanceof Error && error.message === "forbidden") return refuse("not_permitted", "You can't change routines in this workspace.");
  const { ScheduleServiceError } = await scheduleService();
  if (error instanceof ScheduleServiceError) {
    if (error.code === "not_found") return refuse("not_found", "Routine not found.");
    if (error.code === "too_far_ahead" || error.code === "in_the_past" || error.code === "invalid_schedule") return refuse(error.code, error.message);
  }
  await recordError({ workspaceId, scheduledTaskId, agentRunId, operation: "execution", code: "routine_tool_failed", message: `${tool} failed`, detail: { tool }, error });
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
async function refuseMissingConnections(workspaceId: string, needed: string[]): Promise<ToolHandlerResult | null> {
  if (needed.length === 0) return null;
  const connected = await (await scheduleService()).listConnectedProviders(workspaceId);
  const missing = needed.filter((provider) => !connected.includes(provider));
  if (missing.length === 0) return null;
  return refuse(`${missing[0]}_not_connected`, `${missing.join(", ")} is not connected. Ask the person whether to connect it, then call connections.connect.`);
}

/** The routine as routines.list shows it, so a write answers with exactly what was stored. */
async function savedRoutine(workspaceId: string, callerId: string | undefined, taskId: string) {
  return (await (await scheduleService()).listRoutines(workspaceId, callerId)).find((routine) => routine.id === taskId) ?? null;
}

/** Shared routines, and the owner's own private ones. With no owner, only shared routines. */
/** Each run may start at most this many routines with routines.run. */
const ROUTINE_RUN_MAX_PER_RUN = 5;

/** A run's routine is private when the run came from private data, or when the routine that made the run is private. */
async function runCreatedVisibility(client: SupabaseClient, run: AgentRunSpec, parent: { task: ScheduledTaskRow } | null): Promise<"private" | "shared"> {
  if (parent?.task.visibility === "private") return "private";
  return (await runVisibility(client, run.id)) === "private" ? "private" : "shared";
}

/** The guards on a when a run sets. A one-shot that becomes pending counts against the cap; a cron may not run more than hourly. */
async function runWhenRefusal(client: SupabaseClient, workspaceId: string, when: ResolvedWhen, now: Date, becomesPending: boolean): Promise<ToolHandlerResult | null> {
  if (when.kind === "once") {
    if (becomesPending && (await pendingAgentOneShots(client, workspaceId)) >= MAX_PENDING_AGENT_ONE_SHOTS) {
      return refuse("too_many_pending", `This workspace has ${MAX_PENDING_AGENT_ONE_SHOTS} pending routines made by agents. Wait for some to run, or delete ones you no longer need.`);
    }
    return null;
  }
  if (when.schedule && minCronGapSeconds(when.schedule.cron, when.schedule.timezone, now) < MIN_RUN_MADE_CRON_GAP_SECONDS) {
    return refuse("too_frequent", "Routines made by an agent can run at most once an hour.");
  }
  return null;
}

/** The access a patch gives: only the settings it sends, so a stored setting the run didn't touch never counts. */
function givenAccess(patch: RoutinePatch, agent: AgentRoutineConfig | undefined): RoutineAccess {
  if (!agent) return {};
  return {
    ...(patch.canNotify !== undefined ? { canNotify: agent.canNotify } : {}),
    ...(patch.postChannels !== undefined ? { postChannels: agent.postChannels } : {}),
    ...(patch.github !== undefined ? { github: agent.github } : {}),
  };
}

/** A part of the options answer that may be unavailable. Its failure is recorded, and the part reads as null. */
async function optionalPart<T>(workspaceId: string, part: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    await recordError({ workspaceId, operation: "read", code: "routine_options_part_failed", message: `routines.options could not read ${part}`, detail: { part }, error });
    return null;
  }
}

/**
 * Saves a routine for a person, or for a run's owner. A run's guards run first, and the settings it leaves out
 * come from its routine. Model and effort are copied only when the harness is the routine's, since they belong to one harness.
 */
async function createRoutine(client: SupabaseClient, actor: RoutineCaller, input: RoutineInput, scope: Scope, now: Date): Promise<ToolHandlerResult> {
  const owner = actor.userId;
  if (!owner) return noOwner("create");
  const run = actor.type === "run" ? actor.run : null;
  const parent = run ? await loadParentRoutine(client, run) : null;
  scope.scheduledTaskId = parent?.task.id ?? scope.scheduledTaskId;

  const depth = run ? (parent?.task.trigger_depth ?? 0) + 1 : 0;
  if (run && depth > ROUTINE_MAX_DEPTH) return refuse("depth_limit", "Routines can nest 3 levels deep. This run is at level 3, so it can't create another routine.");
  if (run) {
    const max = (findToolPermission(run, "routines.create")?.limits as DraftToolLimits["routines.create"] | undefined)?.maxPerRun ?? ROUTINE_CREATE_MAX_PER_RUN;
    if ((await countRunToolCalls(client, run.id, "routines.create")) >= max) {
      return refuse("limit_reached", `This run has created ${max} routines, its limit. Finish the work now, or say in your result what is left.`);
    }
  }

  const from = parent?.config;
  const harness = input.harness ?? from?.harness;
  if (!harness) return refuse("invalid_input", "harness is required.");
  const inherit = from && harness === from.harness ? from : undefined;
  const model = input.model !== undefined ? input.model : inherit?.model;
  const reasoningEffort = input.reasoningEffort !== undefined ? input.reasoningEffort : inherit && model === inherit.model ? inherit.reasoningEffort : undefined;

  const { validateCreate } = await import("../../../routines/validate-create");
  const checked = validateCreate({
    ...input,
    harness,
    ...(model !== undefined ? { model } : {}),
    reasoningEffort,
    canNotify: input.canNotify ?? from?.canNotify,
    postChannels: input.postChannels ?? from?.postChannels,
    github: input.github ?? from?.github,
  });
  if (!checked.ok) return refuse("invalid_input", `Invalid routine field: ${checked.field}`);
  const config = inherit?.toolset ? { ...checked.config, toolset: inherit.toolset } : checked.config;

  const missing = await refuseMissingConnections(actor.workspaceId, routineProvidersForWhen(checked.when, config));
  if (missing) return missing;
  const { routineAgentProblem } = await import("../../../routines/agent-status");
  const agentProblem = await routineAgentProblem(client, actor.workspaceId, config.harness);
  if (agentProblem) return refuse(agentProblem.code, agentProblem.message);

  if (run) {
    const setting = widerAccess(from ?? null, config);
    if (setting) return refuse("not_permitted", `This run can't give a routine access it doesn't have itself: ${setting}.`);
  }
  const resolved = resolveWhen(checked.when, now);
  if (!resolved.ok) return refuse(resolved.code, resolved.message);
  if (run) {
    const refusal = await runWhenRefusal(client, actor.workspaceId, resolved.value, now, true);
    if (refusal) return refusal;
  }

  const creator: RoutineCreator = actor.type === "user"
    ? personCreator(owner, actor.via)
    : { userId: owner, via: "run", runId: actor.run.id, depth, visibility: await runCreatedVisibility(client, actor.run, parent) };
  const created = await (await scheduleService()).createAgentRoutine(actor.workspaceId, creator, { config, when: checked.when, enabled: checked.enabled });
  return { status: "ok", output: { routine: (await savedRoutine(actor.workspaceId, actor.userId ?? undefined, created.id)) ?? created } };
}

export function createRoutineTools(client: SupabaseClient) {
  const list = defineTool({
    name: "routines.list", mcp: true, allowedOrigins: ["person", ...ANY_RUN], input: RoutineListFilter,
    description: "List the workspace's routines with their full settings: instructions, agent, schedule, triggers, Slack and GitHub access, last run. Pass taskId for one. missingConnections names triggers or access that can't work until that provider is connected. One-shots are hidden unless kind: \"once\". Filter with status and createdBy.",
    handler: async ({ caller, input }) => {
      const actor = resolveRoutineCaller(caller);
      try {
        const routines = await (await scheduleService()).listRoutines(actor.workspaceId, actor.userId ?? undefined, input);
        if (!input.taskId) return { status: "ok", output: { routines } };
        const routine = routines.find((item) => item.id === input.taskId);
        return routine ? { status: "ok", output: { routine } } : refuse("not_found", "Routine not found.");
      } catch (error) { return runError(error, actor.workspaceId, "routines.list", undefined, agentRunOf(actor)); }
    },
  });

  const options = defineTool({
    name: "routines.options", mcp: true, allowedOrigins: ["person"],
    input: z.object({}),
    description: "What a routine can be set to: triggers (and whether each one's provider is connected), schedule presets, agents and whether each can run, Slack channels and GitHub repos it can be given. Call before routines.create or update.",
    handler: async ({ caller }) => {
      const actor = resolveRoutineCaller(caller);
      try {
        const svc = await scheduleService();
        const slackList = createSlackTools(client).find((tool) => tool.name === "slack.list_channels")!;
        const [connected, agents, slack, github] = await Promise.all([
          svc.listConnectedProviders(actor.workspaceId),
          import("../../../routines/agent-status").then(({ routineAgentStatuses }) => routineAgentStatuses(client, actor.workspaceId)),
          optionalPart(actor.workspaceId, "Slack channels", () => slackList.run(caller, {})),
          optionalPart(actor.workspaceId, "GitHub repos", () => import("./github").then(({ listWorkspaceGithubRepos }) => listWorkspaceGithubRepos(client, actor.workspaceId))),
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
      } catch (error) { return runError(error, actor.workspaceId, "routines.options"); }
    },
  });

  const create = defineTool({
    name: "routines.create", mcp: true, allowedOrigins: ["person", ...ANY_RUN], input: RoutineInput,
    description: "Create a routine: work Draft runs later. `when` is once (`{in:\"2h\"}` or `{at: ISO}`, at most 365 days ahead), a schedule (`{schedule:{preset…}|{cron,timezone}}`), events (`{events:[…]}`), or a schedule plus events. Use it for follow-ups ('check back in 2 hours') and for recurring work. `prompt` must be a self-contained brief: what to do, why, and what done means. The run that fires can't see this conversation. From a run, settings you leave out are copied from your routine. Call routines.options (people only) for presets and triggers. Answers with the saved routine.",
    handler: async ({ caller, input }) => {
      const actor = resolveRoutineCaller(caller);
      const scope = scopeOf(actor);
      try {
        return await createRoutine(client, actor, input, scope, new Date());
      } catch (error) { return runError(error, actor.workspaceId, "routines.create", scope.scheduledTaskId, agentRunOf(actor)); }
    },
  });

  const update = defineTool({
    name: "routines.update", mcp: true, allowedOrigins: ["person", ...ANY_RUN], input: z.object({ taskId: UUID, patch: RoutinePatch }),
    description: "Change a routine. Send only the fields to change. Send `when` to reschedule; a schedule is sent whole, e.g. `{schedule:{preset:'daily',time:'09:00',timezone:'UTC'}}`. A fired one-shot given a new `when` runs again. null turns Slack posting or GitHub access off; `when.events: []` removes every trigger. A run can change only routines its own runs made. Answers with the saved routine.",
    handler: async ({ caller, input }) => {
      const actor = resolveRoutineCaller(caller);
      const scope = scopeOf(actor);
      try {
        const owner = actor.userId;
        if (!owner) return noOwner("change");
        const now = new Date();
        const svc = await scheduleService();
        const task = await svc.getRoutineTask(actor.workspaceId, input.taskId, undefined, owner);
        if (!task) return refuse("not_found", "Routine not found.");
        scope.scheduledTaskId = task.task.id;
        if (actor.type === "run" && !(await runMayManage(client, actor.run, task.task))) return refuse("not_permitted", RUN_CHANGE_SCOPE);
        // Only what this change adds is checked, so editing the title of a routine with a lost connection still works.
        const missing = await refuseMissingConnections(actor.workspaceId, routineProvidersForWhen(input.patch.when ?? {}, input.patch));
        if (missing) return missing;
        const { validatePatch } = await import("../../../routines/validate-patch");
        const config = task.task.task_type === "agent_routine" ? parseAgentRoutineConfig(task.task.config_json) : null;
        const patch = validatePatch(input.patch, task.definition.editable, config);
        if (!patch.ok) return refuse(patch.error === "field_not_editable" ? "not_permitted" : "invalid_input", patch.field ?? "Invalid routine patch.");
        if (patch.patch.agent?.harness) {
          const { routineAgentProblem } = await import("../../../routines/agent-status");
          const agentProblem = await routineAgentProblem(client, actor.workspaceId, patch.patch.agent.harness);
          if (agentProblem) return refuse(agentProblem.code, agentProblem.message);
        }
        if (actor.type === "run") {
          const setting = widerAccess((await loadParentRoutine(client, actor.run))?.config ?? null, givenAccess(input.patch, patch.patch.agent));
          if (setting) return refuse("not_permitted", `This run can't give a routine access it doesn't have itself: ${setting}.`);
        }
        if (patch.patch.when) {
          const resolved = resolveWhen(patch.patch.when, now);
          if (!resolved.ok) return refuse(resolved.code, resolved.message);
          if (actor.type === "run") {
            const refusal = await runWhenRefusal(client, actor.workspaceId, resolved.value, now, resolved.value.kind === "once" && task.task.fired_at != null);
            if (refusal) return refusal;
          }
        }
        const updated = await svc.updateRoutine(task, patch.patch, owner, now, { via: actor.type === "run" ? "run" : actor.via });
        return { status: "ok", output: { routine: (await savedRoutine(actor.workspaceId, owner, input.taskId)) ?? updated } };
      } catch (error) { return runError(error, actor.workspaceId, "routines.update", scope.scheduledTaskId, agentRunOf(actor)); }
    },
  });

  const remove = defineTool({
    name: "routines.delete", mcp: true, allowedOrigins: ["person", ...ANY_RUN], destructive: true, input: z.object({ taskId: UUID }),
    description: "Delete a routine. Confirm with the person first. Its past runs stay readable in the app. A run can delete only routines its own runs made.",
    handler: async ({ caller, input }) => {
      const actor = resolveRoutineCaller(caller);
      const scope = scopeOf(actor);
      try {
        const owner = actor.userId;
        if (!owner) return noOwner("delete");
        const svc = await scheduleService();
        const task = await svc.getRoutineTask(actor.workspaceId, input.taskId, undefined, owner);
        if (!task || task.task.task_type !== "agent_routine") return refuse("not_found", "Routine not found.");
        scope.scheduledTaskId = task.task.id;
        if (actor.type === "run" && !(await runMayManage(client, actor.run, task.task))) return refuse("not_permitted", RUN_CHANGE_SCOPE);
        await svc.deleteRoutine(task, owner, new Date(), { via: actor.type === "run" ? "run" : actor.via });
        return { status: "ok", output: { deleted: true } };
      } catch (error) { return runError(error, actor.workspaceId, "routines.delete", scope.scheduledTaskId, agentRunOf(actor)); }
    },
  });

  const run = defineTool({
    name: "routines.run", mcp: true, allowedOrigins: ["person", ...ANY_RUN], input: z.object({ taskId: UUID }),
    description: "Start a run of a routine now. Answers with the run's session id; poll routines.runs with that sessionId for its status and result. If a run is already in progress, this run is queued: it starts when that run ends, and the answer has queued: true and no sessionId.",
    handler: async ({ caller, input }) => {
      const actor = resolveRoutineCaller(caller);
      try {
        const owner = actor.userId;
        if (!owner) return noOwner("run");
        const svc = await scheduleService();
        if (actor.type === "run") {
          // A run starting its own routine would loop forever; a follow-up belongs in a one-shot.
          if ((await loadParentRoutine(client, actor.run))?.task.id === input.taskId) {
            return refuse("not_permitted", "A run can't start its own routine again. To follow up later, create a one-shot with routines.create and when {in: \"2h\"}.");
          }
          const max = (findToolPermission(actor.run, "routines.run")?.limits as { maxPerRun?: number } | undefined)?.maxPerRun ?? ROUTINE_RUN_MAX_PER_RUN;
          if ((await countRunToolCalls(client, actor.run.id, "routines.run")) >= max) {
            return refuse("limit_reached", `This run has already started ${max} routines, the most one run can.`);
          }
        }
        const outcome = await svc.runRoutineNow(actor.workspaceId, input.taskId, owner, { attribution: { via: actor.type === "run" ? "run" : actor.via } });
        if (outcome.status === "queued") return { status: "ok", output: { sessionId: null, queued: true, message: "Queued. It runs when the current run ends." } };
        if (outcome.status === "failed" && outcome.code === "routine_lease_busy") return refuse("codex_login_busy", "Another Codex run is using the login. Try again when it finishes.");
        if (outcome.status === "failed") return refuse(outcome.code, "The routine could not start.");
        return { status: "ok", output: { sessionId: outcome.sessionId, outcome } };
      } catch (error) {
        if (error instanceof Error && error.message === "not_found") return refuse("not_found", "Routine not found.");
        return runError(error, actor.workspaceId, "routines.run", input.taskId, agentRunOf(actor));
      }
    },
  });

  const runs = defineTool({
    name: "routines.runs", mcp: true, allowedOrigins: ["person", ...ANY_RUN],
    input: z.object({
      taskId: UUID,
      sessionId: UUID.optional().describe("The session id of one run, however old. Omit for the newest runs."),
      cursor: z.string().max(200).optional().describe("Without sessionId: the nextCursor of the previous page, for older runs. With transcript: the transcript's nextCursor."),
      transcript: z.boolean().optional().describe("With sessionId: include the run's transcript, a page at a time."),
    }),
    description: "A routine's runs, newest first, 50 at a time: status, what started it (schedule, Run now or an event), result, and why a skipped run was skipped. Pass nextCursor back as cursor for older runs. Pass sessionId for one run; add transcript: true for what the agent did, in pages.",
    handler: async ({ caller, input }) => {
      const actor = resolveRoutineCaller(caller);
      try {
        const svc = await scheduleService();
        if (!input.sessionId) {
          const { parseCursor } = await import("../../../activity/service");
          const before = parseCursor(input.cursor);
          if (before === "invalid") return refuse("invalid_cursor", "That cursor isn't one this tool returned. Pass nextCursor from the previous page.");
          const page = await svc.listRoutineRuns(actor.workspaceId, input.taskId, { before, viewerId: actor.userId });
          return page ? { status: "ok", output: page } : refuse("not_found", "Routine not found.");
        }
        const page = await svc.listRoutineRuns(actor.workspaceId, input.taskId, { sessionId: input.sessionId, viewerId: actor.userId });
        if (!page) return refuse("not_found", "Routine not found.");
        const one = page.runs[0];
        if (!one) return refuse("not_found", "Run not found for this routine.");
        if (!input.transcript) return { status: "ok", output: { run: one } };
        const cursor = input.cursor ? Number(input.cursor) : 0;
        if (!Number.isInteger(cursor) || cursor < 0) return refuse("invalid_cursor", "A transcript cursor is the nextCursor number from the previous page.");
        const { readRunTranscript } = await import("../../../routines/run-detail");
        return { status: "ok", output: { run: one, transcript: await readRunTranscript(client, actor.workspaceId, one.id, cursor) } };
      } catch (error) { return runError(error, actor.workspaceId, "routines.runs", undefined, agentRunOf(actor)); }
    },
  });

  return [list, options, create, update, remove, run, runs];
}

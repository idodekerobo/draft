import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineStep } from "draft-core/routine-steps";
import { runCaller, type AnyDraftToolPermission } from "draft-core/tools";
import { loadVersionDocuments } from "../metaharness/context/context-store";
import { specFromRow } from "../metaharness/runs/agent-run-store";
import { currentDocumentPaths } from "./workflow/context-documents";
import { stepFiles } from "./workflow/step-files";
import { TEXT_STEP_SCHEMA } from "./workflow/step-run-spec";
import type { ParentRun, StepOutputs, WorkflowKind } from "./workflow/types";
import { needsDraftToolServer } from "../metaharness/sandbox/run-manifest";
import { buildRoutineBundle, renderRoutinePrompt, type RoutinePromptStart } from "./build-bundle";
import { endRoutineSession, failRoutineSession, type RoutineSessionRef } from "./fail-routine-session";

const UNSTABLE_PREFIX = "memory/";
const NOTE_MAX_CHARS = 600;

/** What the run of a custom routine keeps on its own row, next to its steps, to word its prompts. */
export interface RoutineRunExtras {
  routine: { title: string; setup: string; timezone: string };
  startedAt: string;
  startedBy: RoutinePromptStart;
}

const extrasOf = (parent: ParentRun): RoutineRunExtras => parent.result_json as unknown as RoutineRunExtras;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const clip = (text: string): string => (text.length > NOTE_MAX_CHARS ? `${text.slice(0, NOTE_MAX_CHARS)}…` : text);

/** What a step said: the text of a text step, or the summary a structured step gave. */
function answerOf(result: unknown): string {
  if (!isObject(result)) return "";
  if (typeof result.text === "string") return result.text;
  if (typeof result.summary === "string") return result.summary;
  return JSON.stringify(result);
}

async function sessionOf(client: SupabaseClient, parent: ParentRun): Promise<RoutineSessionRef | null> {
  if (!parent.session_id) return null;
  const { data, error } = await client.from("sessions").select("id, workspace_id, scheduled_task_id, host_id").eq("id", parent.session_id).maybeSingle();
  if (error) throw error;
  return (data as RoutineSessionRef | null) ?? null;
}

/** Puts what each step said into the routine's session, so the session view and `routines.runs` show it. The last step's answer is the run's result. */
async function writeStepSummaries(client: SupabaseClient, session: RoutineSessionRef, steps: ReadonlyArray<RoutineStep>, outputs: StepOutputs): Promise<void> {
  const events = steps.flatMap((step, index) => {
    const runs = outputs[step.key] ?? [];
    if (runs.length === 0) return [];
    const answers = runs.map((entry) => answerOf(entry.result)).filter(Boolean);
    const last = index === steps.length - 1;
    return last && answers.length === 1
      ? [{ source_id: `step:${step.key}:result`, kind: "assistant_text", payload: { text: answers[0] } }]
      : [{ source_id: `step:${step.key}:summary`, kind: "session_note", payload: { text: clip(`Step ${step.key}: ${answers.join(" | ") || "done"}`) } }];
  });
  if (events.length === 0) return;
  const { error } = await client.rpc("append_session_events", { p_session_id: session.id, p_workspace_id: session.workspace_id, p_host_id: session.host_id, p_events: events });
  // A late write to a session that already ended is not an error.
  if (error && !error.message.includes("session_ended")) throw error;
}

/** A custom routine's steps. The routine's own permissions, tools and network are the most any step may have. */
export const routineWorkflow: WorkflowKind = {
  kind: "routine",
  routinePermissions: async ({ parent }) => parent.permissions as unknown as AnyDraftToolPermission[],
  environment: async ({ parent }) => {
    const spec = specFromRow(parent);
    return { toolset: spec.toolset, computer: spec.computer, model: spec.model };
  },

  async plan({ client, parent, step }) {
    if (step.fanOut.over === "context_documents") {
      // A custom routine has no capture entries, so "with new evidence" has no meaning. Both filters check every stable document.
      const paths = (await currentDocumentPaths(client, parent.workspace_id)).filter((path) => !path.startsWith(UNSTABLE_PREFIX));
      return paths.map((path) => ({ item: { key: `doc:${path}`, type: "document" as const, path } }));
    }
    return [{ item: { key: "run", type: "none" as const } }];
  },

  async prepareRun({ client, parent, step, run, outputs }) {
    const spec = specFromRow(run);
    const { data, error } = await client.from("workspaces").select("organization_id").eq("id", parent.workspace_id).single();
    if (error) throw error;
    const documents = await loadVersionDocuments(client, run.base_context_version_id);
    const extraFiles = stepFiles(outputs);
    const bundle = buildRoutineBundle({ organizationId: (data as { organization_id: string }).organization_id, workspaceId: parent.workspace_id, agentRunId: run.id, audience: runCaller(spec), documents, extraFiles });

    const extras = extrasOf(parent);
    const item = run.step_item;
    const earlier = Object.keys(extraFiles);
    const stepNote = [
      `## This step: ${step.key}`,
      "You are one step of the routine. Do only this step.",
      ...(item?.type === "document" ? [`Work on this document: input/context/${String(item.path)}`] : []),
      ...(earlier.length ? ["The earlier steps left their answers in these files:", ...earlier.map((path) => `- ${path}`)] : []),
      step.output.type === "text"
        ? 'Reply with a JSON object with your answer in the "text" field.'
        : "Reply with a JSON object that matches the required schema, and nothing else.",
    ].join("\n");
    const prompt = renderRoutinePrompt(`${step.prompt.trim()}\n\n${stepNote}`, {
      title: extras.routine.title,
      setup: extras.routine.setup,
      timezone: extras.routine.timezone,
      startedAt: new Date(extras.startedAt),
      hasDraftTools: needsDraftToolServer(spec),
      startedBy: extras.startedBy,
    });
    return { bundle, prompt };
  },

  async finish({ client, parent, steps, outputs }) {
    const session = await sessionOf(client, parent);
    if (!session) return;
    await writeStepSummaries(client, session, steps, outputs);
    // Ending the session ends the run that belongs to it.
    await endRoutineSession(client, session, "completed");
  },

  async fail({ client, parent, code, reason }) {
    const session = await sessionOf(client, parent);
    if (!session) return false;
    return failRoutineSession(client, session, {
      code: "routine_run_failed",
      note: "A step of the routine did not finish, so the run was stopped.",
      message: `Routine run failed: ${reason}`,
      detail: { failure_code: code },
    });
  },
};

export { TEXT_STEP_SCHEMA };

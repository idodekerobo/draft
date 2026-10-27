import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateSandboxCallbackRequest } from "../sandbox";
import { eventsFor, isIncomingLine, type IncomingLine } from "../ingestion/claude-code/live-lines";
import { parseLiveLine } from "../ingestion/claude-code/parse-live-line";
import { recordError } from "../errors/record-error";
import type { SessionRow } from "../types/tables";
import { parseAgentRoutineConfig, parseRoutineSessionId } from "./config";
import { failRoutineSession } from "./fail-routine-session";

const MAX_LINES_PER_POST = 2000;
const SESSION_COLUMNS = "id, workspace_id, session_type, status, last_seq, host_machine_id, scheduled_task_id";

type RoutineSession = Pick<SessionRow, "id" | "workspace_id" | "session_type" | "status" | "last_seq" | "host_machine_id" | "scheduled_task_id">;

const FAILURE_NOTES: Record<string, string> = {
  timeout: "The run took too long and was stopped.",
  claude_error: "The agent reported an error.",
  claude_exit: "The agent stopped before it finished.",
  incomplete_result: "The agent stopped without a final answer.",
  bundle_fetch_failed: "The run could not load the company brain.",
  runner_error: "The run could not start.",
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The prompt is not part of the agent's output, so the first batch carries it as the opening message. */
async function promptEvent(client: SupabaseClient, session: RoutineSession) {
  const { data, error } = await client
    .from("scheduled_tasks")
    .select("config_json")
    .eq("id", session.scheduled_task_id)
    .eq("workspace_id", session.workspace_id)
    .maybeSingle();
  if (error) throw error;
  const config = parseAgentRoutineConfig((data as { config_json: unknown } | null)?.config_json);
  if (!config) return [];
  const line = { file: "root.jsonl", offset: -1, raw: JSON.stringify({ type: "user", uuid: `routine-prompt:${session.id}`, message: { role: "user", content: config.prompt } }) };
  return parseLiveLine(line);
}

async function appendLines(client: SupabaseClient, session: RoutineSession, lines: IncomingLine[]): Promise<Response> {
  const parsed = lines.flatMap(eventsFor);
  const events = [...(session.last_seq === 0 ? await promptEvent(client, session) : []), ...parsed]
    .map((event) => ({ source_id: event.sourceId, kind: event.kind, payload: event.payload }));
  if (events.length === 0) return new Response(null, { status: 204 });

  const { error } = await client.rpc("append_session_events", {
    p_session_id: session.id,
    p_workspace_id: session.workspace_id,
    p_host_machine_id: session.host_machine_id,
    p_events: events,
  });
  // A late batch for a session the tick already failed is not an error.
  if (error?.message.includes("session_ended")) return new Response(null, { status: 204 });
  if (error) throw error;
  return new Response(null, { status: 204 });
}

async function finishRun(client: SupabaseClient, session: RoutineSession, result: Record<string, unknown>): Promise<Response> {
  if (result.ok === true) {
    await client
      .from("sessions")
      .update({ status: "ended", ended_at: new Date().toISOString(), end_reason: "completed", open_approval_count: 0 })
      .eq("id", session.id)
      .eq("workspace_id", session.workspace_id)
      .neq("status", "ended");
    return new Response(null, { status: 204 });
  }
  const code = typeof result.error === "string" && result.error in FAILURE_NOTES ? result.error : "runner_error";
  await failRoutineSession(client, session, {
    code: "routine_run_failed",
    note: FAILURE_NOTES[code]!,
    message: `Routine run failed: ${code}`,
    detail: { failure_code: code, diagnostics: isObject(result.diagnostics) ? result.diagnostics : null },
  });
  return new Response(null, { status: 204 });
}

/**
 * Receives what a routine runner sends: batches of stream-json lines while it runs,
 * then one final message. The token proves the sender is the machine for this one session.
 */
export async function completeRoutineRunCallback(
  request: Request,
  callbackSecret: string,
  client?: SupabaseClient,
): Promise<Response> {
  const db = client ?? (await import("../db/client")).serviceClient;
  const authenticated = await authenticateSandboxCallbackRequest(request, callbackSecret);
  const sessionId = parseRoutineSessionId(authenticated.runId);
  if (!sessionId) return new Response(null, { status: 404 });

  const { data, error } = await db.from("sessions").select(SESSION_COLUMNS).eq("id", sessionId).maybeSingle();
  if (error) throw error;
  const session = data as RoutineSession | null;
  if (!session || session.session_type !== "routine") return new Response(null, { status: 404 });
  if (session.status === "ended") return new Response(null, { status: 204 });

  const result = authenticated.result;
  try {
    if (isObject(result) && result.kind === "lines" && Array.isArray(result.lines)) {
      if (result.lines.length > MAX_LINES_PER_POST || !result.lines.every(isIncomingLine)) return new Response(null, { status: 400 });
      return await appendLines(db, session, result.lines as IncomingLine[]);
    }
    if (isObject(result) && result.kind === "end") return await finishRun(db, session, result);
    return new Response(null, { status: 400 });
  } catch (callbackError) {
    await recordError({
      client: db,
      workspaceId: session.workspace_id,
      sessionId: session.id,
      scheduledTaskId: session.scheduled_task_id,
      operation: "session",
      message: "Routine callback failed",
      code: "routine_callback_failed",
      error: callbackError,
    });
    return new Response(null, { status: 500 });
  }
}

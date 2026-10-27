import { withAuth } from "../auth/withAuth";
import { serviceClient } from "../db/client";
import { recordError } from "../errors/record-error";
import { MAX_INPUT_CHARS, deliveredText } from "draft-core/live-sessions";
import { cleanInputText, sameText } from "../ingestion/claude-code/live-input-text";
import type { SessionEventRow, SessionInputRow, SessionInputState } from "../types/tables";
import { authorName, authorize, errorResponse, knownDbError, loadOwnedSession, optionalString, readBody } from "./sessions-live-shared";

type InputsRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/inputs">;
type PendingRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/inputs/pending">;
type InputRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/inputs/:inputId">;
type InputStateRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/inputs/:inputId/state">;

const INPUT_COLUMNS = "id, author_user_id, author_name, kind, payload, state, reason, consumed_seq, created_at, updated_at";
const VIEWER_LIMIT = 20;
const REASON_MAX_CHARS = 100;
const HOST_TARGET_STATES = new Set<SessionInputState>(["queued", "delivering", "failed", "uncertain", "consumed"]);
const HOST_SOURCE_STATES = new Set<SessionInputState>(["queued", "delivering"]);

type PublicInput = {
  id: string;
  author_user_id: string;
  author_name: string;
  kind: SessionInputRow["kind"];
  text: string;
  state: SessionInputState;
  reason: string | null;
  created_at: string;
  updated_at: string;
};

const textOf = (row: Pick<SessionInputRow, "payload">) => (typeof row.payload.text === "string" ? row.payload.text : "");

function publicInput(row: SessionInputRow): PublicInput {
  return {
    id: row.id,
    author_user_id: row.author_user_id,
    author_name: row.author_name,
    kind: row.kind,
    text: textOf(row),
    state: row.state,
    reason: row.reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function createInput(workspaceId: string, sessionId: string, userId: string, text: string): Promise<Response> {
  const { data, error } = await serviceClient.rpc("create_session_input", {
    p_session_id: sessionId,
    p_workspace_id: workspaceId,
    p_author_user_id: userId,
    p_author_name: await authorName(userId),
    p_kind: "message",
    p_payload: { text },
  });
  if (error) {
    return knownDbError(error.message) ?? errorResponse("input_create_failed", 500, error, workspaceId, sessionId);
  }
  return Response.json({ ok: true, input: publicInput(data as SessionInputRow) }, { status: 201 });
}

export type ViewerInputs = { ok: true; inputs: Array<ReturnType<typeof publicInput> & { mine: boolean }> } | { ok: false; error: unknown };

/** The caller's messages that Claude has not yet taken, plus those of teammates. */
export async function loadViewerInputs(workspaceId: string, sessionId: string, userId: string): Promise<ViewerInputs> {
  const { data, error } = await serviceClient
    .from("session_inputs")
    .select(INPUT_COLUMNS)
    .eq("session_id", sessionId)
    .eq("workspace_id", workspaceId)
    .eq("kind", "message")
    .in("state", ["queued", "delivering", "failed", "uncertain"])
    .is("dismissed_at", null)
    .order("created_at", { ascending: true })
    .limit(VIEWER_LIMIT);
  if (error) return { ok: false, error };
  return { ok: true, inputs: ((data ?? []) as SessionInputRow[]).map((row) => ({ ...publicInput(row), mine: row.author_user_id === userId })) };
}

export const INPUTS_LIST = withAuth<InputsRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const denied = await authorize(workspaceId, caller.userId);
  if (denied) return denied;

  const loaded = await loadViewerInputs(workspaceId, sessionId, caller.userId);
  if (!loaded.ok) return errorResponse("inputs_lookup_failed", 500, loaded.error, workspaceId, sessionId);
  return Response.json({ inputs: loaded.inputs });
});

export const INPUTS_CREATE = withAuth<InputsRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const denied = await authorize(workspaceId, caller.userId);
  if (denied) return denied;

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;

  const text = typeof parsed.body.text === "string" ? cleanInputText(parsed.body.text) : "";
  if (!text) return errorResponse("empty_message", 400);
  if (text.length > MAX_INPUT_CHARS) return errorResponse("message_too_long", 400);

  return createInput(workspaceId, sessionId, caller.userId, text);
});

export const INPUT_ACTION = withAuth<InputRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId, inputId } = req.params;
  const denied = await authorize(workspaceId, caller.userId);
  if (denied) return denied;

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  const action = parsed.body.action;
  if (action !== "resend" && action !== "dismiss") return errorResponse("invalid_action", 400);

  const { data: dismissed, error } = await serviceClient
    .from("session_inputs")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", inputId)
    .eq("session_id", sessionId)
    .eq("workspace_id", workspaceId)
    .eq("author_user_id", caller.userId)
    .eq("kind", "message")
    .in("state", ["failed", "uncertain"])
    .is("dismissed_at", null)
    .select(INPUT_COLUMNS);
  if (error) return errorResponse("input_update_failed", 500, error, workspaceId, sessionId);
  const old = ((dismissed ?? []) as SessionInputRow[])[0];
  if (!old) return errorResponse("input_not_actionable", 409);
  if (action === "dismiss") return Response.json({ ok: true });

  const created = await createInput(workspaceId, sessionId, caller.userId, textOf(old));
  if (!created.ok) {
    await serviceClient.from("session_inputs").update({ dismissed_at: null }).eq("id", inputId);
  }
  return created;
});

export const INPUTS_PENDING = withAuth<PendingRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const denied = await authorize(workspaceId, caller.userId);
  if (denied) return denied;

  const owned = await loadOwnedSession(workspaceId, sessionId, caller.userId);
  if (!owned.ok) return owned.response;
  const params = new URL(req.url).searchParams;
  if (params.get("hostMachineId") !== owned.session.host_machine_id) return errorResponse("foreign_host", 403);

  const everything = params.get("kinds") === "all";
  let query = serviceClient
    .from("session_inputs")
    .select(INPUT_COLUMNS)
    .eq("session_id", sessionId)
    .eq("workspace_id", workspaceId)
    .in("state", ["queued", "delivering"])
    .order("created_at", { ascending: true })
    .limit(VIEWER_LIMIT);
  if (!everything) query = query.eq("kind", "message");
  const { data, error } = await query;
  if (error) return errorResponse("inputs_lookup_failed", 500, error, workspaceId, sessionId);

  const inputs = ((data ?? []) as SessionInputRow[]).map((row) => ({
    ...publicInput(row),
    payload: row.payload,
    ...(row.kind === "message" ? { delivered_text: deliveredText(row.author_name, textOf(row)) } : {}),
  }));
  return Response.json({ inputs });
});

export const INPUT_STATE = withAuth<InputStateRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId, inputId } = req.params;
  const denied = await authorize(workspaceId, caller.userId);
  if (denied) return denied;

  const owned = await loadOwnedSession(workspaceId, sessionId, caller.userId);
  if (!owned.ok) return owned.response;

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  const { body } = parsed;
  if (optionalString(body.hostMachineId, 200) !== owned.session.host_machine_id) return errorResponse("foreign_host", 403);

  const to = body.to as SessionInputState;
  const from = body.from;
  if (!HOST_TARGET_STATES.has(to)) return errorResponse("invalid_state", 400);
  if (!Array.isArray(from) || from.length === 0 || !from.every((s) => HOST_SOURCE_STATES.has(s))) {
    return errorResponse("invalid_state", 400);
  }

  if (to === "consumed") {
    const { data: input } = await serviceClient
      .from("session_inputs")
      .select("kind")
      .eq("id", inputId)
      .eq("session_id", sessionId)
      .maybeSingle<Pick<SessionInputRow, "kind">>();
    if (!input || input.kind === "message") return errorResponse("invalid_state", 400);
  }

  const { data, error } = await serviceClient.rpc("transition_session_input", {
    p_input_id: inputId,
    p_session_id: sessionId,
    p_from: from,
    p_to: to,
    p_reason: optionalString(body.reason, REASON_MAX_CHARS),
    p_consumed_seq: null,
  });
  if (error) {
    if (error.message.includes("invalid_transition")) return errorResponse("invalid_transition", 409);
    return errorResponse("input_update_failed", 500, error, workspaceId, sessionId);
  }
  return Response.json({ ok: true, changed: data === true });
});

/** Marks a delivering (or uncertain) input consumed when the transcript shows its message as a new user turn. */
export async function matchConsumedInputs(workspaceId: string, sessionId: string, afterSeq: number, uptoSeq: number): Promise<void> {
  if (uptoSeq <= afterSeq) return;
  try {
    const { data: waiting, error: waitingError } = await serviceClient
      .from("session_inputs")
      .select("id, author_name, payload, state, created_at")
      .eq("session_id", sessionId)
      .eq("workspace_id", workspaceId)
      .eq("kind", "message")
      .in("state", ["delivering", "uncertain"])
      .is("dismissed_at", null)
      .order("created_at", { ascending: true });
    if (waitingError) throw waitingError;
    if (!waiting || waiting.length === 0) return;

    const { data: events, error } = await serviceClient
      .from("session_events")
      .select("seq, payload")
      .eq("session_id", sessionId)
      .eq("workspace_id", workspaceId)
      .eq("kind", "user_message")
      .gt("seq", afterSeq)
      .lte("seq", uptoSeq)
      .order("seq", { ascending: true });
    if (error) throw error;
    const turns = ((events ?? []) as Pick<SessionEventRow, "seq" | "payload">[]).filter((e) => !e.payload.agent_id && typeof e.payload.text === "string");
    if (turns.length === 0) return;

    const candidates = [...(waiting as Pick<SessionInputRow, "id" | "author_name" | "payload" | "state">[])];
    for (const turn of turns) {
      const index = candidates.findIndex((c) => sameText(deliveredText(c.author_name, textOf(c)), turn.payload.text as string));
      if (index === -1) continue;
      const [match] = candidates.splice(index, 1);
      const { error: moveError } = await serviceClient.rpc("transition_session_input", {
        p_input_id: match!.id,
        p_session_id: sessionId,
        p_from: ["delivering", "uncertain"],
        p_to: "consumed",
        p_reason: null,
        p_consumed_seq: turn.seq,
      });
      if (moveError) throw moveError;
    }
  } catch (error) {
    void recordError({
      workspaceId,
      sessionId,
      operation: "session",
      message: "Could not match a user turn to a sent message",
      code: "input_match_failed",
      detail: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}

/** A queued input of an ended session can never be delivered. */
export async function failQueuedInputs(sessionId: string, reason: "session_ended" | "session_cleared" = "session_ended"): Promise<void> {
  await serviceClient
    .from("session_inputs")
    .update({ state: "failed", reason, updated_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .eq("state", "queued");
}

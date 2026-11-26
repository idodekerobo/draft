import type { Pool } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmbeddedEventBody } from "../../embedded-agent/adapter";

/** The label Draft shows for everything an embedded agent says. It is a display label, not a person. */
export const DRAFT_AGENT_LABEL = "Draft agent";

/** What an adapter's normalizer writes to the outbox for one event. */
export interface OutboxEvent {
  at: string;
  body: EmbeddedEventBody;
}

export interface OutboxRow {
  key: string;
  seq: number;
  event: OutboxEvent;
}

export interface SessionEventDraft {
  source_id: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface Projection {
  /** Events to add to the transcript. A row with no event (a finished turn) is still marked projected. */
  events: SessionEventDraft[];
  /** Turns that ended in these rows: the run's lifetime hook reads them. */
  settled: Array<{ requestId: string; outcome: "completed" | "interrupted" | "failed"; reason?: string }>;
}

export interface ProjectionContext {
  adapterId: string;
  /** Who answered a question or approval, by tool call id. Null when nobody did. */
  answeredBy: (toolCallId: string) => Promise<string | null>;
}

const meta = (adapterId: string, model: { provider: string; model: string } | null) => ({
  author_label: DRAFT_AGENT_LABEL,
  adapter_id: adapterId,
  ...(model ? { provider: model.provider, model: model.model } : {}),
});

/** Maps one outbox row to the session events the session view already renders. Pure apart from `answeredBy`. */
export async function projectRow(row: OutboxRow, context: ProjectionContext): Promise<Projection> {
  const { body } = row.event;
  const none: Projection = { events: [], settled: [] };
  switch (body.kind) {
    case "user_message":
      return { ...none, events: [{ source_id: row.key, kind: "user_message", payload: { text: body.text, input_id: body.requestId, author_user_id: body.authorUserId } }] };
    case "assistant_text":
      return { ...none, events: [{ source_id: row.key, kind: "assistant_text", payload: { text: body.text, ...meta(context.adapterId, body.model) } }] };
    case "thinking":
      return { ...none, events: [{ source_id: row.key, kind: "thinking", payload: { text: body.text, ...meta(context.adapterId, null) } }] };
    case "tool_use":
      return { ...none, events: [{ source_id: row.key, kind: "tool_use", payload: { name: body.name, input: body.input, tool_use_id: body.toolCallId, ...meta(context.adapterId, null) } }] };
    case "tool_result":
      return { ...none, events: [{ source_id: row.key, kind: "tool_result", payload: { tool_use_id: body.toolCallId, content: body.content, is_error: body.isError } }] };
    case "permission_request":
      // The decision route looks the request up by `perm:<id>`, and the id is the engine's tool call id.
      return {
        ...none,
        events: [{
          source_id: `perm:${body.toolCallId}`,
          kind: "permission_request",
          payload: { requestId: body.toolCallId, kind: body.requestKind, name: body.name, input: body.input, questions: body.questions ?? [], ...meta(context.adapterId, null) },
        }],
      };
    case "permission_resolved": {
      const cancelled = body.decision === "cancelled";
      const byName = cancelled ? null : await context.answeredBy(body.toolCallId);
      return {
        ...none,
        events: [{
          source_id: `permres:${body.toolCallId}`,
          kind: "permission_resolved",
          payload: { requestId: body.toolCallId, reason: cancelled ? "cancelled" : "decided", decision: cancelled ? null : body.decision, answers: body.answers ?? null, by_name: byName },
        }],
      };
    }
    case "turn_settled": {
      const settled = [{ requestId: body.requestId, outcome: body.outcome, ...(body.reason ? { reason: body.reason } : {}) }];
      if (body.outcome === "completed") return { events: [], settled };
      const text = body.outcome === "failed" ? `Draft stopped: ${body.reason ?? "something went wrong"}` : "Stopped.";
      return { events: [{ source_id: row.key, kind: "session_note", payload: { text, ...meta(context.adapterId, null) } }], settled };
    }
  }
}

export interface ProjectorDeps {
  pool: Pool;
  client: SupabaseClient;
  adapterId: string;
  /** Called with the turns that ended in a batch, after it is stored. */
  onSettled?: (settled: Projection["settled"]) => Promise<void> | void;
}

const BATCH = 100;

/** Pending outbox rows in commit order, oldest first. */
export async function readPendingOutbox(pool: Pool, sessionId: string, limit = BATCH): Promise<OutboxRow[]> {
  const { rows } = await pool.query(
    `select key, seq::float8 as seq, payload->'event' as event from embedded_agent_state
      where session_id = $1 and kind = 'outbox' and projected_at is null
      order by seq, (payload->>'ordinal')::int, key limit $2`,
    [sessionId, limit],
  );
  return rows.map((row) => ({ key: row.key as string, seq: Number(row.seq), event: row.event as OutboxEvent }));
}

/**
 * Copies pending outbox rows into the session transcript until none are left, and returns how many it projected. Safe to run
 * again at any time or from two processes: a row's events and its projected mark are written in one transaction, and an event
 * already in the transcript is skipped by its source id.
 */
export async function projectOutbox(deps: ProjectorDeps, session: { id: string; workspaceId: string }): Promise<number> {
  const answeredBy = async (toolCallId: string): Promise<string | null> => {
    const { data } = await deps.client
      .from("session_inputs")
      .select("author_name")
      .eq("session_id", session.id)
      .eq("kind", "permission_decision")
      .eq("payload->>requestId", toolCallId)
      .neq("state", "failed")
      .maybeSingle();
    return (data as { author_name: string } | null)?.author_name ?? null;
  };
  let total = 0;
  while (true) {
    const rows = await readPendingOutbox(deps.pool, session.id);
    if (rows.length === 0) return total;
    const events: SessionEventDraft[] = [];
    const settled: Projection["settled"] = [];
    for (const row of rows) {
      const projected = await projectRow(row, { adapterId: deps.adapterId, answeredBy });
      events.push(...projected.events);
      settled.push(...projected.settled);
    }
    const { error } = await deps.client.rpc("append_backend_session_events", {
      p_session_id: session.id,
      p_workspace_id: session.workspaceId,
      p_events: events,
      p_outbox_keys: rows.map((row) => row.key),
    });
    if (error) throw error;
    total += rows.length;
    if (settled.length > 0) await deps.onSettled?.(settled);
    if (rows.length < BATCH) return total;
  }
}

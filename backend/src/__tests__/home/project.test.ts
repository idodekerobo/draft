import { describe, expect, it } from "bun:test";
import { DRAFT_AGENT_LABEL, projectRow, type OutboxRow } from "../../home/runtime/project";
import type { EmbeddedEventBody } from "../../embedded-agent/adapter";

const row = (key: string, body: EmbeddedEventBody): OutboxRow => ({ key, seq: 1, event: { at: "2026-11-26T10:00:00Z", body } });
const context = { adapterId: "pi-durable-sdk", answeredBy: async (id: string) => (id === "call-1" ? "Uzo" : null) };
const OWNER = "33333333-3333-4333-8333-333333333333";

describe("projecting an outbox row into the transcript", () => {
  it("writes a person's message with the input it came from", async () => {
    const projected = await projectRow(row("req:i1", { kind: "user_message", requestId: "i1", text: "hello", authorUserId: OWNER }), context);
    expect(projected.events).toEqual([{ source_id: "req:i1", kind: "user_message", payload: { text: "hello", input_id: "i1", author_user_id: OWNER } }]);
  });

  it("labels the agent's words 'Draft agent' and records the model, provider and adapter", async () => {
    const projected = await projectRow(row("reply:1", { kind: "assistant_text", text: "Hi.", model: { provider: "anthropic", model: "claude-test" } }), context);
    expect(projected.events[0]).toMatchObject({ kind: "assistant_text", payload: { text: "Hi.", author_label: DRAFT_AGENT_LABEL, adapter_id: "pi-durable-sdk", provider: "anthropic", model: "claude-test" } });
  });

  it("names a question's request by the tool call id, the way the decision route looks it up", async () => {
    const asked = await projectRow(row("x", { kind: "permission_request", toolCallId: "call-1", requestKind: "question", name: "home.ask", input: { question: "Send it?" }, questions: [{ question: "Send it?" }] }), context);
    expect(asked.events[0]).toMatchObject({ source_id: "perm:call-1", kind: "permission_request", payload: { requestId: "call-1", kind: "question", questions: [{ question: "Send it?" }] } });
  });

  it("closes a decided request with who decided it, and a cancelled one with its reason", async () => {
    const decided = await projectRow(row("x", { kind: "permission_resolved", toolCallId: "call-1", decision: "allow" }), context);
    expect(decided.events[0]).toMatchObject({ source_id: "permres:call-1", payload: { reason: "decided", decision: "allow", by_name: "Uzo" } });
    const cancelled = await projectRow(row("x", { kind: "permission_resolved", toolCallId: "call-2", decision: "cancelled" }), context);
    expect(cancelled.events[0]).toMatchObject({ source_id: "permres:call-2", payload: { reason: "cancelled", decision: null, by_name: null } });
  });

  it("writes tool use and its result", async () => {
    const use = await projectRow(row("tool:1", { kind: "tool_use", toolCallId: "t1", name: "context.read", input: { path: "a" } }), context);
    const result = await projectRow(row("tool:1:result", { kind: "tool_result", toolCallId: "t1", content: "ok", isError: false }), context);
    expect(use.events[0]).toMatchObject({ kind: "tool_use", payload: { tool_use_id: "t1", name: "context.read" } });
    expect(result.events[0]).toMatchObject({ kind: "tool_result", payload: { tool_use_id: "t1", content: "ok", is_error: false } });
  });

  it("writes no event for a finished turn, but reports it settled; a failed or stopped turn leaves a note", async () => {
    const completed = await projectRow(row("settled:r1", { kind: "turn_settled", requestId: "r1", outcome: "completed" }), context);
    expect(completed).toEqual({ events: [], settled: [{ requestId: "r1", outcome: "completed" }] });
    const failed = await projectRow(row("settled:r2", { kind: "turn_settled", requestId: "r2", outcome: "failed", reason: "model unavailable" }), context);
    expect(failed.events[0]).toMatchObject({ kind: "session_note", payload: { text: "Draft stopped: model unavailable" } });
    expect(failed.settled).toEqual([{ requestId: "r2", outcome: "failed", reason: "model unavailable" }]);
    const stopped = await projectRow(row("settled:r3", { kind: "turn_settled", requestId: "r3", outcome: "interrupted" }), context);
    expect(stopped.events[0]).toMatchObject({ payload: { text: "Stopped." } });
  });
});

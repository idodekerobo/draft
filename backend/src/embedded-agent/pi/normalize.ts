import type { StorageWrite } from "@earendil-works/pi-durable";
import type { EmbeddedEventBody } from "../adapter";
import type { OutboxRow } from "./pg-storage";

/** The tool that asks the person a question. Its call and result are shown as a question card, not as tool rows. */
export const ASK_TOOL = "home_ask";
/** The entry kind a person's message is written as, so the request id and author travel with it. Pi's own kinds start with `pi.`. */
export const INPUT_ENTRY_KIND = "draft.input";

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
type Message = { role?: string; content?: unknown; provider?: string; model?: string; toolCallId?: string; toolName?: string; isError?: boolean };

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[]).map((block) => (block.type === "text" ? (block.text ?? "") : block.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
};

/**
 * Turns what pi stores in one commit into Draft's events, in the order pi wrote them. Pure: the same writes give the same rows,
 * so a replay after a crash gives rows the outbox already holds, under the same source ids.
 */
export function normalizeWrites(writes: readonly StorageWrite[], at: () => string = () => new Date().toISOString()): OutboxRow[] {
  const rows: OutboxRow[] = [];
  const push = (sourceId: string, body: EmbeddedEventBody) => rows.push({ sourceId, payload: { at: at(), body } });

  for (const write of writes) {
    if (write.type === "entry") {
      const entry = write.value as { id: number; kind: string; data?: unknown; model?: Message[] };
      const message = entry.model?.[0];
      if (entry.kind === INPUT_ENTRY_KIND) {
        const data = (entry.data ?? {}) as { requestId?: string; text?: string; authorUserId?: string };
        if (data.requestId) push(`req:${data.requestId}`, { kind: "user_message", requestId: data.requestId, text: data.text ?? "", authorUserId: data.authorUserId ?? "" });
      } else if (entry.kind === "pi.assistant" && message?.role === "assistant" && Array.isArray(message.content)) {
        const model = message.provider && message.model ? { provider: message.provider, model: message.model } : null;
        (message.content as Block[]).forEach((block, index) => {
          const id = `entry:${entry.id}:${index}`;
          if (block.type === "text" && block.text?.trim()) push(id, { kind: "assistant_text", text: block.text, model });
          else if (block.type === "thinking" && block.thinking?.trim()) push(id, { kind: "thinking", text: block.thinking });
          else if (block.type === "toolCall" && block.id && block.name && block.name !== ASK_TOOL) push(id, { kind: "tool_use", toolCallId: block.id, name: block.name, input: block.arguments ?? {} });
        });
      } else if (entry.kind === "pi.tool-result" && message?.role === "toolResult" && message.toolCallId && message.toolName !== ASK_TOOL) {
        push(`entry:${entry.id}`, { kind: "tool_result", toolCallId: message.toolCallId, content: textOf(message.content), isError: message.isError === true });
      }
    } else if (write.type === "submission") {
      const submission = write.value as { id: number; type: string; status: string; requestId?: string; reason?: string };
      if (submission.type !== "input" || !submission.requestId) continue;
      if (submission.status === "done") push(`settled:${submission.id}`, { kind: "turn_settled", requestId: submission.requestId, outcome: "completed" });
      else if (submission.status === "unanswered") {
        const interrupted = submission.reason === "aborted" || submission.reason === "reset";
        push(`settled:${submission.id}`, { kind: "turn_settled", requestId: submission.requestId, outcome: interrupted ? "interrupted" : "failed", ...(interrupted ? {} : { reason: submission.reason ?? "failed" }) });
      }
    }
  }
  return rows;
}

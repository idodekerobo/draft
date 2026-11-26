import { defineExtension, defineSignal, defineTool } from "@earendil-works/pi-durable";
import { arr, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { ASK_TOOL } from "./normalize";

/** What a person's answer to a question or approval carries back to the waiting tool. */
export const AskAnswer = defineSignal({
  name: "draft.ask-answer",
  version: 1,
  schema: obj({ decision: oneOf(["allow", "deny", "cancelled"]), text: opt(str()) }),
});

const DAY_MS = 24 * 60 * 60 * 1000;
const parameters = obj({ question: str(), options: opt(arr(str())) });

/** What a card asks the person: a question to answer, or a call to approve. */
export interface CardRequest {
  requestKind: "question" | "approval";
  /** The tool the card is about. For a question, the question tool. */
  name: string;
  input: unknown;
  question?: string;
  options?: string[];
}

/** The adapter's side of a card: where it is saved and shown, and how it is closed. Idempotent: a rerun finds the same rows. */
export interface AskHooks {
  /** Saves the card under its tool call id and its task id, and shows it. Does nothing when it is already saved. */
  open(card: CardRequest & { toolCallId: string; taskId: number }): Promise<void>;
  /** Closes a card whose tool was stopped while it waited. */
  cancel(toolCallId: string): Promise<void>;
}

type Api = Parameters<NonNullable<Parameters<typeof defineTool>[0]["execute"]>>[1];
type CallContext = Parameters<NonNullable<Parameters<typeof defineTool>[0]["execute"]>>[2];

export type GateResult =
  | { state: "answered"; decision: "allow" | "deny" | "cancelled"; text?: string }
  | { state: "expired" }
  /** Return this from the tool: it waits for the person without holding a process. */
  | { state: "park"; park: { kind: "sleep"; signals: ReturnType<typeof AskAnswer.key>[]; until: number; checkpoint: { asked: true } } };

/**
 * Shows a card and waits for its answer. A tool calls it at the top of `execute`: on the first pass it saves the card and
 * returns a park; when the person answers, the tool runs again and the same call returns the answer. The key is the tool call
 * id, so each call has its own card, and a rerun after a crash finds the card it already made.
 */
export function createGate(hooks: AskHooks) {
  return async function gate(api: Api, context: CallContext, card: CardRequest): Promise<GateResult> {
    const key = api.callId;
    const state = await api.readSignal(AskAnswer, key, context);
    if (state?.kind === "value") return { state: "answered", decision: state.value.decision, ...(state.value.text ? { text: state.value.text } : {}) };
    if (state !== undefined) return { state: "expired" };
    const until = await api.memo("ask.until", api.now() + DAY_MS, context);
    await hooks.open({ ...card, toolCallId: api.callId, taskId: api.taskId });
    return { state: "park", park: { kind: "sleep", signals: [AskAnswer.key(key)], until, checkpoint: { asked: true } } };
  };
}

export type Gate = ReturnType<typeof createGate>;

/**
 * Asks the person a question and waits for the answer without holding a process. A restart while it waits runs no tool
 * code, and a stop closes the card.
 */
export function createAskExtension(hooks: AskHooks, gate: Gate = createGate(hooks)) {
  const ask = defineTool({
    name: ASK_TOOL,
    description:
      "Ask the person a question and wait for their answer. Use it when you need a decision or information only they have. " +
      "Give the question in plain words, and options when the answer is a choice.",
    parameters,
    replay: "safe",
    async execute(args, api, context) {
      const result = await gate(api, context, { requestKind: "question", name: ASK_TOOL, input: { question: args.question }, question: args.question, options: args.options ?? [] });
      if (result.state === "park") return result.park;
      if (result.state === "expired") return { output: [{ type: "text", text: "No answer came." }], isError: true };
      const { decision, text } = result;
      const words = decision === "allow" ? (text?.trim() ? `The person answered: ${text.trim()}` : "The person said yes.") : decision === "deny" ? "The person said no." : "The question was cancelled.";
      return { output: [{ type: "text", text: words }], isError: decision === "cancelled" };
    },
    async cancel(_args, api) {
      await hooks.cancel(api.callId);
    },
  });
  return defineExtension({ name: "draft-ask", tools: [ask] });
}

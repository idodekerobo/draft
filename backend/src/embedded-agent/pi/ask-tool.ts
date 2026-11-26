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

/** The adapter's side of a question: where the question is saved and shown, and how it is closed. Idempotent: a rerun finds the same rows. */
export interface AskHooks {
  /** Saves the question under its tool call id and its task id, and shows it as a card. Does nothing when it is already saved. */
  open(ask: { toolCallId: string; taskId: number; question: string; options: string[] }): Promise<void>;
  /** Closes a question whose tool was stopped while it waited. */
  cancel(toolCallId: string): Promise<void>;
}

/**
 * Asks the person a question and waits for the answer without holding a process. The tool parks on a signal; the person's
 * answer, delivered through the decision route and the host, wakes it with the same call. A restart while it waits runs
 * no tool code, and a stop closes the card.
 */
export function createAskExtension(hooks: AskHooks) {
  const ask = defineTool({
    name: ASK_TOOL,
    description:
      "Ask the person a question and wait for their answer. Use it when you need a decision or information only they have, " +
      "and when an action needs their approval. Give the question in plain words, and options when the answer is a choice.",
    parameters,
    replay: "safe",
    async execute(args, api, context) {
      const key = api.callId;
      const state = await api.readSignal(AskAnswer, key, context);
      if (state?.kind === "value") {
        const { decision, text } = state.value;
        const words = decision === "allow" ? (text?.trim() ? `The person answered: ${text.trim()}` : "The person said yes.") : decision === "deny" ? "The person said no." : "The question was cancelled.";
        return { output: [{ type: "text", text: words }], isError: decision === "cancelled" };
      }
      if (state !== undefined) return { output: [{ type: "text", text: "No answer came." }], isError: true };
      const until = await api.memo("ask.until", api.now() + DAY_MS, context);
      await hooks.open({ toolCallId: api.callId, taskId: api.taskId, question: args.question, options: args.options ?? [] });
      return { kind: "sleep", signals: [AskAnswer.key(key)], until, checkpoint: { asked: true } };
    },
    async cancel(_args, api) {
      await hooks.cancel(api.callId);
    },
  });
  return defineExtension({ name: "draft-ask", tools: [ask] });
}

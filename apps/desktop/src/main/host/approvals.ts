/*
 * One permission request, as the host sees it:
 *
 *   hook called --post permission_request--> held --first decision--> answered, permission_resolved(decided)
 *                                              |-- 55 min -------------> permission_resolved(expired), dialog shows
 *                                              |-- dialog leaves the pane -> permission_resolved(answered_locally)
 *                                              `-- hook process ends ----> permission_resolved(answered_locally | hook_gone)
 *
 * While a request is held, Claude shows its own dialog too, so the owner can answer in a terminal.
 * Claude does not stop a held hook when the owner answers there, so the host watches the pane.
 * If the request cannot be posted, the hook gets no answer and only the dialog remains.
 */

export type HookAnswer = { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string };

export type AnswerValue = string | string[];

/** What a person adds to an allow or deny: answers to a question, a reason, how long an allow lasts. */
export interface DecisionExtras {
  answers?: Record<string, AnswerValue>;
  message?: string;
  scope?: "once" | "session";
}

export type RequestKind = "approval" | "question" | "plan";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  key: string;
  header?: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  isOther: boolean;
  isSecret: boolean;
}

export interface HostEvent {
  sourceId: string;
  kind: "permission_request" | "permission_resolved" | "session_note";
  payload: Record<string, unknown>;
}

export interface Decider {
  userId: string;
  name: string;
}

export interface ApprovalDeps {
  postEvents(events: HostEvent[]): Promise<void>;
  /** The pane shows a dialog, a question or a permission prompt instead of the message box. */
  paneBlocked(): Promise<boolean>;
  newId(): string;
  onOpen(requestId: string): void;
  onClose(requestId: string): void;
  expireMs?: number;
  /** Claude asks one thing at a time, so a new request means the held ones were answered in the terminal. */
  oneAtATime?: boolean;
  /** Wait before the first retry of a result that did not post, doubled for each later one. */
  retryMs?: number;
}

export type Outcome = { type: "decided"; decision: "allow" | "deny"; by: Decider; extras: DecisionExtras } | { type: "expired" } | { type: "gone" } | { type: "local" };

const EXPIRE_MS = 55 * 60 * 1000;
const MAX_INPUT_CHARS = 4000;
/** Checks in a row without the dialog before the owner counts as having answered. */
const MISSES_TO_CLOSE = 2;
const MAX_MESSAGE_CHARS = 2000;
const RESULT_ATTEMPTS = 3;
const RESULT_RETRY_MS = 250;

export function requestKind(toolName: string): RequestKind {
  if (toolName === "AskUserQuestion") return "question";
  if (toolName === "ExitPlanMode") return "plan";
  return "approval";
}

/** The questions Claude's AskUserQuestion tool asked, in the shape the chat shows. Malformed entries are dropped. */
export function questionsFromInput(input: unknown): Question[] {
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return [];
  const questions: Question[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.question !== "string" || !e.question || !Array.isArray(e.options)) continue;
    const options: QuestionOption[] = [];
    for (const option of e.options) {
      const o = typeof option === "string" ? { label: option } : (option as Record<string, unknown> | null);
      if (!o || typeof o.label !== "string" || !o.label) continue;
      options.push(typeof o.description === "string" && o.description ? { label: o.label, description: o.description } : { label: o.label });
    }
    if (options.length === 0) continue;
    questions.push({
      key: e.question,
      ...(typeof e.header === "string" && e.header ? { header: e.header } : {}),
      question: e.question,
      options,
      multiSelect: e.multiSelect === true,
      isOther: true,
      isSecret: false,
    });
  }
  return questions;
}

/** Keeps answers to the asked questions only, as strings or lists of strings. They arrive by position, or by question text from older clients. */
export function cleanAnswers(answers: unknown, questions: Question[]): Record<string, AnswerValue> {
  const clean: Record<string, AnswerValue> = {};
  if (!answers || typeof answers !== "object") return clean;
  const given = answers as Record<string, unknown>;
  for (const [index, question] of questions.entries()) {
    const value = given[String(index)] ?? given[question.key];
    if (typeof value === "string") clean[question.key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === "string")) clean[question.key] = value as string[];
  }
  return clean;
}

function requestPayload(requestId: string, toolName: string, toolInput: unknown): Record<string, unknown> {
  const kind = requestKind(toolName);
  const base = { requestId, name: toolName, kind, ...summarizeToolInput(toolInput) };
  if (kind === "question") return { ...base, questions: questionsFromInput(toolInput) };
  const plan = (toolInput as { plan?: unknown } | null)?.plan;
  if (kind === "plan" && typeof plan === "string") return { ...base, plan };
  return base;
}

export function summarizeToolInput(input: unknown): { input: unknown; input_truncated: boolean } {
  const text = JSON.stringify(input ?? null) ?? "null";
  if (text.length <= MAX_INPUT_CHARS) return { input, input_truncated: false };
  return { input: text.slice(0, MAX_INPUT_CHARS), input_truncated: true };
}

/** What Claude's hook gets back. A question carries the answers, and a plan carries its own input, or Claude asks again in the pane. */
function hookAnswer(toolName: string, toolInput: unknown, outcome: Extract<Outcome, { type: "decided" }>): HookAnswer {
  const input = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? (toolInput as Record<string, unknown>) : null;
  const reason = outcome.extras.message?.trim().slice(0, MAX_MESSAGE_CHARS);
  if (outcome.decision === "deny") {
    return { behavior: "deny", message: reason ? `Denied by ${outcome.by.name} in Draft: ${reason}` : `Denied by ${outcome.by.name} in Draft.` };
  }
  if (!input) return { behavior: "allow" };
  const kind = requestKind(toolName);
  if (kind === "plan") return { behavior: "allow", updatedInput: input };
  if (kind === "question") {
    const answers = cleanAnswers(outcome.extras.answers, questionsFromInput(input));
    return Object.keys(answers).length > 0 ? { behavior: "allow", updatedInput: { ...input, answers } } : { behavior: "allow" };
  }
  return { behavior: "allow" };
}

export class ApprovalBroker {
  private readonly held = new Map<string, { finish: (outcome: Outcome) => void; seenDialog: boolean; misses: number }>();

  constructor(private readonly deps: ApprovalDeps) {}

  /** Holds the hook until someone decides. Returns null to let Claude's own dialog handle it. */
  async hold(payload: { tool_name?: unknown; tool_input?: unknown }, signal: AbortSignal): Promise<HookAnswer | null> {
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
    if (!toolName) return null;
    const outcome = await this.ask((requestId) => requestPayload(requestId, toolName, payload.tool_input), signal);
    if (!outcome || outcome.type !== "decided") return null;
    return hookAnswer(toolName, payload.tool_input, outcome);
  }

  /**
   * Posts a request and waits for how it ends. `payload` builds the event body for the request id.
   * Returns null when the request could not be posted, so only the harness's own dialog remains.
   */
  async ask(payload: (requestId: string) => Record<string, unknown>, signal: AbortSignal): Promise<Outcome | null> {
    if (this.deps.oneAtATime) for (const entry of [...this.held.values()]) entry.finish({ type: "local" });

    const requestId = this.deps.newId();
    try {
      await this.deps.postEvents([{ sourceId: `perm:${requestId}`, kind: "permission_request", payload: payload(requestId) }]);
    } catch (error) {
      console.error("[live-session] could not post a permission request", error);
      return null;
    }
    this.deps.onOpen(requestId);

    const outcome = await new Promise<Outcome>((resolve) => {
      const finish = (value: Outcome) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.held.delete(requestId);
        resolve(value);
      };
      const onAbort = () => finish({ type: "gone" });
      const timer = setTimeout(() => finish({ type: "expired" }), this.deps.expireMs ?? EXPIRE_MS);
      this.held.set(requestId, { finish, seenDialog: false, misses: 0 });
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });

    await this.resolve(requestId, outcome);
    return outcome;
  }

  /** Answers a held request. False when it is not held any more. */
  decide(requestId: string, decision: "allow" | "deny", by: Decider, extras: DecisionExtras = {}): boolean {
    const entry = this.held.get(requestId);
    if (!entry) return false;
    entry.finish({ type: "decided", decision, by, extras });
    return true;
  }

  /** Call every few seconds. A held request whose dialog has left the pane was answered in the terminal. */
  async watchPane(): Promise<void> {
    if (this.held.size === 0) return;
    const blocked = await this.deps.paneBlocked().catch(() => null);
    if (blocked === null) return;
    for (const entry of [...this.held.values()]) {
      if (blocked) {
        entry.seenDialog = true;
        entry.misses = 0;
      } else if (entry.seenDialog && ++entry.misses >= MISSES_TO_CLOSE) {
        entry.finish({ type: "local" });
      }
    }
  }

  private async resolve(requestId: string, outcome: Outcome): Promise<void> {
    const reason =
      outcome.type === "decided"
        ? "decided"
        : outcome.type === "expired"
          ? "expired"
          : outcome.type === "local" || !(await this.deps.paneBlocked().catch(() => false))
            ? "answered_locally"
            : "hook_gone";
    const payload: Record<string, unknown> = { requestId, reason };
    if (outcome.type === "decided") {
      Object.assign(payload, { decision: outcome.decision, by_user_id: outcome.by.userId, by_name: outcome.by.name });
      const { answers, message } = outcome.extras;
      if (answers && Object.keys(answers).length > 0) payload.answers = answers;
      if (message?.trim()) payload.message = message.trim().slice(0, MAX_MESSAGE_CHARS);
    }
    await this.closeOnServer(requestId, payload);
  }

  /** Reports a request that no hook is waiting for, such as one left open by an earlier run of the app. */
  async closeOnServer(requestId: string, payload: Record<string, unknown>): Promise<void> {
    let wait = this.deps.retryMs ?? RESULT_RETRY_MS;
    for (let attempt = 1; attempt <= RESULT_ATTEMPTS; attempt++) {
      try {
        await this.deps.postEvents([{ sourceId: `permres:${requestId}`, kind: "permission_resolved", payload }]);
        this.deps.onClose(requestId);
        return;
      } catch (error) {
        console.error("[live-session] could not post a permission result", error);
        if (attempt < RESULT_ATTEMPTS) await new Promise((done) => setTimeout(done, wait));
        wait *= 2;
      }
    }
    // The id stays in the saved open requests, so the next start closes the card.
  }
}

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

export type HookAnswer = { behavior: "allow" } | { behavior: "deny"; message: string };

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
}

type Outcome = { type: "decided"; decision: "allow" | "deny"; by: Decider } | { type: "expired" } | { type: "gone" } | { type: "local" };

const EXPIRE_MS = 55 * 60 * 1000;
const MAX_INPUT_CHARS = 4000;
/** Checks in a row without the dialog before the owner counts as having answered. */
const MISSES_TO_CLOSE = 2;
/** Claude asks its own questions in the pane; they are not an allow or deny. */
const NOT_APPROVALS = new Set(["AskUserQuestion"]);

export function summarizeToolInput(input: unknown): { input: unknown; input_truncated: boolean } {
  const text = JSON.stringify(input ?? null) ?? "null";
  if (text.length <= MAX_INPUT_CHARS) return { input, input_truncated: false };
  return { input: text.slice(0, MAX_INPUT_CHARS), input_truncated: true };
}

export class ApprovalBroker {
  private readonly held = new Map<string, { finish: (outcome: Outcome) => void; seenDialog: boolean; misses: number }>();

  constructor(private readonly deps: ApprovalDeps) {}

  /** Holds the hook until someone decides. Returns null to let Claude's own dialog handle it. */
  async hold(payload: { tool_name?: unknown; tool_input?: unknown }, signal: AbortSignal): Promise<HookAnswer | null> {
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
    if (!toolName || NOT_APPROVALS.has(toolName)) return null;

    const requestId = this.deps.newId();
    try {
      await this.deps.postEvents([
        { sourceId: `perm:${requestId}`, kind: "permission_request", payload: { requestId, name: toolName, ...summarizeToolInput(payload.tool_input) } },
      ]);
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
    if (outcome.type !== "decided") return null;
    return outcome.decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: `Denied by ${outcome.by.name} in Draft.` };
  }

  /** Answers a held request. False when it is not held any more. */
  decide(requestId: string, decision: "allow" | "deny", by: Decider): boolean {
    const entry = this.held.get(requestId);
    if (!entry) return false;
    entry.finish({ type: "decided", decision, by });
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
    if (outcome.type === "decided") Object.assign(payload, { decision: outcome.decision, by_user_id: outcome.by.userId, by_name: outcome.by.name });
    await this.closeOnServer(requestId, payload);
  }

  /** Reports a request that no hook is waiting for, such as one left open by an earlier run of the app. */
  async closeOnServer(requestId: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.postEvents([{ sourceId: `permres:${requestId}`, kind: "permission_resolved", payload }]);
    } catch (error) {
      console.error("[live-session] could not post a permission result", error);
    } finally {
      this.deps.onClose(requestId);
    }
  }
}

import type { InputFailReason } from "draft-core/live-sessions";
import { classifyPane, isTurnRunning } from "./pane-state";
import type { AnswerValue, Decider, DecisionExtras, HostEvent } from "./approvals";

export interface ControlInput {
  id: string;
  kind: "stop" | "permission_decision" | "set_mode";
  state: "queued" | "delivering";
  author_user_id: string;
  author_name: string;
  payload: { requestId?: string; decision?: string; answers?: unknown; message?: unknown; scope?: unknown; permissionMode?: unknown; approvalMode?: unknown };
}

export interface ControlDeps {
  setState(id: string, from: Array<"queued" | "delivering">, to: "delivering" | "failed" | "consumed", reason?: InputFailReason): Promise<boolean>;
  decide(requestId: string, decision: "allow" | "deny", by: Decider, extras?: DecisionExtras): boolean;
  capture(): Promise<string>;
  sendEscape(): Promise<void>;
  /** Switches the session to the modes asked for. */
  setMode(modes: { permissionMode?: string; approvalMode?: string }): Promise<{ ok: true } | { ok: false; note: string }>;
  postEvents(events: HostEvent[]): Promise<void>;
}

/** Reads the optional parts of a decision from the input row. Anything of the wrong type is ignored. */
export function decisionExtras(payload: ControlInput["payload"]): DecisionExtras {
  const extras: DecisionExtras = {};
  const { answers, message, scope, permissionMode } = payload;
  if (answers && typeof answers === "object" && !Array.isArray(answers)) {
    const clean: Record<string, AnswerValue> = {};
    for (const [key, value] of Object.entries(answers)) {
      if (typeof value === "string") clean[key] = value;
      else if (Array.isArray(value) && value.every((v) => typeof v === "string")) clean[key] = value as string[];
    }
    extras.answers = clean;
  }
  if (typeof message === "string") extras.message = message;
  if (scope === "once" || scope === "session") extras.scope = scope;
  if (permissionMode === "auto" || permissionMode === "default") extras.permissionMode = permissionMode;
  return extras;
}

/** Acts on the Stop buttons and permission decisions that teammates sent. */
export class ControlActions {
  private busy = false;
  private recovered = false;

  constructor(private readonly deps: ControlDeps) {}

  async tick(pending: ControlInput[]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.recovered) {
        // An input left `delivering` by an earlier run cannot be finished: its hook is gone.
        for (const input of pending.filter((i) => i.state === "delivering")) {
          await this.deps.setState(input.id, ["delivering"], "failed", "host_restarted");
        }
        this.recovered = true;
      }
      for (const input of pending.filter((i) => i.state === "queued")) {
        if (!(await this.deps.setState(input.id, ["queued"], "delivering"))) continue;
        await this.act(input);
      }
    } finally {
      this.busy = false;
    }
  }

  private async act(input: ControlInput): Promise<void> {
    try {
      if (input.kind === "permission_decision") {
        const { requestId, decision } = input.payload;
        const decided =
          typeof requestId === "string" &&
          (decision === "allow" || decision === "deny") &&
          this.deps.decide(requestId, decision, { userId: input.author_user_id, name: input.author_name }, decisionExtras(input.payload));
        await this.deps.setState(input.id, ["delivering"], decided ? "consumed" : "failed", decided ? undefined : "request_not_open");
        return;
      }
      if (input.kind === "set_mode") {
        const { permissionMode, approvalMode } = input.payload;
        const result = await this.deps.setMode({
          ...(typeof permissionMode === "string" ? { permissionMode } : {}),
          ...(typeof approvalMode === "string" ? { approvalMode } : {}),
        });
        if (!result.ok) {
          await this.deps.postEvents([{ sourceId: `mode:${input.id}`, kind: "session_note", payload: { text: result.note } }]);
        }
        await this.deps.setState(input.id, ["delivering"], result.ok ? "consumed" : "failed", result.ok ? undefined : "pane_unavailable");
        return;
      }
      await this.stop(input);
      await this.deps.setState(input.id, ["delivering"], "consumed");
    } catch (error) {
      console.error("[live-session] control action failed", input.id, error);
      await this.deps.setState(input.id, ["delivering"], "failed", "pane_unavailable").catch(() => {});
    }
  }

  /** Esc interrupts a running turn and cancels a dialog. At a prompt it would do nothing or clear typed text, so the host leaves it. */
  private async stop(input: ControlInput): Promise<void> {
    const screen = await this.deps.capture();
    const pane = classifyPane(screen);
    // Any dialog counts, including one Draft does not recognise, so the owner is never stuck behind it.
    const interrupts = isTurnRunning(screen) || (pane !== "ready" && pane !== "composer_busy");
    if (interrupts) await this.deps.sendEscape();
    await this.deps.postEvents([
      {
        sourceId: `stop:${input.id}`,
        kind: "session_note",
        payload: interrupts
          ? { text: `Stopped by ${input.author_name}`, interrupted_by: { id: input.author_user_id, name: input.author_name } }
          : { text: `${input.author_name} pressed Stop, but nothing was running` },
      },
    ]);
  }
}

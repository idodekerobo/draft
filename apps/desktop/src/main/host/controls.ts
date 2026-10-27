import { classifyPane, isTurnRunning } from "./pane-state";
import type { Decider, HostEvent } from "./approvals";

export interface ControlInput {
  id: string;
  kind: "stop" | "permission_decision";
  state: "queued" | "delivering";
  author_user_id: string;
  author_name: string;
  payload: { requestId?: string; decision?: string };
}

export interface ControlDeps {
  fetchPending(): Promise<ControlInput[]>;
  setState(id: string, from: Array<"queued" | "delivering">, to: "delivering" | "failed" | "consumed", reason?: string): Promise<boolean>;
  decide(requestId: string, decision: "allow" | "deny", by: Decider): boolean;
  capture(): Promise<string>;
  sendEscape(): Promise<void>;
  postEvents(events: HostEvent[]): Promise<void>;
}

/** Acts on the Stop buttons and permission decisions that teammates sent. */
export class ControlActions {
  private busy = false;
  private recovered = false;

  constructor(private readonly deps: ControlDeps) {}

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const pending = await this.deps.fetchPending();
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
          this.deps.decide(requestId, decision, { userId: input.author_user_id, name: input.author_name });
        await this.deps.setState(input.id, ["delivering"], decided ? "consumed" : "failed", decided ? undefined : "request_not_open");
        return;
      }
      await this.stop(input);
      await this.deps.setState(input.id, ["delivering"], "consumed");
    } catch (error) {
      console.error("[live-session] control action failed", input.id, error);
      await this.deps.setState(input.id, ["delivering"], "failed", "pane_unavailable").catch(() => {});
    }
  }

  /** Esc interrupts a running turn and cancels a dialog. At an empty prompt it would do nothing, so the host leaves it. */
  private async stop(input: ControlInput): Promise<void> {
    const screen = await this.deps.capture();
    const interrupts = isTurnRunning(screen) || ["permission", "question"].includes(classifyPane(screen));
    if (interrupts) await this.deps.sendEscape();
    await this.deps.postEvents([
      {
        sourceId: `stop:${input.id}`,
        kind: "session_note",
        payload: { text: interrupts ? `Stopped by ${input.author_name}` : `${input.author_name} pressed Stop, but nothing was running` },
      },
    ]);
  }
}

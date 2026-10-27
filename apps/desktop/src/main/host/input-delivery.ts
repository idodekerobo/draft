import { classifyPane, type PaneState } from "./pane-state";

/*
 * One teammate message, as the host sees it:
 *
 *   queued --pane ready, composer empty--> delivering --user turn in transcript--> consumed
 *     |                                        |-- host restart, no matching turn --> uncertain --turn shows up late--> consumed
 *     |                                        `-- pane gone or paste failed -------> failed(reason)
 *     `-- pane busy or composer has text --> stays queued (with a reason)
 *
 * The host marks `delivering` before it pastes. The backend marks `consumed` when the
 * transcript shows the message as a user turn. The host never clears the composer, because
 * the owner may be typing in a terminal.
 */

export interface PendingInput {
  id: string;
  state: "queued" | "delivering";
  delivered_text: string;
}

export interface DeliveryDeps {
  fetchPending(): Promise<PendingInput[]>;
  /** Returns false when the input was no longer in one of the `from` states. */
  setState(id: string, from: Array<"queued" | "delivering">, to: "queued" | "delivering" | "failed" | "uncertain", reason?: string): Promise<boolean>;
  capture(): Promise<string>;
  paste(text: string): Promise<void>;
  pressEnter(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

const BLOCK_REASONS: Record<Exclude<PaneState, "ready">, string> = {
  composer_busy: "composer_busy",
  permission: "permission_prompt",
  question: "question_prompt",
  dialog: "dialog",
};

const SUBMIT_POLL_MS = 400;
const SUBMIT_POLLS = 6;
const MAX_PASTE_CHARS = 12_000;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** The backend already cleans text; this keeps the pane safe if it ever does not. */
export function safePasteText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "").slice(0, MAX_PASTE_CHARS);
}

export class InputDelivery {
  private busy = false;
  private recovered = false;
  private readonly reported = new Map<string, string>();

  constructor(private readonly deps: DeliveryDeps) {}

  /** Inputs left `delivering` by an earlier run have no known outcome. Call after the transcript has caught up. */
  private async recover(): Promise<void> {
    const pending = await this.deps.fetchPending();
    for (const input of pending.filter((i) => i.state === "delivering")) {
      await this.deps.setState(input.id, ["delivering"], "uncertain", "host_restarted");
    }
    this.recovered = true;
  }

  /** One pass: delivers the oldest queued input if the pane is ready. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.recovered) await this.recover();
      const next = (await this.deps.fetchPending()).find((i) => i.state === "queued");
      if (!next) return;

      const state = classifyPane(await this.deps.capture());
      if (state !== "ready") {
        await this.report(next.id, BLOCK_REASONS[state]);
        return;
      }
      if (!(await this.deps.setState(next.id, ["queued"], "delivering"))) return;
      await this.deliver(next);
    } finally {
      this.busy = false;
    }
  }

  private async report(id: string, reason: string): Promise<void> {
    if (this.reported.get(id) === reason) return;
    this.reported.set(id, reason);
    await this.deps.setState(id, ["queued"], "queued", reason);
  }

  private async deliver(input: PendingInput): Promise<void> {
    let pasted = false;
    try {
      await this.deps.paste(safePasteText(input.delivered_text));
      pasted = true;
      await this.deps.pressEnter();
      if (await this.submitted()) return;
      await this.deps.pressEnter();
      if (await this.submitted()) return;
      await this.deps.setState(input.id, ["delivering"], "uncertain", "not_submitted");
    } catch (error) {
      console.error("[live-session] delivery failed", input.id, error);
      await this.deps
        .setState(input.id, ["delivering"], pasted ? "uncertain" : "failed", pasted ? "delivery_interrupted" : "pane_unavailable")
        .catch(() => {});
    }
  }

  /** The text left the composer, so Claude took it. */
  private async submitted(): Promise<boolean> {
    for (let i = 0; i < SUBMIT_POLLS; i++) {
      await this.deps.sleep(SUBMIT_POLL_MS);
      if (classifyPane(await this.deps.capture()) !== "composer_busy") return true;
    }
    return false;
  }
}

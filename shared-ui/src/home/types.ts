export type NotificationState = "open" | "done" | "not_mine" | "retracted";
export type NotificationAction = "done" | "not_mine" | "undo";

export interface HomeNotification {
  id: string;
  kind: string;
  subject: string;
  text: string;
  link: string | null;
  needsAction: boolean;
  state: NotificationState;
  refType: string | null;
  refId: string | null;
  createdAt: string;
  actedAt: string | null;
}

export type NeedsYouRow =
  | { kind: "approval"; id: string; sessionId: string; title: string | null; openCount: number; createdAt: string }
  | { kind: "input_request"; id: string; runId: string; question: string; createdAt: string }
  | { kind: "notification"; id: string; notification: HomeNotification; createdAt: string }
  | { kind: "connection_attention"; id: string; provider: string; status: string; createdAt: string }
  | { kind: "failed_delivery"; id: string; notificationId: string; subject: string; channel: string; status: string; createdAt: string };

export interface NeedsYou {
  count: number;
  rows: NeedsYouRow[];
  /** True when one source failed to load, so the list may be missing rows. */
  partial?: boolean;
}

export type ActResult =
  | { ok: true; state: NotificationState; changed: boolean }
  | { ok: false; code: string; message: string };

/** What to tell the person for each way an action can be refused. */
export const ACT_REFUSAL_MESSAGES: Record<string, string> = {
  not_found: "That item is gone.",
  not_recipient: "Only the person it was sent to can act on it.",
  not_actionable: "There is nothing to do on this one.",
  already_acted: "Already handled.",
  stale_undo: "Too late to undo: a later step was taken.",
};
export const actRefusalMessage = (code: string) => ACT_REFUSAL_MESSAGES[code] ?? "Could not save that. Try again.";

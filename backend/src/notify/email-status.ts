/** What Draft says about an email. Higher rank is later in the life of a message, and a status never moves down. */
export const EMAIL_STATUSES = ["accepted", "delayed", "delivered", "failed", "bounced", "complained"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

const RANK: Record<EmailStatus, number> = { accepted: 0, delayed: 1, delivered: 2, failed: 3, bounced: 3, complained: 3 };

/** Maps Resend's `last_event`. Open and click imply delivery. Anything unknown stays `accepted`. */
export function emailStatusFromResend(lastEvent: string | null | undefined): EmailStatus {
  switch (lastEvent) {
    case "delivered":
    case "opened":
    case "clicked":
      return "delivered";
    case "delivery_delayed":
      return "delayed";
    case "bounced":
      return "bounced";
    case "complained":
      return "complained";
    case "failed":
    case "canceled":
    case "suppressed":
      return "failed";
    default:
      return "accepted";
  }
}

/** The status to keep after a new reading. A later stage replaces an earlier one, and the first of two equal ones stays. */
export function mergeEmailStatus(current: EmailStatus, next: EmailStatus): EmailStatus {
  return RANK[next] > RANK[current] ? next : current;
}

/** The words `notification_deliveries.status` uses. `sent` means the provider accepted it. Higher rank is later, and a status never moves down. */
export const EMAIL_STATUSES = ["queued", "sent", "delayed", "delivered", "failed", "bounced", "complained"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

const RANK: Record<EmailStatus, number> = { queued: 0, sent: 1, delayed: 2, delivered: 3, failed: 4, bounced: 4, complained: 4 };

/** Maps Resend's `last_event`. Open and click imply delivery. Anything unknown stays `sent`. */
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
      return "sent";
  }
}

/** The status to keep after a new reading. A later stage replaces an earlier one, and the first of two equal ones stays. */
export function mergeEmailStatus(current: EmailStatus, next: EmailStatus): EmailStatus {
  return RANK[next] > RANK[current] ? next : current;
}

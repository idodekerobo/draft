/** Sender addresses, grouped by purpose. Email is sent from the verified `notify.draftai.us` domain. */
export const EMAIL_SENDERS = {
  notification: "Draft <notifications@notify.draftai.us>",
} as const;

export const EMAIL_SUBJECT_PREFIX = "Draft: ";
/** Used when an email has a body but no subject. */
export const DEFAULT_EMAIL_SUBJECT = `${EMAIL_SUBJECT_PREFIX}New message`;

import type { CalAnswers } from "../../waitlist/cal-profile";

const MAX_VALUE_LENGTH = 500;
const ANSWER_KEYS = ["role", "team_size", "ai_tools", "use_case", "how_heard"] as const;

export interface CalBooking {
  uid: string;
  email: string;
  name?: string;
  answers: CalAnswers;
  metadata: Record<string, string>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_VALUE_LENGTH) : undefined;
}

// A booking-question response is { label, value }. Multi-select values are arrays.
function answerValue(entry: unknown): string | string[] | undefined {
  const value = asRecord(entry)?.value;
  if (Array.isArray(value)) {
    const items = value.map(text).filter((item): item is string => !!item);
    return items.length > 0 ? items : undefined;
  }
  return text(value);
}

export function parseBookingCreated(body: unknown): CalBooking | null {
  const payload = asRecord(asRecord(body)?.payload);
  if (!payload) return null;

  const uid = text(payload.uid);
  const attendee = asRecord(Array.isArray(payload.attendees) ? payload.attendees[0] : null);
  const email = text(attendee?.email)?.toLowerCase();
  if (!uid || !email) return null;

  const responses = asRecord(payload.responses) ?? {};
  const userFields = asRecord(payload.userFieldsResponses) ?? {};
  const answers: Record<string, string | string[]> = {};
  for (const key of ANSWER_KEYS) {
    const value = answerValue(responses[key]) ?? answerValue(userFields[key]);
    if (value) answers[key] = value;
  }

  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(payload.metadata) ?? {})) {
    const clean = text(value);
    if (clean) metadata[key] = clean;
  }

  return {
    uid,
    email,
    name: text(attendee?.name) ?? (typeof answerValue(responses.name) === "string" ? (answerValue(responses.name) as string) : undefined),
    answers: answers as CalAnswers,
    metadata,
  };
}

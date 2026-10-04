const FIELD_MESSAGES: Record<string, string> = {
  preset: "Choose a frequency.",
  time: "Enter a valid time.",
  weekday: "Choose a day.",
  timezone: "Choose a valid timezone.",
};

/** Carries the offending field so the editor can show the message beside it. */
export class RoutineError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
  }
}

/** Turns an API error code (and optional field) into a message a member can act on. */
export function toRoutineError(code: string, field?: string): RoutineError {
  if (field && FIELD_MESSAGES[field]) return new RoutineError(FIELD_MESSAGES[field], field);
  if (code === "not_found") return new RoutineError("This routine no longer exists. Refresh and try again.");
  if (code === "network") return new RoutineError("Could not reach Draft. Check your connection.");
  return new RoutineError("Could not save this schedule. Try again.");
}

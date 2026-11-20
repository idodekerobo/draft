import { ROUTINE_ONCE_MAX_DAYS } from "draft-core/routines";

/** Only the controls a form renders can take a field error. Anything else shows at the foot of the form. */
const FIELD_MESSAGES: Record<string, string> = {
  when: "Choose when it runs.",
  preset: "Choose a frequency.",
  time: "Enter a valid time.",
  weekday: "Choose a day.",
  timezone: "Choose a valid timezone.",
  title: "Enter a name for this routine.",
  prompt: "Describe what the routine should do.",
  harness: "Choose an agent.",
  model: "Choose a model.",
  reasoningEffort: "Choose a reasoning effort from the list.",
  events: "Choose a valid event.",
  canNotify: "Choose whether it may message teammates.",
  canReadGmail: "Choose whether it may read your Gmail.",
  postChannels: "Choose up to 20 channels.",
  github: "Choose repositories Draft can reach.",
};

/** A field such as "when.schedule.time" belongs to its deepest part that has a control, here "time". */
function controlFor(field: string): string | undefined {
  return field.split(".").reverse().find((part) => Object.hasOwn(FIELD_MESSAGES, part));
}

/** Carries the offending field so the editor can show the message beside it. */
export class RoutineError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
  }
}

/** Turns an API error code (and optional field) into a message a member can act on. */
export function toRoutineError(code: string, field?: string): RoutineError {
  if (code === "codex_not_connected" || code === "codex_needs_reconnect") return new RoutineError("Connect Codex for routines first.", "harness");
  if (code === "claude_not_connected" || code === "claude_needs_reconnect") return new RoutineError("Connect Claude Code for routines first.", "harness");
  if (code === "gmail_not_connected") return new RoutineError("Connect your Gmail in Connections first.", "canReadGmail");
  if (code === "too_far_ahead") return new RoutineError(`That time is more than ${ROUTINE_ONCE_MAX_DAYS} days away. Pick a closer time.`, "when");
  if (code === "in_the_past") return new RoutineError("That time has already passed. Pick a later time.", "when");
  if (field === "limit") return new RoutineError("This workspace has reached its limit of routines. Delete one or ask Draft for more.");
  const control = field ? controlFor(field) : undefined;
  if (control) return new RoutineError(FIELD_MESSAGES[control]!, control);
  if (code === "invalid_schedule") return new RoutineError("Choose a valid schedule and try again.", "when");
  if (code === "forbidden") return new RoutineError("You can’t change routines in this workspace.");
  if (code === "already_running") return new RoutineError("This routine is already running.");
  if (code === "codex_login_busy") return new RoutineError("Another Codex run is using the login. Try again when it finishes.");
  if (code === "run_failed") return new RoutineError("The run could not start. Try again.");
  if (code === "not_found") return new RoutineError("This routine no longer exists. Refresh and try again.");
  if (code === "network") return new RoutineError("Could not reach Draft. Check your connection.");
  return new RoutineError("Could not save this schedule. Try again.");
}

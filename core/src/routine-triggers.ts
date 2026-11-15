// The routine lists and wording with no schema library, so the CLI can load them at startup cheaply.
export const ROUTINE_PRESETS = ["draft_default", "hourly", "daily", "weekdays", "weekly"] as const;
export const ROUTINE_WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
/** Events that can start a routine, and the connection each one needs. Add one here to offer a new trigger everywhere. */
export const ROUTINE_TRIGGERS = [
  { event: "fireflies.meeting_summarized", provider: "fireflies", providerLabel: "Fireflies", label: "A Fireflies meeting is summarized", preview: "Starts after every Fireflies meeting is summarized", description: "a Fireflies meeting was summarized" },
  { event: "granola.note_ready", provider: "granola", providerLabel: "Granola", label: "A Granola meeting note is ready", preview: "Starts when a Granola meeting note is ready", description: "a Granola meeting note was generated" },
  { event: "github.pull_request_opened", provider: "github", providerLabel: "GitHub", label: "A pull request is opened", preview: "Starts when a pull request is opened", description: "a GitHub pull request was opened" },
  { event: "github.pull_request_merged", provider: "github", providerLabel: "GitHub", label: "A pull request is merged", preview: "Starts when a pull request is merged", description: "a GitHub pull request was merged" },
  { event: "github.push", provider: "github", providerLabel: "GitHub", label: "Commits land on the default branch", preview: "Starts when commits are pushed to a repo’s default branch", description: "commits were pushed to the default branch" },
  { event: "linear.issue_created", provider: "linear", providerLabel: "Linear", label: "A Linear issue is created", preview: "Starts when a Linear issue is created", description: "a Linear issue was created" },
  { event: "linear.issue_completed", provider: "linear", providerLabel: "Linear", label: "A Linear issue is completed", preview: "Starts when a Linear issue is marked done", description: "a Linear issue was completed" },
] as const;
export type RoutineEventName = (typeof ROUTINE_TRIGGERS)[number]["event"];
export const ROUTINE_EVENT_NAMES = ROUTINE_TRIGGERS.map((trigger) => trigger.event) as [RoutineEventName, ...RoutineEventName[]];

/** The triggers in words, for example "When a GitHub pull request is merged or a Linear issue is created". */
export function describeRoutineTriggers(events: ReadonlyArray<string>): string {
  const labels = ROUTINE_TRIGGERS.filter((trigger) => events.includes(trigger.event)).map((trigger) => trigger.label);
  if (labels.length === 0) return "Only when someone presses Run now";
  return `When ${labels.map((label) => label[0]!.toLowerCase() + label.slice(1)).join(" or ")}`;
}

/** The connections a routine's triggers and access depend on, for example ["github", "slack"]. */
export function routineProviders(config: { events?: ReadonlyArray<string>; postChannels?: unknown; canNotify?: boolean; github?: unknown }): string[] {
  const providers = new Set(ROUTINE_TRIGGERS.filter((trigger) => config.events?.includes(trigger.event)).map((trigger) => trigger.provider as string));
  if (config.postChannels || config.canNotify) providers.add("slack");
  if (config.github) providers.add("github");
  return [...providers].sort();
}

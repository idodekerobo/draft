import { z } from "zod";

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

const githubSchema = z.object({ repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).max(50), access: z.enum(["read", "write"]) }).strict();

const scheduleSchema = z.object({
  preset: z.enum(ROUTINE_PRESETS),
  time: z.string().max(64).optional(),
  weekday: z.enum(ROUTINE_WEEKDAYS).optional(),
  timezone: z.string().max(64).optional(),
}).strict();

export const RoutineInput = z.object({
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(20_000),
  harness: z.string().min(1),
  model: z.string().nullable().optional(),
  schedule: scheduleSchema,
  canNotify: z.boolean().optional(),
  postChannels: z.union([z.literal("joined"), z.array(z.string().min(1).max(80).trim()).max(20)]).optional(),
  github: githubSchema.optional(),
  events: z.array(z.enum(ROUTINE_EVENT_NAMES)).max(10).optional(),
  /** False when only triggers and Run now start the routine. The schedule is kept for when it is turned back on. */
  onSchedule: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).strict();

/** A change to a routine. Schedule fields are flat, as in the HTTP body. Null turns posting or GitHub access off. */
export const RoutinePatch = RoutineInput.omit({ schedule: true, postChannels: true, github: true }).partial().extend({
  ...scheduleSchema.partial().shape,
  postChannels: RoutineInput.shape.postChannels.unwrap().nullable().optional(),
  github: githubSchema.nullable().optional(),
}).strict();
export type RoutineInput = z.infer<typeof RoutineInput>;
export type RoutinePatch = z.infer<typeof RoutinePatch>;

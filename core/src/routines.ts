import { z } from "zod";
import { ROUTINE_EVENT_NAMES, ROUTINE_PRESETS, ROUTINE_WEEKDAYS, routineProviders } from "./routine-triggers";

export * from "./routine-triggers";

export const ROUTINE_ONCE_MAX_DAYS = 365;
export const ROUTINE_DURATION = /^([1-9]\d{0,5})(m|h|d)$/; // "10m", "2h", "3d"

const githubSchema = z.object({ repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).max(50), access: z.enum(["read", "write"]) }).strict();

const scheduleSchema = z.object({
  preset: z.enum(ROUTINE_PRESETS),
  time: z.string().max(64).optional(),
  weekday: z.enum(ROUTINE_WEEKDAYS).optional(),
  timezone: z.string().max(64).optional(),
}).strict();

const cronSchedule = z.object({ cron: z.string().trim().min(9).max(120), timezone: z.string().max(64) }).strict();

/** One delay (`in`), one time (`at`), or a rule with a `schedule` and/or `events`. A null schedule turns it off. */
export const RoutineWhen = z.union([
  z.object({ in: z.string().regex(ROUTINE_DURATION) }).strict(),
  z.object({ at: z.string().datetime({ offset: true }) }).strict(),
  z.object({
    schedule: z.union([scheduleSchema, cronSchedule]).nullable().optional(),
    events: z.array(z.enum(ROUTINE_EVENT_NAMES)).max(10).optional(),
  }).strict(),
]);
export type RoutineWhen = z.infer<typeof RoutineWhen>;

export const RoutineInput = z.object({
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(20_000),
  harness: z.string().min(1).optional(),
  model: z.string().nullable().optional(),
  reasoningEffort: z.string().nullable().optional(),
  when: RoutineWhen,
  canNotify: z.boolean().optional(),
  postChannels: z.union([z.literal("joined"), z.array(z.string().min(1).max(80).trim()).max(20)]).optional(),
  github: githubSchema.optional(),
  enabled: z.boolean().optional(),
}).strict();

/** A change to a routine. Null turns posting or GitHub access off. In a rule, an omitted schedule or events is unchanged. */
export const RoutinePatch = RoutineInput.omit({ postChannels: true, github: true }).partial().extend({
  postChannels: RoutineInput.shape.postChannels.unwrap().nullable().optional(),
  github: githubSchema.nullable().optional(),
}).strict();

export const RoutineListFilter = z.object({
  taskId: z.string().uuid().optional(),
  kind: z.enum(["once", "recurring", "event"]).optional(),
  status: z.enum(["upcoming", "fired"]).optional(),
  createdBy: z.enum(["me", "anyone"]).optional(),
}).strict();

export type RoutineInput = z.infer<typeof RoutineInput>;
export type RoutinePatch = z.infer<typeof RoutinePatch>;
export type RoutineListFilter = z.infer<typeof RoutineListFilter>;

/** The connections a routine needs, from its when rule and its access settings. */
export function routineProvidersForWhen(when: RoutineWhen, access: Omit<Parameters<typeof routineProviders>[0], "events">): string[] {
  return routineProviders({ ...access, events: "events" in when ? when.events : undefined });
}

import { z } from "zod";
import { ROUTINE_EVENT_NAMES, ROUTINE_PRESETS, ROUTINE_WEEKDAYS } from "./routine-triggers";

export * from "./routine-triggers";

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

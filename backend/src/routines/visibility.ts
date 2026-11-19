import type { ScheduledTaskRow } from "../types/tables";

/** A private routine is visible only to the person who made it. A null viewer sees shared routines only. */
export const routineVisibleTo = (task: Pick<ScheduledTaskRow, "visibility" | "created_by_user_id">, viewerId: string | null) =>
  task.visibility !== "private" || (viewerId !== null && task.created_by_user_id === viewerId);

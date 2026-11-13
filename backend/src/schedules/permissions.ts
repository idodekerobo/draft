import { serviceClient } from "../db/client";
import { isAdmin } from "../people/decide";
import type { ScheduledTaskRow } from "../types/tables";

type EditableTask = Pick<ScheduledTaskRow, "task_type" | "created_by_user_id">;

function canEditWith(task: EditableTask, callerId: string, admin: boolean): boolean {
  // Built-in routines belong to the workspace, so any member can tune them.
  if (task.task_type !== "agent_routine") return true;
  return task.created_by_user_id === callerId || admin;
}

/** An agent routine can be changed by the person who made it or by a workspace admin. */
export async function canEditRoutine(callerId: string, task: EditableTask): Promise<boolean> {
  if (canEditWith(task, callerId, false)) return true;
  return isAdmin(serviceClient, callerId);
}

/** One admin lookup for a whole list of routines. */
export async function routineEditChecker(callerId: string): Promise<(task: EditableTask) => boolean> {
  const admin = await isAdmin(serviceClient, callerId);
  return (task) => canEditWith(task, callerId, admin);
}

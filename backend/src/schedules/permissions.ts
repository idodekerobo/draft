import { assertWorkspaceAccess } from "../auth/workspace-access";

// Single seam for who may edit schedules. Any workspace member can today;
// role checks go here.
export function assertCanEditSchedules(workspaceId: string, callerId: string): Promise<Response | null> {
  return assertWorkspaceAccess(workspaceId, callerId);
}

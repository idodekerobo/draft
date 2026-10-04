// Single seam for who may edit schedules. Callers have already verified
// workspace access, and any member can edit today; role checks go here.
export async function canEditSchedules(_workspaceId: string, _callerId: string): Promise<boolean> {
  return true;
}

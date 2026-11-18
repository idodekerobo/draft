// The one place that decides who may change or run a workspace's routines. Callers have
// already checked workspace access, and any member may today; role checks go here.
export async function canEditSchedules(_workspaceId: string, _callerId: string): Promise<boolean> {
  return true;
}

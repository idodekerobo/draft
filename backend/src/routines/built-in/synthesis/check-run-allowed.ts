// Thrown by launchSynthesisRun when checkRunAllowed denies. Callers should
// treat this as "paused," not a failure to retry.
export class RunNotAllowedError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly reason: string,
  ) {
    super(`Synthesis run denied for workspace ${workspaceId}: ${reason}`);
    this.name = "RunNotAllowedError";
  }
}

import { serviceClient } from "../db/client";
import { recordError } from "../errors/record-error";
import { loadSandboxDeploymentConfig } from "../sandbox";
import { startEventRoutines, type StartEventRoutinesInput } from "./start-event-routines";

/**
 * Starts the routines waiting for an event, after the webhook has stored its source. Booting a sandbox takes a
 * while, so the provider gets its answer first, and a routine that fails to start never fails the webhook.
 */
export function fireRoutineEvent(input: StartEventRoutinesInput): void {
  void (async () => {
    await startEventRoutines(serviceClient, loadSandboxDeploymentConfig(), input);
  })().catch((cause) =>
    recordError({ workspaceId: input.workspaceId, operation: "scheduling", message: "Starting event routines failed", code: "event_routines_failed", error: cause }).catch(() => undefined),
  );
}

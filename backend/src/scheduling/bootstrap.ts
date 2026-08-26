import { serviceClient } from "../db/client";
import { loadSandboxDeploymentConfig } from "../sandbox";
import { runSchedulingTick } from "./tick";
import { recordError } from "../errors/record-error";

const TICK_INTERVAL_MS = 30_000;

// setTimeout, not setInterval: dispatch can block up to a minute (Fly
// Machine boot wait), longer than TICK_INTERVAL_MS. setInterval would let a
// second tick start on top of a still-running one and double-dispatch the
// same overdue task.
export function startScheduler(): void {
  const config = loadSandboxDeploymentConfig();

  const runTick = (): void => {
    runSchedulingTick({ client: serviceClient, config })
      .catch((error) => {
        void recordError({
          workspaceId: null,
          operation: "scheduling",
          message: "Scheduling tick failed before task-level dispatch",
          code: "scheduling_tick_failed",
          error,
        });
      })
      .finally(() => {
        setTimeout(runTick, TICK_INTERVAL_MS);
      });
  };

  setTimeout(runTick, TICK_INTERVAL_MS);
}

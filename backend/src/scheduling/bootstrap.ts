import { serviceClient } from "../db/client";
import { loadSandboxDeploymentConfig } from "../sandbox";
import { runSchedulingTick } from "./tick";
import { recordError } from "../errors/record-error";

const TICK_INTERVAL_MS = 30_000;

export function startScheduler(): void {
  const config = loadSandboxDeploymentConfig();

  setInterval(() => {
    runSchedulingTick({ client: serviceClient, config }).catch((error) => {
      void recordError({
        workspaceId: null,
        operation: "scheduling",
        message: "Scheduling tick failed before task-level dispatch",
        code: "scheduling_tick_failed",
        error,
      });
    });
  }, TICK_INTERVAL_MS);
}

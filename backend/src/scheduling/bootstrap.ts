import { serviceClient } from "../db/client";
import { loadSandboxDeploymentConfig } from "../sandbox";
import { runSchedulingTick } from "./tick";

const TICK_INTERVAL_MS = 30_000;

export function startScheduler(): void {
  const config = loadSandboxDeploymentConfig();

  setInterval(() => {
    runSchedulingTick({ client: serviceClient, config }).catch((error) => {
      console.error("scheduling tick failed", error);
    });
  }, TICK_INTERVAL_MS);
}

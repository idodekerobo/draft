import type { SandboxProvider } from "../types";
import type { FlyProviderConfig } from "./config";
import {
  FlyMachinesClient,
  FlyMachineWaitTimeoutError,
  type CreateFlyMachineInput,
  type FlyMachine,
  type FlyMachineState,
  type WaitForStateOptions,
} from "./fly-machines";

const BOOT_TIMEOUT_MS = 60_000;
const SANDBOX_GUEST = {
  cpu_kind: "shared" as const,
  cpus: 1,
  memory_mb: 1024,
};

/** The part of the Fly Machines client the provider uses. A test passes a fake. */
export interface FlyMachinesApi {
  create(input: CreateFlyMachineInput): Promise<FlyMachine>;
  waitForState(machineId: string, desiredState: FlyMachineState, options?: WaitForStateOptions): Promise<FlyMachine>;
  forceDelete(machineId: string): Promise<void>;
}

/** One isolated, one-shot Fly Machine per run. */
export function createFlyProvider(config: FlyProviderConfig, client?: FlyMachinesApi): SandboxProvider {
  const fly: FlyMachinesApi = client ?? new FlyMachinesClient({ app: config.appName, token: config.apiToken });
  return {
    async start(plan) {
      const created = await fly.create({
        image: config.image,
        files: {},
        region: config.region,
        guest: SANDBOX_GUEST,
        metadata: plan.metadata,
        env: plan.env,
      });
      try {
        const machine = await fly.waitForState(created.id, "started", { timeoutMs: BOOT_TIMEOUT_MS });
        return { machineId: machine.id, state: machine.state };
      } catch (error) {
        if (error instanceof FlyMachineWaitTimeoutError) await fly.forceDelete(created.id).catch(() => undefined);
        throw error;
      }
    },
    stop: (machineId) => fly.forceDelete(machineId),
  };
}

import type { SandboxProvider, SandboxSpec, VolumeRef } from "../types";
import type { FlyProviderConfig } from "./config";
import {
  FlyMachinesApiError,
  FlyMachinesClient,
  type CreateFlyMachineInput,
  type CreateFlyVolumeInput,
  type FlyMachine,
  type FlyMachineState,
  type FlyVolume,
  type WaitForStateOptions,
} from "./fly-machines";

const FLY = "fly";
const BOOT_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 60_000;
const VOLUME_PATH = "/data";
// Fly caps memory by CPU count: one shared CPU allows at most 2048 MB, two allow 4096.
const SANDBOX_GUEST = {
  cpu_kind: "shared" as const,
  cpus: 2,
  memory_mb: 4096,
};

/** The part of the Fly Machines client the provider uses. A test passes a fake. */
export interface FlyMachinesApi {
  create(input: CreateFlyMachineInput): Promise<FlyMachine>;
  get(machineId: string): Promise<FlyMachine>;
  start(machineId: string): Promise<void>;
  stop(machineId: string): Promise<void>;
  waitForState(machineId: string, desiredState: FlyMachineState, options?: WaitForStateOptions): Promise<FlyMachine>;
  forceDelete(machineId: string): Promise<void>;
  createVolume(input: CreateFlyVolumeInput): Promise<FlyVolume>;
  getVolume(volumeId: string): Promise<FlyVolume>;
  listByMetadata(key: string, value: string): Promise<FlyMachine[]>;
  deleteVolume(volumeId: string): Promise<void>;
}

/** One isolated, one-shot Fly Machine per run, optionally with a Fly volume mounted at /data. */
export function createFlyProvider(config: FlyProviderConfig, client?: FlyMachinesApi): SandboxProvider {
  const fly: FlyMachinesApi = client ?? new FlyMachinesClient({ app: config.appName, token: config.apiToken });

  const createMachine = (spec: SandboxSpec, region: string, volumeId: string | undefined): Promise<FlyMachine> =>
    fly.create({
      image: config.image,
      files: {},
      region,
      guest: SANDBOX_GUEST,
      metadata: spec.metadata,
      env: spec.env,
      ...(volumeId === undefined ? {} : { mounts: [{ volume: volumeId, path: VOLUME_PATH }] }),
      ...(spec.expose === undefined ? {} : { expose: spec.expose }),
    });
  const deleteMachine = (machineId: string): Promise<void> => ignoreNotFound(fly.forceDelete(machineId));

  return {
    async create(spec) {
      if (spec.volume === undefined) {
        const machine = await createMachine(spec, config.region, undefined);
        return { provider: FLY, machine: machine.id, volume: null };
      }
      if ("existing" in spec.volume) {
        const volume = await fly.getVolume(spec.volume.existing.id);
        const machine = await createMachine(spec, volume.region, volume.id);
        return { provider: FLY, machine: machine.id, volume: volumeRef(volume) };
      }
      const volume = await fly.createVolume({
        name: volumeName(spec.runId),
        region: config.region,
        sizeGb: spec.volume.sizeGb,
      });
      let machine: FlyMachine;
      try {
        machine = await createMachine(spec, volume.region, volume.id);
      } catch (error) {
        return cleanUpOrThrow(error, () => ignoreNotFound(fly.deleteVolume(volume.id)));
      }
      return { provider: FLY, machine: machine.id, volume: volumeRef(volume) };
    },

    async start(ref) {
      try {
        // A new machine boots on its own (state created, then starting); Fly answers 412 to start on it.
        const machine = await fly.get(ref.machine);
        if (machine.state === "stopped" || machine.state === "suspended") await fly.start(ref.machine);
        await fly.waitForState(ref.machine, "started", { timeoutMs: BOOT_TIMEOUT_MS });
      } catch (error) {
        return cleanUpOrThrow(error, () => deleteMachine(ref.machine));
      }
    },

    async stop(ref) {
      await fly.stop(ref.machine);
      await fly.waitForState(ref.machine, "stopped", { timeoutMs: STOP_TIMEOUT_MS });
    },

    async destroy(ref) {
      if (ref.machine) await deleteMachine(ref.machine);
      if (ref.volume !== null) await ignoreNotFound(fly.deleteVolume(ref.volume.id));
    },

    async destroyMachine(ref) {
      if (ref.machine) await deleteMachine(ref.machine);
    },

    async find({ key, value }) {
      const machine = (await fly.listByMetadata(key, value)).find((candidate) => candidate.state !== "destroying" && candidate.state !== "destroyed");
      if (!machine) return null;
      const mounts = (machine.config as { mounts?: Array<{ volume?: string }> } | undefined)?.mounts;
      const volumeId = mounts?.[0]?.volume;
      return { provider: FLY, machine: machine.id, volume: volumeId ? volumeRef(await fly.getVolume(volumeId)) : null };
    },

    // Fly's proxy routes a request with this header to exactly this machine, and starts it when it is stopped.
    endpoint(ref) {
      return { url: `https://${config.appName}.fly.dev`, headers: { "fly-force-instance-id": ref.machine } };
    },

    async status(ref) {
      if (!ref.machine) return "missing";
      let machine: FlyMachine;
      try {
        machine = await fly.get(ref.machine);
      } catch (error) {
        if (isNotFound(error)) return "missing";
        throw error;
      }
      return statusOf(machine);
    },
  };
}

/** Fly volume names allow only lowercase letters, digits and underscores, up to 30 characters. */
function volumeName(runId: string): string {
  return `run_${runId.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`.slice(0, 30);
}

function volumeRef(volume: FlyVolume): VolumeRef {
  return { provider: FLY, id: volume.id, region: volume.region };
}

function statusOf(machine: FlyMachine): "running" | "stopped" | "missing" {
  switch (machine.state) {
    // A stopping machine still counts as running until Fly reports it stopped.
    case "starting":
    case "started":
    case "stopping":
      return "running";
    case "created":
    case "stopped":
    case "suspended":
      return "stopped";
    case "destroying":
    case "destroyed":
      return "missing";
    default:
      throw new Error(`Fly machine ${machine.id} is in state ${machine.state}, which the sandbox provider does not map`);
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof FlyMachinesApiError && error.status === 404;
}

/** A 404 means the machine or volume is already gone, which is what a destroy wants. */
async function ignoreNotFound(operation: Promise<void>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/** Runs the cleanup, then rethrows the original error. If the cleanup also fails, both errors are kept. */
async function cleanUpOrThrow(error: unknown, cleanup: () => Promise<void>): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "Sandbox clean-up failed after an error; both errors are attached");
  }
  throw error;
}

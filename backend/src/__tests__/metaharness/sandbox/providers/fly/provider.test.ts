import { describe, expect, it } from "bun:test";
import {
  FlyMachinesApiError,
  FlyMachineWaitTimeoutError,
  type CreateFlyMachineInput,
  type CreateFlyVolumeInput,
} from "../../../../../metaharness/sandbox/providers/fly/fly-machines";
import { createFlyProvider, type FlyMachinesApi } from "../../../../../metaharness/sandbox/providers/fly/provider";
import type { SandboxRef, SandboxSpec } from "../../../../../metaharness/sandbox/providers";

const config = {
  kind: "fly" as const,
  apiToken: "token",
  appName: "draft-sandbox",
  image: `registry.fly.io/draft@sha256:${"a".repeat(64)}`,
  region: "iad",
};
const spec: SandboxSpec = { runId: "run-1", env: { SECRET: "s" }, metadata: { run_id: "run-1" } };
const plain: SandboxRef = { provider: "fly", machine: "machine-1", volume: null };
const withVolume: SandboxRef = { provider: "fly", machine: "machine-1", volume: { provider: "fly", id: "vol_1", region: "iad" } };

function httpError(status: number): FlyMachinesApiError {
  return new FlyMachinesApiError({ method: "DELETE", url: "https://api.machines.dev/v1/apps/draft-sandbox/machines/machine-1", status });
}

function timeoutError(): FlyMachineWaitTimeoutError {
  return new FlyMachineWaitTimeoutError({ machineId: "machine-1", desiredState: "started", lastState: "starting", timeoutMs: 60_000 });
}

async function errorOf(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}

/** A fake Fly client that records each call in order. Overrides replace one method. */
function fakeApi(overrides: Partial<FlyMachinesApi> = {}) {
  const calls: string[] = [];
  const creates: CreateFlyMachineInput[] = [];
  const volumes: CreateFlyVolumeInput[] = [];
  const api: FlyMachinesApi = {
    create: async (input) => {
      calls.push("create");
      creates.push(input);
      return { id: "machine-1", state: "created" };
    },
    get: async (machineId) => {
      calls.push(`get ${machineId}`);
      return { id: machineId, state: "stopped" };
    },
    start: async (machineId) => {
      calls.push(`start ${machineId}`);
    },
    stop: async (machineId) => {
      calls.push(`stop ${machineId}`);
    },
    waitForState: async (machineId, state) => {
      calls.push(`wait ${machineId} ${state}`);
      return { id: machineId, state };
    },
    forceDelete: async (machineId) => {
      calls.push(`forceDelete ${machineId}`);
    },
    createVolume: async (input) => {
      calls.push(`createVolume ${input.name}`);
      volumes.push(input);
      return { id: "vol_1", region: input.region };
    },
    getVolume: async (volumeId) => {
      calls.push(`getVolume ${volumeId}`);
      return { id: volumeId, region: "ord" };
    },
    deleteVolume: async (volumeId) => {
      calls.push(`deleteVolume ${volumeId}`);
    },
    ...overrides,
  };
  return { api, calls, creates, volumes };
}

describe("createFlyProvider.create", () => {
  it("creates a machine with no mount when the spec has no volume", async () => {
    const { api, calls, creates } = fakeApi();
    const ref = await createFlyProvider(config, api).create(spec);

    expect(ref).toEqual(plain);
    expect(calls).toEqual(["create"]);
    expect(creates[0]).toEqual({
      image: config.image,
      files: {},
      region: "iad",
      guest: { cpu_kind: "shared", cpus: 2, memory_mb: 4096 },
      metadata: { run_id: "run-1" },
      env: { SECRET: "s" },
    });
    expect(creates[0]).not.toHaveProperty("mounts");
  });

  it("creates a volume named from the run and mounts it at /data in its region", async () => {
    const { api, calls, creates, volumes } = fakeApi();
    const ref = await createFlyProvider(config, api).create({ ...spec, runId: "Run-42.x", volume: { sizeGb: 3 } });

    expect(calls).toEqual(["createVolume run_run_42_x", "create"]);
    expect(volumes).toEqual([{ name: "run_run_42_x", region: "iad", sizeGb: 3 }]);
    expect(creates[0]).toMatchObject({ region: "iad", mounts: [{ volume: "vol_1", path: "/data" }] });
    expect(ref).toEqual(withVolume);
  });

  it("truncates a long run id to Fly's 30-character volume name limit", async () => {
    const { api, calls } = fakeApi();
    await createFlyProvider(config, api).create({ ...spec, runId: "a".repeat(40), volume: { sizeGb: 1 } });
    expect(calls[0]).toBe(`createVolume run_${"a".repeat(26)}`);
  });

  it("mounts an existing volume and takes its region from Fly, not from the caller", async () => {
    const { api, calls, creates } = fakeApi();
    const ref = await createFlyProvider(config, api).create({
      ...spec,
      volume: { existing: { provider: "fly", id: "vol_9", region: "iad" } },
    });

    expect(calls).toEqual(["getVolume vol_9", "create"]);
    expect(creates[0]).toMatchObject({ region: "ord", mounts: [{ volume: "vol_9", path: "/data" }] });
    expect(ref.volume).toEqual({ provider: "fly", id: "vol_9", region: "ord" });
  });

  it("deletes the new volume and rethrows when the machine cannot be created", async () => {
    const { api, calls } = fakeApi({
      create: async () => {
        throw new Error("quota exceeded");
      },
    });
    await expect(createFlyProvider(config, api).create({ ...spec, volume: { sizeGb: 1 } })).rejects.toThrow("quota exceeded");
    expect(calls).toEqual(["createVolume run_run_1", "deleteVolume vol_1"]);
  });

  it("keeps both errors when the volume clean-up also fails", async () => {
    const { api } = fakeApi({
      create: async () => {
        throw new Error("quota exceeded");
      },
      deleteVolume: async () => {
        throw new Error("volume busy");
      },
    });
    const error = await errorOf(createFlyProvider(config, api).create({ ...spec, volume: { sizeGb: 1 } }));
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((cause) => (cause as Error).message)).toEqual(["quota exceeded", "volume busy"]);
  });
});

describe("createFlyProvider.start", () => {
  it("starts the machine and waits for it to be started within 60 seconds", async () => {
    const waits: unknown[] = [];
    const { api, calls } = fakeApi({
      waitForState: async (machineId, state, options) => {
        waits.push(options);
        calls.push(`wait ${machineId} ${state}`);
        return { id: machineId, state };
      },
    });

    await createFlyProvider(config, api).start(plain);

    expect(calls).toEqual(["get machine-1", "start machine-1", "wait machine-1 started"]);
    expect(waits).toEqual([{ timeoutMs: 60_000 }]);
  });

  it("destroys the machine, not its volume, and rethrows a boot timeout", async () => {
    const timeout = timeoutError();
    const { api, calls } = fakeApi({
      waitForState: async () => {
        throw timeout;
      },
    });

    await expect(createFlyProvider(config, api).start(withVolume)).rejects.toBe(timeout);
    expect(calls).toEqual(["get machine-1", "start machine-1", "forceDelete machine-1"]);
  });

  it("destroys the machine and rethrows when Fly refuses to start it", async () => {
    const refused = httpError(422);
    const { api, calls } = fakeApi({
      start: async () => {
        throw refused;
      },
    });

    await expect(createFlyProvider(config, api).start(plain)).rejects.toBe(refused);
    expect(calls).toEqual(["get machine-1", "forceDelete machine-1"]);
  });

  it("only waits for a machine that is already booting from create", async () => {
    const { api, calls } = fakeApi({
      get: async (machineId) => {
        calls.push(`get ${machineId}`);
        return { id: machineId, state: "starting" };
      },
    });

    await createFlyProvider(config, api).start(plain);
    expect(calls).toEqual(["get machine-1", "wait machine-1 started"]);
  });

  it("treats a machine that is already gone as cleaned up, and rethrows the boot timeout", async () => {
    const timeout = timeoutError();
    const { api } = fakeApi({
      waitForState: async () => {
        throw timeout;
      },
      forceDelete: async () => {
        throw httpError(404);
      },
    });

    await expect(createFlyProvider(config, api).start(plain)).rejects.toBe(timeout);
  });

  it("keeps both errors when the boot-timeout clean-up fails", async () => {
    const timeout = timeoutError();
    const cleanupError = httpError(500);
    const { api } = fakeApi({
      waitForState: async () => {
        throw timeout;
      },
      forceDelete: async () => {
        throw cleanupError;
      },
    });

    const error = await errorOf(createFlyProvider(config, api).start(plain));
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toBe(timeout);
    expect((error as AggregateError).errors[1]).toBe(cleanupError);
  });
});

describe("createFlyProvider.stop", () => {
  it("stops the machine, waits until it is stopped, and leaves the volume alone", async () => {
    const { api, calls } = fakeApi();
    await createFlyProvider(config, api).stop(withVolume);
    expect(calls).toEqual(["stop machine-1", "wait machine-1 stopped"]);
  });
});

describe("createFlyProvider.destroy", () => {
  it("deletes the machine, then its volume", async () => {
    const { api, calls } = fakeApi();
    await createFlyProvider(config, api).destroy(withVolume);
    expect(calls).toEqual(["forceDelete machine-1", "deleteVolume vol_1"]);
  });

  it("counts a machine or volume that is already gone as destroyed", async () => {
    const { api } = fakeApi({
      forceDelete: async () => {
        throw httpError(404);
      },
      deleteVolume: async () => {
        throw httpError(404);
      },
    });
    await expect(createFlyProvider(config, api).destroy(withVolume)).resolves.toBeUndefined();
  });

  it("keeps the volume when the machine delete fails", async () => {
    const deleted: string[] = [];
    const { api } = fakeApi({
      forceDelete: async () => {
        throw httpError(500);
      },
      deleteVolume: async (volumeId) => {
        deleted.push(volumeId);
      },
    });
    await expect(createFlyProvider(config, api).destroy(withVolume)).rejects.toBeInstanceOf(FlyMachinesApiError);
    expect(deleted).toEqual([]);
  });
});

describe("createFlyProvider.status", () => {
  const cases: Array<[string, "running" | "stopped" | "missing"]> = [
    ["starting", "running"],
    ["started", "running"],
    ["stopping", "running"],
    ["created", "stopped"],
    ["stopped", "stopped"],
    ["suspended", "stopped"],
    ["destroying", "missing"],
    ["destroyed", "missing"],
  ];
  for (const [state, expected] of cases) {
    it(`reports a ${state} machine as ${expected}`, async () => {
      const { api } = fakeApi({ get: async (machineId) => ({ id: machineId, state }) });
      await expect(createFlyProvider(config, api).status(plain)).resolves.toBe(expected);
    });
  }

  it("reports a machine Fly no longer has as missing", async () => {
    const { api } = fakeApi({
      get: async () => {
        throw httpError(404);
      },
    });
    await expect(createFlyProvider(config, api).status(plain)).resolves.toBe("missing");
  });

  it("throws on a state the provider does not map, instead of guessing", async () => {
    const { api } = fakeApi({ get: async (machineId) => ({ id: machineId, state: "failed" }) });
    await expect(createFlyProvider(config, api).status(plain)).rejects.toThrow("in state failed");
  });

  it("rethrows other API errors", async () => {
    const { api } = fakeApi({
      get: async () => {
        throw httpError(500);
      },
    });
    await expect(createFlyProvider(config, api).status(plain)).rejects.toBeInstanceOf(FlyMachinesApiError);
  });
});

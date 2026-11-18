import type { SandboxProvider, SandboxRef } from "../../../../metaharness/sandbox/providers";
import { runProviderConformance } from "./conformance";

/** An in-memory provider. A start marks its machine running, and a destroy of a gone sandbox is not an error. */
function createFakeProvider(): SandboxProvider {
  const machines = new Map<string, "created" | "started" | "stopped">();
  const volumes = new Set<string>();
  const stateOf = (ref: SandboxRef): "created" | "started" | "stopped" => {
    const state = machines.get(ref.machine);
    if (state === undefined) throw new Error(`No machine ${ref.machine}`);
    return state;
  };
  return {
    async create(spec) {
      const machine = crypto.randomUUID();
      machines.set(machine, "created");
      if (spec.volume === undefined) return { provider: "fake", machine, volume: null };
      if ("existing" in spec.volume) {
        if (!volumes.has(spec.volume.existing.id)) throw new Error(`No volume ${spec.volume.existing.id}`);
        return { provider: "fake", machine, volume: spec.volume.existing };
      }
      const id = crypto.randomUUID();
      volumes.add(id);
      return { provider: "fake", machine, volume: { provider: "fake", id, region: "local" } };
    },
    async start(ref) {
      stateOf(ref);
      machines.set(ref.machine, "started");
    },
    async stop(ref) {
      stateOf(ref);
      machines.set(ref.machine, "stopped");
    },
    async destroy(ref) {
      machines.delete(ref.machine);
      if (ref.volume !== null) volumes.delete(ref.volume.id);
    },
    async status(ref) {
      const state = machines.get(ref.machine);
      if (state === undefined) return "missing";
      return state === "started" ? "running" : "stopped";
    },
  };
}

runProviderConformance("fake", createFakeProvider);

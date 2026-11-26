import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComputerServer } from "../../sandbox/computer/server";
import type { SandboxEndpoint, SandboxProvider, SandboxRef, SandboxSpec } from "../../metaharness/sandbox/providers";

interface Machine {
  id: string;
  volume: string;
  token: string;
  metadata: Record<string, string>;
  server: ReturnType<typeof Bun.serve> | null;
  port: number;
}

/**
 * A sandbox provider that runs each machine's computer server in this process, on a temp directory that stands for its volume.
 * A stopped machine has no server, a deleted machine is gone, and a volume outlives its machine: what the real thing does.
 */
export class LocalProvider implements SandboxProvider {
  readonly calls: string[] = [];
  readonly machines = new Map<string, Machine>();
  readonly volumes = new Map<string, string>();
  #n = 0;

  async create(spec: SandboxSpec): Promise<SandboxRef> {
    this.calls.push("create");
    const volumeId = spec.volume && "existing" in spec.volume ? spec.volume.existing.id : `vol-${++this.#n}`;
    if (spec.volume && "existing" in spec.volume && !this.volumes.has(volumeId)) throw new Error("volume is gone");
    if (!this.volumes.has(volumeId)) this.volumes.set(volumeId, await mkdtemp(join(tmpdir(), "local-volume-")));
    const id = `machine-${++this.#n}`;
    this.machines.set(id, { id, volume: volumeId, token: spec.env.DRAFT_COMPUTER_TOKEN ?? "", metadata: spec.metadata, server: null, port: 0 });
    return { provider: "local", machine: id, volume: { provider: "local", id: volumeId, region: "here" } };
  }

  async start(ref: SandboxRef): Promise<void> {
    this.calls.push("start");
    const machine = this.machines.get(ref.machine)!;
    if (machine.server) return;
    const dir = this.volumes.get(machine.volume)!;
    const computer = createComputerServer({ token: machine.token, root: join(dir, "workspace"), stateDir: join(dir, "state") });
    await computer.recover();
    machine.server = Bun.serve({ port: machine.port, hostname: "127.0.0.1", fetch: computer.fetch });
    machine.port = machine.server.port ?? 0;
  }

  async stop(ref: SandboxRef): Promise<void> {
    this.calls.push("stop");
    const machine = this.machines.get(ref.machine);
    await machine?.server?.stop(true);
    if (machine) machine.server = null;
  }

  async destroy(ref: SandboxRef): Promise<void> {
    this.calls.push("destroy");
    await this.destroyMachine(ref);
    if (ref.volume) {
      const dir = this.volumes.get(ref.volume.id);
      this.volumes.delete(ref.volume.id);
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }

  async destroyMachine(ref: SandboxRef): Promise<void> {
    await this.stop(ref);
    this.machines.delete(ref.machine);
  }

  async status(ref: SandboxRef): Promise<"running" | "stopped" | "missing"> {
    const machine = this.machines.get(ref.machine);
    return !machine ? "missing" : machine.server ? "running" : "stopped";
  }

  endpoint(ref: SandboxRef): SandboxEndpoint {
    return { url: `http://127.0.0.1:${this.machines.get(ref.machine)?.port ?? 0}`, headers: {} };
  }

  async find({ key, value }: { key: string; value: string }): Promise<SandboxRef | null> {
    const machine = [...this.machines.values()].find((candidate) => candidate.metadata[key] === value);
    return machine ? { provider: "local", machine: machine.id, volume: { provider: "local", id: machine.volume, region: "here" } } : null;
  }

  /** Removes every machine and volume, for the end of a test. */
  async dispose(): Promise<void> {
    for (const machine of this.machines.values()) await machine.server?.stop(true);
    for (const dir of this.volumes.values()) await rm(dir, { recursive: true, force: true });
    this.machines.clear();
    this.volumes.clear();
  }
}

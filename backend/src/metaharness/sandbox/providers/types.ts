/** A volume that outlives one machine. */
export type VolumeRef = { provider: string; id: string; region: string };

/** Everything a provider needs to create one sandbox. It holds no provider detail: no image, region or machine size. */
export interface SandboxSpec {
  runId: string;
  /** The environment the runner starts with. It holds secrets, so a provider never logs it. */
  env: Record<string, string>;
  metadata: Record<string, string>;
  volume?: { sizeGb: number } | { existing: VolumeRef };
}

/** A sandbox that exists but may not be running. */
export interface SandboxRef {
  provider: string;
  machine: string;
  volume: VolumeRef | null;
}

/** A place that runs one-shot sandboxes. Fly today; others add one folder under providers. */
export interface SandboxProvider {
  /** Creates the machine, and its volume if the spec asks for one. The machine is not started. */
  create(spec: SandboxSpec): Promise<SandboxRef>;
  /** Returns when the sandbox is started. A sandbox that does not start is destroyed, and the error is thrown. */
  start(ref: SandboxRef): Promise<void>;
  /** Stops the machine and keeps its volume. Returns when the machine is stopped. */
  stop(ref: SandboxRef): Promise<void>;
  /** Deletes the machine and its volume. A machine or volume that is already gone counts as deleted. */
  destroy(ref: SandboxRef): Promise<void>;
  /** Deletes only the machine, so its volume can mount a new machine. A machine that is already gone counts as deleted. */
  destroyMachine(ref: SandboxRef): Promise<void>;
  status(ref: SandboxRef): Promise<"running" | "stopped" | "missing">;
}

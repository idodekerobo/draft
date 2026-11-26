/** A volume that outlives one machine. */
export type VolumeRef = { provider: string; id: string; region: string };

/** Everything a provider needs to create one sandbox. It holds no provider detail: no image, region or machine size. */
export interface SandboxSpec {
  runId: string;
  /** The environment the runner starts with. It holds secrets, so a provider never logs it. */
  env: Record<string, string>;
  metadata: Record<string, string>;
  volume?: { sizeGb: number } | { existing: VolumeRef };
  /** A port the sandbox serves to the backend, such as Home's computer server. A provider that cannot expose one omits `endpoint`. */
  expose?: { port: number };
}

/** Where the backend reaches a sandbox's exposed port, and any headers the request needs to reach this sandbox and no other. */
export interface SandboxEndpoint {
  url: string;
  headers: Record<string, string>;
}

/** A sandbox that exists but may not be running. */
export interface SandboxRef {
  provider: string;
  /** Empty once the machine is deleted. Then only the volume is left. */
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
  /** Deletes the machine and its volume. A machine or volume that is already gone counts as deleted, and an empty machine id skips the machine. */
  destroy(ref: SandboxRef): Promise<void>;
  /** Deletes only the machine, so its volume can mount a new machine. A machine that is already gone counts as deleted. */
  destroyMachine(ref: SandboxRef): Promise<void>;
  status(ref: SandboxRef): Promise<"running" | "stopped" | "missing">;
  /** The address of a port the sandbox exposes. Absent for a provider that cannot expose one. The backend still checks the machine's token. */
  endpoint?(ref: SandboxRef, port: number): SandboxEndpoint;
}

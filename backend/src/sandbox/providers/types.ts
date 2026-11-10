/** Everything a provider needs to start one run. The plan holds no provider detail: no image, region or machine size. */
export interface SandboxPlan {
  runId: string;
  bundleHash: string;
  /** The environment the runner starts with. It holds secrets, so a provider never logs it. */
  env: Record<string, string>;
  metadata: Record<string, string>;
}

export interface SandboxStart {
  machineId: string;
  state: string;
}

/** A place that runs one-shot sandboxes. Fly today; others add one folder under providers. */
export interface SandboxProvider {
  /** Starts the sandbox and returns when it is running. Cleans up a sandbox that does not start in time. */
  start(plan: SandboxPlan): Promise<SandboxStart>;
  stop(machineId: string): Promise<void>;
}

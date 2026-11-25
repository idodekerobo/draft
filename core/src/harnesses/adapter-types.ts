/** Where Draft sends a run: an already-registered host, a sandbox Draft starts, or Draft's own backend. */
export type ExecutionTargetType = "host" | "sandbox" | "backend";

/** What an adapter can do in a session. Availability on one host, such as a terminal, is reported at run time. */
export interface AdapterCapabilities {
  terminal: boolean;
  approvals: boolean;
  steer: boolean;
}

/** One way Draft runs a harness. The id is stored on sessions and runs. */
export interface AdapterDefinition {
  id: string;
  harness: string;
  /** Whether a person drives it in a live session, or a routine runs it once. */
  kind: "interactive" | "routine";
  targets: ReadonlyArray<ExecutionTargetType>;
  capabilities: AdapterCapabilities;
  /** How the backend gets events: it parses the harness's CLI output lines, or the adapter emits events itself. */
  eventPath: "lines" | "events";
  /** False for an adapter that is registered so a spec can name it, but has no launcher yet. */
  launchable: boolean;
  /** Every built-in tool name the harness knows. */
  nativeTools: ReadonlyArray<string>;
  /** The built-in tools a sandbox run may be given. Empty when the adapter does not run in a sandbox. */
  cloudNativeTools: ReadonlyArray<string>;
}

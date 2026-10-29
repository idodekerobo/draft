import type { HarnessId } from "draft-core/harnesses";
import type { HostEvent } from "./approvals";
import type { ControlInput } from "./controls";
import type { HostSessionState } from "./cursor-store";
import type { ForwardedLine } from "./forwarder";
import type { PendingInput } from "./input-delivery";

export type HostInput = PendingInput | ControlInput;

/** What a driver may use from the runner that owns it. */
export interface DriverHost {
  /** Server path of the session, without a leading slash. */
  readonly base: string;
  state(): HostSessionState;
  persist(patch: Partial<HostSessionState>): void;
  postLines(lines: ForwardedLine[]): Promise<void>;
  postHostEvents(events: HostEvent[]): Promise<void>;
  setInputState(id: string, from: Array<"queued" | "delivering">, to: string, reason?: string): Promise<boolean>;
  /** A server error after which forwarding cannot continue. */
  isFatal(error: unknown): boolean;
  onFatal(error: unknown): void;
  reportError(what: string, error: unknown): void;
  /** The harness finished a turn, so raw files may have changed. */
  requestUpload(): void;
}

/** Runs one session on this computer. The runner keeps the heartbeat, the input polling and the state. */
export interface HarnessDriver {
  /** Begins forwarding lines and closes approvals an earlier run left open. */
  start(): void;
  /** Stops forwarding. The process may still run. */
  halt(): void;
  /** Stops forwarding and releases what the driver registered. */
  dispose(): void;
  isAlive(): Promise<boolean>;
  /** Forwards what is left. True when all of it reached the server. */
  flush(): Promise<boolean>;
  /** One pass while the process runs: control actions and message delivery. */
  serve(inputs: HostInput[]): Promise<void>;
  /** The native session id the pane moved to after /clear or /fork, or null. */
  rotationTarget(): string | null;
  clearRotation(): void;
  /** Forwards new lines while the process still runs. True when all of it reached the server. */
  refresh(): Promise<boolean>;
  /** Uploads what is left for the record. True when nothing more is needed. */
  finalize(): Promise<boolean>;
  /** Ends the harness the way its own CLI exits, so its end-of-session work runs. */
  stop(): Promise<void>;
  /** Opens the user's terminal app on the running session. */
  openInTerminal(): Promise<{ ok: true } | { ok: false; error: string }>;
}

/** A launch failure whose message is safe to show the person. */
export class LaunchError extends Error {}

export type CheckResult = { ok: true; bin: string; version: string | null } | { ok: false; error: string };

/** What starting a session needs from a harness, before the driver exists. */
export interface HarnessLauncher {
  readonly id: HarnessId;
  check(): Promise<CheckResult>;
  /** Starts the harness in the folder. Returns the state fields only this harness has. */
  launch(input: { sessionId: string; folderPath: string; model: string | null; bin: string; nativeSessionId: string }): Promise<Partial<HostSessionState>>;
  /** The native session id to send when the session is created. Empty when only the harness knows it. */
  newNativeSessionId(): string;
  /** Shown when `launch` throws. */
  readonly launchFailedMessage: string;
}

export interface HarnessRegistration {
  launcher: HarnessLauncher;
  createDriver(host: DriverHost): HarnessDriver;
}

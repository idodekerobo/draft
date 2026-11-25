import type { SessionMcpConnection } from "./drivers/harness-driver";
import type { CaptureResult } from "../exec";

/** API failure with the server's error code and, for validation errors, the offending field. */
export class ServerError extends Error {
  constructor(readonly code: string, readonly field?: string, readonly detail?: Record<string, unknown>) {
    super(code);
  }
}

/** The login is dead and the user must sign in again. */
export class SessionExpiredError extends Error {
  constructor() {
    super("session_expired");
    this.name = "SessionExpiredError";
  }
}

/** What the session host needs from the app that runs it. The desktop app supplies the real ones; tests supply fakes. */
export interface HostServices {
  fetchServer(path: string, init?: RequestInit): Promise<Response>;
  fetchServerJSON<T>(path: string, init?: RequestInit): Promise<T>;
  realtime: {
    connected(): boolean;
    watch(topic: string, listener: (event: string, payload?: unknown) => void): () => void;
    send(topic: string, event: string, payload: unknown): void;
  };
  capture(argv: string[], options?: { timeoutMs?: number; env?: Record<string, string>; cwd?: string }): Promise<CaptureResult>;
  /** Runs the command in the user's terminal app. `name` labels the script file. */
  openInTerminal(name: string, command: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Null until someone signs in. */
  workspaceId(): string | null;
  hostId(): string;
  prepareMcp?(sessionId: string, workspaceId: string, hostId: string, endpointId?: string): Promise<SessionMcpConnection | undefined>;
  transferMcp?(fromSessionId: string, sessionId: string, workspaceId: string, hostId: string): Promise<void>;
  releaseMcp?(sessionId: string): void;
  mcpProblem?(sessionId: string): void;
}

let installed: HostServices | null = null;

/** Called once at startup by the app that runs the host. */
export function installHostServices(services: HostServices): void {
  installed = services;
}

export function hostServices(): HostServices {
  if (!installed) throw new Error("host_services_not_installed");
  return installed;
}

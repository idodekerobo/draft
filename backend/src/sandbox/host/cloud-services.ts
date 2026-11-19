import { capture, type CaptureResult } from "draft-core/exec";
import { ServerError, SessionExpiredError, type HostServices } from "draft-core/host/services";
import { cloudHostId, type HostConfig } from "./config";
import { hostLog } from "./log";

/** No answer came back: a connection or DNS failure. Startup retries it. */
export class TransportError extends Error {
  constructor(cause: unknown) {
    super(`transport_failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "TransportError";
  }
}

/** A server answer that failed, with its HTTP status. The status decides whether a startup retry is worth it. */
export class HttpStatusError extends ServerError {
  constructor(code: string, readonly status: number, field?: string, detail?: Record<string, unknown>) {
    super(code, field, detail);
  }
}

export interface ServiceDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
  capture(argv: string[], options?: { timeoutMs?: number; env?: Record<string, string>; cwd?: string }): Promise<CaptureResult>;
}

export const liveServiceDeps: ServiceDeps = {
  fetch: (url, init) => fetch(url, init),
  capture: (argv, options) => capture(argv, options),
};

/**
 * The host services for a sandbox. Every backend call carries the run token. There is no Realtime in v1, so the
 * session host polls for inputs instead.
 */
export function buildHostServices(config: Pick<HostConfig, "apiBase" | "runToken" | "sessionId" | "workspaceId">, deps: ServiceDeps = liveServiceDeps): HostServices {
  const fetchServer = async (path: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${config.runToken}`);
    if (typeof init?.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await deps.fetch(`${config.apiBase}/${path}`, { ...init, headers });
    } catch (error) {
      throw new TransportError(error);
    }
    if (response.ok) return response;
    // A rejected run token cannot recover by retrying, so the session host pauses instead.
    if (response.status === 401) {
      hostLog("error", "run_token_rejected", { path });
      throw new SessionExpiredError();
    }
    throw await serverError(response);
  };

  return {
    fetchServer,
    fetchServerJSON: async <T>(path: string, init?: RequestInit): Promise<T> => (await (await fetchServer(path, init)).json()) as T,
    realtime: {
      connected: () => false,
      watch: () => () => {},
      send: () => {},
    },
    capture: (argv, options) => deps.capture(argv, options),
    openInTerminal: async () => {
      throw new Error("openInTerminal is not available in a cloud session");
    },
    workspaceId: () => config.workspaceId,
    hostId: () => cloudHostId(config.sessionId),
  };
}

async function serverError(response: Response): Promise<HttpStatusError> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the status is the only code the server gave.
    return new HttpStatusError(`request_failed_${response.status}`, response.status);
  }
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const code = typeof record.error === "string" && record.error ? record.error : `request_failed_${response.status}`;
  return new HttpStatusError(code, response.status, typeof record.field === "string" ? record.field : undefined, record);
}

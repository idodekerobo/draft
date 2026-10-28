import { AuthRefreshError, getFreshAccessToken } from "draft-core/auth-state";

export const apiUrl = process.env.DRAFT_API_BASE_URL ?? "https://api.draftai.us";

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

export interface SessionExpiredCause {
  error?: unknown;
  apiStatus?: number;
}

let onSessionExpired: ((cause: SessionExpiredCause) => void) | null = null;

/** Registers the one place that signs the user out when a request finds a dead login. */
export function setSessionExpiredHandler(handler: ((cause: SessionExpiredCause) => void) | null): void {
  onSessionExpired = handler;
}

export interface ServerFetchDeps {
  token(forceRefresh: boolean): Promise<string>;
  fetch(input: string, init: RequestInit): Promise<Response>;
}

function defaultDeps(): ServerFetchDeps {
  return {
    token: (forceRefresh) => getFreshAccessToken({
      supabaseUrl: process.env.DRAFT_SUPABASE_URL ?? "",
      publishableKey: process.env.DRAFT_SUPABASE_PUBLISHABLE_KEY ?? "",
      forceRefresh,
    }),
    fetch: (input, init) => fetch(input, init),
  };
}

function expireSession(cause: SessionExpiredCause): never {
  onSessionExpired?.(cause);
  throw new SessionExpiredError();
}

export function createServerFetch(deps: ServerFetchDeps = defaultDeps()) {
  const send = async (path: string, init: RequestInit | undefined, forceRefresh: boolean) => {
    const accessToken = await deps.token(forceRefresh);
    return deps.fetch(`${apiUrl}/${path}`, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${accessToken}` },
    });
  };

  return async function fetchServer(path: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await send(path, init, false);
      // The token may have expired between the check and the call; one forced refresh rules that out.
      if (response.status === 401) response = await send(path, init, true);
    } catch (error) {
      const terminal = error instanceof AuthRefreshError && error.kind === "terminal";
      if (terminal || (error instanceof Error && error.message === "not_signed_in")) expireSession({ error });
      throw error;
    }
    if (response.status === 401) expireSession({ apiStatus: response.status });
    if (!response.ok) {
      let message = `request_failed_${response.status}`;
      let field: string | undefined;
      let detail: Record<string, unknown> | undefined;
      try {
        const body = await response.json() as { error?: unknown; field?: unknown };
        detail = body as Record<string, unknown>;
        if (typeof body.error === "string" && body.error.length > 0) message = body.error;
        if (typeof body.field === "string") field = body.field;
      } catch { /* body wasn't JSON — keep the status-based fallback */ }
      throw new ServerError(message, field, detail);
    }
    return response;
  };
}

export const fetchServer = createServerFetch();

export async function fetchServerJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchServer(path, init);
  return response.json() as Promise<T>;
}

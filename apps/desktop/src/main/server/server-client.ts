import { getFreshAccessToken } from "draft-core/auth-state";

export const apiUrl = process.env.DRAFT_API_BASE_URL ?? "https://api.draftai.us";

/** API failure with the server's error code and, for validation errors, the offending field. */
export class ServerError extends Error {
  constructor(readonly code: string, readonly field?: string) {
    super(code);
  }
}

export async function fetchServer(path: string, init?: RequestInit): Promise<Response> {
  const accessToken = await getFreshAccessToken({
    supabaseUrl: process.env.DRAFT_SUPABASE_URL ?? "",
    publishableKey: process.env.DRAFT_SUPABASE_PUBLISHABLE_KEY ?? "",
  });
  const response = await fetch(`${apiUrl}/${path}`, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    let message = `request_failed_${response.status}`;
    let field: string | undefined;
    try {
      const body = await response.json() as { error?: unknown; field?: unknown };
      if (typeof body.error === "string" && body.error.length > 0) message = body.error;
      if (typeof body.field === "string") field = body.field;
    } catch { /* body wasn't JSON — keep the status-based fallback */ }
    throw new ServerError(message, field);
  }
  return response;
}

export async function fetchServerJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchServer(path, init);
  return response.json() as Promise<T>;
}

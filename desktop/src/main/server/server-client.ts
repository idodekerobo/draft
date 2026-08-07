import { getFreshAccessToken } from "draft-core/auth-state";

const apiUrl = process.env.DRAFT_API_BASE_URL ?? "https://api.draftai.us";

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
    // Every route in this backend returns { error: "<code>" } on failure —
    // surface that code as the thrown message instead of a generic one, so
    // callers' catch blocks (which do `err.message`) show something useful.
    let message = `request_failed_${response.status}`;
    try {
      const body = await response.json() as { error?: unknown };
      if (typeof body.error === "string" && body.error.length > 0) message = body.error;
    } catch { /* body wasn't JSON — keep the status-based fallback */ }
    throw new Error(message);
  }
  return response;
}

export async function fetchServerJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchServer(path, init);
  return response.json() as Promise<T>;
}

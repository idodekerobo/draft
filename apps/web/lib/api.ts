import { API_URL } from "@/lib/config";
import { createClient } from "@/lib/supabase/client";

/** status 0 means the request never reached the API. */
export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const {
    data: { session },
  } = await createClient().auth.getSession();
  if (!session) throw new ApiError(401, "signed_out");

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, "network");
  }

  const body = await response.json().catch(() => null) as ({ error?: unknown } & Record<string, unknown>) | null;
  if (!response.ok) {
    throw new ApiError(response.status, typeof body?.error === "string" ? body.error : `http_${response.status}`);
  }
  return body as T;
}

import { ApiError } from "@/lib/api-error";
import { API_URL } from "@/lib/config";

/** Calls the API with a bearer token. Throws ApiError on network or HTTP failure. */
export async function requestApi<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, "network");
  }

  const body = await response.json().catch(() => null) as ({ error?: unknown } & Record<string, unknown>) | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof body?.error === "string" ? body.error : `http_${response.status}`,
      typeof body?.field === "string" ? body.field : undefined,
    );
  }
  return body as T;
}

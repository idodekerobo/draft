import { ApiError } from "@/lib/api-error";
import { API_URL } from "@/lib/config";

async function send(path: string, token: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_URL}${path}`, {
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
}

function toApiError(response: Response, body: ({ error?: unknown } & Record<string, unknown>) | null): ApiError {
  return new ApiError(
    response.status,
    typeof body?.error === "string" ? body.error : `http_${response.status}`,
    typeof body?.field === "string" ? body.field : undefined,
  );
}

/** Calls the API with a bearer token. Throws ApiError on network or HTTP failure. */
export async function requestApi<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await send(path, token, init);
  const body = await response.json().catch(() => null) as ({ error?: unknown } & Record<string, unknown>) | null;
  if (!response.ok) throw toApiError(response, body);
  return body as T;
}

/** Like requestApi, for endpoints that return a file. fileName comes from Content-Disposition. */
export async function requestApiBlob(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<{ blob: Blob; fileName: string | null }> {
  const response = await send(path, token, init);
  if (!response.ok) {
    throw toApiError(response, await response.json().catch(() => null));
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? null;
  return { blob: await response.blob(), fileName };
}

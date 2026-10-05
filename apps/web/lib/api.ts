import { ApiError } from "@/lib/api-error";
import { requestApi, requestApiBlob } from "@/lib/api-request";
import { createClient } from "@/lib/supabase/client";

export { ApiError };

async function accessToken(): Promise<string> {
  const {
    data: { session },
  } = await createClient().auth.getSession();
  if (!session) throw new ApiError(401, "signed_out");
  return session.access_token;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  return requestApi<T>(path, await accessToken(), init);
}

export async function apiFetchBlob(path: string, init: RequestInit = {}) {
  return requestApiBlob(path, await accessToken(), init);
}

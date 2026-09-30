import { ApiError } from "@/lib/api-error";
import { requestApi } from "@/lib/api-request";
import { createClient } from "@/lib/supabase/client";

export { ApiError };

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const {
    data: { session },
  } = await createClient().auth.getSession();
  if (!session) throw new ApiError(401, "signed_out");
  return requestApi<T>(path, session.access_token, init);
}

import { cache } from "react";
import { API_URL } from "@/lib/config";
import { createClient } from "@/lib/supabase/server";
import type { Identity } from "@/lib/identity";

export type ServerIdentity =
  | { state: "signed_out" }
  | { state: "api_down" }
  | { state: "ok"; identity: Identity };

/** Once per request, shared by nested layouts. */
export const getServerIdentity = cache(async (): Promise<ServerIdentity> => {
  const client = await createClient();
  const {
    data: { session },
  } = await client.auth.getSession();
  if (!session) return { state: "signed_out" };
  try {
    const response = await fetch(`${API_URL}/whoami`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
      cache: "no-store",
    });
    if (response.status === 401) return { state: "signed_out" };
    if (!response.ok) return { state: "api_down" };
    return { state: "ok", identity: (await response.json()) as Identity };
  } catch {
    return { state: "api_down" };
  }
});

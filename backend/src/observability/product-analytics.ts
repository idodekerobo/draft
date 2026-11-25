import type { UserCallSurface } from "draft-core/tools";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

export type RoutineProductEvent = "routine_created" | "routine_updated" | "routine_deleted" | "routine_run_requested" | "routine_run_completed";
export type NotificationProductEvent = "notification_created" | "notification_done" | "notification_not_mine" | "notification_undone";
export type ProductEvent = RoutineProductEvent | NotificationProductEvent;
export interface RoutineAttribution {
  via?: UserCallSurface | "run" | "system";
}

export function eventUuid(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Optional analytics must never fail a mutation or publish content from its arguments. */
export async function captureProductEvent(
  client: SupabaseClient,
  event: ProductEvent,
  input: { userId: string | null; workspaceId: string; key: string; properties: Record<string, string | number | boolean | null | undefined>; timestamp?: string },
  options: { key?: string; host?: string; send?: typeof fetch } = {},
): Promise<void> {
  const key = options.key ?? process.env.POSTHOG_KEY ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key || !input.userId) return;
  try {
    const { data, error } = await client.from("users").select("analytics_consent").eq("id", input.userId).abortSignal(AbortSignal.timeout(1500)).maybeSingle();
    if (error || data?.analytics_consent !== true) return;
    const host = options.host ?? process.env.POSTHOG_HOST ?? process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";
    const response = await (options.send ?? fetch)(`${host.replace(/\/$/, "")}/i/v0/e/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(1500),
      body: JSON.stringify({
        api_key: key,
        uuid: eventUuid(`${event}:${input.key}`),
        distinct_id: input.userId,
        event,
        timestamp: input.timestamp ?? new Date().toISOString(),
        properties: { ...input.properties, workspace_id: input.workspaceId, emitter: "backend", occurrence_id: `${event}:${input.key}` },
      }),
    });
    if (!response.ok) console.error(JSON.stringify({ source: "product_analytics", event, status: response.status }));
  } catch {
    console.error(JSON.stringify({ source: "product_analytics", event, error: "capture_failed" }));
  }
}

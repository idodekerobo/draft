import type { SupabaseClient } from "@supabase/supabase-js";
import { recordError } from "../../errors/record-error";
import { emailStatusFromResend, mergeEmailStatus, type EmailStatus } from "../channels/email/status";
import { getResendEmail, type ResendDeps } from "../channels/email/resend";
const FINAL_EMAIL_STATUSES: ReadonlyArray<EmailStatus> = ["failed", "bounced", "complained"];
export type StatusOptions = { statusApiKey?: () => string | undefined; resend?: ResendDeps; agentRunId?: string | null };
export async function loadDeliveryStatus(client: SupabaseClient, notification: { id: string; workspaceId: string; created_at: string }, options: StatusOptions) {
  const { data: rows, error: deliveriesError } = await client
    .from("notification_deliveries")
    .select("id, channel, status, provider_message_id, accepted_at, delivered_at, error_code")
    .eq("notification_id", notification.id)
    .eq("workspace_id", notification.workspaceId)
    .order("created_at", { ascending: true });
  if (deliveriesError) throw deliveriesError;
  const deliveries = (rows ?? []) as Array<{ id: string; channel: string; status: EmailStatus; provider_message_id: string | null; accepted_at: string | null; delivered_at: string | null; error_code: string | null }>;

  let refreshed = true;
  const key = options.statusApiKey?.();
  for (const delivery of deliveries) {
    if (delivery.status === "queued" && !delivery.provider_message_id) { refreshed = false; continue; }
    if (delivery.channel !== "email" || !delivery.provider_message_id || FINAL_EMAIL_STATUSES.includes(delivery.status)) continue;
    if (!key) { refreshed = false; continue; }
    try {
      const latest = await getResendEmail(key, delivery.provider_message_id, options.resend);
      const next = mergeEmailStatus(delivery.status, emailStatusFromResend(latest.lastEvent));
      if (next === delivery.status) continue;
      const now = new Date().toISOString();
      const { error: updateError } = await client.from("notification_deliveries").update({ status: next, last_event_at: now, ...(next === "delivered" ? { delivered_at: now } : {}) }).eq("id", delivery.id).eq("workspace_id", notification.workspaceId);
      if (updateError) throw updateError;
      delivery.status = next;
      if (next === "delivered") delivery.delivered_at = now;
    } catch (refreshError) {
      refreshed = false;
      await recordError({ client, workspaceId: notification.workspaceId, agentRunId: options.agentRunId ?? null, operation: "delivery", code: "notify_status_refresh_failed", message: "people.notification_status could not refresh a delivery", detail: { channel: delivery.channel }, error: refreshError });
    }
  }

  return {
    notificationId: notification.id,
    createdAt: notification.created_at,
    refreshed,
    deliveries: deliveries.map((delivery) => ({ channel: delivery.channel, status: delivery.status, acceptedAt: delivery.accepted_at, deliveredAt: delivery.delivered_at, errorCode: delivery.error_code })),
  };

}

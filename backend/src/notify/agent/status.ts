import type { SupabaseClient } from "@supabase/supabase-js";
import { findToolPermission, type ToolCaller } from "draft-core/tools";
import { loadDeliveryStatus, type StatusOptions } from "../delivery/status";
import { messageFailure, type MessageResult } from "./result";
export async function agentNotificationStatus(client: SupabaseClient, caller: ToolCaller, input: { notificationId: string }, options: StatusOptions): Promise<MessageResult<Awaited<ReturnType<typeof loadDeliveryStatus>>>> {
  if (caller.origin.kind === "run" && !findToolPermission(caller.origin.run, "people.notification_status")) return messageFailure("not_permitted", "This run may not read notification status.");
  const workspaceId = caller.workspaceId;
  const origin = caller.origin;
  const callerUserId = origin.kind === "run" ? origin.run.onBehalfOf : origin.userId;

  const { data: found, error } = await client
    .from("notifications")
    .select("id, recipient_person_id, sender_user_id, visibility, agent_run_id, created_at")
    .eq("id", input.notificationId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  const notification = found as { id: string; recipient_person_id: string; sender_user_id: string | null; visibility: string; agent_run_id: string | null; created_at: string } | null;
  const notFound = messageFailure("not_found", "No notification with that id that you can see.");
  if (!notification) return notFound;

  // A private notification is read by its sender, the run that made it, and its recipient. Anyone else gets the same answer as for a missing one.
  let allowed = notification.visibility === "shared" || (callerUserId !== null && notification.sender_user_id === callerUserId) || (origin.kind === "run" && notification.agent_run_id === origin.run.id);
  if (!allowed && callerUserId) {
    const { data: recipient, error: recipientError } = await client.from("people").select("user_id").eq("id", notification.recipient_person_id).eq("workspace_id", workspaceId).maybeSingle();
    if (recipientError) throw recipientError;
    allowed = (recipient as { user_id: string | null } | null)?.user_id === callerUserId;
  }
  if (!allowed) return notFound;

  const output = await loadDeliveryStatus(client, { ...notification, workspaceId }, { ...options, agentRunId: origin.kind === "run" ? origin.run.id : null });
  return { ok: true, output, summary: output.deliveries.map((entry) => `${entry.channel}: ${entry.status}`).join(", ") };
}

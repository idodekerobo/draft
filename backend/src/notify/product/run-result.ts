import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotifyChannelId } from "draft-core/notify";
import { recordError } from "../../errors/record-error";
import type { NotifyChannel } from "../delivery/types";
import { recipientPersonIds } from "./credential-attention";

/**
 * Tells the workspace's admins that a run of the workspace's context update failed. Only a failure sends one: a notice
 * every night for a success would teach people to ignore Needs you. The key names the run and the person, so a repeat sends nothing new.
 */
export async function notifyAdminsOfFailedRun(client: SupabaseClient, channels: Record<NotifyChannelId, NotifyChannel>, run: { id: string; workspace_id: string }): Promise<void> {
  const { deliverNotification } = await import("../delivery/deliver");
  const { isFailure, resolvePerson } = await import("../delivery/resolve-person");
  for (const personId of await recipientPersonIds(client, run.workspace_id, null)) {
    const recipient = await resolvePerson(client, run.workspace_id, personId);
    if (isFailure(recipient)) continue;
    try {
      const result = await deliverNotification(client, channels, recipient, {
        subject: "A context update failed",
        text: "A run of the workspace's context update did not finish. Open the run to see why.",
        attribution: "Sent by Draft · Context update",
        action: { kind: "run_result", refType: "agent_run", refId: run.id },
        idempotencyKey: `run_result:${run.id}:${recipient.id}`,
        origin: { senderUserId: null, agentRunId: null, scheduledTaskId: null },
      });
      if (!result.ok) throw new Error(result.code);
    } catch (cause) {
      await recordError({ client, workspaceId: run.workspace_id, agentRunId: run.id, operation: "delivery", code: "product_notification_failed", message: "Failed-run notice could not be recorded", detail: { recipientPersonId: recipient.id }, error: cause });
    }
  }
}

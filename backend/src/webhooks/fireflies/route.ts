import { ingestFirefliesMeeting } from "../../ingestion/fireflies/normalize";
import { authenticateFirefliesWebhookRequest, FirefliesWebhookAuthError } from "./request-auth";
import { recordRouteError } from "../../errors/route-error";
import { serviceClient } from "../../db/client";

const HANDLED_EVENTS = new Set(["meeting.summarized", "meeting.transcribed"]);

export async function POST(
  request: Bun.BunRequest<"/webhooks/fireflies/:connectionKey">,
): Promise<Response> {
  let workspaceId: string | null = null;
  let sourceConnectionId: string | null = null;
  try {
    const { connection, credentialId, event, meetingId } = await authenticateFirefliesWebhookRequest(
      request,
      request.params.connectionKey,
    );
    workspaceId = connection.workspace_id;
    sourceConnectionId = connection.id;

    if (HANDLED_EVENTS.has(event)) {
      await ingestFirefliesMeeting(connection, meetingId);
    }

    const { error } = await serviceClient.rpc("mark_fireflies_webhook_success", {
      p_workspace_id: connection.workspace_id,
      p_connection_id: connection.id,
      p_credential_id: credentialId,
      p_succeeded_at: new Date().toISOString(),
    });
    if (error) throw error;

    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof FirefliesWebhookAuthError) {
      return new Response(null, { status: 401 });
    }
    recordRouteError({
      workspaceId,
      sourceConnectionId,
      operation: "ingestion",
      errorCode: "fireflies_webhook_failed",
      error,
    });
    return new Response(null, { status: 500 });
  }
}

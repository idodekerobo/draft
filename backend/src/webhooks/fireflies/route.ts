import { ingestFirefliesMeeting } from "../../ingestion/fireflies/normalize";
import { authenticateFirefliesWebhookRequest, FirefliesWebhookAuthError } from "./request-auth";
import { recordRouteError } from "../../errors/route-error";
import { serviceClient } from "../../db/client";
import { recordError } from "../../errors/record-error";
import { loadSandboxDeploymentConfig } from "../../sandbox";
import { startEventRoutines } from "../../routines/start-event-routines";

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

    let summarizedSourceItemId: string | null = null;
    if (HANDLED_EVENTS.has(event)) {
      const ingested = await ingestFirefliesMeeting(connection, credentialId, meetingId);
      if (event === "meeting.summarized") summarizedSourceItemId = ingested.sourceItemId;
    }

    const { error } = await serviceClient.rpc("mark_fireflies_webhook_success", {
      p_workspace_id: connection.workspace_id,
      p_connection_id: connection.id,
      p_credential_id: credentialId,
      p_succeeded_at: new Date().toISOString(),
    });
    if (error) throw error;

    // Starting a routine boots a sandbox, which takes a while. Fireflies gets its answer first, and a routine that
    // fails to start is recorded and never turns a stored meeting into a failed webhook.
    if (summarizedSourceItemId) {
      const startedFor = { workspaceId: connection.workspace_id, name: "fireflies.meeting_summarized" as const, eventId: meetingId, sourceItemId: summarizedSourceItemId };
      void (async () => startEventRoutines(serviceClient, loadSandboxDeploymentConfig(), startedFor))().catch((cause) =>
        recordError({ workspaceId: startedFor.workspaceId, operation: "scheduling", message: "Starting event routines failed", code: "event_routines_failed", error: cause }),
      );
    }

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
